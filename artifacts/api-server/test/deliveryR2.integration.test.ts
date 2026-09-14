import { strict as assert } from "node:assert";
import { createHash, createHmac } from "node:crypto";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { Readable } from "node:stream";
import sharp from "sharp";
import test, { after, before } from "node:test";
import express from "express";
import { and, eq } from "drizzle-orm";
import {
  classesTable,
  captureFilesTable,
  capturesTable,
  db,
  deliveryAccessesTable,
  deliveryGalleriesTable,
  deliveryOrderItemsTable,
  deliveryOrdersTable,
  marketingContactsTable,
  marketingVisitsTable,
  groupCaptureFilesTable,
  groupCapturesTable,
  groupMembersTable,
  groupsTable,
  photoStorageCopiesTable,
  pool,
  projectsTable,
  studentPhotosTable,
  studentsTable,
  studioMembersTable,
  studiosTable,
} from "@workspace/db";
import deliveryRouter from "../src/routes/delivery";
import photosRouter from "../src/routes/photos";
import { ObjectStorageService } from "../src/lib/objectStorage";
import { encryptStorageValue } from "../src/lib/storageCrypto";
import { setTestStripeClientFactory } from "../src/lib/stripeClient";
import { setTestStripeSyncFactory } from "../src/lib/stripeClient";
import { WebhookHandlers } from "../src/lib/webhookHandlers";

process.env.SESSION_SECRET = "delivery-r2-test-secret-that-is-at-least-32-bytes";
process.env.R2_ACCOUNT_ID = "delivery-r2-test-account";
process.env.R2_ACCESS_KEY_ID = "delivery-r2-test-key";
process.env.R2_SECRET_ACCESS_KEY = "delivery-r2-test-secret";
process.env.R2_BUCKET_NAME = "delivery-r2-test-bucket";
process.env.R2_ENDPOINT = "https://delivery-r2-test.invalid";
process.env.PRIVATE_OBJECT_DIR = "/delivery-r2-test";

let readyStudentBytes = Buffer.alloc(0);
let readyGroupBytes = Buffer.alloc(0);
const fallbackUploadingBytes = Buffer.from("replit fallback for uploading copy");
const fallbackFailedBytes = Buffer.from("replit fallback for failed copy");
const accessCode = "READY123";
const unpaidAccessCode = "UNPAID12";
const suffix = `${process.pid}-${Date.now()}`;
const studioAdminUserId = `delivery-r2-admin-${suffix}`;

let server: Server;
let baseUrl: string;
let gallerySlug: string;
let readyStudentPhotoId: number;
let readyGroupPhotoId: number;
let uploadingPhotoId: number;
let failedPhotoId: number;
let unpaidPhotoId: number;
let unsharedPhotoId: number;
let rawPhotoId: number;
let unratedPhotoId: number;
let paidAccessToken: string;
let unpaidAccessToken: string;
const r2RequestedKeys: string[] = [];
const r2Requests: Array<{ method: string; objectKey: string }> = [];
const r2Bodies = new Map<string, Buffer>();
const r2Failures = new Set<string>();
let objectStorageReads = 0;

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  const userId = req.header("x-test-user") ?? studioAdminUserId;
  const authHandler = Object.assign(
    () => ({ tokenType: "session_token", userId, sessionClaims: { userId } }),
    { [Symbol.for("@clerk/express.auth")]: true },
  );
  (req as any).auth = authHandler;
  next();
});
app.use("/api/projects/:projectId/students", photosRouter);
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

async function insertPrintItem(photoId: number): Promise<number> {
  const [order] = await db.insert(deliveryOrdersTable).values({
    galleryId,
    accessId: paidAccessId,
    status: "paid",
    paymentMethod: "stripe",
    customerName: "R2 print test",
    fulfillmentStatus: "paid",
    deliveryMethod: "shipping",
    amountTotal: 2500,
    currency: "usd",
    paidAt: new Date(),
  }).returning({ id: deliveryOrdersTable.id });
  await db.insert(deliveryOrderItemsTable).values({
    orderId: order.id,
    photoId,
    offerId: "print-single",
    productName: "Print",
    productType: "print",
    includesDigitalDownloads: false,
    quantity: 1,
    unitAmount: 2500,
    currency: "usd",
  });
  return order.id;
}

let studioId: number;
let projectId: number;
let galleryId: number;
let paidAccessId: number;
let unpaidAccessId: number;
let studentId: number;
let unpaidStudentId: number;
let readyCaptureId: number;
let readyCaptureFileId: number;
let printOrderId: number;
let recoveryOrderId: number;
let stripeMode: "success" | "timeout" | "server_error" | "incomplete" | "accept_then_timeout" = "success";
let stripeCreateCalls = 0;
let stripeRetrieveCalls = 0;
const stripeSessions = new Map<string, { id: string; url: string }>();
const stripeCreateParams: Array<{ success_url?: string; cancel_url?: string }> = [];
let acceptedStripeSession: { id: string; url: string } | null = null;
let resendServer: Server;
let resendBaseUrl: string;
let resendMode: "success" | "rejected" | "unknown" | "incomplete" = "success";
const resendRequests: Array<{ idempotencyKey: string; body: string }> = [];
let resendSawCommittedOrder = false;

const originalFetch = globalThis.fetch;
const originalObjectStorageGet = ObjectStorageService.prototype.getObjectEntityFile;

