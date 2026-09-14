import assert from "node:assert/strict";
import test from "node:test";
import {
  ensureSingleManagedWebhook,
  managedWebhookBaseUrl,
} from "../src/lib/managedStripeWebhook";

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

test("repeated initialization reuses one enabled managed webhook", async () => {
  const baseUrl = "https://example.test/api/stripe/webhook";
  const uuid = "916a3273-117c-41b4-a3de-5d6be6375ae5";
  const managed = {
    _id: "we_123",
    uuid,
    url: `${baseUrl}/${uuid}`,
    status: "enabled",
  };
  let createCalls = 0;
  let retrieveCalls = 0;
  let updateCalls = 0;

  const stripeSync = {
    async listManagedWebhooks() {
      return [managed];
    },
    async createManagedWebhook() {
      createCalls += 1;
      throw new Error("should not create a replacement webhook");
    },
  };
  const stripe = {
    webhookEndpoints: {
      async retrieve(id: string) {
        retrieveCalls += 1;
        assert.equal(id, managed._id);
        return { ...managed, id };
      },
      async update(id: string) {
        updateCalls += 1;
        assert.equal(id, managed._id);
        return { ...managed, id };
      },
    },
  };
  const params = {
    enabled_events: ["checkout.session.completed"],
    description: "Volume Capture delivery order payments",
  } as const;

  const first = await ensureSingleManagedWebhook(
    stripeSync as never,
    stripe as never,
    baseUrl,
    params as never,
  );
  const second = await ensureSingleManagedWebhook(
    stripeSync as never,
    stripe as never,
    baseUrl,
    params as never,
  );

  assert.equal(first.webhook.id, managed._id);
  assert.equal(second.webhook.id, managed._id);
  assert.equal(first.uuid, uuid);
  assert.equal(second.uuid, uuid);
  assert.equal(retrieveCalls, 2);
  assert.equal(updateCalls, 2);
  assert.equal(createCalls, 0);
});