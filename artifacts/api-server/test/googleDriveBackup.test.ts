import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { backupFileToGoogleDrive, type DriveRequester } from "../src/lib/googleDriveBackup";

test("large Drive backups use a resumable session instead of proxying file bytes", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "volume-capture-drive-"));
  const filePath = path.join(tempDir, "portrait.jpg");
  const sourceBytes = Buffer.alloc(2 * 1024 * 1024, 7);
  fs.writeFileSync(filePath, sourceBytes);

  const requests: Array<{ path: string; method: string; headers: Record<string, string>; body: unknown }> = [];
  let folderNumber = 0;
  const request: DriveRequester = async (requestPath, options = {}) => {
    const headers = options.headers ?? {};
    requests.push({ path: requestPath, method: options.method ?? "GET", headers, body: options.body });

    if (requestPath.startsWith("/drive/v3/files?") && (options.method ?? "GET") === "GET") {
      return Response.json({ files: [] });
    }
    if (requestPath.startsWith("/drive/v3/files?") && options.method === "POST") {
      folderNumber += 1;
      return Response.json({ id: `folder-${folderNumber}` });
    }
    if (requestPath.startsWith("/upload/drive/v3/files?") && options.method === "POST") {
      return new Response(null, {
        status: 200,
        headers: { Location: "https://www.googleapis.com/upload/session/test-session" },
      });
    }
    if (requestPath === "https://www.googleapis.com/upload/session/test-session" && options.method === "PUT") {
      return Response.json({ id: "uploaded-file", name: "portrait.jpg", size: String(sourceBytes.length) });
    }
    return Response.json({ error: "Unexpected request" }, { status: 500 });
  };

  try {
    const result = await backupFileToGoogleDrive({
      studioId: 3,
      studioName: "Test Studio",
      projectId: 2,
      schoolName: "Test School",
      classId: 5,
      className: "Class A",
      studentId: 1120,
      studentFolderName: "PJEJFU1_Benkirane_Amine",
      filePath,
      fileName: "portrait.jpg",
      fileRole: "JPEG",
      fileFormat: "jpg",
      backupKey: "capture:1:JPEG",
    }, request);

    assert.equal(result.id, "uploaded-file");
    const sessionStart = requests.find((entry) => entry.path.includes("uploadType=resumable"));
    assert.ok(sessionStart);
    assert.equal(sessionStart.method, "POST");
    assert.equal(sessionStart.headers["X-Upload-Content-Length"], String(sourceBytes.length));
    assert.equal(typeof sessionStart.body, "string");

    const fileUpload = requests.find((entry) => entry.path === "https://www.googleapis.com/upload/session/test-session");
    assert.ok(fileUpload);
    assert.equal(fileUpload.method, "PUT");
    assert.equal(fileUpload.headers["Content-Length"], String(sourceBytes.length));
    assert.ok(Buffer.isBuffer(fileUpload.body));
    assert.deepEqual(fileUpload.body, sourceBytes);
    assert.equal(requests.some((entry) => entry.headers["Content-Type"]?.startsWith("multipart/related")), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});