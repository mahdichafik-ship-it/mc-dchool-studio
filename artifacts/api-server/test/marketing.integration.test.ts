import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import test, { after, before } from "node:test";
import express from "express";
import { eq } from "drizzle-orm";
import {
  classesTable,
  captureFilesTable,
  capturesTable,
  db,
  deliveryAccessesTable,
  deliveryGalleriesTable,
  deliveryPriceSheetsTable,
  marketingCampaignRecipientsTable,
  marketingCampaignsTable,
  marketingContactsTable,
  marketingVisitsTable,
  pool,
  projectsTable,
  studioMembersTable,
  studiosTable,
  studentPhotosTable,
  studentsTable,
} from "@workspace/db";
import deliveryRouter from "../src/routes/delivery";
import marketingRouter from "../src/routes/marketing";
import { encryptStorageValue } from "../src/lib/storageCrypto";

const suffix = `${process.pid}-${Date.now()}`;
const ownerUserId = `marketing-owner-${suffix}`;
const adminUserId = `marketing-admin-${suffix}`;
const viewerUserId = `marketing-viewer-${suffix}`;
const otherOwnerUserId = `marketing-other-${suffix}`;
const accessCode = "MKTTEST1";
const app = express();
let server: Server;
let resendServer: Server;
let baseUrl: string;
let resendBaseUrl: string;
const resendBatches: Array<Array<Record<string, unknown>>> = [];
let resendResponseMode: "success" | "incomplete" = "success";
let studioId: number;
let otherStudioId: number;
let galleryId: number;
let accessId: number;
let projectId: number;
let studentId: number;

process.env.SESSION_SECRET = "marketing-integration-secret-that-is-at-least-32-bytes";
process.env.RESEND_API_KEY = "re_test_marketing";
process.env.RESEND_FROM_EMAIL = "Volume Capture <test@volume.example>";

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
app.use("/api", marketingRouter);

function hashCode(code: string): string {
  return createHash("sha256").update(code.trim().toUpperCase()).digest("hex");
}

async function request(userId: string, pathname: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("x-test-user", userId);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  return fetch(`${baseUrl}${pathname}`, { ...init, headers });
}

async function json<T>(response: Response): Promise<T> {
  return response.json() as Promise<T>;
}

before(async () => {
  resendServer = createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/emails/batch") {
      res.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const batch = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Array<Record<string, unknown>>;
    resendBatches.push(batch);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      data: resendResponseMode === "success" ? batch.map((_, index) => ({ id: `email_test_${index}` })) : [],
    }));
  });
  resendServer.listen(0, "127.0.0.1");
  await once(resendServer, "listening");
  const resendAddress = resendServer.address();
  assert(resendAddress && typeof resendAddress !== "string");
  resendBaseUrl = `http://127.0.0.1:${resendAddress.port}`;
  process.env.RESEND_API_BASE_URL = resendBaseUrl;

  const [studio] = await db.insert(studiosTable).values({
    name: `Marketing Studio ${suffix}`,
    createdByUserId: ownerUserId,
  }).returning({ id: studiosTable.id });
  studioId = studio.id;
  const [otherStudio] = await db.insert(studiosTable).values({
    name: `Other Marketing Studio ${suffix}`,
    createdByUserId: otherOwnerUserId,
  }).returning({ id: studiosTable.id });
  otherStudioId = otherStudio.id;
  await db.insert(studioMembersTable).values([
    { studioId, userId: ownerUserId, email: `${ownerUserId}@member.local`, role: "owner" },
    { studioId, userId: adminUserId, email: `${adminUserId}@member.local`, role: "admin" },
    { studioId, userId: viewerUserId, email: `${viewerUserId}@member.local`, role: "viewer" },
    { studioId: otherStudioId, userId: otherOwnerUserId, email: `${otherOwnerUserId}@member.local`, role: "owner" },
  ]);
  const [project] = await db.insert(projectsTable).values({
    userId: ownerUserId,
    studioId,
    schoolName: `Marketing Project ${suffix}`,
    projectType: "corporate",
  }).returning({ id: projectsTable.id });
  projectId = project.id;
  const [studentClass] = await db.insert(classesTable).values({
    projectId: project.id,
    className: `Marketing Department ${suffix}`,
  }).returning({ id: classesTable.id });
  const [student] = await db.insert(studentsTable).values({
    projectId: project.id,
    classId: studentClass.id,
    firstName: "Marketing",
    lastName: "Contact",
    generatedStudentId: `MKT-${suffix}`,
  }).returning({ id: studentsTable.id });
  studentId = student.id;
  const [gallery] = await db.insert(deliveryGalleriesTable).values({
    projectId: project.id,
    studioId,
    slug: `marketing-${suffix}`,
    status: "published",
  }).returning({ id: deliveryGalleriesTable.id, slug: deliveryGalleriesTable.slug });
  galleryId = gallery.id;
  const [access] = await db.insert(deliveryAccessesTable).values({
    galleryId,
    studentId: student.id,
    accessCodeHash: hashCode(accessCode),
    accessCodeEncrypted: encryptStorageValue(accessCode),
    accessCodeLast4: accessCode.slice(-4),
  }).returning({ id: deliveryAccessesTable.id });
  accessId = access.id;
  server = createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  baseUrl = `http://127.0.0.1:${address.port}`;
  process.env.PUBLIC_APP_URL = baseUrl;
  return gallery.slug;
});

