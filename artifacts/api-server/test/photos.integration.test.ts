import { strict as assert } from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { readFile, readdir, rm } from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import test, { after, before } from "node:test";
import express from "express";
import { and, eq, sql } from "drizzle-orm";
import {
  classesTable,
  captureBatchesTable,
  capturesTable,
  captureFilesTable,
  db,
  desktopConnectionsTable,
  groupCaptureFilesTable,
  groupCapturesTable,
  groupMembersTable,
  groupsTable,
  pool,
  projectAssignmentsTable,
  projectsTable,
  photoStorageCopiesTable,
  studentPhotosTable,
  studentsTable,
  studioMembersTable,
  studiosTable,
} from "@workspace/db";
import photosRouter, { recoverPhotoDeleteBackups } from "../src/routes/photos";
import desktopRouter from "../src/routes/desktop";
import projectsRouter from "../src/routes/projects";
import { createDesktopToken } from "../src/lib/desktopAuth";
import {
  clearGoogleDriveFolderCacheForTests,
  setPlatformDriveRequesterForTests,
  type DriveRequester,
} from "../src/lib/googleDriveBackup";
import {
  projectGroupJpegToPhotographedStudents,
} from "../src/lib/groupDeliveryPhotos";

const userId = `photo-flow-test-${process.pid}-${Date.now()}`;
let authUserId = userId;
const jpegBytes = Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAH/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAEFAqf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/AX//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/AX//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAY/Aqf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/IV//2gAMAwEAAgADAAAAEP/EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQMBAT8QH//EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQIBAT8QH//EABQQAQAAAAAAAAAAAAAAAAAAABD/2gAIAQEAAT8QH//Z",
  "base64",
);
const rawBytes = Buffer.from("sample-raw-capture-bytes");
let mockDriveId = 1;
const mockDriveRequester: DriveRequester = async (requestPath, options = {}) => {
  const method = options.method ?? "GET";
  if (requestPath.startsWith("/drive/v3/about?") && method === "GET") {
    return Response.json({ user: { permissionId: "integration-platform-account" } });
  }
  if (requestPath.startsWith("/drive/v3/files?") && method === "GET") {
    return Response.json({ files: [] });
  }
  if (requestPath.startsWith("/drive/v3/files?") && method === "POST") {
    const metadata = JSON.parse(String(options.body));
    return Response.json({ id: `test-folder-${mockDriveId++}`, name: metadata.name });
  }
  if (requestPath.startsWith("/upload/drive/v3/files?") && method === "POST") {
    return new Response(null, {
      headers: { location: `https://test-upload.invalid/${mockDriveId++}` },
    });
  }
  if (requestPath.startsWith("https://test-upload.invalid/") && method === "PUT") {
    return Response.json({ id: `test-file-${mockDriveId++}` });
  }
  return Response.json({ error: "Unexpected mocked Drive request" }, { status: 500 });
};

type PhotoResponse = {
  id: number;
  projectId: number;
  studentId: number;
  fileName: string;
  fileUrl: string;
  mimeType: string;
  capturedAt: string | null;
  createdAt: string;
  r2Upload?: {
    copyId: number;
    objectKey: string;
    uploadUrl: string;
    uploadMethod: "PUT";
    uploadHeaders: Record<string, string>;
    expiresAt: string;
    alreadyVerified: boolean;
  } | null;
};

let server: Server;
let baseUrl: string;
let projectId: number;
let studentId: number;
let classId: number;
let studioId: number;
let memberId: number;
let otherMemberId: number;
let adminMemberId: number;
let hiddenProjectId: number;
let uploadedPhotoId: number | undefined;
let uploadedFilePath: string | undefined;
const captureFilePaths: string[] = [];
const desktopCredentials = createDesktopToken();
const otherDesktopCredentials = createDesktopToken();
const adminDesktopCredentials = createDesktopToken();

const app = express();
app.use(express.json());
const authHandler = Object.assign(
  () => ({
    tokenType: "session_token",
    userId: authUserId,
    sessionClaims: { userId: authUserId },
  }),
  { [Symbol.for("@clerk/express.auth")]: true },
);

// The real requireAuth middleware is used by the router. This supplies the
// same request contract as clerkMiddleware without needing a live Clerk token.
app.use((req, _res, next) => {
  (req as any).auth = authHandler;
  next();
});
app.use("/api/projects/:projectId/captures", photosRouter);
app.use("/api/projects/:projectId/students", photosRouter);
app.use("/api/projects", projectsRouter);
app.use("/api/desktop", photosRouter);
app.use("/api/desktop", desktopRouter);

