import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  deliveryAccessCardTerminology,
  parseDeliveryAccessCode,
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

test("prefers a fragment access code while accepting legacy query links", () => {
  assert.equal(
    parseDeliveryAccessCode("https://gallery.test/delivery/alpha?code=LEGACY12#code=FRAGMENT"),
    "FRAGMENT",
  );
  assert.equal(
    parseDeliveryAccessCode("https://gallery.test/delivery/alpha?code=LEGACY12"),
    "LEGACY12",
  );
  assert.equal(parseDeliveryAccessCode("https://gallery.test/delivery/alpha"), null);
});

test("printable human URLs remain absolute and never include credentials", () => {
  const humanUrl = printableDeliveryAccessUrl(
    "ignored.test",
    "https://gallery.test/delivery/alpha#code=SECRET12",
  );
  assert.equal(humanUrl, "https://gallery.test/delivery/alpha");
  assert.equal(humanUrl.includes("SECRET12"), false);
});

test("delivery keeps draft/unavailable state generic with manual refresh and no gallery polling", () => {
  const source = readFileSync(new URL("../pages/Delivery.tsx", import.meta.url), "utf8");
  assert.match(source, /data-testid="text-delivery-unavailable"/);
  assert.match(source, /Your gallery is not available yet\. Keep this card and return after the photographs have been published\./);
  assert.match(source, /data-testid="button-refresh-delivery"/);
  assert.match(source, /onClick=\{\(\) => void refetchGallery\(\)\}/);
  const galleryHook = source.slice(source.indexOf("useGetDeliveryGallery"), source.indexOf("const enterAccess"));
  assert.equal(galleryHook.includes("refetchInterval"), false);
});

test("access-card management includes prepare invalidation and an explicit regenerate warning", () => {
  const source = readFileSync(new URL("../components/project/DeliveryTab.tsx", import.meta.url), "utf8");
  assert.match(source, /usePrepareDeliveryAccessCards/);
  assert.match(source, /getListDeliveryAccessCardsQueryKey/);
  assert.match(source, /Preparation does not publish the gallery/);
  assert.match(source, /immediately invalidates the existing code/);
});