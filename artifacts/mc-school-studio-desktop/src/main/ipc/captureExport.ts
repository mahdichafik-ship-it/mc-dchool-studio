import { ipcMain } from 'electron'
import { copyFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { eq } from 'drizzle-orm'
import { getDb } from '../db'
import { capturesTable, imageFilesTable, projectsTable } from '../db/schema'
import type { CaptureExportMode, CaptureExportResult } from '../../shared/types'

function safeName(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100) || 'captures'
}

function shouldExport(
  mode: CaptureExportMode,
  capture: typeof capturesTable.$inferSelect,
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

export function registerCaptureExportHandlers(): void {
  ipcMain.handle(
    'captures:export',
    (
      _event,
      {
        projectId,
        destinationDir,
        mode,
      }: { projectId: number; destinationDir: string; mode: CaptureExportMode },
    ): CaptureExportResult => {
      if (!destinationDir || !Number.isInteger(projectId)) {
        return { ok: false, error: 'Choose a destination folder and a valid project.' }
      }
      try {
        const db = getDb()
        const project = db.select().from(projectsTable).where(eq(projectsTable.id, projectId)).get()
        if (!project) return { ok: false, error: 'Project not found.' }

        const outputDir = join(destinationDir, `${safeName(project.schoolName)}-captures`)
        mkdirSync(outputDir, { recursive: true })
        const captures = db
          .select()
          .from(capturesTable)
          .where(eq(capturesTable.projectId, projectId))
          .all()
          .filter((capture) => shouldExport(mode, capture))

        let exportedCaptureCount = 0
        let exportedFileCount = 0
        let skippedMissingFiles = 0

        for (const capture of captures) {
          const files = db
            .select()
            .from(imageFilesTable)
            .where(eq(imageFilesTable.captureId, capture.id))
            .all()
          const sequence = String(capture.sequence ?? capture.id).padStart(6, '0')
          const captureDir = join(outputDir, `${sequence}_${safeName(capture.baseFilename)}`)
          let captureExported = false

          for (const file of files) {
            if (!existsSync(file.storedPath)) {
              skippedMissingFiles++
              continue
            }
            mkdirSync(captureDir, { recursive: true })
            copyFileSync(file.storedPath, join(captureDir, safeName(file.originalFilename)))
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
        }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
  )
}