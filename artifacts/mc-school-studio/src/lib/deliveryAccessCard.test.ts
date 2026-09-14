import { strict as assert } from "node:assert";
import test from "node:test";
import {
  deliveryAccessCardTerminology,
  printableDeliveryAccessUrl,
} from "./deliveryAccessCard.ts";

for (const fixture of [
  { projectType: "school" as const, subjectLabel: "Student", groupLabel: "Class" },
  { projectType: "corporate" as const, subjectLabel: "Employee", groupLabel: "Department" },
]) {
  test(`prints a complete ${fixture.projectType} gallery address`, () => {
    assert.deepEqual(deliveryAccessCardTerminology(fixture.projectType), {
      subjectLabel: fixture.subjectLabel,
      groupLabel: fixture.groupLabel,
    });
    assert.equal(
      printableDeliveryAccessUrl(
        "volumecapture.net",
        `/delivery/${fixture.projectType}-gallery?code=PRIVATE1`,
      ),
      `volumecapture.net/delivery/${fixture.projectType}-gallery`,
    );
  });
}

test("rejects a bare delivery path", () => {
  assert.throws(
    () => printableDeliveryAccessUrl("volumecapture.net", "/delivery"),
    /gallery-specific/,
  );
});