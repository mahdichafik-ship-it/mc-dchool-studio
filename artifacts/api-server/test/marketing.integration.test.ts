import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import test, { after, before } from "node:test";
import express from "express";
import { eq } from "drizzle-orm";
import {
  classesTable,
  db,
  deliveryAccessesTable,
  deliveryGalleriesTable,
  marketingContactsTable,
  marketingVisitsTable,
  pool,
  projectsTable,
  studioMembersTable,
  studiosTable,
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
let baseUrl: string;
let studioId: number;
let otherStudioId: number;
let galleryId: number;
let accessId: number;

process.env.SESSION_SECRET = "marketing-integration-secret-that-is-at-least-32-bytes";

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
  return gallery.slug;
});

after(async () => {
  if (otherStudioId) await db.delete(studiosTable).where(eq(studiosTable.id, otherStudioId));
  if (studioId) await db.delete(studiosTable).where(eq(studiosTable.id, studioId));
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await pool.end();
});

test("requires email and records consent plus append-only repeat visits", async () => {
  const slug = `marketing-${suffix}`;
  const first = await request("public", `/api/delivery/${slug}/access`, {
    method: "POST",
    body: JSON.stringify({ code: accessCode, email: "Lead@Example.com", marketingConsent: true }),
  });
  assert.equal(first.status, 200);
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
  const draft = await json<{ status: string; recipientCount: number; templateId: number }>(campaign);
  assert.equal(draft.status, "draft");
  assert.equal(draft.templateId, template.id);
  assert.equal(draft.recipientCount, 1);
});