import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import test, { after, before } from "node:test";
import express from "express";
import { eq } from "drizzle-orm";
import {
  classesTable,
  db,
  deliveryAccessesTable,
  deliveryGalleriesTable,
  deliveryInvitationAccessLinksTable,
  deliveryInvitationsTable,
  deliveryPriceSheetsTable,
  marketingContactsTable,
  pool,
  projectsTable,
  studioMembersTable,
  studiosTable,
  studentsTable,
} from "@workspace/db";
import deliveryRouter from "../src/routes/delivery";
import { decryptStorageValue } from "../src/lib/storageCrypto";

/**
 * This file owns a localhost-only provider. No test path has a production
 * Resend fallback: resendEmail.ts permits a provider call in test only when
 * RESEND_API_BASE_URL is set to this server.
 */
process.env.NODE_ENV = "test";
process.env.SESSION_SECRET = "delivery-invitation-test-secret-that-is-at-least-32-bytes";
process.env.RESEND_API_KEY = "re_test_delivery_invitation";
process.env.RESEND_FROM_EMAIL = "Volume Capture <test@volume.example>";
process.env.PUBLIC_APP_URL = "https://gallery.test";

const suffix = `${process.pid}-${Date.now()}`;
const ownerUserId = `delivery-invitation-owner-${suffix}`;
const viewerUserId = `delivery-invitation-viewer-${suffix}`;
const platformOwnerUserId = `delivery-invitation-platform-${suffix}`;
process.env.PLATFORM_OWNER_USER_ID = platformOwnerUserId;
const app = express();
let server: Server;
let resendServer: Server;
let baseUrl: string;
let resendBaseUrl: string;
let studioId: number;
let otherStudioId: number;
let fakeSequence = 0;
let fakeMode: "success" | "reject" | "server_error" | "incomplete" | "network" = "success";
const providerIdempotencyCache = new Map<string, { status: number; payload: unknown }>();
const requests: Array<{
  batch: Array<Record<string, unknown>>;
  idempotencyKey: string;
}> = [];

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
app.use("/api", deliveryRouter);

type SubjectInput = {
  firstName: string;
  lastName: string;
  email?: string | null;
  secondaryEmail?: string | null;
};

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>[]> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>[];
}

async function fakeResend(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "POST" || req.url !== "/emails/batch") {
    res.writeHead(404).end();
    return;
  }
  if (fakeMode === "network") {
    req.socket.destroy();
    return;
  }
  const batch = await readJsonBody(req);
  const idempotencyKey = String(req.headers["idempotency-key"] ?? "");
  requests.push({
    batch,
    idempotencyKey,
  });
  const cached = providerIdempotencyCache.get(idempotencyKey);
  if (cached) {
    res.writeHead(cached.status, { "content-type": "application/json" }).end(JSON.stringify(cached.payload));
    return;
  }
  if (fakeMode === "reject") {
    const response = { status: 422, payload: { error: "test rejection" } };
    providerIdempotencyCache.set(idempotencyKey, response);
    res.writeHead(response.status, { "content-type": "application/json" }).end(JSON.stringify(response.payload));
    return;
  }
  if (fakeMode === "server_error") {
    const response = { status: 503, payload: { error: "test outage" } };
    providerIdempotencyCache.set(idempotencyKey, response);
    res.writeHead(response.status, { "content-type": "application/json" }).end(JSON.stringify(response.payload));
    return;
  }
  const data = fakeMode === "incomplete"
    ? batch.slice(0, Math.max(0, batch.length - 1)).map(() => ({ id: `fake_email_${fakeSequence++}` }))
    : batch.map(() => ({ id: `fake_email_${fakeSequence++}` }));
  const response = { status: 200, payload: { data } };
  providerIdempotencyCache.set(idempotencyKey, response);
  res.writeHead(response.status, { "content-type": "application/json" });
  res.end(JSON.stringify(response.payload));
}

async function request(userId: string, pathname: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("x-test-user", userId);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  return fetch(`${baseUrl}${pathname}`, { ...init, headers });
}

async function json<T>(response: Response): Promise<T> {
  return response.json() as Promise<T>;
}

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

