import { createInsertSchema } from "drizzle-zod";
import { integer, jsonb, pgTable, serial, text, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { z } from "zod/v4";
import { deliveryGalleriesTable } from "./deliveries";
import { projectsTable } from "./projects";

export type DeliveryOrganizationRosterWorkbookSheet = {
  name: string;
  headers: string[];
  rows: string[][];
};

export type DeliveryOrganizationRosterWorkbook = {
  sheets: DeliveryOrganizationRosterWorkbookSheet[];
};

export const deliveryOrganizationRostersTable = pgTable("delivery_organization_rosters", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id")
    .notNull()
    .references(() => projectsTable.id, { onDelete: "cascade" }),
  galleryId: integer("gallery_id")
    .notNull()
    .references(() => deliveryGalleriesTable.id, { onDelete: "cascade" }),
  status: text("status", {
    enum: ["awaiting_upload", "submitted", "approved", "changes_requested", "imported"],
  }).notNull().default("awaiting_upload"),
  contactName: text("contact_name"),
  contactEmail: text("contact_email"),
  fileName: text("file_name"),
  fileSize: integer("file_size"),
  contentType: text("content_type"),
  objectKey: text("object_key"),
  sha256: text("sha256"),
  submittedAt: timestamp("submitted_at", { withTimezone: true }),
  sheetCount: integer("sheet_count"),
  rowCount: integer("row_count"),
  workbookData: jsonb("workbook_data").$type<DeliveryOrganizationRosterWorkbook | null>(),
  reviewMessage: text("review_message"),
  reviewedBy: text("reviewed_by"),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  importedAt: timestamp("imported_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("delivery_organization_rosters_project_unique").on(table.projectId),
  uniqueIndex("delivery_organization_rosters_gallery_unique").on(table.galleryId),
  index("delivery_organization_rosters_status_idx").on(table.status, table.updatedAt),
]);

export const insertDeliveryOrganizationRosterSchema = createInsertSchema(deliveryOrganizationRostersTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertDeliveryOrganizationRoster = z.infer<typeof insertDeliveryOrganizationRosterSchema>;
export type DeliveryOrganizationRoster = typeof deliveryOrganizationRostersTable.$inferSelect;
