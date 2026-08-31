import { app, ipcMain, BrowserWindow } from 'electron'
import chokidar, { FSWatcher } from 'chokidar'
import { copyFileSync, existsSync, mkdirSync } from 'fs'
import { stat as statFile } from 'fs/promises'
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
import { getSetting, getUploadConfig, queueCaptureUploads, uploadPhoto } from './upload'
import { extractStudentReference } from '../lib/photoFileNaming'
import { readQrFromImage } from '../lib/qrReader'
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
import type { ActiveCaptureTargetEvent, Photo, Student } from '../../shared/types'
import { createWatchedPhotoStore, processWatchedPhoto } from '../lib/watchedPhotoProcessor'
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
import { resolveWatchFolders } from '../lib/watchFolders'

const FLUSH_DELAY_MS = 500

interface WatchSession {
  watcher: FSWatcher
  pendingFiles: CaptureFile[]
  flushTimer: NodeJS.Timeout | null
  processing: Promise<void>
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
  }
  await Promise.allSettled(sessions.map((session) => session.watcher.close()))
  await Promise.allSettled(sessions.map((session) => session.processing))
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

export function registerWatcherHandlers() {
  const db = getDb()

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
      awaitWriteFinish: { stabilityThreshold: 1500, pollInterval: 100 },
    })

    const session: WatchSession = {
      watcher,
      pendingFiles: [],
      flushTimer: null,
      processing: Promise.resolve(),
      seenPaths: new Set(),
      sequenceState: createSequenceState(pendingManualTargets.get(projectId) ?? null),
    }
    watchers.set(projectId, session)

    watcher.on('add', (filePath) => {
      void enqueueCapture(projectId, filePath)
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
    const session = watchers.get(projectId)
    if (session) {
      if (session.flushTimer) clearTimeout(session.flushTimer)
      session.pendingFiles = []
      await session.watcher.close()
      watchers.delete(projectId)
    }
    pendingManualTargets.delete(projectId)
    emitActiveStudentChanged(projectId, null, 'none')
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

async function enqueueCapture(projectId: number, filePath: string): Promise<void> {
  if (desktopRetiring) return
  const session = watchers.get(projectId)
  if (!session || session.seenPaths.has(filePath)) return

  if (!getCaptureFileRole(filePath)) return

  try {
    const fileStat = await statFile(filePath)
    if (!fileStat.isFile()) return
    if (!registerCapturePath(session.seenPaths, filePath)) return
    session.pendingFiles.push({
      filePath,
      fileName: basename(filePath),
      capturedAtMs: captureTimestamp(fileStat),
    })
    scheduleFlush(projectId)
  } catch (error) {
    console.error(`[Watcher] Could not inspect ${filePath}`, error)
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
  const manualStudentId = session.sequenceState.manualStudentId
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
    })

    if (result.kind === 'unmatched') {
      sendUnmatchedResult(win, projectId, result)
      console.log(`[Watcher] Unmatched ${capture.fileName}: ${result.reason}`)
      return
    }

    finishMatchedPhoto(db, win, result.photo, result.student)
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

    if (manualStudentId !== null && (!student || student.id !== manualStudentId)) {
      recordUnmatched(
        db,
        win,
        projectId,
        capture,
        student
          ? `QR marker for ${student.firstName} ${student.lastName} conflicts with the selected student`
          : `QR marker "${qrResult.studentId}" does not match the selected student`,
      )
      return
    }

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

    const marker = persistQrMarker(db, projectId, student, capture)
    win?.webContents.send('photo:marker', {
      markerId: marker.id,
      fileName: capture.fileName,
      capturedAt: new Date(capture.capturedAtMs).toISOString(),
      student: toStudentEvent(db, student!),
    })
    emitActiveStudentChanged(
      projectId,
      student.id,
      manualStudentId === null ? 'qr' : 'manual',
    )
    console.log(`[Watcher] QR marker ${capture.fileName} → ${student!.firstName} ${student!.lastName}`)
    return
  }

  if (manualStudentId !== null) {
    const result = await processWatchedPhoto(projectId, capture.filePath, {
      store: createWatchedPhotoStore(db, capture.filePath),
      photosDir: getPhotosDir(),
      readQr: async () => null,
      targetStudentId: manualStudentId,
      capturedAt: new Date(capture.capturedAtMs).toISOString(),
    })

    if (result.kind === 'unmatched') {
      sendUnmatchedResult(win, projectId, result)
      console.log(`[Watcher] Unmatched ${capture.fileName}: ${result.reason}`)
      return
    }

    finishMatchedPhoto(db, win, result.photo, result.student)
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
      })

      if (result.kind === 'unmatched') {
        sendUnmatchedResult(win, projectId, result)
        console.log(`[Watcher] Unmatched ${capture.fileName}: ${result.reason}`)
        return
      }

      finishMatchedPhoto(db, win, result.photo, result.student)
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

  const [classRow] = db.select().from(classesTable).where(eq(classesTable.id, student.classId)).all()
  const [project] = db.select().from(projectsTable).where(eq(projectsTable.id, projectId)).all()
  const projectFolder = safeFolderName(project?.schoolName ?? `Project ${projectId}`)
  const classFolder = safeFolderName(classRow?.className ?? 'Unassigned Class')
  const studentFolder = safeFolderName(`${student.generatedStudentId}_${student.lastName}_${student.firstName}`)
  // Keep the source untouched; organize a durable local copy by project/class/student.
  const destDir = join(getPhotosDir(), projectFolder, classFolder, studentFolder)
  mkdirSync(destDir, { recursive: true })
  const destPath = join(destDir, capture.fileName)
  copyFileSync(capture.filePath, destPath)

  const photo = db
    .insert(photosTable)
    .values({
      projectId,
      studentId: student.id,
      filePath: destPath,
      fileName: capture.fileName,
      capturedAt: new Date(capture.capturedAtMs).toISOString(),
      isMatched: true,
    })
    .returning()
    .get()
  mirrorPhotoAsCapture(db, photo, capture.filePath)

  finishMatchedPhoto(db, win, photo, student)
}

