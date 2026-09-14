import {
  captureFilesTable,
  capturesTable,
  db,
  groupCaptureFilesTable,
  groupCapturesTable,
  groupsTable,
  photoStorageCopiesTable,
  projectsTable,
  r2PhotoDeletionOutboxTable,
  studentPhotosTable,
  studentsTable,
} from "@workspace/db";
import { randomUUID } from "node:crypto";
import {
  and,
  asc,
  eq,
  inArray,
  isNull,
  lte,
  or,
  sql,
} from "drizzle-orm";
import { deleteR2Object } from "./r2Storage";
import { listR2ObjectKeys } from "./r2Storage";
import {
  r2LegacyPhotoVariantPrefix,
  r2PhotoVariantPrefix,
} from "./photoVariants";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type SourceType = "student_photo" | "capture_file" | "group_capture_file";

const BATCH_SIZE = 20;
const STALE_CLAIM_MS = 5 * 60_000;
const MAX_RETRY_MS = 60 * 60_000;

export async function enqueueR2PhotoDeletions(
  tx: Transaction,
  sourceType: SourceType,
  sourceIds: number[],
): Promise<number> {
  const ids = [...new Set(sourceIds.filter((id) => Number.isInteger(id) && id > 0))];
  if (ids.length === 0) return 0;
  const sourceColumn =
    sourceType === "student_photo"
      ? photoStorageCopiesTable.studentPhotoId
      : sourceType === "capture_file"
        ? photoStorageCopiesTable.captureFileId
        : photoStorageCopiesTable.groupCaptureFileId;
  if (sourceType === "student_photo") {
    await tx.select({ id: studentPhotosTable.id }).from(studentPhotosTable)
      .where(inArray(studentPhotosTable.id, ids)).for("update");
  } else if (sourceType === "capture_file") {
    await tx.select({ id: captureFilesTable.id }).from(captureFilesTable)
      .where(inArray(captureFilesTable.id, ids)).for("update");
  } else {
    await tx.select({ id: groupCaptureFilesTable.id }).from(groupCaptureFilesTable)
      .where(inArray(groupCaptureFilesTable.id, ids)).for("update");
  }
  const copies = await tx
    .select({
      id: photoStorageCopiesTable.id,
      sourceId: sourceColumn,
      objectKey: photoStorageCopiesTable.objectKey,
      stagingObjectKey: photoStorageCopiesTable.stagingObjectKey,
    })
    .from(photoStorageCopiesTable)
    .where(
      and(
        eq(photoStorageCopiesTable.destination, "r2"),
        inArray(sourceColumn, ids),
      ),
    )
    .for("update");
  if (copies.length === 0) return 0;
  const objects = copies.flatMap((copy) => [
    {
      storageCopyId: copy.id,
      sourceType,
      sourceId: copy.sourceId!,
      objectKey: copy.objectKey,
      objectKind: "original" as const,
    },
    ...(copy.stagingObjectKey && copy.stagingObjectKey !== copy.objectKey
      ? [{
          storageCopyId: copy.id,
          sourceType,
          sourceId: copy.sourceId!,
          objectKey: copy.stagingObjectKey,
          objectKind: "staging" as const,
          // A presigned PUT can remain valid for 15 minutes. Wait until every
          // issued upload URL has expired before declaring the staging key gone.
          nextRetryAt: new Date(Date.now() + 16 * 60_000),
        }]
      : []),
  ]);
  await tx
    .insert(r2PhotoDeletionOutboxTable)
    .values(objects)
    .onConflictDoUpdate({
      target: [
        r2PhotoDeletionOutboxTable.storageCopyId,
        r2PhotoDeletionOutboxTable.objectKey,
      ],
      set: {
        state: "pending",
        objectKind: sql`excluded.object_kind`,
        claimToken: null,
        nextRetryAt: sql`excluded.next_retry_at`,
        lastError: null,
        deletedAt: null,
        updatedAt: new Date(),
      },
    });
  return objects.length;
}

