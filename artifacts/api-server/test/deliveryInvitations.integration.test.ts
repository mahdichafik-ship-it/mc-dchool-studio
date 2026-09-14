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
  deliveryOrdersTable,
  deliveryPriceSheetsTable,
  marketingContactsTable,
  pool,
  projectsTable,
  studentPhotosTable,
  studioMembersTable,
  studiosTable,
  studentsTable,
} from "@workspace/db";
import deliveryRouter from "../src/routes/delivery";
import projectsRouter from "../src/routes/projects";
import classesRouter from "../src/routes/classes";
import importRouter from "../src/routes/import";
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
const otherStudioViewerUserId = `delivery-invitation-other-viewer-${suffix}`;
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
let apiProjectSequence = 0;
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
app.use("/api/projects", projectsRouter);
app.use("/api/projects/:projectId/classes", classesRouter);
app.use("/api/projects/:projectId/import", importRouter);
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

async function createGallery(
  projectType: "school" | "corporate",
  subjects: SubjectInput[],
  targetStudioId = studioId,
  projectOwner = ownerUserId,
) {
  const project = (await db.insert(projectsTable).values({
    userId: projectOwner,
    studioId: targetStudioId,
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
    studioId: targetStudioId,
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

async function prepare(projectId: number, userId = ownerUserId): Promise<Response> {
  return request(userId, `/api/projects/${projectId}/delivery/access-cards/prepare`, { method: "POST" });
}

function importSheet(className: string, rows: string[][]) {
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
    rows,
  };
}

async function createProjectThroughApi(projectType: "school" | "corporate" = "school") {
  const priceSheet = (await db.insert(deliveryPriceSheetsTable).values({
    studioId,
    name: `API lifecycle prices ${suffix}-${++apiProjectSequence}`,
    offersJson: offerJson,
  }).returning({ id: deliveryPriceSheetsTable.id }))[0];
  const response = await request(ownerUserId, "/api/projects", {
    method: "POST",
    body: JSON.stringify({
      projectType,
      schoolName: `API lifecycle ${suffix}-${priceSheet.id}`,
      priceSheetId: priceSheet.id,
    }),
  });
  assert.equal(response.status, 201);
  return json<{ id: number; priceSheetId: number }>(response);
}

async function importRosterThroughApi(projectId: number, className: string, rows: string[][]) {
  const response = await request(ownerUserId, `/api/projects/${projectId}/import/confirm`, {
    method: "POST",
    body: JSON.stringify({ sheets: [importSheet(className, rows)] }),
  });
  assert.equal(response.status, 200);
  return response;
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
  await db.insert(studioMembersTable).values({
    studioId: otherStudioId,
    userId: otherStudioViewerUserId,
    email: `${otherStudioViewerUserId}@member.local`,
    role: "viewer",
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

test("Release 6 prepares draft cards atomically, preserves credentials, isolates studios, and publishes without changing them", async () => {
  process.env.NODE_ENV = "test";
  process.env.PUBLIC_APP_URL = "https://gallery.test";
  process.env.RESEND_API_BASE_URL = resendBaseUrl;
  fakeMode = "success";

  const gallery = await createGallery("school", [
    { firstName: "Prepared", lastName: "Student", email: `prepared-${suffix}@example.com` },
  ]);
  const otherStudioGallery = await createGallery("school", [
    { firstName: "Other", lastName: "Studio", email: `other-${suffix}@example.com` },
  ], otherStudioId, platformOwnerUserId);

  const unauthorized = await prepare(gallery.projectId, viewerUserId);
  assert.equal(unauthorized.status, 404, "view-only members cannot prepare cards");
  const crossStudio = await prepare(gallery.projectId, otherStudioViewerUserId);
  assert.equal(crossStudio.status, 404, "another studio cannot prepare this project");
  const crossStudioOwner = await prepare(otherStudioGallery.projectId, ownerUserId);
  assert.equal(crossStudioOwner.status, 404, "this studio cannot prepare another studio project");

  const beforePhotos = await db.select().from(studentPhotosTable).where(eq(studentPhotosTable.projectId, gallery.projectId));
  const beforeOrders = await db.select().from(deliveryOrdersTable).where(eq(deliveryOrdersTable.galleryId, gallery.galleryId));
  const beforeAttempts = await accessRows(gallery.galleryId);
  const firstPrepare = await prepare(gallery.projectId);
  assert.equal(firstPrepare.status, 200);
  const firstBody = await json<{
    gallery: { status: string };
    preparedCount: number;
    studentCount: number;
    cards: Array<{ studentId: number; accessCode: string; accessUrl: string; qrUrl: string; qrDataUrl: string }>;
  }>(firstPrepare);
  assert.equal(firstBody.gallery.status, "draft");
  assert.equal(firstBody.preparedCount, 1);
  assert.equal(firstBody.studentCount, 1);
  assert.equal((await invitationRows(gallery.galleryId)).length, 0, "preparation does not enqueue invitations");
  assert.deepEqual(await db.select().from(studentPhotosTable).where(eq(studentPhotosTable.projectId, gallery.projectId)), beforePhotos);
  assert.deepEqual(await db.select().from(deliveryOrdersTable).where(eq(deliveryOrdersTable.galleryId, gallery.galleryId)), beforeOrders);
  const firstRow = (await accessRows(gallery.galleryId))[0];
  assert(firstRow);
  assert.equal(firstRow.failedAttempts, 0);
  assert.equal(firstRow.lockedUntil, null);
  assert.equal((await db.select().from(marketingContactsTable).where(eq(marketingContactsTable.studioId, studioId))).some(
    (contact) => contact.email === `prepared-${suffix}@example.com`,
  ), false, "preparation does not create marketing consent");

  const storedCredential = {
    hash: firstRow.accessCodeHash,
    encrypted: firstRow.accessCodeEncrypted,
    last4: firstRow.accessCodeLast4,
    code: decryptStorageValue<string>(firstRow.accessCodeEncrypted),
  };
  assert.equal(firstBody.cards[0]?.accessCode, storedCredential.code);
  assert.match(firstBody.cards[0]?.accessUrl ?? "", /^https:\/\/gallery\.test\/delivery\//);
  assert.equal(firstBody.cards[0]?.accessUrl.includes(storedCredential.code), false);
  assert.equal(firstBody.cards[0]?.qrUrl, `https://gallery.test/delivery/${gallery.slug}#code=${storedCredential.code}`);
  assert.equal(firstBody.cards[0]?.qrUrl.includes("?code="), false);
  assert.match(firstBody.cards[0]?.qrDataUrl ?? "", /^data:image\/png;base64,/);

  const concurrent = await Promise.all([prepare(gallery.projectId), prepare(gallery.projectId)]);
  const concurrentBodies = await Promise.all(concurrent.map((response) => json<typeof firstBody>(response)));
  assert.deepEqual(
    concurrentBodies.map((body) => body.cards[0]?.accessCode),
    [storedCredential.code, storedCredential.code],
    "concurrent preparation returns the persisted winner to both callers",
  );
  const secondRow = (await accessRows(gallery.galleryId))[0];
  assert.deepEqual({
    hash: secondRow?.accessCodeHash,
    encrypted: secondRow?.accessCodeEncrypted,
    last4: secondRow?.accessCodeLast4,
  }, { hash: storedCredential.hash, encrypted: storedCredential.encrypted, last4: storedCredential.last4 });

  const [studentClass] = await db.select().from(classesTable).where(eq(classesTable.projectId, gallery.projectId)).limit(1);
  const [student] = await db.select().from(studentsTable).where(eq(studentsTable.projectId, gallery.projectId)).limit(1);
  assert(studentClass && student);
  await db.update(classesTable).set({ className: "Updated Class" }).where(eq(classesTable.id, studentClass.id));
  await db.update(studentsTable).set({ firstName: "Updated", lastName: "Roster" }).where(eq(studentsTable.id, student.id));
  const [newStudent] = await db.insert(studentsTable).values({
    projectId: gallery.projectId,
    classId: studentClass.id,
    firstName: "Added",
    lastName: "Student",
    generatedStudentId: `DELIVERY-INV-ADDED-${suffix}`,
  }).returning();
  const rosterUpdate = await prepare(gallery.projectId);
  assert.equal(rosterUpdate.status, 200);
  const rosterBody = await json<typeof firstBody>(rosterUpdate);
  assert.equal(rosterBody.cards.find((card) => card.studentId === student.id)?.accessCode, storedCredential.code);
  const addedCode = rosterBody.cards.find((card) => card.studentId === newStudent.id)?.accessCode;
  assert(addedCode && addedCode !== storedCredential.code);

  const [otherStudent] = await db.select().from(studentsTable).where(eq(studentsTable.projectId, otherStudioGallery.projectId)).limit(1);
  assert(otherStudent);
  const otherPrepare = await prepare(otherStudioGallery.projectId, platformOwnerUserId);
  assert.equal(otherPrepare.status, 200);
  const otherBody = await json<typeof firstBody>(otherPrepare);
  assert.notEqual(otherBody.cards[0]?.accessCode, storedCredential.code, "credentials never cross project or studio boundaries");

  await db.delete(studentsTable).where(eq(studentsTable.id, newStudent.id));
  assert.equal((await accessRows(gallery.galleryId)).some((access) => access.studentId === newStudent.id), false);
  const prePublishRows = await accessRows(gallery.galleryId);
  const prePublishAccess = prePublishRows.find((access) => access.studentId === student.id);
  assert(prePublishAccess);
  const prePublishResponse = await request("public", `/api/delivery/${gallery.slug}/access`, {
    method: "POST",
    body: JSON.stringify({ code: storedCredential.code, email: `prepared-${suffix}@example.com` }),
  });
  assert.equal(prePublishResponse.status, 404, "draft access does not validate credentials");
  const afterDraftAttempt = (await accessRows(gallery.galleryId)).find((access) => access.studentId === student.id);
  assert.equal(afterDraftAttempt?.failedAttempts, prePublishAccess.failedAttempts);
  assert.equal(afterDraftAttempt?.lockedUntil, prePublishAccess.lockedUntil);

  await db.insert(studentPhotosTable).values([
    {
      projectId: gallery.projectId, studentId: student.id, fileName: "eligible.jpg",
      fileUrl: "/objects/eligible.jpg", durableObjectPath: "/objects/eligible.jpg",
      mimeType: "image/jpeg", rating: 1, shareWithParents: true,
    },
    {
      projectId: gallery.projectId, studentId: student.id, fileName: "hidden.jpg",
      fileUrl: "/objects/hidden.jpg", durableObjectPath: "/objects/hidden.jpg",
      mimeType: "image/jpeg", rating: 0, shareWithParents: true,
    },
  ]);
  assert.equal((await publish(gallery.projectId)).status, 200);
  const publishedRows = await accessRows(gallery.galleryId);
  const publishedAccess = publishedRows.find((access) => access.studentId === student.id);
  assert(publishedAccess);
  assert.deepEqual({
    hash: publishedAccess.accessCodeHash,
    encrypted: publishedAccess.accessCodeEncrypted,
    last4: publishedAccess.accessCodeLast4,
    code: decryptStorageValue<string>(publishedAccess.accessCodeEncrypted),
  }, storedCredential);
  assert.equal((await invitationRows(gallery.galleryId)).length, 1, "publication owns invitation enqueue/send");

  const accessResponse = await request("public", `/api/delivery/${gallery.slug}/access`, {
    method: "POST",
    body: JSON.stringify({ code: storedCredential.code, email: `prepared-${suffix}@example.com` }),
  });
  assert.equal(accessResponse.status, 200);
  const accessToken = (await json<{ token: string }>(accessResponse)).token;
  const contentResponse = await request("public", `/api/delivery/${gallery.slug}/gallery`, {
    headers: { "x-delivery-token": accessToken },
  });
  assert.equal(contentResponse.status, 200);
  const content = await json<{ photos: Array<{ fileName: string }> }>(contentResponse);
  assert.deepEqual(content.photos.map((photo) => photo.fileName), ["eligible.jpg"]);

  const revoked = await request(ownerUserId, `/api/projects/${gallery.projectId}/delivery/revoke`, { method: "POST" });
  assert.equal(revoked.status, 200);
  const revokedAccess = await request("public", `/api/delivery/${gallery.slug}/access`, {
    method: "POST",
    body: JSON.stringify({ code: storedCredential.code, email: `prepared-${suffix}@example.com` }),
  });
  assert.equal(revokedAccess.status, 404);
});

test("Release 6 fresh lifecycle bootstraps one gallery through real project/import APIs", async () => {
  process.env.NODE_ENV = "test";
  process.env.PUBLIC_APP_URL = "https://gallery.test";
  const project = await createProjectThroughApi();
  // Normal project creation creates a draft gallery. Removing it models a
  // legacy project without changing the project through a test-only shortcut.
  await db.delete(deliveryGalleriesTable).where(eq(deliveryGalleriesTable.projectId, project.id));
  await importRosterThroughApi(project.id, "Original Class", [["Ada", "Lovelace", "EXT-RELEASE6-1"], ["Grace", "Hopper", "EXT-RELEASE6-2"]]);

  const [first, second] = await Promise.all([prepare(project.id), prepare(project.id)]);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  const firstBody = await json<{
    gallery: { id: number; status: string; slug: string };
    preparedCount: number;
    cards: Array<{ studentId: number; accessCode: string; qrUrl: string }>;
  }>(first);
  const secondBody = await json<typeof firstBody>(second);
  assert.equal(firstBody.gallery.status, "draft");
  assert.equal(firstBody.preparedCount, 2);
  assert.deepEqual(
    firstBody.cards.map((card) => ({ studentId: card.studentId, accessCode: card.accessCode, qrUrl: card.qrUrl }))
      .sort((a, b) => a.studentId - b.studentId),
    secondBody.cards.map((card) => ({ studentId: card.studentId, accessCode: card.accessCode, qrUrl: card.qrUrl }))
      .sort((a, b) => a.studentId - b.studentId),
  );
  const galleries = await db.select().from(deliveryGalleriesTable).where(eq(deliveryGalleriesTable.projectId, project.id));
  assert.equal(galleries.length, 1);
  const accesses = await accessRows(galleries[0]!.id);
  assert.equal(accesses.length, 2);

  const originalRows = new Map((await db.select().from(studentsTable).where(eq(studentsTable.projectId, project.id)))
    .map((student) => [student.generatedStudentId, student]));
  const originalCredentials = new Map(accesses.map((access) => [
    access.studentId,
    {
      hash: access.accessCodeHash,
      encrypted: access.accessCodeEncrypted,
      last4: access.accessCodeLast4,
    },
  ]));
  await importRosterThroughApi(project.id, "Moved Class", [["Ada Updated", "Lovelace", "EXT-RELEASE6-1"], ["Grace", "Hopper", "EXT-RELEASE6-2"]]);
  const reprepare = await prepare(project.id);
  assert.equal(reprepare.status, 200);
  const afterImport = await accessRows(galleries[0]!.id);
  for (const access of afterImport) {
    assert.deepEqual({
      hash: access.accessCodeHash,
      encrypted: access.accessCodeEncrypted,
      last4: access.accessCodeLast4,
    }, originalCredentials.get(access.studentId));
  }
  const movedStudents = await db.select({
    student: studentsTable,
    className: classesTable.className,
  }).from(studentsTable).innerJoin(classesTable, eq(studentsTable.classId, classesTable.id))
    .where(eq(studentsTable.projectId, project.id));
  assert.equal(movedStudents.length, originalRows.size);
  assert.equal(movedStudents.every((row) => row.className === "Moved Class"), true);
  assert.equal(movedStudents.find((row) => row.student.generatedStudentId === "EXT-RELEASE6-1")?.student.firstName, "Ada Updated");

  const otherProject = await createProjectThroughApi();
  await db.delete(deliveryGalleriesTable).where(eq(deliveryGalleriesTable.projectId, otherProject.id));
  await importRosterThroughApi(otherProject.id, "Other Project Class", [["Ada", "Lovelace", "EXT-RELEASE6-1"]]);
  const otherPrepare = await prepare(otherProject.id);
  assert.equal(otherPrepare.status, 200);
  const otherGallery = (await db.select().from(deliveryGalleriesTable).where(eq(deliveryGalleriesTable.projectId, otherProject.id)))[0];
  assert(otherGallery);
  const otherAccess = (await accessRows(otherGallery.id))[0];
  assert(otherAccess);
  const movedAccess = (await accessRows(galleries[0]!.id)).find((access) => access.studentId === movedStudents[0]!.student.id);
  assert(movedAccess);
  assert.notEqual(otherAccess.id, movedAccess.id);
  assert.notEqual(otherAccess.studentId, movedAccess.studentId, "the same external roster ID remains project-scoped");
  assert.notEqual(otherAccess.accessCodeHash, movedAccess.accessCodeHash, "the other project receives its own credential");

  const revokedGallery = await db.insert(deliveryGalleriesTable).values({
    projectId: otherProject.id,
    studioId,
    slug: `revoked-${suffix}-${apiProjectSequence}`,
    status: "revoked",
  }).onConflictDoNothing().returning({ id: deliveryGalleriesTable.id });
  assert.equal(revokedGallery.length, 0, "the existing draft gallery remains the sole gallery");
  await db.update(deliveryGalleriesTable).set({ status: "revoked" }).where(eq(deliveryGalleriesTable.id, otherGallery.id));
  const revokedPrepare = await prepare(otherProject.id);
  assert.equal(revokedPrepare.status, 409);
});

test("access-card URLs reject invalid or non-HTTPS production configuration clearly", async () => {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousPublicAppUrl = process.env.PUBLIC_APP_URL;
  try {
    process.env.NODE_ENV = "production";
    process.env.PUBLIC_APP_URL = "http://spoofed.example";
    const gallery = await createGallery("school", [
      { firstName: "URL", lastName: "Validation", email: `url-validation-${suffix}@example.com` },
    ]);
    const response = await request(ownerUserId, `/api/projects/${gallery.projectId}/delivery/access-cards`);
    assert.equal(response.status, 500);
    const body = await json<{ error: string }>(response);
    assert.match(body.error, /HTTPS/i);
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previousPublicAppUrl === undefined) delete process.env.PUBLIC_APP_URL;
    else process.env.PUBLIC_APP_URL = previousPublicAppUrl;
  }
});

test("canonical path prefix is preserved exactly once for cards and transactional invitations", async () => {
  const previousPublicAppUrl = process.env.PUBLIC_APP_URL;
  const canonicalUrl = "https://gallery.test/volume-capture";
  try {
    process.env.PUBLIC_APP_URL = `${canonicalUrl}/`;
    fakeMode = "success";
    const gallery = await createGallery("school", [
      { firstName: "Prefixed", lastName: "Student", email: `prefixed-${suffix}@example.com` },
    ]);
    const prepared = await prepare(gallery.projectId);
    assert.equal(prepared.status, 200);
    const body = await json<{
      cards: Array<{ accessCode: string; accessUrl: string; qrUrl: string }>;
    }>(prepared);
    const card = body.cards[0];
    assert(card);
    assert.equal(card.accessUrl, `${canonicalUrl}/delivery/${gallery.slug}`);
    assert.equal(card.qrUrl, `${canonicalUrl}/delivery/${gallery.slug}#code=${card.accessCode}`);
    assert.equal((card.accessUrl.match(/\/volume-capture\//g) ?? []).length, 1);
    assert.equal((card.qrUrl.match(/\/volume-capture\//g) ?? []).length, 1);

    const requestCountBefore = requests.length;
    assert.equal((await publish(gallery.projectId)).status, 200);
    assert.equal(requests.length, requestCountBefore + 1);
    const providerRequest = requests.at(-1);
    assert(providerRequest);
    const message = providerRequest.batch[0];
    assert(message);
    const serialized = JSON.stringify(message);
    assert.equal(serialized.includes(`${canonicalUrl}/delivery/${gallery.slug}`), true);
    assert.equal(
      serialized.split("/volume-capture/delivery").length - 1,
      2,
      "text and HTML links each preserve one prefix",
    );
    assert.equal(serialized.includes("/volume-capture/volume-capture/"), false);
  } finally {
    if (previousPublicAppUrl === undefined) delete process.env.PUBLIC_APP_URL;
    else process.env.PUBLIC_APP_URL = previousPublicAppUrl;
  }
});

test("malformed canonical URL prevents transactional invitation provider calls", async () => {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousPublicAppUrl = process.env.PUBLIC_APP_URL;
  const previousResendApiBaseUrl = process.env.RESEND_API_BASE_URL;
  try {
    process.env.NODE_ENV = "test";
    process.env.PUBLIC_APP_URL = "https://[";
    process.env.RESEND_API_BASE_URL = resendBaseUrl;
    fakeMode = "success";
    const gallery = await createGallery("school", [
      { firstName: "Invalid", lastName: "URL", email: `invalid-url-${suffix}@example.com` },
    ]);
    const requestCountBefore = requests.length;
    assert.equal((await publish(gallery.projectId)).status, 200);
    assert.equal(requests.length, requestCountBefore);
    const [invitation] = await invitationRows(gallery.galleryId);
    assert.equal(invitation.status, "needs_review");
    assert.match(invitation.lastError ?? "", /could not be prepared/i);
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previousPublicAppUrl === undefined) delete process.env.PUBLIC_APP_URL;
    else process.env.PUBLIC_APP_URL = previousPublicAppUrl;
    if (previousResendApiBaseUrl === undefined) delete process.env.RESEND_API_BASE_URL;
    else process.env.RESEND_API_BASE_URL = previousResendApiBaseUrl;
  }
});