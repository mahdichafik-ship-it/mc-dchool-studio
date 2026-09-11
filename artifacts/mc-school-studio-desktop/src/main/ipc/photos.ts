import { app, ipcMain, shell, BrowserWindow } from 'electron'
import { copyFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { and, eq, count, or, isNull } from 'drizzle-orm'
import { getDb, getPhotosDir } from '../db'
import { capturesTable, imageFilesTable, photosTable, qrMarkersTable, studentsTable, groupCapturesTable, groupCaptureFilesTable } from '../db/schema'
import { generateLivePreview, getLivePreviewCacheDir } from '../lib/livePreview'
import { createLocalPreviewUrl } from '../lib/localPreviewProtocol'
import { reconcileLegacyPhotosAsCaptures } from '../lib/captureRepository'
import { syncCaptureReview, syncGroupCaptureReview } from './upload'
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

function rowToPhoto(
  row: typeof photosTable.$inferSelect,
  thumbnailData: string | null = null,
  previewUrl?: string,
): Photo {
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
    previewUrl,
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

function rowToGroupCaptureFile(row: typeof groupCaptureFilesTable.$inferSelect) {
  return {
    id: row.id,
    fileRole: row.fileRole,
    fileFormat: row.fileFormat,
    originalFilename: row.originalFilename,
    storedPath: row.storedPath,
    fileSize: row.fileSize,
    uploadStatus: row.uploadStatus,
    fileUrl: row.fileUrl,
    galleryReady: row.galleryReady,
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

  ipcMain.handle('groupCaptures:list', async (_e, { projectId, groupId }: { projectId: number; groupId: number }) => {
    const rows = db.select().from(groupCapturesTable)
      .where(and(eq(groupCapturesTable.projectId, projectId), eq(groupCapturesTable.groupId, groupId)))
      .all()
    return Promise.all(rows.map(async (row) => ({
      id: row.id,
      projectId: row.projectId,
      groupId: row.groupId,
      baseFilename: row.baseFilename,
      capturedAt: row.capturedAt,
      pairingStatus: row.pairingStatus,
      rating: row.rating,
      files: await Promise.all(db.select().from(groupCaptureFilesTable)
        .where(eq(groupCaptureFilesTable.captureId, row.id)).all().map(async (file) => {
          const mapped = rowToGroupCaptureFile(file)
          if (file.fileRole !== 'JPEG') return mapped
          const previewPath = await generateLivePreview(file.storedPath, {
            previewKey: `group-capture-${row.id}`,
            cacheDir: getLivePreviewCacheDir(app.getPath('home')),
          })
          return { ...mapped, previewUrl: previewPath ? createLocalPreviewUrl(previewPath, `group-capture-${row.id}`) : undefined }
        })),
    })))
  })
  ipcMain.handle('groupCaptures:summary', async (_e, { projectId }: { projectId: number }) =>
    db.select().from(groupCapturesTable).where(eq(groupCapturesTable.projectId, projectId)).all().length)
  ipcMain.handle('captures:reviewSummary', async (_e, { projectId }: { projectId: number }) => {
    const portraitCaptures = db.select().from(capturesTable)
      .where(eq(capturesTable.projectId, projectId)).all()
      .filter((capture) => capture.studentId !== null)
    const portraitJpegCaptureIds = new Set(
      db.select({ captureId: imageFilesTable.captureId }).from(imageFilesTable)
        .where(eq(imageFilesTable.fileRole, 'JPEG')).all()
        .map((file) => file.captureId),
    )
    const groupCaptures = db.select().from(groupCapturesTable)
      .where(eq(groupCapturesTable.projectId, projectId)).all()
    const groupJpegCaptureIds = new Set(
      db.select({ captureId: groupCaptureFilesTable.captureId }).from(groupCaptureFilesTable)
        .where(eq(groupCaptureFilesTable.fileRole, 'JPEG')).all()
        .map((file) => file.captureId),
    )
    return {
      unratedPortraits: portraitCaptures.filter((capture) =>
        portraitJpegCaptureIds.has(capture.id)
        && capture.rating <= 0
        && !capture.rejected).length,
      unratedGroups: groupCaptures.filter((capture) =>
        groupJpegCaptureIds.has(capture.id)
        && capture.rating <= 0).length,
    }
  })
  ipcMain.handle('groupCaptures:updateReview', async (_e, { captureId, rating }: { captureId: number; rating: number }) => {
    const capture = db.select().from(groupCapturesTable).where(eq(groupCapturesTable.id, captureId)).get()
    if (!capture) return null
    db.update(groupCapturesTable).set({
      rating: Math.max(0, Math.min(5, Math.round(rating))),
      reviewSyncPending: true,
      updatedAt: now(),
    }).where(eq(groupCapturesTable.id, captureId)).run()
    void syncGroupCaptureReview(captureId)
    return db.select().from(groupCapturesTable).where(eq(groupCapturesTable.id, captureId)).get() ?? null
  })

  ipcMain.handle('photos:list', async (_e, { studentId }: { studentId: number }): Promise<Photo[]> => {
    const rows = db
      .select()
      .from(photosTable)
      .where(eq(photosTable.studentId, studentId))
      .orderBy(photosTable.capturedAt)
      .all()

    const result: Photo[] = []
    for (const row of rows) {
      const previewPath = await generateLivePreview(row.filePath, {
        previewKey: `gallery-photo-${row.id}`,
        cacheDir: getLivePreviewCacheDir(app.getPath('home')),
      })
      result.push(rowToPhoto(
        row,
        null,
        previewPath
          ? createLocalPreviewUrl(previewPath, `gallery-photo-${row.id}`)
          : undefined,
      ))
    }
    return result
  })

  ipcMain.handle(
    'captures:list',
    async (_e, { studentId }: { studentId: number }): Promise<StudentCaptureReview> => {
      const legacyPhotos = db
        .select()
        .from(photosTable)
        .where(eq(photosTable.studentId, studentId))
        .all()
      reconcileLegacyPhotosAsCaptures(db, legacyPhotos)

      const rows = db
        .select({ capture: capturesTable, photo: photosTable })
        .from(capturesTable)
        .leftJoin(photosTable, eq(capturesTable.legacyPhotoId, photosTable.id))
        .where(or(
          and(isNull(capturesTable.groupId), eq(capturesTable.studentId, studentId)),
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
        const sourcePath = jpegFile?.storedPath ?? photo?.filePath
        const previewPath = sourcePath
          ? await generateLivePreview(sourcePath, {
            previewKey: `gallery-capture-${capture.id}`,
            cacheDir: getLivePreviewCacheDir(app.getPath('home')),
          })
          : null
        const previewUrl = previewPath
          ? createLocalPreviewUrl(previewPath, `gallery-capture-${capture.id}`)
          : undefined
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
          rating: capture.rating,
          colorLabel: capture.colorLabel,
          pairingStatus: capture.pairingStatus,
          assignmentLocked: capture.assignmentLocked,
          files: files.map(rowToCaptureFile),
          thumbnailData: null,
          legacyPhoto: photo ? rowToPhoto(photo, null, previewUrl) : null,
        })
      }
      const markerRows = db
        .select()
        .from(qrMarkersTable)
        .where(eq(qrMarkersTable.studentId, studentId))
        .orderBy(qrMarkersTable.capturedAt)
        .all()
      const qrMarkers = await Promise.all(markerRows.map(async (marker) => {
        const previewPath = await generateLivePreview(marker.filePath, {
          previewKey: `gallery-marker-${marker.id}`,
          cacheDir: getLivePreviewCacheDir(app.getPath('home')),
        })
        return {
          id: marker.id,
          projectId: marker.projectId,
          studentId: marker.studentId,
          filePath: marker.filePath,
          fileName: marker.fileName,
          capturedAt: marker.capturedAt,
          thumbnailData: null,
          previewUrl: previewPath
            ? createLocalPreviewUrl(previewPath, `gallery-marker-${marker.id}`)
            : undefined,
          createdAt: marker.createdAt,
        }
      }))

      return { captures: result, qrMarkers }
    },
  )

  ipcMain.handle(
    'captures:summary',
    (_e, { projectId }: { projectId: number }): CaptureCompletenessSummary => {
      const legacyPhotos = db
        .select()
        .from(photosTable)
        .where(eq(photosTable.projectId, projectId))
        .all()
      reconcileLegacyPhotosAsCaptures(db, legacyPhotos)

      const rows = db
        .select()
        .from(capturesTable)
        .where(and(eq(capturesTable.projectId, projectId), isNull(capturesTable.groupId)))
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
        rating,
        colorLabel,
      }: {
        captureId: number
        favorite?: boolean
        rejected?: boolean
        selected?: boolean
        rating?: number
        colorLabel?: 'none' | 'red' | 'yellow' | 'green' | 'blue' | 'purple'
      },
    ) => {
      const capture = db.select().from(capturesTable).where(eq(capturesTable.id, captureId)).get()
      if (!capture) return null
      db.update(capturesTable)
        .set({
          ...(favorite === undefined ? {} : { favorite }),
          ...(rejected === undefined ? {} : { rejected }),
          ...(rating === undefined
            ? (selected === undefined ? {} : { selected })
            : { selected: rating > 0 }),
          ...(rating === undefined ? {} : { rating: Math.max(0, Math.min(5, Math.round(rating))) }),
          ...(colorLabel === undefined ? {} : { colorLabel }),
          reviewSyncPending: true,
          updatedAt: now(),
        })
        .where(eq(capturesTable.id, captureId))
        .run()
      const updated = db.select().from(capturesTable).where(eq(capturesTable.id, captureId)).get() ?? null
      if (updated) void syncCaptureReview(updated.id)
      return updated
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
