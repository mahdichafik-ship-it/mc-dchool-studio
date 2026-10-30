import { pgTable, serial, integer, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { projectsTable } from "./projects";
import { studentsTable } from "./students";

export const deliveryProductProofsTable = pgTable("delivery_product_proofs", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id")
    .notNull()
    .references(() => projectsTable.id, { onDelete: "cascade" }),
  studentId: integer("student_id")
    .notNull()
    .references(() => studentsTable.id, { onDelete: "cascade" }),
  kind: text("kind", { enum: ["composite", "calendar"] }).notNull(),
  state: text("state", { enum: ["pending_review", "approved"] })
    .notNull()
    .default("pending_review"),
  sourceManifestHash: text("source_manifest_hash").notNull(),
  sourceManifestJson: text("source_manifest_json").notNull(),
  objectKey: text("object_key").notNull(),
  fileSize: integer("file_size").notNull(),
  sha256: text("sha256").notNull(),
  previewObjectKey: text("preview_object_key"),
  previewFileSize: integer("preview_file_size"),
  previewSha256: text("preview_sha256"),
  generatedBy: text("generated_by").notNull(),
  generatedAt: timestamp("generated_at", { withTimezone: true }).notNull().defaultNow(),
  approvedBy: text("approved_by"),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
}, (table) => [
  uniqueIndex("delivery_product_proofs_student_kind_unique")
    .on(table.projectId, table.studentId, table.kind),
]);

export type DeliveryProductProof = typeof deliveryProductProofsTable.$inferSelect;
