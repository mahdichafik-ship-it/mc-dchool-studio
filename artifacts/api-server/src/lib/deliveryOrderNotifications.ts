import {
  and,
  asc,
  eq,
  isNull,
  isNotNull,
  lt,
  or,
  sql,
} from "drizzle-orm";
import { createHash, randomBytes } from "node:crypto";
import {
  db,
  deliveryOrderNotificationsTable,
  deliveryOrdersTable,
} from "@workspace/db";
import { decryptStorageValue, encryptStorageValue } from "./storageCrypto";
import { ResendSendError, resendConfigurationStatus, sendResendEmailBatch } from "./resendEmail";
import { logger } from "./logger";

const DISPATCH_BATCH_SIZE = 40;
const CLAIM_STALE_MS = 15 * 60 * 1000;
type DeliveryTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type NotificationEvent = "order_received" | "payment_confirmed";

export type DeliveryOrderNotificationSnapshot = {
  orderId: number;
  eventType: NotificationEvent;
  recipientEmail: string;
  publicReference: string;
  gallerySlug: string;
  amountTotal: number;
  currency: string;
  status: string;
  instructions: string;
  itemSummary: string[];
  recoveryUrl: string;
};

export type EnqueueDeliveryOrderNotificationInput = Omit<
  DeliveryOrderNotificationSnapshot,
  "orderId" | "eventType"
> & {
  orderId: number;
  eventType: NotificationEvent;
  recoveryToken: string;
  ready?: boolean;
};

function snapshotHash(snapshot: DeliveryOrderNotificationSnapshot): string {
  return createHash("sha256").update(JSON.stringify(snapshot), "utf8").digest("hex");
}

function recoveryTokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Enqueue inside the caller's order/payment transaction.  The conflict guard
 * is intentional: snapshots are immutable and a duplicate webhook/manual
 * confirmation must not rewrite an already accepted message.
 */
export async function enqueueDeliveryOrderNotification(
  tx: DeliveryTransaction,
  input: EnqueueDeliveryOrderNotificationInput,
): Promise<void> {
  const { recoveryToken, ready = true, ...snapshot } = input;
  const encryptedSnapshot = encryptStorageValue(snapshot);
  await tx.insert(deliveryOrderNotificationsTable).values({
    orderId: input.orderId,
    eventType: input.eventType,
    status: "pending",
    snapshotEncrypted: encryptedSnapshot,
    snapshotHash: snapshotHash(snapshot),
    recoveryTokenEncrypted: encryptStorageValue(recoveryToken),
    recoveryTokenHash: recoveryTokenHash(recoveryToken),
    attempts: 0,
    claimToken: null,
    claimedAt: null,
    providerId: null,
    sentAt: null,
    snapshotReadyAt: ready ? new Date() : null,
    lastError: null,
  }).onConflictDoNothing({
    target: [
      deliveryOrderNotificationsTable.orderId,
      deliveryOrderNotificationsTable.eventType,
    ],
  });
}

/**
 * Finalizes a deferred snapshot exactly once. Stripe order_received rows are
 * inserted atomically with the order but remain non-dispatchable until the
 * provider attempt has a durable outcome.
 */
export async function finalizeDeliveryOrderNotification(
  tx: DeliveryTransaction,
  input: {
    orderId: number;
    eventType: NotificationEvent;
    status: string;
    instructions: string;
  },
): Promise<boolean> {
  const [row] = await tx.select().from(deliveryOrderNotificationsTable).where(and(
    eq(deliveryOrderNotificationsTable.orderId, input.orderId),
    eq(deliveryOrderNotificationsTable.eventType, input.eventType),
    isNull(deliveryOrderNotificationsTable.snapshotReadyAt),
  )).limit(1);
  if (!row) return false;
  const snapshot = decryptStorageValue<DeliveryOrderNotificationSnapshot>(row.snapshotEncrypted);
  const finalized = { ...snapshot, status: input.status, instructions: input.instructions };
  const [updated] = await tx.update(deliveryOrderNotificationsTable).set({
    snapshotEncrypted: encryptStorageValue(finalized),
    snapshotHash: snapshotHash(finalized),
    snapshotReadyAt: new Date(),
    updatedAt: new Date(),
  }).where(and(
    eq(deliveryOrderNotificationsTable.id, row.id),
    isNull(deliveryOrderNotificationsTable.snapshotReadyAt),
  )).returning({ id: deliveryOrderNotificationsTable.id });
  return Boolean(updated);
}

