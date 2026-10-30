import { integer, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { projectsTable } from "./projects";
import { groupsTable } from "./groups";

export const classPhotoLayoutsTable = pgTable("class_photo_layouts", {
  projectId: integer("project_id")
    .primaryKey()
    .references(() => projectsTable.id, { onDelete: "cascade" }),
  settingsJson: text("settings_json").notNull(),
  updatedBy: text("updated_by").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const classPhotoProofsTable = pgTable("class_photo_proofs", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id")
    .notNull()
    .references(() => projectsTable.id, { onDelete: "cascade" }),
  groupId: integer("group_id")
    .notNull()
    .references(() => groupsTable.id, { onDelete: "cascade" }),
  revision: integer("revision").notNull(),
  state: text("state", { enum: ["pending_review", "approved", "revoked"] })
    .notNull()
    .default("pending_review"),
  sourceManifestHash: text("source_manifest_hash").notNull(),
  sourceManifestJson: text("source_manifest_json").notNull(),
  objectKey: text("object_key").notNull(),
  fileSize: integer("file_size").notNull(),
  sha256: text("sha256").notNull(),
  previewObjectKey: text("preview_object_key").notNull(),
  previewFileSize: integer("preview_file_size").notNull(),
  previewSha256: text("preview_sha256").notNull(),
  generatedBy: text("generated_by").notNull(),
  generatedAt: timestamp("generated_at", { withTimezone: true }).notNull().defaultNow(),
  approvedBy: text("approved_by"),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  revokedBy: text("revoked_by"),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
}, (table) => [
  uniqueIndex("class_photo_proofs_group_revision_unique").on(table.projectId, table.groupId, table.revision),
]);

export type ClassPhotoLayout = typeof classPhotoLayoutsTable.$inferSelect;
export type ClassPhotoProof = typeof classPhotoProofsTable.$inferSelect;
