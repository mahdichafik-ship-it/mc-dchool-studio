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
import {
  capturesTable,
  classesTable,
  imageFilesTable,
  settingsTable,
  photosTable,
  projectsTable,
  studentsTable,
} from '../db/schema'
import { eq, and, or, isNull } from 'drizzle-orm'
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

export function getDesktopApiUrl(): string {
  const smokeTestUrl = process.env.CI === 'true'
    ? process.env.MC_SCHOOL_STUDIO_SMOKE_API_URL?.trim()
    : undefined
  return smokeTestUrl || getSetting('upload_api_url') || DEFAULT_API_URL
}

export function saveConnectionToken(token: string) {
  const value = safeStorage.isEncryptionAvailable()
    ? `safe:${safeStorage.encryptString(token).toString('base64')}`
    : token
  setSetting('desktop_connection_token', value)
  deleteSetting('desktop_retired')
}

export function readConnectionToken(): string | null {
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
  const retired = getSetting('desktop_retired') === '1'
  return {
    apiUrl: getDesktopApiUrl(),
    connectionToken: retired ? null : readConnectionToken(),
  }
}

function notifyUploadStatus(photoId: number, studentId: number, status: UploadStatus) {
  const win = BrowserWindow.getAllWindows()[0]
  win?.webContents.send('upload:statusChanged', { photoId, studentId, status })
}

