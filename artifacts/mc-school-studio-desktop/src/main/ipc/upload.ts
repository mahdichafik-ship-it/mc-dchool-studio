/**
 * Cloud upload IPC handlers.
 *
 * Settings are stored in the SQLite settings table (key/value pairs).
 * On a photo match (called from watcher.ts) the matched photo is
 * automatically queued and uploaded to the configured API endpoint.
 */

import { BrowserWindow, ipcMain, safeStorage } from 'electron'
import { readFileSync } from 'fs'
import { getDb } from '../db'
import { settingsTable, photosTable } from '../db/schema'
import { eq, and } from 'drizzle-orm'
import type { UploadStatus } from '../../shared/types'

// ─────────────────────────────────────────────────────────────────────────────
// Settings helpers
// ─────────────────────────────────────────────────────────────────────────────

export function getSetting(key: string): string | null {
  const db = getDb()
  const row = db.select().from(settingsTable).where(eq(settingsTable.key, key)).get()
  return row?.value ?? null
}

export function setSetting(key: string, value: string) {
  const db = getDb()
  // upsert
  const existing = db.select().from(settingsTable).where(eq(settingsTable.key, key)).get()
  if (existing) {
    db.update(settingsTable).set({ value }).where(eq(settingsTable.key, key)).run()
  } else {
    db.insert(settingsTable).values({ key, value }).run()
  }
}

export function deleteSetting(key: string) {
  getDb().delete(settingsTable).where(eq(settingsTable.key, key)).run()
}

export const DEFAULT_API_URL = 'https://volumecapture.net'

export function saveConnectionToken(token: string) {
  const value = safeStorage.isEncryptionAvailable()
    ? `safe:${safeStorage.encryptString(token).toString('base64')}`
    : token
  setSetting('desktop_connection_token', value)
}

function readConnectionToken(): string | null {
  const stored = getSetting('desktop_connection_token')
  if (!stored) return null
  if (!stored.startsWith('safe:')) return stored
  try {
    return safeStorage.decryptString(Buffer.from(stored.slice(5), 'base64'))
  } catch {
    return null
  }
}

export function getUploadConfig(): { apiUrl: string | null; connectionToken: string | null } {
  return {
    apiUrl: getSetting('upload_api_url') ?? DEFAULT_API_URL,
    connectionToken: readConnectionToken(),
  }
}

function notifyUploadStatus(photoId: number, studentId: number, status: UploadStatus) {
  const win = BrowserWindow.getAllWindows()[0]
  win?.webContents.send('upload:statusChanged', { photoId, studentId, status })
}

