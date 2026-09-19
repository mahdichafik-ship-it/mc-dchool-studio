import { sql } from "drizzle-orm";
import { index, pgTable, serial, text, timestamp, integer, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { projectsTable } from "./projects";
import { classesTable } from "./classes";

export const studentsTable = pgTable("students", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id")
    .notNull()
    .references(() => projectsTable.id, { onDelete: "cascade" }),
  classId: integer("class_id")
    .notNull()
    .references(() => classesTable.id, { onDelete: "cascade" }),
  firstName: text("first_name").notNull(),
  lastName: text("last_name").notNull(),
  generatedStudentId: text("generated_student_id").notNull(),
  /** School-supplied identifier; never replaces generatedStudentId. */
  schoolId: text("school_id"),
  email: text("email"),
  phone: text("phone"),
  secondaryEmail: text("secondary_email"),
  guardianFirstName: text("guardian_first_name"),
  guardianLastName: text("guardian_last_name"),
  company: text("company"),
  addressLine1: text("address_line_1"),
  addressLine2: text("address_line_2"),
  city: text("city"),
  stateProvince: text("state_province"),
  zipPostalCode: text("zip_postal_code"),
  country: text("country"),
  contactNote: text("contact_note"),
  jobTitle: text("job_title"),
  officeLocation: text("office_location"),
  photoSession: text("photo_session"),
  captureNotes: text("capture_notes"),
  simpleQr: text("simple_qr"),
  jsonQr: text("json_qr"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  // A roster code is only meaningful inside its project.  lower() makes the
  // invariant match QR/file matching, which is deliberately case-insensitive.
  uniqueIndex("students_project_generated_student_id_ci").on(
    table.projectId,
    sql`lower(${table.generatedStudentId})`,
  ),
  index("students_project_class_idx").on(table.projectId, table.classId),
]);

export const insertStudentSchema = createInsertSchema(studentsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertStudent = z.infer<typeof insertStudentSchema>;
export type Student = typeof studentsTable.$inferSelect;
