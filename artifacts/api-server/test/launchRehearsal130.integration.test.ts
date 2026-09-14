import { strict as assert } from "node:assert";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { rm } from "node:fs/promises";
import path from "node:path";
import test, { after, before } from "node:test";
import express from "express";
import { and, eq } from "drizzle-orm";
import {
  classesTable,
  captureBatchesTable,
  captureFilesTable,
  db,
  deliveryAccessesTable,
  deliveryGalleriesTable,
  deliveryPriceSheetsTable,
  desktopConnectionsTable,
  projectAssignmentsTable,
  projectsTable,
  pool,
  studentPhotosTable,
  studentsTable,
  studioMembersTable,
  studiosTable,
} from "@workspace/db";
import classesRouter from "../src/routes/classes";
import deliveryRouter from "../src/routes/delivery";
import desktopRouter from "../src/routes/desktop";
import importRouter from "../src/routes/import";
import photosRouter from "../src/routes/photos";
import projectsRouter from "../src/routes/projects";
import { decryptStorageValue } from "../src/lib/storageCrypto";
import { createDesktopToken } from "../src/lib/desktopAuth";
import {
  clearGoogleDriveFolderCacheForTests,
  setPlatformDriveRequesterForTests,
  type DriveRequester,
} from "../src/lib/googleDriveBackup";

process.env.NODE_ENV = "test";
process.env.SESSION_SECRET = "launch-rehearsal-130-session-secret-that-is-at-least-32-bytes";
process.env.PUBLIC_APP_URL = "https://gallery.launch.test";

const suffix = `${process.pid}-${Date.now()}`;
const ownerUserId = `launch-rehearsal-130-owner-${suffix}`;
const jpegBytes = Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAH/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAEFAqf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/AX//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/AX//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAY/Aqf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/IV//2gAMAwEAAgADAAAAEP/EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQMBAT8QH//EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQIBAT8QH//EABQQAQAAAAAAAAAAAAAAAAAAABD/2gAIAQEAAT8QH//Z",
  "base64",
);
const rawBytes = Buffer.from("task-130-real-raw-capture");
const desktopCredentials = createDesktopToken();
const driveFiles: string[] = [];
const mockDriveRequester: DriveRequester = async (requestPath, options = {}) => {
  const method = options.method ?? "GET";
  if (requestPath.startsWith("/drive/v3/about?") && method === "GET") {
    return Response.json({ user: { permissionId: "launch-rehearsal-130-platform" } });
  }
  if (requestPath.startsWith("/drive/v3/files?") && method === "GET") {
    return Response.json({ files: [] });
  }
  if (requestPath.startsWith("/drive/v3/files?") && method === "POST") {
    const metadata = JSON.parse(String(options.body)) as { name?: string };
    return Response.json({ id: `launch-folder-${driveFiles.length + 1}`, name: metadata.name });
  }
  if (requestPath.startsWith("/upload/drive/v3/files?") && method === "POST") {
    const location = `https://launch-rehearsal-130.invalid/${driveFiles.length + 1}`;
    driveFiles.push(location);
    return new Response(null, { headers: { location } });
  }
  if (requestPath.startsWith("https://launch-rehearsal-130.invalid/") && method === "PUT") {
    return Response.json({ id: `launch-file-${driveFiles.length}` });
  }
  return Response.json({ error: "Unexpected mocked Drive request" }, { status: 500 });
};

const offerJson = JSON.stringify({
  offers: [{
    id: "digital",
    name: "Digital photo",
    productType: "digital",
    unitAmount: 100,
    currency: "usd",
    paymentMethods: ["establishment"],
    photoCount: 1,
    deliveryMethods: ["digital"],
    active: true,
    includesDigitalDownloads: true,
  }],
});

