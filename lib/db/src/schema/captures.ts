import {
  boolean,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { projectsTable } from "./projects";
import { studentsTable } from "./students";

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
  mimeType: text("mime_type").notNull(),
  fileSize: integer("file_size"),
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