async function createGallery(projectType: "school" | "corporate", subjects: SubjectInput[]) {
  const project = (await db.insert(projectsTable).values({
    userId: ownerUserId,
    studioId,
    projectType,
    schoolName: `${projectType} Invitation Project ${suffix}`,
  }).returning({ id: projectsTable.id }))[0];
  const studentClass = (await db.insert(classesTable).values({
    projectId: project.id,
    className: projectType === "corporate" ? "Engineering" : "Class 3B",
  }).returning({ id: classesTable.id }))[0];
  await db.insert(studentsTable).values(subjects.map((subject, index) => ({
    projectId: project.id,
    classId: studentClass.id,
    firstName: subject.firstName,
    lastName: subject.lastName,
    generatedStudentId: `DELIVERY-INV-${suffix}-${project.id}-${index}`,
    email: subject.email ?? null,
    secondaryEmail: subject.secondaryEmail ?? null,
  })));
  const priceSheet = (await db.insert(deliveryPriceSheetsTable).values({
    studioId,
    name: `Invitation prices ${suffix}-${project.id}`,
    offersJson: offerJson,
  }).returning({ id: deliveryPriceSheetsTable.id }))[0];
  const gallery = (await db.insert(deliveryGalleriesTable).values({
    projectId: project.id,
    studioId,
    priceSheetId: priceSheet.id,
    slug: `delivery-invitation-${suffix}-${project.id}`,
  }).returning({ id: deliveryGalleriesTable.id, slug: deliveryGalleriesTable.slug }))[0];
  return { projectId: project.id, galleryId: gallery.id, slug: gallery.slug };
}

async function publish(projectId: number, userId = ownerUserId): Promise<Response> {
  return request(userId, `/api/projects/${projectId}/delivery/publish`, { method: "POST" });
}

async function invitationRows(galleryId: number) {
  return db.select().from(deliveryInvitationsTable)
    .where(eq(deliveryInvitationsTable.galleryId, galleryId));
}

async function accessRows(galleryId: number) {
  return db.select().from(deliveryAccessesTable)
    .where(eq(deliveryAccessesTable.galleryId, galleryId));
}

async function assertGalleryAccessRemainsValid(galleryId: number, slug: string): Promise<void> {
  const [access] = await accessRows(galleryId);
  assert(access);
  const code = decryptStorageValue<string>(access.accessCodeEncrypted);
  const response = await request("public", `/api/delivery/${slug}/access`, {
    method: "POST",
    body: JSON.stringify({ code, email: "delivery-audit@example.com" }),
  });
  assert.equal(response.status, 200);
}

before(async () => {
  resendServer = createServer((req, res) => {
    void fakeResend(req, res);
  });
  resendServer.listen(0, "127.0.0.1");
  await once(resendServer, "listening");
  const resendAddress = resendServer.address();
  assert(resendAddress && typeof resendAddress !== "string");
  resendBaseUrl = `http://127.0.0.1:${resendAddress.port}`;
  process.env.RESEND_API_BASE_URL = resendBaseUrl;

  const studio = (await db.insert(studiosTable).values({
    name: `Delivery invitation studio ${suffix}`,
    createdByUserId: ownerUserId,
  }).returning({ id: studiosTable.id }))[0];
  studioId = studio.id;
  await db.insert(studioMembersTable).values([
    { studioId, userId: ownerUserId, email: `${ownerUserId}@member.local`, role: "owner" },
    { studioId, userId: viewerUserId, email: `${viewerUserId}@member.local`, role: "viewer" },
  ]);
  const otherStudio = (await db.insert(studiosTable).values({
    name: `Other delivery invitation studio ${suffix}`,
    createdByUserId: platformOwnerUserId,
  }).returning({ id: studiosTable.id }))[0];
  otherStudioId = otherStudio.id;
  await db.insert(studioMembersTable).values({
    studioId: otherStudioId,
    userId: platformOwnerUserId,
    email: `${platformOwnerUserId}@member.local`,
    role: "owner",
  });

  server = createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  if (otherStudioId) await db.delete(studiosTable).where(eq(studiosTable.id, otherStudioId));
  if (studioId) await db.delete(studiosTable).where(eq(studiosTable.id, studioId));
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await new Promise<void>((resolve, reject) => resendServer.close((error) => error ? reject(error) : resolve()));
  await pool.end();
});

