import { ipcMain } from 'electron'
import { copyFileSync, existsSync, mkdirSync } from 'fs'
import { join, resolve, sep } from 'path'
import { eq, and, isNull } from 'drizzle-orm'
import { getDb } from '../db'
import {
  capturesTable,
  classesTable,
  imageFilesTable,
  projectsTable,
  studentsTable,
} from '../db/schema'
import { buildLightroomFilename } from '../lib/lightroomExport'
import type {
  CaptureExportLayout,
  CaptureExportMode,
  CaptureExportResult,
} from '../../shared/types'

function safeName(value: string): string {
  const cleaned = value
    .normalize('NFKC')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100)
  return cleaned && cleaned !== '.' && cleaned !== '..' ? cleaned : 'captures'
}

export function shouldExport(
  mode: CaptureExportMode,
  capture: Pick<typeof capturesTable.$inferSelect, 'pairingStatus' | 'selected' | 'favorite' | 'rejected'>,
): boolean {
  switch (mode) {
    case 'paired':
      return capture.pairingStatus === 'complete'
    case 'jpeg_only':
      return capture.pairingStatus === 'jpeg_only'
    case 'raw_only':
      return capture.pairingStatus === 'raw_only'
    case 'selected':
      return capture.selected
    case 'favorite':
      return capture.favorite
    case 'final_selection':
      return capture.selected && !capture.rejected
    case 'all':
      return true
  }
}

export interface CaptureExportRecord {
  capture: Pick<
    typeof capturesTable.$inferSelect,
    'id' | 'pairingStatus' | 'selected' | 'favorite' | 'rejected' | 'baseFilename' | 'sequence' | 'capturedAt'
  >
  files: Array<Pick<
    typeof imageFilesTable.$inferSelect,
    'fileRole' | 'fileFormat' | 'originalFilename' | 'storedPath'
  >>
  className: string | null
  student: {
    firstName: string
    lastName: string
    generatedStudentId: string
  } | null
}

export interface CaptureExportInput {
  project: Pick<typeof projectsTable.$inferSelect, 'schoolName'>
  records: CaptureExportRecord[]
  destinationDir: string
  mode: CaptureExportMode
  layout?: CaptureExportLayout
}

function isPathInside(parentDir: string, candidatePath: string): boolean {
  const parent = resolve(parentDir)
  const candidate = resolve(candidatePath)
  return candidate === parent || candidate.startsWith(`${parent}${sep}`)
}

export function exportCaptureRecords({
  project,
  records,
  destinationDir,
  mode,
  layout = 'capture_folders',
}: CaptureExportInput): CaptureExportResult {
  const outputDir = layout === 'lightroom_watch_folder'
    ? destinationDir
    : join(destinationDir, `${safeName(project.schoolName)}-captures`)
  mkdirSync(outputDir, { recursive: true })

  let exportedCaptureCount = 0
  let exportedFileCount = 0
  let skippedMissingFiles = 0
  let skippedExistingFiles = 0

  for (const { capture, files, className, student } of records.filter(
    ({ capture }) => shouldExport(mode, capture),
  )) {
    const sequence = String(capture.sequence ?? capture.id).padStart(6, '0')
    const captureDir = join(outputDir, `${sequence}_${safeName(capture.baseFilename)}`)
    let captureExported = false

    for (const file of files) {
      if (!existsSync(file.storedPath)) {
        skippedMissingFiles++
        continue
      }
      const destinationPath = layout === 'lightroom_watch_folder'
        ? join(outputDir, buildLightroomFilename({
            schoolName: project.schoolName,
            className,
            student,
            captureId: capture.id,
            sequence: capture.sequence,
            originalFilename: file.originalFilename,
            fileRole: file.fileRole,
            fileFormat: file.fileFormat,
          }))
        : join(captureDir, safeName(file.originalFilename))
      const destinationParent = layout === 'lightroom_watch_folder' ? outputDir : captureDir
      if (!isPathInside(destinationParent, destinationPath)) {
        skippedMissingFiles++
        continue
      }
      if (layout === 'lightroom_watch_folder' && existsSync(destinationPath)) {
        skippedExistingFiles++
        continue
      }
      if (layout === 'capture_folders') mkdirSync(captureDir, { recursive: true })
      copyFileSync(file.storedPath, destinationPath)
      exportedFileCount++
      captureExported = true
    }
    if (captureExported) exportedCaptureCount++
  }

  return {
    ok: true,
    outputDir,
    exportedCaptureCount,
    exportedFileCount,
    skippedMissingFiles,
    skippedExistingFiles,
  }
}

export function registerCaptureExportHandlers(): void {
  ipcMain.handle(
    'captures:export',
    (
      _event,
      {
        projectId,
        destinationDir,
        mode,
        layout = 'capture_folders',
      }: {
        projectId: number
        destinationDir: string
        mode: CaptureExportMode
        layout?: CaptureExportLayout
      },
    ): CaptureExportResult => {
      if (!destinationDir || !Number.isInteger(projectId)) {
        return { ok: false, error: 'Choose a destination folder and a valid project.' }
      }
      try {
        const db = getDb()
        const project = db.select().from(projectsTable).where(eq(projectsTable.id, projectId)).get()
        if (!project) return { ok: false, error: 'Project not found.' }
        const captures = db
          .select()
          .from(capturesTable)
          .where(and(eq(capturesTable.projectId, projectId), isNull(capturesTable.groupId)))
          .all()
        return exportCaptureRecords({
          project,
          mode,
          layout,
          destinationDir,
          records: captures.map((capture) => {
            const captureClass = capture.classId === null
              ? null
              : db.select().from(classesTable).where(eq(classesTable.id, capture.classId)).get()
            const student = capture.studentId === null
              ? null
              : db.select().from(studentsTable).where(eq(studentsTable.id, capture.studentId)).get() ?? null
            return {
              capture,
              files: db
                .select()
                .from(imageFilesTable)
                .where(eq(imageFilesTable.captureId, capture.id))
                .all(),
              className: captureClass?.className ?? null,
              student,
            }
          }),
        })
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
  )
}