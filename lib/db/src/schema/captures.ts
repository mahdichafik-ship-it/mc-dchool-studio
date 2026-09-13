import {
  boolean,
  integer,
  pgTable,
  real,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { projectsTable } from "./projects";
import { studentsTable } from "./students";
import { desktopConnectionsTable, studioMembersTable } from "./studios";

export const captureBatchesTable = pgTable("capture_batches", {
  id: serial("id").primaryKey(),
  batchKey: text("batch_key").notNull(),
  projectId: integer("project_id")
    .notNull()
    .references(() => projectsTable.id, { onDelete: "cascade" }),
  memberId: integer("member_id")
    .notNull()
    .references(() => studioMembersTable.id, { onDelete: "cascade" }),
  desktopConnectionId: integer("desktop_connection_id")
    .notNull()
    .references(() => desktopConnectionsTable.id, { onDelete: "cascade" }),
  status: text("status", { enum: ["uploading", "failed", "complete"] }).notNull().default("uploading"),
  expectedFileCount: integer("expected_file_count").notNull().default(0),
  uploadedFileCount: integer("uploaded_file_count").notNull().default(0),
  failedFileCount: integer("failed_file_count").notNull().default(0),
  handoffComment: text("handoff_comment"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  lastSyncAt: timestamp("last_sync_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
}, (table) => [
  uniqueIndex("capture_batches_project_key_unique").on(table.projectId, table.batchKey),
]);

export const capturesTable = pgTable("captures", {
  id: serial("id").primaryKey(),
  captureKey: text("capture_key").notNull(),
  projectId: integer("project_id")
    .notNull()
    .references(() => projectsTable.id, { onDelete: "cascade" }),
  studentId: integer("student_id")
    .notNull()
    .references(() => studentsTable.id, { onDelete: "cascade" }),
  baseFilename: text("base_filename").notNull(),
  capturedAt: text("captured_at"),
  sequence: integer("sequence"),
  pairingStatus: text("pairing_status").notNull().default("pending"),
  favorite: boolean("favorite").notNull().default(false),
  rejected: boolean("rejected").notNull().default(false),
  selected: boolean("selected").notNull().default(false),
  rating: integer("rating").notNull().default(0),
  colorLabel: text("color_label", {
    enum: ["none", "red", "yellow", "green", "blue", "purple"],
  }).notNull().default("none"),
  // Edits are deliberately nullable: null means identity and keeps captures
  // uploaded by older desktop clients backwards compatible.
  cropPositionX: real("crop_position_x"),
  cropPositionY: real("crop_position_y"),
  cropScale: real("crop_scale"),
  aspectRatio: text("aspect_ratio"),
  straightenAngle: real("straighten_angle"),
  rotation: integer("rotation"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("captures_project_capture_key_unique")
    .on(table.projectId, table.captureKey),
]);

export const captureFilesTable = pgTable("capture_files", {
  id: serial("id").primaryKey(),
  captureId: integer("capture_id")
    .notNull()
    .references(() => capturesTable.id, { onDelete: "cascade" }),
  fileRole: text("file_role").notNull(),
  fileFormat: text("file_format").notNull(),
  originalFilename: text("original_filename").notNull(),
  fileUrl: text("file_url").notNull(),
  durableObjectPath: text("durable_object_path"),
  mimeType: text("mime_type").notNull(),
  fileSize: integer("file_size"),
  captureBatchId: integer("capture_batch_id")
    .references(() => captureBatchesTable.id, { onDelete: "set null" }),
  desktopConnectionId: integer("desktop_connection_id"),
  clientUploadId: text("client_upload_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("capture_files_capture_role_unique")
    .on(table.captureId, table.fileRole),
  uniqueIndex("capture_files_desktop_upload_unique")
    .on(table.desktopConnectionId, table.clientUploadId),
]);

export type Capture = typeof capturesTable.$inferSelect;
export type CaptureFile = typeof captureFilesTable.$inferSelect;
export type CaptureBatch = typeof captureBatchesTable.$inferSelect;