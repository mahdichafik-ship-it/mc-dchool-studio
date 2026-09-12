import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { Readable } from "node:stream";
import test, { after, before } from "node:test";
import express from "express";
import { eq } from "drizzle-orm";
import {
  classesTable,
  db,
  deliveryAccessesTable,
  deliveryGalleriesTable,
  deliveryOrderItemsTable,
  deliveryOrdersTable,
  groupCaptureFilesTable,
  groupCapturesTable,
  groupsTable,
  photoStorageCopiesTable,
  pool,
  projectsTable,
  studentPhotosTable,
  studentsTable,
  studiosTable,
} from "@workspace/db";
import deliveryRouter from "../src/routes/delivery";
import { ObjectStorageService } from "../src/lib/objectStorage";
import { encryptStorageValue } from "../src/lib/storageCrypto";

process.env.SESSION_SECRET = "delivery-r2-test-secret-that-is-at-least-32-bytes";
process.env.R2_ACCOUNT_ID = "delivery-r2-test-account";
process.env.R2_ACCESS_KEY_ID = "delivery-r2-test-key";
process.env.R2_SECRET_ACCESS_KEY = "delivery-r2-test-secret";
process.env.R2_BUCKET_NAME = "delivery-r2-test-bucket";
process.env.R2_ENDPOINT = "https://delivery-r2-test.invalid";
process.env.PRIVATE_OBJECT_DIR = "/delivery-r2-test";

const readyStudentBytes = Buffer.from("ready student R2 bytes");
const readyGroupBytes = Buffer.from("ready group R2 bytes");
const fallbackUploadingBytes = Buffer.from("replit fallback for uploading copy");
const fallbackFailedBytes = Buffer.from("replit fallback for failed copy");
const accessCode = "READY123";
const unpaidAccessCode = "UNPAID12";
const suffix = `${process.pid}-${Date.now()}`;

let server: Server;
let baseUrl: string;
let gallerySlug: string;
let readyStudentPhotoId: number;
let readyGroupPhotoId: number;
let uploadingPhotoId: number;
let failedPhotoId: number;
let unpaidPhotoId: number;
let unsharedPhotoId: number;
let paidAccessToken: string;
let unpaidAccessToken: string;
const r2RequestedKeys: string[] = [];
const r2Bodies = new Map<string, Buffer>();
const r2Failures = new Set<string>();
let objectStorageReads = 0;

const app = express();
app.use(express.json());
app.use("/api", deliveryRouter);

function hashCode(code: string): string {
  return createHash("sha256").update(code.trim().toUpperCase()).digest("hex");
}

async function requestPhoto(
  photoId: number,
  token: string,
  query = "download=1",
): Promise<Response> {
  return fetch(
    `${baseUrl}/api/delivery/${gallerySlug}/photos/${photoId}/file?${query}`,
    { headers: { "x-delivery-token": token } },
  );
}

async function insertPhoto(
  studentId: number,
  fileName: string,
): Promise<number> {
  const [photo] = await db.insert(studentPhotosTable).values({
    projectId,
    studentId,
    fileName,
    fileUrl: `/objects/${fileName}`,
    durableObjectPath: `/objects/${fileName}`,
    mimeType: "image/jpeg",
    rating: 1,
    shareWithParents: true,
  }).returning({ id: studentPhotosTable.id });
  return photo.id;
}

async function insertPaidItems(photoIds: number[]): Promise<void> {
  const [order] = await db.insert(deliveryOrdersTable).values({
    galleryId,
    accessId: paidAccessId,
    status: "paid",
    paymentMethod: "stripe",
    customerName: "R2 delivery test",
    fulfillmentStatus: "not_required",
    deliveryMethod: "digital",
    amountTotal: 100,
    currency: "usd",
    paidAt: new Date(),
  }).returning({ id: deliveryOrdersTable.id });
  await db.insert(deliveryOrderItemsTable).values(photoIds.map((photoId) => ({
    orderId: order.id,
    photoId,
    offerId: "digital-single",
    productName: "Digital photo",
    productType: "digital" as const,
    includesDigitalDownloads: true,
    quantity: 1,
    unitAmount: 100,
    currency: "usd",
  })));
}