/**
 * The paid snapshot reuses the encrypted recovery capability from the
 * order_received row.  It is deliberately read within the same transaction
 * as the authoritative paid transition.
 */
export async function enqueuePaymentConfirmedNotification(
  tx: DeliveryTransaction,
  order: Pick<DeliveryOrderNotificationSnapshot, "orderId" | "status" | "instructions">,
): Promise<void> {
  const [received] = await tx.select()
    .from(deliveryOrderNotificationsTable)
    .where(and(
      eq(deliveryOrderNotificationsTable.orderId, order.orderId),
      eq(deliveryOrderNotificationsTable.eventType, "order_received"),
    ))
    .limit(1);
  if (!received) return;
  const base = decryptStorageValue<DeliveryOrderNotificationSnapshot>(received.snapshotEncrypted);
  const recoveryToken = decryptStorageValue<string>(received.recoveryTokenEncrypted);
  await enqueueDeliveryOrderNotification(tx, {
    ...base,
    orderId: order.orderId,
    eventType: "payment_confirmed",
    status: order.status,
    instructions: order.instructions,
    recoveryToken,
  });
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[character] ?? character));
}

async function recoverStaleClaims(orderId?: number): Promise<void> {
  const staleBefore = new Date(Date.now() - CLAIM_STALE_MS);
  await db.update(deliveryOrderNotificationsTable).set({
    status: "needs_review",
    claimToken: null,
    claimedAt: null,
    updatedAt: new Date(),
    lastError: "Provider claim became stale; reconcile before retrying",
  }).where(and(
    eq(deliveryOrderNotificationsTable.status, "sending"),
    ...(orderId === undefined ? [] : [eq(deliveryOrderNotificationsTable.orderId, orderId)]),
    or(
      isNull(deliveryOrderNotificationsTable.claimedAt),
      lt(deliveryOrderNotificationsTable.claimedAt, staleBefore),
    ),
  ));
}

type ClaimedNotification = {
  id: number;
  orderId: number;
  eventType: NotificationEvent;
  claimToken: string;
  attempt: number;
};

async function claimBatch(orderId?: number): Promise<ClaimedNotification[]> {
  return db.transaction(async (tx) => {
    const rows = await tx.select({
      id: deliveryOrderNotificationsTable.id,
      orderId: deliveryOrderNotificationsTable.orderId,
      eventType: deliveryOrderNotificationsTable.eventType,
    }).from(deliveryOrderNotificationsTable)
      .innerJoin(deliveryOrdersTable, eq(deliveryOrdersTable.id, deliveryOrderNotificationsTable.orderId))
      .where(and(
        eq(deliveryOrderNotificationsTable.status, "pending"),
        isNotNull(deliveryOrderNotificationsTable.snapshotReadyAt),
        ...(orderId === undefined ? [] : [eq(deliveryOrderNotificationsTable.orderId, orderId)]),
      ))
      .orderBy(asc(deliveryOrderNotificationsTable.id))
      .limit(DISPATCH_BATCH_SIZE)
      .for("update", { skipLocked: true });
    if (rows.length === 0) return [];
    const now = new Date();
    const claimed = rows.map((row) => ({
      ...row,
      claimToken: randomBytes(24).toString("base64url"),
    }));
    const result: ClaimedNotification[] = [];
    for (const row of claimed) {
      const [updated] = await tx.update(deliveryOrderNotificationsTable).set({
        status: "sending",
        claimToken: row.claimToken,
        claimedAt: now,
        attempts: sql`${deliveryOrderNotificationsTable.attempts} + 1`,
        updatedAt: now,
      }).where(and(
        eq(deliveryOrderNotificationsTable.id, row.id),
        eq(deliveryOrderNotificationsTable.status, "pending"),
      )).returning({ id: deliveryOrderNotificationsTable.id, attempts: deliveryOrderNotificationsTable.attempts });
      if (updated) {
        result.push({
          ...row,
          attempt: updated.attempts,
        });
      }
    }
    return result;
  });
}

