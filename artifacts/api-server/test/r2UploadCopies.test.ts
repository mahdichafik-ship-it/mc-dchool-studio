import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { eq } from "drizzle-orm";
import {
  classesTable,
  db,
  photoStorageCopiesTable,
  projectsTable,
  studentPhotosTable,
  studentsTable,
  studiosTable,
} from "@workspace/db";
import {
  readableR2CandidateKey,
  readableR2ObjectKey,
  verifyR2Copy,
} from "../src/lib/r2UploadCopies";

const hierarchy = {
  studioId: 7,
  studioName: "North / Light Studio",
  projectId: 11,
  projectName: "Acme: Spring Photos",
  classId: 13,
  className: "Marketing / West",
  subjectId: 17,
  subjectFolderName: "Employee_Ada_17",
};

test("R2 final keys follow the readable backup hierarchy", () => {
  assert.equal(
    readableR2ObjectKey(hierarchy, " originals/IMG 0001.jpg "),
    "North _ Light Studio/Acme_ Spring Photos/Marketing _ West/Employee_Ada_17/IMG 0001.jpg",
  );
});

test("R2 collision names remain deterministic and preserve the original extension", () => {
  const first = readableR2ObjectKey(hierarchy, "IMG_0001.jpg", "r2:student:22");
  const repeated = readableR2ObjectKey(hierarchy, "IMG_0001.jpg", "r2:student:22");
  const second = readableR2ObjectKey(hierarchy, "IMG_0001.jpg", "r2:student:23");

  assert.equal(first, repeated);
  assert.match(first, /\/IMG_0001__[a-f0-9]{12}\.jpg$/);
  assert.notEqual(first, second);
});

test("R2 group keys use the group folder and Groups fallback", () => {
  assert.equal(
    readableR2ObjectKey({
      ...hierarchy,
      classId: undefined,
      className: "Groups",
      subjectFolderName: "Group_42",
      subjectId: 42,
    }, "class.jpg"),
    "North _ Light Studio/Acme_ Spring Photos/Groups/Group_42/class.jpg",
  );
});

test("R2 verified candidates stay readable and are unique per attempt", () => {
  const readable = readableR2ObjectKey(hierarchy, "IMG_0001.jpg");
  const first = readableR2CandidateKey(
    readable,
    "staging/storage-copy-9/attempt-a/IMG_0001.jpg",
  );
  const repeated = readableR2CandidateKey(
    readable,
    "staging/storage-copy-9/attempt-a/IMG_0001.jpg",
  );
  const second = readableR2CandidateKey(
    readable,
    "staging/storage-copy-9/attempt-b/IMG_0001.jpg",
  );

  assert.equal(first, repeated);
  assert.match(
    first,
    /^North _ Light Studio\/Acme_ Spring Photos\/Marketing _ West\/Employee_Ada_17\/IMG_0001__[a-f0-9]{12}\.jpg$/,
  );
  assert.notEqual(first, second);
});

