import { app, ipcMain, BrowserWindow } from 'electron'
import chokidar, { FSWatcher } from 'chokidar'
import { existsSync, mkdirSync } from 'fs'
import { copyFile, mkdir, stat as statFile } from 'fs/promises'
import { basename, dirname, extname, join, parse, resolve } from 'path'
import { and, eq } from 'drizzle-orm'
import { getDb, getPhotosDir } from '../db'
import {
  capturesTable,
  classesTable,
  photosTable,
  projectsTable,
  qrMarkersTable,
  studentsTable,
  groupsTable,
} from '../db/schema'
import { getSetting, notifyLiveUploadJobQueued } from './upload'
import {
  extractStudentReference,
  formatGroupPhotoName,
  formatStudentFolderName,
  formatStudentPhotoName,
} from '../lib/photoFileNaming'
import { copyManagedCaptureFile } from '../lib/managedCaptureCopy'
import { readQrFromImage } from '../lib/qrReader'
import { createLocalPreviewUrl } from '../lib/localPreviewProtocol'
import { generateLivePreview, getLivePreviewCacheDir } from '../lib/livePreview'
import { waitForStableFile } from '../lib/fileStability'
import {
  finishImagePipelineTrace,
  getImagePipelinePreviewContext,
  markImagePipeline,
  markImagePipelinePreviewSuperseded,
  markImagePipelineRendererStage,
  retainImagePipelineTraceForPaint,
  startImagePipelineTrace,
} from '../lib/imagePipelineDiagnostics'
import {
  advanceSequence,
  clearManualStudent,
  createSequenceState,
  registerCapturePath,
  setManualStudent,
  sortCaptureFiles,
  type CaptureFile,
  type SequenceState,
} from '../lib/photoSequence'
import type {
  ActiveCaptureTargetEvent,
  DroppedCaptureBatchResult,
  DroppedCaptureFileResult,
  ImagePipelineRendererStage,
  Photo,
  Student,
} from '../../shared/types'
import {
  createWatchedPhotoStore,
  processWatchedPhoto,
  type WatchedPhotoResult,
} from '../lib/watchedPhotoProcessor'
import {
  hasProcessedCaptureSource,
  hasProcessedQrMarkerSource,
  mirrorPhotoAsCapture,
  recordQrMarker,
  recordRawCapture,
  recordGroupCapture,
} from '../lib/captureRepository'
import { getCaptureFileRole } from '../lib/capturePairing'
import {
  ensureProjectStorageLayout,
  getPhotoSystemLayout,
  getProjectStorageLayout,
} from '../lib/storageLayout'
import { NewestLivePreviewScheduler } from '../lib/livePreviewScheduler'
import { resolveWatchFolders } from '../lib/watchFolders'

const FLUSH_DELAY_MS = 50
interface WatchSession {
  watcher: FSWatcher | null
  pendingFiles: CaptureFile[]
  pendingEnqueues: Set<Promise<unknown>>
  flushTimer: NodeJS.Timeout | null
  processing: Promise<void>
  persistence: Promise<void>
  pendingPersistences: Set<Promise<void>>
  previewScheduler: NewestLivePreviewScheduler
  seenPaths: Set<string>
  sequenceState: SequenceState
  awaitDurability: boolean
}

type CaptureProcessingStatus = 'imported' | 'duplicate' | 'unmatched'

interface EnqueueCaptureOptions {
  session?: WatchSession
  selectedStudentId?: number | null
  selectedGroupId?: number | null
  processImmediately?: boolean
}

// Active watchers: projectId → watcher session
const watchers = new Map<number, WatchSession>()
const pendingManualTargets = new Map<number, number>()
const pendingGroupTargets = new Map<number, number>()
const activeDropBatches = new Set<Promise<DroppedCaptureBatchResult>>()
let dropBatchTail: Promise<void> = Promise.resolve()
let desktopRetiring = false

function createWatchSession(
  watcher: FSWatcher | null,
  sequenceState: SequenceState = createSequenceState(),
  awaitDurability = false,
): WatchSession {
  return {
    watcher,
    pendingFiles: [],
    pendingEnqueues: new Set(),
    flushTimer: null,
    processing: Promise.resolve(),
    persistence: Promise.resolve(),
    pendingPersistences: new Set(),
    previewScheduler: new NewestLivePreviewScheduler(),
    seenPaths: new Set(),
    sequenceState,
    awaitDurability,
  }
}

export async function stopAllWatchersForRetirement(): Promise<void> {
  desktopRetiring = true
  // Drop ingestion uses isolated sessions rather than entries in `watchers`.
  // Retirement must wait for those sessions too, otherwise the database and
  // managed originals could be removed while a drop is still copying them.
  await drainDroppedCaptureBatches()
  const sessions = [...watchers.values()]
  watchers.clear()
  for (const session of sessions) {
    if (session.flushTimer) clearTimeout(session.flushTimer)
    session.flushTimer = null
    session.pendingFiles = []
    await Promise.allSettled([...session.pendingEnqueues])
  }
  await Promise.allSettled(
    sessions
      .map((session) => session.watcher)
      .filter((watcher): watcher is FSWatcher => watcher !== null)
      .map((watcher) => watcher.close()),
  )
  await Promise.allSettled(sessions.map((session) => session.processing))
  await Promise.allSettled(sessions.map((session) => session.persistence))
  await Promise.allSettled(sessions.flatMap((session) => [...session.pendingPersistences]))
  await Promise.allSettled(sessions.map((session) => session.previewScheduler.waitForIdle()))
}

export async function stopAllWatchersForShutdown(): Promise<void> {
  const projectIds = [...watchers.keys()]
  const results = await Promise.allSettled(projectIds.map((projectId) =>
    stopProjectWatcher(projectId, { drain: true, clearTarget: true })))
  const failures = results
    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    .map((result) => result.reason)
  if (failures.length > 0) {
    throw new AggregateError(failures, 'One or more Watch Folder sessions failed to drain')
  }
  await drainDroppedCaptureBatches()
}

export function enableWatchersAfterSignIn(): void {
  desktopRetiring = false
}

function queueDroppedCaptureBatch(
  projectId: number,
  studentId: number,
  filePaths: string[],
): Promise<DroppedCaptureBatchResult> {
  // Serializing batches makes source-path dedupe and JPEG/RAW pairing
  // deterministic when a photographer drops files again before the first
  // batch has finished persisting.
  const batch = dropBatchTail.then(() => ingestDroppedFiles(projectId, studentId, filePaths))
  dropBatchTail = batch.then(
    () => undefined,
    () => undefined,
  )
  activeDropBatches.add(batch)
  void batch.finally(() => activeDropBatches.delete(batch)).catch(() => {})
  return batch
}