after(async () => {
  if (otherStudioId) await db.delete(studiosTable).where(eq(studiosTable.id, otherStudioId));
  if (studioId) await db.delete(studiosTable).where(eq(studiosTable.id, studioId));
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await new Promise<void>((resolve, reject) => resendServer.close((error) => error ? reject(error) : resolve()));
  await pool.end();
});

test("requires email and records consent plus append-only repeat visits", async () => {
  const slug = `marketing-${suffix}`;
  const first = await request("public", `/api/delivery/${slug}/access`, {
    method: "POST",
    body: JSON.stringify({ code: accessCode, email: "Lead@Example.com", marketingConsent: true }),
  });
  assert.equal(first.status, 200);
  const firstToken = (await json<{ token: string }>(first)).token;
  const corporateGallery = await request("public", `/api/delivery/${slug}/gallery`, {
    headers: { "x-delivery-token": firstToken },
  });
  assert.equal(corporateGallery.status, 200);
  const corporateContent = await json<{
    gallery: { projectType: string; subjectLabel: string; groupLabel: string };
    subject: {
      displayName: string;
      label: string;
      organizationName: string;
      groupLabel: string;
      groupName: string;
    };
  }>(corporateGallery);
  assert.deepEqual(corporateContent.gallery, {
    projectType: "corporate",
    subjectLabel: "Employee",
    groupLabel: "Department",
    slug,
    status: "published",
    expiresAt: null,
    studio: {
      name: `Marketing Studio ${suffix}`,
      tagline: "Private photo delivery",
      primaryColor: "#0F766E",
      accentColor: "#14B8A6",
    },
  });
  assert.deepEqual(corporateContent.subject, {
    firstName: "Marketing",
    lastName: "Contact",
    displayName: "Marketing Contact",
    label: "Employee",
    organizationName: `Marketing Project ${suffix}`,
    groupLabel: "Department",
    groupName: `Marketing Department ${suffix}`,
  });
  const repeat = await request("public", `/api/delivery/${slug}/access`, {
    method: "POST",
    body: JSON.stringify({ code: accessCode, email: " lead@example.com ", marketingConsent: true }),
  });
  assert.equal(repeat.status, 200);
  const [contact] = await db.select().from(marketingContactsTable)
    .where(eq(marketingContactsTable.email, "lead@example.com"));
  assert(contact);
  assert.equal(contact.marketingConsent, true);
  assert(contact.consentAt);
  assert.equal(contact.successfulGalleryAccesses, 2);
  const visits = await db.select().from(marketingVisitsTable)
    .where(eq(marketingVisitsTable.contactId, contact.id));
  assert.equal(visits.length, 2);
  assert.deepEqual(visits.map((visit) => [visit.galleryId, visit.accessId, visit.projectId]), [
    [galleryId, accessId, visits[0].projectId],
    [galleryId, accessId, visits[0].projectId],
  ]);
});

