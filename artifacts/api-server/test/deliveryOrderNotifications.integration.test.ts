import { strict as assert } from "node:assert";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import test, { after, before } from "node:test";
import { eq } from "drizzle-orm";
import {
  db,
  deliveryGalleriesTable,
  deliveryOrderNotificationsTable,
  deliveryOrdersTable,
  pool,
  projectsTable,
  studiosTable,
} from "@workspace/db";
import {
  deliveryOrderNotificationTestHooks,
  dispatchDeliveryOrderNotifications,
  enqueueDeliveryOrderNotification,
  retryFailedDeliveryOrderNotifications,
} from "../src/lib/deliveryOrderNotifications";

process.env.NODE_ENV = "test";
process.env.SESSION_SECRET = "delivery-order-notification-test-secret-32-bytes";
process.env.RESEND_API_KEY = "re_test_order_notifications";
process.env.RESEND_FROM_EMAIL = "Volume Capture <test@volume.example>";
process.env.PUBLIC_APP_URL = "https://gallery.test";

const suffix = `${process.pid}-${Date.now()}`;
let resendServer: Server;
let studioId: number;
let galleryId: number;
let providerSequence = 0;
let providerMode: "success" | "reject" | "unknown" = "success";
const requests: Array<{ idempotencyKey: string; body: string }> = [];

async function fakeResend(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "POST" || req.url !== "/emails/batch") {
    res.writeHead(404).end();
    return;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  requests.push({
    idempotencyKey: String(req.headers["idempotency-key"] ?? ""),
    body: Buffer.concat(chunks).toString("utf8"),
  });
  if (providerMode === "reject") {
    res.writeHead(422, { "content-type": "application/json" }).end('{"error":"rejected"}');
    return;
  }
  if (providerMode === "unknown") {
    res.writeHead(503, { "content-type": "application/json" }).end('{"error":"unavailable"}');
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ data: [{ id: `order_email_${++providerSequence}` }] }));
}

async function createPendingNotification() {
  const token = randomBytes(32).toString("base64url");
  const reference = `ORDER-${randomBytes(6).toString("hex")}`;
  const email = `parent-${randomBytes(5).toString("hex")}@example.com`;
  const [order] = await db.transaction(async (tx) => {
    const [created] = await tx.insert(deliveryOrdersTable).values({
      galleryId,
      accessId: 1,
      status: "pending",
      paymentMethod: "establishment",
      customerEmail: email,
      amountTotal: 2500,
      currency: "usd",
      publicReference: reference,
      recoveryTokenHash: createHash("sha256").update(token).digest("hex"),
      notificationStatus: "not_sent",
    }).returning();
    await enqueueDeliveryOrderNotification(tx, {
      orderId: created.id,
      eventType: "order_received",
      recipientEmail: email,
      publicReference: reference,
      gallerySlug: `notification-gallery-${suffix}`,
      amountTotal: created.amountTotal,
      currency: created.currency,
      status: created.status,
      instructions: "Pay at the school office.",
      itemSummary: ["Class portrait"],
      recoveryUrl: `https://gallery.test/delivery/test#recoveryToken=${token}`,
      recoveryToken: token,
    });
    return [created];
  });
  const [notification] = await db.select().from(deliveryOrderNotificationsTable)
    .where(eq(deliveryOrderNotificationsTable.orderId, order.id));
  assert(notification);
  return { order, notification, token, email, reference };
}

async function notificationFor(orderId: number) {
  const [row] = await db.select().from(deliveryOrderNotificationsTable)
    .where(eq(deliveryOrderNotificationsTable.orderId, orderId));
  assert(row);
  return row;
}