function notifyCaptureFileStatus(
  captureId: number,
  fileId: number,
  studentId: number,
  fileRole: 'JPEG' | 'RAW',
  status: UploadStatus,
) {
  const win = BrowserWindow.getAllWindows()[0]
  win?.webContents.send('capture:fileUploadStatusChanged', {
    captureId,
    fileId,
    studentId,
    fileRole,
    status,
  })
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

let cloudSyncDisabledForRetirement = false
let cloudSessionVerified = false
const activeUploads = new Set<Promise<void>>()
const activePhotoUploads = new Map<number, Promise<void>>()
const activeCaptureFileUploads = new Map<number, Promise<void>>()
const cloudIdentityRepairs = new Map<string, Promise<void>>()

class RetryableUploadError extends Error {}

type DesktopProjectSummary = {
  id: number
  schoolName: string
}

type DesktopProjectBundle = {
  project: { id: number }
  classes: Array<{ id: number; className: string }>
  students: Array<{ id: number; classId: number; generatedStudentId: string }>
}

export function disableCloudSyncForRetirement(): void {
  cloudSyncDisabledForRetirement = true
  cloudSessionVerified = false
}

export function enableCloudSyncAfterSignIn(): void {
  cloudSyncDisabledForRetirement = false
  cloudSessionVerified = true
}

export function markCloudSessionUnavailable(): void {
  cloudSessionVerified = false
}

export function markCloudSessionVerified(): void {
  if (cloudSyncDisabledForRetirement) return
  cloudSessionVerified = true
}

export function isCloudSessionVerified(): boolean {
  return cloudSessionVerified && !cloudSyncDisabledForRetirement
}

async function repairCloudIdentity(
  projectId: number,
  studentId: number,
  apiUrl: string,
  connectionToken: string,
): Promise<void> {
  const db = getDb()
  const project = db.select().from(projectsTable).where(eq(projectsTable.id, projectId)).get()
  const student = db.select().from(studentsTable).where(eq(studentsTable.id, studentId)).get()
  if (!project || !student) throw new Error('The local project or student no longer exists.')
  if (project.cloudId !== null && student.cloudId !== null) return

  const normalizedName = project.schoolName.trim().toLocaleLowerCase()
  const projectsResponse = await fetch(`${apiUrl.replace(/\/+$/, '')}/api/desktop/projects`, {
    headers: { Authorization: `Bearer ${connectionToken}` },
    signal: AbortSignal.timeout(15000),
  })
  if (!projectsResponse.ok) {
    const text = await projectsResponse.text()
    if (projectsResponse.status === 401) invalidateDesktopCredentials(true)
    if (projectsResponse.status === 429 || projectsResponse.status >= 500) {
      throw new RetryableUploadError(`HTTP ${projectsResponse.status}: ${text}`)
    }
    throw new Error(`Could not refresh project identity (HTTP ${projectsResponse.status}: ${text})`)
  }
  const cloudProjects = await projectsResponse.json() as DesktopProjectSummary[]
  const cloudProject = project.cloudId !== null
    ? cloudProjects.find((candidate) => candidate.id === project.cloudId)
    : (() => {
      const matches = cloudProjects.filter((candidate) =>
        candidate.schoolName.trim().toLocaleLowerCase() === normalizedName)
      if (matches.length > 1) {
        throw new Error(`Several cloud projects match "${project.schoolName}". Sync this project again before uploading.`)
      }
      return matches[0]
    })()
  if (!cloudProject) {
    throw new Error(`The cloud project "${project.schoolName}" is not assigned to this desktop.`)
  }

  const bundleResponse = await fetch(
    `${apiUrl.replace(/\/+$/, '')}/api/desktop/projects/${cloudProject.id}/bundle`,
    {
      headers: { Authorization: `Bearer ${connectionToken}` },
      signal: AbortSignal.timeout(30000),
    },
  )
  if (!bundleResponse.ok) {
    const text = await bundleResponse.text()
    if (bundleResponse.status === 401) invalidateDesktopCredentials(true)
    if (bundleResponse.status === 429 || bundleResponse.status >= 500) {
      throw new RetryableUploadError(`HTTP ${bundleResponse.status}: ${text}`)
    }
    throw new Error(`Could not refresh student identity (HTTP ${bundleResponse.status}: ${text})`)
  }
  const bundle = await bundleResponse.json() as DesktopProjectBundle
  const cloudStudent = bundle.students.find((candidate) =>
    candidate.generatedStudentId.trim().toLocaleLowerCase()
      === student.generatedStudentId.trim().toLocaleLowerCase())
  if (!cloudStudent) {
    throw new Error(`Student "${student.generatedStudentId}" was not found in the cloud project.`)
  }

  db.transaction((tx) => {
    tx.update(projectsTable)
      .set({ cloudId: bundle.project.id })
      .where(eq(projectsTable.id, projectId))
      .run()

    const localClasses = tx
      .select()
      .from(classesTable)
      .where(eq(classesTable.projectId, projectId))
      .all()
    for (const cloudClass of bundle.classes) {
      const localClass = localClasses.find((candidate) =>
        candidate.className.trim().toLocaleLowerCase() === cloudClass.className.trim().toLocaleLowerCase())
      if (localClass) {
        tx.update(classesTable)
          .set({ cloudId: cloudClass.id })
          .where(eq(classesTable.id, localClass.id))
          .run()
      }
    }

    const localStudent = tx
      .select()
      .from(studentsTable)
      .where(eq(studentsTable.id, studentId))
      .get()
    if (localStudent) {
      tx.update(studentsTable)
        .set({ cloudId: cloudStudent.id })
        .where(eq(studentsTable.id, studentId))
        .run()
    }
  })
}

async function ensureCloudIdentity(
  projectId: number,
  studentId: number,
  apiUrl: string,
  connectionToken: string,
): Promise<void> {
  const repairKey = `${projectId}:${studentId}`
  const existing = cloudIdentityRepairs.get(repairKey)
  if (existing) {
    await existing
    return
  }
  const repair = repairCloudIdentity(projectId, studentId, apiUrl, connectionToken)
  cloudIdentityRepairs.set(repairKey, repair)
  try {
    await repair
  } finally {
    cloudIdentityRepairs.delete(repairKey)
  }
}

export function invalidateDesktopCredentials(notifyRenderer = false): void {
  markCloudSessionUnavailable()
  deleteSetting('desktop_connection_token')
  deleteSetting('desktop_cached_member')
  if (notifyRenderer) {
    BrowserWindow.getAllWindows()[0]?.webContents.send('auth:sessionInvalidated', {
      signedIn: false,
      error: 'Your desktop session was signed out or revoked. Sign in again.',
    })
  }
}

export async function waitForActiveUploads(): Promise<void> {
  await Promise.allSettled([...activeUploads])
}

function isRetryableUploadFailure(error: unknown): boolean {
  if (error instanceof RetryableUploadError) return true
  if (!(error instanceof Error)) return false
  return error.name === 'AbortError'
    || error.name === 'TimeoutError'
    || error.name === 'TypeError'
}

async function performUploadPhoto(
  projectId: number,
  studentId: number,
  photoId: number,
  filePath: string,
  fileName: string,
  capturedAt: string,
  captureBatchKey?: string,
): Promise<void> {
  const db = getDb()
  const { apiUrl, connectionToken } = getUploadConfig()

  if (!apiUrl || !connectionToken) {
    throw new Error('Cloud upload is not configured.')
  }

  // Mark as uploading
  db.update(photosTable)
    .set({ uploadStatus: 'uploading', fileUrl: null })
    .where(eq(photosTable.id, photoId))
    .run()
  notifyUploadStatus(photoId, studentId, 'uploading')

  try {
    await ensureCloudIdentity(projectId, studentId, apiUrl, connectionToken)
    const project = db.select().from(projectsTable).where(eq(projectsTable.id, projectId)).get()
    const student = db.select().from(studentsTable).where(eq(studentsTable.id, studentId)).get()
    if (!project?.cloudId || !student?.cloudId) {
      throw new Error('This project needs to be re-synced before its photos can upload.')
    }

    const fileBuffer = readFileSync(filePath)
    const blob = new Blob([fileBuffer], { type: 'image/jpeg' })

    const formData = new FormData()
    formData.append('photo', blob, fileName)
    formData.append('capturedAt', capturedAt)

    const url = `${apiUrl.replace(/\/+$/, '')}/api/projects/${project.cloudId}/students/${student.cloudId}/photos`
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${connectionToken}`,
        'X-MC-Upload-Id': String(photoId),
        ...(captureBatchKey ? { 'X-MC-Capture-Batch': captureBatchKey } : {}),
      },
      body: formData,
      signal: AbortSignal.timeout(30000),
    })

    if (!response.ok) {
      const text = await response.text()
      if (response.status === 401) {
        invalidateDesktopCredentials(true)
      }
      if (response.status === 429 || response.status >= 500) {
        throw new RetryableUploadError(`HTTP ${response.status}: ${text}`)
      }
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
    const retryable = isRetryableUploadFailure(err)
    if (retryable) markCloudSessionUnavailable()
    console.error(`[Upload] Upload ${retryable ? 'waiting for connectivity' : 'failed'}:`, err)
    db.update(photosTable)
      .set({ uploadStatus: retryable ? 'pending' : 'error' })
      .where(eq(photosTable.id, photoId))
      .run()
    notifyUploadStatus(photoId, studentId, retryable ? 'pending' : 'error')
    throw err
  }
}

export function uploadPhoto(
  projectId: number,
  studentId: number,
  photoId: number,
  filePath: string,
  fileName: string,
  capturedAt: string,
  captureBatchKey?: string,
): Promise<void> {
  if (!isCloudSessionVerified()) return Promise.resolve()
  const existing = activePhotoUploads.get(photoId)
  if (existing) return existing

  const task = performUploadPhoto(projectId, studentId, photoId, filePath, fileName, capturedAt, captureBatchKey)
  activePhotoUploads.set(photoId, task)
  activeUploads.add(task)
  void task.finally(() => {
    activeUploads.delete(task)
    activePhotoUploads.delete(photoId)
  }).catch(() => {})
  return task
}

function setCaptureFileStatus(
  captureId: number,
  fileId: number,
  status: UploadStatus,
  fileUrl: string | null | undefined,
): void {
  const db = getDb()
  const file = db.select().from(imageFilesTable).where(eq(imageFilesTable.id, fileId)).get()
  const capture = db.select().from(capturesTable).where(eq(capturesTable.id, captureId)).get()
  if (!file || !capture || file.captureId !== captureId || capture.studentId === null) return

  db.update(imageFilesTable)
    .set({
      uploadStatus: status,
      ...(fileUrl !== undefined ? { fileUrl } : {}),
    })
    .where(eq(imageFilesTable.id, fileId))
    .run()

  if (file.fileRole === 'JPEG' && capture.legacyPhotoId !== null) {
    db.update(photosTable)
      .set({
        uploadStatus: status,
        ...(fileUrl !== undefined ? { fileUrl } : {}),
      })
      .where(eq(photosTable.id, capture.legacyPhotoId))
      .run()
    notifyUploadStatus(capture.legacyPhotoId, capture.studentId, status)
  }
  notifyCaptureFileStatus(captureId, fileId, capture.studentId, file.fileRole, status)
}

async function performUploadCaptureFile(captureId: number, fileId: number, captureBatchKey?: string): Promise<void> {
  const db = getDb()
  const capture = db.select().from(capturesTable).where(eq(capturesTable.id, captureId)).get()
  const file = db.select().from(imageFilesTable).where(eq(imageFilesTable.id, fileId)).get()
  if (!capture) throw new Error(`Capture ${captureId} was not found.`)
  if (!file || file.captureId !== captureId) throw new Error(`Capture file ${fileId} was not found.`)
  if (capture.studentId === null) throw new Error('Capture is not matched to a student.')

  const { apiUrl, connectionToken } = getUploadConfig()
  if (!apiUrl || !connectionToken) throw new Error('Cloud upload is not configured.')

  setCaptureFileStatus(captureId, fileId, 'uploading', null)

  try {
    await ensureCloudIdentity(capture.projectId, capture.studentId, apiUrl, connectionToken)
    const project = db.select().from(projectsTable).where(eq(projectsTable.id, capture.projectId)).get()
    const student = db.select().from(studentsTable).where(eq(studentsTable.id, capture.studentId)).get()
    if (!project?.cloudId || !student?.cloudId) {
      throw new Error('This project needs to be re-synced before its captures can upload.')
    }

    const fileBuffer = readFileSync(file.storedPath)
    const mimeType = file.fileRole === 'JPEG'
      ? 'image/jpeg'
      : 'application/octet-stream'
    const formData = new FormData()
    formData.append('file', new Blob([fileBuffer], { type: mimeType }), file.originalFilename)
    formData.append('captureKey', capture.captureKey)
    formData.append('fileRole', file.fileRole)
    formData.append('fileFormat', file.fileFormat)
    formData.append('baseFilename', capture.baseFilename)
    if (capture.capturedAt) formData.append('capturedAt', capture.capturedAt)
    if (capture.sequence !== null) formData.append('sequence', String(capture.sequence))
    formData.append('favorite', String(capture.favorite))
    formData.append('rejected', String(capture.rejected))
    formData.append('selected', String(capture.selected))

    const url = `${apiUrl.replace(/\/+$/, '')}/api/projects/${project.cloudId}/students/${student.cloudId}/captures`
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${connectionToken}`,
        'X-MC-Upload-Id': String(file.id),
        ...(captureBatchKey ? { 'X-MC-Capture-Batch': captureBatchKey } : {}),
      },
      body: formData,
      signal: AbortSignal.timeout(120_000),
    })

    if (!response.ok) {
      const text = await response.text()
      if (response.status === 401) invalidateDesktopCredentials(true)
      if (response.status === 429 || response.status >= 500) {
        throw new RetryableUploadError(`HTTP ${response.status}: ${text}`)
      }
      throw new Error(`HTTP ${response.status}: ${text}`)
    }

    let serverFileUrl: string | null = null
    try {
      const payload = await response.json() as { file?: { fileUrl?: unknown } }
      if (typeof payload.file?.fileUrl === 'string') serverFileUrl = toServerFileUrl(payload.file.fileUrl)
    } catch {
      console.warn('[Upload] Capture file uploaded but did not return a readable fileUrl')
    }
    setCaptureFileStatus(captureId, fileId, 'done', serverFileUrl)
    console.log(`[Upload] Capture file ${fileId} (${file.fileRole}) uploaded successfully`)
  } catch (error) {
    const retryable = isRetryableUploadFailure(error)
    if (retryable) markCloudSessionUnavailable()
    console.error(`[Upload] Capture file ${retryable ? 'waiting for connectivity' : 'failed'}:`, error)
    setCaptureFileStatus(captureId, fileId, retryable ? 'pending' : 'error', undefined)
    throw error
  }
}

