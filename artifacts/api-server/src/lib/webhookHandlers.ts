import { and, eq } from "drizzle-orm";
import { db, deliveryOrdersTable, deliveryOrderItemsTable } from "@workspace/db";
import { getStripeSync } from "./stripeClient";

export class WebhookHandlers {
  static async processWebhook(payload: Buffer, signature: string, managedWebhookUuid?: string): Promise<void> {
    const sync = await getStripeSync();
    await sync.processWebhook(payload, signature, managedWebhookUuid);

    // StripeSync has already verified the signature and processed the event.
    // Parse the now-authenticated payload to apply the application-level order update.
    const event = JSON.parse(payload.toString("utf8")) as {
      type: string;
      data: { object: { id?: string; metadata?: Record<string, string>; payment_intent?: string | null; customer_details?: { email?: string | null; name?: string | null; address?: Record<string, string | null> | null } | null; customer_email?: string | null; amount_total?: number | null } };
    };
    if (event.type !== "checkout.session.completed") return;

    const session = event.data.object;
    const orderId = Number(session.metadata?.orderId);
    if (!Number.isInteger(orderId)) return;
    const items = await db.select({ productType: deliveryOrderItemsTable.productType })
      .from(deliveryOrderItemsTable).where(eq(deliveryOrderItemsTable.orderId, orderId));
    const hasPhysicalItem = items.some((item) => item.productType === "print" || item.productType === "pack");
    const details = session.customer_details;
    const address = details?.address
      ? Object.entries(details.address).filter(([, value]) => value).map(([key, value]) => `${key}: ${value}`).join(", ")
      : null;
    await db.update(deliveryOrdersTable).set({
      status: "paid",
      stripePaymentIntentId: typeof session.payment_intent === "string" ? session.payment_intent : null,
      customerEmail: session.customer_details?.email ?? session.customer_email ?? null,
      ...(details?.name ? { customerName: details.name } : {}),
      ...(address ? { deliveryAddress: address } : {}),
      fulfillmentStatus: hasPhysicalItem ? "paid" : "not_required",
      amountTotal: session.amount_total ?? 0,
      paidAt: new Date(),
    }).where(and(
      eq(deliveryOrdersTable.id, orderId),
      eq(deliveryOrdersTable.paymentMethod, "stripe"),
      ...(session.id ? [eq(deliveryOrdersTable.stripeCheckoutSessionId, session.id)] : []),
      eq(deliveryOrdersTable.status, "pending"),
    ));
  }
}