function messageFor(
  snapshot: DeliveryOrderNotificationSnapshot,
): { to: string[]; subject: string; text: string; html: string; headers: Record<string, string> } {
  const status = snapshot.status;
  const instructions = snapshot.instructions;
  const summary = snapshot.itemSummary.length > 0
    ? snapshot.itemSummary.map((item) => `- ${item}`).join("\n")
    : "- Order items";
  const amount = (snapshot.amountTotal / 100).toFixed(2);
  const text = [
    `Your photo order ${snapshot.publicReference} was received.`,
    `Status: ${status}`,
    `Amount: ${amount} ${snapshot.currency.toUpperCase()}`,
    "",
    "Items:",
    summary,
    "",
    instructions,
    "",
    `View order status: ${snapshot.recoveryUrl}`,
  ].join("\n");
  const html = `<div style="font-family:Arial,sans-serif;line-height:1.6;color:#0f172a">` +
    `<p>Your photo order <strong>${escapeHtml(snapshot.publicReference)}</strong> was received.</p>` +
    `<p><strong>Status:</strong> ${escapeHtml(status)}<br>` +
    `<strong>Amount:</strong> ${escapeHtml(amount)} ${escapeHtml(snapshot.currency.toUpperCase())}</p>` +
    `<p><strong>Items</strong></p><ul>${snapshot.itemSummary.map((item) =>
      `<li>${escapeHtml(item)}</li>`).join("") || "<li>Order items</li>"}</ul>` +
    `<p>${escapeHtml(instructions)}</p>` +
    `<p><a href="${escapeHtml(snapshot.recoveryUrl)}">View order status</a></p></div>`;
  return {
    to: [snapshot.recipientEmail],
    subject: `Photo order ${snapshot.publicReference}`,
    text,
    html,
    headers: {},
  };
}

async function markClaim(
  item: ClaimedNotification,
  values: {
    status: "sent" | "failed" | "needs_review";
    providerId?: string | null;
    lastError?: string | null;
  },
): Promise<boolean> {
  const [updated] = await db.update(deliveryOrderNotificationsTable).set({
    status: values.status,
    providerId: values.providerId ?? null,
    sentAt: values.status === "sent" ? new Date() : null,
    claimToken: null,
    claimedAt: null,
    lastError: values.lastError ?? null,
    updatedAt: new Date(),
  }).where(and(
    eq(deliveryOrderNotificationsTable.id, item.id),
    eq(deliveryOrderNotificationsTable.status, "sending"),
    eq(deliveryOrderNotificationsTable.claimToken, item.claimToken),
  )).returning({ id: deliveryOrderNotificationsTable.id });
  if (updated) {
    await db.update(deliveryOrdersTable).set({
      notificationStatus: values.status === "sent"
        ? "sent"
        : values.status === "failed" ? "failed" : "uncertain",
      notificationProviderId: values.providerId ?? null,
      notificationError: values.lastError ?? null,
    }).where(eq(deliveryOrdersTable.id, item.orderId));
  }
  return Boolean(updated);
}

export type DeliveryOrderNotificationDispatchSummary = {
  claimed: number;
  sent: number;
  failed: number;
  needsReview: number;
  pending: number;
};

/**
 * Dispatches only a bounded batch of order notifications.  Unknown provider
 * outcomes are needs_review and are never selected again automatically.
 */