test("invalid and wrong codes do not create contacts", async () => {
  const slug = `marketing-${suffix}`;
  const malformedEmail = await request("public", `/api/delivery/${slug}/access`, {
    method: "POST",
    body: JSON.stringify({ code: accessCode, email: "not-an-email" }),
  });
  assert.equal(malformedEmail.status, 400);
  const wrongCode = await request("public", `/api/delivery/${slug}/access`, {
    method: "POST",
    body: JSON.stringify({ code: "WRONG123", email: "wrong@example.com" }),
  });
  assert.equal(wrongCode.status, 401);
  const [contact] = await db.select().from(marketingContactsTable)
    .where(eq(marketingContactsTable.email, "wrong@example.com"));
  assert.equal(contact, undefined);
});

test("owner/admin can read isolated overview and contacts, while viewer and other studio cannot", async () => {
  for (const userId of [ownerUserId, adminUserId]) {
    const overviewResponse = await request(userId, "/api/marketing/overview");
    assert.equal(overviewResponse.status, 200);
    const overview = await json<{
      uniqueContacts: number;
      perProject: { projectName: string; projectType: string }[];
    }>(overviewResponse);
    assert.equal(overview.uniqueContacts, 1);
    assert.equal(overview.perProject[0].projectName, `Marketing Project ${suffix}`);
    assert.equal(overview.perProject[0].projectType, "corporate");
    const contactsResponse = await request(userId, "/api/marketing/contacts");
    assert.equal(contactsResponse.status, 200);
    const contacts = await json<{ total: number; contacts: { email: string }[] }>(contactsResponse);
    assert.equal(contacts.total, 1);
    assert.equal(contacts.contacts[0].email, "lead@example.com");
  }
  assert.equal((await request(viewerUserId, "/api/marketing/overview")).status, 403);
  assert.equal((await request(viewerUserId, "/api/marketing/contacts")).status, 403);
  const otherOverview = await request(otherOwnerUserId, "/api/marketing/overview");
  assert.equal(otherOverview.status, 200);
  assert.equal((await json<{ uniqueContacts: number }>(otherOverview)).uniqueContacts, 0);
  const otherContacts = await request(otherOwnerUserId, "/api/marketing/contacts");
  assert.equal(otherContacts.status, 200);
  assert.equal((await json<{ total: number }>(otherContacts)).total, 0);
});

