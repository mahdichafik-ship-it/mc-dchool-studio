import { boolean, integer, pgTable, serial, text, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { studiosTable } from "./studios";
import { deliveryGalleriesTable, deliveryAccessesTable } from "./deliveries";
import { projectsTable } from "./projects";

export const marketingContactsTable = pgTable("marketing_contacts", {
  id: serial("id").primaryKey(),
  studioId: integer("studio_id").notNull().references(() => studiosTable.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  successfulGalleryAccesses: integer("successful_gallery_accesses").notNull().default(0),
  marketingConsent: boolean("marketing_consent"),
  consentAt: timestamp("consent_at", { withTimezone: true }),
  consentSource: text("consent_source"),
  unsubscribedAt: timestamp("unsubscribed_at", { withTimezone: true }),
  lastOrderAt: timestamp("last_order_at", { withTimezone: true }),
}, (table) => [
  uniqueIndex("marketing_contacts_studio_email_unique").on(table.studioId, table.email),
  index("marketing_contacts_studio_last_seen_idx").on(table.studioId, table.lastSeenAt),
]);

export const marketingVisitsTable = pgTable("marketing_visits", {
  id: serial("id").primaryKey(),
  contactId: integer("contact_id").notNull().references(() => marketingContactsTable.id, { onDelete: "cascade" }),
  galleryId: integer("gallery_id").notNull().references(() => deliveryGalleriesTable.id, { onDelete: "cascade" }),
  accessId: integer("access_id").notNull().references(() => deliveryAccessesTable.id, { onDelete: "cascade" }),
  projectId: integer("project_id").notNull().references(() => projectsTable.id, { onDelete: "cascade" }),
  studioId: integer("studio_id").notNull().references(() => studiosTable.id, { onDelete: "cascade" }),
  visitedAt: timestamp("visited_at", { withTimezone: true }).notNull().defaultNow(),
  sessionMarker: text("session_marker"),
}, (table) => [
  index("marketing_visits_studio_visited_idx").on(table.studioId, table.visitedAt),
  index("marketing_visits_contact_idx").on(table.contactId),
]);

export const marketingTemplatesTable = pgTable("marketing_templates", {
  id: serial("id").primaryKey(),
  studioId: integer("studio_id").notNull().references(() => studiosTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  subject: text("subject").notNull(),
  bodyText: text("body_text").notNull(),
  category: text("category").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("marketing_templates_studio_name_unique").on(table.studioId, table.name),
]);

export const marketingCampaignsTable = pgTable("marketing_campaigns", {
  id: serial("id").primaryKey(),
  studioId: integer("studio_id").notNull().references(() => studiosTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  templateId: integer("template_id").notNull().references(() => marketingTemplatesTable.id, { onDelete: "restrict" }),
  audienceFilterSnapshot: text("audience_filter_snapshot").notNull(),
  recipientCount: integer("recipient_count").notNull().default(0),
  status: text("status", { enum: ["draft"] }).notNull().default("draft"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type MarketingContact = typeof marketingContactsTable.$inferSelect;
export type MarketingVisit = typeof marketingVisitsTable.$inferSelect;
export type MarketingTemplate = typeof marketingTemplatesTable.$inferSelect;
export type MarketingCampaign = typeof marketingCampaignsTable.$inferSelect;