function toServerFileUrl(fileUrl: string | null): string | null {
  if (!fileUrl) return null
  if (/^https?:\/\//i.test(fileUrl)) return fileUrl

  const { apiUrl } = getUploadConfig()
  if (!apiUrl) return null
  return `${apiUrl.replace(/\/+$/, '')}/${fileUrl.replace(/^\/+/, '')}`
}

// ─────────────────────────────────────────────────────────────────────────────
// Upload a single photo to the cloud API
// ─────────────────────────────────────────────────────────────────────────────

export async function uploadPhoto(
  projectId: number,
  studentId: number,
  photoId: number,
  filePath: string,
  fileName: string,
  capturedAt: string,
): Promise<void> {
  const db = getDb()
  const { apiUrl, connectionToken } = getUploadConfig()

  if (!apiUrl || !connectionToken) {
    console.log('[Upload] Cloud upload not configured, skipping.')
    return
  }

  // Mark as uploading
  db.update(photosTable)
    .set({ uploadStatus: 'uploading', fileUrl: null })
    .where(eq(photosTable.id, photoId))
    .run()
  notifyUploadStatus(photoId, studentId, 'uploading')

  try {
    const fileBuffer = readFileSync(filePath)
    const blob = new Blob([fileBuffer], { type: 'image/jpeg' })

    const formData = new FormData()
    formData.append('photo', blob, fileName)
    formData.append('capturedAt', capturedAt)

    const url = `${apiUrl.replace(/\/+$/, '')}/api/projects/${projectId}/students/${studentId}/photos`
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${connectionToken}`,
      },
      body: formData,
    })

    if (!response.ok) {
      const text = await response.text()
      throw new Error(`HTTP ${response.status}: ${text}`)
    }

    // Keep the server URL so the desktop app can link directly to the uploaded file.
    let fileUrl: string | null = null
    try {
      const payload = await response.json() as { fileUrl?: unknown }
      if (typeof payload.fileUrl === 'string') fileUrl = payload.fileUrl
    } catch {
      // A successful upload is still complete if the server response is not JSON.
      console.warn('[Upload] Upload succeeded but did not return a readable fileUrl')
    }

    // Mark as done
    db.update(photosTable)
      .set({ uploadStatus: 'done', fileUrl })
      .where(eq(photosTable.id, photoId))
      .run()
    notifyUploadStatus(photoId, studentId, 'done')

    console.log(`[Upload] Photo ${photoId} uploaded successfully`)
  } catch (err) {
    console.error('[Upload] Upload failed:', err)
    db.update(photosTable)
      .set({ uploadStatus: 'error' })
      .where(eq(photosTable.id, photoId))
      .run()
    notifyUploadStatus(photoId, studentId, 'error')
    throw err
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// IPC handlers
// ─────────────────────────────────────────────────────────────────────────────

export function registerUploadHandlers() {
  // Test connection to API
  ipcMain.handle('upload:testConnection', async () => {
    const { apiUrl, connectionToken } = getUploadConfig()
    if (!apiUrl || !connectionToken) {
      return { ok: false, error: 'Sign in to MC School Studio before testing the connection' }
    }
    try {
      const url = `${apiUrl.replace(/\/+$/, '')}/api/desktop/me`
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${connectionToken}` },
        signal: AbortSignal.timeout(5000),
      })
      if (response.ok) {
        return { ok: true }
      }
      const body = await response.json().catch(() => ({})) as { error?: string }
      return { ok: false, error: body.error ?? `Server returned ${response.status}` }
    } catch (err) {
      return { ok: false, error: String(err) }
    }
  })

  // Manual retry for a failed photo upload
  ipcMain.handle('upload:retry', async (_e, { photoId }: { photoId: number }) => {
    const db = getDb()
    const photo = db.select().from(photosTable).where(eq(photosTable.id, photoId)).get()
    if (!photo || !photo.studentId) return { ok: false, error: 'Photo not found or not matched' }
    try {
      await uploadPhoto(
        photo.projectId,
        photo.studentId,
        photo.id,
        photo.filePath,
        photo.fileName,
        photo.capturedAt,
      )
      return { ok: true }
    } catch (err) {
      return { ok: false, error: String(err) }
    }
  })

  // Get upload status and server URLs for all matched photos in a project.
  ipcMain.handle(
    'upload:getProjectStatus',
    (_e, { projectId }: { projectId: number }) => {
      const db = getDb()
      const photos = db
        .select({
          id: photosTable.id,
          studentId: photosTable.studentId,
          uploadStatus: photosTable.uploadStatus,
          fileUrl: photosTable.fileUrl,
        })
        .from(photosTable)
        .where(and(eq(photosTable.projectId, projectId), eq(photosTable.isMatched, true)))
        .all()
      return photos.map((photo) => ({
        ...photo,
        fileUrl: toServerFileUrl(photo.fileUrl),
      }))
    },
  )

  // Count failed uploads across all projects (for Settings screen)
  ipcMain.handle('upload:getGlobalErrorCount', () => {
    const db = getDb()
    const photos = db
      .select({ id: photosTable.id })
      .from(photosTable)
      .where(eq(photosTable.uploadStatus, 'error'))
      .all()
    return photos.length
  })
}