before(async () => {
  setTestStripeClientFactory(async () => ({
    prices: {
      list: async () => ({ data: [] }),
    },
    checkout: {
      sessions: {
        create: async (params: { success_url?: string; cancel_url?: string }, options: { idempotencyKey?: string }) => {
          stripeCreateCalls += 1;
          stripeCreateParams.push(params);
          const idempotencyKey = options.idempotencyKey ?? "missing";
          const session = { id: `cs_test_${stripeCreateCalls}`, url: `https://checkout.test/${stripeCreateCalls}` };
          stripeSessions.set(idempotencyKey, session);
          if (stripeMode === "accept_then_timeout") {
            acceptedStripeSession = session;
            throw new Error("Stripe test timeout after provider accepted the request");
          }
          if (stripeMode === "incomplete") {
            return {} as any;
          }
          if (stripeMode !== "success") {
            throw new Error(`Stripe test ${stripeMode} after provider accepted the request`);
          }
          return session;
        },
        retrieve: async (id: string) => {
          stripeRetrieveCalls += 1;
          return [...stripeSessions.values()].find((session) => session.id === id) ?? null;
        },
      },
    },
  } as any));
  setTestStripeSyncFactory(async () => ({
    processWebhook: async (payload: Buffer, signature: string) => {
      if (signature !== "signed-test") throw new Error("invalid test signature");
      const sessionId = (JSON.parse(payload.toString("utf8")) as {
        data?: { object?: { id?: string | null } };
      }).data?.object?.id;
      if (acceptedStripeSession && sessionId && sessionId !== acceptedStripeSession.id) {
        throw new Error("test Stripe signature does not authenticate this session");
      }
    },
  }));
  readyStudentBytes = await sharp({
    create: { width: 1800, height: 2400, channels: 3, background: "#496f8a" },
  }).jpeg({ quality: 94 }).toBuffer();
  readyGroupBytes = await sharp({
    create: { width: 1600, height: 1200, channels: 3, background: "#7f5b45" },
  }).jpeg({ quality: 94 }).toBuffer();
  server = createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  baseUrl = `http://127.0.0.1:${address.port}`;
  resendServer = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", async () => {
      const body = Buffer.concat(chunks).toString("utf8");
      resendRequests.push({
        idempotencyKey: request.headers["idempotency-key"]?.toString() ?? "",
        body,
      });
      try {
        const messages = JSON.parse(body) as Array<{ text?: string; html?: string }>;
        const firstMessage = messages[0];
        const reference = firstMessage?.text?.match(/order (order_[A-Za-z0-9_-]+)/)?.[1];
        if (reference) {
          const [committed] = await db.select({ id: deliveryOrdersTable.id })
            .from(deliveryOrdersTable)
            .where(eq(deliveryOrdersTable.publicReference, reference));
          resendSawCommittedOrder = Boolean(committed);
        }
      } catch {
        // The production sender will classify malformed provider responses as unknown.
      }
      if (resendMode === "rejected") {
        response.statusCode = 422;
        response.end("rejected");
      } else if (resendMode === "unknown") {
        response.statusCode = 503;
        response.end("provider unavailable");
      } else if (resendMode === "incomplete") {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ data: [] }));
      } else {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ data: [{ id: `email_${resendRequests.length}` }] }));
      }
    });
  });
  resendServer.listen(0, "127.0.0.1");
  await once(resendServer, "listening");
  const resendAddress = resendServer.address();
  assert(resendAddress && typeof resendAddress !== "string");
  resendBaseUrl = `http://127.0.0.1:${resendAddress.port}`;
  process.env.RESEND_API_BASE_URL = resendBaseUrl;
  process.env.RESEND_API_KEY = "delivery-test-key";
  process.env.RESEND_FROM_EMAIL = "Studio Orders <orders@delivery.test>";
  process.env.PUBLIC_APP_URL = baseUrl;

  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (!url.startsWith(process.env.R2_ENDPOINT!)) {
      return originalFetch(input, init);
    }
    const pathname = new URL(url).pathname.split("/").slice(2).join("/");
    const objectKey = decodeURIComponent(pathname);
    const method = String(init?.method ?? "GET").toUpperCase();
    r2RequestedKeys.push(objectKey);
    r2Requests.push({ method, objectKey });
    if (r2Failures.has(objectKey)) {
      return new Response("R2 test read failure", { status: 503 });
    }
    if (method === "PUT") {
      const bytes = Buffer.from(init?.body as Buffer);
      r2Bodies.set(objectKey, bytes);
      return new Response(null, { headers: { etag: `"${createHash("md5").update(bytes).digest("hex")}"` } });
    }
    const body = r2Bodies.get(objectKey);
    const headers = body ? {
      "content-type": "image/jpeg",
      "content-length": String(body.length),
      "x-amz-meta-sha256": createHash("sha256").update(body).digest("hex"),
    } : undefined;
    return body
      ? new Response(method === "HEAD" ? null : body, { headers })
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
  await db.insert(studioMembersTable).values({
    studioId,
    userId: studioAdminUserId,
    email: `${studioAdminUserId}@member.local`,
    role: "admin",
  });
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
  await db.update(deliveryGalleriesTable).set({
    priceSheetJson: JSON.stringify({
      offers: [{
        id: "digital-single",
        name: "Digital photo",
        productType: "digital",
        photoCount: 1,
        unitAmount: 100,
        currency: "usd",
        paymentMethods: ["establishment", "stripe"],
        deliveryMethods: ["digital"],
        active: true,
        includesDigitalDownloads: true,
      }],
    }),
  }).where(eq(deliveryGalleriesTable.id, galleryId));
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
  const [readyCapture] = await db.insert(capturesTable).values({
    captureKey: `ready-student-${suffix}`,
    projectId,
    studentId,
    baseFilename: "ready-student",
    pairingStatus: "jpeg_only",
    rating: 1,
  }).returning({ id: capturesTable.id });
  readyCaptureId = readyCapture.id;
  const [readyCaptureFile] = await db.insert(captureFilesTable).values({
    captureId: readyCapture.id,
    fileRole: "JPEG",
    fileFormat: "JPG",
    originalFilename: "ready-student.jpg",
    fileUrl: "/objects/ready-student.jpg",
    durableObjectPath: "/objects/ready-student.jpg",
    mimeType: "image/jpeg",
    fileSize: readyStudentBytes.length,
  }).returning({ id: captureFilesTable.id });
  readyCaptureFileId = readyCaptureFile.id;
  uploadingPhotoId = await insertPhoto(studentId, "uploading.jpg");
  failedPhotoId = await insertPhoto(studentId, "failed.jpg");
  unpaidPhotoId = await insertPhoto(unpaidStudentId, "unpaid.jpg");
  unsharedPhotoId = await insertPhoto(studentId, "unshared.jpg");
  rawPhotoId = await insertPhoto(studentId, "selected.raw");
  await db.update(studentPhotosTable).set({ mimeType: "image/x-canon-cr2" })
    .where(eq(studentPhotosTable.id, rawPhotoId));
  unratedPhotoId = await insertPhoto(studentId, "unrated.jpg");
  await db.update(studentPhotosTable).set({ rating: 0 })
    .where(eq(studentPhotosTable.id, unratedPhotoId));
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
  await db.insert(groupMembersTable).values({ groupId: group.id, studentId });
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
      captureFileId: readyCaptureFileId,
      destination: "r2",
      objectKey: "ready/student.jpg",
      state: "ready",
      fileSize: readyStudentBytes.length,
      sha256: createHash("sha256").update(readyStudentBytes).digest("hex"),
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
      fileSize: readyGroupBytes.length,
      sha256: createHash("sha256").update(readyGroupBytes).digest("hex"),
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
  printOrderId = await insertPrintItem(readyStudentPhotoId);

  const readyAccessResponse = await fetch(`${baseUrl}/api/delivery/${gallerySlug}/access`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: accessCode, email: `ready-${suffix}@example.com` }),
  });
  assert.equal(readyAccessResponse.status, 200);
  paidAccessToken = (await readyAccessResponse.json() as { token: string }).token;
  const unpaidAccessResponse = await fetch(`${baseUrl}/api/delivery/${gallerySlug}/access`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: unpaidAccessCode, email: `unpaid-${suffix}@example.com` }),
  });
  assert.equal(unpaidAccessResponse.status, 200);
  unpaidAccessToken = (await unpaidAccessResponse.json() as { token: string }).token;
  const [readyContact] = await db.select().from(marketingContactsTable)
    .where(eq(marketingContactsTable.email, `ready-${suffix}@example.com`));
  assert(readyContact, "successful access should create a normalized studio contact");
  assert.equal(readyContact.successfulGalleryAccesses, 1);
  const readyVisits = await db.select().from(marketingVisitsTable)
    .where(eq(marketingVisitsTable.contactId, readyContact.id));
  assert.equal(readyVisits.length, 1, "successful access should append one visit event");
  const wrongCodeResponse = await fetch(`${baseUrl}/api/delivery/${gallerySlug}/access`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: "WRONG123", email: `wrong-${suffix}@example.com` }),
  });
  assert.equal(wrongCodeResponse.status, 401);
  const [wrongContact] = await db.select().from(marketingContactsTable)
    .where(eq(marketingContactsTable.email, `wrong-${suffix}@example.com`));
  assert.equal(wrongContact, undefined, "wrong codes must not create contacts");
});