let server: Server;
let baseUrl: string;
let studioId: number;
let memberId: number;
let projectId: number;
let studentId: number;
const uploadedPaths: string[] = [];

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  const userId = req.header("x-test-user") ?? ownerUserId;
  const authHandler = Object.assign(
    () => ({ tokenType: "session_token", userId, sessionClaims: { userId } }),
    { [Symbol.for("@clerk/express.auth")]: true },
  );
  (req as any).auth = authHandler;
  next();
});
app.use("/api/projects/:projectId/captures", photosRouter);
app.use("/api/projects/:projectId/students", photosRouter);
app.use("/api/projects/:projectId/classes", classesRouter);
app.use("/api/projects/:projectId/import", importRouter);
app.use("/api/projects", projectsRouter);
app.use("/api/desktop", photosRouter);
app.use("/api/desktop", desktopRouter);
app.use("/api", deliveryRouter);

async function request(userId: string, pathname: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("x-test-user", userId);
  if (init.body && !headers.has("content-type") && !(init.body instanceof FormData)) {
    headers.set("content-type", "application/json");
  }
  return fetch(`${baseUrl}${pathname}`, { ...init, headers });
}

async function json<T>(response: Response): Promise<T> {
  return response.json() as Promise<T>;
}

function rosterSheet(className: string) {
  return {
    sheetName: className,
    className,
    firstNameColumn: "First",
    lastNameColumn: "Last",
    studentIdColumn: "Roster ID",
    emailColumn: null,
    secondaryEmailColumn: null,
    phoneColumn: null,
    jobTitleColumn: null,
    officeLocationColumn: null,
    photoSessionColumn: null,
    headers: ["First", "Last", "Roster ID"],
    rows: [["Stable", "Student", "TASK-130-STABLE-ID"]],
  };
}

before(async () => {
  clearGoogleDriveFolderCacheForTests();
  setPlatformDriveRequesterForTests(mockDriveRequester);
  const [studio] = await db.insert(studiosTable).values({
    name: `Launch rehearsal 130 studio ${suffix}`,
    createdByUserId: ownerUserId,
  }).returning({ id: studiosTable.id });
  studioId = studio.id;
  const [member] = await db.insert(studioMembersTable).values({
    studioId,
    userId: ownerUserId,
    email: `${ownerUserId}@member.local`,
    role: "owner",
  }).returning({ id: studioMembersTable.id });
  memberId = member.id;
  const [priceSheet] = await db.insert(deliveryPriceSheetsTable).values({
    studioId,
    name: `Launch rehearsal 130 prices ${suffix}`,
    offersJson: offerJson,
  }).returning({ id: deliveryPriceSheetsTable.id });
  await db.insert(desktopConnectionsTable).values({
    studioId,
    memberId,
    deviceName: "Launch rehearsal Mac",
    tokenHash: desktopCredentials.tokenHash,
    tokenPrefix: desktopCredentials.tokenPrefix,
  });

  server = createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  baseUrl = `http://127.0.0.1:${address.port}`;

  const projectResponse = await request(ownerUserId, "/api/projects", {
    method: "POST",
    body: JSON.stringify({
      projectType: "school",
      schoolName: `Task 130 launch school ${suffix}`,
      priceSheetId: priceSheet.id,
    }),
  });
  assert.equal(projectResponse.status, 201);
  const project = await json<{ id: number }>(projectResponse);
  projectId = project.id;
  await db.insert(projectAssignmentsTable).values({ projectId, memberId });

  const importResponse = await request(ownerUserId, `/api/projects/${projectId}/import/confirm`, {
    method: "POST",
    body: JSON.stringify({ sheets: [rosterSheet("Class One")] }),
  });
  assert.equal(importResponse.status, 200);
  const imported = await db.select({ id: studentsTable.id })
    .from(studentsTable)
    .where(eq(studentsTable.projectId, projectId));
  assert.equal(imported.length, 1);
  studentId = imported[0].id;
});

