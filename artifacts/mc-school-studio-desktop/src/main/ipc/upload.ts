/**
 * Cloud upload IPC handlers.
 *
 * Settings are stored in the SQLite settings table (key/value pairs).
 * On a photo match (called from watcher.ts) the matched photo is
 * automatically queued and uploaded to the configured API endpoint.
 */

import { ipcMain } from 'electron'
import { readFileSync } from 'fs'
import { getDb } from '../db'
import { settingsTable, photosTable } from '../db/schema'
import { eq, and } from 'drizzle-orm'

// ─────────────────────────────────────────────────────────────────────────────
// Settings helpers
// ─────────────────────────────────────────────────────────────────────────────

function getSetting(key: string): string | null {
  const db = getDb()
  const row = db.select().from(settingsTable).where(eq(settingsTable.key, key)).get()
  return row?.value ?? null
}

function setSetting(key: string, value: string) {
  const db = getDb()
  // upsert
  const existing = db.select().from(settingsTable).where(eq(settingsTable.key, key)).get()
  if (existing) {
    db.update(settingsTable).set({ value }).where(eq(settingsTable.key, key)).run()
  } else {
    db.insert(settingsTable).values({ key, value }).run()
  }
}

export function getUploadConfig(): { apiUrl: string | null; uploadKey: string | null } {
  return {
    apiUrl: getSetting('upload_api_url'),
    uploadKey: getSetting('upload_key'),
  }
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
  const { apiUrl, uploadKey } = getUploadConfig()

  if (!apiUrl || !uploadKey) {
    console.log('[Upload] Cloud upload not configured, skipping.')
    return
  }

  // Mark as uploading
  db.update(photosTable)
    .set({ uploadStatus: 'uploading' })
    .where(eq(photosTable.id, photoId))
    .run()

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
        Authorization: `Bearer ${uploadKey}`,
      },
      body: formData,
    })

    if (!response.ok) {
      const text = await response.text()
      throw new Error(`HTTP ${response.status}: ${text}`)
    }

    // Mark as done
    db.update(photosTable)
      .set({ uploadStatus: 'done' })
      .where(eq(photosTable.id, photoId))
      .run()

    console.log(`[Upload] Photo ${photoId} uploaded successfully`)
  } catch (err) {
    console.error('[Upload] Upload failed:', err)
    db.update(photosTable)
      .set({ uploadStatus: 'error' })
      .where(eq(photosTable.id, photoId))
      .run()
    throw err
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// IPC handlers
// ─────────────────────────────────────────────────────────────────────────────

export function registerUploadHandlers() {
  // Get current cloud upload configuration
  ipcMain.handle('upload:getConfig', () => {
    return getUploadConfig()
  })

  // Save cloud upload configuration
  ipcMain.handle(
    'upload:setConfig',
    (_e, { apiUrl, uploadKey }: { apiUrl: string; uploadKey: string }) => {
      setSetting('upload_api_url', apiUrl.trim())
      setSetting('upload_key', uploadKey.trim())
      return { ok: true }
    },
  )

  // Test connection to API
  ipcMain.handle('upload:testConnection', async () => {
    const { apiUrl, uploadKey } = getUploadConfig()
    if (!apiUrl || !uploadKey) {
      return { ok: false, error: 'API URL and upload key are required' }
    }
    try {
      const url = `${apiUrl.replace(/\/+$/, '')}/api/healthz`
      const response = await fetch(url, { signal: AbortSignal.timeout(5000) })
      if (response.ok) {
        return { ok: true }
      }
      return { ok: false, error: `Server returned ${response.status}` }
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

  // Get upload status for all photos in a project (for sidebar progress)
  ipcMain.handle(
    'upload:getProjectStatus',
    (_e, { projectId }: { projectId: number }) => {
      const db = getDb()
      const photos = db
        .select({
          id: photosTable.id,
          studentId: photosTable.studentId,
          uploadStatus: photosTable.uploadStatus,
        })
        .from(photosTable)
        .where(and(eq(photosTable.projectId, projectId), eq(photosTable.isMatched, true)))
        .all()
      return photos
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