let studioId: number;
let projectId: number;
let galleryId: number;
let paidAccessId: number;
let unpaidAccessId: number;
let studentId: number;
let unpaidStudentId: number;

const originalFetch = globalThis.fetch;
const originalObjectStorageGet = ObjectStorageService.prototype.getObjectEntityFile;

before(async () => {
  server = createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  baseUrl = `http://127.0.0.1:${address.port}`;

  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (!url.startsWith(process.env.R2_ENDPOINT!)) {
      return originalFetch(input, init);
    }
    const pathname = new URL(url).pathname.split("/").slice(2).join("/");
    const objectKey = decodeURIComponent(pathname);
    r2RequestedKeys.push(objectKey);
    if (r2Failures.has(objectKey)) {
      return new Response("R2 test read failure", { status: 503 });
    }
    const body = r2Bodies.get(objectKey);
    return body
      ? new Response(body, { headers: { "content-type": "image/jpeg" } })
      : new Response("not found", { status: 404 });
  };
  ObjectStorageService.prototype.getObjectEntityFile = async function () {
    objectStorageReads += 1;
    const bytes = thisPathBytes;
    return {
      createReadStream: () => Readable.from([bytes]),
    } as any;
  };

  const [studio] = await db.insert(studiosTable).values({
    name: `Delivery R2 test studio ${suffix}`,
    createdByUserId: `delivery-r2-test-${suffix}`,
  }).returning({ id: studiosTable.id });
  studioId = studio.id;
  const [project] = await db.insert(projectsTable).values({
    userId: `delivery-r2-test-${suffix}`,
    studioId,
    schoolName: `Delivery R2 test school ${suffix}`,
  }).returning({ id: projectsTable.id });
  projectId = project.id;
  const [studentClass] = await db.insert(classesTable).values({
    projectId,
    className: "Delivery R2 test class",
  }).returning({ id: classesTable.id });
  const [student] = await db.insert(studentsTable).values({
    projectId,
    classId: studentClass.id,
    firstName: "Ready",
    lastName: "Student",
    generatedStudentId: `R2READY${suffix}`,
  }).returning({ id: studentsTable.id });
  studentId = student.id;
  const [unpaidStudent] = await db.insert(studentsTable).values({
    projectId,
    classId: studentClass.id,
    firstName: "Unpaid",
    lastName: "Student",
    generatedStudentId: `R2UNPAID${suffix}`,
  }).returning({ id: studentsTable.id });
  unpaidStudentId = unpaidStudent.id;

  gallerySlug = `delivery-r2-${suffix}`;
  const [gallery] = await db.insert(deliveryGalleriesTable).values({
    projectId,
    studioId,
    slug: gallerySlug,
    status: "published",
  }).returning({ id: deliveryGalleriesTable.id });
  galleryId = gallery.id;
  const [paidAccess] = await db.insert(deliveryAccessesTable).values({
    galleryId,
    studentId,
    accessCodeHash: hashCode(accessCode),
    accessCodeEncrypted: encryptStorageValue(accessCode),
    accessCodeLast4: accessCode.slice(-4),
  }).returning({ id: deliveryAccessesTable.id });
  paidAccessId = paidAccess.id;
  const [unpaidAccess] = await db.insert(deliveryAccessesTable).values({
    galleryId,
    studentId: unpaidStudentId,
    accessCodeHash: hashCode(unpaidAccessCode),
    accessCodeEncrypted: encryptStorageValue(unpaidAccessCode),
    accessCodeLast4: unpaidAccessCode.slice(-4),
  }).returning({ id: deliveryAccessesTable.id });
  unpaidAccessId = unpaidAccess.id;

  readyStudentPhotoId = await insertPhoto(studentId, "ready-student.jpg");
  uploadingPhotoId = await insertPhoto(studentId, "uploading.jpg");
  failedPhotoId = await insertPhoto(studentId, "failed.jpg");
  unpaidPhotoId = await insertPhoto(unpaidStudentId, "unpaid.jpg");
  unsharedPhotoId = await insertPhoto(studentId, "unshared.jpg");
  await db.update(studentPhotosTable).set({ shareWithParents: false })
    .where(eq(studentPhotosTable.id, unsharedPhotoId));

  const [group] = await db.insert(groupsTable).values({
    projectId,
    name: "Materialized group",
  }).returning({ id: groupsTable.id });
  const [groupCapture] = await db.insert(groupCapturesTable).values({
    projectId,
    groupId: group.id,
    captureKey: `group-capture-${suffix}`,
    baseFilename: "group-photo",
    pairingStatus: "complete",
    rating: 1,
  }).returning({ id: groupCapturesTable.id });
  const [groupFile] = await db.insert(groupCaptureFilesTable).values({
    captureId: groupCapture.id,
    fileRole: "JPEG",
    fileFormat: "JPEG",
    originalFilename: "group-photo.jpg",
    fileUrl: "/objects/group-photo.jpg",
    durableObjectPath: "/objects/group-photo.jpg",
    mimeType: "image/jpeg",
  }).returning({ id: groupCaptureFilesTable.id });
  const [groupPhoto] = await db.insert(studentPhotosTable).values({
    projectId,
    studentId,
    fileName: "group-photo.jpg",
    fileUrl: "/objects/group-photo.jpg",
    durableObjectPath: "/objects/group-photo.jpg",
    sourceGroupCaptureFileId: groupFile.id,
    mimeType: "image/jpeg",
    rating: 1,
    shareWithParents: true,
  }).returning({ id: studentPhotosTable.id });
  readyGroupPhotoId = groupPhoto.id;

  await db.insert(photoStorageCopiesTable).values([
    {
      studentPhotoId: readyStudentPhotoId,
      destination: "r2",
      objectKey: "ready/student.jpg",
      state: "ready",
      verifiedAt: new Date(),
    },
    {
      studentPhotoId: uploadingPhotoId,
      destination: "r2",
      objectKey: "uploading/student.jpg",
      state: "uploading",
    },
    {
      studentPhotoId: failedPhotoId,
      destination: "r2",
      objectKey: "failed/student.jpg",
      state: "failed",
    },
    {
      groupCaptureFileId: groupFile.id,
      destination: "r2",
      objectKey: "ready/group.jpg",
      state: "ready",
      verifiedAt: new Date(),
    },
    {
      studentPhotoId: unsharedPhotoId,
      destination: "r2",
      objectKey: "ready/unshared.jpg",
      state: "ready",
      verifiedAt: new Date(),
    },
  ]);
  r2Bodies.set("ready/student.jpg", readyStudentBytes);
  r2Bodies.set("ready/group.jpg", readyGroupBytes);
  r2Bodies.set("ready/unshared.jpg", Buffer.from("must never be read"));
  await insertPaidItems([
    readyStudentPhotoId,
    readyGroupPhotoId,
    uploadingPhotoId,
    failedPhotoId,
    unsharedPhotoId,
  ]);

  const readyAccessResponse = await fetch(`${baseUrl}/api/delivery/${gallerySlug}/access`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: accessCode }),
  });
  assert.equal(readyAccessResponse.status, 200);
  paidAccessToken = (await readyAccessResponse.json() as { token: string }).token;
  const unpaidAccessResponse = await fetch(`${baseUrl}/api/delivery/${gallerySlug}/access`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: unpaidAccessCode }),
  });
  assert.equal(unpaidAccessResponse.status, 200);
  unpaidAccessToken = (await unpaidAccessResponse.json() as { token: string }).token;
});

