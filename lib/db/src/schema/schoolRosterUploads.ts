import { index, integer, jsonb, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { projectsTable } from "./projects";

export const schoolRosterUploadsTable = pgTable("school_roster_uploads", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id").notNull().references(() => projectsTable.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull(),
  status: text("status").notNull().default("awaiting_upload"),
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  contactName: text("contact_name"),
  contactEmail: text("contact_email"),
  fileName: text("file_name"),
  fileSize: integer("file_size"),
  submittedAt: timestamp("submitted_at", { withTimezone: true }),
  sheetCount: integer("sheet_count"),
  rowCount: integer("row_count"),
  workbookData: jsonb("workbook_data"),
  reviewMessage: text("review_message"),
  reviewedBy: text("reviewed_by"),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  importedAt: timestamp("imported_at", { withTimezone: true }),
}, (table) => [
  uniqueIndex("school_roster_uploads_project_unique").on(table.projectId),
  uniqueIndex("school_roster_uploads_token_hash_unique").on(table.tokenHash),
  index("school_roster_uploads_status_idx").on(table.status, table.updatedAt),
]);
