import { integer, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { studioMembersTable, studiosTable } from "./studios";

export const studioStorageConnectionsTable = pgTable("studio_storage_connections", {
  id: serial("id").primaryKey(),
  studioId: integer("studio_id").notNull().references(() => studiosTable.id, { onDelete: "cascade" }),
  provider: text("provider", { enum: ["google_drive", "dropbox"] }).notNull(),
  providerAccountId: text("provider_account_id").notNull(),
  providerAccountEmail: text("provider_account_email").notNull(),
  encryptedCredentials: text("encrypted_credentials"),
  status: text("status", { enum: ["active", "revoked", "error"] }).notNull().default("active"),
  connectedByMemberId: integer("connected_by_member_id").references(() => studioMembersTable.id, { onDelete: "set null" }),
  lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  disconnectedAt: timestamp("disconnected_at", { withTimezone: true }),
}, (table) => [
  uniqueIndex("studio_storage_connections_studio_provider_unique").on(table.studioId, table.provider),
]);

export const studioStorageOauthStatesTable = pgTable("studio_storage_oauth_states", {
  id: serial("id").primaryKey(),
  studioId: integer("studio_id").notNull().references(() => studiosTable.id, { onDelete: "cascade" }),
  memberId: integer("member_id").notNull().references(() => studioMembersTable.id, { onDelete: "cascade" }),
  provider: text("provider", { enum: ["google_drive", "dropbox"] }).notNull(),
  stateHash: text("state_hash").notNull().unique(),
  encryptedCodeVerifier: text("encrypted_code_verifier").notNull(),
  redirectUri: text("redirect_uri").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const studioStorageAuditTable = pgTable("studio_storage_audit", {
  id: serial("id").primaryKey(),
  studioId: integer("studio_id").notNull().references(() => studiosTable.id, { onDelete: "cascade" }),
  actorMemberId: integer("actor_member_id").references(() => studioMembersTable.id, { onDelete: "set null" }),
  action: text("action", {
    enum: ["connection_started", "connected", "disconnected", "connection_failed", "fallback_selected"],
  }).notNull(),
  provider: text("provider", { enum: ["platform_google_drive", "google_drive", "dropbox"] }).notNull(),
  providerAccountId: text("provider_account_id"),
  providerAccountEmail: text("provider_account_email"),
  detail: text("detail"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});