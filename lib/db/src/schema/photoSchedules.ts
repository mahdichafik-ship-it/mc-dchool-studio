import { index, integer, jsonb, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { projectsTable } from "./projects";

export const projectPhotoSchedulesTable = pgTable("project_photo_schedules", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id").notNull().references(() => projectsTable.id, { onDelete: "cascade" }),
  revision: integer("revision").notNull().default(1),
  schedule: jsonb("schedule").notNull(),
  clientAcceptedRevision: integer("client_accepted_revision"),
  clientAcceptedAt: timestamp("client_accepted_at", { withTimezone: true }),
  clientAcceptedByName: text("client_accepted_by_name"),
  clientAcceptedByEmail: text("client_accepted_by_email"),
  studioAcceptedRevision: integer("studio_accepted_revision"),
  studioAcceptedAt: timestamp("studio_accepted_at", { withTimezone: true }),
  studioAcceptedByUserId: text("studio_accepted_by_user_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("project_photo_schedules_project_unique").on(table.projectId),
]);

export const projectPhotoScheduleAllocationRevisionsTable = pgTable("project_photo_schedule_allocation_revisions", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id").notNull().references(() => projectsTable.id, { onDelete: "cascade" }),
  revision: integer("revision").notNull(),
  allocation: jsonb("allocation").notNull(),
  actorUserId: text("actor_user_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("project_photo_schedule_allocation_revisions_project_revision_unique").on(table.projectId, table.revision),
  index("project_photo_schedule_allocation_revisions_project_idx").on(table.projectId, table.revision),
]);

export const projectPhotoScheduleRevisionsTable = pgTable("project_photo_schedule_revisions", {
  id: serial("id").primaryKey(),
  scheduleId: integer("schedule_id").notNull().references(() => projectPhotoSchedulesTable.id, { onDelete: "cascade" }),
  revision: integer("revision").notNull(),
  schedule: jsonb("schedule").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("project_photo_schedule_revisions_schedule_revision_unique").on(table.scheduleId, table.revision),
  index("project_photo_schedule_revisions_schedule_idx").on(table.scheduleId, table.revision),
]);

export const projectPhotoScheduleEventsTable = pgTable("project_photo_schedule_events", {
  id: serial("id").primaryKey(),
  scheduleId: integer("schedule_id").notNull().references(() => projectPhotoSchedulesTable.id, { onDelete: "cascade" }),
  revision: integer("revision").notNull(),
  eventType: text("event_type").notNull(),
  actorType: text("actor_type").notNull(),
  actorUserId: text("actor_user_id"),
  actorName: text("actor_name"),
  actorEmail: text("actor_email"),
  message: text("message"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("project_photo_schedule_events_schedule_idx").on(table.scheduleId, table.id),
]);