before(async () => {
  resendServer = createServer((req, res) => void fakeResend(req, res));
  resendServer.listen(0, "127.0.0.1");
  await once(resendServer, "listening");
  const address = resendServer.address();
  assert(address && typeof address !== "string");
  process.env.RESEND_API_BASE_URL = `http://127.0.0.1:${address.port}`;

  const [studio] = await db.insert(studiosTable).values({
    name: `Order notification studio ${suffix}`,
    createdByUserId: `order-notification-owner-${suffix}`,
  }).returning();
  studioId = studio.id;
  const [project] = await db.insert(projectsTable).values({
    userId: `order-notification-owner-${suffix}`,
    studioId,
    schoolName: `Order notification project ${suffix}`,
  }).returning();
  const [gallery] = await db.insert(deliveryGalleriesTable).values({
    projectId: project.id,
    studioId,
    slug: `notification-gallery-${suffix}`,
  }).returning();
  galleryId = gallery.id;
});

after(async () => {
  deliveryOrderNotificationTestHooks.afterProviderAccepted = undefined;
  if (studioId) await db.delete(studiosTable).where(eq(studiosTable.id, studioId));
  await new Promise<void>((resolve, reject) =>
    resendServer.close((error) => error ? reject(error) : resolve()));
  await pool.end();
});

test("a committed notification survives the pre-send restart gap and keeps credentials encrypted", async () => {
  providerMode = "success";
  const start = requests.length;
  const created = await createPendingNotification();
  const serialized = `${created.notification.snapshotEncrypted} ${created.notification.recoveryTokenEncrypted}`;
  assert.equal(serialized.includes(created.email), false);
  assert.equal(serialized.includes(created.token), false);
  assert.equal(serialized.includes(created.reference), false);

  const result = await dispatchDeliveryOrderNotifications(created.order.id);
  assert.equal(result.sent, 1);
  assert.equal(requests.length, start + 1);
  assert.equal((await notificationFor(created.order.id)).status, "sent");
  const [order] = await db.select().from(deliveryOrdersTable)
    .where(eq(deliveryOrdersTable.id, created.order.id));
  assert.equal(order.notificationStatus, "sent");
});

test("a crash after provider acceptance is quarantined and never replayed automatically", async () => {
  providerMode = "success";
  const start = requests.length;
  const created = await createPendingNotification();
  deliveryOrderNotificationTestHooks.afterProviderAccepted = async () => {
    throw new Error("simulated process loss after provider acceptance");
  };
  const first = await dispatchDeliveryOrderNotifications(created.order.id);
  deliveryOrderNotificationTestHooks.afterProviderAccepted = undefined;
  assert.equal(first.needsReview, 1);
  assert.equal(requests.length, start + 1);
  assert.equal((await notificationFor(created.order.id)).status, "needs_review");

  const replay = await dispatchDeliveryOrderNotifications(created.order.id);
  assert.equal(replay.claimed, 0);
  assert.equal(requests.length, start + 1);
});

test("concurrent dispatchers claim a pending notification only once", async () => {
  providerMode = "success";
  const start = requests.length;
  const created = await createPendingNotification();
  const results = await Promise.all([
    dispatchDeliveryOrderNotifications(created.order.id),
    dispatchDeliveryOrderNotifications(created.order.id),
  ]);
  assert.equal(results.reduce((sum, result) => sum + result.claimed, 0), 1);
  assert.equal(requests.length, start + 1);
  assert.equal((await notificationFor(created.order.id)).status, "sent");
});

test("definitive rejection requires explicit retry while uncertain outcomes remain quarantined", async () => {
  providerMode = "reject";
  const rejected = await createPendingNotification();
  assert.equal((await dispatchDeliveryOrderNotifications(rejected.order.id)).failed, 1);
  assert.equal((await notificationFor(rejected.order.id)).status, "failed");
  providerMode = "success";
  assert.equal((await retryFailedDeliveryOrderNotifications(rejected.order.id)).sent, 1);

  providerMode = "unknown";
  const uncertain = await createPendingNotification();
  assert.equal((await dispatchDeliveryOrderNotifications(uncertain.order.id)).needsReview, 1);
  assert.equal((await notificationFor(uncertain.order.id)).status, "needs_review");
  providerMode = "success";
  assert.equal((await retryFailedDeliveryOrderNotifications(uncertain.order.id)).claimed, 0);
});