import { jsonb, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { projectsTable } from "./projects";

export const deliveryProductProofLayoutsTable = pgTable("delivery_product_proof_layouts", {
  projectId: integer("project_id")
    .primaryKey()
    .references(() => projectsTable.id, { onDelete: "cascade" }),
  layout: jsonb("layout").$type<Record<string, unknown>>().notNull(),
  updatedBy: text("updated_by").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type DeliveryProductProofLayout = typeof deliveryProductProofLayoutsTable.$inferSelect;