async function drainDroppedCaptureBatches(): Promise<void> {
  while (activeDropBatches.size > 0) {
    await Promise.allSettled([...activeDropBatches])
  }
}

function getMainWindow(): BrowserWindow | null {
  const wins = BrowserWindow.getAllWindows()
  return wins.length > 0 ? wins[0] : null
}

function safeFolderName(value: string): string {
  return value.trim().replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/\s+/g, ' ').slice(0, 120) || 'Unknown'
}

function looksLikeSmartShooterName(fileName: string): boolean {
  const stem = basename(fileName, extname(fileName))
  return /^[^_]+_[^_]+_[^_]+_[^_]+(?:[-_].*)?$/.test(stem)
}

function captureTimestamp(stat: Awaited<ReturnType<typeof statFile>>): number {
  if (Number.isFinite(stat.birthtimeMs) && stat.birthtimeMs > 0) return stat.birthtimeMs
  if (Number.isFinite(stat.mtimeMs) && stat.mtimeMs > 0) return stat.mtimeMs
  return Date.now()
}

function toStudentEvent(
  db: ReturnType<typeof getDb>,
  student: typeof studentsTable.$inferSelect,
): Student {
  const classRow = db.select().from(classesTable).where(eq(classesTable.id, student.classId)).get()
  return {
    id: student.id,
    projectId: student.projectId,
    classId: student.classId,
    className: classRow?.className ?? '',
    firstName: student.firstName,
    lastName: student.lastName,
    generatedStudentId: student.generatedStudentId,
    simpleQr: student.simpleQr,
    jsonQr: student.jsonQr,
    photoCount: 0,
    createdAt: student.createdAt,
    updatedAt: student.updatedAt,
  }
}

function emitActiveStudentChanged(
  projectId: number,
  studentId: number | null,
  source: ActiveCaptureTargetEvent['source'],
): void {
  getMainWindow()?.webContents.send('watcher:activeStudentChanged', {
    projectId,
    studentId,
    source,
  } satisfies ActiveCaptureTargetEvent)
}

function findProjectStudent(
  db: ReturnType<typeof getDb>,
  projectId: number,
  studentId: number,
): typeof studentsTable.$inferSelect | undefined {
  return db
    .select()
    .from(studentsTable)
    .where(and(eq(studentsTable.projectId, projectId), eq(studentsTable.id, studentId)))
    .get()
}

function findStudentByFilename(
  db: ReturnType<typeof getDb>,
  projectId: number,
  fileName: string,
): typeof studentsTable.$inferSelect | undefined {
  const students = db.select().from(studentsTable).where(eq(studentsTable.projectId, projectId)).all()
  const reference = extractStudentReference(fileName, students.map((student) => student.generatedStudentId))
  if (!reference) return undefined
  const normalizedReference = reference.trim().toLocaleLowerCase()
  return students.find((student) =>
    student.generatedStudentId.trim().toLocaleLowerCase() === normalizedReference)
}

function getStudentPhotoFolder(
  db: ReturnType<typeof getDb>,
  projectId: number,
  student: typeof studentsTable.$inferSelect,
): string {
  const project = db.select().from(projectsTable).where(eq(projectsTable.id, projectId)).get()
  const classRow = db.select().from(classesTable).where(eq(classesTable.id, student.classId)).get()
  return join(
    getPhotosDir(),
    safeFolderName(project?.schoolName ?? `Project ${projectId}`),
    safeFolderName(classRow?.className ?? 'Unassigned Class'),
    safeFolderName(formatStudentFolderName(
      student.firstName,
      student.lastName,
      student.generatedStudentId,
    )),
  )
}

function getProjectStorage(
  projectId: number,
  project: typeof projectsTable.$inferSelect,
) {
  // getPhotosDir() is the configured PHOTOS directory. Keep Jobs beside it
  // so custom storage roots do not silently send project originals elsewhere.
  return ensureProjectStorageLayout(
    getProjectStorageLayout(
      getPhotoSystemLayout(dirname(getPhotosDir())),
      projectId,
      project.schoolName,
    ),
  )
}

function sendUnmatchedResult(
  win: BrowserWindow | null,
  projectId: number,
  result: { filePath: string; fileName: string; reason: string; photoId?: number },
): void {
  win?.webContents.send('photo:unmatched', {
    ...result,
    projectId,
  })
}

let nextPreviewId = -1

async function emitLocalPreview(
  win: BrowserWindow | null,
  projectId: number,
  capture: CaptureFile,
  student: typeof studentsTable.$inferSelect,
  context: { filePath: string; fileName: string; capturedAt: string },
  previewPath: string,
): Promise<string | null> {
  const diagnosticId = capture.diagnosticId
  if (!diagnosticId) return null
  const previewUrl = createLocalPreviewUrl(previewPath, diagnosticId)
  markImagePipeline(
    diagnosticId,
    'preview prepared',
    `source=${previewUrl} artifact=${previewPath}`,
  )

  const preview: Photo = {
    id: nextPreviewId--,
    projectId,
    studentId: student.id,
    filePath: context.filePath,
    fileName: context.fileName,
    capturedAt: context.capturedAt,
    isMatched: true,
    thumbnailData: null,
    createdAt: context.capturedAt,
    previewKey: diagnosticId,
    previewUrl,
  }
  retainImagePipelineTraceForPaint(diagnosticId)
  win?.webContents.send('photo:matched', {
    photo: preview,
    student: toStudentEvent(getDb(), student),
    preview: true,
    previewKey: diagnosticId,
    pipeline: getImagePipelinePreviewContext(diagnosticId),
  })
  markImagePipeline(
    diagnosticId,
    'IPC event sent',
    `preview source=${previewUrl}`,
  )
  return previewUrl
}

async function prepareAndEmitLocalPreview(
  win: BrowserWindow | null,
  projectId: number,
  capture: CaptureFile,
  student: typeof studentsTable.$inferSelect,
  context: { filePath: string; fileName: string; capturedAt: string },
): Promise<string | null> {
  const previewKey = capture.diagnosticId ?? `${projectId}:${capture.filePath}`
  markImagePipeline(
    capture.diagnosticId,
    'preview preparation started',
    'strategy=libvips-reduced-artifact',
  )
  const previewPath = await generateLivePreview(context.filePath, {
    previewKey,
    cacheDir: getLivePreviewCacheDir(app.getPath('home')),
  })
  if (!previewPath) return null
  return emitLocalPreview(win, projectId, capture, student, context, previewPath)
}