export function uploadCaptureFile(captureId: number, fileId: number, captureBatchKey?: string): Promise<void> {
  if (!isCloudSessionVerified()) return Promise.resolve()
  const existing = activeCaptureFileUploads.get(fileId)
  if (existing) return existing

  const task = performUploadCaptureFile(captureId, fileId, captureBatchKey)
  activeCaptureFileUploads.set(fileId, task)
  activeUploads.add(task)
  void task.finally(() => {
    activeUploads.delete(task)
    activeCaptureFileUploads.delete(fileId)
  }).catch(() => {})
  return task
}

export async function queueCaptureUploads(captureId: number): Promise<void> {
  if (!isCloudSessionVerified()) return
  const db = getDb()
  const files = db
    .select()
    .from(imageFilesTable)
    .where(eq(imageFilesTable.captureId, captureId))
    .all()
    .filter((file) => file.uploadStatus !== 'done')
  await Promise.allSettled(files.map((file) => uploadCaptureFile(captureId, file.id)))
}

export interface ProjectSyncProgress {
  completed: number
  total: number
  failed: number
  error?: string
}

type ProjectSyncJob =
  | { kind: 'capture-file'; captureId: number; fileId: number }
  | {
    kind: 'legacy-photo'
    projectId: number
    studentId: number
    photoId: number
    filePath: string
    fileName: string
    capturedAt: string
  }