test("template CRUD returns direct OpenAPI objects and campaign previews only eligible recipients", async () => {
  const slug = `marketing-${suffix}`;
  await request("public", `/api/delivery/${slug}/access`, {
    method: "POST",
    body: JSON.stringify({ code: accessCode, email: "unconsented@example.com" }),
  });
  await request("public", `/api/delivery/${slug}/access`, {
    method: "POST",
    body: JSON.stringify({ code: accessCode, email: "unsubscribed@example.com", marketingConsent: true }),
  });
  const contacts = await db.select().from(marketingContactsTable);
  const unsubscribed = contacts.find((contact) => contact.email === "unsubscribed@example.com");
  assert(unsubscribed);
  const unsubscribe = await request(ownerUserId, `/api/marketing/contacts/${unsubscribed.id}/unsubscribe`, { method: "POST" });
  assert.equal(unsubscribe.status, 200);

  const create = await request(ownerUserId, "/api/marketing/templates", {
    method: "POST",
    body: JSON.stringify({ name: "Welcome", subject: "Hello", bodyText: "Welcome!", category: "welcome" }),
  });
  assert.equal(create.status, 201);
  const created = await json<{ id: number; studioId: number; name: string }>(create);
  assert.equal(created.name, "Welcome");
  const update = await request(ownerUserId, `/api/marketing/templates/${created.id}`, {
    method: "PATCH",
    body: JSON.stringify({ name: "Welcome updated", subject: "Hi", bodyText: "Updated", category: "welcome" }),
  });
  assert.equal(update.status, 200);
  assert.equal((await json<{ id: number; name: string }>(update)).name, "Welcome updated");
  const list = await request(ownerUserId, "/api/marketing/templates");
  assert.equal(list.status, 200);
  assert((await json<{ id: number }[]>(list)).some((template) => template.id === created.id));
  const deleted = await request(ownerUserId, `/api/marketing/templates/${created.id}`, { method: "DELETE" });
  assert.equal(deleted.status, 204);

  const campaignTemplate = await request(ownerUserId, "/api/marketing/templates", {
    method: "POST",
    body: JSON.stringify({ name: "Campaign", subject: "News", bodyText: "News", category: "news" }),
  });
  const template = await json<{ id: number }>(campaignTemplate);
  const campaign = await request(ownerUserId, "/api/marketing/campaigns", {
    method: "POST",
    body: JSON.stringify({ name: "Eligible contacts", templateId: template.id }),
  });
  assert.equal(campaign.status, 201);
  const draft = await json<{ id: number; status: string; recipientCount: number; templateId: number }>(campaign);
  assert.equal(draft.status, "draft");
  assert.equal(draft.templateId, template.id);
  assert.equal(draft.recipientCount, 1);

  const emailStatus = await request(ownerUserId, "/api/marketing/email-status");
  assert.equal(emailStatus.status, 200);
  assert.deepEqual(await json(emailStatus), {
    configured: true,
    fromEmail: "Volume Capture <test@volume.example>",
  });
  assert.equal((await request(viewerUserId, "/api/marketing/email-status")).status, 403);

  process.env.RESEND_FROM_EMAIL = "Volume Capture <onboarding@resend.dev>";
  const onboardingSend = await request(ownerUserId, `/api/marketing/campaigns/${draft.id}/send`, { method: "POST" });
  assert.equal(onboardingSend.status, 503);
  assert.equal(resendBatches.length, 0);
  process.env.RESEND_FROM_EMAIL = "Volume Capture <test@volume.example>";

  const sent = await request(ownerUserId, `/api/marketing/campaigns/${draft.id}/send`, { method: "POST" });
  assert.equal(sent.status, 200);
  const result = await json<{ campaign: { status: string; sentCount: number; sentAt: string }; sentCount: number }>(sent);
  assert.equal(result.sentCount, 1);
  assert.equal(result.campaign.status, "sent");
  assert.equal(result.campaign.sentCount, 1);
  assert(result.campaign.sentAt);
  assert.equal(resendBatches.length, 1);
  assert.equal(resendBatches[0].length, 1);
  assert.deepEqual(resendBatches[0][0].to, ["lead@example.com"]);
  assert.equal(resendBatches[0][0].from, "Volume Capture <test@volume.example>");
  assert.equal(resendBatches[0][0].subject, "News");
  assert(!JSON.stringify(resendBatches).includes("unconsented@example.com"));
  assert(!JSON.stringify(resendBatches).includes("unsubscribed@example.com"));
  const [ledgerEntry] = await db.select().from(marketingCampaignRecipientsTable)
    .where(eq(marketingCampaignRecipientsTable.campaignId, draft.id));
  assert.equal(ledgerEntry.status, "sent");
  assert.equal(ledgerEntry.providerEmailId, "email_test_0");

  const headers = resendBatches[0][0].headers as Record<string, string>;
  const unsubscribeHeader = headers["List-Unsubscribe"];
  assert(unsubscribeHeader?.startsWith("<") && unsubscribeHeader.endsWith(">"));
  const unsubscribeUrl = unsubscribeHeader.slice(1, -1);
  const unsubscribeResponse = await fetch(unsubscribeUrl);
  assert.equal(unsubscribeResponse.status, 200);
  const [leadBeforeConfirmation] = await db.select().from(marketingContactsTable)
    .where(eq(marketingContactsTable.email, "lead@example.com"));
  assert.equal(leadBeforeConfirmation.unsubscribedAt, null);
  const confirmedUnsubscribe = await fetch(unsubscribeUrl, { method: "POST" });
  assert.equal(confirmedUnsubscribe.status, 204);
  const [lead] = await db.select().from(marketingContactsTable)
    .where(eq(marketingContactsTable.email, "lead@example.com"));
  assert(lead.unsubscribedAt);

  const forbiddenReconsent = await request(ownerUserId, `/api/marketing/contacts/${lead.id}/consent`, {
    method: "PATCH",
    body: JSON.stringify({ consented: true, source: "studio_manual" }),
  });
  assert.equal(forbiddenReconsent.status, 409);

  const duplicateSend = await request(ownerUserId, `/api/marketing/campaigns/${draft.id}/send`, { method: "POST" });
  assert.equal(duplicateSend.status, 409);
  assert.equal(resendBatches.length, 1);

  const [uncertainContact] = await db.insert(marketingContactsTable).values({
    studioId,
    email: "uncertain@example.com",
    marketingConsent: true,
    consentAt: new Date(),
    consentSource: "test",
  }).returning();
  const uncertainCampaignResponse = await request(ownerUserId, "/api/marketing/campaigns", {
    method: "POST",
    body: JSON.stringify({ name: "Uncertain delivery", templateId: template.id }),
  });
  const uncertainCampaign = await json<{ id: number }>(uncertainCampaignResponse);
  resendResponseMode = "incomplete";
  const uncertainSend = await request(ownerUserId, `/api/marketing/campaigns/${uncertainCampaign.id}/send`, { method: "POST" });
  assert.equal(uncertainSend.status, 502);
  const [storedUncertainCampaign] = await db.select().from(marketingCampaignsTable)
    .where(eq(marketingCampaignsTable.id, uncertainCampaign.id));
  assert.equal(storedUncertainCampaign.status, "needs_review");
  assert.equal(storedUncertainCampaign.sentCount, 0);
  resendResponseMode = "success";
  assert(uncertainContact.id);
});

