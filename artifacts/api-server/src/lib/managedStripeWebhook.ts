import type Stripe from "stripe";
import type { StripeSync } from "stripe-replit-sync";
import { pool } from "@workspace/db";
import { logger } from "./logger";

type LegacyManagedWebhook = Stripe.WebhookEndpoint & {
  _id?: string;
  uuid?: string;
};

type ManagedWebhookSync = Pick<
  StripeSync,
  "listManagedWebhooks" | "createManagedWebhook"
>;

function managedWebhookId(webhook: LegacyManagedWebhook): string | null {
  return webhook.id ?? webhook._id ?? null;
}

export function managedWebhookBaseUrl(webhook: LegacyManagedWebhook): string {
  if (webhook.uuid && webhook.url.endsWith(`/${webhook.uuid}`)) {
    return webhook.url.slice(0, -(webhook.uuid.length + 1));
  }
  return webhook.url.replace(
    /\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    "",
  );
}

function isMissingStripeResource(error: unknown): boolean {
  const stripeError = error as { statusCode?: unknown; code?: unknown };
  return stripeError?.statusCode === 404 || stripeError?.code === "resource_missing";
}

async function removeManagedWebhook(
  stripe: Stripe,
  webhook: LegacyManagedWebhook,
): Promise<void> {
  const id = managedWebhookId(webhook);
  if (!id) return;
  try {
    await stripe.webhookEndpoints.del(id);
  } catch (error) {
    if (!isMissingStripeResource(error)) throw error;
  }
  await pool.query(`DELETE FROM stripe._managed_webhooks WHERE _id = $1`, [id]);
}

export async function ensureSingleManagedWebhook(
  stripeSync: ManagedWebhookSync,
  stripe: Stripe,
  baseUrl: string,
  params: Omit<Stripe.WebhookEndpointCreateParams, "url">,
): Promise<{ webhook: Stripe.WebhookEndpoint; uuid: string }> {
  const configured = await stripeSync.listManagedWebhooks() as LegacyManagedWebhook[];
  const matching = configured.filter((webhook) => managedWebhookBaseUrl(webhook) === baseUrl);
  let retained: { webhook: Stripe.WebhookEndpoint; uuid: string } | null = null;

  for (const managed of matching) {
    const id = managedWebhookId(managed);
    if (!id) continue;
    try {
      const webhook = await stripe.webhookEndpoints.retrieve(id);
      if (!("deleted" in webhook) && webhook.status === "enabled" && !retained) {
        const updated = await stripe.webhookEndpoints.update(id, params);
        retained = { webhook: updated, uuid: managed.uuid ?? "" };
        continue;
      }
    } catch (error) {
      if (!isMissingStripeResource(error)) throw error;
    }
    await removeManagedWebhook(stripe, managed);
  }

  if (retained) {
    logger.info({
      webhookId: retained.webhook.id,
      removedDuplicates: Math.max(0, matching.length - 1),
    }, "Reused managed Stripe webhook");
    return retained;
  }

  const created = await stripeSync.createManagedWebhook(baseUrl, params);
  logger.info({ webhookId: created.webhook.id }, "Created managed Stripe webhook");
  return created;
}