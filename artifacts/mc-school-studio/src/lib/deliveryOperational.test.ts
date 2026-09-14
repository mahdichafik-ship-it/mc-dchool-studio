import { strict as assert } from "node:assert";
import test from "node:test";
import {
  getCommonMethods,
  checkoutTransition,
  mediaRefreshDelay,
  parseRecoveryCredentials,
  recoveryStatusLabel,
  scheduleMediaRefresh,
  shouldClearDeliveryAccess,
} from "./deliveryOperational.ts";

const offer = (overrides: Record<string, unknown> = {}) => ({
  id: "digital",
  name: "Digital",
  productType: "digital",
  photoCount: 1,
  unitAmount: 100,
  currency: "usd",
  deliveryMethods: ["digital"],
  paymentMethods: ["establishment", "stripe"],
  active: true,
  ...overrides,
}) as any;

test("media refresh schedules thirty seconds before expiry and clamps near expiry", () => {
  const now = Date.parse("2027-01-01T00:00:00.000Z");
  assert.equal(mediaRefreshDelay("2027-01-01T00:15:00.000Z", now), 870_000);
  assert.equal(mediaRefreshDelay("2027-01-01T00:00:10.000Z", now), 1_000);
  assert.equal(mediaRefreshDelay("not-a-date", now), null);
});

test("media refresh scheduler refetches once and cleanup cancels pending timer", () => {
  let scheduled: (() => void) | undefined;
  let cancelled: unknown;
  let delay = 0;
  let refreshes = 0;
  const cleanup = scheduleMediaRefresh(
    "2027-01-01T00:15:00.000Z",
    Date.parse("2027-01-01T00:00:00.000Z"),
    (callback, nextDelay) => {
      scheduled = callback;
      delay = nextDelay;
      return "timer";
    },
    (handle) => { cancelled = handle; },
    () => { refreshes += 1; },
  );
  assert.equal(delay, 870_000);
  scheduled?.();
  assert.equal(refreshes, 1);
  cleanup();
  assert.equal(cancelled, "timer");
});

test("recovery parser accepts reference in query and credential only in fragment", () => {
  assert.deepEqual(
    parseRecoveryCredentials("https://studio.test/delivery/a?orderRef=ord_123#recoveryToken=secret"),
    { reference: "ord_123", token: "secret" },
  );
  assert.equal(parseRecoveryCredentials("https://studio.test/delivery/a?orderRef=ord_123&recoveryToken=secret"), null);
  assert.equal(parseRecoveryCredentials("https://studio.test/delivery/a#recoveryToken=secret"), null);
});

test("common method normalization converges to intersections without mutating offers", () => {
  const offers = [
    offer(),
    offer({ id: "print", deliveryMethods: ["shipping"], paymentMethods: ["establishment"] }),
  ];
  const result = getCommonMethods([
    { id: "a", offerId: "digital", photoIds: [1], quantity: 1 },
    { id: "b", offerId: "print", photoIds: [2], quantity: 1 },
  ], offers);
  assert.deepEqual(result, { delivery: [], payment: ["establishment"], currency: "usd" });
  assert.deepEqual(offers[0].deliveryMethods, ["digital"]);
});

test("recovery status presentation has an explicit safe fallback", () => {
  assert.equal(recoveryStatusLabel("pending"), "pending");
  assert.equal(recoveryStatusLabel("paid"), "paid");
  assert.equal(recoveryStatusLabel("provider-secret"), "unknown");
});

test("uncertain checkout retains the idempotency key and basket for recovery polling", () => {
  assert.deepEqual(checkoutTransition({
    checkoutAttemptStatus: "uncertain",
    checkoutUrl: null,
    paymentMethod: "stripe",
  }), {
    uncertain: true,
    retainCheckoutKey: true,
    retainBasket: true,
    redirectToCheckout: false,
  });
  assert.deepEqual(checkoutTransition({
    checkoutAttemptStatus: "created",
    checkoutUrl: "https://checkout.test/session",
    paymentMethod: "stripe",
  }), {
    uncertain: false,
    retainCheckoutKey: false,
    retainBasket: false,
    redirectToCheckout: true,
  });
  assert.equal(checkoutTransition({
    checkoutAttemptStatus: "created",
    checkoutUrl: null,
    paymentMethod: "stripe",
  }).retainBasket, true);
  assert.equal(checkoutTransition({
    checkoutAttemptStatus: "not_started",
    checkoutUrl: null,
    paymentMethod: "establishment",
  }).retainBasket, false);
});

test("background media refresh errors preserve state except actual access expiry", () => {
  assert.equal(shouldClearDeliveryAccess({ status: 503 }), false);
  assert.equal(shouldClearDeliveryAccess(new Error("network")), false);
  assert.equal(shouldClearDeliveryAccess({ status: 401 }), true);
});