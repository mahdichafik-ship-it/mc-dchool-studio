import { statSync } from 'node:fs'
import { and, eq } from 'drizzle-orm'
import type { getDb } from '../db'
import {
  capturesTable,
  classesTable,
  imageFilesTable,
  photosTable,
  qrMarkersTable,
  studentsTable,
} from '../db/schema.ts'
import { getCaptureFileFormat, getCaptureFileRole, normalizeBaseFilename } from './capturePairing.ts'

type DesktopDb = ReturnType<typeof getDb>
type PhotoRow = typeof photosTable.$inferSelect
const PAIR_TIMESTAMP_TOLERANCE_MS = 120_000

interface CaptureFileInput {
  projectId: number
  studentId: number | null
  classId: number | null
  filePath: string
  storedPath: string
  fileName: string
  capturedAt: string
}

function timestampMs(value: string): number {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function sameCaptureWindow(capturedAt: string, candidateAt: string): boolean {
  const incoming = timestampMs(capturedAt)
  const candidate = timestampMs(candidateAt)
  return incoming === 0 || candidate === 0 || Math.abs(incoming - candidate) <= PAIR_TIMESTAMP_TOLERANCE_MS
}

function getCaptureFiles(db: DesktopDb, captureId: number) {
  return db.select().from(imageFilesTable).where(eq(imageFilesTable.captureId, captureId)).all()
}

function findDuplicateFile(db: DesktopDb, sourcePath: string) {
  return db
    .select({ captureId: imageFilesTable.captureId })
    .from(imageFilesTable)
    .where(eq(imageFilesTable.sourcePath, sourcePath))
    .get()
}

function findPairCandidate(db: DesktopDb, input: CaptureFileInput) {
  const role = getCaptureFileRole(input.fileName)
  if (!role) return undefined

  return db
    .select()
    .from(capturesTable)
    .where(and(
      eq(capturesTable.projectId, input.projectId),
      eq(capturesTable.baseFilename, normalizeBaseFilename(input.fileName)),
    ))
    .all()
    .map((capture) => ({ capture, files: getCaptureFiles(db, capture.id) }))
    .filter(({ capture, files }) =>
      sameCaptureWindow(input.capturedAt, capture.capturedAt)
      && !files.some((file) => file.fileRole === role),
    )
    .sort((a, b) => timestampMs(b.capture.capturedAt) - timestampMs(a.capture.capturedAt))[0]
}

function statusForFiles(files: Array<{ fileRole: 'JPEG' | 'RAW' }>) {
  const hasJpeg = files.some((file) => file.fileRole === 'JPEG')
  const hasRaw = files.some((file) => file.fileRole === 'RAW')
  if (hasJpeg && hasRaw) return 'complete' as const
  if (hasJpeg) return 'jpeg_only' as const
  if (hasRaw) return 'raw_only' as const
  return 'unpaired' as const
}

function insertImageFile(db: DesktopDb, captureId: number, input: CaptureFileInput): void {
  const fileRole = getCaptureFileRole(input.fileName)
  if (!fileRole) throw new Error(`Unsupported capture file type: ${input.fileName}`)
  const fileSize = (() => {
    try {
      return statSync(input.filePath).size
    } catch {
      return null
    }
  })()

  db.insert(imageFilesTable).values({
    captureId,
    fileRole,
    fileFormat: getCaptureFileFormat(input.fileName),
    originalFilename: input.fileName,
    storedPath: input.storedPath,
    sourcePath: input.filePath,
    fileSize,
    importTime: input.capturedAt,
    createdAt: input.capturedAt,
  }).run()
}

/**
 * Returns true when this source path has already been persisted. This check
 * survives watcher restarts, unlike the per-session seenPaths set.
 */
export function hasProcessedCaptureSource(db: DesktopDb, sourcePath: string): boolean {
  return Boolean(findDuplicateFile(db, sourcePath))
}

export interface QrMarkerInput {
  projectId: number
  studentId: number
  filePath: string
  fileName: string
  sourcePath: string
  capturedAt: string
}

export function hasProcessedQrMarkerSource(db: DesktopDb, sourcePath: string): boolean {
  return Boolean(
    db
      .select({ id: qrMarkersTable.id })
      .from(qrMarkersTable)
      .where(eq(qrMarkersTable.sourcePath, sourcePath))
      .get(),
  )
}

export function recordQrMarker(
  db: DesktopDb,
  input: QrMarkerInput,
): { kind: 'created' | 'duplicate'; marker: typeof qrMarkersTable.$inferSelect } {
  const existing = db
    .select()
    .from(qrMarkersTable)
    .where(eq(qrMarkersTable.sourcePath, input.sourcePath))
    .get()
  if (existing) return { kind: 'duplicate', marker: existing }

  const marker = db.insert(qrMarkersTable).values({
    ...input,
    createdAt: input.capturedAt,
  }).returning().get()
  return { kind: 'created', marker }
}

/**
 * Persist a RAW file without creating a legacy photo row. If a JPEG capture
 * already exists, the RAW is attached to it; otherwise the RAW creates the
 * capture and locks the first file's assignment.
 */
export function recordRawCapture(db: DesktopDb, input: CaptureFileInput): {
  kind: 'created' | 'paired' | 'duplicate'
  captureId: number
} {
  const duplicate = findDuplicateFile(db, input.filePath)
  if (duplicate) return { kind: 'duplicate', captureId: duplicate.captureId }

  const candidate = findPairCandidate(db, input)
  if (candidate) {
    insertImageFile(db, candidate.capture.id, input)
    const files = getCaptureFiles(db, candidate.capture.id)
    db.update(capturesTable)
      .set({
        pairingStatus: statusForFiles(files),
        updatedAt: input.capturedAt,
      })
      .where(eq(capturesTable.id, candidate.capture.id))
      .run()
    return { kind: 'paired', captureId: candidate.capture.id }
  }

  const capture = db.insert(capturesTable).values({
    captureKey: [
      'capture',
      input.projectId,
      normalizeBaseFilename(input.fileName),
      input.capturedAt,
      input.filePath,
    ].map((part) => encodeURIComponent(String(part))).join(':'),
    projectId: input.projectId,
    studentId: input.studentId,
    classId: input.classId,
    baseFilename: normalizeBaseFilename(input.fileName),
    capturedAt: input.capturedAt,
    assignmentLocked: true,
    pairingStatus: 'raw_only',
    createdAt: input.capturedAt,
    updatedAt: input.capturedAt,
  }).returning().get()
  insertImageFile(db, capture.id, input)
  return { kind: 'created', captureId: capture.id }
}

/**
 * Mirror the current one-file photo record into the capture model.
 *
 * The legacy row remains the compatibility record used by the existing
 * gallery, upload, deletion, and retirement flows. This adapter gives each
 * newly processed JPEG a capture/file representation while the legacy gallery
 * and upload flows remain the compatibility surface.
 */
export function mirrorPhotoAsCapture(db: DesktopDb, photo: PhotoRow, sourcePath = photo.filePath): void {
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

  const candidate = findPairCandidate(db, {
    projectId: photo.projectId,
    studentId: photo.studentId,
    classId: classRow?.id ?? null,
    filePath: sourcePath,
    storedPath: photo.filePath,
    fileName: photo.fileName,
    capturedAt: photo.capturedAt,
  })

  if (candidate) {
    db.update(capturesTable)
      .set({
        legacyPhotoId: photo.id,
        updatedAt: photo.createdAt,
        pairingStatus: statusForFiles([...candidate.files, { fileRole: 'JPEG' }]),
      })
      .where(eq(capturesTable.id, candidate.capture.id))
      .run()
    db.insert(imageFilesTable).values({
      captureId: candidate.capture.id,
      fileRole: role,
      fileFormat: getCaptureFileFormat(photo.fileName),
      originalFilename: photo.fileName,
      storedPath: photo.filePath,
      sourcePath,
      fileSize,
      importTime: photo.createdAt,
      uploadStatus: photo.uploadStatus,
      fileUrl: photo.fileUrl,
      createdAt: photo.createdAt,
    }).run()
    return
  }

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
    sourcePath,
    fileSize,
    importTime: photo.createdAt,
    uploadStatus: photo.uploadStatus,
    fileUrl: photo.fileUrl,
    createdAt: photo.createdAt,
  }).run()
}