import { index, integer, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { projectsTable } from "./projects";
import { studentsTable } from "./students";

export const deliveryProductProofRegenerationOutboxTable = pgTable(
  "delivery_product_proof_regeneration_outbox",
  {
    id: serial("id").primaryKey(),
    projectId: integer("project_id")
      .notNull()
      .references(() => projectsTable.id, { onDelete: "cascade" }),
    studentId: integer("student_id")
      .notNull()
      .references(() => studentsTable.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["composite", "calendar"] }).notNull(),
    state: text("state", { enum: ["pending", "processing", "failed", "complete"] })
      .notNull()
      .default("pending"),
    attempts: integer("attempts").notNull().default(0),
    claimToken: text("claim_token"),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("delivery_product_proof_regeneration_student_kind_unique")
      .on(table.projectId, table.studentId, table.kind),
    index("delivery_product_proof_regeneration_due_idx")
      .on(table.state, table.nextAttemptAt, table.id),
  ],
);

export type DeliveryProductProofRegenerationJob =
  typeof deliveryProductProofRegenerationOutboxTable.$inferSelect;
