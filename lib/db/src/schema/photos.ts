import { boolean, pgTable, serial, text, timestamp, integer, uniqueIndex } from "drizzle-orm/pg-core";
import { projectsTable } from "./projects";
import { studentsTable } from "./students";
import { captureBatchesTable } from "./captures";
import { groupCaptureFilesTable } from "./groups";

export const studentPhotosTable = pgTable("student_photos", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id")
    .notNull()
    .references(() => projectsTable.id, { onDelete: "cascade" }),
  studentId: integer("student_id")
    .notNull()
    .references(() => studentsTable.id, { onDelete: "cascade" }),
  fileName: text("file_name").notNull(),
  fileUrl: text("file_url").notNull(),
  durableObjectPath: text("durable_object_path"),
  mimeType: text("mime_type").notNull().default("image/jpeg"),
  capturedAt: text("captured_at"),
  captureBatchId: integer("capture_batch_id")
    .references(() => captureBatchesTable.id, { onDelete: "set null" }),
  desktopConnectionId: integer("desktop_connection_id"),
  clientUploadId: text("client_upload_id"),
  sourceGroupCaptureFileId: integer("source_group_capture_file_id")
    .references(() => groupCaptureFilesTable.id, { onDelete: "cascade" }),
  rating: integer("rating").notNull().default(0),
  colorLabel: text("color_label", { enum: ["none", "red", "yellow", "green", "blue", "purple"] }).notNull().default("none"),
  shareWithParents: boolean("share_with_parents").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("student_photos_desktop_upload_unique")
    .on(table.desktopConnectionId, table.clientUploadId),
  uniqueIndex("student_photos_group_file_student_unique")
    .on(table.sourceGroupCaptureFileId, table.studentId),
]);

export type StudentPhoto = typeof studentPhotosTable.$inferSelect;