after(async () => {
  setTestStripeClientFactory(null);
  setTestStripeSyncFactory(null);
  ObjectStorageService.prototype.getObjectEntityFile = originalObjectStorageGet;
  globalThis.fetch = originalFetch;
  await new Promise<void>((resolve, reject) => resendServer.close((error) => error ? reject(error) : resolve()));
  delete process.env.RESEND_API_BASE_URL;
  delete process.env.RESEND_API_KEY;
  delete process.env.RESEND_FROM_EMAIL;
  delete process.env.PUBLIC_APP_URL;
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
  const readyBytes = Buffer.from(await readyResponse.arrayBuffer());
  assert(readyBytes.length > 0, `empty ready body; r2=${JSON.stringify(r2RequestedKeys)}`);
  assert(r2RequestedKeys.includes("ready/student.jpg"));
  assert(r2RequestedKeys.some((key) => key.includes("__download__")));
  assert.equal(objectStorageReads, 0);

  thisPathBytes = fallbackUploadingBytes;
  const uploadingResponse = await requestPhoto(uploadingPhotoId, paidAccessToken);
  assert.equal(uploadingResponse.status, 200);
  assert.deepEqual(Buffer.from(await uploadingResponse.arrayBuffer()), fallbackUploadingBytes);
  thisPathBytes = fallbackFailedBytes;
  const failedResponse = await requestPhoto(failedPhotoId, paidAccessToken);
  assert.equal(failedResponse.status, 200);
  assert.deepEqual(Buffer.from(await failedResponse.arrayBuffer()), fallbackFailedBytes);
  assert(r2RequestedKeys.includes("ready/student.jpg"));
  assert(r2RequestedKeys.some((key) => key.includes("__download__")));
  assert.equal(objectStorageReads, 2);
});

test("streams the authorized studio original bytes while keeping previews derivative-only", async () => {
  r2RequestedKeys.length = 0;
  const originalResponse = await fetch(
    `${baseUrl}/api/projects/${projectId}/students/${studentId}/photos/${readyStudentPhotoId}/file?download=original`,
    { headers: { "x-test-user": studioAdminUserId } },
  );
  assert.equal(originalResponse.status, 200);
  assert.match(originalResponse.headers.get("content-disposition") ?? "", /^attachment;/);
  assert.deepEqual(Buffer.from(await originalResponse.arrayBuffer()), readyStudentBytes);
  assert.deepEqual(r2RequestedKeys, ["ready/student.jpg"]);

  r2RequestedKeys.length = 0;
  const thumbnailResponse = await fetch(
    `${baseUrl}/api/projects/${projectId}/students/${studentId}/photos/${readyStudentPhotoId}/file?size=thumbnail`,
    { headers: { "x-test-user": studioAdminUserId } },
  );
  assert.equal(thumbnailResponse.status, 200);
  const thumbnailBytes = Buffer.from(await thumbnailResponse.arrayBuffer());
  assert.notDeepEqual(thumbnailBytes, readyStudentBytes);
  const metadata = await sharp(thumbnailBytes).metadata();
  assert.equal(metadata.width, 480);
  assert(r2RequestedKeys.some((key) => key.includes("/.variants/") && key.includes("__thumbnail__")));
});

test("rejects unauthorized studio original downloads before reading R2", async () => {
  r2RequestedKeys.length = 0;
  const response = await fetch(
    `${baseUrl}/api/projects/${projectId}/students/${studentId}/photos/${readyStudentPhotoId}/file?download=original`,
    { headers: { "x-test-user": `delivery-r2-outsider-${suffix}` } },
  );
  assert.equal(response.status, 404);
  assert.equal(r2RequestedKeys.length, 0);
});

test("paid print fulfillment exposes and consumes the edited print variant", async () => {
  await db.update(capturesTable).set({
    cropPositionX: 0.75,
    cropPositionY: 0.25,
    cropScale: 2,
    aspectRatio: "1:1",
  }).where(eq(capturesTable.id, readyCaptureId));

  const orderResponse = await fetch(`${baseUrl}/api/delivery/${gallerySlug}/orders/${printOrderId}`, {
    headers: { "x-delivery-token": paidAccessToken },
  });
  assert.equal(orderResponse.status, 200);
  const order = await orderResponse.json() as {
    items: Array<{ productType: string; printUrl?: string }>;
  };
  const printUrl = order.items.find((item) => item.productType === "print")?.printUrl;
  assert(printUrl);

  r2Requests.length = 0;
  const printResponse = await fetch(`${baseUrl}${printUrl}`);
  assert.equal(printResponse.status, 200);
  assert.equal(printResponse.headers.get("content-type"), "image/jpeg");
  const printBytes = Buffer.from(await printResponse.arrayBuffer());
  const printMetadata = await sharp(printBytes).metadata();
  assert.equal(printMetadata.width, 900);
  assert.equal(printMetadata.height, 900);
  assert.deepEqual(r2Bodies.get("ready/student.jpg"), readyStudentBytes);
  assert(r2Requests.some((request) => request.method === "PUT" && request.objectKey.includes("/.variants/") && request.objectKey.includes("__print__")));
  await db.update(capturesTable).set({
    cropPositionX: null,
    cropPositionY: null,
    cropScale: null,
    aspectRatio: null,
  }).where(eq(capturesTable.id, readyCaptureId));
});

test("creates one persistent watermarked thumbnail and reuses it for later gallery views", async () => {
  r2Requests.length = 0;
  const galleryResponse = await fetch(`${baseUrl}/api/delivery/${gallerySlug}/gallery`, {
    headers: { "x-delivery-token": paidAccessToken },
  });
  assert.equal(galleryResponse.status, 200);
  const gallery = await galleryResponse.json() as {
    photos: Array<{ id: number; fileUrl: string }>;
    mediaExpiresAt: string;
  };
  assert(Number.isFinite(Date.parse(gallery.mediaExpiresAt)));
  const listed = gallery.photos.find((photo) => photo.id === readyStudentPhotoId);
  assert(listed);
  assert.equal(gallery.photos.some((photo) => photo.id === rawPhotoId), false);
  assert.equal(gallery.photos.some((photo) => photo.id === unratedPhotoId), false);
  assert.match(listed.fileUrl, /preview=1&size=thumbnail/);
  const mediaToken = new URL(`http://delivery.test${listed.fileUrl}`).searchParams.get("mediaToken");
  assert(mediaToken);
  const [encodedMediaPayload] = mediaToken.split(".");
  const expiredPayload = JSON.parse(Buffer.from(encodedMediaPayload, "base64url").toString("utf8")) as Record<string, unknown>;
  expiredPayload.expiresAt = Math.floor(Date.now() / 1000) - 1;
  const expiredEncoded = Buffer.from(JSON.stringify(expiredPayload)).toString("base64url");
  const expiredMediaToken = `${expiredEncoded}.${createHmac("sha256", process.env.SESSION_SECRET!)
    .update(expiredEncoded).digest("base64url")}`;
  const expiredMedia = await fetch(
    `${baseUrl}/api/delivery/${gallerySlug}/photos/${readyStudentPhotoId}/file?download=1&mediaToken=${encodeURIComponent(expiredMediaToken)}`,
  );
  assert.equal(expiredMedia.status, 401);

  const first = await fetch(`${baseUrl}${listed.fileUrl}`);
  assert.equal(first.status, 200);
  assert.equal(
    first.headers.get("cache-control"),
    "public, max-age=900, s-maxage=900, immutable",
  );
  const firstBytes = Buffer.from(await first.arrayBuffer());
  assert(firstBytes.length > 0);
  assert(firstBytes.length < readyStudentBytes.length);
  const variantPut = r2Requests.find((request) =>
    request.method === "PUT" && request.objectKey.includes("/.variants/")
  );
  assert(variantPut, "the first gallery view should persist a derivative in R2");
  assert.match(variantPut.objectKey, /thumbnail-watermarked/);

  const putCount = r2Requests.filter((request) => request.method === "PUT").length;
  const second = await fetch(`${baseUrl}${listed.fileUrl}`);
  assert.equal(second.status, 200);
  assert.deepEqual(Buffer.from(await second.arrayBuffer()), firstBytes);
  assert.equal(
    r2Requests.filter((request) => request.method === "PUT").length,
    putCount,
    "a stored derivative must be reused instead of regenerated",
  );
});

