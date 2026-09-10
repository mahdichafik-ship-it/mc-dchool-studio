import { pgTable, serial, text, timestamp, integer, uniqueIndex } from "drizzle-orm/pg-core";
import { projectsTable } from "./projects";
import { studiosTable } from "./studios";
import { studentsTable } from "./students";

export const deliveryGalleriesTable = pgTable("delivery_galleries", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id")
    .notNull()
    .references(() => projectsTable.id, { onDelete: "cascade" }),
  studioId: integer("studio_id")
    .references(() => studiosTable.id, { onDelete: "set null" }),
  slug: text("slug").notNull().unique(),
  status: text("status", { enum: ["draft", "published", "revoked"] })
    .notNull()
    .default("draft"),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("delivery_galleries_project_unique").on(table.projectId),
]);

export const deliveryAccessesTable = pgTable("delivery_accesses", {
  id: serial("id").primaryKey(),
  galleryId: integer("gallery_id")
    .notNull()
    .references(() => deliveryGalleriesTable.id, { onDelete: "cascade" }),
  studentId: integer("student_id")
    .notNull()
    .references(() => studentsTable.id, { onDelete: "cascade" }),
  accessCodeHash: text("access_code_hash").notNull(),
  accessCodeEncrypted: text("access_code_encrypted").notNull(),
  accessCodeLast4: text("access_code_last4").notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("delivery_accesses_gallery_student_unique").on(table.galleryId, table.studentId),
]);

export type DeliveryGallery = typeof deliveryGalleriesTable.$inferSelect;
export type DeliveryAccess = typeof deliveryAccessesTable.$inferSelect;