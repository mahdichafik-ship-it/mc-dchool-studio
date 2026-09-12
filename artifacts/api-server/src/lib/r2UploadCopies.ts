import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { basename } from "node:path";
import {
  db,
} from "@workspace/db";
import {
  photoStorageCopiesTable,
  type PhotoStorageCopy,
} from "@workspace/db/schema";
import { and, eq } from "drizzle-orm";
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

function objectKeyFor(source: R2Source, originalFilename: string): string {
  const safeName =
    basename(originalFilename).replace(/[^a-zA-Z0-9._-]/g, "_") || "file";
  if (source.kind === "student") {
    return `projects/${source.projectId}/students/${source.studentId}/photos/${source.id}/${safeName}`;
  }
  if (source.kind === "capture") {
    return `projects/${source.projectId}/captures/${source.captureId}/files/${source.id}/${safeName}`;
  }
  return `projects/${source.projectId}/group-captures/${source.captureId}/files/${source.id}/${safeName}`;
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
  const objectKey =
    copy?.objectKey ?? objectKeyFor(input.source, input.originalFilename);

  if (copy) assertCopyMatches(copy, input);

  if (!copy) {
    await db
      .insert(photoStorageCopiesTable)
      .values({
        ...sourceValues(input.source),
        destination: "r2",
        objectKey,
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

  const stagingObjectKey =
    `staging/storage-copy-${copy.id}/${randomUUID()}/${basename(input.originalFilename).replace(/[^a-zA-Z0-9._-]/g, "_") || "file"}`;
  const upload = createR2PutUpload(
    stagingObjectKey,
    { contentType: input.mimeType, sha256: input.sha256 },
    config,
  );
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
      eq(photoStorageCopiesTable.fileSize, input.fileSize),
      eq(photoStorageCopiesTable.sha256, input.sha256.toLowerCase()),
    ))
    .returning();
  if (!updated) {
    throw new Error("R2 upload changed concurrently; retry with a fresh session");
  }

  return {
    ...upload,
    copyId: updated.id,
    objectKey: stagingObjectKey,
    alreadyVerified: false,
  };
}

export async function verifyR2Copy(
  copy: PhotoStorageCopy,
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

  const candidateObjectKey =
    `verified/storage-copy-${copy.id}/${randomUUID()}/${basename(copy.objectKey)}`;
  await copyR2Object(stagingObjectKey, candidateObjectKey, {
    sha256: actualSha256!,
  });
  const finalMetadata = await headR2Object(candidateObjectKey);
  const finalDigest = finalMetadata
    ? await readR2Digest(candidateObjectKey)
    : null;
  if (
    !finalMetadata ||
    !finalDigest ||
    finalMetadata.contentLength !== finalDigest.size ||
    finalDigest.size !== actualSize ||
    finalDigest.sha256.toLowerCase() !== actualSha256
  ) {
    await deleteR2Object(candidateObjectKey).catch(() => undefined);
    throw Object.assign(
      new Error("Verified R2 object could not be promoted safely"),
      { code: "R2_UPLOAD_NOT_VERIFIED" },
    );
  }
  const [ready] = await db
    .update(photoStorageCopiesTable)
    .set({
      state: "ready",
      stagingObjectKey: null,
      objectKey: candidateObjectKey,
      providerObjectId: candidateObjectKey,
      fileSize: finalDigest.size,
      mimeType: finalMetadata.contentType ?? copy.mimeType,
      sha256: finalDigest.sha256,
      etag: finalMetadata.etag,
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
    await deleteR2Object(stagingObjectKey).catch(() => undefined);
    throw Object.assign(
      new Error("A newer R2 upload attempt replaced this verification"),
      { code: "R2_UPLOAD_NOT_VERIFIED" },
    );
  }
  await deleteR2Object(stagingObjectKey).catch(() => undefined);
  return ready;
}