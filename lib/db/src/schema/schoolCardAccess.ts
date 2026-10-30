import { index, integer, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { projectsTable } from "./projects";

export const schoolCardAccessLinksTable = pgTable("school_card_access_links", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id").notNull().references(() => projectsTable.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  tokenHash: text("token_hash").notNull(),
  status: text("status").notNull().default("active"),
  deliveryStatus: text("delivery_status").notNull().default("pending"),
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
}, (table) => [
  uniqueIndex("school_card_access_links_token_hash_unique").on(table.tokenHash),
  index("school_card_access_links_project_status_idx").on(table.projectId, table.status),
  index("school_card_access_links_project_email_idx").on(table.projectId, table.email),
]);

export const schoolCardAccessChallengesTable = pgTable("school_card_access_challenges", {
  id: serial("id").primaryKey(),
  linkId: integer("link_id").notNull().references(() => schoolCardAccessLinksTable.id, { onDelete: "cascade" }),
  codeHash: text("code_hash").notNull(),
  attemptCount: integer("attempt_count").notNull().default(0),
  deliveryStatus: text("delivery_status").notNull().default("pending"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
}, (table) => [
  index("school_card_access_challenges_link_created_idx").on(table.linkId, table.createdAt),
]);

export const schoolCardAccessSessionsTable = pgTable("school_card_access_sessions", {
  id: serial("id").primaryKey(),
  linkId: integer("link_id").notNull().references(() => schoolCardAccessLinksTable.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
}, (table) => [
  uniqueIndex("school_card_access_sessions_token_hash_unique").on(table.tokenHash),
  index("school_card_access_sessions_link_idx").on(table.linkId, table.expiresAt),
]);
