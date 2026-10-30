import { boolean, integer, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { deliveryGalleriesTable } from "./deliveries";

export const deliveryOrganizationAccessesTable = pgTable("delivery_organization_accesses", {
  id: serial("id").primaryKey(),
  galleryId: integer("gallery_id").notNull().references(() => deliveryGalleriesTable.id, { onDelete: "cascade" }),
  accessCodeHash: text("access_code_hash").notNull(),
  accessCodeEncrypted: text("access_code_encrypted").notNull(),
  accessCodeLast4: text("access_code_last4").notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  failedAttempts: integer("failed_attempts").notNull().default(0),
  tokenVersion: integer("token_version").notNull().default(1),
  lockedUntil: timestamp("locked_until", { withTimezone: true }),
  lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  familyCardsEnabled: boolean("family_cards_enabled").notNull().default(false),
}, (table) => [
  uniqueIndex("delivery_organization_accesses_gallery_unique").on(table.galleryId),
]);