test("a stale concurrent verifier cannot replace or delete the winning candidate", async () => {
  const originalFetch = globalThis.fetch;
  const originalR2Environment = {
    R2_ACCOUNT_ID: process.env.R2_ACCOUNT_ID,
    R2_ACCESS_KEY_ID: process.env.R2_ACCESS_KEY_ID,
    R2_SECRET_ACCESS_KEY: process.env.R2_SECRET_ACCESS_KEY,
    R2_BUCKET_NAME: process.env.R2_BUCKET_NAME,
    R2_ENDPOINT: process.env.R2_ENDPOINT,
  };
  const bytes = Buffer.from("concurrent R2 verifier bytes");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const objects = new Map<string, Buffer>();
  const deletedKeys: string[] = [];
  const candidateKeys: string[] = [];
  const suffix = `${process.pid}-${Date.now()}`;
  let studioId: number | undefined;
  let releaseVerifierA!: () => void;
  let notifyVerifierAPaused!: () => void;
  const verifierAResumed = new Promise<void>((resolve) => {
    releaseVerifierA = resolve;
  });
  const verifierAPaused = new Promise<void>((resolve) => {
    notifyVerifierAPaused = resolve;
  });

  const keyFromUrl = (input: string): string => {
    const parts = new URL(input).pathname.split("/").slice(2);
    return parts.map((part) => decodeURIComponent(part)).join("/");
  };
  const keyFromCopySource = (source: string): string => {
    const parts = source.split("/").slice(2);
    return parts.map((part) => decodeURIComponent(part)).join("/");
  };

  process.env.R2_ACCOUNT_ID = "r2-concurrency-test-account";
  process.env.R2_ACCESS_KEY_ID = "r2-concurrency-test-key";
  process.env.R2_SECRET_ACCESS_KEY = "r2-concurrency-test-secret";
  process.env.R2_BUCKET_NAME = "r2-concurrency-test-bucket";
  process.env.R2_ENDPOINT = "https://r2-concurrency-test.invalid";

  globalThis.fetch = async (input, init) => {
    const method = init?.method ?? "GET";
    const objectKey = keyFromUrl(String(input));
    if (method === "HEAD") {
      const body = objects.get(objectKey);
      if (!body) return new Response(null, { status: 404 });
      return new Response(null, {
        headers: {
          "content-length": String(body.length),
          "content-type": "image/jpeg",
          etag: `"${sha256}"`,
          "x-amz-meta-sha256": sha256,
        },
      });
    }
    if (method === "GET") {
      const body = objects.get(objectKey);
      return body
        ? new Response(body, {
            headers: {
              "content-length": String(body.length),
              "content-type": "image/jpeg",
            },
          })
        : new Response(null, { status: 404 });
    }
    if (method === "PUT") {
      const headers = new Headers(init?.headers);
      const source = headers.get("x-amz-copy-source");
      if (!source) throw new Error("The R2 test only supports copy PUTs");
      const sourceBody = objects.get(keyFromCopySource(source));
      if (!sourceBody) return new Response(null, { status: 404 });
      objects.set(objectKey, Buffer.from(sourceBody));
      candidateKeys.push(objectKey);
      return new Response(null, { status: 200 });
    }
    if (method === "DELETE") {
      deletedKeys.push(objectKey);
      objects.delete(objectKey);
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected R2 test method: ${method}`);
  };

  try {
    const [studio] = await db.insert(studiosTable).values({
      name: `R2 verifier concurrency studio ${suffix}`,
      createdByUserId: `r2-verifier-concurrency-${suffix}`,
    }).returning({ id: studiosTable.id });
    studioId = studio.id;
    const [project] = await db.insert(projectsTable).values({
      userId: `r2-verifier-concurrency-${suffix}`,
      studioId,
      schoolName: `R2 verifier concurrency project ${suffix}`,
    }).returning({ id: projectsTable.id });
    const [studentClass] = await db.insert(classesTable).values({
      projectId: project.id,
      className: "Concurrency test class",
    }).returning({ id: classesTable.id });
    const [student] = await db.insert(studentsTable).values({
      projectId: project.id,
      classId: studentClass.id,
      firstName: "Verifier",
      lastName: "Race",
      generatedStudentId: `r2-verifier-${suffix}`,
    }).returning({ id: studentsTable.id });
    const [photo] = await db.insert(studentPhotosTable).values({
      projectId: project.id,
      studentId: student.id,
      fileName: `concurrent-${suffix}.jpg`,
      fileUrl: `/objects/concurrent-${suffix}.jpg`,
      mimeType: "image/jpeg",
    }).returning({ id: studentPhotosTable.id });
    const stagingObjectKey = `staging/r2-verifier-concurrency-${suffix}/upload.jpg`;
    const readableObjectKey = readableR2ObjectKey(
      { ...hierarchy, subjectId: student.id },
      `concurrent-${suffix}.jpg`,
    );
    objects.set(stagingObjectKey, bytes);
    const [copy] = await db.insert(photoStorageCopiesTable).values({
      studentPhotoId: photo.id,
      destination: "r2",
      objectKey: readableObjectKey,
      stagingObjectKey,
      state: "uploading",
      mimeType: "image/jpeg",
      fileSize: bytes.length,
      sha256,
      attemptCount: 1,
    }).returning();

    const verifierA = verifyR2Copy(copy, {
      afterCandidateHashed: async () => {
        notifyVerifierAPaused();
        await verifierAResumed;
      },
    });
    await verifierAPaused;

    const winningCopy = await verifyR2Copy(copy);
    assert.equal(candidateKeys.length, 2);
    assert.notEqual(candidateKeys[0], candidateKeys[1]);
    assert.equal(winningCopy.state, "ready");
    assert.equal(winningCopy.stagingObjectKey, null);
    assert.equal(winningCopy.objectKey, candidateKeys[1]);
    assert.match(
      winningCopy.objectKey,
      /\/concurrent-[^/]+__[a-f0-9]{12}\.jpg$/,
    );

    releaseVerifierA();
    await assert.rejects(
      verifierA,
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === "R2_UPLOAD_NOT_VERIFIED",
    );

    const [storedCopy] = await db
      .select()
      .from(photoStorageCopiesTable)
      .where(eq(photoStorageCopiesTable.id, copy.id));
    assert.equal(storedCopy.state, "ready");
    assert.equal(storedCopy.objectKey, winningCopy.objectKey);
    assert.equal(storedCopy.providerObjectId, winningCopy.objectKey);
    assert.deepEqual(
      [...objects.keys()].filter((key) => key !== stagingObjectKey),
      [winningCopy.objectKey],
    );
    assert.deepEqual(
      deletedKeys.filter((key) => candidateKeys.includes(key)),
      [candidateKeys[0]],
    );
    assert.ok(!deletedKeys.includes(winningCopy.objectKey));
    assert.equal(objects.has(stagingObjectKey), false);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(originalR2Environment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (studioId !== undefined) {
      await db.delete(studiosTable).where(eq(studiosTable.id, studioId));
    }
  }
});