test("school and corporate addresses consolidate with every subject code and never touch marketing consent", async () => {
  fakeMode = "success";
  const school = await createGallery("school", [
    { firstName: "Ada", lastName: "One", email: " Parent@One.example ", secondaryEmail: "shared@example.com" },
    { firstName: "Grace", lastName: "Two", email: "SHARED@example.com", secondaryEmail: "Shared@Example.com" },
    { firstName: "No", lastName: "Address", email: "not-an-email", secondaryEmail: " " },
  ]);
  const corporate = await createGallery("corporate", [
    { firstName: "Lin", lastName: "Three", email: "employee@example.com", secondaryEmail: "corp-shared@example.com" },
    { firstName: "Katherine", lastName: "Four", email: "EMPLOYEE@EXAMPLE.COM", secondaryEmail: "other@example.com" },
  ]);
  const contact = (await db.insert(marketingContactsTable).values({
    studioId,
    email: "parent@one.example",
    marketingConsent: false,
    consentSource: "test",
  }).returning())[0];
  const beforeConsent = { marketingConsent: contact.marketingConsent, consentAt: contact.consentAt };

  assert.equal((await publish(school.projectId)).status, 200);
  assert.equal((await publish(corporate.projectId)).status, 200);

  const schoolInvitations = await invitationRows(school.galleryId);
  const corporateInvitations = await invitationRows(corporate.galleryId);
  assert.deepEqual(new Set(schoolInvitations.map((row) => row.recipientEmail)), new Set([
    "parent@one.example", "shared@example.com",
  ]));
  assert.deepEqual(new Set(corporateInvitations.map((row) => row.recipientEmail)), new Set([
    "employee@example.com", "corp-shared@example.com", "other@example.com",
  ]));
  assert.equal(schoolInvitations.every((row) => row.status === "sent"), true);
  assert.equal(corporateInvitations.every((row) => row.status === "sent"), true);
  const schoolShared = requests.find((request) =>
    request.batch.some((message) =>
      (message.to as string[] | undefined)?.[0] === "shared@example.com"));
  assert(schoolShared);
  const sharedMessage = schoolShared.batch.find((message) =>
    (message.to as string[] | undefined)?.[0] === "shared@example.com");
  assert(sharedMessage);
  const sharedBody = JSON.stringify(sharedMessage);
  assert.match(sharedBody, /Grace Two/);
  assert.match(sharedBody, /Ada One/);
  assert.match(sharedBody, /Student/);
  assert.match(sharedBody, /Class/);
  assert.equal((sharedMessage.headers as Record<string, string>)["List-Unsubscribe"], undefined);
  const schoolKeyDigest = createHash("sha256").update(schoolInvitations
    .map((row) => `${row.id}:${row.contentRevision}:a1`)
    .sort()
    .join("|")).digest("hex");
  assert.equal(schoolShared.idempotencyKey, `volume-capture-delivery-invitations-v1-${schoolKeyDigest}`);
  assert.equal(sharedBody.includes("?code="), false);
  const sharedInvitation = schoolInvitations.find((row) => row.recipientEmail === "shared@example.com");
  assert(sharedInvitation);
  const sharedLinks = await db.select({ access: deliveryAccessesTable })
    .from(deliveryInvitationAccessLinksTable)
    .innerJoin(deliveryAccessesTable, eq(deliveryAccessesTable.id, deliveryInvitationAccessLinksTable.accessId))
    .where(eq(deliveryInvitationAccessLinksTable.invitationId, sharedInvitation.id));
  for (const { access } of sharedLinks) {
    const code = decryptStorageValue<string>(access.accessCodeEncrypted);
    assert(sharedBody.includes(code));
  }
  const corporateRequest = requests.find((request) =>
    request.batch.some((message) =>
      (message.to as string[] | undefined)?.[0] === "employee@example.com"));
  assert(corporateRequest);
  const corporateMessage = corporateRequest.batch.find((message) =>
    (message.to as string[] | undefined)?.[0] === "employee@example.com");
  assert(corporateMessage);
  assert.match(JSON.stringify(corporateMessage), /Employee/);
  assert.match(JSON.stringify(corporateMessage), /Department/);
  assert.match(JSON.stringify(corporateMessage), /Lin Three/);
  assert.match(JSON.stringify(corporateMessage), /Katherine Four/);
  assert(corporateInvitations.every((row) => row.providerId && row.sentAt && row.attempts === 1));
  const [afterContact] = await db.select().from(marketingContactsTable)
    .where(eq(marketingContactsTable.id, contact.id));
  assert.deepEqual(
    { marketingConsent: afterContact.marketingConsent, consentAt: afterContact.consentAt },
    beforeConsent,
  );
});

