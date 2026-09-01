import { app, ipcMain, BrowserWindow } from 'electron'
import chokidar, { FSWatcher } from 'chokidar'
import { existsSync, mkdirSync } from 'fs'
import { copyFile, mkdir, stat as statFile } from 'fs/promises'
import { basename, extname, join, parse, resolve } from 'path'
import { and, eq } from 'drizzle-orm'
import { getDb, getPhotosDir } from '../db'
import {
  capturesTable,
  classesTable,
  photosTable,
  projectsTable,
  qrMarkersTable,
  studentsTable,
} from '../db/schema'
import { getSetting } from './upload'
import { extractStudentReference } from '../lib/photoFileNaming'
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
  watcher: FSWatcher
  pendingFiles: CaptureFile[]
  pendingEnqueues: Set<Promise<void>>
  flushTimer: NodeJS.Timeout | null
  processing: Promise<void>
  persistence: Promise<void>
  pendingPersistences: Set<Promise<void>>
  previewScheduler: NewestLivePreviewScheduler
  seenPaths: Set<string>
  sequenceState: SequenceState
}

// Active watchers: projectId → watcher session
const watchers = new Map<number, WatchSession>()
const pendingManualTargets = new Map<number, number>()
let desktopRetiring = false

export async function stopAllWatchersForRetirement(): Promise<void> {
  desktopRetiring = true
  const sessions = [...watchers.values()]
  watchers.clear()
  for (const session of sessions) {
    if (session.flushTimer) clearTimeout(session.flushTimer)
    session.flushTimer = null
    session.pendingFiles = []
    await Promise.allSettled([...session.pendingEnqueues])
  }
  await Promise.allSettled(sessions.map((session) => session.watcher.close()))
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
}