export async function enqueueR2PhotoDeletionsForStudents(
  tx: Transaction,
  studentIds: number[],
): Promise<number> {
  if (studentIds.length === 0) return 0;
  await tx.select({ id: studentsTable.id }).from(studentsTable)
    .where(inArray(studentsTable.id, studentIds)).for("update");
  const photos = await tx.select({ id: studentPhotosTable.id }).from(studentPhotosTable)
    .where(inArray(studentPhotosTable.studentId, studentIds)).for("update");
  const captures = await tx.select({ id: capturesTable.id }).from(capturesTable)
    .where(inArray(capturesTable.studentId, studentIds)).for("update");
  const captureFiles = captures.length
    ? await tx.select({ id: captureFilesTable.id }).from(captureFilesTable)
      .where(inArray(captureFilesTable.captureId, captures.map((row) => row.id)))
      .for("update")
    : [];
  return (await enqueueR2PhotoDeletions(tx, "student_photo", photos.map((row) => row.id)))
    + (await enqueueR2PhotoDeletions(tx, "capture_file", captureFiles.map((row) => row.id)));
}

export async function lockProjectStudentIds(
  tx: Transaction,
  projectId: number,
  requestedIds: number[],
): Promise<number[]> {
  if (requestedIds.length === 0) return [];
  const rows = await tx.select({ id: studentsTable.id }).from(studentsTable)
    .where(and(
      eq(studentsTable.projectId, projectId),
      inArray(studentsTable.id, requestedIds),
    ))
    .for("update");
  return rows.map((row) => row.id);
}

export async function enqueueR2PhotoDeletionsForGroups(
  tx: Transaction,
  groupIds: number[],
): Promise<number> {
  if (groupIds.length === 0) return 0;
  await tx.select({ id: groupsTable.id }).from(groupsTable)
    .where(inArray(groupsTable.id, groupIds)).for("update");
  const captures = await tx.select({ id: groupCapturesTable.id }).from(groupCapturesTable)
    .where(inArray(groupCapturesTable.groupId, groupIds)).for("update");
  const files = captures.length
    ? await tx.select({ id: groupCaptureFilesTable.id })
      .from(groupCaptureFilesTable)
      .where(inArray(groupCaptureFilesTable.captureId, captures.map((row) => row.id)))
      .for("update")
    : [];
  return enqueueR2PhotoDeletions(tx, "group_capture_file", files.map((row) => row.id));
}

export async function enqueueR2PhotoDeletionsForProject(
  tx: Transaction,
  projectId: number,
): Promise<number> {
  await tx.select({ id: projectsTable.id }).from(projectsTable)
    .where(eq(projectsTable.id, projectId)).for("update");
  const [students, groups] = await Promise.all([
    tx.select({ id: studentsTable.id }).from(studentsTable)
      .where(eq(studentsTable.projectId, projectId)),
    tx.select({ id: groupsTable.id }).from(groupsTable)
      .where(eq(groupsTable.projectId, projectId)),
  ]);
  return (await enqueueR2PhotoDeletionsForStudents(tx, students.map((row) => row.id)))
    + (await enqueueR2PhotoDeletionsForGroups(tx, groups.map((row) => row.id)));
}

async function releaseStaleClaims(now: Date): Promise<void> {
  await db
    .update(r2PhotoDeletionOutboxTable)
    .set({
      state: "failed",
      claimToken: null,
      nextRetryAt: now,
      lastError: "Deletion claim became stale and was released for retry",
      updatedAt: now,
    })
    .where(
      and(
        eq(r2PhotoDeletionOutboxTable.state, "deleting"),
        or(
          isNull(r2PhotoDeletionOutboxTable.lastAttemptAt),
          lte(
            r2PhotoDeletionOutboxTable.lastAttemptAt,
            new Date(now.getTime() - STALE_CLAIM_MS),
          ),
        ),
      ),
    );
}

async function claimBatch(now: Date) {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(r2PhotoDeletionOutboxTable)
      .where(
        and(
          inArray(r2PhotoDeletionOutboxTable.state, ["pending", "failed"]),
          or(
            isNull(r2PhotoDeletionOutboxTable.nextRetryAt),
            lte(r2PhotoDeletionOutboxTable.nextRetryAt, now),
          ),
        ),
      )
      .orderBy(asc(r2PhotoDeletionOutboxTable.id))
      .limit(BATCH_SIZE)
      .for("update", { skipLocked: true });
    if (rows.length === 0) return [];
    return Promise.all(rows.map(async (row) => {
      const claimToken = randomUUID();
      await tx.update(r2PhotoDeletionOutboxTable).set({
        state: "deleting",
        claimToken,
        attemptCount: sql`${r2PhotoDeletionOutboxTable.attemptCount} + 1`,
        lastAttemptAt: now,
        nextRetryAt: null,
        updatedAt: now,
      }).where(eq(r2PhotoDeletionOutboxTable.id, row.id));
      return { ...row, claimToken, attemptCount: row.attemptCount + 1 };
    }));
  });
}