test("repeated and concurrent publish creates one access/link and never sends again", async () => {
  const gallery = await createGallery("school", [
    { firstName: "Repeat", lastName: "Subject", email: `repeat-${suffix}@example.com` },
  ]);
  assert.equal((await publish(gallery.projectId)).status, 200);
  const before = requests.length;
  const responses = await Promise.all([publish(gallery.projectId), publish(gallery.projectId)]);
  assert.deepEqual(responses.map((response) => response.status), [200, 200]);
  assert.equal(requests.length, before);
  assert.equal((await accessRows(gallery.galleryId)).length, 1);
  assert.equal((await invitationRows(gallery.galleryId)).length, 1);
  assert.equal((await db.select().from(deliveryInvitationAccessLinksTable)
    .where(eq(deliveryInvitationAccessLinksTable.invitationId, (await invitationRows(gallery.galleryId))[0].id))).length, 1);
  await assertGalleryAccessRemainsValid(gallery.galleryId, gallery.slug);
});

test("4xx is failed and explicitly retryable, while publication stays committed", async () => {
  fakeMode = "reject";
  const gallery = await createGallery("school", [
    { firstName: "Rejected", lastName: "Subject", email: `reject-${suffix}@example.com` },
  ]);
  assert.equal((await publish(gallery.projectId)).status, 200);
  assert.equal((await invitationRows(gallery.galleryId))[0].status, "failed");
  const beforeRetry = requests.length;
  assert.equal((await request(viewerUserId, `/api/projects/${gallery.projectId}/delivery/invitations/retry`, { method: "POST" })).status, 403);
  assert.equal((await request(platformOwnerUserId, `/api/projects/${gallery.projectId}/delivery/invitations/retry`, { method: "POST" })).status, 403);
  const firstAttemptKey = requests[beforeRetry - 1]?.idempotencyKey;
  assert(firstAttemptKey);
  fakeMode = "success";
  assert.equal((await request(ownerUserId, `/api/projects/${gallery.projectId}/delivery/invitations/retry`, { method: "POST" })).status, 200);
  const [sent] = await invitationRows(gallery.galleryId);
  assert.equal(sent.status, "sent");
  assert.equal(sent.attempts, 2);
  assert(sent.providerId && sent.sentAt);
  assert.equal(requests.length, beforeRetry + 1);
  assert.notEqual(requests[beforeRetry]?.idempotencyKey, firstAttemptKey);
  assert.equal((await request(ownerUserId, `/api/projects/${gallery.projectId}/delivery/invitations/retry`, { method: "POST" })).status, 200);
  assert.equal(requests.length, beforeRetry + 1);
  await assertGalleryAccessRemainsValid(gallery.galleryId, gallery.slug);
});

test("5xx, incomplete, and network failures become needs_review and can never be retried by the endpoint", async () => {
  for (const mode of ["server_error", "incomplete", "network"] as const) {
    fakeMode = mode;
    const gallery = await createGallery("corporate", [
      { firstName: mode, lastName: "Subject", email: `${mode}-${suffix}@example.com` },
    ]);
    assert.equal((await publish(gallery.projectId)).status, 200);
    const [invitation] = await invitationRows(gallery.galleryId);
    assert.equal(invitation.status, "needs_review");
    const beforeRetry = requests.length;
    fakeMode = "success";
    assert.equal((await request(ownerUserId, `/api/projects/${gallery.projectId}/delivery/invitations/retry`, { method: "POST" })).status, 200);
    assert.equal(requests.length, beforeRetry);
    assert.equal((await invitationRows(gallery.galleryId))[0].status, "needs_review");
    await assertGalleryAccessRemainsValid(gallery.galleryId, gallery.slug);
  }
});

