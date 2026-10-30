import { boolean, index, integer, jsonb, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { projectsTable } from "./projects";
import { studiosTable } from "./studios";

export const studioEmailTemplatesTable = pgTable("studio_email_templates", {
  id: serial("id").primaryKey(),
  studioId: integer("studio_id").notNull().references(() => studiosTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  emailType: text("email_type").notNull(),
  projectType: text("project_type").notNull(),
  status: text("status").notNull().default("active"),
  version: integer("version").notNull().default(1),
  translations: jsonb("translations").notNull().default({}),
  createdByUserId: text("created_by_user_id").notNull(),
  updatedByUserId: text("updated_by_user_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("studio_email_templates_studio_idx").on(table.studioId, table.status),
]);

export const studioEmailTemplateVersionsTable = pgTable("studio_email_template_versions", {
  id: serial("id").primaryKey(),
  studioId: integer("studio_id").notNull().references(() => studiosTable.id, { onDelete: "cascade" }),
  templateId: integer("template_id").notNull().references(() => studioEmailTemplatesTable.id, { onDelete: "cascade" }),
  version: integer("version").notNull(),
  snapshot: jsonb("snapshot").notNull(),
  changedByUserId: text("changed_by_user_id").notNull(),
  changedAt: timestamp("changed_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("studio_email_template_versions_unique").on(table.templateId, table.version),
  index("studio_email_template_versions_studio_idx").on(table.studioId, table.templateId),
]);

export const studioEmailTemplateDefaultsTable = pgTable("studio_email_template_defaults", {
  id: serial("id").primaryKey(),
  studioId: integer("studio_id").notNull().references(() => studiosTable.id, { onDelete: "cascade" }),
  projectType: text("project_type").notNull(),
  emailType: text("email_type").notNull(),
  templateId: integer("template_id").references(() => studioEmailTemplatesTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("studio_email_template_defaults_unique").on(table.studioId, table.projectType, table.emailType),
]);

export const projectEmailSettingsTable = pgTable("project_email_settings", {
  projectId: integer("project_id").primaryKey().references(() => projectsTable.id, { onDelete: "cascade" }),
  studioId: integer("studio_id").notNull().references(() => studiosTable.id, { onDelete: "cascade" }),
  rosterReminderAfterDays: integer("roster_reminder_after_days").notNull().default(7),
  photoDayReminderLeadDays: integer("photo_day_reminder_lead_days").notNull().default(7),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("project_email_settings_studio_idx").on(table.studioId),
]);

export const projectEmailSelectionsTable = pgTable("project_email_selections", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id").notNull().references(() => projectsTable.id, { onDelete: "cascade" }),
  studioId: integer("studio_id").notNull().references(() => studiosTable.id, { onDelete: "cascade" }),
  emailType: text("email_type").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  templateId: integer("template_id").references(() => studioEmailTemplatesTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("project_email_selections_unique").on(table.projectId, table.emailType),
  index("project_email_selections_studio_idx").on(table.studioId, table.emailType),
]);

export const projectEmailCommunicationsTable = pgTable("project_email_communications", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id").notNull().references(() => projectsTable.id, { onDelete: "cascade" }),
  studioId: integer("studio_id").notNull().references(() => studiosTable.id, { onDelete: "cascade" }),
  emailType: text("email_type").notNull(),
  sendReason: text("send_reason").notNull(),
  recipientKind: text("recipient_kind").notNull().default("project_contact"),
  recipientStudioMemberId: integer("recipient_studio_member_id"),
  language: text("language").notNull(),
  status: text("status").notNull().default("pending"),
  eventKey: text("event_key").notNull(),
  messageSnapshotEncrypted: text("message_snapshot_encrypted"),
  recipientEmail: text("recipient_email"),
  templateId: integer("template_id"),
  templateName: text("template_name").notNull(),
  templateVersion: integer("template_version"),
  subject: text("subject"),
  html: text("html"),
  bodyText: text("body_text"),
  createdByUserId: text("created_by_user_id"),
  createdByName: text("created_by_name"),
  scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  providerId: text("provider_id"),
  attempts: integer("attempts").notNull().default(0),
  claimToken: text("claim_token"),
  claimedAt: timestamp("claimed_at", { withTimezone: true }),
  lastError: text("last_error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("project_email_communications_event_unique").on(table.projectId, table.eventKey),
  index("project_email_communications_outbox_idx").on(table.status, table.scheduledAt, table.id),
  index("project_email_communications_studio_idx").on(table.studioId, table.projectId, table.createdAt),
]);

export const projectScheduleNotificationRecipientsTable = pgTable("project_schedule_notification_recipients", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id").notNull().references(() => projectsTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  emailEncrypted: text("email_encrypted").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("project_schedule_notification_recipients_project_idx").on(table.projectId, table.id),
]);
