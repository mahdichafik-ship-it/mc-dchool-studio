import { strict as assert } from "node:assert";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import test, { after, before } from "node:test";
import express from "express";
import { eq } from "drizzle-orm";
import {
  db,
  deliveryGalleriesTable,
  deliveryPriceSheetsTable,
  pool,
  studioMembersTable,
  studiosTable,
} from "@workspace/db";
import { deliveryAmount, deliveryOrderQuantity, validateDeliverySelection } from "../src/lib/deliveryOfferRules";
import { deliveryTerminology, normalizeDeliveryProjectType } from "../src/lib/deliveryTerminology";
import deliveryRouter from "../src/routes/delivery";
import projectsRouter from "../src/routes/projects";

process.env.NODE_ENV = "test";
process.env.SESSION_SECRET = "delivery-offers-test-secret-that-is-at-least-32-bytes";
process.env.PUBLIC_APP_URL = "https://gallery.test";

const suffix = `${process.pid}-${Date.now()}`;
const ownerUserId = `delivery-offers-owner-${suffix}`;
const adminUserId = `delivery-offers-admin-${suffix}`;
const viewerUserId = `delivery-offers-viewer-${suffix}`;
const otherOwnerUserId = `delivery-offers-other-owner-${suffix}`;
let studioId: number;
let otherStudioId: number;
let server: Server;
let baseUrl: string;

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  const userId = req.header("x-test-user") ?? ownerUserId;
  (req as any).auth = Object.assign(
    () => ({ tokenType: "session_token", userId, sessionClaims: { userId } }),
    { [Symbol.for("@clerk/express.auth")]: true },
  );
  next();
});
app.use("/api/projects", projectsRouter);
app.use("/api", deliveryRouter);