test("recovers a manual order through the header secret without exposing download data", async () => {
  const recoverySecret = `recovery-secret-${suffix}-with-enough-entropy`;
  const publicReference = `ord_recovery_${suffix}`;
  const recoveryHash = createHash("sha256").update(recoverySecret).digest("hex");
  const [order] = await db.insert(deliveryOrdersTable).values({
    galleryId,
    accessId: unpaidAccessId,
    status: "pending",
    paymentMethod: "establishment",
    customerName: "Manual Recovery Customer",
    customerEmail: `manual-recovery-${suffix}@example.com`,
    fulfillmentStatus: "not_required",
    deliveryMethod: "school",
    amountTotal: 1900,
    currency: "usd",
    publicReference,
    recoveryTokenHash: recoveryHash,
    recoveryExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
    recoveryRevokedAt: null,
    idempotencyKey: `manual-recovery-${suffix}`,
    requestFingerprint: "test-fingerprint",
    checkoutAttemptStatus: "not_started",
    notificationStatus: "sent",
  }).returning({ id: deliveryOrdersTable.id });
  recoveryOrderId = order.id;
  await db.insert(deliveryOrderItemsTable).values({
    orderId: order.id,
    photoId: unpaidPhotoId,
    offerId: "digital-single",
    productName: "Digital photo",
    productType: "digital",
    includesDigitalDownloads: true,
    quantity: 1,
    unitAmount: 1900,
    currency: "usd",
  });

  const recovered = await fetch(
    `${baseUrl}/api/delivery/${gallerySlug}/orders/recovery/${publicReference}`,
    { headers: { "x-order-recovery-token": recoverySecret } },
  );
  assert.equal(recovered.status, 200);
  const body = await recovered.json() as Record<string, unknown>;
  assert.deepEqual(Object.keys(body).sort(), [
    "amountTotal", "createdAt", "currency", "deliveryMethod", "fulfillmentStatus",
    "items", "manualInstructions", "paidAt", "paymentMethod", "reference", "status",
  ].sort());
  assert.equal(body.status, "pending");
  assert.equal(body.paymentMethod, "establishment");
  assert.equal("downloadablePhotoIds" in body, false);
  assert.equal("accessCode" in body, false);
  assert.equal("mediaUrl" in body, false);
  assert.equal("orderId" in body, false);

  const queryToken = await fetch(
    `${baseUrl}/api/delivery/${gallerySlug}/orders/recovery/${publicReference}?recoveryToken=${encodeURIComponent(recoverySecret)}`,
  );
  assert.equal(queryToken.status, 404, "recovery credentials must be supplied in the header");

  const stored = await db.select({
    recoveryTokenHash: deliveryOrdersTable.recoveryTokenHash,
  }).from(deliveryOrdersTable).where(eq(deliveryOrdersTable.id, recoveryOrderId));
  assert.equal(stored[0]?.recoveryTokenHash, recoveryHash);
  assert.notEqual(stored[0]?.recoveryTokenHash, recoverySecret);
  const wrongToken = await fetch(
    `${baseUrl}/api/delivery/${gallerySlug}/orders/recovery/${publicReference}`,
    { headers: { "x-order-recovery-token": `${recoverySecret}-wrong` } },
  );
  assert.equal(wrongToken.status, 404);
  const wrongReference = await fetch(
    `${baseUrl}/api/delivery/${gallerySlug}/orders/recovery/not-this-order`,
    { headers: { "x-order-recovery-token": recoverySecret } },
  );
  assert.equal(wrongReference.status, 404);

  await db.update(deliveryOrdersTable).set({
    status: "paid",
    fulfillmentStatus: "ready",
    paidAt: new Date(),
  }).where(eq(deliveryOrdersTable.id, recoveryOrderId));
  const paid = await fetch(
    `${baseUrl}/api/delivery/${gallerySlug}/orders/recovery/${publicReference}`,
    { headers: { "x-order-recovery-token": recoverySecret } },
  );
  assert.equal(paid.status, 200);
  const paidBody = await paid.json() as { status: string; fulfillmentStatus: string };
  assert.equal(paidBody.status, "paid");
  assert.equal(paidBody.fulfillmentStatus, "ready");

  await db.update(deliveryOrdersTable).set({
    recoveryExpiresAt: new Date(Date.now() - 1_000),
  }).where(eq(deliveryOrdersTable.id, recoveryOrderId));
  const expired = await fetch(
    `${baseUrl}/api/delivery/${gallerySlug}/orders/recovery/${publicReference}`,
    { headers: { "x-order-recovery-token": recoverySecret } },
  );
  assert.equal(expired.status, 404);

  await db.update(deliveryOrdersTable).set({
    recoveryExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
    recoveryRevokedAt: new Date(),
  }).where(eq(deliveryOrdersTable.id, recoveryOrderId));
  const revoked = await fetch(
    `${baseUrl}/api/delivery/${gallerySlug}/orders/recovery/${publicReference}`,
    { headers: { "x-order-recovery-token": recoverySecret } },
  );
  assert.equal(revoked.status, 404);
  await db.update(deliveryOrdersTable).set({
    status: "refunded",
  }).where(eq(deliveryOrdersTable.id, recoveryOrderId));
});

