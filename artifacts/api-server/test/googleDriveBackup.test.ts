import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  backupFileToGoogleDrive,
  canonicalProjectFolderName,
  canonicalStudentFolderName,
  clearGoogleDriveFolderCacheForTests,
  setPlatformDriveRequesterForTests,
  stableCollisionFileName,
  type DriveBackupInput,
  type DriveRequester,
} from "../src/lib/googleDriveBackup";
import {
  backupToDropbox,
  dropboxContentHash,
  studioDriveCacheScope,
} from "../src/lib/studioStorageBackup";

function fixture(): { input: DriveBackupInput; cleanup: () => void } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "drive-backup-test-"));
  const filePath = path.join(directory, "capture.jpg");
  fs.writeFileSync(filePath, Buffer.from("original photo bytes"));
  return {
    input: {
      studioId: 1,
      studioName: "Studio",
      projectId: 2,
      schoolName: "West School",
      classId: 3,
      className: "Class A",
      studentId: 4,
      studentFolderName: "Ada_Lovelace_STU4",
      filePath,
      fileName: "IMG_0001.jpg",
      fileRole: "JPEG",
      fileFormat: "jpg",
      backupKey: "capture-1:JPEG",
    },
    cleanup: () => fs.rmSync(directory, { recursive: true, force: true }),
  };
}

function driveMock(existingNames: Record<string, string> = {}) {
  const calls: Array<{ path: string; method: string; body?: unknown }> = [];
  const folders = new Map<string, { id: string; name: string }>();
  const uploaded = new Map<string, { id: string; name: string; parents?: string[] }>();
  let nextId = 1;
  const pendingMetadata = new Map<string, {
    name: string;
    parents: string[];
    appProperties: { mcSchoolStudioBackupKey: string };
  }>();

  for (const [propertyValue, name] of Object.entries(existingNames)) {
    folders.set(propertyValue, { id: `old-${propertyValue}`, name });
  }

  const request: DriveRequester = async (requestPath, options = {}) => {
    const method = options.method ?? "GET";
    calls.push({ path: requestPath, method, body: options.body });
    if (requestPath.startsWith("/drive/v3/files?") && method === "GET") {
      const query = new URL(requestPath, "https://drive.test").searchParams.get("q") ?? "";
      const values = [...query.matchAll(/value='([^']+)'/g)].map((match) => match[1]);
      const value = values.at(-1) ?? "";
      if (query.includes("mcSchoolStudioBackupKey")) {
        const backupKey = query.match(/key='mcSchoolStudioBackupKey' and value='([^']+)'/)?.[1] ?? "";
        const file = uploaded.get(backupKey);
        return Response.json({ files: file ? [file] : [] });
      }
      const folder = folders.get(value);
      return Response.json({ files: folder ? [folder] : [] });
    }
    if (requestPath.startsWith("/drive/v3/files?") && method === "POST") {
      const body = JSON.parse(String(options.body));
      const value = Object.values(body.appProperties)[0] as string;
      const folder = { id: `folder-${nextId++}`, name: body.name };
      folders.set(value, folder);
      return Response.json(folder);
    }
    if (requestPath.startsWith("/drive/v3/files/") && method === "PATCH") {
      const id = requestPath.split("/")[4]?.split("?")[0];
      const query = new URL(requestPath, "https://drive.test").searchParams;
      if (query.has("addParents")) {
        const file = [...uploaded.values()].find((candidate) => candidate.id === id);
        assert.ok(file);
        file.parents = [query.get("addParents")!];
        return Response.json(file);
      }
      const body = JSON.parse(String(options.body));
      const folder = [...folders.values()].find((candidate) => candidate.id === id);
      assert.ok(folder);
      folder.name = body.name;
      return Response.json(folder);
    }
    if (requestPath.startsWith("/upload/drive/v3/files?") && method === "POST") {
      const sessionId = String(nextId++);
      pendingMetadata.set(sessionId, JSON.parse(String(options.body)));
      return new Response(null, {
        headers: { location: `https://upload.test/session/${sessionId}` },
      });
    }
    if (requestPath.startsWith("https://upload.test/session/") && method === "PUT") {
      const sessionId = requestPath.split("/").at(-1) ?? "";
      const metadata = pendingMetadata.get(sessionId);
      assert.ok(metadata);
      const file = { id: `file-${nextId++}`, name: metadata.name, parents: metadata.parents };
      Object.assign(file, {
        size: String((options.body as Buffer).length),
        md5Checksum: createHash("md5").update(options.body as Buffer).digest("hex"),
        appProperties: metadata.appProperties,
      });
      uploaded.set(metadata.appProperties.mcSchoolStudioBackupKey, file);
      pendingMetadata.delete(sessionId);
      return Response.json(file);
    }
    return Response.json({ error: "unexpected request" }, { status: 500 });
  };
  return { request, calls, folders, uploaded };
}