function enqueueLocalPreview(
  scheduler: NewestLivePreviewScheduler,
  win: BrowserWindow | null,
  projectId: number,
  capture: CaptureFile,
  student: typeof studentsTable.$inferSelect,
  context: { filePath: string; fileName: string; capturedAt: string },
): null {
  // The trace must outlive the capture-processing loop because generation now
  // runs independently of persistence and may start after the loop advances.
  retainImagePipelineTraceForPaint(capture.diagnosticId)
  scheduler.enqueue({
    traceId: capture.diagnosticId,
    run: async () => {
      const previewUrl = await prepareAndEmitLocalPreview(
        win,
        projectId,
        capture,
        student,
        context,
      )
      if (!previewUrl) finishImagePipelineTrace(capture.diagnosticId)
    },
    supersede: () => markImagePipelinePreviewSuperseded(
      capture.diagnosticId,
      'superseded before live-preview generation',
    ),
  })
  return null
}

type PendingMatchedPhoto = Extract<WatchedPhotoResult, { kind: 'matched-pending' }>

function enqueueMatchedPhotoPersistence(
  session: WatchSession,
  db: ReturnType<typeof getDb>,
  win: BrowserWindow | null,
  projectId: number,
  capture: CaptureFile,
  result: PendingMatchedPhoto,
): Promise<void> {
  const task = session.persistence.then(async () => {
    await session.previewScheduler.waitForIdle()
    const photo = await result.persist()
    await finishMatchedPhoto(
      db,
      win,
      photo,
      result.student,
      capture.diagnosticId,
      result.thumbnailData,
      { skipPreviewGeneration: true },
    )
    notifyLiveUploadJobQueued(projectId)
  })
  const handledTask = task.catch((error) => {
    // The source remains untouched and can be retried after a removable or
    // network-backed destination becomes available again.
    session.seenPaths.delete(capture.filePath)
    console.error(`[Watcher] Could not persist ${capture.filePath}; it will be retried`, error)
  })
  session.persistence = handledTask
  session.pendingPersistences.add(handledTask)
  void handledTask.finally(() => session.pendingPersistences.delete(handledTask)).catch(() => {})
  return task
}

export function registerWatcherHandlers() {
  const db = getDb()

  ipcMain.handle('imagePipeline:rendererStage', (_event, payload: unknown) => {
    if (!payload || typeof payload !== 'object') return { ok: false }
    const stage = payload as ImagePipelineRendererStage
    if (!stage.traceId || !stage.stage || !Number.isFinite(stage.atEpochMs)) {
      return { ok: false }
    }
    markImagePipelineRendererStage(stage)
    return { ok: true }
  })

  ipcMain.handle('watcher:start', async (_e, { projectId }: { projectId: number }) => {
    if (desktopRetiring || getSetting('desktop_retired') === '1') {
      throw new Error('Cloud sync is disabled because this desktop was retired')
    }
    if (watchers.has(projectId)) return

    const [project] = db
      .select()
      .from(projectsTable)
      .where(eq(projectsTable.id, projectId))
      .all()

    if (!project?.watchFolder) {
      throw new Error('No watch folder configured for this project')
    }
    if (project.finishedAt) {
      throw new Error('This project is finished. Reopen it as a new local project before capturing more photos.')
    }

    const watchFolders = resolveWatchFolders(project.watchFolder, existsSync)
    if (watchFolders.mode === 'dual') {
      for (const folder of watchFolders.paths) mkdirSync(folder, { recursive: true })
    }
    const watcher = chokidar.watch(watchFolders.paths, {
      persistent: true,
      // Process files that were already written before the photographer
      // opened the project. The database/source-path checks below make this
      // safe across restarts and prevent duplicate imports.
      ignoreInitial: false,
    })

    const session = createWatchSession(
      watcher,
      createSequenceState(pendingManualTargets.get(projectId) ?? null),
    )
    watchers.set(projectId, session)

    watcher.on('add', (filePath) => {
      const diagnosticId = startImagePipelineTrace(filePath)
      const enqueueTask = enqueueCapture(projectId, filePath, diagnosticId)
      session.pendingEnqueues.add(enqueueTask)
      void enqueueTask
        .catch((error) => {
          console.error(`[Watcher] Could not enqueue ${filePath}`, error)
        })
        .finally(() => session.pendingEnqueues.delete(enqueueTask))
    })
    watcher.on('error', (error) => {
      console.error(`[Watcher] Error for project ${projectId}`, error)
    })

    await new Promise<void>((resolveReady, rejectReady) => {
      const handleReady = () => {
        watcher.off('error', handleStartupError)
        resolveReady()
      }
      const handleStartupError = (error: Error) => {
        watcher.off('ready', handleReady)
        watchers.delete(projectId)
        void watcher.close()
        rejectReady(error)
      }

      watcher.once('ready', handleReady)
      watcher.once('error', handleStartupError)
    })

    console.log(
      `[Watcher] Started ${watchFolders.mode} watching for project ${projectId}: ${watchFolders.paths.join(', ')}`,
    )
  })

  ipcMain.handle('watcher:stop', async (_e, { projectId }: { projectId: number }) => {
    await stopProjectWatcher(projectId, { drain: true, clearTarget: true })
    console.log(`[Watcher] Stopped watching for project ${projectId}`)
  })

  ipcMain.handle('watcher:isRunning', (_e, { projectId }: { projectId: number }): boolean => {
    return watchers.has(projectId)
  })

  ipcMain.handle(
    'watcher:getActiveStudent',
    (_e, { projectId }: { projectId: number }): number | null => {
      const session = watchers.get(projectId)
      return session?.sequenceState.activeStudentId ?? pendingManualTargets.get(projectId) ?? null
    },
  )

  ipcMain.handle(
    'watcher:setActiveStudent',
    (_e, { projectId, studentId }: { projectId: number; studentId: number | null }): number | null => {
      if (studentId !== null) {
        const student = findProjectStudent(db, projectId, studentId)
        if (!student) throw new Error('Student does not belong to this project')
        pendingManualTargets.set(projectId, studentId)
        pendingGroupTargets.delete(projectId)
        const session = watchers.get(projectId)
        if (session) setManualStudent(session.sequenceState, studentId)
      } else {
        pendingManualTargets.delete(projectId)
        pendingGroupTargets.delete(projectId)
        const session = watchers.get(projectId)
        if (session) clearManualStudent(session.sequenceState)
      }

      emitActiveStudentChanged(projectId, studentId, studentId === null ? 'none' : 'manual')
      return studentId
    },
  )

  ipcMain.handle(
    'watcher:getActiveTarget',
    (_e, { projectId }: { projectId: number }) => ({
      studentId: pendingGroupTargets.has(projectId)
        ? null
        : watchers.get(projectId)?.sequenceState.activeStudentId ?? pendingManualTargets.get(projectId) ?? null,
      groupId: pendingGroupTargets.get(projectId) ?? null,
      targetType: pendingGroupTargets.has(projectId)
        ? 'group'
        : (pendingManualTargets.has(projectId) ? 'student' : 'none'),
    }),
  )

  ipcMain.handle(
    'watcher:setActiveGroup',
    (_e, { projectId, groupId }: { projectId: number; groupId: number | null }): number | null => {
      if (groupId !== null) {
        const group = db.select().from(groupsTable).where(and(
          eq(groupsTable.id, groupId), eq(groupsTable.projectId, projectId),
        )).get()
        if (!group) throw new Error('Group does not belong to this project')
        pendingGroupTargets.set(projectId, groupId)
        pendingManualTargets.delete(projectId)
        const session = watchers.get(projectId)
        if (session) clearManualStudent(session.sequenceState)
      } else {
        pendingGroupTargets.delete(projectId)
      }
      getMainWindow()?.webContents.send('watcher:activeStudentChanged', {
        projectId, studentId: null, groupId, targetType: groupId === null ? 'none' : 'group', source: groupId === null ? 'none' : 'manual',
      })
      return groupId
    },
  )

  ipcMain.handle(
    'watcher:ingestDroppedFiles',
    async (
      _e,
      input: { projectId: number; studentId: number; filePaths: string[] },
    ): Promise<DroppedCaptureBatchResult> => {
      if (!Number.isInteger(input?.projectId) || !Number.isInteger(input?.studentId)) {
        throw new Error('A valid project and student are required for dropped photos')
      }
      return queueDroppedCaptureBatch(input.projectId, input.studentId, input.filePaths)
    },
  )
}