after(async () => {
  ObjectStorageService.prototype.getObjectEntityFile = originalObjectStorageGet;
  globalThis.fetch = originalFetch;
  if (studioId) await db.delete(studiosTable).where(eq(studiosTable.id, studioId));
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await pool.end();
});

let thisPathBytes = fallbackUploadingBytes;

test("selects a ready student R2 copy and keeps uploading/failed copies on Object Storage", async () => {
  r2RequestedKeys.length = 0;
  objectStorageReads = 0;
  const readyResponse = await requestPhoto(readyStudentPhotoId, paidAccessToken);
  assert.equal(readyResponse.status, 200);
  assert.deepEqual(Buffer.from(await readyResponse.arrayBuffer()), readyStudentBytes);
  assert.deepEqual(r2RequestedKeys, ["ready/student.jpg"]);
  assert.equal(objectStorageReads, 0);

  thisPathBytes = fallbackUploadingBytes;
  const uploadingResponse = await requestPhoto(uploadingPhotoId, paidAccessToken);
  assert.equal(uploadingResponse.status, 200);
  assert.deepEqual(Buffer.from(await uploadingResponse.arrayBuffer()), fallbackUploadingBytes);
  thisPathBytes = fallbackFailedBytes;
  const failedResponse = await requestPhoto(failedPhotoId, paidAccessToken);
  assert.equal(failedResponse.status, 200);
  assert.deepEqual(Buffer.from(await failedResponse.arrayBuffer()), fallbackFailedBytes);
  assert.deepEqual(r2RequestedKeys, ["ready/student.jpg"]);
  assert.equal(objectStorageReads, 2);
});

