import { createHash } from "node:crypto";
import { basename, dirname, extname } from "node:path";
import sharp from "sharp";
import { captureFilesTable, capturesTable, db, photoStorageCopiesTable, studentPhotosTable, type PhotoStorageCopy } from "@workspace/db";
import { and, eq, or } from "drizzle-orm";
import {
  deleteR2Object,
  getR2Object,
  headR2Object,
  listR2ObjectKeys,
  putR2Buffer,
} from "./r2Storage";
import {
  applyCaptureEdits,
  captureEditSettingsFromRow,
  normalizedCaptureEditSettings,
  type CaptureEditSettings,
} from "./captureEdits";

export type PhotoVariantKind = "thumbnail" | "preview" | "download" | "print";

const VARIANT_SETTINGS: Record<PhotoVariantKind, { width: number; quality: number }> = {
  thumbnail: { width: 480, quality: 72 },
  preview: { width: 1600, quality: 82 },
  download: { width: 10000, quality: 94 },
  print: { width: 10000, quality: 95 },
};

function watermarkTile(text: string): Buffer {
  const safeText = text.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&apos;",
  }[character] ?? character)).slice(0, 120);
  return Buffer.from(`<svg width="320" height="190" xmlns="http://www.w3.org/2000/svg">
    <g transform="rotate(-28 160 95)" fill="white" fill-opacity=".30"
      font-family="Arial,sans-serif" font-size="24" font-weight="700">
      <text x="-30" y="105">${safeText}</text>
    </g>
  </svg>`);
}

export function r2PhotoVariantKey(
  original: Pick<PhotoStorageCopy, "objectKey" | "sha256">,
  kind: PhotoVariantKind,
  watermarkText?: string,
  editSettings?: Partial<CaptureEditSettings> | null,
): string {
  if (!original.sha256) throw new Error("Verified R2 source hash is missing");
  const watermark = watermarkText?.trim() || "";
  const edits = normalizedCaptureEditSettings(editSettings);
  const signature = createHash("sha256")
    .update(`${original.sha256.toLowerCase()}:${kind}:${watermark}:${JSON.stringify(edits)}:variant-v2`)
    .digest("hex")
    .slice(0, 16);
  const extension = extname(original.objectKey);
  const stem = basename(original.objectKey, extension);
  const label = watermark ? `${kind}-watermarked` : kind;
  return `${dirname(original.objectKey)}/.variants/${stem}__${label}__${signature}.jpg`;
}

export async function getVerifiedR2CopyForPhoto(
  photo: typeof studentPhotosTable.$inferSelect,
): Promise<PhotoStorageCopy | null> {
  const sourceCondition = photo.sourceGroupCaptureFileId === null
    ? eq(photoStorageCopiesTable.studentPhotoId, photo.id)
    : or(
      eq(photoStorageCopiesTable.studentPhotoId, photo.id),
      eq(photoStorageCopiesTable.groupCaptureFileId, photo.sourceGroupCaptureFileId),
    );
  const [copy] = await db.select().from(photoStorageCopiesTable).where(and(
    eq(photoStorageCopiesTable.destination, "r2"),
    eq(photoStorageCopiesTable.state, "ready"),
    sourceCondition,
  )).orderBy(photoStorageCopiesTable.verifiedAt).limit(1);
  if (copy) return copy;
  if (photo.sourceGroupCaptureFileId !== null) return null;

  const captureIdentity = photo.clientUploadId
    ? and(
      eq(captureFilesTable.desktopConnectionId, photo.desktopConnectionId!),
      eq(captureFilesTable.clientUploadId, photo.clientUploadId),
    )
    : eq(captureFilesTable.originalFilename, photo.fileName);
  const [captureCopy] = await db
    .select({ copy: photoStorageCopiesTable })
    .from(photoStorageCopiesTable)
    .innerJoin(captureFilesTable, eq(photoStorageCopiesTable.captureFileId, captureFilesTable.id))
    .innerJoin(capturesTable, eq(captureFilesTable.captureId, capturesTable.id))
    .where(and(
      eq(photoStorageCopiesTable.destination, "r2"),
      eq(photoStorageCopiesTable.state, "ready"),
      eq(capturesTable.projectId, photo.projectId),
      eq(capturesTable.studentId, photo.studentId),
      eq(captureFilesTable.fileRole, "JPEG"),
      captureIdentity,
    ))
    .orderBy(photoStorageCopiesTable.verifiedAt)
    .limit(1);
  return captureCopy?.copy ?? null;
}

