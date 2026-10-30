import { index, integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { deliveryAccessesTable, deliveryGalleriesTable } from "./deliveries";
import { deliveryOrdersTable } from "./deliveryOrders";
import { projectsTable } from "./projects";
import { studiosTable } from "./studios";

export const deliveryStudioNotificationsTable = pgTable("delivery_studio_notifications", {
  id: serial("id").primaryKey(),
  studioId: integer("studio_id").notNull().references(() => studiosTable.id, { onDelete: "cascade" }),
  projectId: integer("project_id").notNull().references(() => projectsTable.id, { onDelete: "cascade" }),
  galleryId: integer("gallery_id").notNull().references(() => deliveryGalleriesTable.id, { onDelete: "cascade" }),
  accessId: integer("access_id").references(() => deliveryAccessesTable.id, { onDelete: "set null" }),
  orderId: integer("order_id").references(() => deliveryOrdersTable.id, { onDelete: "cascade" }),
  eventType: text("event_type", { enum: ["gallery_access", "order_received", "roster_uploaded"] }).notNull(),
  projectName: text("project_name").notNull(),
  gallerySlug: text("gallery_slug").notNull(),
  title: text("title").notNull(),
  message: text("message").notNull(),
  actorEmail: text("actor_email"),
  actorLabel: text("actor_label"),
  readAt: timestamp("read_at", { withTimezone: true }),
  emailStatus: text("email_status", { enum: ["pending", "sending", "sent", "failed", "needs_review"] })
    .notNull().default("pending"),
  emailAttempts: integer("email_attempts").notNull().default(0),
  emailClaimToken: text("email_claim_token"),
  emailClaimedAt: timestamp("email_claimed_at", { withTimezone: true }),
  emailProviderIds: text("email_provider_ids"),
  emailSentAt: timestamp("email_sent_at", { withTimezone: true }),
  emailLastError: text("email_last_error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("delivery_studio_notifications_project_created_idx").on(table.projectId, table.createdAt),
  index("delivery_studio_notifications_email_status_idx").on(table.emailStatus, table.createdAt),
]);

export type DeliveryStudioNotification = typeof deliveryStudioNotificationsTable.$inferSelect;