test("manual checkout replays idempotently and rejects changed payloads", async () => {
  resendMode = "success";
  resendSawCommittedOrder = false;
  const emailCountBefore = resendRequests.length;
  const idempotencyKey = `manual-idempotency-${suffix}`;
  const payload = {
    token: unpaidAccessToken,
    idempotencyKey,
    offerId: "digital-single",
    photoIds: [unpaidPhotoId],
    quantity: 1,
    customerName: "Manual Checkout",
    customerEmail: `manual-checkout-${suffix}@example.com`,
    paymentMethod: "establishment",
    deliveryMethod: "digital",
  };
  const first = await fetch(`${baseUrl}/api/delivery/${gallerySlug}/orders`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  assert.equal(first.status, 200);
  const firstBody = await first.json() as { orderId: number; recoveryToken?: string | null; recoveryUrl?: string | null };
  assert.equal(typeof firstBody.recoveryToken, "string");
  assert.match(firstBody.recoveryUrl ?? "", /#recoveryToken=/);
  assert.doesNotMatch(firstBody.recoveryUrl ?? "", /[?&]recoveryToken=/);
  assert.equal(resendRequests.length, emailCountBefore + 1);
  const notification = resendRequests.at(-1);
  assert(notification);
  assert.equal(notification.idempotencyKey, `volume-capture-order-${firstBody.orderId}-v1`);
  assert.match(notification.body, /Digital photo/);
  assert.match(notification.body, /#recoveryToken=/);
  assert.doesNotMatch(notification.body, /[?&]recoveryToken=/);
  assert.doesNotMatch(notification.body, /accessCode|tokenHash|mediaUrl/i);
  assert.equal(resendSawCommittedOrder, true, "provider request must happen after order commit");
  const unsubscribeAt = new Date();
  await db.update(marketingContactsTable).set({
    marketingConsent: false,
    unsubscribedAt: unsubscribeAt,
  }).where(eq(marketingContactsTable.email, payload.customerEmail));
  const replay = await fetch(`${baseUrl}/api/delivery/${gallerySlug}/orders`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  assert.equal(replay.status, 200);
  const replayBody = await replay.json() as { orderId: number; recoveryToken?: string | null };
  assert.equal(replayBody.orderId, firstBody.orderId);
  assert.equal(replayBody.recoveryToken, undefined);
  assert.equal(resendRequests.length, emailCountBefore + 1);
  const notifiedOrder = await db.select({
    notificationStatus: deliveryOrdersTable.notificationStatus,
    notificationProviderId: deliveryOrdersTable.notificationProviderId,
  }).from(deliveryOrdersTable).where(eq(deliveryOrdersTable.id, firstBody.orderId));
  assert.equal(notifiedOrder[0]?.notificationStatus, "sent");
  assert.equal(notifiedOrder[0]?.notificationProviderId, `email_${emailCountBefore + 1}`);
  const [unchangedMarketingContact] = await db.select({
    marketingConsent: marketingContactsTable.marketingConsent,
    unsubscribedAt: marketingContactsTable.unsubscribedAt,
  }).from(marketingContactsTable).where(eq(marketingContactsTable.email, payload.customerEmail));
  assert.equal(unchangedMarketingContact?.marketingConsent, false);
  assert.equal(unchangedMarketingContact?.unsubscribedAt?.getTime(), unsubscribeAt.getTime());

  const changed = await fetch(`${baseUrl}/api/delivery/${gallerySlug}/orders`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...payload, customerName: "Changed Payload" }),
  });
  assert.equal(changed.status, 409);

  const distinct = await fetch(`${baseUrl}/api/delivery/${gallerySlug}/orders`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...payload, idempotencyKey: `${idempotencyKey}-new` }),
  });
  assert.equal(distinct.status, 200);
  const distinctBody = await distinct.json() as { orderId: number };
  assert.notEqual(distinctBody.orderId, firstBody.orderId);
  const sameKeyOrders = await db.select({ id: deliveryOrdersTable.id })
    .from(deliveryOrdersTable)
    .where(and(
      eq(deliveryOrdersTable.galleryId, galleryId),
      eq(deliveryOrdersTable.accessId, unpaidAccessId),
      eq(deliveryOrdersTable.idempotencyKey, idempotencyKey),
    ));
  assert.equal(sameKeyOrders.length, 1);
  const [orderContact] = await db.select({
    marketingConsent: marketingContactsTable.marketingConsent,
  }).from(marketingContactsTable).where(eq(
    marketingContactsTable.email,
    payload.customerEmail,
  ));
  assert.equal(orderContact?.marketingConsent, false, "checkout replay must preserve marketing consent state");
});

