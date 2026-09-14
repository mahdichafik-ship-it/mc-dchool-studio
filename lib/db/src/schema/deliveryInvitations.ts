import { integer, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { deliveryAccessesTable, deliveryGalleriesTable } from "./deliveries";

/**
 * Delivery invitations are deliberately separate from marketing contacts and
 * campaigns. A row is one durable outbox item for one gallery/recipient; the
 * link table preserves every subject access code in a shared inbox.
 */
export const deliveryInvitationsTable = pgTable("delivery_invitations", {
  id: serial("id").primaryKey(),
  galleryId: integer("gallery_id")
    .notNull()
    .references(() => deliveryGalleriesTable.id, { onDelete: "cascade" }),
  recipientEmail: text("recipient_email").notNull(),
  status: text("status", { enum: ["pending", "sending", "sent", "failed", "needs_review"] })
    .notNull()
    .default("pending"),
  contentRevision: integer("content_revision").notNull().default(1),
  attempts: integer("attempts").notNull().default(0),
  claimedAt: timestamp("claimed_at", { withTimezone: true }),
  providerId: text("provider_id"),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  lastError: text("last_error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("delivery_invitations_gallery_email_unique").on(table.galleryId, table.recipientEmail),
]);

export const deliveryInvitationAccessLinksTable = pgTable("delivery_invitation_access_links", {
  id: serial("id").primaryKey(),
  invitationId: integer("invitation_id")
    .notNull()
    .references(() => deliveryInvitationsTable.id, { onDelete: "cascade" }),
  accessId: integer("access_id")
    .notNull()
    .references(() => deliveryAccessesTable.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("delivery_invitation_access_link_unique").on(table.invitationId, table.accessId),
]);

export type DeliveryInvitation = typeof deliveryInvitationsTable.$inferSelect;
export type DeliveryInvitationAccessLink = typeof deliveryInvitationAccessLinksTable.$inferSelect;
export const insertDeliveryInvitationSchema = createInsertSchema(deliveryInvitationsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertDeliveryInvitation = z.infer<typeof insertDeliveryInvitationSchema>;