function getProjectSyncJobs(projectId: number): ProjectSyncJob[] {
  const db = getDb()
  const captures = db
    .select()
    .from(capturesTable)
    .where(eq(capturesTable.projectId, projectId))
    .all()
  const jobs: ProjectSyncJob[] = []
  const mirroredPhotoIds = new Set<number>()

  for (const capture of captures) {
    if (capture.legacyPhotoId !== null) mirroredPhotoIds.add(capture.legacyPhotoId)
    if (capture.studentId === null) continue
    const files = db
      .select()
      .from(imageFilesTable)
      .where(eq(imageFilesTable.captureId, capture.id))
      .all()
    for (const file of files) {
      if (file.uploadStatus !== 'done') {
        jobs.push({ kind: 'capture-file', captureId: capture.id, fileId: file.id })
      }
    }
  }

  const legacyPhotos = db
    .select()
    .from(photosTable)
    .where(eq(photosTable.projectId, projectId))
    .all()
  for (const photo of legacyPhotos) {
    if (
      !photo.isMatched
      || photo.studentId === null
      || mirroredPhotoIds.has(photo.id)
      || photo.uploadStatus === 'done'
    ) continue
    jobs.push({
      kind: 'legacy-photo',
      projectId,
      studentId: photo.studentId,
      photoId: photo.id,
      filePath: photo.filePath,
      fileName: photo.fileName,
      capturedAt: photo.capturedAt,
    })
  }

  return jobs
}

