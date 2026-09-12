import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { basename, dirname } from "node:path";
import {
  db,
} from "@workspace/db";
import {
  capturesTable,
  captureFilesTable,
  classesTable,
  groupCaptureFilesTable,
  groupCapturesTable,
  groupsTable,
  photoStorageCopiesTable,
  projectsTable,
  studentPhotosTable,
  studentsTable,
  studiosTable,
  type PhotoStorageCopy,
} from "@workspace/db/schema";
import { and, eq, or } from "drizzle-orm";
import {
  canonicalProjectFolderName,
  canonicalStoragePathName,
  canonicalStudentFolderName,
  stableCollisionFileName,
} from "./googleDriveBackup";
import {
  createR2PutUpload,
  copyR2Object,
  deleteR2Object,
  getR2Object,
  getR2Config,
  headR2Object,
  type R2PutUpload,
} from "./r2Storage";

type R2Source =
  | { kind: "student"; id: number; projectId: number; studentId: number }
  | { kind: "capture"; id: number; projectId: number; captureId: number }
  | { kind: "group"; id: number; projectId: number; captureId: number };

export type R2ObjectHierarchy = {
  studioName: string;
  projectName: string;
  className: string;
  subjectFolderName: string;
  studioId: number;
  projectId: number;
  classId?: number;
  subjectId: number;
};

export interface R2CopyUpload extends R2PutUpload {
  copyId: number;
  objectKey: string;
  alreadyVerified: boolean;
}

export async function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(filePath)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });
}

function sourceValues(source: R2Source) {
  return {
    studentPhotoId: source.kind === "student" ? source.id : null,
    captureFileId: source.kind === "capture" ? source.id : null,
    groupCaptureFileId: source.kind === "group" ? source.id : null,
  };
}

function sourceCondition(source: R2Source) {
  if (source.kind === "student") {
    return and(
      eq(photoStorageCopiesTable.studentPhotoId, source.id),
      eq(photoStorageCopiesTable.destination, "r2"),
    );
  }
  if (source.kind === "capture") {
    return and(
      eq(photoStorageCopiesTable.captureFileId, source.id),
      eq(photoStorageCopiesTable.destination, "r2"),
    );
  }
  return and(
    eq(photoStorageCopiesTable.groupCaptureFileId, source.id),
    eq(photoStorageCopiesTable.destination, "r2"),
  );
}

export function readableR2ObjectKey(
  hierarchy: R2ObjectHierarchy,
  originalFilename: string,
  collisionKey?: string,
): string {
  const originalName = canonicalStoragePathName(
    basename(originalFilename),
    "file",
  );
  const fileName = collisionKey
    ? stableCollisionFileName(originalName, collisionKey)
    : originalName;
  return [
    canonicalStoragePathName(hierarchy.studioName, `Studio ${hierarchy.studioId}`),
    canonicalProjectFolderName(hierarchy.projectName, hierarchy.projectId),
    canonicalStoragePathName(
      hierarchy.className,
      hierarchy.classId !== undefined ? `Class ${hierarchy.classId}` : "Groups",
    ),
    canonicalStoragePathName(
      hierarchy.subjectFolderName,
      `Student ${hierarchy.subjectId}`,
    ),
    fileName,
  ].join("/");
}

export function readableR2CandidateKey(
  readableObjectKey: string,
  attemptKey: string,
): string {
  const directory = dirname(readableObjectKey);
  const candidateName = stableCollisionFileName(
    basename(readableObjectKey),
    attemptKey,
  );
  return directory === "." ? candidateName : `${directory}/${candidateName}`;
}