export async function dispatchR2PhotoDeletions(options: {
  now?: Date;
  deleteObject?: (objectKey: string) => Promise<void>;
  listVariantKeys?: (prefix: string) => Promise<string[]>;
} = {}): Promise<number> {
  const now = options.now ?? new Date();
  const deleteObject = options.deleteObject ?? deleteR2Object;
  const listVariantKeys = options.listVariantKeys ?? listR2ObjectKeys;
  await releaseStaleClaims(now);
  const rows = await claimBatch(now);
  for (const row of rows) {
    const liveKeyCondition = row.objectKind === "staging"
      ? or(
          eq(photoStorageCopiesTable.objectKey, row.objectKey),
          eq(photoStorageCopiesTable.stagingObjectKey, row.objectKey),
        )
      : eq(photoStorageCopiesTable.objectKey, row.objectKey);
    const [liveCopy] = await db
      .select({ id: photoStorageCopiesTable.id })
      .from(photoStorageCopiesTable)
      .where(
        and(
          eq(photoStorageCopiesTable.destination, "r2"),
          liveKeyCondition,
        ),
      )
      .limit(1);
    if (liveCopy) {
      await db
        .update(r2PhotoDeletionOutboxTable)
        .set({
          state: "conflict",
          claimToken: null,
          lastError: `Object key is attached to live storage copy ${liveCopy.id}`,
          updatedAt: now,
        })
        .where(and(
          eq(r2PhotoDeletionOutboxTable.id, row.id),
          eq(r2PhotoDeletionOutboxTable.state, "deleting"),
          eq(r2PhotoDeletionOutboxTable.claimToken, row.claimToken),
        ));
      continue;
    }
    try {
      await deleteObject(row.objectKey);
      if (row.objectKind === "original") {
        const prefixes = [r2PhotoVariantPrefix(row.objectKey)];
        const legacyPrefix = r2LegacyPhotoVariantPrefix(row.objectKey);
        if (legacyPrefix !== prefixes[0]) {
          const liveCopies = await db.select({ objectKey: photoStorageCopiesTable.objectKey })
            .from(photoStorageCopiesTable)
            .where(eq(photoStorageCopiesTable.destination, "r2"));
          const legacyPrefixIsShared = liveCopies.some(
            (copy) => r2LegacyPhotoVariantPrefix(copy.objectKey) === legacyPrefix,
          );
          if (!legacyPrefixIsShared) prefixes.push(legacyPrefix);
        }
        const seenVariantKeys = new Set<string>();
        for (const variantPrefix of prefixes) {
          const variantKeys = await listVariantKeys(variantPrefix);
          for (const variantKey of variantKeys) {
            if (!variantKey.startsWith(variantPrefix)) {
              throw new Error("R2 variant listing returned a key outside the photo namespace");
            }
            if (!seenVariantKeys.has(variantKey)) {
              await deleteObject(variantKey);
              seenVariantKeys.add(variantKey);
            }
          }
        }
      }
      await db
        .update(r2PhotoDeletionOutboxTable)
        .set({
          state: "deleted",
          claimToken: null,
          deletedAt: now,
          lastError: null,
          updatedAt: now,
        })
        .where(and(
          eq(r2PhotoDeletionOutboxTable.id, row.id),
          eq(r2PhotoDeletionOutboxTable.state, "deleting"),
          eq(r2PhotoDeletionOutboxTable.claimToken, row.claimToken),
        ));
    } catch (error) {
      const retryMs = Math.min(
        MAX_RETRY_MS,
        5_000 * 2 ** Math.min(row.attemptCount - 1, 10),
      );
      await db
        .update(r2PhotoDeletionOutboxTable)
        .set({
          state: "failed",
          claimToken: null,
          nextRetryAt: new Date(now.getTime() + retryMs),
          lastError: error instanceof Error ? error.message.slice(0, 2_000) : String(error).slice(0, 2_000),
          updatedAt: now,
        })
        .where(and(
          eq(r2PhotoDeletionOutboxTable.id, row.id),
          eq(r2PhotoDeletionOutboxTable.state, "deleting"),
          eq(r2PhotoDeletionOutboxTable.claimToken, row.claimToken),
        ));
    }
  }
  return rows.length;
}