/**
 * Upload a complete local project only when explicitly requested by the
 * photographer. This deliberately runs sequentially so progress is
 * deterministic and an offline transition cannot silently count skipped work
 * as complete.
 */
export async function syncProjectUploads(
  projectId: number,
  onProgress?: (progress: ProjectSyncProgress) => void,
  captureBatchKey?: string,
): Promise<ProjectSyncProgress> {
  const jobs = getProjectSyncJobs(projectId)
  let completed = 0
  let failed = 0
  let firstError: string | undefined
  const report = () => onProgress?.({ completed, total: jobs.length, failed, error: firstError })
  report()

  for (const job of jobs) {
    try {
      if (!isCloudSessionVerified()) {
        throw new Error('Cloud sync is unavailable. Local captures are safe; reconnect and try again.')
      }
      if (job.kind === 'capture-file') {
        await uploadCaptureFile(job.captureId, job.fileId, captureBatchKey)
      } else {
        await uploadPhoto(
          job.projectId,
          job.studentId,
          job.photoId,
          job.filePath,
          job.fileName,
          job.capturedAt,
          captureBatchKey,
        )
      }
    } catch (error) {
      failed++
      firstError ??= String(error)
    } finally {
      completed++
      report()
    }
  }

  return { completed, total: jobs.length, failed, error: firstError }
}

export function getProjectSyncJobCount(projectId: number): number {
  return getProjectSyncJobs(projectId).length
}

export async function beginProjectCaptureBatch(projectId: number, expectedFileCount: number): Promise<string> {
  const db = getDb()
  const project = db.select().from(projectsTable).where(eq(projectsTable.id, projectId)).get()
  if (!project?.cloudId) throw new Error('This project needs to be re-synced before its batch can upload.')
  const settingKey = `capture_batch:${projectId}`
  const batchKey = getSetting(settingKey) ?? crypto.randomUUID()
  setSetting(settingKey, batchKey)
  const { apiUrl, connectionToken } = getUploadConfig()
  if (!apiUrl || !connectionToken) throw new Error('Cloud upload is not configured.')
  const response = await fetch(`${apiUrl.replace(/\/+$/, '')}/api/desktop/projects/${project.cloudId}/capture-batches`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${connectionToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ batchKey, expectedFileCount }),
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) throw new Error(`Could not start capture batch: HTTP ${response.status}: ${await response.text()}`)
  return batchKey
}

