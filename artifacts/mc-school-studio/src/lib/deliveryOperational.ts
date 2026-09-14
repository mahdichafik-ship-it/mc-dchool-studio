import type { DeliveryOffer } from "@workspace/api-client-react";

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