after(async () => {
  setPlatformDriveRequesterForTests();
  clearGoogleDriveFolderCacheForTests();
  await Promise.all(uploadedPaths.map((filePath) => rm(filePath, { force: true })));
  if (studioId) await db.delete(studiosTable).where(eq(studiosTable.id, studioId));
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await pool.end();
});

test("Task 130 rehearses cards, reconnect upload, delivery, and stable-ID class moves", async () => {
  const beforePhotos = await db.select().from(studentPhotosTable).where(eq(studentPhotosTable.projectId, projectId));
  assert.equal(beforePhotos.length, 0, "pre-photo-day preparation must not upload a photo");

  const prepareResponse = await request(ownerUserId, `/api/projects/${projectId}/delivery/access-cards/prepare`, {
    method: "POST",
  });
  assert.equal(prepareResponse.status, 200);
  const prepared = await json<{
    gallery: { slug: string; status: string };
    cards: Array<{ studentId: number; accessCode: string; accessUrl: string; qrUrl: string }>;
  }>(prepareResponse);
  assert.equal(prepared.gallery.status, "draft");
  const card = prepared.cards.find((candidate) => candidate.studentId === studentId);
  assert(card);
  assert.match(card.accessUrl, /^https:\/\/gallery\.launch\.test\/delivery\//);
  assert.equal(card.accessUrl.includes(card.accessCode), false);
  assert.equal(card.qrUrl, `https://gallery.launch.test/delivery/${prepared.gallery.slug}#code=${card.accessCode}`);
  const beforeReconnectPhotos = await db.select().from(studentPhotosTable)
    .where(eq(studentPhotosTable.projectId, projectId));
  assert.equal(beforeReconnectPhotos.length, 0, "the prepared card must still have no uploaded photo before reconnect");
  const [preparedGallery] = await db.select({ id: deliveryGalleriesTable.id })
    .from(deliveryGalleriesTable)
    .where(eq(deliveryGalleriesTable.projectId, projectId));
  assert(preparedGallery);
  const [preparedAccess] = await db.select().from(deliveryAccessesTable)
    .where(and(
      eq(deliveryAccessesTable.galleryId, preparedGallery.id),
      eq(deliveryAccessesTable.studentId, studentId),
    ));
  assert(preparedAccess);
  const credential = {
    hash: preparedAccess.accessCodeHash,
    encrypted: preparedAccess.accessCodeEncrypted,
    last4: preparedAccess.accessCodeLast4,
    code: decryptStorageValue<string>(preparedAccess.accessCodeEncrypted),
    qrUrl: card.qrUrl,
  };
  assert.equal(card.accessCode, credential.code);

  // The photographer can finish a local/offline capture before reconnecting.
  // The first cloud operation is the real desktop batch contract.
  const batchKey = `task-130-${suffix}`;
  const batchResponse = await fetch(`${baseUrl}/api/desktop/projects/${projectId}/capture-batches`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${desktopCredentials.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ batchKey, expectedFileCount: 2 }),
  });
  assert.equal(batchResponse.status, 201);

  const captureKey = `task-130-capture-${suffix}`;
  const upload = async (
    role: "JPEG" | "RAW",
    filename: string,
    bytes: Buffer,
    mimeType: string,
    uploadId: string,
  ) => {
    const form = new FormData();
    form.append("file", new Blob([bytes], { type: mimeType }), filename);
    form.append("captureKey", captureKey);
    form.append("baseFilename", "stable-student-portrait");
    form.append("fileRole", role);
    form.append("fileFormat", role === "RAW" ? "NEF" : "JPEG");
    form.append("capturedAt", "2026-08-22T12:34:56.000Z");
    form.append("sequence", "1");
    const response = await fetch(
      `${baseUrl}/api/projects/${projectId}/students/${studentId}/captures`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${desktopCredentials.token}`,
          "X-MC-Upload-Id": uploadId,
          "X-MC-Capture-Batch": batchKey,
        },
        body: form,
      },
    );
    assert.equal(response.status, 201);
    return json<{
      captureId: number;
      pairingStatus: string;
      file: { id: number; fileRole: string; fileUrl: string };
    }>(response);
  };

  const jpeg = await upload("JPEG", "stable-student-portrait.jpg", jpegBytes, "image/jpeg", `task-130-jpeg-${suffix}`);
  uploadedPaths.push(path.resolve(process.cwd(), jpeg.file.fileUrl.replace(/^\//, "")));
  assert.equal(jpeg.pairingStatus, "jpeg_only");
  const raw = await upload("RAW", "stable-student-portrait.nef", rawBytes, "application/octet-stream", `task-130-raw-${suffix}`);
  uploadedPaths.push(path.resolve(process.cwd(), raw.file.fileUrl.replace(/^\//, "")));
  assert.equal(raw.captureId, jpeg.captureId);
  assert.equal(raw.pairingStatus, "complete");
  assert.equal(raw.file.fileRole, "RAW");

  const finishResponse = await fetch(`${baseUrl}/api/desktop/projects/${projectId}/capture-batches/${batchKey}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${desktopCredentials.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ status: "complete", failedFileCount: 0, handoffComment: "Reconnected after offline capture." }),
  });
  assert.equal(finishResponse.status, 200);
  const finishedBatch = await json<{ status: string; uploadedFileCount: number }>(finishResponse);
  assert.deepEqual(
    { status: finishedBatch.status, uploadedFileCount: finishedBatch.uploadedFileCount },
    { status: "complete", uploadedFileCount: 2 },
  );

  const [photo] = await db.select().from(studentPhotosTable).where(and(
    eq(studentPhotosTable.projectId, projectId),
    eq(studentPhotosTable.studentId, studentId),
    eq(studentPhotosTable.fileName, "stable-student-portrait.jpg"),
  ));
  assert(photo, "the desktop JPEG should be projected through the real capture API");
  const webReviewResponse = await request(ownerUserId, `/api/projects/${projectId}/students/${studentId}/photos/${photo.id}/review`, {
    method: "PATCH",
    body: JSON.stringify({ decision: "selected", rating: 5 }),
  });
  assert.equal(webReviewResponse.status, 200);
  const reviewed = await json<{ photo: { rating: number; shareWithParents: boolean } }>(webReviewResponse);
  assert.equal(reviewed.photo.rating, 5);
  assert.equal(reviewed.photo.shareWithParents, true);

  const captureListResponse = await request(ownerUserId, `/api/projects/${projectId}/captures`);
  assert.equal(captureListResponse.status, 200);
  const captureList = await json<{
    students: Array<{ studentId: number; captures: Array<{ id: number; pairingStatus: string; files: Array<{ fileRole: string }> }> }>;
  }>(captureListResponse);
  const listedCapture = captureList.students.find((student) => student.studentId === studentId)?.captures
    .find((capture) => capture.id === jpeg.captureId);
  assert(listedCapture);
  assert.equal(listedCapture.pairingStatus, "complete");
  assert.deepEqual(listedCapture.files.map((file) => file.fileRole).sort(), ["JPEG", "RAW"]);

  const publishResponse = await request(ownerUserId, `/api/projects/${projectId}/delivery/publish`, {
    method: "POST",
  });
  assert.equal(publishResponse.status, 200);
  const published = await json<{ gallery: { status: string; slug: string } }>(publishResponse);
  assert.equal(published.gallery.status, "published");
  assert.equal(published.gallery.slug, prepared.gallery.slug);

  const [publishedAccess] = await db.select().from(deliveryAccessesTable)
    .where(eq(deliveryAccessesTable.id, preparedAccess.id));
  assert(publishedAccess);
  assert.deepEqual({
    hash: publishedAccess.accessCodeHash,
    encrypted: publishedAccess.accessCodeEncrypted,
    last4: publishedAccess.accessCodeLast4,
    code: decryptStorageValue<string>(publishedAccess.accessCodeEncrypted),
  }, {
    hash: credential.hash,
    encrypted: credential.encrypted,
    last4: credential.last4,
    code: credential.code,
  });

  const accessResponse = await request("public", `/api/delivery/${prepared.gallery.slug}/access`, {
    method: "POST",
    body: JSON.stringify({ code: credential.code, email: `parent-${suffix}@example.com` }),
  });
  assert.equal(accessResponse.status, 200);
  const accessToken = (await json<{ token: string }>(accessResponse)).token;
  const galleryResponse = await request("public", `/api/delivery/${prepared.gallery.slug}/gallery`, {
    headers: { "x-delivery-token": accessToken },
  });
  assert.equal(galleryResponse.status, 200);
  const gallery = await json<{ student: { departmentName: string }; photos: Array<{ fileName: string; mimeType: string }> }>(galleryResponse);
  assert.equal(gallery.photos.length, 1);
  assert.equal(gallery.photos[0]?.fileName, "stable-student-portrait.jpg");
  assert.equal(gallery.photos[0]?.mimeType, "image/jpeg");
  assert.doesNotMatch(JSON.stringify(gallery), /\.nef|stable-student-portrait\.nef/i);

  const updateResponse = await request(ownerUserId, `/api/projects/${projectId}/import/confirm`, {
    method: "POST",
    body: JSON.stringify({ sheets: [rosterSheet("Class Two")] }),
  });
  assert.equal(updateResponse.status, 200);
  const update = await json<{ studentsUpdated: number; studentsMoved: number }>(updateResponse);
  assert.equal(update.studentsUpdated, 1);
  assert.equal(update.studentsMoved, 1);
  const [movedStudent] = await db.select().from(studentsTable).where(eq(studentsTable.id, studentId));
  assert(movedStudent);
  const [movedClass] = await db.select().from(classesTable).where(eq(classesTable.id, movedStudent.classId));
  assert.equal(movedClass.className, "Class Two");

  const reprepareResponse = await request(ownerUserId, `/api/projects/${projectId}/delivery/access-cards/prepare`, {
    method: "POST",
  });
  assert.equal(reprepareResponse.status, 200);
  const reprepared = await json<{ cards: Array<{ studentId: number; accessCode: string; qrUrl: string }> }>(reprepareResponse);
  const movedCard = reprepared.cards.find((candidate) => candidate.studentId === studentId);
  assert(movedCard);
  assert.equal(movedCard.accessCode, credential.code);
  assert.equal(movedCard.qrUrl, credential.qrUrl);

  const movedAccessResponse = await request("public", `/api/delivery/${prepared.gallery.slug}/access`, {
    method: "POST",
    body: JSON.stringify({ code: credential.code, email: `parent-after-move-${suffix}@example.com` }),
  });
  assert.equal(movedAccessResponse.status, 200);
  const movedToken = (await json<{ token: string }>(movedAccessResponse)).token;
  const movedGalleryResponse = await request("public", `/api/delivery/${prepared.gallery.slug}/gallery`, {
    headers: { "x-delivery-token": movedToken },
  });
  assert.equal(movedGalleryResponse.status, 200);
  const movedGallery = await json<{ student: { departmentName: string }; photos: Array<{ fileName: string }> }>(movedGalleryResponse);
  assert.equal(movedGallery.student.departmentName, "Class Two");
  assert.deepEqual(movedGallery.photos.map((photo) => photo.fileName), ["stable-student-portrait.jpg"]);

  const [storedBatch] = await db.select().from(captureBatchesTable).where(eq(captureBatchesTable.batchKey, batchKey));
  assert.equal(storedBatch.status, "complete");
  const captureFiles = await db.select().from(captureFilesTable).where(eq(captureFilesTable.captureId, jpeg.captureId));
  assert.deepEqual(captureFiles.map((file) => file.fileRole).sort(), ["JPEG", "RAW"]);
});