export async function stopProjectWatcher(
  projectId: number,
  options: { drain?: boolean; clearTarget?: boolean } = {},
): Promise<void> {
  const { drain = true, clearTarget = true } = options
  const session = watchers.get(projectId)
  if (!session) {
    if (clearTarget) {
      pendingManualTargets.delete(projectId)
      pendingGroupTargets.delete(projectId)
      emitActiveStudentChanged(projectId, null, 'none')
    }
    return
  }

  // Remove the session before closing chokidar so late filesystem callbacks
  // cannot enqueue new work after the finish operation has begun.
  watchers.delete(projectId)
  if (session.flushTimer) clearTimeout(session.flushTimer)
  session.flushTimer = null
  if (session.watcher) await session.watcher.close()
  await Promise.allSettled([...session.pendingEnqueues])
  const pending = sortCaptureFiles(session.pendingFiles.splice(0))

  if (drain && pending.length > 0) {
    session.processing = session.processing.then(async () => {
      for (const capture of pending) {
        try {
          await handleNewPhoto(projectId, capture, session)
        } catch (error) {
          console.error(`[Watcher] Could not drain ${capture.filePath} while stopping`, error)
        } finally {
          finishImagePipelineTrace(capture.diagnosticId)
        }
      }
    })
  }
  await session.processing
  await session.persistence
  await Promise.allSettled([...session.pendingPersistences])
  await session.previewScheduler.waitForIdle()

  if (clearTarget) {
    pendingManualTargets.delete(projectId)
    emitActiveStudentChanged(projectId, null, 'none')
  }
}

async function enqueueCapture(
  projectId: number,
  filePath: string,
  diagnosticId?: string,
  options: EnqueueCaptureOptions = {},
): Promise<CaptureProcessingStatus | 'unsupported'> {
  if (desktopRetiring) {
    finishImagePipelineTrace(diagnosticId)
    throw new Error('Cloud sync is disabled because this desktop was retired')
  }
  const session = options.session ?? watchers.get(projectId)
  if (!session || session.seenPaths.has(filePath)) {
    finishImagePipelineTrace(diagnosticId)
    return 'duplicate'
  }

  if (!getCaptureFileRole(filePath)) {
    finishImagePipelineTrace(diagnosticId)
    return 'unsupported'
  }

  try {
    const fileStat = await waitForStableFile(filePath, statFile)
    markImagePipeline(diagnosticId, 'file became stable', `bytes=${fileStat.size}`)
    if (desktopRetiring || (options.session === undefined && watchers.get(projectId) !== session)) {
      finishImagePipelineTrace(diagnosticId)
      throw new Error('Capture session stopped before the file became available')
    }
    if (!registerCapturePath(session.seenPaths, filePath)) return 'duplicate'
    const db = getDb()
    if (
      hasProcessedCaptureSource(db, filePath)
      || hasProcessedQrMarkerSource(db, filePath)
    ) {
      return 'duplicate'
    }
    session.pendingFiles.push({
      filePath,
      fileName: basename(filePath),
      capturedAtMs: captureTimestamp(fileStat),
      diagnosticId,
      // Capture the effective target at arrival time. Processing can be
      // delayed by image copies or a burst of filesystem events, and a
      // photographer may select another student or scan another QR during
      // that delay.
      selectedStudentId: options.selectedStudentId !== undefined
        ? options.selectedStudentId
        : session.sequenceState.manualStudentId ?? session.sequenceState.activeStudentId,
      selectedGroupId: options.selectedGroupId !== undefined
        ? options.selectedGroupId
        : pendingGroupTargets.get(projectId) ?? null,
    })
    if (options.processImmediately) {
      const [capture] = session.pendingFiles.splice(0)
      if (!capture) throw new Error('Capture could not be queued')
      const processing = session.processing.then(() => handleNewPhoto(projectId, capture, session))
      session.processing = processing.catch((error) => {
        session.seenPaths.delete(capture.filePath)
        console.error(`[Watcher] Could not process ${capture.filePath}`, error)
      })
      try {
        return await processing
      } finally {
        finishImagePipelineTrace(capture.diagnosticId)
      }
    }
    scheduleFlush(projectId)
    return 'imported'
  } catch (error) {
    console.error(`[Watcher] Could not inspect ${filePath}`, error)
    finishImagePipelineTrace(diagnosticId)
    throw error
  }
}

