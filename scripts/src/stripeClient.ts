import Stripe from "stripe";
import { StripeSync } from "stripe-replit-sync";

async function credentials(): Promise<{ secretKey: string; webhookSecret?: string }> {
  const hostname = process.env.REPLIT_CONNECTORS_HOSTNAME;
  const token = process.env.REPL_IDENTITY ? `repl ${process.env.REPL_IDENTITY}` : `depl ${process.env.WEB_REPL_RENEWAL}`;
  if (!hostname || !token) throw new Error("Stripe connection environment is not available");
  const response = await fetch(`https://${hostname}/api/v2/connection?include_secrets=true&connector_names=stripe`, {
    headers: { Accept: "application/json", X_REPLIT_TOKEN: token },
  });
  if (!response.ok) throw new Error(`Could not load Stripe connection (${response.status})`);
  const data = await response.json() as { items?: { settings?: { secret_key?: string; webhook_secret?: string } }[] };
  const settings = data.items?.[0]?.settings as {
    secret_key?: string;
    secret?: string;
    webhook_secret?: string;
  } | undefined;
  const secretKey = settings?.secret_key ?? settings?.secret;
  if (!secretKey) throw new Error("Stripe is not connected");
  return { secretKey, webhookSecret: settings?.webhook_secret };
}

export async function getUncachableStripeClient(): Promise<Stripe> {
  return new Stripe((await credentials()).secretKey);
}

export async function getStripeSync(): Promise<StripeSync> {
  const { secretKey, webhookSecret } = await credentials();
  return new StripeSync({
    poolConfig: { connectionString: process.env.DATABASE_URL! },
    stripeSecretKey: secretKey,
    stripeWebhookSecret: webhookSecret ?? "",
  });
}