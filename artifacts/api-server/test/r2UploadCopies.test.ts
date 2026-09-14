import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { and, eq } from "drizzle-orm";
import {
  classesTable,
  db,
  photoStorageCopiesTable,
  projectsTable,
  r2PhotoDeletionOutboxTable,
  studentPhotosTable,
  studentsTable,
  studiosTable,
} from "@workspace/db";
import {
  cleanupExpiredR2StagingUploads,
  createR2CopyUpload,
  readableR2CandidateKey,
  readableR2ObjectKey,
  verifyR2Copy,
} from "../src/lib/r2UploadCopies";
import { dispatchR2PhotoDeletions } from "../src/lib/r2PhotoDeletionOutbox";

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
  let failNextCandidateDelete = false;
  let failNextStagingDelete = false;
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
      if (failNextStagingDelete && objectKey === stagingObjectKey) {
        failNextStagingDelete = false;
        return new Response("temporary outage", { status: 503 });
      }
      if (failNextCandidateDelete && candidateKeys.includes(objectKey)) {
        failNextCandidateDelete = false;
        return new Response("temporary outage", { status: 503 });
      }
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
      afterVerificationClaimed: async () => {
        const cleanupWhileVerifying = await cleanupExpiredR2StagingUploads({
          now: new Date(),
          deleteObject: async (key) => {
            deletedKeys.push(key);
          },
        });
        assert.deepEqual(
          cleanupWhileVerifying,
          { inspected: 0, deleted: 0, failed: 0 },
        );
      },
      afterCandidateHashed: async () => {
        notifyVerifierAPaused();
        await verifierAResumed;
      },
    });
    await verifierAPaused;

    failNextStagingDelete = true;
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

    failNextCandidateDelete = true;
    releaseVerifierA();
    await assert.rejects(
      verifierA,
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === "R2_UPLOAD_NOT_VERIFIED",
    );

    const [queuedCandidate] = await db.select()
      .from(r2PhotoDeletionOutboxTable)
      .where(and(
        eq(r2PhotoDeletionOutboxTable.storageCopyId, copy.id),
        eq(r2PhotoDeletionOutboxTable.objectKey, candidateKeys[0]),
      ));
    assert.equal(queuedCandidate.state, "pending");
    await dispatchR2PhotoDeletions({
      now: new Date(Date.now() + 1_000),
      listVariantKeys: async () => [],
      deleteObject: async (key) => {
        deletedKeys.push(key);
        objects.delete(key);
      },
    });
    assert.equal(objects.has(stagingObjectKey), true);
    await dispatchR2PhotoDeletions({
      now: new Date(Date.now() + 17 * 60_000),
      listVariantKeys: async () => [],
      deleteObject: async (key) => {
        deletedKeys.push(key);
        objects.delete(key);
      },
    });

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
      [candidateKeys[0], candidateKeys[0]],
      "the failed immediate cleanup and durable retry must target only the losing candidate",
    );
    assert.ok(!deletedKeys.includes(winningCopy.objectKey));
    assert.equal(objects.has(stagingObjectKey), false);
    const [cleanedCandidate] = await db.select()
      .from(r2PhotoDeletionOutboxTable)
      .where(eq(r2PhotoDeletionOutboxTable.id, queuedCandidate.id));
    assert.equal(cleanedCandidate.state, "deleted");
    const [cleanedStaging] = await db.select()
      .from(r2PhotoDeletionOutboxTable)
      .where(and(
        eq(r2PhotoDeletionOutboxTable.storageCopyId, copy.id),
        eq(r2PhotoDeletionOutboxTable.objectKey, stagingObjectKey),
      ));
    assert.equal(cleanedStaging.state, "deleted");
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