function scheduleFlush(projectId: number): void {
  const session = watchers.get(projectId)
  if (!session) return

  if (session.flushTimer) clearTimeout(session.flushTimer)
  session.flushTimer = setTimeout(() => {
    session.flushTimer = null
    const batch = sortCaptureFiles(session.pendingFiles.splice(0))
    if (batch.length === 0) return

    session.processing = session.processing
      .then(async () => {
        for (const capture of batch) {
          try {
            await handleNewPhoto(projectId, capture, session)
          } catch (error) {
            // Do not permanently lose a capture because a removable drive,
            // network folder, or image decoder was temporarily unavailable.
            session.seenPaths.delete(capture.filePath)
            console.error(
              `[Watcher] Could not process ${capture.filePath}; it will be retried`,
              error,
            )
          } finally {
            finishImagePipelineTrace(capture.diagnosticId)
          }
        }
      })
      .catch((error) => {
        console.error(`[Watcher] Could not process project ${projectId} capture batch`, error)
      })
  }, FLUSH_DELAY_MS)
}

function sendDroppedProgress(
  projectId: number,
  studentId: number,
  completed: number,
  total: number,
  result: DroppedCaptureFileResult,
): void {
  getMainWindow()?.webContents.send('watcher:dropProgress', {
    projectId,
    studentId,
    completed,
    total,
    result,
  })
}

async function ingestDroppedFiles(
  projectId: number,
  studentId: number,
  filePaths: string[],
): Promise<DroppedCaptureBatchResult> {
  if (desktopRetiring || getSetting('desktop_retired') === '1') {
    throw new Error('Cloud sync is disabled because this desktop was retired')
  }

  const db = getDb()
  const project = db
    .select()
    .from(projectsTable)
    .where(eq(projectsTable.id, projectId))
    .get()
  if (!project) throw new Error(`Project ${projectId} not found`)
  if (project.finishedAt) {
    throw new Error('This project is finished. Reopen it as a new local project before importing photos.')
  }
  const student = findProjectStudent(db, projectId, studentId)
  if (!student) throw new Error('Student does not belong to this project')
  if (!Array.isArray(filePaths)) throw new Error('Dropped files were not provided')

  // This session intentionally has no chokidar watcher. It reuses the same
  // stable-file and handleNewPhoto pipeline without importing the configured
  // watch folder or changing the camera sequence target.
  const session = createWatchSession(null, createSequenceState(), true)
  const results: DroppedCaptureFileResult[] = []
  let imported = 0
  let duplicates = 0
  let skipped = 0
  let errors = 0

  for (const rawPath of filePaths) {
    const filePath = typeof rawPath === 'string' ? rawPath : ''
    const fileName = filePath ? basename(filePath) : 'Unknown file'
    let diagnosticId: string | undefined
    let result: DroppedCaptureFileResult

    if (!filePath) {
      result = { filePath, fileName, status: 'error', reason: 'The dropped file path was empty.' }
    } else if (!getCaptureFileRole(fileName)) {
      result = {
        filePath,
        fileName,
        status: 'unsupported',
        reason: 'Only JPEG (.jpg/.jpeg) and supported RAW files can be imported.',
      }
    } else {
      try {
        diagnosticId = startImagePipelineTrace(filePath)
        const fileStat = await statFile(filePath)
        if (!fileStat.isFile()) {
          throw new Error('The dropped item is not a regular file.')
        }
        const status = await enqueueCapture(projectId, filePath, diagnosticId, {
          session,
          selectedStudentId: studentId,
          selectedGroupId: null,
          processImmediately: true,
        })
        if (status === 'duplicate') {
          result = {
            filePath,
            fileName,
            status: 'duplicate',
            reason: 'This source file was already imported or discarded.',
          }
        } else if (status === 'unmatched') {
          result = {
            filePath,
            fileName,
            status: 'error',
            reason: 'The capture could not be assigned to the selected student.',
          }
        } else {
          result = { filePath, fileName, status: 'imported' }
        }
      } catch (error) {
        result = {
          filePath,
          fileName,
          status: 'error',
          reason: error instanceof Error ? error.message : String(error),
        }
      } finally {
        finishImagePipelineTrace(diagnosticId)
      }
    }

    results.push(result)
    if (result.status === 'imported') imported++
    else if (result.status === 'duplicate') duplicates++
    else if (result.status === 'unsupported') skipped++
    else errors++
    sendDroppedProgress(projectId, studentId, results.length, filePaths.length, result)
  }

  await session.processing
  await session.persistence
  await Promise.allSettled([...session.pendingPersistences])
  await session.previewScheduler.waitForIdle()
  return {
    projectId,
    studentId,
    total: filePaths.length,
    imported,
    duplicates,
    skipped,
    errors,
    files: results,
  }
}

