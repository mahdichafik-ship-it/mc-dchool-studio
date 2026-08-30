import { statSync } from 'node:fs'
import { and, eq } from 'drizzle-orm'
import type { getDb } from '../db'
import { capturesTable, classesTable, imageFilesTable, photosTable, studentsTable } from '../db/schema.ts'
import { getCaptureFileFormat, getCaptureFileRole, normalizeBaseFilename } from './capturePairing.ts'

type DesktopDb = ReturnType<typeof getDb>
type PhotoRow = typeof photosTable.$inferSelect

/**
 * Mirror the current one-file photo record into the capture model.
 *
 * The legacy row remains the compatibility record used by the existing
 * gallery, upload, deletion, and retirement flows. This adapter gives each
 * newly processed JPEG a capture/file representation until the live watcher
 * is moved to dual-folder ingestion.
 */
export function mirrorPhotoAsCapture(db: DesktopDb, photo: PhotoRow): void {
  const existing = db
    .select()
    .from(capturesTable)
    .where(eq(capturesTable.legacyPhotoId, photo.id))
    .get()
  if (existing) return

  const role = getCaptureFileRole(photo.fileName)
  if (role !== 'JPEG') return

  const student = photo.studentId === null
    ? undefined
    : db.select().from(studentsTable).where(eq(studentsTable.id, photo.studentId)).get()
  const classRow = student
    ? db.select().from(classesTable).where(eq(classesTable.id, student.classId)).get()
    : undefined
  const fileSize = (() => {
    try {
      return statSync(photo.filePath).size
    } catch {
      return null
    }
  })()

  const capture = db.insert(capturesTable).values({
    captureKey: `legacy-photo:${photo.id}`,
    projectId: photo.projectId,
    studentId: photo.studentId,
    classId: classRow?.id ?? null,
    baseFilename: normalizeBaseFilename(photo.fileName),
    capturedAt: photo.capturedAt,
    assignmentLocked: true,
    pairingStatus: photo.isMatched ? 'jpeg_only' : 'unpaired',
    legacyPhotoId: photo.id,
    createdAt: photo.createdAt,
    updatedAt: photo.createdAt,
  }).returning().get()

  db.insert(imageFilesTable).values({
    captureId: capture.id,
    fileRole: role,
    fileFormat: getCaptureFileFormat(photo.fileName),
    originalFilename: photo.fileName,
    storedPath: photo.filePath,
    sourcePath: photo.filePath,
    fileSize,
    importTime: photo.createdAt,
    uploadStatus: photo.uploadStatus,
    fileUrl: photo.fileUrl,
    createdAt: photo.createdAt,
  }).run()
}