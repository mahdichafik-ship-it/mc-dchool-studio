import { copyFile, mkdir } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { and, eq } from 'drizzle-orm'
import type { getDb } from '../db'
import { classesTable, photosTable, projectsTable, studentsTable } from '../db/schema.ts'
import { extractStudentReference } from './photoFileNaming.ts'
import { mirrorPhotoAsCapture } from './captureRepository.ts'
import { markImagePipeline } from './imagePipelineDiagnostics.ts'

type DesktopDb = ReturnType<typeof getDb>
type ProjectRow = typeof projectsTable.$inferSelect
type ClassRow = typeof classesTable.$inferSelect
type StudentRow = typeof studentsTable.$inferSelect
type PhotoRow = typeof photosTable.$inferSelect

export interface WatchedPhotoStore {
  findProject(projectId: number): ProjectRow | undefined
  listStudents(projectId: number): StudentRow[]
  findStudent(projectId: number, generatedStudentId: string): StudentRow | undefined
  findClass(classId: number): ClassRow | undefined
  insertPhoto(photo: typeof photosTable.$inferInsert): PhotoRow
}

export function createWatchedPhotoStore(db: DesktopDb, sourcePath?: string): WatchedPhotoStore {
  return {
    findProject: (projectId) =>
      db.select().from(projectsTable).where(eq(projectsTable.id, projectId)).get(),
    listStudents: (projectId) =>
      db.select().from(studentsTable).where(eq(studentsTable.projectId, projectId)).all(),
    findStudent: (projectId, generatedStudentId) =>
      db
        .select()
        .from(studentsTable)
        .where(eq(studentsTable.projectId, projectId))
        .all()
        .find((student) =>
          student.generatedStudentId.trim().toLocaleLowerCase()
            === generatedStudentId.trim().toLocaleLowerCase()),
    findClass: (classId) =>
      db.select().from(classesTable).where(eq(classesTable.id, classId)).get(),
    insertPhoto: (photo) => {
      const saved = db.insert(photosTable).values(photo).returning().get()
      mirrorPhotoAsCapture(db, saved, sourcePath ?? saved.filePath)
      return saved
    },
  }
}

export interface WatchedPhotoQrResult {
  studentId: string
}

export interface WatchedPhotoProcessorOptions {
  store: WatchedPhotoStore
  photosDir: string
  readQr: (filePath: string) => Promise<WatchedPhotoQrResult | null>
  targetStudentId?: number | null
  capturedAt?: string
  diagnosticId?: string
  deferPersistence?: boolean
  onPreviewReady?: (context: {
    filePath: string
    fileName: string
    capturedAt: string
    student: StudentRow
  }) => Promise<string | null> | string | null
}

export type WatchedPhotoResult =
  | {
      kind: 'matched'
      photo: typeof photosTable.$inferSelect
      student: typeof studentsTable.$inferSelect
      thumbnailData?: string | null
    }
  | {
      kind: 'matched-pending'
      student: typeof studentsTable.$inferSelect
      thumbnailData?: string | null
      persist: () => Promise<typeof photosTable.$inferSelect>
    }
  | {
      kind: 'unmatched'
      filePath: string
      fileName: string
      reason: string
    }

function now() {
  return new Date().toISOString()
}

function safeFolderName(value: string): string {
  return value.trim().replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/\s+/g, ' ').slice(0, 120) || 'Unknown'
}

function saveUnmatchedPhoto(
  store: WatchedPhotoStore,
  projectId: number,
  filePath: string,
  fileName: string,
  reason: string,
): WatchedPhotoResult {
  store.insertPhoto({
    projectId,
    studentId: null,
    filePath,
    fileName,
    capturedAt: now(),
    isMatched: false,
  })

  return {
    kind: 'unmatched',
    filePath,
    fileName,
    reason,
  }
}

interface MatchedPhotoPersistenceContext {
  project: ProjectRow
  student: StudentRow
  classRow: ClassRow | undefined
  filePath: string
  fileName: string
  capturedAt: string
}

