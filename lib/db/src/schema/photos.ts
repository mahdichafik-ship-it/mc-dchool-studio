import { pgTable, serial, text, timestamp, integer } from "drizzle-orm/pg-core";
import { projectsTable } from "./projects";
import { studentsTable } from "./students";

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
  mimeType: text("mime_type").notNull().default("image/jpeg"),
  capturedAt: text("captured_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type StudentPhoto = typeof studentPhotosTable.$inferSelect;