async function handleNewPhoto(
  projectId: number,
  capture: CaptureFile,
  session: WatchSession,
): Promise<CaptureProcessingStatus> {
  if (desktopRetiring) throw new Error('Cloud sync is disabled because this desktop was retired')
  const db = getDb()
  const project = db
    .select()
    .from(projectsTable)
    .where(eq(projectsTable.id, projectId))
    .get()
  if (!project) throw new Error(`Project ${projectId} not found`)
  const role = getCaptureFileRole(capture.fileName)
  if (
    !role
    || hasProcessedCaptureSource(db, capture.filePath)
    || hasProcessedQrMarkerSource(db, capture.filePath)
  ) return 'duplicate'

  // Group targets deliberately bypass student matching/QR sequencing. Both
  // JPEG and RAW files use the same repository pairing key and remain local
  // until the explicit project upload boundary.
  if (capture.selectedGroupId !== null && capture.selectedGroupId !== undefined) {
    const group = db.select().from(groupsTable).where(and(
      eq(groupsTable.id, capture.selectedGroupId), eq(groupsTable.projectId, projectId),
    )).get()
    if (!group) throw new Error('Active capture group no longer exists')
    const classRow = group.classId === null
      ? undefined
      : db.select().from(classesTable).where(eq(classesTable.id, group.classId)).get()
    const destination = join(
      getPhotosDir(), safeFolderName(project.schoolName),
      safeFolderName(classRow?.className ?? 'Unassigned Class'), safeFolderName(group.name),
    )
    mkdirSync(destination, { recursive: true })
    const storedPath = join(destination, formatGroupPhotoName(
      classRow?.className ?? 'Unassigned Class',
      group.name,
      capture.fileName,
      capture.filePath,
    ))
    await copyManagedCaptureFile(capture.filePath, storedPath)
    recordGroupCapture(db, {
      projectId, studentId: null, classId: group.classId, groupId: String(group.id),
      filePath: capture.filePath, storedPath, fileName: capture.fileName,
      capturedAt: new Date(capture.capturedAtMs).toISOString(),
    })
    notifyLiveUploadJobQueued(projectId)
    getMainWindow()?.webContents.send('groupCapture:updated', {
      projectId,
      groupId: group.id,
    })
    return 'imported'
  }

  if (role === 'RAW') {
    return handleNewRaw(projectId, capture, session, db)
  }

  const win = getMainWindow()
  const manualStudentId = capture.selectedStudentId !== undefined
    ? capture.selectedStudentId
    : session.sequenceState.manualStudentId
  const knownStudents = db.select().from(studentsTable).where(eq(studentsTable.projectId, projectId)).all()
  const filenameReference = extractStudentReference(
    capture.fileName,
    knownStudents.map((student) => student.generatedStudentId),
  )

  // Smart Shooter's roster ID is the most reliable portrait signal. Resolve
  // it before pixel QR detection so a portrait that happens to contain a
  // barcode/QR-like pattern is not swallowed as a marker.
  if (filenameReference) {
    const result = await processWatchedPhoto(projectId, capture.filePath, {
      store: createWatchedPhotoStore(db, capture.filePath),
      photosDir: getPhotosDir(),
      projectJpegOriginalsDir: getProjectStorage(projectId, project).jpegOriginals,
      readQr: async () => null,
      targetStudentId: manualStudentId,
      capturedAt: new Date(capture.capturedAtMs).toISOString(),
      diagnosticId: capture.diagnosticId,
      deferPersistence: true,
      onPreviewReady: (context) => enqueueLocalPreview(
        session.previewScheduler,
        win,
        projectId,
        capture,
        context.student,
        context,
      ),
    })

    if (result.kind === 'unmatched') {
      sendUnmatchedResult(win, projectId, result)
      console.log(`[Watcher] Unmatched ${capture.fileName}: ${result.reason}`)
      return 'unmatched'
    }

    if (result.kind === 'matched-pending') {
      const persistence = enqueueMatchedPhotoPersistence(session, db, win, projectId, capture, result)
      if (session.awaitDurability) await persistence
    }
    return 'imported'
  }

  if (manualStudentId !== null) {
    const result = await processWatchedPhoto(projectId, capture.filePath, {
      store: createWatchedPhotoStore(db, capture.filePath),
      photosDir: getPhotosDir(),
      projectJpegOriginalsDir: getProjectStorage(projectId, project).jpegOriginals,
      readQr: async () => null,
      targetStudentId: manualStudentId,
      capturedAt: new Date(capture.capturedAtMs).toISOString(),
      diagnosticId: capture.diagnosticId,
      deferPersistence: true,
      onPreviewReady: (context) => enqueueLocalPreview(
        session.previewScheduler,
        win,
        projectId,
        capture,
        context.student,
        context,
      ),
    })

    if (result.kind === 'unmatched') {
      sendUnmatchedResult(win, projectId, result)
      console.log(`[Watcher] Unmatched ${capture.fileName}: ${result.reason}`)
      return 'unmatched'
    }

    if (result.kind === 'matched-pending') {
      const persistence = enqueueMatchedPhotoPersistence(session, db, win, projectId, capture, result)
      if (session.awaitDurability) await persistence
    }
    return 'imported'
  }

  // A QR marker can select the next student when the photographer has not
  // explicitly selected one in the roster.
  const qrResult = await readQrFromImage(capture.filePath)

  if (qrResult) {
    const normalizedQrStudentId = qrResult.studentId.trim().toLocaleLowerCase()
    const student = db
      .select()
      .from(studentsTable)
      .where(eq(studentsTable.projectId, projectId))
      .all()
      .find((candidate) =>
        candidate.generatedStudentId.trim().toLocaleLowerCase() === normalizedQrStudentId)

    const decision = advanceSequence(session.sequenceState, {
      kind: 'marker',
      studentId: student?.id ?? null,
      reference: qrResult.studentId,
    })

    if (decision.kind === 'review') {
      recordUnmatched(db, win, projectId, capture, decision.reason)
      emitActiveStudentChanged(projectId, null, 'none')
      return 'unmatched'
    }

    if (!student) {
      recordUnmatched(
        db,
        win,
        projectId,
        capture,
        `QR marker "${qrResult.studentId}" does not match a student in this project`,
      )
      return 'unmatched'
    }

    const marker = await persistQrMarker(db, projectId, student, capture)
    win?.webContents.send('photo:marker', {
      markerId: marker.id,
      fileName: capture.fileName,
      capturedAt: new Date(capture.capturedAtMs).toISOString(),
      student: toStudentEvent(db, student!),
    })
    emitActiveStudentChanged(
      projectId,
      student.id,
      'qr',
    )
    console.log(`[Watcher] QR marker ${capture.fileName} → ${student!.firstName} ${student!.lastName}`)
    return 'imported'
  }

  // Once a QR marker is active, its sequence owns every following portrait.
  // Filename matching remains available only for older Smart Shooter setups
  // that do not use marker images.
  if (session.sequenceState.activeStudentId === null) {
    if (looksLikeSmartShooterName(capture.fileName)) {
      const result = await processWatchedPhoto(projectId, capture.filePath, {
        store: createWatchedPhotoStore(db, capture.filePath),
        photosDir: getPhotosDir(),
        projectJpegOriginalsDir: getProjectStorage(projectId, project).jpegOriginals,
        readQr: async () => null,
        capturedAt: new Date(capture.capturedAtMs).toISOString(),
        diagnosticId: capture.diagnosticId,
        deferPersistence: true,
        onPreviewReady: (context) => enqueueLocalPreview(
          session.previewScheduler,
          win,
          projectId,
          capture,
          context.student,
          context,
        ),
      })

      if (result.kind === 'unmatched') {
        sendUnmatchedResult(win, projectId, result)
        console.log(`[Watcher] Unmatched ${capture.fileName}: ${result.reason}`)
        return 'unmatched'
      }

      if (result.kind === 'matched-pending') {
        const persistence = enqueueMatchedPhotoPersistence(session, db, win, projectId, capture, result)
        if (session.awaitDurability) await persistence
      }
      return 'imported'
    }
  }

  const decision = advanceSequence(session.sequenceState, { kind: 'portrait' })
  if (decision.kind === 'review') {
    recordUnmatched(db, win, projectId, capture, decision.reason)
    return 'unmatched'
  }

  const student = db
    .select()
    .from(studentsTable)
    .where(
      and(
        eq(studentsTable.projectId, projectId),
        eq(studentsTable.id, decision.studentId),
      ),
    )
    .get()

  if (!student) {
    session.sequenceState.activeStudentId = null
    recordUnmatched(db, win, projectId, capture, 'The active student is no longer in this project roster')
    return 'unmatched'
  }

  const result = await processWatchedPhoto(projectId, capture.filePath, {
    store: createWatchedPhotoStore(db, capture.filePath),
    photosDir: getPhotosDir(),
    projectJpegOriginalsDir: getProjectStorage(projectId, project).jpegOriginals,
    readQr: async () => null,
    targetStudentId: student.id,
    capturedAt: new Date(capture.capturedAtMs).toISOString(),
    diagnosticId: capture.diagnosticId,
    deferPersistence: true,
    onPreviewReady: (context) => enqueueLocalPreview(
      session.previewScheduler,
      win,
      projectId,
      capture,
      context.student,
      context,
    ),
  })
  if (result.kind === 'unmatched') {
    sendUnmatchedResult(win, projectId, result)
    return 'unmatched'
  }
  if (result.kind === 'matched-pending') {
    const persistence = enqueueMatchedPhotoPersistence(session, db, win, projectId, capture, result)
    if (session.awaitDurability) await persistence
  }
  return 'imported'
}