export async function finishProjectCaptureBatch(
  projectId: number,
  batchKey: string,
  status: 'failed' | 'complete',
  failedFileCount: number,
): Promise<void> {
  const db = getDb()
  const project = db.select().from(projectsTable).where(eq(projectsTable.id, projectId)).get()
  const { apiUrl, connectionToken } = getUploadConfig()
  if (!project?.cloudId || !apiUrl || !connectionToken) throw new Error('Cloud upload is not configured.')
  const response = await fetch(`${apiUrl.replace(/\/+$/, '')}/api/desktop/projects/${project.cloudId}/capture-batches/${encodeURIComponent(batchKey)}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${connectionToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ status, failedFileCount }),
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) throw new Error(`Could not update capture batch: HTTP ${response.status}: ${await response.text()}`)
}

// ─────────────────────────────────────────────────────────────────────────────
// IPC handlers
// ─────────────────────────────────────────────────────────────────────────────

export function registerUploadHandlers() {
  // Test connection to API
  ipcMain.handle('upload:testConnection', async () => {
    const { apiUrl, connectionToken } = getUploadConfig()
    if (!apiUrl || !connectionToken) {
      return { ok: false, error: 'Sign in to Volume Capture before testing the connection' }
    }
    try {
      const url = `${apiUrl.replace(/\/+$/, '')}/api/desktop/me`
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${connectionToken}` },
        signal: AbortSignal.timeout(5000),
      })
      if (response.ok) {
        markCloudSessionVerified()
        return { ok: true }
      }
      if (response.status === 401) invalidateDesktopCredentials(true)
      else if (response.status >= 500) markCloudSessionUnavailable()
      const body = await response.json().catch(() => ({})) as { error?: string }
      return { ok: false, error: body.error ?? `Server returned ${response.status}` }
    } catch (err) {
      markCloudSessionUnavailable()
      return { ok: false, error: String(err) }
    }
  })

  // Manual retry for a failed photo upload
  ipcMain.handle('upload:retry', async (_e, { photoId }: { photoId: number }) => {
    const db = getDb()
    const photo = db.select().from(photosTable).where(eq(photosTable.id, photoId)).get()
    if (!photo || !photo.studentId) return { ok: false, error: 'Photo not found or not matched' }
    if (!isCloudSessionVerified()) {
      return { ok: false, error: 'Upload is waiting for an internet connection and a verified studio session.' }
    }
    try {
      const capture = db
        .select()
        .from(capturesTable)
        .where(eq(capturesTable.legacyPhotoId, photoId))
        .get()
      const jpegFile = capture
        ? db
          .select()
          .from(imageFilesTable)
          .where(and(eq(imageFilesTable.captureId, capture.id), eq(imageFilesTable.fileRole, 'JPEG')))
          .get()
        : undefined
      if (capture && jpegFile) {
        await uploadCaptureFile(capture.id, jpegFile.id)
        return { ok: true }
      }
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

  ipcMain.handle('upload:retryFile', async (_e, { fileId }: { fileId: number }) => {
    const db = getDb()
    const file = db.select().from(imageFilesTable).where(eq(imageFilesTable.id, fileId)).get()
    if (!file) return { ok: false, error: 'Capture file not found' }
    const capture = db.select().from(capturesTable).where(eq(capturesTable.id, file.captureId)).get()
    if (!capture?.studentId) return { ok: false, error: 'Capture is not matched to a student' }
    if (!isCloudSessionVerified()) {
      return { ok: false, error: 'Upload is waiting for an internet connection and a verified studio session.' }
    }
    try {
      await uploadCaptureFile(capture.id, file.id)
      return { ok: true }
    } catch (error) {
      return { ok: false, error: String(error) }
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
    const captureFiles = db
      .select({ id: imageFilesTable.id })
      .from(imageFilesTable)
      .where(eq(imageFilesTable.uploadStatus, 'error'))
      .all()
    const mirroredPhotoIds = new Set(
      db
        .select({ photoId: capturesTable.legacyPhotoId })
        .from(capturesTable)
        .all()
        .map((row) => row.photoId)
        .filter((photoId): photoId is number => photoId !== null),
    )
    return photos.filter((photo) => !mirroredPhotoIds.has(photo.id)).length + captureFiles.length
  })
}
