import { copyFileSync, mkdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import { and, eq } from 'drizzle-orm'
import type { getDb } from '../db'
import { classesTable, photosTable, projectsTable, studentsTable } from '../db/schema.ts'
import { extractStudentReference } from './photoFileNaming.ts'
import { mirrorPhotoAsCapture } from './captureRepository.ts'

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
}

export type WatchedPhotoResult =
  | {
      kind: 'matched'
      photo: typeof photosTable.$inferSelect
      student: typeof studentsTable.$inferSelect
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

/**
 * Process one file discovered by the Smart Shooter watcher.
 *
 * The source file is only read for QR fallback and copied on a match. It is
 * never moved, renamed, or deleted from the watch folder.
 */
export async function processWatchedPhoto(
  projectId: number,
  filePath: string,
  { store, photosDir, readQr, targetStudentId = null, capturedAt }: WatchedPhotoProcessorOptions,
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

  const classRow = store.findClass(student.classId)
  const projectFolder = safeFolderName(project.schoolName)
  const classFolder = safeFolderName(classRow?.className ?? 'Unassigned Class')
  const studentFolder = safeFolderName(`${student.generatedStudentId}_${student.lastName}_${student.firstName}`)
  const destDir = join(photosDir, projectFolder, classFolder, studentFolder)
  mkdirSync(destDir, { recursive: true })
  const destPath = join(destDir, fileName)
  copyFileSync(filePath, destPath)

  const photo = store.insertPhoto({
    projectId,
    studentId: student.id,
    filePath: destPath,
    fileName,
    capturedAt: capturedAt ?? now(),
    isMatched: true,
  })

  return { kind: 'matched', photo, student }
}