test("a newly linked access advances an uncertain invitation revision without resetting needs_review", async () => {
  fakeMode = "incomplete";
  const gallery = await createGallery("school", [
    { firstName: "Uncertain", lastName: "First", email: `uncertain-shared-${suffix}@example.com` },
  ]);
  assert.equal((await publish(gallery.projectId)).status, 200);
  const [before] = await invitationRows(gallery.galleryId);
  assert.equal(before.status, "needs_review");
  assert.equal(before.contentRevision, 1);
  const [studentClass] = await db.select().from(classesTable)
    .where(eq(classesTable.projectId, gallery.projectId)).limit(1);
  await db.insert(studentsTable).values({
    projectId: gallery.projectId,
    classId: studentClass.id,
    firstName: "Uncertain",
    lastName: "Second",
    generatedStudentId: `DELIVERY-INV-UNCERTAIN-${suffix}`,
    email: `UNCERTAIN-SHARED-${suffix}@example.com`,
  });
  const beforeRetry = requests.length;
  fakeMode = "success";
  assert.equal((await publish(gallery.projectId)).status, 200);
  const [after] = await invitationRows(gallery.galleryId);
  assert.equal(after.status, "needs_review");
  assert.equal(after.contentRevision, 2);
  assert.match(after.lastError ?? "", /uncertain provider attempt/i);
  assert.equal(requests.length, beforeRetry);
  assert.equal((await accessRows(gallery.galleryId)).length, 2);
});

test("stale sending claims become needs_review and are never resent", async () => {
  fakeMode = "success";
  const gallery = await createGallery("school", [
    { firstName: "Stale", lastName: "Claim", email: `stale-${suffix}@example.com` },
  ]);
  assert.equal((await publish(gallery.projectId)).status, 200);
  const [invitation] = await invitationRows(gallery.galleryId);
  await db.update(deliveryInvitationsTable).set({
    status: "sending",
    claimedAt: new Date(Date.now() - 16 * 60 * 1000),
    lastError: null,
  }).where(eq(deliveryInvitationsTable.id, invitation.id));
  const before = requests.length;
  assert.equal((await publish(gallery.projectId)).status, 200);
  assert.equal(requests.length, before);
  const [reconciled] = await invitationRows(gallery.galleryId);
  assert.equal(reconciled.status, "needs_review");
  assert.match(reconciled.lastError ?? "", /stale/i);
  await assertGalleryAccessRemainsValid(gallery.galleryId, gallery.slug);
});

test("development, incomplete configuration, and onboarding sender never contact the provider", async () => {
  const modes = [
    { name: "development", setup: () => { process.env.NODE_ENV = "development"; } },
    { name: "unconfigured", setup: () => {
      process.env.NODE_ENV = "test";
      delete process.env.RESEND_API_KEY;
    } },
    { name: "non-loopback", setup: () => {
      process.env.NODE_ENV = "test";
      process.env.RESEND_API_KEY = "re_test_delivery_invitation";
      process.env.RESEND_FROM_EMAIL = "Volume Capture <test@volume.example>";
      process.env.RESEND_API_BASE_URL = "https://api.resend.com";
    } },
    { name: "onboarding", setup: () => {
      process.env.NODE_ENV = "test";
      process.env.RESEND_API_KEY = "re_test_delivery_invitation";
      process.env.RESEND_FROM_EMAIL = "Volume Capture <onboarding@resend.dev>";
    } },
  ] as const;
  for (const mode of modes) {
    fakeMode = "success";
    mode.setup();
    const gallery = await createGallery("school", [
      { firstName: mode.name, lastName: "Subject", email: `${mode.name}-${suffix}@example.com` },
    ]);
    const before = requests.length;
    assert.equal((await publish(gallery.projectId)).status, 200);
    assert.equal(requests.length, before);
    assert.equal((await invitationRows(gallery.galleryId))[0].status, "pending");
    await assertGalleryAccessRemainsValid(gallery.galleryId, gallery.slug);
    process.env.RESEND_API_BASE_URL = resendBaseUrl;
  }
  process.env.NODE_ENV = "test";
  process.env.RESEND_API_KEY = "re_test_delivery_invitation";
  process.env.RESEND_FROM_EMAIL = "Volume Capture <test@volume.example>";
});