before(async () => {
  clearGoogleDriveFolderCacheForTests();
  setPlatformDriveRequesterForTests(mockDriveRequester);
  const [studio] = await db
    .insert(studiosTable)
    .values({ name: "Photo flow integration studio", createdByUserId: userId })
    .returning({ id: studiosTable.id });
  studioId = studio.id;

  const [member] = await db
    .insert(studioMembersTable)
    .values({
      studioId,
      userId,
      email: `${userId}@member.local`,
      role: "photographer",
    })
    .returning({ id: studioMembersTable.id });
  memberId = member.id;

  const [otherMember] = await db
    .insert(studioMembersTable)
    .values({
      studioId,
      userId: `${userId}-other`,
      email: `${userId}-other@member.local`,
      role: "photographer",
    })
    .returning({ id: studioMembersTable.id });
  otherMemberId = otherMember.id;

  const [adminMember] = await db
    .insert(studioMembersTable)
    .values({
      studioId,
      userId: `${userId}-admin`,
      email: `${userId}-admin@member.local`,
      role: "admin",
    })
    .returning({ id: studioMembersTable.id });
  adminMemberId = adminMember.id;

  const [project] = await db
    .insert(projectsTable)
    .values({
      userId,
      studioId,
      schoolName: "Photo flow integration school",
    })
    .returning({ id: projectsTable.id });
  projectId = project.id;
  await db.insert(projectAssignmentsTable).values([
    { projectId, memberId },
    { projectId, memberId: otherMemberId },
  ]);

  const [hiddenProject] = await db
    .insert(projectsTable)
    .values({
      userId,
      studioId,
      schoolName: "Hidden integration project",
    })
    .returning({ id: projectsTable.id });
  hiddenProjectId = hiddenProject.id;

  await db.insert(desktopConnectionsTable).values([
    {
      studioId,
      memberId,
      deviceName: "Integration desktop",
      tokenHash: desktopCredentials.tokenHash,
      tokenPrefix: desktopCredentials.tokenPrefix,
    },
    {
      studioId,
      memberId: otherMemberId,
      deviceName: "Other integration desktop",
      tokenHash: otherDesktopCredentials.tokenHash,
      tokenPrefix: otherDesktopCredentials.tokenPrefix,
    },
    {
      studioId,
      memberId: adminMemberId,
      deviceName: "Admin integration desktop",
      tokenHash: adminDesktopCredentials.tokenHash,
      tokenPrefix: adminDesktopCredentials.tokenPrefix,
    },
  ]);

  const [studentClass] = await db
    .insert(classesTable)
    .values({
      projectId,
      className: "Integration class",
    })
    .returning({ id: classesTable.id });
  classId = studentClass.id;

  const [student] = await db
    .insert(studentsTable)
    .values({
      projectId,
      classId,
      firstName: "Integration",
      lastName: "Student",
      generatedStudentId: `INT${String(process.pid).slice(-4)}${Date.now()
        .toString()
        .slice(-4)}`,
    })
    .returning({ id: studentsTable.id });
  studentId = student.id;

  server = createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  setPlatformDriveRequesterForTests();
  clearGoogleDriveFolderCacheForTests();
  if (uploadedFilePath) {
    await rm(uploadedFilePath, { force: true });
  }
  await Promise.all(captureFilePaths.map((filePath) => rm(filePath, { force: true })));
  if (studioId) {
    await db.delete(studiosTable).where(eq(studiosTable.id, studioId));
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await pool.end();
});

test("uploads paired JPEG and RAW members idempotently and serves the RAW member", async () => {
  const captureKey = `capture-integration-${process.pid}-${Date.now()}`;
  const batchKey = `batch-integration-${process.pid}-${Date.now()}`;
  const batchStart = await fetch(`${baseUrl}/api/desktop/projects/${projectId}/capture-batches`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${desktopCredentials.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ batchKey, expectedFileCount: 2 }),
  });
  assert.equal(batchStart.status, 201);
  const jpegForm = new (globalThis as any).FormData();
  jpegForm.append(
    "file",
    new (globalThis as any).Blob([jpegBytes], { type: "image/jpeg" }),
    "portrait-original.jpg",
  );
  jpegForm.append("captureKey", captureKey);
  jpegForm.append("baseFilename", "portrait-original");
  jpegForm.append("fileRole", "JPEG");
  jpegForm.append("capturedAt", "2026-08-22T12:34:56.000Z");
  jpegForm.append("sequence", "7");

  const jpegResponse = await fetch(
    `${baseUrl}/api/projects/${projectId}/students/${studentId}/captures`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${desktopCredentials.token}`,
        "X-MC-Upload-Id": `${captureKey}-jpeg`,
        "X-MC-Capture-Batch": batchKey,
      },
      body: jpegForm,
    },
  );
  assert.equal(jpegResponse.status, 201);
  const jpegUploaded = await jpegResponse.json() as {
    captureId: number;
    pairingStatus: string;
    file: { id: number; fileRole: string; fileUrl: string };
  };
  assert.equal(jpegUploaded.pairingStatus, "jpeg_only");
  assert.equal(jpegUploaded.file.fileRole, "JPEG");
  captureFilePaths.push(path.resolve(process.cwd(), jpegUploaded.file.fileUrl.replace(/^\//, "")));
  const [projectedDeliveryPhoto] = await db
    .select()
    .from(studentPhotosTable)
    .where(and(
      eq(studentPhotosTable.projectId, projectId),
      eq(studentPhotosTable.studentId, studentId),
      eq(studentPhotosTable.fileName, "portrait-original.jpg"),
    ));
  assert(projectedDeliveryPhoto, "every durable uploaded JPEG should be available to a published gallery");

  const retryForm = new (globalThis as any).FormData();
  retryForm.append(
    "file",
    new (globalThis as any).Blob([jpegBytes], { type: "image/jpeg" }),
    "portrait-original.jpg",
  );
  retryForm.append("captureKey", captureKey);
  retryForm.append("fileRole", "JPEG");
  const retryResponse = await fetch(
    `${baseUrl}/api/projects/${projectId}/students/${studentId}/captures`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${desktopCredentials.token}`,
        "X-MC-Upload-Id": `${captureKey}-jpeg`,
        "X-MC-Capture-Batch": batchKey,
      },
      body: retryForm,
    },
  );
  assert.equal(retryResponse.status, 200);
  const retried = await retryResponse.json() as { captureId: number; file: { id: number } };
  assert.equal(retried.captureId, jpegUploaded.captureId);
  assert.equal(retried.file.id, jpegUploaded.file.id);

  const rawForm = new (globalThis as any).FormData();
  rawForm.append(
    "file",
    new (globalThis as any).Blob([rawBytes], { type: "application/octet-stream" }),
    "portrait-original.nef",
  );
  rawForm.append("captureKey", captureKey);
  rawForm.append("baseFilename", "portrait-original");
  rawForm.append("fileRole", "RAW");
  rawForm.append("fileFormat", "NEF");
  rawForm.append("capturedAt", "2026-08-22T12:34:56.000Z");
  rawForm.append("sequence", "7");
  const rawResponse = await fetch(
    `${baseUrl}/api/projects/${projectId}/students/${studentId}/captures`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${desktopCredentials.token}`,
        "X-MC-Upload-Id": `${captureKey}-raw`,
        "X-MC-Capture-Batch": batchKey,
      },
      body: rawForm,
    },
  );
  assert.equal(rawResponse.status, 201);
  const rawUploaded = await rawResponse.json() as {
    captureId: number;
    pairingStatus: string;
    file: { id: number; fileRole: string; originalFilename: string; fileUrl: string };
  };
  assert.equal(rawUploaded.captureId, jpegUploaded.captureId);
  assert.equal(rawUploaded.pairingStatus, "complete");
  assert.equal(rawUploaded.file.fileRole, "RAW");
  assert.equal(rawUploaded.file.originalFilename, "portrait-original.nef");
  const rawPath = path.resolve(process.cwd(), rawUploaded.file.fileUrl.replace(/^\//, ""));
  captureFilePaths.push(rawPath);
  assert.deepEqual(await readFile(rawPath), rawBytes);

  const captureReviewResponse = await fetch(
    `${baseUrl}/api/projects/${projectId}/students/${studentId}/captures/${captureKey}/review`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${desktopCredentials.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        rating: 4,
        colorLabel: "green",
        favorite: true,
        selected: true,
        rejected: false,
        cropPosition: { x: 0.25, y: 0.75 },
        cropScale: 1.5,
        aspectRatio: "4:5",
        straightenAngle: 2,
        rotation: 90,
      }),
    },
  );
  assert.equal(captureReviewResponse.status, 200);
  const reviewedCapture = await captureReviewResponse.json() as {
    capture: {
      cropPositionX: number;
      cropPositionY: number;
      cropScale: number;
      aspectRatio: string;
      straightenAngle: number;
      rotation: number;
      favorite: boolean;
      selected: boolean;
      rejected: boolean;
    };
  };
  assert.equal(reviewedCapture.capture.cropPositionX, 0.25);
  assert.equal(reviewedCapture.capture.cropPositionY, 0.75);
  assert.equal(reviewedCapture.capture.cropScale, 1.5);
  assert.equal(reviewedCapture.capture.aspectRatio, "4:5");
  assert.equal(reviewedCapture.capture.straightenAngle, 2);
  assert.equal(reviewedCapture.capture.rotation, 90);
  assert.equal(reviewedCapture.capture.favorite, true);
  assert.equal(reviewedCapture.capture.selected, true);
  assert.equal(reviewedCapture.capture.rejected, false);

  const rejectedReviewResponse = await fetch(
    `${baseUrl}/api/projects/${projectId}/students/${studentId}/captures/${captureKey}/review`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${desktopCredentials.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        rating: 0,
        favorite: true,
        selected: true,
        rejected: true,
      }),
    },
  );
  assert.equal(rejectedReviewResponse.status, 200);
  const rejectedReview = await rejectedReviewResponse.json() as {
    capture: { favorite: boolean; selected: boolean; rejected: boolean };
  };
  assert.equal(rejectedReview.capture.favorite, true);
  assert.equal(rejectedReview.capture.selected, false);
  assert.equal(rejectedReview.capture.rejected, true);

  const selectedReviewResponse = await fetch(
    `${baseUrl}/api/projects/${projectId}/students/${studentId}/captures/${captureKey}/review`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${desktopCredentials.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        rating: 4,
        favorite: true,
        selected: true,
        rejected: false,
      }),
    },
  );
  assert.equal(selectedReviewResponse.status, 200);
  const selectedReview = await selectedReviewResponse.json() as {
    capture: { favorite: boolean; selected: boolean; rejected: boolean };
  };
  assert.equal(selectedReview.capture.favorite, true);
  assert.equal(selectedReview.capture.selected, true);
  assert.equal(selectedReview.capture.rejected, false);

  const webCaptureList = await fetch(`${baseUrl}/api/projects/${projectId}/captures`);
  assert.equal(webCaptureList.status, 200);
  const webCaptureReview = await webCaptureList.json() as {
    students: Array<{ studentId: number; captures: Array<{
      id: number;
      pairingStatus: string;
      files: Array<{ id: number; fileRole: string; url: string; fileUrl?: string }>;
    }> }>;
    totals: { captures: number; complete: number };
  };
  const listedCapture = webCaptureReview.students
    .find((student) => student.studentId === studentId)
    ?.captures.find((candidate) => candidate.id === jpegUploaded.captureId);
  assert(listedCapture);
  assert.equal(listedCapture.pairingStatus, "complete");
  assert.equal(webCaptureReview.totals.complete >= 1, true);
  assert(listedCapture.files.every((file) => file.url.includes("/captures/")));
  assert(listedCapture.files.every((file) => !("fileUrl" in file)));

  const webJpeg = listedCapture.files.find((file) => file.fileRole === "JPEG");
  const webRaw = listedCapture.files.find((file) => file.fileRole === "RAW");
  assert(webJpeg && webRaw);
  for (const file of [webJpeg, webRaw]) {
    const fileResponse = await fetch(`${baseUrl}${file.url}`);
    assert.equal(fileResponse.status, 200);
  }

  for (const mode of ["paired", "selected", "favorite", "final-selection"] as const) {
    const exportResponse = await fetch(`${baseUrl}/api/projects/${projectId}/captures/export?mode=${mode}`);
    assert.equal(exportResponse.status, 200, `${mode} export should be authorized`);
    assert.match(exportResponse.headers.get("content-type") ?? "", /application\/zip/);
    assert((await exportResponse.arrayBuffer()).byteLength > 0);
  }

  const [capture] = await db
    .select()
    .from(capturesTable)
    .where(eq(capturesTable.id, jpegUploaded.captureId));
  assert(capture);
  assert.equal(capture.pairingStatus, "complete");
  const files = await db
    .select()
    .from(captureFilesTable)
    .where(eq(captureFilesTable.captureId, capture.id));
  assert.equal(files.length, 2);
  assert.deepEqual(
    files.map((file) => file.fileRole).sort(),
    ["JPEG", "RAW"],
  );
  assert(files.every((file) => file.captureBatchId !== null));

  const batchFinish = await fetch(`${baseUrl}/api/desktop/projects/${projectId}/capture-batches/${batchKey}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${desktopCredentials.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      status: "complete",
      failedFileCount: 0,
      handoffComment: "Two students need a retake in the left hallway.",
    }),
  });
  assert.equal(batchFinish.status, 200);
  const completedBatch = await batchFinish.json() as { status: string; uploadedFileCount: number };
  assert.equal(completedBatch.status, "complete");
  assert.equal(completedBatch.uploadedFileCount, 2);
  const nonStandardHandoff = await fetch(`${baseUrl}/api/desktop/projects/${projectId}/capture-batches/${batchKey}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${desktopCredentials.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ status: "complete", failedFileCount: 0, comment: "must not be accepted" }),
  });
  assert.equal(nonStandardHandoff.status, 400);
  const [storedBatch] = await db.select().from(captureBatchesTable).where(eq(captureBatchesTable.batchKey, batchKey));
  assert.equal(storedBatch.status, "complete");
  assert.equal(storedBatch.handoffComment, "Two students need a retake in the left hallway.");

  const collaborationResponse = await fetch(`${baseUrl}/api/projects/${projectId}/collaboration`);
  assert.equal(collaborationResponse.status, 200);
  const collaboration = await collaborationResponse.json() as {
    summary: { photographedStudents: number; totalCaptures: number; pairing: { complete: number } };
    batches: Array<{ batchKey: string; status: string; uploadedFileCount: number; handoffComment: string | null }>;
  };
  assert.equal(collaboration.summary.photographedStudents, 1);
  assert.equal(collaboration.batches.find((batch) => batch.batchKey === batchKey)?.handoffComment, "Two students need a retake in the left hallway.");
  assert(collaboration.summary.totalCaptures >= 1);
  assert(collaboration.summary.pairing.complete >= 1);
  const visibleBatch = collaboration.batches.find((batch) => batch.batchKey === batchKey);
  assert.equal(visibleBatch?.status, "complete");
  assert.equal(visibleBatch?.uploadedFileCount, 2);

  const completedBatchStart = await fetch(`${baseUrl}/api/desktop/projects/${projectId}/capture-batches`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${desktopCredentials.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ batchKey, expectedFileCount: 2 }),
  });
  assert.equal(completedBatchStart.status, 200);
  const stillCompletedBatch = await completedBatchStart.json() as { status: string; completedAt: string | null };
  assert.equal(stillCompletedBatch.status, "complete");
  assert(stillCompletedBatch.completedAt);

  const conflictingBatchStart = await fetch(`${baseUrl}/api/desktop/projects/${projectId}/capture-batches`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${otherDesktopCredentials.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ batchKey, expectedFileCount: 2 }),
  });
  assert.equal(conflictingBatchStart.status, 409);

  const rawFileResponse = await fetch(
    `${baseUrl}/api/projects/${projectId}/students/${studentId}/captures/${capture.id}/files/${rawUploaded.file.id}/file`,
  );
  assert.equal(rawFileResponse.status, 200);
  assert.equal(rawFileResponse.headers.get("content-type"), "application/octet-stream");
  assert.deepEqual(Buffer.from(await rawFileResponse.arrayBuffer()), rawBytes);

  const [desktopConnection] = await db.select({ id: desktopConnectionsTable.id })
    .from(desktopConnectionsTable)
    .where(eq(desktopConnectionsTable.tokenHash, desktopCredentials.tokenHash));
  assert(desktopConnection);
  try {
    for (const status of ["retired", "revoked"] as const) {
      await db.update(desktopConnectionsTable).set({
        status,
        retiredAt: status === "retired" ? new Date() : null,
        revokedAt: status === "revoked" ? new Date() : null,
      }).where(eq(desktopConnectionsTable.id, desktopConnection.id));
      const blockedReview = await fetch(
        `${baseUrl}/api/projects/${projectId}/students/${studentId}/captures/${captureKey}/review`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${desktopCredentials.token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ selected: true, rejected: false, rating: 5 }),
        },
      );
      assert.equal(blockedReview.status, 401, `${status} desktops cannot update review flags`);
    }
  } finally {
    await db.update(desktopConnectionsTable).set({
      status: "active",
      retiredAt: null,
      revokedAt: null,
    }).where(eq(desktopConnectionsTable.id, desktopConnection.id));
  }
  await db.delete(studentPhotosTable).where(eq(studentPhotosTable.id, projectedDeliveryPhoto.id));
});

test("a reconnected Mac supersedes an interrupted batch and credits committed retries", async () => {
  const interruptedCredentials = createDesktopToken();
  const replacementCredentials = createDesktopToken();
  const [interruptedConnection, replacementConnection] = await db.insert(desktopConnectionsTable).values([
    {
      studioId,
      memberId,
      deviceName: "Interrupted integration desktop",
      tokenHash: interruptedCredentials.tokenHash,
      tokenPrefix: interruptedCredentials.tokenPrefix,
    },
    {
      studioId,
      memberId,
      deviceName: "Replacement integration desktop",
      tokenHash: replacementCredentials.tokenHash,
      tokenPrefix: replacementCredentials.tokenPrefix,
    },
  ]).returning({ id: desktopConnectionsTable.id });
  const [group] = await db.insert(groupsTable).values({
    projectId,
    name: `Reconnect group ${Date.now()}`,
    isDefaultClassGroup: false,
  }).returning({ id: groupsTable.id });
  const interruptedBatchKey = `interrupted-${process.pid}-${Date.now()}`;
  const replacementBatchKey = `replacement-${process.pid}-${Date.now()}`;
  const authHeaders = (token: string) => ({ Authorization: `Bearer ${token}` });
  const start = await fetch(`${baseUrl}/api/desktop/projects/${projectId}/capture-batches`, {
    method: "POST",
    headers: { ...authHeaders(interruptedCredentials.token), "Content-Type": "application/json" },
    body: JSON.stringify({ batchKey: interruptedBatchKey, expectedFileCount: 3 }),
  });
  assert.equal(start.status, 201);

  const portraitUploadId = `resume-portrait-${Date.now()}`;
  const portraitCaptureKey = `resume-portrait-capture-${Date.now()}`;
  const portraitForm = new (globalThis as any).FormData();
  portraitForm.append("file", new (globalThis as any).Blob([jpegBytes], { type: "image/jpeg" }), "resume-portrait.jpg");
  portraitForm.append("captureKey", portraitCaptureKey);
  portraitForm.append("fileRole", "JPEG");
  const portraitCommit = await fetch(`${baseUrl}/api/projects/${projectId}/students/${studentId}/captures`, {
    method: "POST",
    headers: {
      ...authHeaders(interruptedCredentials.token),
      "X-MC-Upload-Id": portraitUploadId,
      "X-MC-Capture-Batch": interruptedBatchKey,
    },
    body: portraitForm,
  });
  assert.equal(portraitCommit.status, 201);
  const portrait = await portraitCommit.json() as { captureId: number; file: { id: number; fileUrl: string } };
  captureFilePaths.push(path.resolve(process.cwd(), portrait.file.fileUrl.replace(/^\//, "")));

  const legacyUploadId = String(Date.now()).slice(-9);
  const legacyForm = new (globalThis as any).FormData();
  legacyForm.append("photo", new (globalThis as any).Blob([jpegBytes], { type: "image/jpeg" }), "resume-legacy.jpg");
  const legacyCommit = await fetch(`${baseUrl}/api/projects/${projectId}/students/${studentId}/photos`, {
    method: "POST",
    headers: {
      ...authHeaders(interruptedCredentials.token),
      "X-MC-Upload-Id": legacyUploadId,
      "X-MC-Capture-Batch": interruptedBatchKey,
    },
    body: legacyForm,
  });
  assert.equal(legacyCommit.status, 201);
  const legacy = await legacyCommit.json() as { id: number; fileUrl: string };
  captureFilePaths.push(path.resolve(process.cwd(), legacy.fileUrl.replace(/^\//, "")));

  const groupUploadId = `resume-group-${Date.now()}`;
  const groupCaptureKey = `resume-group-capture-${Date.now()}`;
  const groupForm = new (globalThis as any).FormData();
  groupForm.append("file", new (globalThis as any).Blob([jpegBytes], { type: "image/jpeg" }), "resume-group.jpg");
  groupForm.append("captureKey", groupCaptureKey);
  groupForm.append("fileRole", "JPEG");
  const groupCommit = await fetch(`${baseUrl}/api/desktop/projects/${projectId}/groups/${group.id}/captures`, {
    method: "POST",
    headers: {
      ...authHeaders(interruptedCredentials.token),
      "X-MC-Upload-Id": groupUploadId,
      "X-MC-Capture-Batch": interruptedBatchKey,
    },
    body: groupForm,
  });
  assert.equal(groupCommit.status, 201);
  const groupFile = await groupCommit.json() as { file: { id: number; fileUrl: string } };
  captureFilePaths.push(path.resolve(process.cwd(), groupFile.file.fileUrl.replace(/^\//, "")));

  const activeMacConflict = await fetch(`${baseUrl}/api/desktop/projects/${projectId}/capture-batches`, {
    method: "POST",
    headers: { ...authHeaders(replacementCredentials.token), "Content-Type": "application/json" },
    body: JSON.stringify({
      batchKey: replacementBatchKey,
      supersedesBatchKey: interruptedBatchKey,
      expectedFileCount: 3,
    }),
  });
  assert.equal(activeMacConflict.status, 409);

  await db.update(desktopConnectionsTable).set({
    status: "revoked",
    revokedAt: new Date(),
  }).where(eq(desktopConnectionsTable.id, interruptedConnection.id));
  const replacementStart = await fetch(`${baseUrl}/api/desktop/projects/${projectId}/capture-batches`, {
    method: "POST",
    headers: { ...authHeaders(replacementCredentials.token), "Content-Type": "application/json" },
    body: JSON.stringify({
      batchKey: replacementBatchKey,
      supersedesBatchKey: interruptedBatchKey,
      expectedFileCount: 3,
    }),
  });
  assert.equal(replacementStart.status, 201);
  const replayedReplacementStart = await fetch(`${baseUrl}/api/desktop/projects/${projectId}/capture-batches`, {
    method: "POST",
    headers: { ...authHeaders(replacementCredentials.token), "Content-Type": "application/json" },
    body: JSON.stringify({
      batchKey: replacementBatchKey,
      supersedesBatchKey: interruptedBatchKey,
      expectedFileCount: 3,
    }),
  });
  assert.equal(replayedReplacementStart.status, 200, "a lost successful supersession response must be safely replayable");

  const mismatchedGroupRetry = new (globalThis as any).FormData();
  mismatchedGroupRetry.append("file", new (globalThis as any).Blob([jpegBytes], { type: "image/jpeg" }), "resume-group.jpg");
  mismatchedGroupRetry.append("captureKey", groupCaptureKey);
  mismatchedGroupRetry.append("fileRole", "JPEG");
  const mismatchedGroupResponse = await fetch(`${baseUrl}/api/desktop/projects/${projectId}/groups/${group.id}/captures`, {
    method: "POST",
    headers: {
      ...authHeaders(replacementCredentials.token),
      "X-MC-Upload-Id": `${groupUploadId}-different`,
      "X-MC-Capture-Batch": replacementBatchKey,
    },
    body: mismatchedGroupRetry,
  });
  assert.equal(mismatchedGroupResponse.status, 200);
  const [unmovedGroupFile] = await db.select().from(groupCaptureFilesTable)
    .where(eq(groupCaptureFilesTable.id, groupFile.file.id));
  const [interruptedBatch] = await db.select().from(captureBatchesTable)
    .where(eq(captureBatchesTable.batchKey, interruptedBatchKey));
  assert.equal(unmovedGroupFile.captureBatchId, interruptedBatch.id, "role-only reuse must not transfer batch membership");

  const retryPortrait = new (globalThis as any).FormData();
  retryPortrait.append("file", new (globalThis as any).Blob([jpegBytes], { type: "image/jpeg" }), "resume-portrait.jpg");
  retryPortrait.append("captureKey", portraitCaptureKey);
  retryPortrait.append("fileRole", "JPEG");
  const retryLegacy = new (globalThis as any).FormData();
  retryLegacy.append("photo", new (globalThis as any).Blob([jpegBytes], { type: "image/jpeg" }), "resume-legacy.jpg");
  const retryGroup = new (globalThis as any).FormData();
  retryGroup.append("file", new (globalThis as any).Blob([jpegBytes], { type: "image/jpeg" }), "resume-group.jpg");
  retryGroup.append("captureKey", groupCaptureKey);
  retryGroup.append("fileRole", "JPEG");
  const retryRequests = [
    fetch(`${baseUrl}/api/projects/${projectId}/students/${studentId}/captures`, {
      method: "POST",
      headers: { ...authHeaders(replacementCredentials.token), "X-MC-Upload-Id": portraitUploadId, "X-MC-Capture-Batch": replacementBatchKey },
      body: retryPortrait,
    }),
    fetch(`${baseUrl}/api/projects/${projectId}/students/${studentId}/photos`, {
      method: "POST",
      headers: { ...authHeaders(replacementCredentials.token), "X-MC-Upload-Id": legacyUploadId, "X-MC-Capture-Batch": replacementBatchKey },
      body: retryLegacy,
    }),
    fetch(`${baseUrl}/api/desktop/projects/${projectId}/groups/${group.id}/captures`, {
      method: "POST",
      headers: { ...authHeaders(replacementCredentials.token), "X-MC-Upload-Id": groupUploadId, "X-MC-Capture-Batch": replacementBatchKey },
      body: retryGroup,
    }),
  ];
  const retryResponses = await Promise.all(retryRequests);
  assert.deepEqual(retryResponses.map((response) => response.status), [200, 200, 200]);

  const finish = await fetch(`${baseUrl}/api/desktop/projects/${projectId}/capture-batches/${replacementBatchKey}`, {
    method: "PATCH",
    headers: { ...authHeaders(replacementCredentials.token), "Content-Type": "application/json" },
    body: JSON.stringify({ status: "complete", failedFileCount: 0 }),
  });
  assert.equal(finish.status, 200);
  const completed = await finish.json() as { status: string; uploadedFileCount: number };
  assert.equal(completed.status, "complete");
  assert.equal(completed.uploadedFileCount, 3);

  const batches = await db.select().from(captureBatchesTable).where(eq(captureBatchesTable.projectId, projectId));
  const interrupted = batches.find((batch) => batch.batchKey === interruptedBatchKey);
  const replacement = batches.find((batch) => batch.batchKey === replacementBatchKey);
  assert.equal(interrupted?.status, "superseded");
  assert(interrupted?.supersededAt);
  assert.equal(replacement?.supersedesBatchId, interrupted?.id);
  assert.equal(replacement?.uploadedFileCount, 3);
  const [portraitFile] = await db.select().from(captureFilesTable).where(eq(captureFilesTable.id, portrait.file.id));
  const [legacyFile] = await db.select().from(studentPhotosTable).where(eq(studentPhotosTable.id, legacy.id));
  const [groupCaptureFile] = await db.select().from(groupCaptureFilesTable).where(eq(groupCaptureFilesTable.id, groupFile.file.id));
  assert.equal(portraitFile.captureBatchId, replacement?.id);
  assert.equal(legacyFile.captureBatchId, replacement?.id);
  assert.equal(groupCaptureFile.captureBatchId, replacement?.id);
  await db.delete(studentPhotosTable).where(and(
    eq(studentPhotosTable.projectId, projectId),
    eq(studentPhotosTable.studentId, studentId),
    sql`${studentPhotosTable.fileName} in ('resume-portrait.jpg', 'resume-legacy.jpg')`,
  ));
  await db.delete(capturesTable).where(eq(capturesTable.id, portrait.captureId));
  await db.delete(groupCapturesTable).where(eq(groupCapturesTable.captureKey, groupCaptureKey));
  await db.delete(captureBatchesTable).where(eq(captureBatchesTable.projectId, projectId));
  await db.delete(desktopConnectionsTable).where(eq(desktopConnectionsTable.id, interruptedConnection.id));
  await db.delete(desktopConnectionsTable).where(eq(desktopConnectionsTable.id, replacementConnection.id));
});

test("lets a studio admin review a photo and keeps parent visibility synchronized", async () => {
  const captureKey = `web-review-${process.pid}-${Date.now()}`;
  const fileName = `${captureKey}.jpg`;
  const form = new (globalThis as any).FormData();
  form.append("file", new (globalThis as any).Blob([jpegBytes], { type: "image/jpeg" }), fileName);
  form.append("captureKey", captureKey);
  form.append("baseFilename", captureKey);
  form.append("fileRole", "JPEG");
  form.append("capturedAt", "2026-08-22T12:34:56.000Z");
  form.append("sequence", "1");

  const uploadResponse = await fetch(
    `${baseUrl}/api/projects/${projectId}/students/${studentId}/captures`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${desktopCredentials.token}`,
        "X-MC-Upload-Id": `${captureKey}-jpeg`,
      },
      body: form,
    },
  );
  assert.equal(uploadResponse.status, 201);
  const uploaded = await uploadResponse.json() as {
    captureId: number;
    file: { id: number; fileUrl: string };
  };
  const filePath = path.resolve(process.cwd(), uploaded.file.fileUrl.replace(/^\//, ""));
  captureFilePaths.push(filePath);

  const [photo] = await db.select().from(studentPhotosTable).where(and(
    eq(studentPhotosTable.projectId, projectId),
    eq(studentPhotosTable.studentId, studentId),
    eq(studentPhotosTable.fileName, fileName),
  ));
  assert(photo, "the capture should project a reviewable delivery photo");

  authUserId = `${userId}-admin`;
  try {
    const selectedResponse = await fetch(
      `${baseUrl}/api/projects/${projectId}/students/${studentId}/photos/${photo.id}/review`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision: "selected", rating: 5 }),
      },
    );
    assert.equal(selectedResponse.status, 200);
    const selected = await selectedResponse.json() as { photo: PhotoResponse & { rating: number; shareWithParents: boolean } };
    assert.equal(selected.photo.rating, 5);
    assert.equal(selected.photo.shareWithParents, true);

    const [selectedCapture] = await db.select().from(capturesTable).where(eq(capturesTable.id, uploaded.captureId));
    assert.equal(selectedCapture?.rating, 5);
    assert.equal(selectedCapture?.colorLabel, "green");

    const doNotShareResponse = await fetch(
      `${baseUrl}/api/projects/${projectId}/students/${studentId}/photos/${photo.id}/review`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision: "do_not_share" }),
      },
    );
    assert.equal(doNotShareResponse.status, 200);
    const hidden = await doNotShareResponse.json() as { photo: PhotoResponse & { rating: number; colorLabel: string; shareWithParents: boolean } };
    assert.equal(hidden.photo.rating, 0);
    assert.equal(hidden.photo.colorLabel, "red");
    assert.equal(hidden.photo.shareWithParents, false);

    const [hiddenCapture] = await db.select().from(capturesTable).where(eq(capturesTable.id, uploaded.captureId));
    assert.equal(hiddenCapture?.rating, 0);
    assert.equal(hiddenCapture?.colorLabel, "red");

    authUserId = userId;
    const photographerResponse = await fetch(
      `${baseUrl}/api/projects/${projectId}/students/${studentId}/photos/${photo.id}/review`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision: "selected", rating: 4 }),
      },
    );
    assert.equal(photographerResponse.status, 404, "non-manager review attempts must be rejected");
  } finally {
    authUserId = userId;
    await db.delete(studentPhotosTable).where(eq(studentPhotosTable.id, photo.id));
    await db.delete(captureFilesTable).where(eq(captureFilesTable.id, uploaded.file.id));
    await db.delete(capturesTable).where(eq(capturesTable.id, uploaded.captureId));
    await rm(filePath, { force: true });
  }
});