async function resolveObjectHierarchy(
  source: R2Source,
): Promise<R2ObjectHierarchy> {
  if (source.kind === "student") {
    const [row] = await db
      .select({
        studioId: studiosTable.id,
        studioName: studiosTable.name,
        projectId: projectsTable.id,
        projectName: projectsTable.schoolName,
        classId: classesTable.id,
        className: classesTable.className,
        subjectId: studentsTable.id,
        firstName: studentsTable.firstName,
        lastName: studentsTable.lastName,
        generatedStudentId: studentsTable.generatedStudentId,
      })
      .from(studentPhotosTable)
      .innerJoin(studentsTable, eq(studentsTable.id, source.studentId))
      .innerJoin(projectsTable, eq(projectsTable.id, studentsTable.projectId))
      .innerJoin(studiosTable, eq(studiosTable.id, projectsTable.studioId))
      .innerJoin(classesTable, eq(classesTable.id, studentsTable.classId))
      .where(and(
        eq(studentPhotosTable.id, source.id),
        eq(studentPhotosTable.projectId, source.projectId),
      ))
      .limit(1);
    if (!row) throw new Error("Could not resolve the student R2 object hierarchy");
    return {
      ...row,
      subjectFolderName: canonicalStudentFolderName(
        row.firstName,
        row.lastName,
        row.generatedStudentId,
      ),
    };
  }

  if (source.kind === "capture") {
    const [row] = await db
      .select({
        studioId: studiosTable.id,
        studioName: studiosTable.name,
        projectId: projectsTable.id,
        projectName: projectsTable.schoolName,
        classId: classesTable.id,
        className: classesTable.className,
        subjectId: studentsTable.id,
        firstName: studentsTable.firstName,
        lastName: studentsTable.lastName,
        generatedStudentId: studentsTable.generatedStudentId,
      })
      .from(captureFilesTable)
      .innerJoin(capturesTable, eq(capturesTable.id, source.captureId))
      .innerJoin(studentsTable, eq(studentsTable.id, capturesTable.studentId))
      .innerJoin(projectsTable, eq(projectsTable.id, capturesTable.projectId))
      .innerJoin(studiosTable, eq(studiosTable.id, projectsTable.studioId))
      .innerJoin(classesTable, eq(classesTable.id, studentsTable.classId))
      .where(and(
        eq(captureFilesTable.id, source.id),
        eq(capturesTable.projectId, source.projectId),
      ))
      .limit(1);
    if (!row) throw new Error("Could not resolve the capture R2 object hierarchy");
    return {
      ...row,
      subjectFolderName: canonicalStudentFolderName(
        row.firstName,
        row.lastName,
        row.generatedStudentId,
      ),
    };
  }

  const [row] = await db
    .select({
      studioId: studiosTable.id,
      studioName: studiosTable.name,
      projectId: projectsTable.id,
      projectName: projectsTable.schoolName,
      classId: classesTable.id,
      className: classesTable.className,
      subjectId: groupsTable.id,
    })
    .from(groupCaptureFilesTable)
    .innerJoin(groupCapturesTable, eq(groupCapturesTable.id, source.captureId))
    .innerJoin(groupsTable, eq(groupsTable.id, groupCapturesTable.groupId))
    .innerJoin(projectsTable, eq(projectsTable.id, groupCapturesTable.projectId))
    .innerJoin(studiosTable, eq(studiosTable.id, projectsTable.studioId))
    .leftJoin(classesTable, eq(classesTable.id, groupsTable.classId))
    .where(and(
      eq(groupCaptureFilesTable.id, source.id),
      eq(groupCapturesTable.projectId, source.projectId),
    ))
    .limit(1);
  if (!row) throw new Error("Could not resolve the group R2 object hierarchy");
  return {
    ...row,
    classId: row.classId ?? undefined,
    className: row.className ?? "Groups",
    subjectFolderName: `Group_${row.subjectId}`,
  };
}

function assertCopyMatches(
  copy: PhotoStorageCopy,
  expected: { fileSize: number; sha256: string },
): void {
  if (
    (copy.fileSize !== null && copy.fileSize !== expected.fileSize) ||
    (copy.sha256 !== null &&
      copy.sha256.toLowerCase() !== expected.sha256.toLowerCase())
  ) {
    throw new Error(
      "The stable upload identifier was reused with different file bytes",
    );
  }
}

async function readR2Digest(
  objectKey: string,
): Promise<{ sha256: string; size: number }> {
  const response = await getR2Object(objectKey);
  if (!response.body) {
    throw new Error("R2 object could not be read for verification");
  }
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of response.body) {
    const bytes =
      typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk);
    hash.update(bytes);
    size += bytes.byteLength;
  }
  return { sha256: hash.digest("hex"), size };
}

