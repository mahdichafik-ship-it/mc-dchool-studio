import { ipcMain, BrowserWindow } from 'electron'
import chokidar, { FSWatcher } from 'chokidar'
import { copyFileSync, mkdirSync } from 'fs'
import { stat as statFile } from 'fs/promises'
import { basename, extname, join } from 'path'
import { and, eq } from 'drizzle-orm'
import { getDb, getPhotosDir } from '../db'
import { classesTable, photosTable, projectsTable, studentsTable } from '../db/schema'
import { getSetting, getUploadConfig, uploadPhoto } from './upload'
import { extractStudentReference } from '../lib/photoFileNaming'
import { readQrFromImage } from '../lib/qrReader'
import {
  advanceSequence,
  createSequenceState,
  registerCapturePath,
  sortCaptureFiles,
  type CaptureFile,
  type SequenceState,
} from '../lib/photoSequence'
import type { Photo, Student } from '../../shared/types'
import { createWatchedPhotoStore, processWatchedPhoto } from '../lib/watchedPhotoProcessor'

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

    const watcher = chokidar.watch(project.watchFolder, {
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 1500, pollInterval: 100 },
    })

    const session: WatchSession = {
      watcher,
      pendingFiles: [],
      flushTimer: null,
      processing: Promise.resolve(),
      seenPaths: new Set(),
      sequenceState: createSequenceState(),
    }
    watchers.set(projectId, session)

    watcher.on('add', (filePath) => {
      void enqueuePhoto(projectId, filePath)
    })
    watcher.on('error', (error) => {
      console.error(`[Watcher] Error for project ${projectId}`, error)
    })

    console.log(`[Watcher] Started watching ${project.watchFolder} for project ${projectId}`)
  })

  ipcMain.handle('watcher:stop', async (_e, { projectId }: { projectId: number }) => {
    const session = watchers.get(projectId)
    if (!session) return

    if (session.flushTimer) clearTimeout(session.flushTimer)
    session.pendingFiles = []
    await session.watcher.close()
    watchers.delete(projectId)
    console.log(`[Watcher] Stopped watching for project ${projectId}`)
  })

  ipcMain.handle('watcher:isRunning', (_e, { projectId }: { projectId: number }): boolean => {
    return watchers.has(projectId)
  })
}

async function enqueuePhoto(projectId: number, filePath: string): Promise<void> {
  if (desktopRetiring) return
  const session = watchers.get(projectId)
  if (!session || session.seenPaths.has(filePath)) return

  const lower = filePath.toLowerCase()
  if (!lower.endsWith('.jpg') && !lower.endsWith('.jpeg')) return

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
          await handleNewPhoto(projectId, capture, session)
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
  const win = getMainWindow()
  const qrResult = await readQrFromImage(capture.filePath)

  if (qrResult) {
    const student = db
      .select()
      .from(studentsTable)
      .where(
        and(
          eq(studentsTable.projectId, projectId),
          eq(studentsTable.generatedStudentId, qrResult.studentId),
        ),
      )
      .get()

    const decision = advanceSequence(session.sequenceState, {
      kind: 'marker',
      studentId: student?.id ?? null,
      reference: qrResult.studentId,
    })

    if (decision.kind === 'review') {
      recordUnmatched(db, win, projectId, capture, decision.reason)
      return
    }

    win?.webContents.send('photo:marker', {
      fileName: capture.fileName,
      capturedAt: new Date(capture.capturedAtMs).toISOString(),
      student: toStudentEvent(db, student!),
    })
    console.log(`[Watcher] QR marker ${capture.fileName} → ${student!.firstName} ${student!.lastName}`)
    return
  }

  // Once a QR marker is active, its sequence owns every following portrait.
  // Filename matching remains available only for older Smart Shooter setups
  // that do not use marker images.
  if (session.sequenceState.activeStudentId === null) {
    const knownStudents = db.select().from(studentsTable).where(eq(studentsTable.projectId, projectId)).all()
    const filenameReference = extractStudentReference(
      capture.fileName,
      knownStudents.map((student) => student.generatedStudentId),
    )

    if (filenameReference || looksLikeSmartShooterName(capture.fileName)) {
      const result = await processWatchedPhoto(projectId, capture.filePath, {
        store: createWatchedPhotoStore(db),
        photosDir: getPhotosDir(),
        readQr: async () => null,
      })

      if (result.kind === 'unmatched') {
        win?.webContents.send('photo:unmatched', result)
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

  finishMatchedPhoto(db, win, photo, student)
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

  const { apiUrl, connectionToken } = getUploadConfig()
  if (apiUrl && connectionToken) {
    db.update(photosTable)
      .set({ uploadStatus: 'pending' })
      .where(eq(photosTable.id, photo.id))
      .run()
    win?.webContents.send('upload:statusChanged', {
      photoId: photo.id,
      studentId: student.id,
      status: 'pending',
    })

    uploadPhoto(photo.projectId, student.id, photo.id, photo.filePath, photo.fileName, photo.capturedAt)
      .catch(() => {})
  }
}

function recordUnmatched(
  db: ReturnType<typeof getDb>,
  win: BrowserWindow | null,
  projectId: number,
  capture: CaptureFile,
  reason: string,
): void {
  db.insert(photosTable)
    .values({
      projectId,
      studentId: null,
      filePath: capture.filePath,
      fileName: capture.fileName,
      capturedAt: new Date(capture.capturedAtMs).toISOString(),
      isMatched: false,
    })
    .run()

  win?.webContents.send('photo:unmatched', {
    filePath: capture.filePath,
    fileName: capture.fileName,
    reason,
  })
}