export function enableWatchersAfterSignIn(): void {
  desktopRetiring = false
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
    safeFolderName(`${student.generatedStudentId}_${student.lastName}_${student.firstName}`),
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
): void {
  const task = session.persistence
    .then(async () => {
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
    })
    .catch((error) => {
      // The source remains untouched and can be retried after a removable or
      // network-backed destination becomes available again.
      session.seenPaths.delete(capture.filePath)
      console.error(`[Watcher] Could not persist ${capture.filePath}; it will be retried`, error)
    })
  session.persistence = task
  session.pendingPersistences.add(task)
  void task.finally(() => session.pendingPersistences.delete(task)).catch(() => {})
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

    const session: WatchSession = {
      watcher,
      pendingFiles: [],
      pendingEnqueues: new Set(),
      flushTimer: null,
      processing: Promise.resolve(),
      persistence: Promise.resolve(),
      pendingPersistences: new Set(),
      previewScheduler: new NewestLivePreviewScheduler(),
      seenPaths: new Set(),
      sequenceState: createSequenceState(pendingManualTargets.get(projectId) ?? null),
    }
    watchers.set(projectId, session)

    watcher.on('add', (filePath) => {
      const diagnosticId = startImagePipelineTrace(filePath)
      const enqueueTask = enqueueCapture(projectId, filePath, diagnosticId)
      session.pendingEnqueues.add(enqueueTask)
      void enqueueTask.finally(() => session.pendingEnqueues.delete(enqueueTask))
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
        const session = watchers.get(projectId)
        if (session) setManualStudent(session.sequenceState, studentId)
      } else {
        pendingManualTargets.delete(projectId)
        const session = watchers.get(projectId)
        if (session) clearManualStudent(session.sequenceState)
      }

      emitActiveStudentChanged(projectId, studentId, studentId === null ? 'none' : 'manual')
      return studentId
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
      emitActiveStudentChanged(projectId, null, 'none')
    }
    return
  }

  // Remove the session before closing chokidar so late filesystem callbacks
  // cannot enqueue new work after the finish operation has begun.
  watchers.delete(projectId)
  if (session.flushTimer) clearTimeout(session.flushTimer)
  session.flushTimer = null
  await session.watcher.close()
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
): Promise<void> {
  if (desktopRetiring) {
    finishImagePipelineTrace(diagnosticId)
    return
  }
  const session = watchers.get(projectId)
  if (!session || session.seenPaths.has(filePath)) {
    finishImagePipelineTrace(diagnosticId)
    return
  }

  if (!getCaptureFileRole(filePath)) {
    finishImagePipelineTrace(diagnosticId)
    return
  }

  try {
    const fileStat = await waitForStableFile(filePath, statFile)
    markImagePipeline(diagnosticId, 'file became stable', `bytes=${fileStat.size}`)
    if (desktopRetiring || watchers.get(projectId) !== session) {
      finishImagePipelineTrace(diagnosticId)
      return
    }
    if (!registerCapturePath(session.seenPaths, filePath)) return
    session.pendingFiles.push({
      filePath,
      fileName: basename(filePath),
      capturedAtMs: captureTimestamp(fileStat),
      diagnosticId,
      // Capture the effective target at arrival time. Processing can be
      // delayed by image copies or a burst of filesystem events, and a
      // photographer may select another student or scan another QR during
      // that delay.
      selectedStudentId: session.sequenceState.manualStudentId
        ?? session.sequenceState.activeStudentId,
    })
    scheduleFlush(projectId)
  } catch (error) {
    console.error(`[Watcher] Could not inspect ${filePath}`, error)
    finishImagePipelineTrace(diagnosticId)
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

async function handleNewPhoto(
  projectId: number,
  capture: CaptureFile,
  session: WatchSession,
): Promise<void> {
  if (desktopRetiring) return
  const db = getDb()
  const role = getCaptureFileRole(capture.fileName)
  if (
    !role
    || hasProcessedCaptureSource(db, capture.filePath)
    || hasProcessedQrMarkerSource(db, capture.filePath)
  ) return

  if (role === 'RAW') {
    await handleNewRaw(projectId, capture, session, db)
    return
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
      return
    }

    if (result.kind === 'matched-pending') {
      enqueueMatchedPhotoPersistence(session, db, win, projectId, capture, result)
    }
    return
  }

  if (manualStudentId !== null) {
    const result = await processWatchedPhoto(projectId, capture.filePath, {
      store: createWatchedPhotoStore(db, capture.filePath),
      photosDir: getPhotosDir(),
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
      return
    }

    if (result.kind === 'matched-pending') {
      enqueueMatchedPhotoPersistence(session, db, win, projectId, capture, result)
    }
    return
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
      return
    }

    if (!student) {
      recordUnmatched(
        db,
        win,
        projectId,
        capture,
        `QR marker "${qrResult.studentId}" does not match a student in this project`,
      )
      return
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
    return
  }

  // Once a QR marker is active, its sequence owns every following portrait.
  // Filename matching remains available only for older Smart Shooter setups
  // that do not use marker images.
  if (session.sequenceState.activeStudentId === null) {
    if (looksLikeSmartShooterName(capture.fileName)) {
      const result = await processWatchedPhoto(projectId, capture.filePath, {
        store: createWatchedPhotoStore(db, capture.filePath),
        photosDir: getPhotosDir(),
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
        return
      }

      if (result.kind === 'matched-pending') {
        enqueueMatchedPhotoPersistence(session, db, win, projectId, capture, result)
      }
      return
    }
  }

  const decision = advanceSequence(session.sequenceState, { kind: 'portrait' })
  if (decision.kind === 'review') {
    recordUnmatched(db, win, projectId, capture, decision.reason)
    return
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
    return
  }

  const result = await processWatchedPhoto(projectId, capture.filePath, {
    store: createWatchedPhotoStore(db, capture.filePath),
    photosDir: getPhotosDir(),
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
    return
  }
  if (result.kind === 'matched-pending') {
    enqueueMatchedPhotoPersistence(session, db, win, projectId, capture, result)
  }
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
  const studentFolder = safeFolderName(`${student.generatedStudentId}_${student.lastName}_${student.firstName}`)
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
): Promise<void> {
  const project = db.select().from(projectsTable).where(eq(projectsTable.id, projectId)).get()
  if (!project) return

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
  const conflictReason = manualStudentId !== null
    && filenameReference
    && (!filenameStudent || filenameStudent.id !== manualStudentId)
    ? filenameStudent
      ? `RAW filename for ${filenameStudent.firstName} ${filenameStudent.lastName} conflicts with the selected student`
      : `RAW filename student ID "${filenameReference}" conflicts with the selected student`
    : null
  const student = conflictReason ? undefined : manualStudent ?? filenameStudent ?? sequenceStudent
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
    enqueueLocalPreview(
      session.previewScheduler,
      getMainWindow(),
      projectId,
      capture,
      student,
      {
        filePath: capture.filePath,
        fileName: capture.fileName,
        capturedAt: new Date(capture.capturedAtMs).toISOString(),
      },
    )
  }

  const task = session.persistence
    .then(async () => {
      await session.previewScheduler.waitForIdle()
      const storage = ensureProjectStorageLayout(
        getProjectStorageLayout(
          getPhotoSystemLayout(app.getPath('home')),
          projectId,
          project.schoolName,
        ),
      )
      markImagePipeline(
        capture.diagnosticId,
        'file move started',
        `destination=${student ? 'student folder' : 'RAW originals'} mode=async-copy`,
      )
      const storedPath = await copyToProjectFolder(
        capture.filePath,
        capture.fileName,
        student ? getStudentPhotoFolder(db, projectId, student) : storage.rawOriginals,
      )
      markImagePipeline(capture.diagnosticId, 'file move complete', `storedPath=${storedPath} mode=async-copy`)
      markImagePipeline(capture.diagnosticId, 'RAW pairing complete', `capture=${capture.fileName}`)
      markImagePipeline(capture.diagnosticId, 'database write started', `capture=${capture.fileName}`)
      const result = recordRawCapture(db, {
        projectId,
        studentId: student?.id ?? null,
        classId: student?.classId ?? null,
        filePath: capture.filePath,
        storedPath,
        fileName: capture.fileName,
        capturedAt: new Date(capture.capturedAtMs).toISOString(),
      })

      if (result.kind === 'duplicate') return
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
      if (conflictReason) {
        sendUnmatchedResult(getMainWindow(), projectId, {
          filePath: capture.filePath,
          fileName: capture.fileName,
          reason: conflictReason,
        })
      }
      console.log(
        `[Watcher] RAW ${result.kind === 'paired' ? 'paired' : 'stored'} ${capture.fileName}`
          + ` for project ${projectId}${student ? ` → ${student.firstName} ${student.lastName}` : ''}`,
      )
    })
    .catch((error) => {
      session.seenPaths.delete(capture.filePath)
      console.error(`[Watcher] Could not persist RAW ${capture.filePath}; it will be retried`, error)
    })
  session.persistence = task
  session.pendingPersistences.add(task)
  void task.finally(() => session.pendingPersistences.delete(task)).catch(() => {})
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