export async function createR2CopyUpload(input: {
  source: R2Source;
  originalFilename: string;
  mimeType: string;
  fileSize: number;
  sha256: string;
}): Promise<R2CopyUpload | null> {
  const config = getR2Config();
  if (!config) return null;
  const condition = sourceCondition(input.source);
  let [copy] = await db
    .select()
    .from(photoStorageCopiesTable)
    .where(condition)
    .limit(1);
  if (!copy) {
    const hierarchy = await resolveObjectHierarchy(input.source);
    const collisionKey = `r2:${input.source.kind}:${input.source.id}`;
    const baseObjectKey = readableR2ObjectKey(
      hierarchy,
      input.originalFilename,
    );
    const collisionObjectKey = readableR2ObjectKey(
      hierarchy,
      input.originalFilename,
      collisionKey,
    );
    for (const candidate of [baseObjectKey, collisionObjectKey]) {
      await db
        .insert(photoStorageCopiesTable)
        .values({
          ...sourceValues(input.source),
          destination: "r2",
          objectKey: candidate,
          state: "pending",
          mimeType: input.mimeType,
          fileSize: input.fileSize,
          sha256: input.sha256.toLowerCase(),
        })
        .onConflictDoNothing();
      [copy] = await db
        .select()
        .from(photoStorageCopiesTable)
        .where(condition)
        .limit(1);
      if (copy) {
        break;
      }
    }
    [copy] = await db
      .select()
      .from(photoStorageCopiesTable)
      .where(condition)
      .limit(1);
  }
  if (!copy) throw new Error("R2 storage copy could not be created");
  // A concurrent request may have won the insert after our first SELECT.
  // Re-check the winner before issuing a URL for its stable object key.
  assertCopyMatches(copy, input);

  if (copy.state === "ready") {
    return {
      copyId: copy.id,
      objectKey: copy.objectKey,
      uploadUrl: "",
      uploadMethod: "PUT",
      uploadHeaders: {},
      expiresAt: new Date().toISOString(),
      alreadyVerified: true,
    };
  }

  const signedUpload = (stagingObjectKey: string): R2CopyUpload => ({
    ...createR2PutUpload(
      stagingObjectKey,
      { contentType: input.mimeType, sha256: input.sha256 },
      config,
    ),
    copyId: copy!.id,
    objectKey: stagingObjectKey,
    alreadyVerified: false,
  });

  // A retry for an active attempt must reuse its server-owned staging key.
  // This prevents a second caller from replacing the first caller's attempt.
  if (copy.state === "uploading") {
    if (!copy.stagingObjectKey) {
      throw new Error("R2 upload attempt has no staging object");
    }
    return signedUpload(copy.stagingObjectKey);
  }

  const stagingObjectKey =
    `staging/storage-copy-${copy.id}/${randomUUID()}/${canonicalStoragePathName(basename(input.originalFilename), "file")}`;
  const [updated] = await db
    .update(photoStorageCopiesTable)
    .set({
      state: "uploading",
      stagingObjectKey,
      mimeType: input.mimeType,
      fileSize: input.fileSize,
      sha256: input.sha256.toLowerCase(),
      attemptCount: copy.attemptCount + 1,
      lastAttemptAt: new Date(),
      lastError: null,
      updatedAt: new Date(),
    })
    .where(and(
      eq(photoStorageCopiesTable.id, copy.id),
      or(
        eq(photoStorageCopiesTable.state, "pending"),
        eq(photoStorageCopiesTable.state, "failed"),
      ),
      eq(photoStorageCopiesTable.fileSize, input.fileSize),
      eq(photoStorageCopiesTable.sha256, input.sha256.toLowerCase()),
    ))
    .returning();
  if (!updated) {
    const [current] = await db
      .select()
      .from(photoStorageCopiesTable)
      .where(condition)
      .limit(1);
    if (!current) {
      throw new Error("R2 upload changed concurrently; retry with a fresh session");
    }
    assertCopyMatches(current, input);
    if (current.state === "ready") {
      return {
        copyId: current.id,
        objectKey: current.objectKey,
        uploadUrl: "",
        uploadMethod: "PUT",
        uploadHeaders: {},
        expiresAt: new Date().toISOString(),
        alreadyVerified: true,
      };
    }
    if (current.state === "uploading" && current.stagingObjectKey) {
      return {
        ...createR2PutUpload(
          current.stagingObjectKey,
          { contentType: input.mimeType, sha256: input.sha256 },
          config,
        ),
        copyId: current.id,
        objectKey: current.stagingObjectKey,
        alreadyVerified: false,
      };
    }
    throw new Error("R2 upload changed concurrently; retry with a fresh session");
  }

  return {
    ...createR2PutUpload(
      stagingObjectKey,
      { contentType: input.mimeType, sha256: input.sha256 },
      config,
    ),
    copyId: updated.id,
    objectKey: stagingObjectKey,
    alreadyVerified: false,
  };
}

/**
 * The hook is intentionally limited to the point after the candidate has
 * been fully read and hashed, but before the database compare-and-set. It
 * gives integration tests a deterministic way to exercise two verifiers
 * racing on the same server-owned upload attempt.
 */