export async function persistMatchedPhoto(
  store: WatchedPhotoStore,
  photosDir: string,
  context: MatchedPhotoPersistenceContext,
  diagnosticId?: string,
): Promise<PhotoRow> {
  const projectFolder = safeFolderName(context.project.schoolName)
  const classFolder = safeFolderName(context.classRow?.className ?? 'Unassigned Class')
  const studentFolder = safeFolderName(
    `${context.student.generatedStudentId}_${context.student.lastName}_${context.student.firstName}`,
  )
  const destDir = join(photosDir, projectFolder, classFolder, studentFolder)
  await mkdir(destDir, { recursive: true })
  const destPath = join(destDir, context.fileName)
  markImagePipeline(diagnosticId, 'file move started', `destination=${destPath} mode=async-copy`)
  await copyFile(context.filePath, destPath)
  markImagePipeline(diagnosticId, 'file move complete', `destination=${destPath} mode=async-copy`)

  markImagePipeline(diagnosticId, 'database write started', `file=${context.fileName}`)
  const photo = store.insertPhoto({
    projectId: context.project.id,
    studentId: context.student.id,
    filePath: destPath,
    fileName: context.fileName,
    capturedAt: context.capturedAt,
    isMatched: true,
  })
  markImagePipeline(diagnosticId, 'database write complete', `photo=${photo.id}`)
  return photo
}

/**
 * Process one file discovered by the Smart Shooter watcher.
 *
 * The source file is only read for QR fallback and copied on a match. It is
 * never moved, renamed, or deleted from the watch folder.
 */
export async function processWatchedPhoto(
  projectId: number,
  filePath: string,
  {
    store,
    photosDir,
    readQr,
    targetStudentId = null,
    capturedAt,
    diagnosticId,
    onPreviewReady,
    deferPersistence = false,
  }: WatchedPhotoProcessorOptions,
): Promise<WatchedPhotoResult> {
  const fileName = basename(filePath)
  const project = store.findProject(projectId)
  if (!project) throw new Error(`Project ${projectId} not found`)

  const knownStudents = store.listStudents(projectId)
  const filenameReference = extractStudentReference(
    fileName,
    knownStudents.map((student) => student.generatedStudentId),
  )
  const qrResult = filenameReference ? null : await readQr(filePath)
  const reference = filenameReference ?? qrResult?.studentId

  if (!reference && targetStudentId === null) {
    return saveUnmatchedPhoto(store, projectId, filePath, fileName, 'No QR code detected')
  }

  // The ID lookup is scoped to this project so an ID from another project
  // cannot accidentally assign a photo to the wrong student.
  const student = reference
    ? store.findStudent(projectId, reference)
    : store.listStudents(projectId).find((candidate) => candidate.id === targetStudentId)

  markImagePipeline(
    diagnosticId,
    'student lookup complete',
    `reference=${reference ?? 'none'} student=${student?.id ?? 'none'} file=${fileName}`,
  )

  if (!student) {
    return saveUnmatchedPhoto(
      store,
      projectId,
      filePath,
      fileName,
      reference
        ? `Student ID "${reference}" not found in this project`
        : `Selected student "${targetStudentId}" was not found in this project`,
    )
  }

  if (targetStudentId !== null && reference && student.id !== targetStudentId) {
    return saveUnmatchedPhoto(
      store,
      projectId,
      filePath,
      fileName,
      `Filename student ID "${reference}" conflicts with the selected student`,
    )
  }

  const effectiveCapturedAt = capturedAt ?? now()
  markImagePipeline(
    diagnosticId,
    'student assigned',
    `student=${student.id} file=${fileName}`,
  )
  const thumbnailData = await onPreviewReady?.({
    filePath,
    fileName,
    capturedAt: effectiveCapturedAt,
    student,
  })

  const context = {
    project,
    student,
    classRow: store.findClass(student.classId),
    filePath,
    fileName,
    capturedAt: effectiveCapturedAt,
  }
  if (deferPersistence) {
    return {
      kind: 'matched-pending',
      student,
      thumbnailData,
      persist: () => persistMatchedPhoto(store, photosDir, context, diagnosticId),
    }
  }

  const photo = await persistMatchedPhoto(store, photosDir, context, diagnosticId)
  return { kind: 'matched', photo, student, thumbnailData }
}