test("Stripe checkout stores its stable provider idempotency key and does not recreate on replay", async () => {
  stripeMode = "success";
  const idempotencyKey = `stripe-success-${suffix}`;
  const payload = {
    token: unpaidAccessToken,
    idempotencyKey,
    offerId: "digital-single",
    photoIds: [unpaidPhotoId],
    quantity: 1,
    customerName: "Stripe Checkout",
    customerEmail: `stripe-checkout-${suffix}@example.com`,
    paymentMethod: "stripe",
    deliveryMethod: "digital",
  };
  const first = await fetch(`${baseUrl}/api/delivery/${gallerySlug}/orders`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  assert.equal(first.status, 200);
  const firstBody = await first.json() as { orderId: number; checkoutUrl: string; checkoutAttemptStatus: string };
  assert.equal(firstBody.checkoutAttemptStatus, "created");
  assert.match(firstBody.checkoutUrl, /^https:\/\/checkout\.test\//);
  assert.equal(stripeCreateCalls, 1);
  const providerKey = `delivery-order-${firstBody.orderId}-${idempotencyKey}`;
  assert.equal(stripeSessions.has(providerKey), true);
  const order = await db.select({
    stripeCheckoutSessionId: deliveryOrdersTable.stripeCheckoutSessionId,
    checkoutAttemptStatus: deliveryOrdersTable.checkoutAttemptStatus,
  }).from(deliveryOrdersTable).where(eq(deliveryOrdersTable.id, firstBody.orderId));
  assert.equal(order[0]?.stripeCheckoutSessionId, "cs_test_1");
  assert.equal(order[0]?.checkoutAttemptStatus, "created");

  const replay = await fetch(`${baseUrl}/api/delivery/${gallerySlug}/orders`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  assert.equal(replay.status, 200);
  const replayBody = await replay.json() as { orderId: number; checkoutUrl: string };
  assert.equal(replayBody.orderId, firstBody.orderId);
  assert.equal(replayBody.checkoutUrl, firstBody.checkoutUrl);
  assert.equal(stripeCreateCalls, 1);
  assert.equal(stripeRetrieveCalls, 1);
});

test("Stripe callbacks and recovery use canonical PUBLIC_APP_URL despite hostile request headers", async () => {
  const previousPublicAppUrl = process.env.PUBLIC_APP_URL;
  const canonicalUrl = "https://public.example/volume-capture";
  process.env.PUBLIC_APP_URL = `${canonicalUrl}/`;
  stripeMode = "success";
  try {
    const headerCases = [
      { host: "hostile.example" },
      { "x-forwarded-host": "forwarded-hostile.example" },
      { "x-forwarded-proto": "http" },
      {
        host: "combined-hostile.example",
        "x-forwarded-host": "combined-forwarded.example",
        "x-forwarded-proto": "http",
      },
    ];
    for (const [index, hostileHeaders] of headerCases.entries()) {
      const createCountBefore = stripeCreateCalls;
      const response = await fetch(`${baseUrl}/api/delivery/${gallerySlug}/orders`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...hostileHeaders,
        },
        body: JSON.stringify({
          token: unpaidAccessToken,
          idempotencyKey: `canonical-url-${suffix}-${index}`,
          offerId: "digital-single",
          photoIds: [unpaidPhotoId],
          quantity: 1,
          customerName: "Canonical URL",
          customerEmail: `canonical-url-${index}-${suffix}@example.com`,
          paymentMethod: "stripe",
          deliveryMethod: "digital",
        }),
      });
      assert.equal(response.status, 200);
      assert.equal(stripeCreateCalls, createCountBefore + 1);
      const body = await response.json() as { orderId: number; recoveryUrl: string };
      const params = stripeCreateParams.at(-1);
      assert.equal(
        params?.success_url,
        `${canonicalUrl}/delivery/${gallerySlug}?paid=1&order=${body.orderId}`,
      );
      assert.equal(
        params?.cancel_url,
        `${canonicalUrl}/delivery/${gallerySlug}?cancelled=1&order=${body.orderId}`,
      );
      assert.equal(body.recoveryUrl.startsWith(`${canonicalUrl}/delivery/${gallerySlug}?orderRef=`), true);
      assert.equal((params?.success_url?.match(/\/volume-capture\//g) ?? []).length, 1);
      assert.equal((params?.cancel_url?.match(/\/volume-capture\//g) ?? []).length, 1);
      assert.equal((body.recoveryUrl.match(/\/volume-capture\//g) ?? []).length, 1);
      for (const [header, hostileValue] of Object.entries(hostileHeaders)) {
        if (header === "x-forwarded-proto") {
          assert.equal(new URL(params?.success_url ?? "").protocol, "https:");
          assert.equal(new URL(params?.cancel_url ?? "").protocol, "https:");
          assert.equal(new URL(body.recoveryUrl).protocol, "https:");
          continue;
        }
        assert.equal(params?.success_url?.includes(hostileValue), false);
        assert.equal(params?.cancel_url?.includes(hostileValue), false);
        assert.equal(body.recoveryUrl.includes(hostileValue), false);
      }
    }
  } finally {
    if (previousPublicAppUrl === undefined) delete process.env.PUBLIC_APP_URL;
    else process.env.PUBLIC_APP_URL = previousPublicAppUrl;
  }
});

test("malformed canonical URL fails before Stripe Checkout creation", async () => {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousPublicAppUrl = process.env.PUBLIC_APP_URL;
  const createCountBefore = stripeCreateCalls;
  try {
    process.env.NODE_ENV = "production";
    process.env.PUBLIC_APP_URL = "https://[";
    const response = await fetch(`${baseUrl}/api/delivery/${gallerySlug}/orders`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: unpaidAccessToken,
        idempotencyKey: `invalid-canonical-url-${suffix}`,
        offerId: "digital-single",
        photoIds: [unpaidPhotoId],
        quantity: 1,
        customerName: "Invalid URL",
        customerEmail: `invalid-url-${suffix}@example.com`,
        paymentMethod: "stripe",
        deliveryMethod: "digital",
      }),
    });
    assert.equal(response.status, 503);
    assert.equal(stripeCreateCalls, createCountBefore);
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previousPublicAppUrl === undefined) delete process.env.PUBLIC_APP_URL;
    else process.env.PUBLIC_APP_URL = previousPublicAppUrl;
  }
});

test("order notification rejection and unknown provider outcomes are durable and not retried", async () => {
  const createOrder = async (key: string, email: string) => {
    const response = await fetch(`${baseUrl}/api/delivery/${gallerySlug}/orders`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: unpaidAccessToken,
        idempotencyKey: key,
        offerId: "digital-single",
        photoIds: [unpaidPhotoId],
        quantity: 1,
        customerName: "Notification Outcome",
        customerEmail: email,
        paymentMethod: "establishment",
        deliveryMethod: "digital",
      }),
    });
    assert.equal(response.status, 200);
    return response.json() as Promise<{ orderId: number }>;
  };

  resendMode = "rejected";
  const rejected = await createOrder(`email-rejected-${suffix}`, `email-rejected-${suffix}@example.com`);
  const rejectedRow = await db.select({
    notificationStatus: deliveryOrdersTable.notificationStatus,
    notificationError: deliveryOrdersTable.notificationError,
  }).from(deliveryOrdersTable).where(eq(deliveryOrdersTable.id, rejected.orderId));
  assert.equal(rejectedRow[0]?.notificationStatus, "failed");
  assert.match(rejectedRow[0]?.notificationError ?? "", /rejected/i);

  resendMode = "unknown";
  const unknown = await createOrder(`email-unknown-${suffix}`, `email-unknown-${suffix}@example.com`);
  const unknownRow = await db.select({
    notificationStatus: deliveryOrdersTable.notificationStatus,
  }).from(deliveryOrdersTable).where(eq(deliveryOrdersTable.id, unknown.orderId));
  assert.equal(unknownRow[0]?.notificationStatus, "uncertain");

  resendMode = "incomplete";
  const incomplete = await createOrder(`email-incomplete-${suffix}`, `email-incomplete-${suffix}@example.com`);
  const incompleteRow = await db.select({
    notificationStatus: deliveryOrdersTable.notificationStatus,
  }).from(deliveryOrdersTable).where(eq(deliveryOrdersTable.id, incomplete.orderId));
  assert.equal(incompleteRow[0]?.notificationStatus, "uncertain");
  const emailCount = resendRequests.length;
  const replay = await fetch(`${baseUrl}/api/delivery/${gallerySlug}/orders`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      token: unpaidAccessToken,
      idempotencyKey: `email-incomplete-${suffix}`,
      offerId: "digital-single",
      photoIds: [unpaidPhotoId],
      quantity: 1,
      customerName: "Notification Outcome",
      customerEmail: `email-incomplete-${suffix}@example.com`,
      paymentMethod: "establishment",
      deliveryMethod: "digital",
    }),
  });
  assert.equal(replay.status, 200);
  assert.equal(resendRequests.length, emailCount, "uncertain notification must not auto-retry");
});

