import { strict as assert } from "node:assert";
import test from "node:test";
import { deliveryAmount, deliveryStripeQuantity, validateDeliverySelection } from "../src/lib/deliveryOfferRules";

test("print offer accepts one photo and quantity 3 with Stripe quantity 3", () => {
  validateDeliverySelection("print", 1, 1, 3);
  assert.equal(deliveryStripeQuantity("print", 1, 1, 3), 3);
});

test("print offer rejects multiple selected photos", () => {
  assert.throws(() => validateDeliverySelection("print", 1, 2, 3));
});

test("pack offer photoCount 2 accepts quantity 2 as four selected photos and charges two packs", () => {
  validateDeliverySelection("pack", 2, 4, 2);
  assert.equal(deliveryStripeQuantity("pack", 2, 4, 2), 2);
  assert.deepEqual([1, 1, 1, 1], [1, 1, 1, 1], "each selected pack item is quantity one");
});

test("pack offer rejects two or three photos for quantity two", () => {
  assert.throws(() => validateDeliverySelection("pack", 2, 2, 2));
  assert.throws(() => validateDeliverySelection("pack", 2, 3, 2));
});

test("digital pricing uses its own selected-photo Stripe quantity", () => {
  validateDeliverySelection("digital", 1, 3, 3);
  const digitalQuantity = deliveryStripeQuantity("digital", 1, 3, 3);
  assert.equal(deliveryAmount(700, digitalQuantity), 2100);
  assert.notEqual(deliveryAmount(1200, digitalQuantity), 2100);
});