test("expired staging cleanup preserves active and verified objects and retries failures", async () => {
  const originalAccountId = process.env.R2_ACCOUNT_ID;
  const originalAccessKey = process.env.R2_ACCESS_KEY_ID;
  const originalSecret = process.env.R2_SECRET_ACCESS_KEY;
  const originalBucket = process.env.R2_BUCKET_NAME;
  const suffix = `${process.pid}-${Date.now()}`;
  const now = new Date("2026-09-14T12:00:00.000Z");
  let studioId: number | undefined;

  process.env.R2_ACCOUNT_ID = "cleanup-test-account";
  process.env.R2_ACCESS_KEY_ID = "cleanup-test-key";
  process.env.R2_SECRET_ACCESS_KEY = "cleanup-test-secret";
  process.env.R2_BUCKET_NAME = "cleanup-test-bucket";

  try {
    const [studio] = await db.insert(studiosTable).values({
      name: `R2 cleanup studio ${suffix}`,
      createdByUserId: `r2-cleanup-${suffix}`,
    }).returning({ id: studiosTable.id });
    studioId = studio.id;
    const [project] = await db.insert(projectsTable).values({
      userId: `r2-cleanup-${suffix}`,
      studioId,
      schoolName: `R2 cleanup project ${suffix}`,
    }).returning({ id: projectsTable.id });
    const [studentClass] = await db.insert(classesTable).values({
      projectId: project.id,
      className: "Cleanup test class",
    }).returning({ id: classesTable.id });

    const copies = [];
    for (const label of ["expired", "active", "ready"]) {
      const [student] = await db.insert(studentsTable).values({
        projectId: project.id,
        classId: studentClass.id,
        firstName: label,
        lastName: "Cleanup",
        generatedStudentId: `r2-cleanup-${label}-${suffix}`,
      }).returning({ id: studentsTable.id });
      const [photo] = await db.insert(studentPhotosTable).values({
        projectId: project.id,
        studentId: student.id,
        fileName: `${label}.jpg`,
        fileUrl: `/objects/${label}-${suffix}.jpg`,
        mimeType: "image/jpeg",
      }).returning({ id: studentPhotosTable.id });
      const [copy] = await db.insert(photoStorageCopiesTable).values({
        studentPhotoId: photo.id,
        destination: "r2",
        objectKey: label === "ready"
          ? `final/${label}-${suffix}.jpg`
          : `final/pending-${label}-${suffix}.jpg`,
        stagingObjectKey: label === "ready"
          ? null
          : `staging/${label}-${suffix}.jpg`,
        state: label === "ready" ? "ready" : "uploading",
        attemptCount: 1,
        lastAttemptAt: label === "active"
          ? new Date(now.getTime() - 5 * 60_000)
          : new Date(now.getTime() - 2 * 60 * 60_000),
      }).returning();
      copies.push(copy);
    }

    const attemptedDeletes: string[] = [];
    const failed = await cleanupExpiredR2StagingUploads({
      now,
      deleteObject: async (key) => {
        attemptedDeletes.push(key);
        throw new Error("temporary R2 outage");
      },
    });
    assert.deepEqual(failed, { inspected: 1, deleted: 0, failed: 1 });
    assert.deepEqual(attemptedDeletes, [`staging/expired-${suffix}.jpg`]);

    const [afterFailure] = await db
      .select()
      .from(photoStorageCopiesTable)
      .where(eq(photoStorageCopiesTable.id, copies[0].id));
    assert.equal(afterFailure.state, "failed");
    assert.equal(afterFailure.cleanupAttemptCount, 1);
    assert.equal(afterFailure.nextRetryAt?.toISOString(), "2026-09-14T12:05:00.000Z");
    assert.match(afterFailure.lastError ?? "", /temporary R2 outage/);

    const beforeRetry = await cleanupExpiredR2StagingUploads({
      now: new Date("2026-09-14T12:04:59.000Z"),
      deleteObject: async () => {
        throw new Error("must not retry early");
      },
    });
    assert.equal(beforeRetry.inspected, 0);

    const deletedKeys: string[] = [];
    const retried = await cleanupExpiredR2StagingUploads({
      now: new Date("2026-09-14T12:05:00.000Z"),
      deleteObject: async (key) => {
        deletedKeys.push(key);
      },
    });
    assert.deepEqual(retried, { inspected: 1, deleted: 1, failed: 0 });
    assert.deepEqual(deletedKeys, [`staging/expired-${suffix}.jpg`]);

    const stored = await db
      .select()
      .from(photoStorageCopiesTable)
      .where(eq(photoStorageCopiesTable.destination, "r2"));
    const testCopies = stored.filter((copy) => copies.some((item) => item.id === copy.id));
    assert.equal(testCopies.find((copy) => copy.id === copies[0].id)?.state, "pending");
    assert.equal(testCopies.find((copy) => copy.id === copies[0].id)?.stagingObjectKey, null);
    assert.equal(testCopies.find((copy) => copy.id === copies[1].id)?.state, "uploading");
    assert.equal(testCopies.find((copy) => copy.id === copies[2].id)?.objectKey, `final/ready-${suffix}.jpg`);

    await db
      .update(photoStorageCopiesTable)
      .set({
        state: "cleaning",
        stagingObjectKey: `staging/reclaimed-${suffix}.jpg`,
        lastAttemptAt: new Date(now.getTime() - 2 * 60 * 60_000),
        updatedAt: new Date(now.getTime() - 20 * 60_000),
      })
      .where(eq(photoStorageCopiesTable.id, copies[0].id));
    const reclaimedKeys: string[] = [];
    const reclaimed = await cleanupExpiredR2StagingUploads({
      now,
      deleteObject: async (key) => {
        reclaimedKeys.push(key);
      },
    });
    assert.deepEqual(reclaimed, { inspected: 1, deleted: 1, failed: 0 });
    assert.deepEqual(reclaimedKeys, [`staging/reclaimed-${suffix}.jpg`]);

    await db
      .update(photoStorageCopiesTable)
      .set({
        state: "failed",
        stagingObjectKey: `staging/retry-${suffix}.jpg`,
        fileSize: 1,
        sha256: "a".repeat(64),
        lastError: "verification mismatch",
      })
      .where(eq(photoStorageCopiesTable.id, copies[1].id));
    const [activePhoto] = await db
      .select()
      .from(studentPhotosTable)
      .where(eq(studentPhotosTable.id, copies[1].studentPhotoId!));
    const uploadRetry = await createR2CopyUpload({
      source: {
        kind: "student",
        id: activePhoto.id,
        projectId: project.id,
        studentId: activePhoto.studentId,
      },
      originalFilename: activePhoto.fileName,
      mimeType: "image/jpeg",
      fileSize: 1,
      sha256: "a".repeat(64),
    });
    assert.equal(uploadRetry?.objectKey, `staging/retry-${suffix}.jpg`);
    const [retriedCopy] = await db
      .select()
      .from(photoStorageCopiesTable)
      .where(eq(photoStorageCopiesTable.id, copies[1].id));
    assert.equal(retriedCopy.state, "uploading");
    assert.equal(retriedCopy.stagingObjectKey, `staging/retry-${suffix}.jpg`);
  } finally {
    if (originalAccountId === undefined) delete process.env.R2_ACCOUNT_ID;
    else process.env.R2_ACCOUNT_ID = originalAccountId;
    if (originalAccessKey === undefined) delete process.env.R2_ACCESS_KEY_ID;
    else process.env.R2_ACCESS_KEY_ID = originalAccessKey;
    if (originalSecret === undefined) delete process.env.R2_SECRET_ACCESS_KEY;
    else process.env.R2_SECRET_ACCESS_KEY = originalSecret;
    if (originalBucket === undefined) delete process.env.R2_BUCKET_NAME;
    else process.env.R2_BUCKET_NAME = originalBucket;
    if (studioId !== undefined) {
      await db.delete(studiosTable).where(eq(studiosTable.id, studioId));
    }
  }
});