import { strict as assert } from "node:assert";
import test from "node:test";
import { deliveryAmount, deliveryOrderQuantity, validateDeliverySelection } from "../src/lib/deliveryOfferRules";
import { deliveryTerminology, normalizeDeliveryProjectType } from "../src/lib/deliveryTerminology";

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