test("publishes only delivery-eligible JPEGs and creates access records idempotently", async () => {
  const offersJson = JSON.stringify({
    offers: [{
      id: "digital-single",
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
  const [priceSheet] = await db.insert(deliveryPriceSheetsTable).values({
    studioId,
    name: `Release 2 price sheet ${suffix}`,
    offersJson,
  }).returning({ id: deliveryPriceSheetsTable.id });
  await db.update(deliveryGalleriesTable).set({
    status: "draft",
    priceSheetId: priceSheet.id,
  }).where(eq(deliveryGalleriesTable.id, galleryId));
  await db.insert(studentPhotosTable).values({
    projectId,
    studentId,
    fileName: "selected.raw",
    fileUrl: "/objects/selected.raw",
    durableObjectPath: null,
    mimeType: "image/x-canon-cr2",
    rating: 1,
    shareWithParents: true,
  });
  const [studentClass] = await db.select().from(classesTable)
    .where(eq(classesTable.projectId, projectId)).limit(1);
  const [newSubject] = await db.insert(studentsTable).values({
    projectId,
    classId: studentClass.id,
    firstName: "Concurrent",
    lastName: "Subject",
    generatedStudentId: `MKT-CONCURRENT-${suffix}`,
  }).returning({ id: studentsTable.id });

  const concurrent = await Promise.all([
    request(ownerUserId, `/api/projects/${projectId}/delivery/publish`, { method: "POST" }),
    request(ownerUserId, `/api/projects/${projectId}/delivery/publish`, { method: "POST" }),
  ]);
  assert.deepEqual(concurrent.map((response) => response.status), [200, 200]);
  const publicationTimes = (await Promise.all(concurrent.map((response) =>
    json<{ gallery: { publishedAt: string } }>(response)
  ))).map((response) => response.gallery.publishedAt);
  assert.equal(new Set(publicationTimes).size, 1);
  const accesses = await db.select().from(deliveryAccessesTable)
    .where(eq(deliveryAccessesTable.studentId, newSubject.id));
  assert.equal(accesses.length, 1);

  await db.update(deliveryGalleriesTable).set({ status: "draft" })
    .where(eq(deliveryGalleriesTable.id, galleryId));
  const [capture] = await db.insert(capturesTable).values({
    captureKey: `unready-jpeg-${suffix}`,
    projectId,
    studentId,
    baseFilename: "unready-jpeg",
    rating: 1,
  }).returning({ id: capturesTable.id });
  const [file] = await db.insert(captureFilesTable).values({
    captureId: capture.id,
    fileRole: "JPEG",
    fileFormat: "JPG",
    originalFilename: "unready-jpeg.jpg",
    fileUrl: "/objects/unready-jpeg.jpg",
    durableObjectPath: null,
    mimeType: "image/jpeg",
  }).returning({ id: captureFilesTable.id });
  const blocked = await request(ownerUserId, `/api/projects/${projectId}/delivery/publish`, { method: "POST" });
  assert.equal(blocked.status, 409);
  assert.equal((await json<{ code: string }>(blocked)).code, "PHOTO_STORAGE_INCOMPLETE");

  await db.update(captureFilesTable).set({ durableObjectPath: "/objects/unready-jpeg.jpg" })
    .where(eq(captureFilesTable.id, file.id));
  const published = await request(ownerUserId, `/api/projects/${projectId}/delivery/publish`, { method: "POST" });
  assert.equal(published.status, 200);
});

test("regenerating an access code immediately invalidates existing delivery tokens", async () => {
  const slug = `marketing-${suffix}`;
  const granted = await request("public", `/api/delivery/${slug}/access`, {
    method: "POST",
    body: JSON.stringify({ code: accessCode, email: "token-version@example.com" }),
  });
  assert.equal(granted.status, 200);
  const oldToken = (await json<{ token: string }>(granted)).token;
  const before = await request("public", `/api/delivery/${slug}/gallery`, {
    headers: { "x-delivery-token": oldToken },
  });
  assert.equal(before.status, 200);

  const regenerated = await request(ownerUserId, `/api/projects/${projectId}/delivery/access/${studentId}/regenerate`, {
    method: "POST",
  });
  assert.equal(regenerated.status, 200);
  const newCode = (await json<{ accessCode: string }>(regenerated)).accessCode;

  const expired = await request("public", `/api/delivery/${slug}/gallery`, {
    headers: { "x-delivery-token": oldToken },
  });
  assert.equal(expired.status, 401);
  const refreshed = await request("public", `/api/delivery/${slug}/access`, {
    method: "POST",
    body: JSON.stringify({ code: newCode, email: "token-version@example.com" }),
  });
  assert.equal(refreshed.status, 200);
  const refreshedToken = (await json<{ token: string }>(refreshed)).token;

  const revoked = await request(ownerUserId, `/api/projects/${projectId}/delivery/access/${studentId}`, {
    method: "PATCH",
    body: JSON.stringify({ revoked: true }),
  });
  assert.equal(revoked.status, 200);
  assert.equal((await request("public", `/api/delivery/${slug}/gallery`, {
    headers: { "x-delivery-token": refreshedToken },
  })).status, 401);

  const restored = await request(ownerUserId, `/api/projects/${projectId}/delivery/access/${studentId}`, {
    method: "PATCH",
    body: JSON.stringify({ revoked: false }),
  });
  assert.equal(restored.status, 200);
  assert.equal((await request("public", `/api/delivery/${slug}/gallery`, {
    headers: { "x-delivery-token": refreshedToken },
  })).status, 401);
});

test("throttles repeated unknown access-code attempts", async () => {
  const slug = `marketing-${suffix}`;
  let response: Response | undefined;
  for (let attempt = 0; attempt < 25; attempt += 1) {
    response = await request("public", `/api/delivery/${slug}/access`, {
      method: "POST",
      body: JSON.stringify({ code: `BAD${String(attempt).padStart(5, "0")}`, email: "limited@example.com" }),
    });
    if (response.status === 429) break;
  }
  assert(response);
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "900");
});