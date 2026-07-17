import { ipcMain, shell, BrowserWindow } from 'electron'
import { copyFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { eq, count } from 'drizzle-orm'
import { getDb, getPhotosDir } from '../db'
import { photosTable, studentsTable } from '../db/schema'
import { generateThumbnail } from '../lib/qrReader'
import type { Photo } from '../../shared/types'

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

      // Notify renderer so sidebar counts update immediately
      const win = getMainWindow()
      win?.webContents.send('photo:reassigned', {
        photoId,
        projectId: photo.projectId,
        fromStudentId: photo.studentId,
        toStudentId: studentId,
      })
    },
  )

  ipcMain.handle('photos:delete', async (_e, { photoId }: { photoId: number }) => {
    // Fetch before deleting so we can include projectId in the event
    const [photo] = db.select().from(photosTable).where(eq(photosTable.id, photoId)).all()
    db.delete(photosTable).where(eq(photosTable.id, photoId)).run()

    // Notify renderer so sidebar counts update immediately
    if (photo) {
      const win = getMainWindow()
      win?.webContents.send('photo:deleted', {
        photoId,
        projectId: photo.projectId,
        studentId: photo.studentId,
      })
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
