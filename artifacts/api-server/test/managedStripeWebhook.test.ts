import assert from "node:assert/strict";
import test from "node:test";
import { managedWebhookBaseUrl } from "../src/lib/managedStripeWebhook";

test("normalizes legacy managed webhook URLs using their stored UUID", () => {
  assert.equal(
    managedWebhookBaseUrl({
      _id: "we_123",
      id: undefined as never,
      uuid: "916a3273-117c-41b4-a3de-5d6be6375ae5",
      url: "https://example.test/api/stripe/webhook/916a3273-117c-41b4-a3de-5d6be6375ae5",
    } as never),
    "https://example.test/api/stripe/webhook",
  );
});

test("leaves an exact non-legacy webhook URL unchanged", () => {
  assert.equal(
    managedWebhookBaseUrl({
      id: "we_123",
      url: "https://example.test/api/stripe/webhook",
    } as never),
    "https://example.test/api/stripe/webhook",
  );
});