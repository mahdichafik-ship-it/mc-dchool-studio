import { createInsertSchema } from "drizzle-zod";
import { integer, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { z } from "zod/v4";
import { deliveryGalleriesTable } from "./deliveries";

export const deliveryOrganizationPublishedNotificationsTable = pgTable("delivery_organization_published_notifications", {
  id: serial("id").primaryKey(),
  galleryId: integer("gallery_id")
    .notNull()
    .references(() => deliveryGalleriesTable.id, { onDelete: "cascade" }),
  recipientEmail: text("recipient_email").notNull(),
  status: text("status", { enum: ["pending", "sending", "sent", "failed", "needs_review"] })
    .notNull()
    .default("pending"),
  attempts: integer("attempts").notNull().default(0),
  claimToken: text("claim_token"),
  claimedAt: timestamp("claimed_at", { withTimezone: true }),
  providerId: text("provider_id"),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  lastError: text("last_error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("delivery_organization_published_notifications_gallery_unique").on(table.galleryId),
]);

export const insertDeliveryOrganizationPublishedNotificationSchema = createInsertSchema(
  deliveryOrganizationPublishedNotificationsTable,
).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertDeliveryOrganizationPublishedNotification = z.infer<
  typeof insertDeliveryOrganizationPublishedNotificationSchema
>;
export type DeliveryOrganizationPublishedNotification =
  typeof deliveryOrganizationPublishedNotificationsTable.$inferSelect;
