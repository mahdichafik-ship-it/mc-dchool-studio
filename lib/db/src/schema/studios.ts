import { pgTable, serial, text, timestamp, integer, uniqueIndex } from "drizzle-orm/pg-core";

export const studiosTable = pgTable("studios", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  createdByUserId: text("created_by_user_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const studioMembersTable = pgTable("studio_members", {
  id: serial("id").primaryKey(),
  studioId: integer("studio_id").notNull().references(() => studiosTable.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull(),
  email: text("email").notNull(),
  displayName: text("display_name"),
  role: text("role", { enum: ["owner", "admin", "assistant", "photographer", "viewer"] }).notNull().default("photographer"),
  status: text("status", { enum: ["active", "removed"] }).notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex("studio_members_studio_user_unique").on(table.studioId, table.userId)]);

export const studioInvitesTable = pgTable("studio_invites", {
  id: serial("id").primaryKey(),
  studioId: integer("studio_id").notNull().references(() => studiosTable.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  role: text("role", { enum: ["admin", "assistant", "photographer", "viewer"] }).notNull().default("photographer"),
  code: text("code").notNull().unique(),
  status: text("status", { enum: ["pending", "accepted", "cancelled"] }).notNull().default("pending"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const projectAssignmentsTable = pgTable("project_assignments", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id").notNull(),
  memberId: integer("member_id").notNull().references(() => studioMembersTable.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex("project_assignments_project_member_unique").on(table.projectId, table.memberId)]);

export const desktopConnectionsTable = pgTable("desktop_connections", {
  id: serial("id").primaryKey(),
  studioId: integer("studio_id").notNull().references(() => studiosTable.id, { onDelete: "cascade" }),
  memberId: integer("member_id").notNull().references(() => studioMembersTable.id, { onDelete: "cascade" }),
  deviceName: text("device_name").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  tokenPrefix: text("token_prefix").notNull(),
  status: text("status", { enum: ["active", "revoked"] }).notNull().default("active"),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
});

export const desktopAuthSessionsTable = pgTable("desktop_auth_sessions", {
  id: serial("id").primaryKey(),
  publicCode: text("public_code").notNull().unique(),
  clientSecretHash: text("client_secret_hash").notNull(),
  memberId: integer("member_id").references(() => studioMembersTable.id, { onDelete: "cascade" }),
  status: text("status", { enum: ["pending", "approved", "used", "expired"] }).notNull().default("pending"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  usedAt: timestamp("used_at", { withTimezone: true }),
});