test("accepted Stripe session can bind an uncertain order exactly once through authenticated webhook", async () => {
  stripeMode = "accept_then_timeout";
  acceptedStripeSession = null;
  const payload = {
    token: paidAccessToken,
    idempotencyKey: `stripe-accepted-timeout-${suffix}`,
    offerId: "digital-single",
    photoIds: [readyStudentPhotoId],
    quantity: 1,
    customerName: "Accepted Stripe",
    customerEmail: `accepted-stripe-${suffix}@example.com`,
    paymentMethod: "stripe",
    deliveryMethod: "digital",
  };
  const response = await fetch(`${baseUrl}/api/delivery/${gallerySlug}/orders`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  assert.equal(response.status, 202);
  const created = await response.json() as { orderId: number; checkoutAttemptStatus: string };
  assert.equal(created.checkoutAttemptStatus, "uncertain");
  assert(acceptedStripeSession);

  const event = (
    overrides: Record<string, unknown> = {},
    mutate: (object: Record<string, any>) => void = () => undefined,
  ) => {
    const object: Record<string, any> = {
      id: acceptedStripeSession!.id,
      metadata: { orderId: String(created.orderId), gallerySlug, projectId: String(projectId) },
      payment_intent: "pi_accepted",
      payment_status: "paid",
      amount_total: 100,
      currency: "usd",
      customer_details: {
        email: payload.customerEmail,
        name: payload.customerName,
      },
      ...overrides,
    };
    mutate(object);
    return Buffer.from(JSON.stringify({
      type: "checkout.session.completed",
      data: { object },
    }));
  };
  const requiredFieldMutations: Array<[string, (object: Record<string, any>) => void]> = [
    ["session ID omitted", object => { delete object.id; }],
    ["session ID null", object => { object.id = null; }],
    ["metadata order ID omitted", object => { delete object.metadata.orderId; }],
    ["metadata order ID null", object => { object.metadata.orderId = null; }],
    ["metadata gallery slug omitted", object => { delete object.metadata.gallerySlug; }],
    ["metadata gallery slug null", object => { object.metadata.gallerySlug = null; }],
    ["metadata project ID omitted", object => { delete object.metadata.projectId; }],
    ["metadata project ID null", object => { object.metadata.projectId = null; }],
    ["amount omitted", object => { delete object.amount_total; }],
    ["amount null", object => { object.amount_total = null; }],
    ["currency omitted", object => { delete object.currency; }],
    ["currency null", object => { object.currency = null; }],
    ["payment status omitted", object => { delete object.payment_status; }],
    ["payment status null", object => { object.payment_status = null; }],
    ["customer details omitted", object => { delete object.customer_details; }],
    ["customer details null", object => { object.customer_details = null; }],
    ["customer email omitted", object => { delete object.customer_details.email; }],
    ["customer email null", object => { object.customer_details.email = null; }],
    ["customer name omitted", object => { delete object.customer_details.name; }],
    ["customer name null", object => { object.customer_details.name = null; }],
  ];
  for (const [label, mutate] of requiredFieldMutations) {
    await WebhookHandlers.processWebhook(event({}, mutate), "signed-test");
    const [stillPending] = await db.select({
      status: deliveryOrdersTable.status,
      stripeCheckoutSessionId: deliveryOrdersTable.stripeCheckoutSessionId,
    }).from(deliveryOrdersTable).where(eq(deliveryOrdersTable.id, created.orderId));
    assert.equal(stillPending?.status, "pending", label);
    assert.equal(stillPending?.stripeCheckoutSessionId, null, label);
  }
  await assert.rejects(
    WebhookHandlers.processWebhook(event({ id: "cs_wrong_session" }), "signed-test"),
    /does not authenticate this session/,
  );
  const [wrongSession] = await db.select({
    status: deliveryOrdersTable.status,
    stripeCheckoutSessionId: deliveryOrdersTable.stripeCheckoutSessionId,
  }).from(deliveryOrdersTable).where(eq(deliveryOrdersTable.id, created.orderId));
  assert.equal(wrongSession?.status, "pending");
  assert.equal(wrongSession?.stripeCheckoutSessionId, null);

  const entitlementBeforePayment = await fetch(
    `${baseUrl}/api/delivery/${gallerySlug}/orders/${created.orderId}`,
    { headers: { "x-delivery-token": paidAccessToken } },
  );
  assert.equal(entitlementBeforePayment.status, 200);
  assert.deepEqual((await entitlementBeforePayment.json() as { downloadablePhotoIds: number[] }).downloadablePhotoIds, []);

  await WebhookHandlers.processWebhook(event(), "signed-test");
  await WebhookHandlers.processWebhook(event(), "signed-test");
  const [paid] = await db.select({
    status: deliveryOrdersTable.status,
    stripeCheckoutSessionId: deliveryOrdersTable.stripeCheckoutSessionId,
  }).from(deliveryOrdersTable).where(eq(deliveryOrdersTable.id, created.orderId));
  assert.equal(paid.status, "paid");
  assert.equal(paid.stripeCheckoutSessionId, acceptedStripeSession.id);
  await assert.rejects(
    WebhookHandlers.processWebhook(event({ id: "cs_different_session" }), "signed-test"),
    /does not authenticate this session/,
  );
  const [stillPaid] = await db.select({
    status: deliveryOrdersTable.status,
    stripeCheckoutSessionId: deliveryOrdersTable.stripeCheckoutSessionId,
  }).from(deliveryOrdersTable).where(eq(deliveryOrdersTable.id, created.orderId));
  assert.equal(stillPaid.status, "paid");
  assert.equal(stillPaid.stripeCheckoutSessionId, acceptedStripeSession.id);
  const entitlements = await db.select({ id: deliveryOrderItemsTable.id })
    .from(deliveryOrderItemsTable).where(eq(deliveryOrderItemsTable.orderId, created.orderId));
  assert.equal(entitlements.length, 1);
});

test("simultaneous identical checkouts converge on one order and one notification", async () => {
  resendMode = "success";
  stripeMode = "success";
  const beforeStripeCreates = stripeCreateCalls;
  const idempotencyKey = `simultaneous-${suffix}`;
  const payload = {
    token: unpaidAccessToken,
    idempotencyKey,
    offerId: "digital-single",
    photoIds: [unpaidPhotoId],
    quantity: 1,
    customerName: "Simultaneous Checkout",
    customerEmail: `simultaneous-${suffix}@example.com`,
    paymentMethod: "stripe",
    deliveryMethod: "digital",
  };
  const beforeEmails = resendRequests.length;
  const responses = await Promise.all([1, 2].map(() => fetch(
    `${baseUrl}/api/delivery/${gallerySlug}/orders`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    },
  )));
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 200]);
  const bodies = await Promise.all(responses.map((response) => response.json() as Promise<{ orderId: number }>));
  assert.equal(bodies[0].orderId, bodies[1].orderId);
  const orders = await db.select({ id: deliveryOrdersTable.id })
    .from(deliveryOrdersTable)
    .where(and(
      eq(deliveryOrdersTable.galleryId, galleryId),
      eq(deliveryOrdersTable.accessId, unpaidAccessId),
      eq(deliveryOrdersTable.idempotencyKey, idempotencyKey),
    ));
  assert.equal(orders.length, 1);
  assert.equal(stripeCreateCalls, beforeStripeCreates + 1);
  const [createdOrder] = await db.select({
    stripeCheckoutSessionId: deliveryOrdersTable.stripeCheckoutSessionId,
  }).from(deliveryOrdersTable).where(eq(deliveryOrdersTable.id, bodies[0].orderId));
  assert.equal(createdOrder?.stripeCheckoutSessionId, `cs_test_${stripeCreateCalls}`);
  assert.equal(resendRequests.length, beforeEmails + 1);
});

test("ambiguous Stripe create is durable and replay never creates another provider session", async () => {
  stripeMode = "timeout";
  resendMode = "success";
  const emailCountBefore = resendRequests.length;
  const idempotencyKey = `stripe-timeout-${suffix}`;
  const payload = {
    token: unpaidAccessToken,
    idempotencyKey,
    offerId: "digital-single",
    photoIds: [unpaidPhotoId],
    quantity: 1,
    customerName: "Stripe Uncertain",
    customerEmail: `stripe-uncertain-${suffix}@example.com`,
    paymentMethod: "stripe",
    deliveryMethod: "digital",
  };
  const first = await fetch(`${baseUrl}/api/delivery/${gallerySlug}/orders`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  assert.equal(first.status, 202);
  const firstBody = await first.json() as { orderId: number; checkoutAttemptStatus: string };
  assert.equal(firstBody.checkoutAttemptStatus, "uncertain");
  assert.equal(resendRequests.length, emailCountBefore + 1);
  assert.match(resendRequests.at(-1)?.body ?? "", /do not submit the order again/i);
  const createsAfterFirst = stripeCreateCalls;
  const persisted = await db.select({
    checkoutAttemptStatus: deliveryOrdersTable.checkoutAttemptStatus,
    checkoutAttemptError: deliveryOrdersTable.checkoutAttemptError,
  }).from(deliveryOrdersTable).where(eq(deliveryOrdersTable.id, firstBody.orderId));
  assert.equal(persisted[0]?.checkoutAttemptStatus, "uncertain");
  assert.match(persisted[0]?.checkoutAttemptError ?? "", /timeout/i);

  const replay = await fetch(`${baseUrl}/api/delivery/${gallerySlug}/orders`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  assert.equal(replay.status, 200);
  const replayBody = await replay.json() as { orderId: number; checkoutAttemptStatus: string };
  assert.equal(replayBody.orderId, firstBody.orderId);
  assert.equal(replayBody.checkoutAttemptStatus, "uncertain");
  assert.equal(stripeCreateCalls, createsAfterFirst);
  assert.equal(resendRequests.length, emailCountBefore + 1);

  for (const [failureMode, suffixLabel] of [["server_error", "5xx"], ["incomplete", "incomplete"]] as const) {
    stripeMode = failureMode;
    const failureKey = `stripe-${suffixLabel}-${suffix}`;
    const failureResponse = await fetch(`${baseUrl}/api/delivery/${gallerySlug}/orders`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...payload,
        idempotencyKey: failureKey,
        customerName: `Stripe ${suffixLabel}`,
        customerEmail: `stripe-${suffixLabel}-${suffix}@example.com`,
      }),
    });
    assert.equal(failureResponse.status, 202);
    const failureBody = await failureResponse.json() as { orderId: number; checkoutAttemptStatus: string };
    assert.equal(failureBody.checkoutAttemptStatus, "uncertain");
    const failureRow = await db.select({
      checkoutAttemptStatus: deliveryOrdersTable.checkoutAttemptStatus,
    }).from(deliveryOrdersTable).where(eq(deliveryOrdersTable.id, failureBody.orderId));
    assert.equal(failureRow[0]?.checkoutAttemptStatus, "uncertain");
  }
  stripeMode = "success";
});