async function copyToProjectFolder(
  sourcePath: string,
  fileName: string,
  destinationDir: string,
): Promise<string> {
  await mkdir(destinationDir, { recursive: true })
  let destinationPath = join(destinationDir, fileName)
  if (resolve(sourcePath) !== resolve(destinationPath) && existsSync(destinationPath)) {
    const parsed = parse(fileName)
    let suffix = 2
    do {
      destinationPath = join(destinationDir, `${parsed.name}-${suffix}${parsed.ext}`)
      suffix++
    } while (existsSync(destinationPath))
  }
  if (resolve(sourcePath) !== resolve(destinationPath)) {
    await copyFile(sourcePath, destinationPath)
  }
  return destinationPath
}

function nextAvailableFileName(destinationDirs: string[], fileName: string): string {
  const isAvailable = (candidate: string) =>
    destinationDirs.every((directory) => !existsSync(join(directory, candidate)))
  if (isAvailable(fileName)) return fileName

  const parsed = parse(fileName)
  let suffix = 2
  let candidate = `${parsed.name}-${suffix}${parsed.ext}`
  while (!isAvailable(candidate)) {
    suffix++
    candidate = `${parsed.name}-${suffix}${parsed.ext}`
  }
  return candidate
}

async function persistQrMarker(
  db: ReturnType<typeof getDb>,
  projectId: number,
  student: typeof studentsTable.$inferSelect,
  capture: CaptureFile,
): Promise<typeof qrMarkersTable.$inferSelect> {
  const project = db.select().from(projectsTable).where(eq(projectsTable.id, projectId)).get()
  const classRow = db.select().from(classesTable).where(eq(classesTable.id, student.classId)).get()
  if (!project) throw new Error(`Project ${projectId} not found`)

  const projectFolder = safeFolderName(project.schoolName)
  const classFolder = safeFolderName(classRow?.className ?? 'Unassigned Class')
  const studentFolder = safeFolderName(formatStudentFolderName(
    student.firstName,
    student.lastName,
    student.generatedStudentId,
  ))
  const markerDir = join(getPhotosDir(), projectFolder, classFolder, studentFolder, 'QR Markers')
  const storedPath = await copyToProjectFolder(capture.filePath, capture.fileName, markerDir)
  const result = recordQrMarker(db, {
    projectId,
    studentId: student.id,
    filePath: storedPath,
    fileName: capture.fileName,
    sourcePath: capture.filePath,
    capturedAt: new Date(capture.capturedAtMs).toISOString(),
  })
  return result.marker
}

