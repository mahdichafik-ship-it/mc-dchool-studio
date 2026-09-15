import { boolean, integer, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { projectsTable } from "./projects";
import { classesTable } from "./classes";
import { studentsTable } from "./students";
import { captureBatchesTable } from "./captures";
import { desktopConnectionsTable } from "./studios";

export const groupsTable = pgTable("groups", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id").notNull().references(() => projectsTable.id, { onDelete: "cascade" }),
  classId: integer("class_id").references(() => classesTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  isDefaultClassGroup: boolean("is_default_class_group").notNull().default(false),
  desktopConnectionId: integer("desktop_connection_id").references(() => desktopConnectionsTable.id, { onDelete: "set null" }),
  clientGroupId: text("client_group_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("groups_one_default_per_class").on(table.classId).where(sql`${table.isDefaultClassGroup} = true`),
  uniqueIndex("groups_desktop_connection_client_unique").on(table.desktopConnectionId, table.clientGroupId),
]);

export const groupMembersTable = pgTable("group_members", {
  id: serial("id").primaryKey(),
  groupId: integer("group_id").notNull().references(() => groupsTable.id, { onDelete: "cascade" }),
  studentId: integer("student_id").notNull().references(() => studentsTable.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("group_members_group_student_unique").on(table.groupId, table.studentId),
]);

export const groupMemberExclusionsTable = pgTable("group_member_exclusions", {
  id: serial("id").primaryKey(),
  groupId: integer("group_id").notNull().references(() => groupsTable.id, { onDelete: "cascade" }),
  studentId: integer("student_id").notNull().references(() => studentsTable.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("group_member_exclusions_group_student_unique").on(table.groupId, table.studentId),
]);

export const groupCapturesTable = pgTable("group_captures", {
  id: serial("id").primaryKey(),
  captureKey: text("capture_key").notNull(),
  projectId: integer("project_id").notNull().references(() => projectsTable.id, { onDelete: "cascade" }),
  groupId: integer("group_id").notNull().references(() => groupsTable.id, { onDelete: "cascade" }),
  baseFilename: text("base_filename").notNull(),
  capturedAt: text("captured_at"),
  sequence: integer("sequence"),
  pairingStatus: text("pairing_status").notNull().default("pending"),
  reviewStatus: text("review_status").notNull().default("pending"),
  favorite: boolean("favorite").notNull().default(false),
  rejected: boolean("rejected").notNull().default(false),
  selected: boolean("selected").notNull().default(false),
  rating: integer("rating").notNull().default(0),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("group_captures_project_capture_key_unique").on(table.projectId, table.captureKey),
]);

export const groupCaptureFilesTable = pgTable("group_capture_files", {
  id: serial("id").primaryKey(),
  captureId: integer("capture_id").notNull().references(() => groupCapturesTable.id, { onDelete: "cascade" }),
  fileRole: text("file_role").notNull(),
  fileFormat: text("file_format").notNull(),
  originalFilename: text("original_filename").notNull(),
  fileUrl: text("file_url").notNull(),
  durableObjectPath: text("durable_object_path"),
  mimeType: text("mime_type").notNull(),
  fileSize: integer("file_size"),
  captureBatchId: integer("capture_batch_id").references(() => captureBatchesTable.id, { onDelete: "set null" }),
  desktopConnectionId: integer("desktop_connection_id").references(() => desktopConnectionsTable.id, { onDelete: "set null" }),
  clientUploadId: text("client_upload_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("group_capture_files_capture_role_unique").on(table.captureId, table.fileRole),
  uniqueIndex("group_capture_files_desktop_upload_unique").on(table.desktopConnectionId, table.clientUploadId),
]);

export type Group = typeof groupsTable.$inferSelect;
export type GroupMember = typeof groupMembersTable.$inferSelect;
export type GroupCapture = typeof groupCapturesTable.$inferSelect;
export type GroupCaptureFile = typeof groupCaptureFilesTable.$inferSelect;