test("rejects another subject's photo from listing, ordering, preview, and download", async () => {
  const galleryResponse = await fetch(`${baseUrl}/api/delivery/${gallerySlug}/gallery`, {
    headers: { "x-delivery-token": paidAccessToken },
  });
  assert.equal(galleryResponse.status, 200);
  assert.equal((await galleryResponse.json() as { photos: Array<{ id: number }> })
    .photos.some((photo) => photo.id === unpaidPhotoId), false);

  const orderResponse = await fetch(`${baseUrl}/api/delivery/${gallerySlug}/orders`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      token: paidAccessToken,
      idempotencyKey: `r2-wrong-subject-${suffix}`,
      offerId: "digital-single",
      photoIds: [unpaidPhotoId],
      quantity: 1,
      customerName: "Wrong subject",
      customerEmail: `wrong-subject-${suffix}@example.com`,
      paymentMethod: "stripe",
    }),
  });
  assert.equal(orderResponse.status, 400);
  assert.equal((await requestPhoto(unpaidPhotoId, paidAccessToken, "preview=1")).status, 404);
  assert.equal((await requestPhoto(unpaidPhotoId, paidAccessToken)).status, 404);
});

test("selects a ready group source copy for a materialized group photo", async () => {
  r2RequestedKeys.length = 0;
  objectStorageReads = 0;
  const response = await requestPhoto(readyGroupPhotoId, paidAccessToken);
  assert.equal(response.status, 200);
  const groupBytes = Buffer.from(await response.arrayBuffer());
  assert(groupBytes.length > 0, `empty group body; r2=${JSON.stringify(r2RequestedKeys)}`);
  assert(r2RequestedKeys.includes("ready/group.jpg"));
  assert(r2RequestedKeys.some((key) => key.includes("__download__")));
  assert.equal(objectStorageReads, 0);
});

test("enforces current group membership without deleting purchased photo identity", async () => {
  const [groupPhoto] = await db.select().from(studentPhotosTable)
    .where(eq(studentPhotosTable.id, readyGroupPhotoId));
  assert(groupPhoto.sourceGroupCaptureFileId);
  const [groupFile] = await db.select().from(groupCaptureFilesTable)
    .where(eq(groupCaptureFilesTable.id, groupPhoto.sourceGroupCaptureFileId));
  const [capture] = await db.select().from(groupCapturesTable)
    .where(eq(groupCapturesTable.id, groupFile.captureId));

  await db.delete(groupMembersTable).where(and(
    eq(groupMembersTable.groupId, capture.groupId),
    eq(groupMembersTable.studentId, studentId),
  ));
  const removedResponse = await fetch(`${baseUrl}/api/delivery/${gallerySlug}/gallery`, {
    headers: { "x-delivery-token": paidAccessToken },
  });
  assert.equal(removedResponse.status, 200);
  assert.equal((await removedResponse.json() as { photos: Array<{ id: number }> })
    .photos.some((photo) => photo.id === readyGroupPhotoId), false);
  assert.equal((await requestPhoto(readyGroupPhotoId, paidAccessToken, "preview=1")).status, 404);
  const [preservedPhoto] = await db.select().from(studentPhotosTable)
    .where(eq(studentPhotosTable.id, readyGroupPhotoId));
  assert.equal(preservedPhoto.id, readyGroupPhotoId);
  const [preservedItem] = await db.select().from(deliveryOrderItemsTable)
    .where(eq(deliveryOrderItemsTable.photoId, readyGroupPhotoId)).limit(1);
  assert.equal(preservedItem.photoId, readyGroupPhotoId);

  await db.insert(groupMembersTable).values({ groupId: capture.groupId, studentId });
  const restoredResponse = await fetch(`${baseUrl}/api/delivery/${gallerySlug}/gallery`, {
    headers: { "x-delivery-token": paidAccessToken },
  });
  assert.equal(restoredResponse.status, 200);
  const restored = await restoredResponse.json() as { photos: Array<{ id: number; fileName: string }> };
  assert(restored.photos.some((photo) => photo.id === readyGroupPhotoId));
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
      idempotencyKey: `r2-unshared-${suffix}`,
      offerId: "digital-single",
      photoIds: blockedPhotoIds,
      quantity: 1,
      customerName: "Unshared Photo Test",
      customerEmail: `unshared-${suffix}@example.com`,
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

test("does not expose RAW or unrated files through ordering, preview, or download", async () => {
  for (const photoId of [rawPhotoId, unratedPhotoId]) {
    const orderResponse = await fetch(`${baseUrl}/api/delivery/${gallerySlug}/orders`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: paidAccessToken,
        idempotencyKey: `r2-ineligible-${suffix}-${photoId}`,
        offerId: "digital-single",
        photoIds: [photoId],
        quantity: 1,
        customerName: "Ineligible photo",
        customerEmail: `ineligible-${suffix}@example.com`,
        paymentMethod: "stripe",
      }),
    });
    assert.equal(orderResponse.status, 400);
    assert.equal((await requestPhoto(photoId, paidAccessToken, "preview=1")).status, 404);
    assert.equal((await requestPhoto(photoId, paidAccessToken)).status, 404);
  }
});

test("keeps an authorized R2 read failure private instead of serving stale Object Storage bytes", async () => {
  r2RequestedKeys.length = 0;
  objectStorageReads = 0;
  r2Failures.add("ready/student.jpg");
  const downloadVariantKey = Array.from(r2Bodies.keys()).find((key) => key.includes("__download__"));
  assert(downloadVariantKey);
  r2Failures.add(downloadVariantKey);
  thisPathBytes = Buffer.from("stale Object Storage bytes");
  const response = await requestPhoto(readyStudentPhotoId, paidAccessToken);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "Photo file is temporarily unavailable" });
  assert(r2RequestedKeys.includes(downloadVariantKey));
  assert.equal(objectStorageReads, 0);
  r2Failures.delete("ready/student.jpg");
  r2Failures.delete(downloadVariantKey);
});