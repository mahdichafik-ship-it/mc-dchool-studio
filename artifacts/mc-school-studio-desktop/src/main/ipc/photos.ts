import { app, ipcMain, shell, BrowserWindow } from 'electron'
import { copyFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from 'fs'
import { basename, dirname, extname, join } from 'path'
import { randomUUID } from 'crypto'
import { and, eq, count, or, isNull, ne } from 'drizzle-orm'
import { getDb, getPhotosDir } from '../db'
import { capturesTable, groupMembersTable, groupsTable, imageFilesTable, photosTable, projectsTable, qrMarkersTable, studentsTable, groupCapturesTable, groupCaptureFilesTable } from '../db/schema'
import {
  generateLivePreview,
  getCachedLivePreview,
  getLivePreviewCacheDir,
} from '../lib/livePreview'
import { createLocalPreviewUrl } from '../lib/localPreviewProtocol'
import { reconcileLegacyPhotosAsCaptures } from '../lib/captureRepository'
import { buildCaptureReviewStatus } from '../lib/captureReviewStatus'
import { groupFiveStarReplacementIds, portraitFiveStarReplacementIds } from '../lib/reviewRatingReplacement'
import { syncCaptureReview, syncGroupCaptureReview } from './upload'
import type {
  CaptureCompletenessSummary,
  CaptureAspectRatio,
  CaptureFraming,
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

function normalizeReviewFlags(
  capture: typeof capturesTable.$inferSelect,
  values: {
    favorite?: boolean
    rejected?: boolean
    selected?: boolean
    rating?: number
  },
) {
  const rating = values.rating === undefined
    ? capture.rating
    : Math.max(0, Math.min(5, Math.round(values.rating)))
  const rejected = values.rejected
    ?? (values.selected === true || (values.rating !== undefined && rating > 0) ? false : capture.rejected)
  const selected = values.selected
    ?? (values.rating !== undefined ? rating > 0 : capture.selected)
  return {
    favorite: values.favorite ?? capture.favorite,
    rejected,
    selected: rejected ? false : selected,
    rating,
  }
}

const captureAspectRatios: CaptureAspectRatio[] = ['original', '1:1', '4:5', '5:7', '3:2', '7:5', '16:9']
const captureRotations = [0, 90, 180, 270] as const

function captureFraming(row: typeof capturesTable.$inferSelect): CaptureFraming {
  return {
    cropX: row.cropX,
    cropY: row.cropY,
    cropScale: row.cropScale,
    aspectRatio: captureAspectRatios.includes(row.aspectRatio as CaptureAspectRatio)
      ? row.aspectRatio as CaptureAspectRatio
      : 'original',
    straightenAngle: row.straightenAngle,
    rotation: captureRotations.includes(row.rotation as typeof captureRotations[number])
      ? row.rotation as typeof captureRotations[number]
      : 0,
    pending: row.reframePending,
  }
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

function rowToCaptureFile(row: typeof imageFilesTable.$inferSelect, previewUrl?: string) {
  return {
    id: row.id,
    fileRole: row.fileRole,
    fileFormat: row.fileFormat,
    originalFilename: row.originalFilename,
    storedPath: row.storedPath,
    fileSize: row.fileSize,
    uploadStatus: row.uploadStatus,
    fileUrl: row.fileUrl,
    ...(previewUrl ? { previewUrl } : {}),
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

function getCaptureSummary(
  rows: Array<typeof capturesTable.$inferSelect>,
  files: Array<Pick<typeof imageFilesTable.$inferSelect, 'captureId' | 'fileRole'>>,
): CaptureCompletenessSummary {
  const filesByCapture = new Map<number, Array<Pick<typeof imageFilesTable.$inferSelect, 'captureId' | 'fileRole'>>>()
  for (const file of files) {
    const captureFiles = filesByCapture.get(file.captureId) ?? []
    captureFiles.push(file)
    filesByCapture.set(file.captureId, captureFiles)
  }

  return rows.reduce<CaptureCompletenessSummary>(
    (summary, capture) => {
      const captureFiles = filesByCapture.get(capture.id) ?? []
      summary.total++
      summary.jpegFiles += captureFiles.filter((file) => file.fileRole === 'JPEG').length
      summary.rawFiles += captureFiles.filter((file) => file.fileRole === 'RAW').length
      if (capture.pairingStatus === 'complete') summary.complete++
      else if (capture.pairingStatus === 'jpeg_only') summary.jpegOnly++
      else if (capture.pairingStatus === 'raw_only') summary.rawOnly++
      else summary.unpaired++
      if (capture.pairingStatus !== 'complete') summary.incompletePairs++
      return summary
    },
    {
      total: 0,
      complete: 0,
      jpegOnly: 0,
      rawOnly: 0,
      unpaired: 0,
      jpegFiles: 0,
      rawFiles: 0,
      incompletePairs: 0,
    },
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
           const previewPath = await getCachedLivePreview(
             `group-capture-${row.id}`,
             getLivePreviewCacheDir(app.getPath('home')),
           )
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
  ipcMain.handle('captures:reviewStatus', (_e, { projectId }: { projectId: number }) => {
    const portraitJpegCaptureIds = new Set(
      db.select({ captureId: imageFilesTable.captureId })
        .from(imageFilesTable)
        .where(eq(imageFilesTable.fileRole, 'JPEG'))
        .all()
        .map((file) => file.captureId),
    )
    const portraitCaptures = db.select({
      captureId: capturesTable.id,
      studentId: capturesTable.studentId,
      rating: capturesTable.rating,
      rejected: capturesTable.rejected,
    })
      .from(capturesTable)
      .where(and(
        eq(capturesTable.projectId, projectId),
        isNull(capturesTable.groupId),
      ))
      .all()

    const groupJpegCaptureIds = new Set(
      db.select({ captureId: groupCaptureFilesTable.captureId })
        .from(groupCaptureFilesTable)
        .where(eq(groupCaptureFilesTable.fileRole, 'JPEG'))
        .all()
        .map((file) => file.captureId),
    )
    const groupCaptures = db.select({
      captureId: groupCapturesTable.id,
      groupId: groupCapturesTable.groupId,
      rating: groupCapturesTable.rating,
    })
      .from(groupCapturesTable)
      .where(eq(groupCapturesTable.projectId, projectId))
      .all()
    const groupMembers = db.select({
      groupId: groupMembersTable.groupId,
      studentId: groupMembersTable.studentId,
    })
      .from(groupMembersTable)
      .all()
    return buildCaptureReviewStatus({
      portraitCaptures,
      portraitJpegCaptureIds,
      groupCaptures,
      groupJpegCaptureIds,
      groupMembers,
    })
  })
  ipcMain.handle('groupCaptures:updateReview', async (_e, { captureId, rating }: { captureId: number; rating: number }) => {
    const capture = db.select().from(groupCapturesTable).where(eq(groupCapturesTable.id, captureId)).get()
    if (!capture) return null
    const nextRating = Math.max(0, Math.min(5, Math.round(rating)))
    const changedAt = now()
    const { clearedIds, updated } = db.transaction((tx) => {
      const previous = nextRating === 5
        ? tx.select({ id: groupCapturesTable.id })
          .from(groupCapturesTable)
          .where(and(
            eq(groupCapturesTable.projectId, capture.projectId),
            eq(groupCapturesTable.groupId, capture.groupId),
            eq(groupCapturesTable.rating, 5),
            // Keep the target in the same transaction even when it is already
            // the winner, so a repeated click remains an atomic no-op.
            ne(groupCapturesTable.id, captureId),
          ))
          .all()
        : []
        const clearedIds = groupFiveStarReplacementIds(
          previous.map((row) => ({ ...row, projectId: capture.projectId, groupId: capture.groupId, rating: 5 })),
          { ...capture, rating: nextRating },
        )
      if (previous.length > 0) {
        tx.update(groupCapturesTable).set({
          rating: 0,
          reviewSyncPending: true,
          updatedAt: changedAt,
        }).where(and(
          eq(groupCapturesTable.projectId, capture.projectId),
          eq(groupCapturesTable.groupId, capture.groupId),
          eq(groupCapturesTable.rating, 5),
          ne(groupCapturesTable.id, captureId),
        )).run()
      }
      tx.update(groupCapturesTable).set({
        rating: nextRating,
        reviewSyncPending: true,
        updatedAt: changedAt,
      }).where(eq(groupCapturesTable.id, captureId)).run()
      return {
        clearedIds,
        updated: tx.select().from(groupCapturesTable).where(eq(groupCapturesTable.id, captureId)).get() ?? null,
      }
    })
    for (const clearedId of clearedIds) void syncGroupCaptureReview(clearedId)
    if (updated) void syncGroupCaptureReview(updated.id)
    for (const groupId of new Set([capture.groupId])) {
      getMainWindow()?.webContents.send('groupCapture:updated', {
        projectId: capture.projectId,
        groupId,
      })
    }
    return updated
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
      const previewPath = await getCachedLivePreview(
        `gallery-photo-${row.id}`,
        getLivePreviewCacheDir(app.getPath('home')),
      )
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
        .orderBy(capturesTable.capturedAt, capturesTable.id)
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
          ? await getCachedLivePreview(
            `gallery-capture-${capture.id}`,
            getLivePreviewCacheDir(app.getPath('home')),
          )
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
          files: files.map((file) => rowToCaptureFile(
            file,
            file.fileRole === 'JPEG' ? previewUrl : undefined,
          )),
          thumbnailData: null,
          legacyPhoto: photo ? rowToPhoto(photo, null, previewUrl) : null,
          framing: captureFraming(capture),
        })
      }
      const markerRows = db
        .select()
        .from(qrMarkersTable)
        .where(eq(qrMarkersTable.studentId, studentId))
        .orderBy(qrMarkersTable.capturedAt)
        .all()
      const qrMarkers = await Promise.all(markerRows.map(async (marker) => {
        const previewPath = await getCachedLivePreview(
          `gallery-marker-${marker.id}`,
          getLivePreviewCacheDir(app.getPath('home')),
        )
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
      const files = db
        .select({ captureId: imageFilesTable.captureId, fileRole: imageFilesTable.fileRole })
        .from(imageFilesTable)
        .all()
      return getCaptureSummary(rows, files)
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
      const review = normalizeReviewFlags(capture, { favorite, rejected, selected, rating })
      const changedAt = now()
      const { clearedIds, updated } = db.transaction((tx) => {
        const previous = review.rating === 5 && capture.studentId !== null
          ? tx.select({ id: capturesTable.id })
            .from(capturesTable)
            .where(and(
              eq(capturesTable.projectId, capture.projectId),
              eq(capturesTable.studentId, capture.studentId),
              isNull(capturesTable.groupId),
              eq(capturesTable.rating, 5),
              ne(capturesTable.id, captureId),
            ))
            .all()
          : []
        const clearedIds = portraitFiveStarReplacementIds(
          previous.map((row) => ({
            ...row,
            projectId: capture.projectId,
            studentId: capture.studentId,
            groupId: null,
            rating: 5,
          })),
          { ...capture, rating: review.rating },
        )
        if (previous.length > 0) {
          tx.update(capturesTable).set({
            rating: 0,
            reviewSyncPending: true,
            updatedAt: changedAt,
          }).where(and(
            eq(capturesTable.projectId, capture.projectId),
            eq(capturesTable.studentId, capture.studentId),
            isNull(capturesTable.groupId),
            eq(capturesTable.rating, 5),
            ne(capturesTable.id, captureId),
          )).run()
        }
        tx.update(capturesTable)
          .set({
            favorite: review.favorite,
            rejected: review.rejected,
            selected: review.selected,
            rating: review.rating,
            ...(colorLabel === undefined ? {} : { colorLabel }),
            reviewSyncPending: true,
            updatedAt: changedAt,
          })
          .where(eq(capturesTable.id, captureId))
          .run()
        return {
          clearedIds,
          updated: tx.select().from(capturesTable).where(eq(capturesTable.id, captureId)).get() ?? null,
        }
      })
      for (const clearedId of clearedIds) void syncCaptureReview(clearedId)
      if (updated) void syncCaptureReview(updated.id)
      if (updated) {
        // One event per affected capture keeps other open project views from
        // retaining the old winner after a replacement.
        for (const affectedId of [...clearedIds, updated.id]) {
          getMainWindow()?.webContents.send('capture:updated', {
            projectId: updated.projectId,
            captureId: affectedId,
            studentId: updated.studentId,
          })
        }
      }
      return updated
    },
  )

  ipcMain.handle(
    'captures:updateFraming',
    (
      _e,
      {
        captureId,
        framing,
      }: {
        captureId: number
        framing: Omit<CaptureFraming, 'pending'>
      },
    ) => {
      const capture = db.select().from(capturesTable).where(eq(capturesTable.id, captureId)).get()
      if (!capture) return null
      const aspectRatio = captureAspectRatios.includes(framing.aspectRatio) ? framing.aspectRatio : 'original'
      const rotation = captureRotations.includes(framing.rotation) ? framing.rotation : 0
      db.update(capturesTable)
        .set({
          cropX: Math.max(-100, Math.min(100, Math.round(framing.cropX))),
          cropY: Math.max(-100, Math.min(100, Math.round(framing.cropY))),
          cropScale: Math.max(100, Math.min(300, Math.round(framing.cropScale))),
          aspectRatio,
          straightenAngle: Math.max(-15, Math.min(15, framing.straightenAngle)),
          rotation,
          reframePending: true,
          reviewSyncPending: true,
          updatedAt: now(),
        })
        .where(eq(capturesTable.id, captureId))
        .run()
      const updated = db.select().from(capturesTable).where(eq(capturesTable.id, captureId)).get() ?? null
      if (updated) {
        void syncCaptureReview(updated.id)
      }
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
    'photos:getPreview',
    async (
      _e,
      { filePath, previewKey }: { filePath: string; previewKey: string },
    ): Promise<string | null> => {
      if (
        typeof filePath !== 'string'
        || !filePath.trim()
        || typeof previewKey !== 'string'
        || !previewKey.trim()
      ) {
        return null
      }
      const previewPath = await generateLivePreview(filePath, {
        previewKey,
        cacheDir: getLivePreviewCacheDir(app.getPath('home')),
      })
      return previewPath
        ? createLocalPreviewUrl(previewPath, previewKey)
        : null
    },
  )

  ipcMain.handle(
    'photos:reassign',
    async (_e, { photoId, studentId }: { photoId: number; studentId: number }) => {
      const db = getDb()
      const photo = db.select().from(photosTable).where(eq(photosTable.id, photoId)).get()
      if (!photo) throw new Error('Photo not found.')
      const project = db.select().from(projectsTable).where(eq(projectsTable.id, photo.projectId)).get()
      if (project?.finishedAt) throw new Error('This project is finished and its captures can no longer be changed.')
      if (photo.uploadStatus === 'done' || photo.uploadStatus === 'uploading' || photo.fileUrl) {
        throw new Error('This photo is already uploaded. Reassign it before uploading to the cloud.')
      }
      const student = db.select().from(studentsTable).where(and(
        eq(studentsTable.id, studentId),
        eq(studentsTable.projectId, photo.projectId),
      )).get()
      if (!student) throw new Error('Choose a student from this project.')
      const capture = db
        .select()
        .from(capturesTable)
        .where(eq(capturesTable.legacyPhotoId, photoId))
        .get()
      const imageFiles = capture
        ? db.select().from(imageFilesTable).where(eq(imageFilesTable.captureId, capture.id)).all()
        : []
      if (imageFiles.some((file) => file.uploadStatus === 'done' || file.uploadStatus === 'uploading' || file.fileUrl)) {
        throw new Error('This capture is already uploaded. Reassign it before uploading to the cloud.')
      }
      const destDir = join(getPhotosDir(), String(photo.projectId), student.generatedStudentId)
      mkdirSync(destDir, { recursive: true })
      const moves = (imageFiles.length > 0 ? imageFiles.map((file) => ({
        source: file.storedPath,
        target: join(destDir, basename(file.storedPath)),
      })) : [{ source: photo.filePath, target: join(destDir, photo.fileName) }])
      if (!moves.some((move) => move.source === photo.filePath)) {
        moves.push({ source: photo.filePath, target: join(destDir, photo.fileName) })
      }
      if (moves.some(({ target, source }) => target !== source && existsSync(target))) {
        throw new Error('A file with that name already exists in the destination student folder.')
      }
      if (moves.some(({ source }) => !existsSync(source))) {
        throw new Error('A paired photo file is missing. Nothing was reassigned.')
      }
      const copied: string[] = []
      try {
        for (const { source, target } of moves) {
          if (source === target) continue
          copyFileSync(source, target)
          copied.push(target)
        }
        const photoPath = moves.find((move) => move.source === photo.filePath)?.target ?? join(destDir, photo.fileName)
        db.transaction((tx) => {
          tx.update(photosTable)
            .set({ studentId, filePath: photoPath, isMatched: true })
            .where(eq(photosTable.id, photoId)).run()
          if (capture) {
            for (const file of imageFiles) {
              const move = moves.find((candidate) => candidate.source === file.storedPath)
              if (move) tx.update(imageFilesTable)
                .set({ storedPath: move.target })
                .where(eq(imageFilesTable.id, file.id)).run()
            }
            tx.update(capturesTable)
              .set({ studentId, classId: student.classId, assignmentLocked: true, updatedAt: now() })
              .where(eq(capturesTable.id, capture.id)).run()
          }
        })
      } catch (error) {
        for (const filePath of copied) {
          try { if (existsSync(filePath)) unlinkSync(filePath) } catch {}
        }
        throw error
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

  ipcMain.handle('photos:moveToGroup', async (_e, { photoId, groupId }: { photoId: number; groupId: number }) => {
    const db = getDb()
    const photo = db.select().from(photosTable).where(eq(photosTable.id, photoId)).get()
    if (!photo) throw new Error('Photo not found.')
    if (photo.uploadStatus === 'done' || photo.uploadStatus === 'uploading' || photo.fileUrl) {
      throw new Error('Only photos that have not been uploaded can be moved into a group.')
    }
    const group = db.select().from(groupsTable).where(eq(groupsTable.id, groupId)).get()
    if (!group || group.projectId !== photo.projectId) throw new Error('Choose a group from this project.')
    const project = db.select().from(projectsTable).where(eq(projectsTable.id, photo.projectId)).get()
    if (project?.finishedAt) throw new Error('This project is finished and its captures can no longer be changed.')
    const capture = db.select().from(capturesTable).where(eq(capturesTable.legacyPhotoId, photo.id)).get()
    const imageFiles = capture
      ? db.select().from(imageFilesTable).where(eq(imageFilesTable.captureId, capture.id)).all()
      : []
    if (imageFiles.some((file) => file.uploadStatus === 'done' || file.uploadStatus === 'uploading' || file.fileUrl)) {
      throw new Error('Only captures that have not been uploaded can be moved into a group.')
    }
    const files = imageFiles.length > 0 ? imageFiles : [{
      fileRole: 'JPEG' as const,
      fileFormat: extname(photo.fileName).replace(/^\./, '').toLowerCase() || 'jpg',
      originalFilename: photo.fileName,
      storedPath: photo.filePath,
      sourcePath: null,
      fileSize: null,
    }]
    if (files.some((file) => !existsSync(file.storedPath))) {
      throw new Error('A capture file is missing. Nothing was moved.')
    }
    const groupCapture = db.insert(groupCapturesTable).values({
      captureKey: randomUUID(),
      projectId: photo.projectId,
      classId: group.classId ?? (photo.studentId
        ? db.select({ classId: studentsTable.classId }).from(studentsTable).where(eq(studentsTable.id, photo.studentId)).get()?.classId ?? null
        : null),
      groupId,
      baseFilename: capture?.baseFilename ?? basename(photo.fileName, extname(photo.fileName)),
      capturedAt: capture?.capturedAt ?? photo.capturedAt,
      pairingStatus: capture?.pairingStatus ?? 'jpeg_only',
      rating: capture?.rating ?? 0,
      reviewSyncPending: false,
      updatedAt: now(),
    }).returning().get()
    if (!groupCapture) throw new Error('The group photo could not be created.')
    try {
      db.transaction((tx) => {
        tx.insert(groupCaptureFilesTable).values(files.map((file) => ({
          captureId: groupCapture.id,
          fileRole: file.fileRole,
          fileFormat: file.fileFormat,
          originalFilename: file.originalFilename,
          storedPath: file.storedPath,
          sourcePath: file.sourcePath,
          fileSize: file.fileSize,
          uploadStatus: null,
          fileUrl: null,
          galleryReady: false,
        }))).run()
        if (photo.studentId && !tx.select({ id: groupMembersTable.id }).from(groupMembersTable)
          .where(and(eq(groupMembersTable.groupId, groupId), eq(groupMembersTable.studentId, photo.studentId))).get()) {
          tx.insert(groupMembersTable).values({ groupId, studentId: photo.studentId }).run()
        }
        if (capture) tx.delete(capturesTable).where(eq(capturesTable.id, capture.id)).run()
        tx.delete(photosTable).where(eq(photosTable.id, photo.id)).run()
      })
    } catch (error) {
      db.delete(groupCapturesTable).where(eq(groupCapturesTable.id, groupCapture.id)).run()
      throw error
    }
    const win = getMainWindow()
    win?.webContents.send('capture:updated', { projectId: photo.projectId, captureId: groupCapture.id, studentId: null, groupId })
  })

  ipcMain.handle('photos:rename', async (_e, { photoId, name }: { photoId: number; name: string }) => {
    const db = getDb()
    const photo = db.select().from(photosTable).where(eq(photosTable.id, photoId)).get()
    if (!photo) throw new Error('Photo not found.')
    if (photo.uploadStatus === 'done' || photo.uploadStatus === 'uploading' || photo.fileUrl) {
      throw new Error('Uploaded photos cannot be renamed in the desktop app.')
    }
    const inputName = name.trim()
    if (!inputName || inputName.length > 100 || basename(inputName) !== inputName || /[\u0000-\u001f]/.test(inputName)) {
      throw new Error('Enter a file name under 100 characters without a folder path.')
    }
    const capture = db.select().from(capturesTable).where(eq(capturesTable.legacyPhotoId, photo.id)).get()
    const imageFiles = capture
      ? db.select().from(imageFilesTable).where(eq(imageFilesTable.captureId, capture.id)).all()
      : []
    if (imageFiles.some((file) => file.uploadStatus === 'done' || file.uploadStatus === 'uploading' || file.fileUrl)) {
      throw new Error('Uploaded captures cannot be renamed in the desktop app.')
    }
    const suppliedExtension = extname(inputName)
    const newStem = suppliedExtension ? basename(inputName, suppliedExtension) : inputName
    const entries = imageFiles.length > 0
      ? imageFiles.map((file) => ({
        id: file.id,
        source: file.storedPath,
        target: join(dirname(file.storedPath), `${newStem}${extname(file.storedPath)}`),
      }))
      : [{ id: null, source: photo.filePath, target: join(dirname(photo.filePath), `${newStem}${extname(photo.filePath)}`) }]
    if (entries.some(({ source, target }) => !existsSync(source))) throw new Error('A capture file is missing. Nothing was renamed.')
    if (entries.some(({ source, target }) => source !== target && existsSync(target))) {
      throw new Error('A file with that name already exists.')
    }
    const renamed: Array<{ source: string; target: string }> = []
    try {
      for (const entry of entries) {
        if (entry.source === entry.target) continue
        renameSync(entry.source, entry.target)
        renamed.push(entry)
      }
      const jpegEntry = entries.find((entry) => entry.source === photo.filePath)
        ?? entries.find((entry) => extname(entry.target).toLowerCase() === '.jpg' || extname(entry.target).toLowerCase() === '.jpeg')
      const nextPhotoPath = jpegEntry?.target ?? entries[0].target
      db.transaction((tx) => {
        tx.update(photosTable).set({
          filePath: nextPhotoPath,
          fileName: basename(nextPhotoPath),
        }).where(eq(photosTable.id, photo.id)).run()
        for (const entry of entries) {
          if (entry.id !== null) tx.update(imageFilesTable).set({
            storedPath: entry.target,
            originalFilename: basename(entry.target),
          }).where(eq(imageFilesTable.id, entry.id)).run()
        }
        if (capture) tx.update(capturesTable).set({ baseFilename: newStem, updatedAt: now() })
          .where(eq(capturesTable.id, capture.id)).run()
      })
    } catch (error) {
      for (const entry of renamed.reverse()) {
        try { if (existsSync(entry.target)) renameSync(entry.target, entry.source) } catch {}
      }
      throw error
    }
    return { fileName: basename(nextPhotoPath) }
  })

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