function copyToProjectFolder(sourcePath: string, fileName: string, destinationDir: string): string {
  mkdirSync(destinationDir, { recursive: true })
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
    copyFileSync(sourcePath, destinationPath)
  }
  return destinationPath
}

function persistQrMarker(
  db: ReturnType<typeof getDb>,
  projectId: number,
  student: typeof studentsTable.$inferSelect,
  capture: CaptureFile,
): typeof qrMarkersTable.$inferSelect {
  const project = db.select().from(projectsTable).where(eq(projectsTable.id, projectId)).get()
  const classRow = db.select().from(classesTable).where(eq(classesTable.id, student.classId)).get()
  if (!project) throw new Error(`Project ${projectId} not found`)

  const projectFolder = safeFolderName(project.schoolName)
  const classFolder = safeFolderName(classRow?.className ?? 'Unassigned Class')
  const studentFolder = safeFolderName(`${student.generatedStudentId}_${student.lastName}_${student.firstName}`)
  const markerDir = join(getPhotosDir(), projectFolder, classFolder, studentFolder, 'QR Markers')
  const storedPath = copyToProjectFolder(capture.filePath, capture.fileName, markerDir)
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

function handleNewRaw(
  projectId: number,
  capture: CaptureFile,
  session: WatchSession,
  db: ReturnType<typeof getDb>,
): void {
  const project = db.select().from(projectsTable).where(eq(projectsTable.id, projectId)).get()
  if (!project) return

  const knownStudents = db.select().from(studentsTable).where(eq(studentsTable.projectId, projectId)).all()
  const filenameReference = extractStudentReference(
    capture.fileName,
    knownStudents.map((student) => student.generatedStudentId),
  )
  const filenameStudent = findStudentByFilename(db, projectId, capture.fileName)
  const manualStudentId = session.sequenceState.manualStudentId
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
  const storage = ensureProjectStorageLayout(
    getProjectStorageLayout(
      getPhotoSystemLayout(app.getPath('home')),
      projectId,
      project.schoolName,
    ),
  )
  const storedPath = copyToProjectFolder(
    capture.filePath,
    capture.fileName,
    student ? getStudentPhotoFolder(db, projectId, student) : storage.rawOriginals,
  )
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
  if (conflictReason) {
    sendUnmatchedResult(getMainWindow(), projectId, {
      filePath: capture.filePath,
      fileName: capture.fileName,
      reason: conflictReason,
    })
  }
  void queueCaptureUploads(result.captureId).catch(() => {})
  console.log(
    `[Watcher] RAW ${result.kind === 'paired' ? 'paired' : 'stored'} ${capture.fileName}`
      + ` for project ${projectId}${student ? ` → ${student.firstName} ${student.lastName}` : ''}`,
  )
}

function finishMatchedPhoto(
  db: ReturnType<typeof getDb>,
  win: BrowserWindow | null,
  photo: typeof photosTable.$inferSelect,
  student: typeof studentsTable.$inferSelect,
): void {
  console.log(`[Watcher] Matched ${photo.fileName} → ${student.firstName} ${student.lastName}`)
  const photoForEvent: Photo = {
    id: photo.id,
    projectId: photo.projectId,
    studentId: photo.studentId,
    filePath: photo.filePath,
    fileName: photo.fileName,
    capturedAt: photo.capturedAt,
    isMatched: true,
    thumbnailData: null,
    createdAt: photo.createdAt,
  }

  win?.webContents.send('photo:matched', {
    photo: photoForEvent,
    student: toStudentEvent(db, student),
  })
  const capture = db
    .select()
    .from(capturesTable)
    .where(eq(capturesTable.legacyPhotoId, photo.id))
    .get()
  if (capture) {
    win?.webContents.send('capture:updated', {
      projectId: photo.projectId,
      captureId: capture.id,
      studentId: photo.studentId,
    })
  }

  db.update(photosTable)
    .set({ uploadStatus: 'pending' })
    .where(eq(photosTable.id, photo.id))
    .run()
  win?.webContents.send('upload:statusChanged', {
    photoId: photo.id,
    studentId: student.id,
    status: 'pending',
  })

  if (capture) {
    void queueCaptureUploads(capture.id).catch(() => {})
  } else {
    const { apiUrl, connectionToken } = getUploadConfig()
    if (apiUrl && connectionToken) {
      uploadPhoto(photo.projectId, student.id, photo.id, photo.filePath, photo.fileName, photo.capturedAt)
        .catch(() => {})
    }
  }
}

function recordUnmatched(
  db: ReturnType<typeof getDb>,
  win: BrowserWindow | null,
  projectId: number,
  capture: CaptureFile,
  reason: string,
): void {
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

  win?.webContents.send('photo:unmatched', {
    projectId,
    photoId: photo.id,
    filePath: capture.filePath,
    fileName: capture.fileName,
    reason,
  })
}
