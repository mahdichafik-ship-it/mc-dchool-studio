import { index, integer, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { studiosTable, studioMembersTable } from "./studios";

export const studioNotificationSettingsTable = pgTable("studio_notification_settings", {
  id: serial("id").primaryKey(),
  studioId: integer("studio_id").notNull().references(() => studiosTable.id, { onDelete: "cascade" }),
  notificationEmail: text("notification_email").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("studio_notification_settings_studio_unique").on(table.studioId),
]);

export const studioNotificationRecipientsTable = pgTable("studio_notification_recipients", {
  id: serial("id").primaryKey(),
  studioId: integer("studio_id").notNull().references(() => studiosTable.id, { onDelete: "cascade" }),
  memberId: integer("member_id").notNull().references(() => studioMembersTable.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("studio_notification_recipients_studio_member_unique").on(table.studioId, table.memberId),
  index("studio_notification_recipients_studio_idx").on(table.studioId),
]);