test("canonical backup folders match the desktop First_Last_ID convention", () => {
  assert.equal(canonicalStudentFolderName("Ada", "Lovelace", "STU4"), "Ada_Lovelace_STU4");
  assert.equal(canonicalProjectFolderName(" West / School ", 2), "West _ School");
  assert.equal(canonicalProjectFolderName(" ", 2), "Project 2");
  assert.equal(canonicalProjectFolderName("West\u0000School", 2), "West_School");
  assert.equal(canonicalProjectFolderName("A".repeat(140), 2).length, 120);
});

test("Dropbox collision suffixes are stable per capture and preserve extensions", () => {
  const first = stableCollisionFileName("IMG_0001.jpg", "capture-1:JPEG");
  const repeated = stableCollisionFileName("IMG_0001.jpg", "capture-1:JPEG");
  const second = stableCollisionFileName("IMG_0001.jpg", "capture-2:JPEG");
  assert.equal(first, repeated);
  assert.match(first, /^IMG_0001__[a-f0-9]{12}\.jpg$/);
  assert.notEqual(first, second);
  assert.notEqual(dropboxContentHash(Buffer.from("first")), dropboxContentHash(Buffer.from("second")));
  assert.notEqual(studioDriveCacheScope(7, "account-A"), studioDriveCacheScope(7, "account-B"));
});

test("folder cache removes ten Drive requests on a subsequent capture", async () => {
  clearGoogleDriveFolderCacheForTests();
  const { input, cleanup } = fixture();
  const mock = driveMock();
  try {
    await backupFileToGoogleDrive(input, mock.request, "google-drive:account:A");
    const firstCount = mock.calls.length;
    await backupFileToGoogleDrive(
      { ...input, backupKey: "capture-2:JPEG" },
      mock.request,
      "google-drive:account:A",
    );
    const secondCount = mock.calls.length - firstCount;
    assert.equal(firstCount, 13);
    assert.equal(secondCount, 3);
    assert.equal(firstCount - secondCount, 10);
  } finally {
    cleanup();
  }
});

test("cache is isolated by provider account scope and coalesces in-flight folders", async () => {
  clearGoogleDriveFolderCacheForTests();
  const { input, cleanup } = fixture();
  const mock = driveMock();
  try {
    await Promise.all([
      backupFileToGoogleDrive(input, mock.request, "google-drive:studio-connection:7:account:A"),
      backupFileToGoogleDrive(
        { ...input, backupKey: "capture-2:JPEG" },
        mock.request,
        "google-drive:studio-connection:7:account:A",
      ),
    ]);
    assert.equal(mock.calls.filter((call) => call.method === "POST" && call.path.startsWith("/drive/v3/files?")).length, 5);

    await backupFileToGoogleDrive(
      { ...input, backupKey: "capture-3:JPEG" },
      mock.request,
      "google-drive:studio-connection:7:account:B",
    );
    assert.equal(mock.calls.filter((call) => call.method === "GET" && call.path.startsWith("/drive/v3/files?")).length, 13);
  } finally {
    cleanup();
  }
});