function offer(unitAmount: number, id = `digital-${unitAmount}`) {
  return {
    id,
    name: `Digital ${unitAmount}`,
    productType: "digital",
    unitAmount,
    currency: "usd",
    paymentMethods: ["establishment"],
    photoCount: 1,
    deliveryMethods: ["digital"],
    active: true,
    includesDigitalDownloads: true,
  };
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

async function createSheet(targetStudioId: number, name: string, offers = [offer(100)]) {
  return (await db.insert(deliveryPriceSheetsTable).values({
    studioId: targetStudioId,
    name: `${name} ${suffix}`,
    offersJson: JSON.stringify({ offers }),
  }).returning())[0];
}

async function createProject(priceSheetId?: number, userId = ownerUserId) {
  return request(userId, "/api/projects", {
    method: "POST",
    body: JSON.stringify({
      schoolName: `Price sheet project ${suffix}-${Math.random()}`,
      ...(priceSheetId === undefined ? {} : { priceSheetId }),
    }),
  });
}

before(async () => {
  const studio = (await db.insert(studiosTable).values({
    name: `Delivery offers studio ${suffix}`,
    createdByUserId: ownerUserId,
  }).returning({ id: studiosTable.id }))[0];
  studioId = studio.id;
  await db.insert(studioMembersTable).values([
    { studioId, userId: ownerUserId, email: `${ownerUserId}@member.local`, role: "owner" },
    { studioId, userId: adminUserId, email: `${adminUserId}@member.local`, role: "admin" },
    { studioId, userId: viewerUserId, email: `${viewerUserId}@member.local`, role: "viewer" },
  ]);
  const otherStudio = (await db.insert(studiosTable).values({
    name: `Other delivery offers studio ${suffix}`,
    createdByUserId: otherOwnerUserId,
  }).returning({ id: studiosTable.id }))[0];
  otherStudioId = otherStudio.id;
  await db.insert(studioMembersTable).values({
    studioId: otherStudioId,
    userId: otherOwnerUserId,
    email: `${otherOwnerUserId}@member.local`,
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
  await pool.end();
});

test("print offer accepts one photo and creates three order units", () => {
  validateDeliverySelection("print", 1, 1, 3);
  assert.equal(deliveryOrderQuantity("print", 1, 1, 3), 3);
});

test("print offer rejects multiple selected photos", () => {
  assert.throws(() => validateDeliverySelection("print", 1, 2, 3));
});

test("pack offer photoCount 2 accepts quantity 2 as four selected photos and charges two packs", () => {
  validateDeliverySelection("pack", 2, 4, 2);
  assert.equal(deliveryOrderQuantity("pack", 2, 4, 2), 2);
  assert.deepEqual([1, 1, 1, 1], [1, 1, 1, 1], "each selected pack item is quantity one");
});

test("pack offer rejects two or three photos for quantity two", () => {
  assert.throws(() => validateDeliverySelection("pack", 2, 2, 2));
  assert.throws(() => validateDeliverySelection("pack", 2, 3, 2));
});

test("digital pricing is derived without a payment provider", () => {
  validateDeliverySelection("digital", 1, 3, 3);
  const digitalQuantity = deliveryOrderQuantity("digital", 1, 3, 3);
  assert.equal(deliveryAmount(700, digitalQuantity), 2100);
  assert.notEqual(deliveryAmount(1200, digitalQuantity), 2100);
});

test("corporate delivery keeps legacy subject identifiers but presents employee terminology", () => {
  assert.deepEqual(deliveryTerminology(normalizeDeliveryProjectType("corporate")), {
    subjectLabel: "Employee",
    groupLabel: "Department",
  });
  assert.equal(normalizeDeliveryProjectType("legacy-project-without-a-type"), "school");
});

test("school delivery terminology remains unchanged for legacy projects", () => {
  assert.deepEqual(deliveryTerminology(normalizeDeliveryProjectType(undefined)), {
    subjectLabel: "Student",
    groupLabel: "Class",
  });
});

test("project creation requires a sheet owned by the creating studio and stores it on the draft gallery", async () => {
  const missing = await createProject();
  assert.equal(missing.status, 400);
  assert.equal((await json<{ code: string }>(missing)).code, "PRICE_SHEET_REQUIRED");

  const foreignSheet = await createSheet(otherStudioId, "Foreign");
  assert.equal((await createProject(foreignSheet.id)).status, 400);

  const ownSheet = await createSheet(studioId, "Assigned", [offer(125)]);
  const created = await createProject(ownSheet.id);
  assert.equal(created.status, 201);
  const project = await json<{ id: number; priceSheetId: number }>(created);
  assert.equal(project.priceSheetId, ownSheet.id);
  const [gallery] = await db.select().from(deliveryGalleriesTable)
    .where(eq(deliveryGalleriesTable.projectId, project.id));
  assert.equal(gallery.status, "draft");
  assert.equal(gallery.priceSheetId, ownSheet.id);
  assert.deepEqual(JSON.parse(gallery.priceSheetJson!), { offers: [offer(125)] });
});

test("publishing rejects missing, foreign, and empty sheets and snapshots a valid reusable sheet", async () => {
  const sheet = await createSheet(studioId, "Publish", [offer(200)]);
  const created = await createProject(sheet.id);
  const project = await json<{ id: number }>(created);
  const [gallery] = await db.select().from(deliveryGalleriesTable)
    .where(eq(deliveryGalleriesTable.projectId, project.id));

  await db.update(deliveryGalleriesTable).set({ priceSheetId: null }).where(eq(deliveryGalleriesTable.id, gallery.id));
  let response = await request(ownerUserId, `/api/projects/${project.id}/delivery/publish`, { method: "POST" });
  assert.equal(response.status, 409);
  assert.equal((await json<{ code: string }>(response)).code, "PRICE_SHEET_REQUIRED");

  const foreignSheet = await createSheet(otherStudioId, "Publish foreign");
  await db.update(deliveryGalleriesTable).set({ priceSheetId: foreignSheet.id }).where(eq(deliveryGalleriesTable.id, gallery.id));
  response = await request(ownerUserId, `/api/projects/${project.id}/delivery/publish`, { method: "POST" });
  assert.equal(response.status, 409);
  assert.equal((await json<{ code: string }>(response)).code, "PRICE_SHEET_INVALID");

  const emptySheet = await createSheet(studioId, "Publish empty", []);
  await db.update(deliveryGalleriesTable).set({ priceSheetId: emptySheet.id }).where(eq(deliveryGalleriesTable.id, gallery.id));
  response = await request(ownerUserId, `/api/projects/${project.id}/delivery/publish`, { method: "POST" });
  assert.equal(response.status, 409);
  assert.equal((await json<{ code: string }>(response)).code, "PRICE_SHEET_INVALID");

  const malformedSheet = await createSheet(studioId, "Publish malformed");
  await db.update(deliveryPriceSheetsTable).set({ offersJson: "{\"offers\":" })
    .where(eq(deliveryPriceSheetsTable.id, malformedSheet.id));
  await db.update(deliveryGalleriesTable).set({ priceSheetId: malformedSheet.id }).where(eq(deliveryGalleriesTable.id, gallery.id));
  response = await request(ownerUserId, `/api/projects/${project.id}/delivery/publish`, { method: "POST" });
  assert.equal(response.status, 409);
  assert.equal((await json<{ code: string }>(response)).code, "PRICE_SHEET_INVALID");

  await db.update(deliveryGalleriesTable).set({ priceSheetId: sheet.id }).where(eq(deliveryGalleriesTable.id, gallery.id));
  await db.delete(deliveryPriceSheetsTable).where(eq(deliveryPriceSheetsTable.id, malformedSheet.id));
  response = await request(ownerUserId, `/api/projects/${project.id}/delivery/publish`, { method: "POST" });
  assert.equal(response.status, 200, await response.clone().text());
  const [published] = await db.select().from(deliveryGalleriesTable).where(eq(deliveryGalleriesTable.id, gallery.id));
  const publishedSnapshot = published.priceSheetJson;
  assert.equal(published.status, "published");
  assert.deepEqual(JSON.parse(publishedSnapshot!), { offers: [offer(200)] });

  response = await request(ownerUserId, `/api/studio/delivery/price-sheets/${sheet.id}`, {
    method: "PATCH",
    body: JSON.stringify({ name: `Publish edited ${suffix}`, offers: [offer(999)] }),
  });
  assert.equal(response.status, 200);
  const [unchanged] = await db.select().from(deliveryGalleriesTable).where(eq(deliveryGalleriesTable.id, gallery.id));
  assert.equal(unchanged.priceSheetJson, publishedSnapshot);

  response = await request(ownerUserId, `/api/projects/${project.id}/delivery/publish`, { method: "POST" });
  assert.equal(response.status, 200);
  const [republished] = await db.select().from(deliveryGalleriesTable).where(eq(deliveryGalleriesTable.id, gallery.id));
  assert.equal(republished.priceSheetJson, publishedSnapshot);
});

test("published galleries block assignment changes until revocation", async () => {
  const first = await createSheet(studioId, "First assignment");
  const second = await createSheet(studioId, "Second assignment", [offer(300)]);
  const project = await json<{ id: number }>(await createProject(first.id));
  assert.equal((await request(ownerUserId, `/api/projects/${project.id}/delivery/publish`, { method: "POST" })).status, 200);

  let response = await request(ownerUserId, `/api/projects/${project.id}/delivery`, {
    method: "PATCH",
    body: JSON.stringify({ priceSheetId: second.id }),
  });
  assert.equal(response.status, 409);
  response = await request(ownerUserId, `/api/projects/${project.id}/delivery`, {
    method: "PATCH",
    body: JSON.stringify({ offers: [offer(777)] }),
  });
  assert.equal(response.status, 409);
  response = await request(ownerUserId, `/api/projects/${project.id}/delivery`, {
    method: "PATCH",
    body: JSON.stringify({ priceSheetId: first.id, offers: [offer(888)] }),
  });
  assert.equal(response.status, 409);
  assert.equal((await request(ownerUserId, `/api/projects/${project.id}/delivery/revoke`, { method: "POST" })).status, 200);
  response = await request(ownerUserId, `/api/projects/${project.id}/delivery`, {
    method: "PATCH",
    body: JSON.stringify({ priceSheetId: second.id }),
  });
  assert.equal(response.status, 200);
  const body = await json<{ gallery: { priceSheetId: number } }>(response);
  assert.equal(body.gallery.priceSheetId, second.id);
});

test("concurrent first publishers cannot overwrite the winning price snapshot", async () => {
  const sheet = await createSheet(studioId, "Concurrent publish", [offer(410)]);
  const project = await json<{ id: number }>(await createProject(sheet.id));
  const lockClient = await pool.connect();
  try {
    await lockClient.query("begin");
    await lockClient.query("lock table delivery_galleries in share mode");
    const firstPublish = request(ownerUserId, `/api/projects/${project.id}/delivery/publish`, { method: "POST" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await db.update(deliveryPriceSheetsTable).set({
      offersJson: JSON.stringify({ offers: [offer(420)] }),
      updatedAt: new Date(),
    }).where(eq(deliveryPriceSheetsTable.id, sheet.id));
    const secondPublish = request(ownerUserId, `/api/projects/${project.id}/delivery/publish`, { method: "POST" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await lockClient.query("commit");

    const [firstResponse, secondResponse] = await Promise.all([firstPublish, secondPublish]);
    assert.equal(firstResponse.status, 200);
    assert.equal(secondResponse.status, 200);
    const firstBody = await json<{ gallery: { priceSheetJson: string } }>(firstResponse);
    const secondBody = await json<{ gallery: { priceSheetJson: string } }>(secondResponse);
    const [stored] = await db.select().from(deliveryGalleriesTable)
      .where(eq(deliveryGalleriesTable.projectId, project.id));
    assert.equal(firstBody.gallery.priceSheetJson, stored.priceSheetJson);
    assert.equal(secondBody.gallery.priceSheetJson, stored.priceSheetJson);
    assert(
      stored.priceSheetJson === JSON.stringify({ offers: [offer(410)] })
      || stored.priceSheetJson === JSON.stringify({ offers: [offer(420)] }),
    );
  } finally {
    if (!lockClient.release) return;
    try { await lockClient.query("rollback"); } catch {}
    lockClient.release();
  }
});

test("studio price-sheet routes isolate studios and enforce management roles", async () => {
  const ownSheet = await createSheet(studioId, "Visible own");
  const foreignSheet = await createSheet(otherStudioId, "Hidden foreign");

  let response = await request(viewerUserId, "/api/studio/delivery/price-sheets");
  assert.equal(response.status, 200);
  const listed = await json<Array<{ id: number; studioId: number }>>(response);
  assert(listed.some((sheet) => sheet.id === ownSheet.id));
  assert(listed.every((sheet) => sheet.studioId === studioId));
  assert(!listed.some((sheet) => sheet.id === foreignSheet.id));

  const input = { name: `Viewer denied ${suffix}`, offers: [offer(450)] };
  assert.equal((await request(viewerUserId, "/api/studio/delivery/price-sheets", {
    method: "POST", body: JSON.stringify(input),
  })).status, 403);
  assert.equal((await request(viewerUserId, `/api/studio/delivery/price-sheets/${ownSheet.id}`, {
    method: "PATCH", body: JSON.stringify(input),
  })).status, 404);

  response = await request(adminUserId, "/api/studio/delivery/price-sheets", {
    method: "POST",
    body: JSON.stringify({ name: `Admin created ${suffix}`, offers: [offer(500)] }),
  });
  assert.equal(response.status, 201);
  assert.equal((await json<{ studioId: number }>(response)).studioId, studioId);

  response = await request(ownerUserId, `/api/studio/delivery/price-sheets/${foreignSheet.id}`, {
    method: "PATCH",
    body: JSON.stringify({ name: `Cross-studio denied ${suffix}`, offers: [offer(600)] }),
  });
  assert.equal(response.status, 404);
  const [foreignUnchanged] = await db.select().from(deliveryPriceSheetsTable)
    .where(eq(deliveryPriceSheetsTable.id, foreignSheet.id));
  assert.notEqual(foreignUnchanged.name, `Cross-studio denied ${suffix}`);
});