export async function ensureR2PhotoVariant(
  original: PhotoStorageCopy,
  kind: PhotoVariantKind,
  watermarkText?: string,
  editSettings?: Partial<CaptureEditSettings> | null,
): Promise<string> {
  if (original.destination !== "r2" || original.state !== "ready" || !original.sha256) {
    throw new Error("A verified R2 original is required to create a photo variant");
  }
  let resolvedEditSettings = editSettings;
  if (resolvedEditSettings === undefined) {
    if (original.captureFileId !== null) {
      const [capture] = await db.select({
        cropPositionX: capturesTable.cropPositionX,
        cropPositionY: capturesTable.cropPositionY,
        cropScale: capturesTable.cropScale,
        aspectRatio: capturesTable.aspectRatio,
        straightenAngle: capturesTable.straightenAngle,
        rotation: capturesTable.rotation,
      }).from(captureFilesTable)
        .innerJoin(capturesTable, eq(captureFilesTable.captureId, capturesTable.id))
        .where(eq(captureFilesTable.id, original.captureFileId))
        .limit(1);
      resolvedEditSettings = capture ? captureEditSettingsFromRow(capture) : null;
    } else if (original.studentPhotoId !== null) {
      const [photo] = await db.select().from(studentPhotosTable)
        .where(eq(studentPhotosTable.id, original.studentPhotoId))
        .limit(1);
      if (photo) {
        const captureIdentity = photo.clientUploadId
          ? and(
            eq(captureFilesTable.desktopConnectionId, photo.desktopConnectionId!),
            eq(captureFilesTable.clientUploadId, photo.clientUploadId),
          )
          : eq(captureFilesTable.originalFilename, photo.fileName);
        const [capture] = await db.select({
          cropPositionX: capturesTable.cropPositionX,
          cropPositionY: capturesTable.cropPositionY,
          cropScale: capturesTable.cropScale,
          aspectRatio: capturesTable.aspectRatio,
          straightenAngle: capturesTable.straightenAngle,
          rotation: capturesTable.rotation,
        }).from(captureFilesTable)
          .innerJoin(capturesTable, eq(captureFilesTable.captureId, capturesTable.id))
          .where(and(
            eq(capturesTable.projectId, photo.projectId),
            eq(capturesTable.studentId, photo.studentId),
            eq(captureFilesTable.fileRole, "JPEG"),
            captureIdentity,
          ))
          .limit(1);
        resolvedEditSettings = capture ? captureEditSettingsFromRow(capture) : null;
      }
    }
  }
  const objectKey = r2PhotoVariantKey(original, kind, watermarkText, resolvedEditSettings);
  if (await headR2Object(objectKey)) return objectKey;

  const source = await getR2Object(original.objectKey);
  const sourceBytes = Buffer.from(await source.arrayBuffer());
  const settings = VARIANT_SETTINGS[kind];
  let pipeline = await applyCaptureEdits(sourceBytes, normalizedCaptureEditSettings(resolvedEditSettings));
  pipeline = pipeline.resize({ width: settings.width, withoutEnlargement: true });
  if (watermarkText?.trim()) {
    pipeline = pipeline.composite([{
      input: watermarkTile(watermarkText.trim()),
      tile: true,
      blend: "over",
    }]);
  }
  const bytes = await pipeline.jpeg({
    quality: settings.quality,
    progressive: true,
    mozjpeg: true,
  }).toBuffer();
  const digest = createHash("sha256").update(bytes).digest("hex");
  await putR2Buffer(objectKey, bytes, { contentType: "image/jpeg", sha256: digest });
  const verified = await headR2Object(objectKey);
  if (
    !verified
    || (verified.contentLength !== null && verified.contentLength !== bytes.length)
    || (verified.sha256 !== null && verified.sha256.toLowerCase() !== digest)
  ) {
    throw new Error("R2 photo variant could not be verified");
  }
  return objectKey;
}

export async function prepareBaseR2PhotoVariants(original: PhotoStorageCopy): Promise<void> {
  await Promise.all([
    ensureR2PhotoVariant(original, "thumbnail"),
    ensureR2PhotoVariant(original, "preview"),
  ]);
}

function variantPrefix(originalObjectKey: string): string {
  const extension = extname(originalObjectKey);
  const stem = basename(originalObjectKey, extension);
  return `${dirname(originalObjectKey)}/.variants/${stem}__`;
}

export async function deleteDirectR2AssetsForPhoto(
  photoId: number,
): Promise<number[]> {
  const copies = await db.select().from(photoStorageCopiesTable).where(and(
    eq(photoStorageCopiesTable.studentPhotoId, photoId),
    eq(photoStorageCopiesTable.destination, "r2"),
  ));
  const verifiedCopies = copies.filter((copy) => copy.verifiedAt !== null);
  const cleanedCopyIds: number[] = [];

  for (const copy of verifiedCopies) {
    const now = new Date();
    await db.update(photoStorageCopiesTable).set({
      state: "cleaning",
      cleanupAttemptCount: copy.cleanupAttemptCount + 1,
      lastAttemptAt: now,
      lastError: null,
      updatedAt: now,
    }).where(eq(photoStorageCopiesTable.id, copy.id));

    try {
      const variants = await listR2ObjectKeys(variantPrefix(copy.objectKey));
      for (const objectKey of variants) await deleteR2Object(objectKey);
      await deleteR2Object(copy.objectKey);
      cleanedCopyIds.push(copy.id);
    } catch (error) {
      await db.update(photoStorageCopiesTable).set({
        state: "failed",
        lastError: error instanceof Error ? error.message.slice(0, 1_000) : "R2 deletion failed",
        updatedAt: new Date(),
      }).where(eq(photoStorageCopiesTable.id, copy.id));
      throw error;
    }
  }

  return cleanedCopyIds;
}