test("keeps identical local capture keys isolated between photographer desktops", async () => {
  const [otherStudent] = await db
    .insert(studentsTable)
    .values({
      projectId,
      classId,
      firstName: "Other",
      lastName: "Student",
      generatedStudentId: `OTHER${process.pid}${Date.now()}`,
    })
    .returning({ id: studentsTable.id });
  const sharedLocalKey = `legacy-photo:${Date.now()}`;

  const upload = async (
    targetStudentId: number,
    token: string,
    uploadId: string,
    filename: string,
    expectedStatus = 201,
  ) => {
    const form = new (globalThis as any).FormData();
    form.append("file", new (globalThis as any).Blob([jpegBytes], { type: "image/jpeg" }), filename);
    form.append("captureKey", sharedLocalKey);
    form.append("fileRole", "JPEG");
    const response = await fetch(
      `${baseUrl}/api/projects/${projectId}/students/${targetStudentId}/captures`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "X-MC-Upload-Id": uploadId,
        },
        body: form,
      },
    );
    assert.equal(response.status, expectedStatus);
    return response.json() as Promise<{ captureId: number; file: { fileUrl: string } }>;
  };

  const firstUploadId = `shared-key-first-${Date.now()}`;
  const first = await upload(
    studentId,
    desktopCredentials.token,
    firstUploadId,
    "first-photographer.jpg",
  );
  await upload(
    otherStudent.id,
    desktopCredentials.token,
    firstUploadId,
    "wrong-target.jpg",
    409,
  );
  const second = await upload(
    otherStudent.id,
    otherDesktopCredentials.token,
    `shared-key-second-${Date.now()}`,
    "second-photographer.jpg",
  );

  assert.notEqual(first.captureId, second.captureId);
  captureFilePaths.push(
    path.resolve(process.cwd(), first.file.fileUrl.replace(/^\//, "")),
    path.resolve(process.cwd(), second.file.fileUrl.replace(/^\//, "")),
  );
  await db.delete(studentPhotosTable).where(eq(studentPhotosTable.fileName, "first-photographer.jpg"));
  await db.delete(studentPhotosTable).where(eq(studentPhotosTable.fileName, "second-photographer.jpg"));
  await db.delete(capturesTable).where(eq(capturesTable.id, first.captureId));
  await db.delete(capturesTable).where(eq(capturesTable.id, second.captureId));
  await db.delete(studentsTable).where(eq(studentsTable.id, otherStudent.id));
});

test("preserves a photo through upload, delivery, and deletion", async () => {
  const form = new (globalThis as any).FormData();
  form.append(
    "photo",
    new (globalThis as any).Blob([jpegBytes], { type: "image/jpeg" }),
    "integration-portrait.jpg",
  );
  form.append("capturedAt", "2026-08-22T12:34:56.000Z");

  const uploadResponse = await fetch(
    `${baseUrl}/api/projects/${projectId}/students/${studentId}/photos`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${desktopCredentials.token}`,
        "X-MC-Upload-Id": "1",
      },
      body: form,
    },
  );
  assert.equal(uploadResponse.status, 201);
  const uploaded = (await uploadResponse.json()) as PhotoResponse;
  uploadedPhotoId = uploaded.id;

  assert.equal(uploaded.projectId, projectId);
  assert.equal(uploaded.studentId, studentId);
  assert.equal(uploaded.fileName, "integration-portrait.jpg");
  assert.equal(uploaded.mimeType, "image/jpeg");
  assert.equal(uploaded.capturedAt, "2026-08-22T12:34:56.000Z");
  assert.equal(uploaded.r2Upload?.uploadMethod, "PUT");
  assert.equal(uploaded.r2Upload?.alreadyVerified, false);
  assert.match(
    uploaded.r2Upload?.objectKey ?? "",
    /^staging\/storage-copy-\d+\/[0-9a-f-]+\//,
  );
  assert.doesNotMatch(
    uploaded.r2Upload?.uploadUrl ?? "",
    /R2_SECRET_ACCESS_KEY/,
  );

  const [storedPhoto] = await db
    .select()
    .from(studentPhotosTable)
    .where(eq(studentPhotosTable.id, uploaded.id));
  assert(storedPhoto, "upload should create a student_photos row");
  assert.equal(storedPhoto.fileUrl, uploaded.fileUrl);

  uploadedFilePath = path.resolve(process.cwd(), uploaded.fileUrl.replace(/^\//, ""));
  assert(fs.existsSync(uploadedFilePath), "upload should create the photo on disk");
  assert.deepEqual(await readFile(uploadedFilePath), jpegBytes);

  const retryForm = new (globalThis as any).FormData();
  retryForm.append(
    "photo",
    new (globalThis as any).Blob([jpegBytes], { type: "image/jpeg" }),
    "integration-portrait.jpg",
  );
  retryForm.append("capturedAt", "2026-08-22T12:34:56.000Z");
  const retryResponse = await fetch(
    `${baseUrl}/api/projects/${projectId}/students/${studentId}/photos`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${desktopCredentials.token}`,
        "X-MC-Upload-Id": "1",
      },
      body: retryForm,
    },
  );
  assert.equal(retryResponse.status, 200);
  const retried = (await retryResponse.json()) as PhotoResponse;
  assert.equal(retried.id, uploaded.id, "retry should return the original server photo");

  const listResponse = await fetch(
    `${baseUrl}/api/projects/${projectId}/students/${studentId}/photos`,
  );
  assert.equal(listResponse.status, 200);
  const listedPhotos = (await listResponse.json()) as PhotoResponse[];
  assert.equal(listedPhotos.length, 1);
  const { r2Upload: _r2Upload, ...uploadedPhoto } = uploaded;
  assert.deepEqual(listedPhotos[0], uploadedPhoto);
  const listedFilePath = path.resolve(
    process.cwd(),
    listedPhotos[0].fileUrl.replace(/^\//, ""),
  );
  assert(fs.existsSync(listedFilePath), "GET fileUrl should resolve on disk");

  const fileResponse = await fetch(
    `${baseUrl}/api/projects/${projectId}/students/${studentId}/photos/${uploaded.id}/file`,
  );
  assert.equal(fileResponse.status, 200);
  assert.equal(fileResponse.headers.get("content-type"), "image/jpeg");
  assert.deepEqual(
    Buffer.from(await fileResponse.arrayBuffer()),
    jpegBytes,
    "GET file endpoint should deliver the uploaded JPEG",
  );

  const deleteResponse = await fetch(
    `${baseUrl}/api/projects/${projectId}/students/${studentId}/photos/${uploaded.id}`,
    { method: "DELETE" },
  );
  assert.equal(deleteResponse.status, 204);
  assert(!fs.existsSync(uploadedFilePath), "DELETE should remove the photo file");

  const [deletedPhoto] = await db
    .select({ id: studentPhotosTable.id })
    .from(studentPhotosTable)
    .where(
      and(
        eq(studentPhotosTable.id, uploaded.id),
        eq(studentPhotosTable.projectId, projectId),
      ),
    );
  assert.equal(deletedPhoto, undefined, "DELETE should remove the database row");
  uploadedPhotoId = undefined;
  uploadedFilePath = undefined;
});

test("deletes a private R2 original and its variants safely and idempotently", async () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const fileUrl = `/uploads/student-photos/${projectId}/${studentId}/r2-delete-${suffix}.jpg`;
  const filePath = path.resolve(process.cwd(), fileUrl.replace(/^\//, ""));
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, jpegBytes);
  const [photo] = await db.insert(studentPhotosTable).values({
    projectId,
    studentId,
    fileName: `r2-delete-${suffix}.jpg`,
    fileUrl,
    mimeType: "image/jpeg",
  }).returning();
  const originalKey = `Studio/Project/Class/Student/r2-delete-${suffix}.jpg`;
  const variantPrefix = `Studio/Project/Class/Student/.variants/r2-delete-${suffix}__`;
  const variantKeys = [`${variantPrefix}preview__one.jpg`, `${variantPrefix}thumbnail__two.jpg`];
  const otherProjectKey = `Other/Project/Class/Student/r2-delete-${suffix}.jpg`;
  const objects = new Set([originalKey, ...variantKeys, otherProjectKey]);
  const deletedKeys: string[] = [];
  let failOneDelete = true;
  const r2Server = createServer((req, res) => {
    const requestUrl = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "GET" && requestUrl.searchParams.get("list-type") === "2") {
      const prefix = requestUrl.searchParams.get("prefix") ?? "";
      const keys = [...objects].filter((key) => key.startsWith(prefix));
      res.writeHead(200, { "Content-Type": "application/xml" });
      res.end(`<ListBucketResult><IsTruncated>false</IsTruncated>${keys.map((key) => `<Contents><Key>${encodeURIComponent(key)}</Key></Contents>`).join("")}</ListBucketResult>`);
      return;
    }
    if (req.method === "DELETE") {
      const key = decodeURIComponent(requestUrl.pathname.split("/").slice(2).join("/"));
      if (failOneDelete) {
        failOneDelete = false;
        res.writeHead(503);
        res.end("retry");
        return;
      }
      objects.delete(key);
      deletedKeys.push(key);
      res.writeHead(204);
      res.end();
      return;
    }
    res.writeHead(500);
    res.end("unexpected R2 request");
  });
  await new Promise<void>((resolve) => r2Server.listen(0, "127.0.0.1", resolve));
  const address = r2Server.address();
  assert(address && typeof address === "object");
  const savedR2 = {
    account: process.env.R2_ACCOUNT_ID,
    key: process.env.R2_ACCESS_KEY_ID,
    secret: process.env.R2_SECRET_ACCESS_KEY,
    bucket: process.env.R2_BUCKET_NAME,
    endpoint: process.env.R2_ENDPOINT,
  };
  Object.assign(process.env, {
    R2_ACCOUNT_ID: "delete-test",
    R2_ACCESS_KEY_ID: "delete-test-key",
    R2_SECRET_ACCESS_KEY: "delete-test-secret",
    R2_BUCKET_NAME: "delete-test-bucket",
    R2_ENDPOINT: `http://127.0.0.1:${address.port}`,
  });
  const [copy] = await db.insert(photoStorageCopiesTable).values({
    studentPhotoId: photo.id,
    destination: "r2",
    objectKey: originalKey,
    state: "ready",
    mimeType: "image/jpeg",
    fileSize: jpegBytes.length,
    sha256: "a".repeat(64),
    verifiedAt: new Date(),
  }).returning();

  try {
    const first = await fetch(`${baseUrl}/api/projects/${projectId}/students/${studentId}/photos/${photo.id}`, { method: "DELETE" });
    assert.equal(first.status, 500);
    assert(fs.existsSync(filePath), "uncertain R2 deletion must keep recoverable local bytes");
    const [failedCopy] = await db.select().from(photoStorageCopiesTable).where(eq(photoStorageCopiesTable.id, copy.id));
    assert.equal(failedCopy.state, "failed");

    const retry = await fetch(`${baseUrl}/api/projects/${projectId}/students/${studentId}/photos/${photo.id}`, { method: "DELETE" });
    assert.equal(retry.status, 204);
    assert(!fs.existsSync(filePath));
    assert(!objects.has(originalKey));
    assert(variantKeys.every((key) => !objects.has(key)));
    assert(objects.has(otherProjectKey), "deletion must not touch another project's object");
    assert.deepEqual(new Set(deletedKeys), new Set([originalKey, ...variantKeys]));

    const replay = await fetch(`${baseUrl}/api/projects/${projectId}/students/${studentId}/photos/${photo.id}`, { method: "DELETE" });
    assert.equal(replay.status, 204, "a lost successful response must be safely replayable");
  } finally {
    await new Promise<void>((resolve) => r2Server.close(() => resolve()));
    const restore = (key: string, value: string | undefined) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    };
    restore("R2_ACCOUNT_ID", savedR2.account);
    restore("R2_ACCESS_KEY_ID", savedR2.key);
    restore("R2_SECRET_ACCESS_KEY", savedR2.secret);
    restore("R2_BUCKET_NAME", savedR2.bucket);
    restore("R2_ENDPOINT", savedR2.endpoint);
    await db.delete(studentPhotosTable).where(eq(studentPhotosTable.id, photo.id));
    await rm(filePath, { force: true });
    const parent = path.dirname(filePath);
    for (const entry of await readdir(parent, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith(".photo-delete-")) continue;
      const directory = path.join(parent, entry.name);
      const files = await readdir(directory).catch(() => []);
      if (files.includes(path.basename(filePath))) {
        await rm(directory, { recursive: true, force: true });
      }
    }
  }
});

