import { ipcMain, BrowserWindow } from 'electron'
import { uploadPhoto, getUploadConfig } from './upload'
import chokidar, { FSWatcher } from 'chokidar'
import { copyFileSync, mkdirSync } from 'fs'
import { join, basename } from 'path'
import { eq, and } from 'drizzle-orm'
import { getDb, getPhotosDir } from '../db'
import { projectsTable, studentsTable, photosTable } from '../db/schema'
import { readQrFromImage } from '../lib/qrReader'
import type { Photo, Student } from '../../shared/types'

// Active watchers: projectId → FSWatcher
const watchers = new Map<number, FSWatcher>()

function now() {
  return new Date().toISOString()
}

function getMainWindow(): BrowserWindow | null {
  const wins = BrowserWindow.getAllWindows()
  return wins.length > 0 ? wins[0] : null
}

export function registerWatcherHandlers() {
  const db = getDb()

  ipcMain.handle('watcher:start', async (_e, { projectId }: { projectId: number }) => {
    if (watchers.has(projectId)) return // already watching

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

    watcher.on('add', async (filePath) => {
      const lower = filePath.toLowerCase()
      if (!lower.endsWith('.jpg') && !lower.endsWith('.jpeg')) return

      await handleNewPhoto(projectId, filePath)
    })

    watchers.set(projectId, watcher)
    console.log(`[Watcher] Started watching ${project.watchFolder} for project ${projectId}`)
  })

  ipcMain.handle('watcher:stop', async (_e, { projectId }: { projectId: number }) => {
    const w = watchers.get(projectId)
    if (w) {
      await w.close()
      watchers.delete(projectId)
      console.log(`[Watcher] Stopped watching for project ${projectId}`)
    }
  })

  ipcMain.handle('watcher:isRunning', (_e, { projectId }: { projectId: number }): boolean => {
    return watchers.has(projectId)
  })
}

async function handleNewPhoto(projectId: number, filePath: string) {
  const db = getDb()
  const win = getMainWindow()
  const fileName = basename(filePath)

  console.log(`[Watcher] New photo: ${fileName}`)

  // Read QR code from photo
  const qrResult = await readQrFromImage(filePath)

  if (!qrResult) {
    console.log(`[Watcher] No QR found in ${fileName}`)
    // Store as unmatched photo
    db.insert(photosTable)
      .values({
        projectId,
        studentId: null,
        filePath,
        fileName,
        capturedAt: now(),
        isMatched: false,
      })
      .run()

    win?.webContents.send('photo:unmatched', {
      filePath,
      fileName,
      reason: 'No QR code detected',
    })
    return
  }

  // Find student by generatedStudentId scoped to this project
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

  if (!student) {
    console.log(`[Watcher] QR student ID ${qrResult.studentId} not found in project ${projectId}`)
    db.insert(photosTable)
      .values({
        projectId,
        studentId: null,
        filePath,
        fileName,
        capturedAt: now(),
        isMatched: false,
      })
      .run()

    win?.webContents.send('photo:unmatched', {
      filePath,
      fileName,
      reason: `Student ID "${qrResult.studentId}" not found in this project`,
    })
    return
  }

  // Copy photo to app photos directory
  const destDir = join(getPhotosDir(), String(projectId), student.generatedStudentId)
  mkdirSync(destDir, { recursive: true })
  const destPath = join(destDir, fileName)
  copyFileSync(filePath, destPath)

  // Save to DB
  const photo = db
    .insert(photosTable)
    .values({
      projectId,
      studentId: student.id,
      filePath: destPath,
      fileName,
      capturedAt: now(),
      isMatched: true,
    })
    .returning()
    .get()

  console.log(`[Watcher] Matched ${fileName} → ${student.firstName} ${student.lastName}`)

  // Notify renderer
  const studentForEvent: Omit<Student, 'photoCount'> & { photoCount: number } = {
    id: student.id,
    projectId: student.projectId,
    classId: student.classId,
    className: '',
    firstName: student.firstName,
    lastName: student.lastName,
    generatedStudentId: student.generatedStudentId,
    simpleQr: student.simpleQr,
    jsonQr: student.jsonQr,
    photoCount: 1,
    createdAt: student.createdAt,
    updatedAt: student.updatedAt,
  }

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
    student: studentForEvent,
  })

  // Auto-upload if cloud upload is configured
  const { apiUrl, uploadKey } = getUploadConfig()
  if (apiUrl && uploadKey) {
    // Mark as pending first so the UI shows it immediately
    db.update(photosTable)
      .set({ uploadStatus: 'pending' })
      .where(eq(photosTable.id, photo.id))
      .run()

    // Fire-and-forget upload; progress is reflected via uploadStatus in DB
    uploadPhoto(photo.projectId, student.id, photo.id, photo.filePath, photo.fileName, photo.capturedAt)
      .then(() => {
        win?.webContents.send('upload:statusChanged', {
          photoId: photo.id,
          studentId: student.id,
          status: 'done',
        })
      })
      .catch(() => {
        win?.webContents.send('upload:statusChanged', {
          photoId: photo.id,
          studentId: student.id,
          status: 'error',
        })
      })
  }
}