async function handleNewRaw(
  projectId: number,
  capture: CaptureFile,
  session: WatchSession,
  db: ReturnType<typeof getDb>,
): Promise<CaptureProcessingStatus> {
  const project = db.select().from(projectsTable).where(eq(projectsTable.id, projectId)).get()
  if (!project) throw new Error(`Project ${projectId} not found`)

  const knownStudents = db.select().from(studentsTable).where(eq(studentsTable.projectId, projectId)).all()
  const filenameReference = extractStudentReference(
    capture.fileName,
    knownStudents.map((student) => student.generatedStudentId),
  )
  const filenameStudent = findStudentByFilename(db, projectId, capture.fileName)
  const manualStudentId = capture.selectedStudentId !== undefined
    ? capture.selectedStudentId
    : session.sequenceState.manualStudentId
  const manualStudent = manualStudentId === null
    ? undefined
    : findProjectStudent(db, projectId, manualStudentId)
  const sequenceStudentId = session.sequenceState.activeStudentId
  const sequenceStudent = sequenceStudentId === null
    ? undefined
    : findProjectStudent(db, projectId, sequenceStudentId)
  // The in-app target is authoritative when one was captured with the file.
  const student = manualStudentId !== null
    ? manualStudent
    : filenameStudent ?? sequenceStudent
  markImagePipeline(
    capture.diagnosticId,
    'student lookup complete',
    `reference=${filenameReference ?? 'none'} student=${student?.id ?? 'none'} file=${capture.fileName}`,
  )
  markImagePipeline(
    capture.diagnosticId,
    'student assigned',
    student ? `student=${student.id} file=${capture.fileName}` : `student=none file=${capture.fileName}`,
  )
  if (student) {
    const destinationFileName = formatStudentPhotoName(
      student.firstName,
      student.lastName,
      student.generatedStudentId,
      capture.fileName,
    )
    enqueueLocalPreview(
      session.previewScheduler,
      getMainWindow(),
      projectId,
      capture,
      student,
      {
        filePath: capture.filePath,
        fileName: destinationFileName,
        capturedAt: new Date(capture.capturedAtMs).toISOString(),
      },
    )
  }

  const task = session.persistence.then(async () => {
      await session.previewScheduler.waitForIdle()
      const storage = getProjectStorage(projectId, project)
      const destinationFileName = student
        ? formatStudentPhotoName(
          student.firstName,
          student.lastName,
          student.generatedStudentId,
          capture.fileName,
        )
        : capture.fileName
      const studentFolder = student ? getStudentPhotoFolder(db, projectId, student) : null
      const outputFileName = nextAvailableFileName(
        [studentFolder, storage.rawOriginals]
          .filter((directory): directory is string => directory !== null),
        destinationFileName,
      )
      markImagePipeline(
        capture.diagnosticId,
        'file move started',
        `destination=${student ? 'student folder' : 'RAW originals'} mode=async-copy`,
      )
      const legacyStoredPath = student
        ? await copyToProjectFolder(
          capture.filePath,
          outputFileName,
          studentFolder!,
        )
        : null
      const storedPath = await copyToProjectFolder(
        capture.filePath,
        outputFileName,
        storage.rawOriginals,
      )
      markImagePipeline(
        capture.diagnosticId,
        'file move complete',
        `storedPath=${storedPath} legacyPath=${legacyStoredPath ?? 'none'} mode=async-copy`,
      )
      markImagePipeline(capture.diagnosticId, 'RAW pairing complete', `capture=${capture.fileName}`)
      markImagePipeline(capture.diagnosticId, 'database write started', `capture=${capture.fileName}`)
      const result = recordRawCapture(db, {
        projectId,
        studentId: student?.id ?? null,
        classId: student?.classId ?? null,
        filePath: capture.filePath,
        storedPath,
        fileName: outputFileName,
        capturedAt: new Date(capture.capturedAtMs).toISOString(),
      })

      if (result.kind === 'duplicate') return
      notifyLiveUploadJobQueued(projectId)
      markImagePipeline(capture.diagnosticId, 'database write complete', `capture=${result.captureId}`)
      const savedCapture = db
        .select()
        .from(capturesTable)
        .where(eq(capturesTable.id, result.captureId))
        .get()
      getMainWindow()?.webContents.send('capture:updated', {
        projectId,
        captureId: result.captureId,
        studentId: savedCapture?.studentId ?? null,
      })
      markImagePipeline(capture.diagnosticId, 'IPC event sent', 'RAW capture update')
      console.log(
        `[Watcher] RAW ${result.kind === 'paired' ? 'paired' : 'stored'} ${capture.fileName}`
          + ` for project ${projectId}${student ? ` → ${student.firstName} ${student.lastName}` : ''}`,
      )
    })
  const handledTask = task.catch((error) => {
      session.seenPaths.delete(capture.filePath)
      console.error(`[Watcher] Could not persist RAW ${capture.filePath}; it will be retried`, error)
    })
  session.persistence = handledTask
  session.pendingPersistences.add(handledTask)
  void handledTask.finally(() => session.pendingPersistences.delete(handledTask)).catch(() => {})
  if (session.awaitDurability) await task
  return 'imported'
}

async function finishMatchedPhoto(
  db: ReturnType<typeof getDb>,
  win: BrowserWindow | null,
  photo: typeof photosTable.$inferSelect,
  student: typeof studentsTable.$inferSelect,
  diagnosticId?: string,
  previewThumbnailData?: string | null,
  options: { skipPreviewGeneration?: boolean } = {},
): Promise<void> {
  console.log(`[Watcher] Matched ${photo.fileName} → ${student.firstName} ${student.lastName}`)
  // The fast path normally generated this artifact from the untouched source
  // before the managed copy and database work. Recovery paths also generate a
  // reduced artifact rather than sending the managed original to the renderer.
  let previewUrl = previewThumbnailData?.startsWith('mc-preview://')
    ? previewThumbnailData
    : undefined
  if (
    !options.skipPreviewGeneration
    && !previewUrl
    && (previewThumbnailData === undefined || previewThumbnailData === null)
  ) {
    const previewPath = await generateLivePreview(photo.filePath, {
      previewKey: diagnosticId ?? `persisted-photo-${photo.id}`,
      cacheDir: getLivePreviewCacheDir(app.getPath('home')),
    })
    previewUrl = previewPath
      ? createLocalPreviewUrl(previewPath, diagnosticId ?? `persisted-photo-${photo.id}`)
      : undefined
  }
  const thumbnailData = previewUrl ? null : previewThumbnailData
  const capture = db
    .select()
    .from(capturesTable)
    .where(eq(capturesTable.legacyPhotoId, photo.id))
    .get()
  const photoForEvent: Photo = {
    id: photo.id,
    projectId: photo.projectId,
    studentId: photo.studentId,
    filePath: photo.filePath,
    fileName: photo.fileName,
    capturedAt: photo.capturedAt,
    isMatched: true,
    thumbnailData: thumbnailData ?? null,
    createdAt: photo.createdAt,
    previewKey: diagnosticId,
    previewUrl,
  }

  win?.webContents.send('photo:matched', {
    photo: photoForEvent,
    student: toStudentEvent(db, student),
    captureId: capture?.id,
    previewKey: diagnosticId,
  })
  markImagePipeline(diagnosticId, 'IPC event sent', 'persisted local capture')
  if (capture) {
    win?.webContents.send('capture:updated', {
      projectId: photo.projectId,
      captureId: capture.id,
      studentId: photo.studentId,
    })
  }

}

function recordUnmatched(
  db: ReturnType<typeof getDb>,
  win: BrowserWindow | null,
  projectId: number,
  capture: CaptureFile,
  reason: string,
): void {
  markImagePipeline(capture.diagnosticId, 'database write started', `file=${capture.fileName}`)
  const photo = db.insert(photosTable)
    .values({
      projectId,
      studentId: null,
      filePath: capture.filePath,
      fileName: capture.fileName,
      capturedAt: new Date(capture.capturedAtMs).toISOString(),
      isMatched: false,
    })
    .returning()
    .get()
  mirrorPhotoAsCapture(db, photo, capture.filePath)
  markImagePipeline(capture.diagnosticId, 'database write complete', `photo=${photo.id}`)

  win?.webContents.send('photo:unmatched', {
    projectId,
    photoId: photo.id,
    filePath: capture.filePath,
    fileName: capture.fileName,
    reason,
  })
  markImagePipeline(capture.diagnosticId, 'IPC event sent', 'unmatched local capture')
}