test("existing appProperty folders are renamed and reused without split trees", async () => {
  clearGoogleDriveFolderCacheForTests();
  const { input, cleanup } = fixture();
  const mock = driveMock({
    "backups-v1": "Volume Capture Backups",
    "1": "Studio",
    "2": "West School (Project 2)",
    "3": "Class A",
    "4": "STU4_Lovelace_Ada",
  });
  try {
    await backupFileToGoogleDrive(input, mock.request, "google-drive:account:A");
    assert.equal(mock.calls.filter((call) => call.method === "POST" && call.path.startsWith("/drive/v3/files?")).length, 0);
    assert.equal(mock.calls.filter((call) => call.method === "PATCH").length, 2);
    assert.equal(mock.folders.get("2")?.name, "West School");
    assert.equal(mock.folders.get("4")?.name, "Ada_Lovelace_STU4");
  } finally {
    cleanup();
  }
});

test("folder lookup errors fail closed and are not cached", async () => {
  clearGoogleDriveFolderCacheForTests();
  const { input, cleanup } = fixture();
  let requests = 0;
  const failing: DriveRequester = async () => {
    requests += 1;
    return Response.json({ error: "denied" }, { status: 403 });
  };
  try {
    await assert.rejects(
      backupFileToGoogleDrive(input, failing, "google-drive:account:A"),
      /HTTP 403/,
    );
    await assert.rejects(
      backupFileToGoogleDrive(input, failing, "google-drive:account:A"),
      /HTTP 403/,
    );
    assert.equal(requests, 2);
  } finally {
    cleanup();
  }
});

test("metadata reads retry transient Drive throttling without creating duplicates", async () => {
  clearGoogleDriveFolderCacheForTests();
  const { input, cleanup } = fixture();
  const mock = driveMock();
  let throttled = false;
  const request: DriveRequester = async (requestPath, options) => {
    if (!throttled && requestPath.startsWith("/drive/v3/files?") && !options?.method) {
      throttled = true;
      return Response.json({ error: "rate limited" }, { status: 429 });
    }
    return mock.request(requestPath, options);
  };
  try {
    await backupFileToGoogleDrive(input, request, "google-drive:account:A");
    assert.equal(throttled, true);
    assert.equal(mock.calls.filter((call) => call.method === "POST" && call.path.startsWith("/drive/v3/files?")).length, 5);
  } finally {
    cleanup();
  }
});

test("platform account identity lookup retries a 429 response before caching folders", async () => {
  clearGoogleDriveFolderCacheForTests();
  const { input, cleanup } = fixture();
  const mock = driveMock();
  let aboutCalls = 0;
  const request: DriveRequester = async (requestPath, options) => {
    if (requestPath.startsWith("/drive/v3/about?")) {
      aboutCalls += 1;
      if (aboutCalls === 1) return Response.json({ error: "throttled" }, { status: 429 });
      return Response.json({ user: { permissionId: "platform-account-A" } });
    }
    return mock.request(requestPath, options);
  };
  try {
    setPlatformDriveRequesterForTests(request);
    await backupFileToGoogleDrive(input);
    assert.equal(aboutCalls, 2);
  } finally {
    setPlatformDriveRequesterForTests();
    cleanup();
  }
});

test("identical original filenames remain distinct by stable capture backup key", async () => {
  clearGoogleDriveFolderCacheForTests();
  const { input, cleanup } = fixture();
  const mock = driveMock();
  try {
    const first = await backupFileToGoogleDrive(input, mock.request, "google-drive:account:A");
    const second = await backupFileToGoogleDrive(
      { ...input, backupKey: "capture-2:JPEG" },
      mock.request,
      "google-drive:account:A",
    );
    const repeated = await backupFileToGoogleDrive(input, mock.request, "google-drive:account:A");
    assert.notEqual(first.id, second.id);
    assert.equal(first.name, "IMG_0001.jpg");
    assert.equal(second.name, "IMG_0001.jpg");
    assert.equal(repeated.id, first.id);
    assert.equal(mock.calls.filter((call) => call.path.startsWith("/upload/drive/v3/files?")).length, 2);
  } finally {
    cleanup();
  }
});

