import { integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { studiosTable } from "./studios";

export const platformActionAuditTable = pgTable("platform_action_audit", {
  id: serial("id").primaryKey(),
  actorUserId: text("actor_user_id").notNull(),
  studioId: integer("studio_id").references(() => studiosTable.id, { onDelete: "set null" }),
  action: text("action").notNull(),
  targetType: text("target_type").notNull(),
  targetId: text("target_id"),
  detail: text("detail"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});