import type {
  DeliveryOffer,
  DeliveryOperationsResponse,
  DeliveryOrderSafe,
} from "@workspace/api-client-react";

export type DeliveryNotificationEvent = "order_received" | "payment_confirmed";
export type DeliveryNotificationStatus =
  | "pending"
  | "sending"
  | "sent"
  | "failed"
  | "needs_review"
  | "unavailable";

export type DeliveryNotificationState = {
  status: DeliveryNotificationStatus;
  sentAt: string | null;
  retryAllowed: boolean;
};

export const deliveryOperationsStatusRows = (operations: DeliveryOperationsResponse) => [
  { key: "pending", label: "Pending", invitations: operations.invitations.pending, orderNotifications: operations.orderNotifications.pending },
  { key: "sending", label: "Sending", invitations: operations.invitations.sending, orderNotifications: operations.orderNotifications.sending },
  { key: "sent", label: "Sent", invitations: operations.invitations.sent, orderNotifications: operations.orderNotifications.sent },
  { key: "failed", label: "Failed", invitations: operations.invitations.failed, orderNotifications: operations.orderNotifications.failed },
  { key: "needsReview", label: "Needs review", invitations: operations.invitations.needsReview, orderNotifications: operations.orderNotifications.needsReview },
] as const;

/**
 * Only studio owners and admins may see or change operational order state.
 * Keep this check in the client as a presentation guard; the API remains the
 * authority for authorization.
 */
export function isDeliveryManager(member: { role?: unknown; status?: unknown } | null | undefined): boolean {
  return member?.status === "active" && (member.role === "owner" || member.role === "admin");
}

export function notificationStatusPresentation(status: unknown): {
  status: DeliveryNotificationStatus;
  label: string;
  tone: "neutral" | "info" | "success" | "danger" | "warning";
} {
  switch (status) {
    case "pending": return { status, label: "Queued", tone: "neutral" };
    case "sending": return { status, label: "Sending", tone: "info" };
    case "sent": return { status, label: "Sent", tone: "success" };
    case "failed": return { status, label: "Failed", tone: "danger" };
    case "needs_review": return { status, label: "Needs review", tone: "warning" };
    default: return { status: "unavailable", label: "Unavailable", tone: "neutral" };
  }
}

/**
 * Normalize a timestamp from the safe operational response. Invalid dates and
 * non-date values are intentionally omitted rather than displayed.
 */
export function safeNotificationTimestamp(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function notificationState(value: NonNullable<NonNullable<DeliveryOrderSafe["notifications"]>["orderReceived"]>): DeliveryNotificationState {
  const presentation = notificationStatusPresentation(value.status);
  return {
    status: presentation.status,
    sentAt: safeNotificationTimestamp(value.sentAt),
    retryAllowed: value.retryAllowed,
  };
}

/**
 * Read only the explicitly safe, event-scoped notification fields. Older
 * orders and API responses without operational fields remain safely
 * unavailable; no provider, recovery, error, or encrypted data is read.
 */
export function getDeliveryNotificationState(
  order: Pick<DeliveryOrderSafe, "notifications">,
  event: DeliveryNotificationEvent,
): DeliveryNotificationState {
  const notification = event === "order_received"
    ? order.notifications?.orderReceived
    : order.notifications?.paymentConfirmed;
  return notification
    ? notificationState(notification)
    : { status: "unavailable", sentAt: null, retryAllowed: false };
}

/** Retry is offered only when at least one event is definitively failed. */
export function canRetryFailedOrderNotifications(
  states: readonly Pick<DeliveryNotificationState, "status" | "retryAllowed">[],
): boolean {
  return states.some((state) => state.status === "failed" && state.retryAllowed);
}

export type LocalBasketItem = {
  id: string;
  offerId: string;
  photoIds: number[];
  quantity: number;
};

export type RecoveryCredentials = {
  reference: string;
  token: string;
};

export type CheckoutTransitionInput = {
  checkoutAttemptStatus?: string;
  checkoutUrl?: string | null;
  paymentMethod?: string;
};

export function checkoutTransition(result: CheckoutTransitionInput) {
  const uncertain = result.checkoutAttemptStatus === "uncertain";
  const acceptedManual = !uncertain && result.paymentMethod !== "stripe" && !result.checkoutUrl;
  const definitive = !uncertain && (Boolean(result.checkoutUrl) || acceptedManual);
  return {
    uncertain,
    retainCheckoutKey: !definitive,
    retainBasket: !definitive,
    redirectToCheckout: !uncertain && Boolean(result.checkoutUrl),
  };
}

export function shouldClearDeliveryAccess(error: unknown): boolean {
  return Boolean(error && typeof error === "object"
    && "status" in error && (error as { status?: unknown }).status === 401);
}

export function mediaRefreshDelay(expiresAt: string, now = Date.now()): number | null {
  const expiry = Date.parse(expiresAt);
  return Number.isFinite(expiry) ? Math.max(1_000, expiry - now - 30_000) : null;
}

export function scheduleMediaRefresh(
  expiresAt: string,
  now: number,
  schedule: (callback: () => void, delay: number) => unknown,
  cancel: (handle: unknown) => void,
  refresh: () => void,
): () => void {
  const delay = mediaRefreshDelay(expiresAt, now);
  if (delay === null) return () => undefined;
  const handle = schedule(refresh, delay);
  return () => cancel(handle);
}

export function getCommonMethods(basketItems: LocalBasketItem[], contentOffers: DeliveryOffer[]) {
  if (basketItems.length === 0) return { delivery: [] as string[], payment: [] as string[], currency: null as string | null };

  const firstOffer = contentOffers.find(o => o.id === basketItems[0].offerId);
  if (!firstOffer) return { delivery: [] as string[], payment: [] as string[], currency: null as string | null };

  let commonDelivery = [...firstOffer.deliveryMethods] as string[];
  let commonPayment = [...firstOffer.paymentMethods] as string[];
  const currency = firstOffer.currency;

  for (const item of basketItems) {
    const offer = contentOffers.find(o => o.id === item.offerId);
    if (offer) {
      commonDelivery = commonDelivery.filter(m => offer.deliveryMethods.includes(m as any));
      commonPayment = commonPayment.filter(m => offer.paymentMethods.includes(m as any));
    }
  }

  return { delivery: commonDelivery, payment: commonPayment, currency };
}

export function parseRecoveryCredentials(location: string): RecoveryCredentials | null {
  const url = new URL(location, "https://delivery.invalid");
  const reference = url.searchParams.get("orderRef")?.trim() ?? "";
  const fragment = new URLSearchParams(url.hash.replace(/^#/, ""));
  const token = fragment.get("recoveryToken")?.trim() ?? "";
  return reference && token ? { reference, token } : null;
}

export function recoveryStatusLabel(status: string): string {
  switch (status) {
    case "paid": return "paid";
    case "pending": return "pending";
    case "refunded": return "refunded";
    case "cancelled": return "cancelled";
    case "expired": return "expired";
    default: return "unknown";
  }
}