export async function dispatchDeliveryOrderNotifications(
  orderId?: number,
): Promise<DeliveryOrderNotificationDispatchSummary> {
  await recoverStaleClaims(orderId);
  if (!resendConfigurationStatus().canDispatch) {
    const [pending] = await db.select({ count: sql<number>`count(*)` })
      .from(deliveryOrderNotificationsTable)
      .where(and(
        eq(deliveryOrderNotificationsTable.status, "pending"),
        ...(orderId === undefined ? [] : [eq(deliveryOrderNotificationsTable.orderId, orderId)]),
      ));
    return { claimed: 0, sent: 0, failed: 0, needsReview: 0, pending: Number(pending?.count ?? 0) };
  }
  const claimed = await claimBatch(orderId);
  let sent = 0;
  let failed = 0;
  let needsReview = 0;
  for (const item of claimed) {
    const [row] = await db.select({
      notification: deliveryOrderNotificationsTable,
      order: deliveryOrdersTable,
    }).from(deliveryOrderNotificationsTable)
      .innerJoin(deliveryOrdersTable, eq(deliveryOrdersTable.id, deliveryOrderNotificationsTable.orderId))
      .where(and(
        eq(deliveryOrderNotificationsTable.id, item.id),
        eq(deliveryOrderNotificationsTable.claimToken, item.claimToken),
      )).limit(1);
    if (!row) continue;
    try {
      const snapshot = decryptStorageValue<DeliveryOrderNotificationSnapshot>(
        row.notification.snapshotEncrypted,
      );
      if (snapshotHash(snapshot) !== row.notification.snapshotHash) {
        await markClaim(item, { status: "needs_review", lastError: "Notification snapshot hash validation failed" });
        needsReview += 1;
        continue;
      }
      const token = decryptStorageValue<string>(row.notification.recoveryTokenEncrypted);
      if (recoveryTokenHash(token) !== row.notification.recoveryTokenHash
        || recoveryTokenHash(token) !== (row.order.recoveryTokenHash ?? "")) {
        await markClaim(item, { status: "needs_review", lastError: "Notification recovery capability validation failed" });
        needsReview += 1;
        continue;
      }
      const [providerId] = await sendResendEmailBatch(
        [messageFor(snapshot)],
        `volume-capture-order-notification-v1-${item.id}-a${item.attempt}`,
      );
      if (await markClaim(item, { status: "sent", providerId })) sent += 1;
    } catch (error) {
      const rejected = error instanceof ResendSendError && error.outcome === "rejected";
      const status = rejected ? "failed" : "needs_review";
      const updated = await markClaim(item, {
        status,
        lastError: (error instanceof Error ? error.message : "Order notification provider result is uncertain").slice(0, 1_000),
      });
      if (updated) {
        if (rejected) failed += 1;
        else needsReview += 1;
      }
      logger.warn({ err: error, notificationId: item.id }, "Order notification dispatch did not complete");
    }
  }
  const [pending] = await db.select({ count: sql<number>`count(*)` })
    .from(deliveryOrderNotificationsTable)
    .where(and(
      eq(deliveryOrderNotificationsTable.status, "pending"),
      ...(orderId === undefined ? [] : [eq(deliveryOrderNotificationsTable.orderId, orderId)]),
    ));
  return { claimed: claimed.length, sent, failed, needsReview, pending: Number(pending?.count ?? 0) };
}

/** Only explicit manager actions may move definitive failures back to pending. */
export async function retryFailedDeliveryOrderNotifications(orderId: number) {
  await db.update(deliveryOrderNotificationsTable).set({
    status: "pending",
    claimToken: null,
    claimedAt: null,
    lastError: null,
    updatedAt: new Date(),
  }).where(and(
    eq(deliveryOrderNotificationsTable.orderId, orderId),
    eq(deliveryOrderNotificationsTable.status, "failed"),
  ));
  return dispatchDeliveryOrderNotifications(orderId);
}