test("preserves the uploaded photo when the database delete fails", async () => {
  const form = new (globalThis as any).FormData();
  form.append(
    "photo",
    new (globalThis as any).Blob([jpegBytes], { type: "image/jpeg" }),
    "database-failure-portrait.jpg",
  );

  const uploadResponse = await fetch(
    `${baseUrl}/api/projects/${projectId}/students/${studentId}/photos`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${desktopCredentials.token}` },
      body: form,
    },
  );
  assert.equal(uploadResponse.status, 201);
  const uploaded = (await uploadResponse.json()) as PhotoResponse;
  const filePath = path.resolve(process.cwd(), uploaded.fileUrl.replace(/^\//, ""));
  assert(fs.existsSync(filePath), "the uploaded photo should exist before the failure");

  const triggerName = `photo_delete_failure_${process.pid}_${Date.now()}`;
  const functionName = `${triggerName}_function`;
  await pool.query(`
    CREATE FUNCTION ${functionName}() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'intentional photo delete failure';
    END;
    $$ LANGUAGE plpgsql
  `);
  await pool.query(`
    CREATE TRIGGER ${triggerName}
    BEFORE DELETE ON student_photos
    FOR EACH ROW EXECUTE FUNCTION ${functionName}()
  `);

  try {
    const deleteResponse = await fetch(
      `${baseUrl}/api/projects/${projectId}/students/${studentId}/photos/${uploaded.id}`,
      { method: "DELETE" },
    );
    assert.equal(deleteResponse.status, 500);
    assert(fs.existsSync(filePath), "a failed database delete must keep the photo file");
    assert.deepEqual(await readFile(filePath), jpegBytes);

    const [storedPhoto] = await db
      .select()
      .from(studentPhotosTable)
      .where(eq(studentPhotosTable.id, uploaded.id));
    assert(storedPhoto, "a failed database delete must keep the photo row");
    assert.equal(storedPhoto.fileUrl, uploaded.fileUrl);
  } finally {
    await pool.query(`DROP TRIGGER IF EXISTS ${triggerName} ON student_photos`);
    await pool.query(`DROP FUNCTION IF EXISTS ${functionName}()`);
    await db.delete(studentPhotosTable).where(eq(studentPhotosTable.id, uploaded.id));
    await rm(filePath, { force: true });
  }
});

async function uploadFailureTestPhoto(fileName: string): Promise<{
  uploaded: PhotoResponse;
  filePath: string;
}> {
  const form = new (globalThis as any).FormData();
  form.append(
    "photo",
    new (globalThis as any).Blob([jpegBytes], { type: "image/jpeg" }),
    fileName,
  );
  const response = await fetch(
    `${baseUrl}/api/projects/${projectId}/students/${studentId}/photos`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${desktopCredentials.token}` },
      body: form,
    },
  );
  assert.equal(response.status, 201);
  const uploaded = (await response.json()) as PhotoResponse;
  return {
    uploaded,
    filePath: path.resolve(process.cwd(), uploaded.fileUrl.replace(/^\//, "")),
  };
}

async function reservePort(): Promise<number> {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const address = probe.address();
  assert(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolve, reject) => {
    probe.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function startProductionServer(): Promise<{
  child: ChildProcess;
  output: () => string;
}> {
  const port = await reservePort();
  const child = spawn(process.execPath, [path.resolve(process.cwd(), "dist/index.mjs")], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ENV: "test",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });

  const healthUrl = `http://127.0.0.1:${port}/api/healthz`;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Production server exited before becoming ready:\n${output}`);
    }

    try {
      const response = await fetch(healthUrl);
      if (response.ok) {
        return { child, output: () => output };
      }
    } catch {
      // The child may still be recovering the deletion backups or binding its port.
    }
    await wait(50);
  }

  child.kill("SIGTERM");
  throw new Error(`Production server did not become ready:\n${output}`);
}

async function stopProductionServer(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await once(child, "exit");
}

test("recovers interrupted photo deletions before a restarted server accepts requests", async () => {
  const restored = await uploadFailureTestPhoto("restart-restored.jpg");
  const preserved = await uploadFailureTestPhoto("restart-preserved.jpg");
  const deleted = await uploadFailureTestPhoto("restart-deleted.jpg");
  const fixtures = [restored, preserved, deleted];
  const backupDirectories = fixtures.map(({ filePath }, index) =>
    path.join(path.dirname(filePath), `.photo-delete-restart-${index}`),
  );
  const backupPaths = fixtures.map(({ filePath }, index) =>
    path.join(backupDirectories[index], path.basename(filePath)),
  );
  const preservedOriginalBytes = Buffer.from("the surviving original");
  const staleBackupBytes = Buffer.from("stale backup bytes");
  let productionServer: ChildProcess | undefined;

  try {
    // Simulate the process stopping after the backup copy, before its next
    // deletion step, for each possible database/filesystem state.
    await rm(restored.filePath, { force: true });
    await fs.promises.mkdir(backupDirectories[0], { recursive: true });
    await fs.promises.writeFile(backupPaths[0], jpegBytes);

    await fs.promises.writeFile(preserved.filePath, preservedOriginalBytes);
    await fs.promises.mkdir(backupDirectories[1], { recursive: true });
    await fs.promises.writeFile(backupPaths[1], staleBackupBytes);

    await fs.promises.mkdir(backupDirectories[2], { recursive: true });
    await fs.promises.copyFile(deleted.filePath, backupPaths[2]);
    await db.delete(studentPhotosTable).where(eq(studentPhotosTable.id, deleted.uploaded.id));

    const started = await startProductionServer();
    productionServer = started.child;

    const [restoredRow] = await db
      .select({ id: studentPhotosTable.id })
      .from(studentPhotosTable)
      .where(eq(studentPhotosTable.id, restored.uploaded.id));
    const [preservedRow] = await db
      .select({ id: studentPhotosTable.id })
      .from(studentPhotosTable)
      .where(eq(studentPhotosTable.id, preserved.uploaded.id));
    const [deletedRow] = await db
      .select({ id: studentPhotosTable.id })
      .from(studentPhotosTable)
      .where(eq(studentPhotosTable.id, deleted.uploaded.id));

    assert(restoredRow, "a surviving row must remain after restart recovery");
    assert(preservedRow, "a row with a surviving original must remain after restart recovery");
    assert.equal(deletedRow, undefined, "a committed row deletion must remain committed");
    assert.deepEqual(await readFile(restored.filePath), jpegBytes, "missing originals must be restored");
    assert.deepEqual(
      await readFile(preserved.filePath),
      preservedOriginalBytes,
      "recovery must not overwrite a surviving original",
    );
    assert.equal(
      fs.existsSync(deleted.filePath),
      false,
      "an original without a database row must be removed",
    );
    for (const backupDirectory of backupDirectories) {
      assert.equal(
        fs.existsSync(backupDirectory),
        false,
        "successfully reconciled backups must be removed",
      );
    }
  } finally {
    if (productionServer) {
      await stopProductionServer(productionServer);
    }
    for (const fixture of fixtures) {
      await db.delete(studentPhotosTable).where(eq(studentPhotosTable.id, fixture.uploaded.id));
      await rm(fixture.filePath, { force: true });
    }
    for (const backupDirectory of backupDirectories) {
      await rm(backupDirectory, { recursive: true, force: true });
    }
  }
});

test("restores the photo row when removing its file fails", async () => {
  const { uploaded, filePath } = await uploadFailureTestPhoto("unlink-failure.jpg");
  const originalUnlinkSync = fs.unlinkSync;
  fs.unlinkSync = ((target: fs.PathLike) => {
    if (path.resolve(String(target)) === filePath) {
      throw new Error("intentional unlink failure");
    }
    return originalUnlinkSync(target);
  }) as typeof fs.unlinkSync;

  try {
    const response = await fetch(
      `${baseUrl}/api/projects/${projectId}/students/${studentId}/photos/${uploaded.id}`,
      { method: "DELETE" },
    );
    assert.equal(response.status, 500);
    const [storedPhoto] = await db
      .select()
      .from(studentPhotosTable)
      .where(eq(studentPhotosTable.id, uploaded.id));
    assert(storedPhoto, "the photo row should be restored after unlink fails");
    assert.deepEqual(await readFile(filePath), jpegBytes);
  } finally {
    fs.unlinkSync = originalUnlinkSync;
    await db.delete(studentPhotosTable).where(eq(studentPhotosTable.id, uploaded.id));
    await rm(filePath, { force: true });
  }
});

test("keeps a durable backup when restoring the deleted row fails", async () => {
  const { uploaded, filePath } = await uploadFailureTestPhoto("restore-failure.jpg");
  const originalUnlinkSync = fs.unlinkSync;
  fs.unlinkSync = ((target: fs.PathLike) => {
    if (path.resolve(String(target)) === filePath) {
      throw new Error("intentional unlink failure");
    }
    return originalUnlinkSync(target);
  }) as typeof fs.unlinkSync;
  const triggerName = `photo_restore_failure_${process.pid}_${Date.now()}`;
  const functionName = `${triggerName}_function`;
  await pool.query(`
    CREATE FUNCTION ${functionName}() RETURNS trigger AS $$
    BEGIN
      IF NEW.id = ${uploaded.id} THEN
        RAISE EXCEPTION 'intentional photo restore failure';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `);
  await pool.query(`
    CREATE TRIGGER ${triggerName}
    BEFORE INSERT ON student_photos
    FOR EACH ROW EXECUTE FUNCTION ${functionName}()
  `);

  const parentDirectory = path.dirname(filePath);
  try {
    const response = await fetch(
      `${baseUrl}/api/projects/${projectId}/students/${studentId}/photos/${uploaded.id}`,
      { method: "DELETE" },
    );
    assert.equal(response.status, 500);
    assert.deepEqual(await readFile(filePath), jpegBytes, "the original remains readable");
    const backupDirectories = (await readdir(parentDirectory))
      .filter((entry) => entry.startsWith(".photo-delete-"));
    assert(backupDirectories.length > 0, "failed compensation must retain a recovery backup");
    const backupPath = path.join(parentDirectory, backupDirectories[0], path.basename(filePath));
    assert.deepEqual(await readFile(backupPath), jpegBytes);
  } finally {
    fs.unlinkSync = originalUnlinkSync;
    await pool.query(`DROP TRIGGER IF EXISTS ${triggerName} ON student_photos`);
    await pool.query(`DROP FUNCTION IF EXISTS ${functionName}()`);
    await db.insert(studentPhotosTable).values({
      id: uploaded.id,
      projectId: uploaded.projectId,
      studentId: uploaded.studentId,
      fileName: uploaded.fileName,
      fileUrl: uploaded.fileUrl,
      mimeType: uploaded.mimeType,
      capturedAt: uploaded.capturedAt,
      createdAt: new Date(uploaded.createdAt),
    }).onConflictDoNothing();
    await db.delete(studentPhotosTable).where(eq(studentPhotosTable.id, uploaded.id));
    for (const entry of await readdir(parentDirectory)) {
      if (entry.startsWith(".photo-delete-")) {
        await rm(path.join(parentDirectory, entry), { recursive: true, force: true });
      }
    }
    await rm(filePath, { force: true });
  }
});

test("finishes deletion when only backup cleanup fails", async () => {
  const { uploaded, filePath } = await uploadFailureTestPhoto("cleanup-failure.jpg");
  const originalRmSync = fs.rmSync;
  let blockedBackupDirectory: string | undefined;
  fs.rmSync = ((target: fs.PathLike, options?: fs.RmDirOptions) => {
    if (path.basename(String(target)).startsWith(".photo-delete-")) {
      blockedBackupDirectory = String(target);
      throw new Error("intentional backup cleanup failure");
    }
    return originalRmSync(target, options);
  }) as typeof fs.rmSync;

  try {
    const response = await fetch(
      `${baseUrl}/api/projects/${projectId}/students/${studentId}/photos/${uploaded.id}`,
      { method: "DELETE" },
    );
    assert.equal(response.status, 204);
    assert.equal(fs.existsSync(filePath), false);
    const [storedPhoto] = await db
      .select({ id: studentPhotosTable.id })
      .from(studentPhotosTable)
      .where(eq(studentPhotosTable.id, uploaded.id));
    assert.equal(storedPhoto, undefined);
    assert(blockedBackupDirectory && fs.existsSync(blockedBackupDirectory));
    assert.deepEqual(
      await readFile(path.join(blockedBackupDirectory, path.basename(filePath))),
      jpegBytes,
    );
  } finally {
    fs.rmSync = originalRmSync;
    if (blockedBackupDirectory) {
      await rm(blockedBackupDirectory, { recursive: true, force: true });
    }
    await db.delete(studentPhotosTable).where(eq(studentPhotosTable.id, uploaded.id));
    await rm(filePath, { force: true });
  }
});

test("restores a photo after a process stops with only its deletion backup", async () => {
  const { uploaded, filePath } = await uploadFailureTestPhoto("interrupted-delete.jpg");
  const backupDirectory = path.join(path.dirname(filePath), ".photo-delete-interrupted");
  const backupPath = path.join(backupDirectory, path.basename(filePath));
  await rm(filePath, { force: true });
  await fs.promises.mkdir(backupDirectory, { recursive: true });
  await fs.promises.writeFile(backupPath, jpegBytes);

  try {
    await recoverPhotoDeleteBackups();
    assert.deepEqual(await readFile(filePath), jpegBytes, "recovery must preserve uploaded bytes");
    assert.equal(fs.existsSync(backupDirectory), false, "a recovered backup should be removed");
    const [storedPhoto] = await db
      .select({ id: studentPhotosTable.id })
      .from(studentPhotosTable)
      .where(eq(studentPhotosTable.id, uploaded.id));
    assert(storedPhoto, "recovery must retain the database row");
  } finally {
    await db.delete(studentPhotosTable).where(eq(studentPhotosTable.id, uploaded.id));
    await rm(filePath, { force: true });
    await rm(backupDirectory, { recursive: true, force: true });
  }
});

test("does not overwrite a valid original when an interrupted backup is stale", async () => {
  const { uploaded, filePath } = await uploadFailureTestPhoto("valid-original-delete.jpg");
  const backupDirectory = path.join(path.dirname(filePath), ".photo-delete-stale");
  const backupPath = path.join(backupDirectory, path.basename(filePath));
  const validOriginalBytes = Buffer.from("valid-original");
  const staleBackupBytes = Buffer.from("stale-backup");
  await fs.promises.writeFile(filePath, validOriginalBytes);
  await fs.promises.mkdir(backupDirectory, { recursive: true });
  await fs.promises.writeFile(backupPath, staleBackupBytes);

  try {
    await recoverPhotoDeleteBackups();
    assert.deepEqual(await readFile(filePath), validOriginalBytes);
    assert.notDeepEqual(await readFile(filePath), staleBackupBytes);
    assert.equal(fs.existsSync(backupDirectory), false, "a stale backup should be cleaned");
  } finally {
    await db.delete(studentPhotosTable).where(eq(studentPhotosTable.id, uploaded.id));
    await rm(filePath, { force: true });
    await rm(backupDirectory, { recursive: true, force: true });
  }
});

test("alerts once and preserves an ambiguous deletion backup for manual recovery", async () => {
  const { uploaded, filePath } = await uploadFailureTestPhoto("ambiguous-delete.jpg");
  const backupDirectory = path.join(path.dirname(filePath), ".photo-delete-ambiguous");
  const backupPath = path.join(backupDirectory, path.basename(filePath));
  const extraPath = path.join(backupDirectory, "unexpected-extra-file");
  const alertMarkerPath = path.join(backupDirectory, ".photo-delete-recovery-alerted");
  await fs.promises.mkdir(backupDirectory, { recursive: true });
  await fs.promises.copyFile(filePath, backupPath);
  await fs.promises.writeFile(extraPath, "not a photo backup");

  try {
    await recoverPhotoDeleteBackups();
    await recoverPhotoDeleteBackups();

    assert(fs.existsSync(backupPath), "an ambiguous backup must remain available");
    assert(fs.existsSync(extraPath), "ambiguous backup contents must remain untouched");
    assert(fs.existsSync(alertMarkerPath), "an unsafe recovery alert must be persisted");
    assert(fs.existsSync(filePath), "the original must remain untouched for manual recovery");
    const [storedPhoto] = await db
      .select({ id: studentPhotosTable.id })
      .from(studentPhotosTable)
      .where(eq(studentPhotosTable.id, uploaded.id));
    assert(storedPhoto, "an ambiguous backup must not change the database row");
  } finally {
    await db.delete(studentPhotosTable).where(eq(studentPhotosTable.id, uploaded.id));
    await rm(filePath, { force: true });
    await rm(backupDirectory, { recursive: true, force: true });
  }
});

test("cleans an interrupted deletion after its database row is gone", async () => {
  const { uploaded, filePath } = await uploadFailureTestPhoto("committed-delete.jpg");
  const backupDirectory = path.join(path.dirname(filePath), ".photo-delete-committed");
  const backupPath = path.join(backupDirectory, path.basename(filePath));
  await fs.promises.mkdir(backupDirectory, { recursive: true });
  await fs.promises.copyFile(filePath, backupPath);
  await db.delete(studentPhotosTable).where(eq(studentPhotosTable.id, uploaded.id));

  try {
    await recoverPhotoDeleteBackups();
    assert.equal(fs.existsSync(filePath), false, "a deleted row permits orphan cleanup");
    assert.equal(fs.existsSync(backupDirectory), false, "the orphaned backup should be cleaned");
  } finally {
    await db.delete(studentPhotosTable).where(eq(studentPhotosTable.id, uploaded.id));
    await rm(filePath, { force: true });
    await rm(backupDirectory, { recursive: true, force: true });
  }
});

test("limits photographer desktops to assignments, gives admins studio access, and revokes only one connection", async () => {
  const listResponse = await fetch(`${baseUrl}/api/desktop/projects`, {
    headers: { Authorization: `Bearer ${desktopCredentials.token}` },
  });
  assert.equal(listResponse.status, 200);
  const projects = await listResponse.json() as { id: number }[];
  assert(projects.some((project) => project.id === projectId), "assigned project should be listed");
  assert(!projects.some((project) => project.id === hiddenProjectId), "unassigned project must not be listed");

  const bundleResponse = await fetch(`${baseUrl}/api/desktop/projects/${hiddenProjectId}/bundle`, {
    headers: { Authorization: `Bearer ${desktopCredentials.token}` },
  });
  assert.equal(bundleResponse.status, 404, "unassigned project bundle must be hidden");

  const adminListResponse = await fetch(`${baseUrl}/api/desktop/projects`, {
    headers: { Authorization: `Bearer ${adminDesktopCredentials.token}` },
  });
  assert.equal(adminListResponse.status, 200);
  const adminProjects = await adminListResponse.json() as { id: number }[];
  assert.deepEqual(
    adminProjects.map((project) => project.id).sort((a, b) => a - b),
    [projectId, hiddenProjectId].sort((a, b) => a - b),
    "an admin desktop should see every project in its studio without assignments",
  );

  const adminBundleResponse = await fetch(`${baseUrl}/api/desktop/projects/${projectId}/bundle`, {
    headers: { Authorization: `Bearer ${adminDesktopCredentials.token}` },
  });
  assert.equal(adminBundleResponse.status, 200, "an admin desktop should download an unassigned studio bundle");

  const adminUpload = new (globalThis as any).FormData();
  adminUpload.append(
    "photo",
    new (globalThis as any).Blob([jpegBytes], { type: "image/jpeg" }),
    "admin-studio-upload.jpg",
  );
  const adminUploadResponse = await fetch(
    `${baseUrl}/api/projects/${projectId}/students/${studentId}/photos`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${adminDesktopCredentials.token}` },
      body: adminUpload,
    },
  );
  assert.equal(adminUploadResponse.status, 201, "an admin desktop should upload to any project in its studio");
  const adminUploaded = await adminUploadResponse.json() as PhotoResponse;
  await db.delete(studentPhotosTable).where(eq(studentPhotosTable.id, adminUploaded.id));
  await rm(path.resolve(process.cwd(), adminUploaded.fileUrl.replace(/^\//, "")), { force: true });

  await db
    .update(desktopConnectionsTable)
    .set({ status: "revoked", revokedAt: new Date() })
    .where(and(
      eq(desktopConnectionsTable.memberId, memberId),
      eq(desktopConnectionsTable.tokenHash, desktopCredentials.tokenHash),
    ));

  const revokedResponse = await fetch(`${baseUrl}/api/desktop/projects`, {
    headers: { Authorization: `Bearer ${desktopCredentials.token}` },
  });
  assert.equal(revokedResponse.status, 401);

  const otherConnectionResponse = await fetch(`${baseUrl}/api/desktop/projects`, {
    headers: { Authorization: `Bearer ${otherDesktopCredentials.token}` },
  });
  assert.equal(otherConnectionResponse.status, 200, "revoking one device must not interrupt another");
});

test("rejects encoded traversal identifiers before writing an upload", async () => {
  const form = new (globalThis as any).FormData();
  form.append(
    "photo",
    new (globalThis as any).Blob([jpegBytes], { type: "image/jpeg" }),
    "traversal-attempt.jpg",
  );

  const response = await fetch(
    `${baseUrl}/api/projects/%2E%2E%2Foutside/students/${studentId}/photos`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${otherDesktopCredentials.token}` },
      body: form,
    },
  );
  assert.equal(response.status, 400);
  assert(!fs.existsSync(path.resolve(process.cwd(), "uploads", "outside")), "invalid identifiers must not create an upload directory");
});

test("shows a class photo for every group member even without an individual portrait", async () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const [testClass] = await db.insert(classesTable).values({
    projectId,
    className: `5EM A ${suffix}`,
  }).returning();
  const [photographed, absent] = await db.insert(studentsTable).values([
    {
      projectId, classId: testClass.id, firstName: "Photographed", lastName: "Student",
      generatedStudentId: `GROUP-PHOTO-${suffix}`,
    },
    {
      projectId, classId: testClass.id, firstName: "Absent", lastName: "Student",
      generatedStudentId: `GROUP-ABSENT-${suffix}`,
    },
  ]).returning();
  const [group] = await db.insert(groupsTable).values({
    projectId, classId: testClass.id, name: `Class ${suffix}`, isDefaultClassGroup: true,
  }).returning();
  await db.insert(groupMembersTable).values([
    { groupId: group.id, studentId: photographed.id },
    { groupId: group.id, studentId: absent.id },
  ]);
  const [capture] = await db.insert(groupCapturesTable).values({
    projectId,
    groupId: group.id,
    captureKey: `class-photo-${suffix}`,
    baseFilename: `class-photo-${suffix}`,
    capturedAt: new Date().toISOString(),
    pairingStatus: "jpeg_only",
    rating: 5,
  }).returning();
  const [file] = await db.insert(groupCaptureFilesTable).values({
    captureId: capture.id,
    fileRole: "JPEG",
    fileFormat: "jpg",
    originalFilename: `class-photo-${suffix}.jpg`,
    fileUrl: `/uploads/groups/${suffix}.jpg`,
    durableObjectPath: `/objects/groups/${suffix}.jpg`,
    mimeType: "image/jpeg",
  }).returning();
  await projectGroupJpegToPhotographedStudents(capture, file);
  const projected = await db.select().from(studentPhotosTable)
    .where(eq(studentPhotosTable.sourceGroupCaptureFileId, file.id));
  assert.deepEqual(
    new Set(projected.map((photo) => photo.studentId)),
    new Set([photographed.id, absent.id]),
  );
  assert(projected.every((photo) => photo.rating === 5));
  assert(projected.every((photo) => photo.shareWithParents));
});