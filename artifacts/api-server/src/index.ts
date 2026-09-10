import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import app from "./app";
import { logger } from "./lib/logger";
import { recoverPhotoDeleteBackups } from "./routes/photos";
import { runMigrations } from "stripe-replit-sync";
import { getStripeSync } from "./lib/stripeClient";
import { pool } from "@workspace/db";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);
const migrationDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations");

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

try {
  await recoverPhotoDeleteBackups();
  if (process.env.REPLIT_CONNECTORS_HOSTNAME) {
    const migrationTable = await pool.query<{ exists: boolean }>(`
      SELECT EXISTS(
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema = 'stripe' AND table_name = 'migrations'
      ) AS exists
    `);
    let migration12Applied = false;
    if (migrationTable.rows[0]?.exists) {
      const migrationState = await pool.query<{ id: number }>(
        `SELECT id FROM stripe.migrations WHERE id = 12`,
      );
      migration12Applied = migrationState.rows.some((row) => row.id === 12);
    }
    if (!migration12Applied) {
      await pool.query(`
        DO $$
        DECLARE table_name text;
        BEGIN
          FOREACH table_name IN ARRAY ARRAY[
            'subscriptions', 'products', 'customers', 'prices', 'invoices',
            'charges', 'coupons', 'disputes', 'events', 'payouts', 'plans'
          ]
          LOOP
            IF to_regclass('stripe.' || table_name) IS NOT NULL THEN
              EXECUTE format('DROP TRIGGER IF EXISTS handle_updated_at ON stripe.%I', table_name);
            END IF;
          END LOOP;
        END $$;
      `);
    }
    const modernStripeSchema = await pool.query<{ modern: boolean }>(`
      SELECT EXISTS(
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'stripe'
          AND table_name = 'subscription_items'
          AND column_name = '_raw_data'
      ) AND EXISTS(
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema = 'stripe'
          AND table_name IN ('_managed_webhooks', '_sync_status', 'accounts')
        GROUP BY table_schema
        HAVING COUNT(*) = 3
      ) AS modern
    `);
    if (modernStripeSchema.rows[0]?.modern && migrationTable.rows[0]?.exists) {
      for (const fileName of readdirSync(migrationDir).filter((file) => /^\d{4}_.*\.sql$/.test(file))) {
        const id = Number(fileName.slice(0, 4));
        if (id < 14) continue;
        const name = fileName.slice(5, -4);
        const sql = readFileSync(path.join(migrationDir, fileName), "utf8");
        const hash = createHash("sha1").update(fileName + sql, "utf8").digest("hex");
        await pool.query(
          `INSERT INTO stripe.migrations (id, name, hash)
           VALUES ($1, $2, $3)
           ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, hash = EXCLUDED.hash`,
          [id, name, hash],
        );
      }
    }
    await runMigrations({ databaseUrl: process.env.DATABASE_URL!, schema: "stripe" });
    const stripeSync = await getStripeSync();
    const webhookBaseUrl = `https://${process.env.REPLIT_DOMAINS?.split(",")[0] ?? "localhost"}`;
    await stripeSync.findOrCreateManagedWebhook(`${webhookBaseUrl}/api/stripe/webhook`, {
      enabled_events: [
        "checkout.session.completed",
        "payment_intent.succeeded",
        "payment_intent.payment_failed",
        "charge.refunded",
      ],
      description: "Volume Capture delivery order payments",
    });
    await stripeSync.syncBackfill();
  }
} catch (error) {
  logger.error({ err: error }, "Could not initialize photo recovery or Stripe");
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
});
