import { and, eq, isNull } from "drizzle-orm";
import { db, deliveryOrdersTable, deliveryOrderItemsTable, deliveryGalleriesTable } from "@workspace/db";
import { getStripeSync } from "./stripeClient";
import { markContactOrder, normalizeMarketingEmail } from "./marketing";

export class WebhookHandlers {
  static async processWebhook(payload: Buffer, signature: string, managedWebhookUuid?: string): Promise<void> {
    const sync = await getStripeSync();
    await sync.processWebhook(payload, signature, managedWebhookUuid);

    // StripeSync has already verified the signature and processed the event.
    // Parse the now-authenticated payload to apply the application-level order update.
    const event = JSON.parse(payload.toString("utf8")) as {
      type: string;
      data: { object: {
        id?: string;
        metadata?: Record<string, string>;
        payment_intent?: string | null;
        payment_status?: string | null;
        currency?: string | null;
        customer_details?: {
          email?: string | null;
          name?: string | null;
          address?: Record<string, string | null> | null;
        } | null;
        customer_email?: string | null;
        amount_total?: number | null;
      } };
    };
    if (event.type !== "checkout.session.completed") return;

    const session = event.data.object;
    const orderId = Number(session.metadata?.orderId);
    if (!Number.isInteger(orderId) || !session.id) return;
    const [existingOrder] = await db.select().from(deliveryOrdersTable)
      .where(eq(deliveryOrdersTable.id, orderId)).limit(1);
    if (!existingOrder || existingOrder.paymentMethod !== "stripe") return;
    const [gallery] = await db.select({
      studioId: deliveryGalleriesTable.studioId,
      slug: deliveryGalleriesTable.slug,
      projectId: deliveryGalleriesTable.projectId,
    }).from(deliveryGalleriesTable)
      .where(eq(deliveryGalleriesTable.id, existingOrder.galleryId)).limit(1);
    if (!gallery
      || (session.metadata?.gallerySlug && session.metadata.gallerySlug !== gallery.slug)
      || (session.metadata?.projectId && session.metadata.projectId !== String(gallery.projectId))) return;

    // Stripe's completed event must describe the order we are about to mark
    // paid. Never bind an arbitrary session or trust a missing amount/currency.
    const details = session.customer_details;
    const normalizedEmail = normalizeMarketingEmail(details?.email ?? session.customer_email);
    const normalizedDetailsEmail = normalizeMarketingEmail(details?.email);
    const storedEmail = normalizeMarketingEmail(existingOrder.customerEmail);
    const storedName = existingOrder.customerName?.trim().toLowerCase();
    const incomingName = details?.name?.trim().toLowerCase();
    const isUncertainBinding = existingOrder.stripeCheckoutSessionId === null;
    if (isUncertainBinding) {
      const metadata = session.metadata;
      const metadataOrderId = metadata?.orderId;
      const metadataGallerySlug = metadata?.gallerySlug;
      const metadataProjectId = metadata?.projectId;
      const normalizedCurrency = typeof session.currency === "string"
        ? session.currency.trim().toLowerCase()
        : "";
      const normalizedStoredCurrency = existingOrder.currency.trim().toLowerCase();
      const normalizedStoredName = existingOrder.customerName?.trim().replace(/\s+/g, " ").toLowerCase();
      const normalizedIncomingName = details?.name?.trim().replace(/\s+/g, " ").toLowerCase();
      // A provider-accepted session has no local ID to authenticate by. Every
      // checkout-completion binding field is therefore mandatory and exact.
      if (
        session.id.trim() === ""
        || metadataOrderId !== String(orderId)
        || !metadataGallerySlug || metadataGallerySlug !== gallery.slug
        || !metadataProjectId || metadataProjectId !== String(gallery.projectId)
        || typeof session.amount_total !== "number" || session.amount_total !== existingOrder.amountTotal
        || !normalizedCurrency || normalizedCurrency !== normalizedStoredCurrency
        || session.payment_status !== "paid"
        || !details
        || !normalizedDetailsEmail || !storedEmail || normalizedDetailsEmail !== storedEmail
        || !normalizedIncomingName || !normalizedStoredName || normalizedIncomingName !== normalizedStoredName
      ) return;
    } else {
      // Preserve the established validation contract for sessions already
      // durably associated with the order.
      if (session.payment_status && session.payment_status !== "paid") return;
      if (session.amount_total !== null && session.amount_total !== undefined
        && session.amount_total !== existingOrder.amountTotal) return;
      if (session.currency && session.currency.toLowerCase() !== existingOrder.currency.toLowerCase()) return;
      if (normalizedEmail && storedEmail && normalizedEmail !== storedEmail) return;
      if (incomingName && storedName && incomingName !== storedName) return;
    }

    const items = await db.select({ productType: deliveryOrderItemsTable.productType })
      .from(deliveryOrderItemsTable).where(eq(deliveryOrderItemsTable.orderId, orderId));
    const hasPhysicalItem = items.some((item) => item.productType === "print" || item.productType === "pack");
    const address = details?.address
      ? Object.entries(details.address).filter(([, value]) => value).map(([key, value]) => `${key}: ${value}`).join(", ")
      : null;

    // A process crash after Stripe accepted create leaves no local session ID.
    // Only an uncertain, pending Stripe order may bind that first session. A
    // non-null ID can never be replaced, even by another completed event.
    const bindable = existingOrder.status === "pending"
      && (existingOrder.stripeCheckoutSessionId === session.id
        || (existingOrder.stripeCheckoutSessionId === null
          && existingOrder.checkoutAttemptStatus === "uncertain"));
    if (!bindable) return;
    const updated = await db.update(deliveryOrdersTable).set({
      stripeCheckoutSessionId: session.id,
      status: "paid",
      stripePaymentIntentId: typeof session.payment_intent === "string" ? session.payment_intent : null,
      ...(normalizedEmail ? { customerEmail: normalizedEmail } : {}),
      ...(details?.name ? { customerName: details.name } : {}),
      ...(address ? { deliveryAddress: address } : {}),
      fulfillmentStatus: hasPhysicalItem ? "paid" : "not_required",
      amountTotal: existingOrder.amountTotal,
      paidAt: new Date(),
    }).where(and(
      eq(deliveryOrdersTable.id, orderId),
      eq(deliveryOrdersTable.paymentMethod, "stripe"),
      eq(deliveryOrdersTable.status, "pending"),
      ...(existingOrder.stripeCheckoutSessionId === null
        ? [isNull(deliveryOrdersTable.stripeCheckoutSessionId), eq(deliveryOrdersTable.checkoutAttemptStatus, "uncertain")]
        : [eq(deliveryOrdersTable.stripeCheckoutSessionId, session.id)]),
    )).returning({ id: deliveryOrdersTable.id });
    if (!updated.length) return;

    const contact = normalizedEmail && gallery.studioId
      ? await markContactOrder(gallery.studioId, normalizedEmail, existingOrder.contactId)
      : null;
    if (contact) {
      await db.update(deliveryOrdersTable).set({ contactId: contact.id }).where(eq(deliveryOrdersTable.id, orderId));
    }
  }
}