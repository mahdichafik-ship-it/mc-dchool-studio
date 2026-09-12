import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { captureFilesTable } from "./captures";
import { groupCaptureFilesTable } from "./groups";
import { studentPhotosTable } from "./photos";

export const photoStorageCopiesTable = pgTable(
  "photo_storage_copies",
  {
    id: serial("id").primaryKey(),
    studentPhotoId: integer("student_photo_id").references(
      () => studentPhotosTable.id,
      { onDelete: "cascade" },
    ),
    captureFileId: integer("capture_file_id").references(
      () => captureFilesTable.id,
      { onDelete: "cascade" },
    ),
    groupCaptureFileId: integer("group_capture_file_id").references(
      () => groupCaptureFilesTable.id,
      { onDelete: "cascade" },
    ),
    destination: text("destination", {
      enum: ["replit", "r2", "google_drive", "dropbox"],
    }).notNull(),
    objectKey: text("object_key").notNull(),
    stagingObjectKey: text("staging_object_key"),
    providerObjectId: text("provider_object_id"),
    state: text("state", {
      enum: ["pending", "uploading", "ready", "failed"],
    })
      .notNull()
      .default("pending"),
    mimeType: text("mime_type"),
    fileSize: bigint("file_size", { mode: "number" }),
    sha256: text("sha256"),
    etag: text("etag"),
    attemptCount: integer("attempt_count").notNull().default(0),
    nextRetryAt: timestamp("next_retry_at", { withTimezone: true }),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    lastError: text("last_error"),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "photo_storage_copies_exactly_one_source",
      sql`num_nonnulls(${table.studentPhotoId}, ${table.captureFileId}, ${table.groupCaptureFileId}) = 1`,
    ),
    uniqueIndex("photo_storage_copies_student_destination_unique")
      .on(table.studentPhotoId, table.destination)
      .where(sql`${table.studentPhotoId} is not null`),
    uniqueIndex("photo_storage_copies_capture_destination_unique")
      .on(table.captureFileId, table.destination)
      .where(sql`${table.captureFileId} is not null`),
    uniqueIndex("photo_storage_copies_group_destination_unique")
      .on(table.groupCaptureFileId, table.destination)
      .where(sql`${table.groupCaptureFileId} is not null`),
    uniqueIndex("photo_storage_copies_destination_key_unique").on(
      table.destination,
      table.objectKey,
    ),
  ],
);

export type PhotoStorageCopy = typeof photoStorageCopiesTable.$inferSelect;
export type NewPhotoStorageCopy = typeof photoStorageCopiesTable.$inferInsert;