test("selects a ready group source copy for a materialized group photo", async () => {
  r2RequestedKeys.length = 0;
  objectStorageReads = 0;
  const response = await requestPhoto(readyGroupPhotoId, paidAccessToken);
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), readyGroupBytes);
  assert.deepEqual(r2RequestedKeys, ["ready/group.jpg"]);
  assert.equal(objectStorageReads, 0);
});

test("rejects unauthorized and unpaid requests before either storage backend", async () => {
  r2RequestedKeys.length = 0;
  objectStorageReads = 0;
  const unauthorized = await requestPhoto(readyStudentPhotoId, "");
  assert.equal(unauthorized.status, 401);
  assert.equal(r2RequestedKeys.length, 0);

  const unpaid = await requestPhoto(unpaidPhotoId, unpaidAccessToken);
  assert.equal(unpaid.status, 402);
  assert.equal(r2RequestedKeys.length, 0);
  assert.equal(objectStorageReads, 0);
});

test("does not expose a positively-rated unshared photo through listing, ordering, preview, or download", async () => {
  r2RequestedKeys.length = 0;
  objectStorageReads = 0;
  await db.update(studentPhotosTable).set({ shareWithParents: false })
    .where(eq(studentPhotosTable.id, readyGroupPhotoId));
  const blockedPhotoIds = [unsharedPhotoId, readyGroupPhotoId];

  const galleryResponse = await fetch(`${baseUrl}/api/delivery/${gallerySlug}/gallery`, {
    headers: { "x-delivery-token": paidAccessToken },
  });
  assert.equal(galleryResponse.status, 200);
  const gallery = await galleryResponse.json() as { photos: Array<{ id: number }> };
  assert.equal(gallery.photos.some((photo) => blockedPhotoIds.includes(photo.id)), false);

  const orderResponse = await fetch(`${baseUrl}/api/delivery/${gallerySlug}/orders`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      token: paidAccessToken,
      offerId: "digital-single",
      photoIds: blockedPhotoIds,
      quantity: 1,
      customerName: "Unshared Photo Test",
      paymentMethod: "stripe",
    }),
  });
  assert.equal(orderResponse.status, 400);

  for (const photoId of blockedPhotoIds) {
    const previewResponse = await requestPhoto(photoId, paidAccessToken, "preview=1");
    assert.equal(previewResponse.status, 404);
    const downloadResponse = await requestPhoto(photoId, paidAccessToken);
    assert.equal(downloadResponse.status, 404);
  }
  assert.deepEqual(r2RequestedKeys, []);
  assert.equal(objectStorageReads, 0);
});

test("keeps an authorized R2 read failure private instead of serving stale Object Storage bytes", async () => {
  r2RequestedKeys.length = 0;
  objectStorageReads = 0;
  r2Failures.add("ready/student.jpg");
  thisPathBytes = Buffer.from("stale Object Storage bytes");
  const response = await requestPhoto(readyStudentPhotoId, paidAccessToken);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "Photo file is temporarily unavailable" });
  assert.deepEqual(r2RequestedKeys, ["ready/student.jpg"]);
  assert.equal(objectStorageReads, 0);
  r2Failures.delete("ready/student.jpg");
});