import { ipcMain, shell, BrowserWindow } from 'electron'
import { copyFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { and, eq, count, or } from 'drizzle-orm'
import { getDb, getPhotosDir } from '../db'
import { capturesTable, imageFilesTable, photosTable, qrMarkersTable, studentsTable } from '../db/schema'
import { generateThumbnail } from '../lib/qrReader'
import type {
  CaptureCompletenessSummary,
  CaptureReview,
  StudentCaptureReview,
  Photo,
} from '../../shared/types'

function getMainWindow(): BrowserWindow | null {
  const wins = BrowserWindow.getAllWindows()
  return wins.length > 0 ? wins[0] : null
}

function now() {
  return new Date().toISOString()
}

function rowToPhoto(row: typeof photosTable.$inferSelect, thumbnailData: string | null = null): Photo {
  return {
    id: row.id,
    projectId: row.projectId,
    studentId: row.studentId,
    filePath: row.filePath,
    fileName: row.fileName,
    capturedAt: row.capturedAt,
    isMatched: row.isMatched,
    thumbnailData,
    createdAt: row.createdAt,
  }
}

function rowToCaptureFile(row: typeof imageFilesTable.$inferSelect) {
  return {
    id: row.id,
    fileRole: row.fileRole,
    fileFormat: row.fileFormat,
    originalFilename: row.originalFilename,
    storedPath: row.storedPath,
    fileSize: row.fileSize,
    uploadStatus: row.uploadStatus,
    fileUrl: row.fileUrl,
  }
}

function getCaptureSummary(rows: Array<typeof capturesTable.$inferSelect>): CaptureCompletenessSummary {
  return rows.reduce<CaptureCompletenessSummary>(
    (summary, capture) => {
      summary.total++
      if (capture.pairingStatus === 'complete') summary.complete++
      else if (capture.pairingStatus === 'jpeg_only') summary.jpegOnly++
      else if (capture.pairingStatus === 'raw_only') summary.rawOnly++
      else summary.unpaired++
      return summary
    },
    { total: 0, complete: 0, jpegOnly: 0, rawOnly: 0, unpaired: 0 },
  )
}

export function registerPhotoHandlers() {
  const db = getDb()

  ipcMain.handle('photos:list', async (_e, { studentId }: { studentId: number }): Promise<Photo[]> => {
    const rows = db
      .select()
      .from(photosTable)
      .where(eq(photosTable.studentId, studentId))
      .orderBy(photosTable.capturedAt)
      .all()

    const result: Photo[] = []
    for (const row of rows) {
      const thumb = await generateThumbnail(row.filePath)
      result.push(rowToPhoto(row, thumb))
    }
    return result
  })

  ipcMain.handle(
    'captures:list',
    async (_e, { studentId }: { studentId: number }): Promise<StudentCaptureReview> => {
      const rows = db
        .select({ capture: capturesTable, photo: photosTable })
        .from(capturesTable)
        .leftJoin(photosTable, eq(capturesTable.legacyPhotoId, photosTable.id))
        .where(or(
          eq(capturesTable.studentId, studentId),
          eq(photosTable.studentId, studentId),
        ))
        .orderBy(capturesTable.capturedAt)
        .all()

      const result: CaptureReview[] = []
      for (const { capture, photo } of rows) {
        const files = db
          .select()
          .from(imageFilesTable)
          .where(eq(imageFilesTable.captureId, capture.id))
          .all()
        const jpegFile = files.find((file) => file.fileRole === 'JPEG')
        const thumbnailData = jpegFile ? await generateThumbnail(jpegFile.storedPath) : null
        result.push({
          id: capture.id,
          projectId: capture.projectId,
          studentId: capture.studentId,
          classId: capture.classId,
          baseFilename: capture.baseFilename,
          capturedAt: capture.capturedAt,
          sequence: capture.sequence,
          favorite: capture.favorite,
          rejected: capture.rejected,
          selected: capture.selected,
          pairingStatus: capture.pairingStatus,
          assignmentLocked: capture.assignmentLocked,
          files: files.map(rowToCaptureFile),
          thumbnailData,
          legacyPhoto: photo ? rowToPhoto(photo, thumbnailData) : null,
        })
      }
      const markerRows = db
        .select()
        .from(qrMarkersTable)
        .where(eq(qrMarkersTable.studentId, studentId))
        .orderBy(qrMarkersTable.capturedAt)
        .all()
      const qrMarkers = await Promise.all(markerRows.map(async (marker) => ({
        id: marker.id,
        projectId: marker.projectId,
        studentId: marker.studentId,
        filePath: marker.filePath,
        fileName: marker.fileName,
        capturedAt: marker.capturedAt,
        thumbnailData: await generateThumbnail(marker.filePath),
        createdAt: marker.createdAt,
      })))

      return { captures: result, qrMarkers }
    },
  )

  ipcMain.handle(
    'captures:summary',
    (_e, { projectId }: { projectId: number }): CaptureCompletenessSummary => {
      const rows = db
        .select()
        .from(capturesTable)
        .where(eq(capturesTable.projectId, projectId))
        .all()
      return getCaptureSummary(rows)
    },
  )

  ipcMain.handle(
    'captures:updateReview',
    (
      _e,
      {
        captureId,
        favorite,
        rejected,
        selected,
      }: {
        captureId: number
        favorite?: boolean
        rejected?: boolean
        selected?: boolean
      },
    ) => {
      const capture = db.select().from(capturesTable).where(eq(capturesTable.id, captureId)).get()
      if (!capture) return null
      db.update(capturesTable)
        .set({
          ...(favorite === undefined ? {} : { favorite }),
          ...(rejected === undefined ? {} : { rejected }),
          ...(selected === undefined ? {} : { selected }),
          updatedAt: now(),
        })
        .where(eq(capturesTable.id, captureId))
        .run()
      return db.select().from(capturesTable).where(eq(capturesTable.id, captureId)).get() ?? null
    },
  )

  ipcMain.handle(
    'photos:getThumbnail',
    async (_e, { filePath }: { filePath: string }): Promise<string | null> => {
      return generateThumbnail(filePath)
    },
  )

  ipcMain.handle(
    'photos:reassign',
    async (_e, { photoId, studentId }: { photoId: number; studentId: number }) => {
      const db = getDb()
      const [photo] = db.select().from(photosTable).where(eq(photosTable.id, photoId)).all()
      if (!photo) return

      // Move file to new student's folder
      const student = db.select().from(studentsTable).where(eq(studentsTable.id, studentId)).get()
      if (!student) return

      const destDir = join(getPhotosDir(), String(photo.projectId), student.generatedStudentId)
      mkdirSync(destDir, { recursive: true })
      const destPath = join(destDir, photo.fileName)

      copyFileSync(photo.filePath, destPath)

      db.update(photosTable)
        .set({ studentId, filePath: destPath, isMatched: true })
        .where(eq(photosTable.id, photoId))
        .run()
      const capture = db
        .select()
        .from(capturesTable)
        .where(eq(capturesTable.legacyPhotoId, photoId))
        .get()
      if (capture) {
        db.update(imageFilesTable)
          .set({ storedPath: destPath })
          .where(and(
            eq(imageFilesTable.captureId, capture.id),
            eq(imageFilesTable.fileRole, 'JPEG'),
          ))
          .run()
        db.update(capturesTable)
          .set({ updatedAt: now() })
          .where(eq(capturesTable.id, capture.id))
          .run()
      }

      // Notify renderer so sidebar counts update immediately
      const win = getMainWindow()
      win?.webContents.send('photo:reassigned', {
        photoId,
        projectId: photo.projectId,
        fromStudentId: photo.studentId,
        toStudentId: studentId,
      })
      if (capture) {
        win?.webContents.send('capture:updated', {
          projectId: photo.projectId,
          captureId: capture.id,
          studentId,
        })
      }
    },
  )

  ipcMain.handle('photos:delete', async (_e, { photoId }: { photoId: number }) => {
    // Fetch before deleting so we can include projectId in the event
    const [photo] = db.select().from(photosTable).where(eq(photosTable.id, photoId)).all()
    const capture = db
      .select()
      .from(capturesTable)
      .where(eq(capturesTable.legacyPhotoId, photoId))
      .get()
    db.delete(photosTable).where(eq(photosTable.id, photoId)).run()
    if (capture) {
      db.delete(imageFilesTable)
        .where(and(
          eq(imageFilesTable.captureId, capture.id),
          eq(imageFilesTable.fileRole, 'JPEG'),
        ))
        .run()
      const remainingFiles = db
        .select()
        .from(imageFilesTable)
        .where(eq(imageFilesTable.captureId, capture.id))
        .all()
      if (remainingFiles.length === 0) {
        db.delete(capturesTable).where(eq(capturesTable.id, capture.id)).run()
      } else {
        db.update(capturesTable)
          .set({
            legacyPhotoId: null,
            pairingStatus: 'raw_only',
            updatedAt: now(),
          })
          .where(eq(capturesTable.id, capture.id))
          .run()
      }
    }

    // Notify renderer so sidebar counts update immediately
    if (photo) {
      const win = getMainWindow()
      win?.webContents.send('photo:deleted', {
        photoId,
        projectId: photo.projectId,
        studentId: photo.studentId,
      })
      if (capture) {
        win?.webContents.send('capture:updated', {
          projectId: photo.projectId,
          captureId: capture.id,
          studentId: photo.studentId,
        })
      }
    }
  })

  ipcMain.handle('photos:unmatched', async (_e, { projectId }: { projectId: number }): Promise<Photo[]> => {
    const rows = db
      .select()
      .from(photosTable)
      .where(eq(photosTable.projectId, projectId))
      .all()
      .filter((r) => !r.isMatched)

    const result: Photo[] = []
    for (const row of rows) {
      const thumb = await generateThumbnail(row.filePath)
      result.push(rowToPhoto(row, thumb))
    }
    return result
  })

  ipcMain.handle('photos:openInSystem', async (_e, { filePath }: { filePath: string }) => {
    await shell.openPath(filePath)
  })
}