export interface VerifyR2CopyTestHooks {
  afterCandidateHashed?: (candidate: {
    objectKey: string;
    sha256: string;
    size: number;
  }) => void | Promise<void>;
}

export async function verifyR2Copy(
  copy: PhotoStorageCopy,
  testHooks: VerifyR2CopyTestHooks = {},
): Promise<PhotoStorageCopy> {
  if (copy.destination !== "r2") {
    throw new Error("Storage copy is not an R2 destination");
  }
  if (!copy.stagingObjectKey) {
    throw Object.assign(new Error("R2 upload staging object is missing"), {
      code: "R2_UPLOAD_NOT_VERIFIED",
    });
  }
  const stagingObjectKey = copy.stagingObjectKey;
  const metadata = await headR2Object(stagingObjectKey);
  let actualSha256: string | null = null;
  let actualSize = 0;
  if (metadata) {
    const digest = await readR2Digest(stagingObjectKey);
    actualSha256 = digest.sha256;
    actualSize = digest.size;
  }
  const mismatch =
    !metadata ||
    metadata.contentLength !== actualSize ||
    (copy.fileSize !== null && actualSize !== copy.fileSize) ||
    (copy.sha256 !== null &&
      actualSha256?.toLowerCase() !== copy.sha256.toLowerCase());
  if (mismatch) {
    const [failed] = await db
      .update(photoStorageCopiesTable)
      .set({
        state: "failed",
        lastError: metadata
          ? "R2 object metadata did not match the expected file"
          : "R2 object was not found",
        updatedAt: new Date(),
      })
      .where(and(
        eq(photoStorageCopiesTable.id, copy.id),
        eq(photoStorageCopiesTable.state, "uploading"),
        eq(photoStorageCopiesTable.stagingObjectKey, stagingObjectKey),
      ))
      .returning();
    throw Object.assign(new Error(
      failed?.lastError ?? "A newer R2 upload attempt replaced this verification",
    ), {
      code: "R2_UPLOAD_NOT_VERIFIED",
    });
  }

  // Keep the candidate in the human-readable hierarchy. The UUID makes
  // concurrent verifiers own distinct candidates even when they inspect the
  // same staging attempt; the suffix remains deterministically derived from
  // that candidate's staging/attempt key.
  const candidateAttemptKey = `${stagingObjectKey}:${randomUUID()}`;
  const candidateObjectKey = readableR2CandidateKey(
    copy.objectKey,
    candidateAttemptKey,
  );
  await copyR2Object(stagingObjectKey, candidateObjectKey, {
    sha256: actualSha256!,
  });
  const candidateMetadata = await headR2Object(candidateObjectKey);
  const candidateDigest = candidateMetadata
    ? await readR2Digest(candidateObjectKey)
    : null;
  if (
    !candidateMetadata ||
    !candidateDigest ||
    candidateMetadata.contentLength !== candidateDigest.size ||
    candidateDigest.size !== actualSize ||
    candidateDigest.sha256.toLowerCase() !== actualSha256
  ) {
    await deleteR2Object(candidateObjectKey).catch(() => undefined);
    throw Object.assign(
      new Error("Verified R2 object could not be promoted safely"),
      { code: "R2_UPLOAD_NOT_VERIFIED" },
    );
  }

  await testHooks.afterCandidateHashed?.({
    objectKey: candidateObjectKey,
    sha256: candidateDigest.sha256,
    size: candidateDigest.size,
  });

  const [ready] = await db
    .update(photoStorageCopiesTable)
    .set({
      state: "ready",
      stagingObjectKey: null,
      objectKey: candidateObjectKey,
      providerObjectId: candidateObjectKey,
      fileSize: candidateDigest.size,
      mimeType: candidateMetadata.contentType ?? copy.mimeType,
      sha256: candidateDigest.sha256,
      etag: candidateMetadata.etag,
      verifiedAt: new Date(),
      nextRetryAt: null,
      lastError: null,
      updatedAt: new Date(),
    })
    .where(and(
      eq(photoStorageCopiesTable.id, copy.id),
      eq(photoStorageCopiesTable.state, "uploading"),
      eq(photoStorageCopiesTable.stagingObjectKey, stagingObjectKey),
    ))
    .returning();
  if (!ready) {
    await deleteR2Object(candidateObjectKey).catch(() => undefined);
    throw Object.assign(
      new Error("A newer R2 upload attempt replaced this verification"),
      { code: "R2_UPLOAD_NOT_VERIFIED" },
    );
  }
  await deleteR2Object(stagingObjectKey).catch(() => undefined);
  return ready;
}