test("an idempotent old-role upload is scoped and moved by ID into the student folder", async () => {
  clearGoogleDriveFolderCacheForTests();
  const { input, cleanup } = fixture();
  const mock = driveMock();
  mock.uploaded.set(input.backupKey, {
    id: "existing-photo",
    name: input.fileName,
    parents: ["old-jpeg-role-folder"],
    size: String(fs.statSync(input.filePath).size),
    md5Checksum: createHash("md5").update(fs.readFileSync(input.filePath)).digest("hex"),
    appProperties: { mcSchoolStudioStudentId: String(input.studentId) },
  });
  try {
    const result = await backupFileToGoogleDrive(input, mock.request, "google-drive:account:A");
    assert.equal(result.id, "existing-photo");
    const lookup = mock.calls.find((call) =>
      call.method === "GET" && decodeURIComponent(call.path).includes("mcSchoolStudioBackupKey")
    );
    assert.ok(lookup);
    const decodedLookup = decodeURIComponent(lookup.path);
    assert.match(decodedLookup, /mcSchoolStudioStudioId/);
    assert.match(decodedLookup, /mcSchoolStudioProjectId/);
    const move = mock.calls.find((call) =>
      call.method === "PATCH" && call.path.includes("/drive/v3/files/existing-photo?")
    );
    assert.ok(move);
    assert.match(move.path, /addParents=folder-/);
    assert.match(move.path, /removeParents=old-jpeg-role-folder/);
    assert.equal(mock.calls.some((call) => call.path.startsWith("/upload/drive/v3/files?")), false);
  } finally {
    cleanup();
  }
});

test("Drive rejects an appProperty match with different bytes", async () => {
  clearGoogleDriveFolderCacheForTests();
  const { input, cleanup } = fixture();
  const mock = driveMock();
  mock.uploaded.set(input.backupKey, {
    id: "wrong-photo",
    name: input.fileName,
    parents: ["old-folder"],
    size: "5",
    md5Checksum: createHash("md5").update("wrong").digest("hex"),
    appProperties: { mcSchoolStudioStudentId: String(input.studentId) },
  });
  try {
    await assert.rejects(
      backupFileToGoogleDrive(input, mock.request, "google-drive:account:A"),
      /backup integrity conflict/,
    );
    assert.equal(mock.calls.filter((call) => call.path.startsWith("/upload/drive/v3/files?")).length, 0);
  } finally {
    cleanup();
  }
});

test("Dropbox never accepts a fallback conflict containing different bytes", async () => {
  const { input, cleanup } = fixture();
  const uploadedPaths: string[] = [];
  const fetcher = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const requestUrl = String(url);
    if (requestUrl.endsWith("/files/create_folder_v2")) return Response.json({});
    if (requestUrl.endsWith("/files/get_metadata")) {
      return Response.json({
        size: fs.statSync(input.filePath).size,
        content_hash: dropboxContentHash(Buffer.from("different bytes")),
      });
    }
    if (requestUrl.includes("/files/upload")) {
      const headers = new Headers(init?.headers);
      const argument = JSON.parse(headers.get("Dropbox-API-Arg") ?? "{}");
      uploadedPaths.push(argument.path);
      return Response.json({ error_summary: "path/conflict/file" }, { status: 409 });
    }
    return Response.json({ error: "unexpected" }, { status: 500 });
  };
  try {
    await assert.rejects(
      backupToDropbox(input, "test-token", fetcher as typeof fetch),
      /Dropbox upload failed with HTTP 409/,
    );
    assert.equal(uploadedPaths.length, 2);
    assert.notEqual(uploadedPaths[0], uploadedPaths[1]);
  } finally {
    cleanup();
  }
});

test("Dropbox primary-name conflict is idempotent only for identical bytes", async () => {
  const { input, cleanup } = fixture();
  let uploadCalls = 0;
  const bytes = fs.readFileSync(input.filePath);
  const fetcher = async (url: string | URL | Request): Promise<Response> => {
    const requestUrl = String(url);
    if (requestUrl.endsWith("/files/create_folder_v2")) return Response.json({});
    if (requestUrl.endsWith("/files/get_metadata")) {
      return Response.json({ size: bytes.length, content_hash: dropboxContentHash(bytes) });
    }
    if (requestUrl.includes("/files/upload")) {
      uploadCalls += 1;
      return Response.json({ error_summary: "path/conflict/file" }, { status: 409 });
    }
    return Response.json({ error: "unexpected" }, { status: 500 });
  };
  try {
    await backupToDropbox(input, "test-token", fetcher as typeof fetch);
    assert.equal(uploadCalls, 1);
  } finally {
    cleanup();
  }
});