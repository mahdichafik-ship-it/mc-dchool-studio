/**
 * Cloud upload IPC handlers.
 *
 * Settings are stored in the SQLite settings table (key/value pairs).
 * On a photo match (called from watcher.ts) the matched photo is
 * automatically queued and uploaded to the configured API endpoint.
 */

import { BrowserWindow, ipcMain, safeStorage } from 'electron'
import { readFileSync } from 'fs'
import { basename } from 'node:path'
import { getDb } from '../db'
import {
  capturesTable,
  classesTable,
  imageFilesTable,
  settingsTable,
  photosTable,
  projectsTable,
  studentsTable,
  groupCapturesTable,
  groupCaptureFilesTable,
  groupsTable,
  groupMembersTable,
} from '../db/schema'
import { normalizeProjectType } from '../../shared/types'
import { eq, and, or, isNull } from 'drizzle-orm'
import type { LiveUploadState, UploadStatus } from '../../shared/types'
import { assertCaptureBatchComplete } from '../lib/captureBatch'

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
  project: { id: number; projectType?: unknown }
  classes: Array<{ id: number; className: string }>
  students: Array<{
    id: number
    classId: number
    generatedStudentId: string
    simpleQr?: string | null
    jsonQr?: string | null
  }>
}

export function disableCloudSyncForRetirement(): void {
  cloudSyncDisabledForRetirement = true
  cloudSessionVerified = false
}

export function enableCloudSyncAfterSignIn(): void {
  cloudSyncDisabledForRetirement = false
  cloudSessionVerified = true
  kickEnabledLiveUploads()
}

export function markCloudSessionUnavailable(): void {
  cloudSessionVerified = false
}

export function markCloudSessionVerified(): void {
  if (cloudSyncDisabledForRetirement) return
  cloudSessionVerified = true
  kickEnabledLiveUploads()
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
  let cloudStudent = bundle.students.find((candidate) =>
    candidate.generatedStudentId.trim().toLocaleLowerCase()
      === student.generatedStudentId.trim().toLocaleLowerCase())
  if (!cloudStudent) {
    const localClass = db.select().from(classesTable).where(eq(classesTable.id, student.classId)).get()
    const cloudClass = bundle.classes.find((candidate) =>
      candidate.id === localClass?.cloudId
      || candidate.className.trim().toLocaleLowerCase()
        === localClass?.className.trim().toLocaleLowerCase())
    if (!localClass || !cloudClass) {
      throw new Error(`The class for student "${student.generatedStudentId}" was not found in the cloud project.`)
    }

    const createResponse = await fetch(
      `${apiUrl.replace(/\/+$/, '')}/api/desktop/projects/${cloudProject.id}/students`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${connectionToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          classId: cloudClass.id,
          firstName: student.firstName,
          lastName: student.lastName,
          generatedStudentId: student.generatedStudentId,
        }),
        signal: AbortSignal.timeout(30000),
      },
    )
    if (!createResponse.ok) {
      const text = await createResponse.text()
      if (createResponse.status === 401) invalidateDesktopCredentials(true)
      if (createResponse.status === 429 || createResponse.status >= 500) {
        throw new RetryableUploadError(`HTTP ${createResponse.status}: ${text}`)
      }
      throw new Error(`Could not add the student to the cloud project (HTTP ${createResponse.status}: ${text})`)
    }
    cloudStudent = await createResponse.json() as DesktopProjectBundle['students'][number]
  }

  db.transaction((tx) => {
    tx.update(projectsTable)
      .set({ cloudId: bundle.project.id, projectType: normalizeProjectType(bundle.project.projectType) })
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
        .set({
          cloudId: cloudStudent.id,
          simpleQr: cloudStudent.simpleQr ?? localStudent.simpleQr,
          jsonQr: cloudStudent.jsonQr ?? localStudent.jsonQr,
          updatedAt: new Date().toISOString(),
        })
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

export async function syncStudentCloudIdentity(
  projectId: number,
  studentId: number,
): Promise<{ synced: boolean; error?: string }> {
  const { apiUrl, connectionToken } = getUploadConfig()
  if (!apiUrl || !connectionToken || !isCloudSessionVerified()) {
    return { synced: false }
  }
  try {
    await ensureCloudIdentity(projectId, studentId, apiUrl, connectionToken)
    return { synced: true }
  } catch (error) {
    return { synced: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** Reconcile local group identity and membership before any group upload. */
export async function syncGroupCloudIdentities(projectId: number): Promise<void> {
  const db = getDb()
  const project = db.select().from(projectsTable).where(eq(projectsTable.id, projectId)).get()
  const { apiUrl, connectionToken } = getUploadConfig()
  if (!project?.cloudId || !apiUrl || !connectionToken || !isCloudSessionVerified()) {
    throw new Error('Cloud upload is not configured or this project has not been synced.')
  }
  const groups = db.select().from(groupsTable).where(eq(groupsTable.projectId, projectId)).all()
  const bundleResponse = await fetch(`${apiUrl.replace(/\/+$/, '')}/api/desktop/projects/${project.cloudId}/bundle`, {
    headers: { Authorization: `Bearer ${connectionToken}` }, signal: AbortSignal.timeout(30_000),
  })
  if (!bundleResponse.ok) throw new Error(`Could not refresh cloud group identities (HTTP ${bundleResponse.status}: ${await bundleResponse.text()})`)
  const bundle = await bundleResponse.json() as {
    groups?: Array<{ id: number; classId?: number | null; isDefaultClassGroup?: boolean; name: string }>
  }
  for (const group of groups) {
    const members = db.select().from(groupMembersTable).where(eq(groupMembersTable.groupId, group.id)).all()
    for (const member of members) {
      const result = await syncStudentCloudIdentity(projectId, member.studentId)
      if (!result.synced) throw new Error(result.error ?? 'Could not synchronize a group member.')
    }
    const refreshedProject = db.select().from(projectsTable).where(eq(projectsTable.id, projectId)).get()
    const refreshedGroup = db.select().from(groupsTable).where(eq(groupsTable.id, group.id)).get()
    const cls = refreshedGroup?.classId == null ? null
      : db.select().from(classesTable).where(eq(classesTable.id, refreshedGroup.classId)).get()
    const refreshedMembers = db.select().from(groupMembersTable).where(eq(groupMembersTable.groupId, group.id)).all()
    const students = refreshedMembers.map((member) => db.select().from(studentsTable).where(eq(studentsTable.id, member.studentId)).get())
    const memberStudentIds = students.map((student) => student?.cloudId).filter((id): id is number => id !== null && id !== undefined)
    if (memberStudentIds.length !== students.length) throw new Error(`Group "${group.name}" has a member without a cloud identity.`)
    let cloudGroupId = refreshedGroup?.cloudId ?? null
    if (cloudGroupId == null && refreshedGroup?.isDefaultClassGroup) {
      cloudGroupId = bundle.groups?.find((candidate) =>
        candidate.isDefaultClassGroup
        && (candidate.classId == null || candidate.classId === cls?.cloudId)
        && candidate.name.trim().toLocaleLowerCase() === refreshedGroup.name.trim().toLocaleLowerCase())?.id ?? null
      if (cloudGroupId != null) {
        db.update(groupsTable).set({ cloudId: cloudGroupId }).where(eq(groupsTable.id, group.id)).run()
      }
    }
    const dirty = Boolean(refreshedGroup?.membershipDirty)
    // A pull owns clean cloud-backed groups. Avoid echoing stale local values
    // back over newer cloud edits. Clean local defaults also wait for a cloud
    // identity rather than creating an unintended custom group.
    if (!dirty) continue
    const body = refreshedGroup?.isDefaultClassGroup
      ? { memberStudentIds }
      : {
        name: refreshedGroup?.name ?? group.name,
        classId: cls?.cloudId ?? null,
        memberStudentIds,
      }
    let response: Response
    if (cloudGroupId != null) {
      response = await fetch(`${apiUrl.replace(/\/+$/, '')}/api/desktop/projects/${refreshedProject?.cloudId}/groups/${cloudGroupId}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${connectionToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      })
    } else {
      response = await fetch(`${apiUrl.replace(/\/+$/, '')}/api/desktop/projects/${refreshedProject?.cloudId}/groups`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${connectionToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientGroupId: `desktop-${projectId}-${group.id}`,
          ...body,
        }),
        signal: AbortSignal.timeout(30_000),
      })
    }
    if (!response.ok) {
      if (response.status === 401) invalidateDesktopCredentials(true)
      throw new Error(`Could not synchronize group "${group.name}" (HTTP ${response.status}: ${await response.text()})`)
    }
    const payload = await response.json().catch(() => ({})) as { id?: number; groupId?: number; cloudId?: number }
    const cloudId = payload.id ?? payload.groupId ?? payload.cloudId
    if (cloudGroupId == null && Number.isInteger(cloudId)) {
      db.update(groupsTable).set({ cloudId, updatedAt: new Date().toISOString() })
        .where(eq(groupsTable.id, group.id)).run()
    }
    // A successful explicit Upload & Finish commits the local group edits.
    // Keep this persisted so a restart cannot re-submit an already committed
    // membership as a pending local override.
    db.update(groupsTable)
      .set({ membershipDirty: false, updatedAt: new Date().toISOString() })
      .where(eq(groupsTable.id, group.id))
      .run()
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
    formData.append('rating', String(capture.rating))
    formData.append('colorLabel', capture.colorLabel)

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

async function performUploadGroupCaptureFile(captureId: number, fileId: number, captureBatchKey?: string): Promise<void> {
  const db = getDb()
  const capture = db.select().from(groupCapturesTable).where(eq(groupCapturesTable.id, captureId)).get()
  const file = db.select().from(groupCaptureFilesTable).where(eq(groupCaptureFilesTable.id, fileId)).get()
  if (!capture || !file || file.captureId !== captureId) throw new Error('Group capture file was not found.')
  const group = db.select().from(groupsTable).where(eq(groupsTable.id, capture.groupId)).get()
  const project = db.select().from(projectsTable).where(eq(projectsTable.id, capture.projectId)).get()
  const { apiUrl, connectionToken } = getUploadConfig()
  if (!group?.cloudId || !project?.cloudId || !apiUrl || !connectionToken) {
    throw new Error('This group needs to be re-synced before its captures can upload.')
  }
  db.update(groupCaptureFilesTable).set({ uploadStatus: 'uploading' }).where(eq(groupCaptureFilesTable.id, fileId)).run()
  try {
    const formData = new FormData()
    const managedFilename = basename(file.storedPath)
    formData.append('file', new Blob([readFileSync(file.storedPath)], {
      type: file.fileRole === 'JPEG' ? 'image/jpeg' : 'application/octet-stream',
    }), managedFilename)
    formData.append('captureKey', capture.captureKey)
    formData.append('baseFilename', capture.baseFilename)
    formData.append('capturedAt', capture.capturedAt)
    const response = await fetch(`${apiUrl.replace(/\/+$/, '')}/api/desktop/projects/${project.cloudId}/groups/${group.cloudId}/captures`, {
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
      if (response.status === 429 || response.status >= 500) throw new RetryableUploadError(`HTTP ${response.status}: ${text}`)
      throw new Error(`HTTP ${response.status}: ${text}`)
    }
    const payload = await response.json().catch(() => ({})) as { file?: { fileUrl?: unknown } }
    db.update(groupCaptureFilesTable).set({
      uploadStatus: 'done',
      fileUrl: typeof payload.file?.fileUrl === 'string' ? toServerFileUrl(payload.file.fileUrl) : null,
    }).where(eq(groupCaptureFilesTable.id, fileId)).run()
  } catch (error) {
    const retryable = isRetryableUploadFailure(error)
    if (retryable) markCloudSessionUnavailable()
    db.update(groupCaptureFilesTable).set({ uploadStatus: retryable ? 'pending' : 'error' })
      .where(eq(groupCaptureFilesTable.id, fileId)).run()
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

export async function syncCaptureReview(captureId: number): Promise<void> {
  if (!isCloudSessionVerified()) return
  const db = getDb()
  const capture = db.select().from(capturesTable).where(eq(capturesTable.id, captureId)).get()
  if (!capture?.studentId) return
  const project = db.select().from(projectsTable).where(eq(projectsTable.id, capture.projectId)).get()
  const student = db.select().from(studentsTable).where(eq(studentsTable.id, capture.studentId)).get()
  const { apiUrl, connectionToken } = getUploadConfig()
  if (!project?.cloudId || !student?.cloudId || !apiUrl || !connectionToken) return
  try {
    const response = await fetch(
      `${apiUrl.replace(/\/+$/, '')}/api/projects/${project.cloudId}/students/${student.cloudId}/captures/${encodeURIComponent(capture.captureKey)}/review`,
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${connectionToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          favorite: capture.favorite,
          rejected: capture.rejected,
          selected: capture.selected,
          rating: capture.rating,
          colorLabel: capture.colorLabel,
        }),
        signal: AbortSignal.timeout(10_000),
      },
    )
    if (response.status === 401) {
      invalidateDesktopCredentials(true)
      return
    }
    if (response.ok) {
      db.update(capturesTable)
        .set({ reviewSyncPending: false, updatedAt: new Date().toISOString() })
        .where(eq(capturesTable.id, captureId))
        .run()
      return
    }
    if (!response.ok && response.status !== 404) {
      console.warn(`[Review] Cloud review sync failed with HTTP ${response.status}`)
    }
  } catch (error) {
    console.warn('[Review] Cloud review sync deferred:', error)
  }
}

async function syncPendingCaptureReviews(projectId?: number): Promise<void> {
  if (!isCloudSessionVerified()) return
  const db = getDb()
  const captures = db
    .select({ id: capturesTable.id })
    .from(capturesTable)
    .where(projectId === undefined
      ? eq(capturesTable.reviewSyncPending, true)
      : and(eq(capturesTable.reviewSyncPending, true), eq(capturesTable.projectId, projectId)))
    .all()
  for (const capture of captures) {
    if (!isCloudSessionVerified()) return
    await syncCaptureReview(capture.id)
  }
}

function uploadGroupCaptureFile(captureId: number, fileId: number, captureBatchKey?: string): Promise<void> {
  if (!isCloudSessionVerified()) return Promise.resolve()
  const task = performUploadGroupCaptureFile(captureId, fileId, captureBatchKey)
  activeUploads.add(task)
  void task.finally(() => activeUploads.delete(task)).catch(() => {})
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
  | { kind: 'group-capture-file'; captureId: number; fileId: number }

function getProjectSyncJobs(projectId: number): ProjectSyncJob[] {
  const db = getDb()
  const captures = db
    .select()
    .from(capturesTable)
    .where(eq(capturesTable.projectId, projectId))
    .all()
  const jobs: ProjectSyncJob[] = []
  const mirroredPhotoIds = new Set<number>()
  const groupCaptures = db.select().from(groupCapturesTable).where(eq(groupCapturesTable.projectId, projectId)).all()
  for (const capture of groupCaptures) {
    for (const file of db.select().from(groupCaptureFilesTable).where(eq(groupCaptureFilesTable.captureId, capture.id)).all()) {
      if (file.uploadStatus !== 'done') jobs.push({ kind: 'group-capture-file', captureId: capture.id, fileId: file.id })
    }
  }

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

const LIVE_UPLOAD_SETTING_PREFIX = 'live_upload:'
const CAPTURE_BATCH_FILE_KEYS_PREFIX = 'capture_batch_files:'
const LIVE_UPLOAD_INTERVAL_MS = 2_500
const liveUploadTimers = new Map<number, NodeJS.Timeout>()
const activeLiveUploadRuns = new Map<number, Promise<void>>()
const liveUploadActivity = new Map<number, { lastUploadedAt?: string; lastError?: string }>()

function liveUploadSettingKey(projectId: number): string {
  return `${LIVE_UPLOAD_SETTING_PREFIX}${projectId}`
}

function projectSyncJobKey(job: ProjectSyncJob): string {
  if (job.kind === 'capture-file') return `capture:${job.fileId}`
  if (job.kind === 'group-capture-file') return `group:${job.fileId}`
  return `legacy:${job.photoId}`
}

function registerProjectBatchJobs(projectId: number, jobs: ProjectSyncJob[]): number {
  const settingKey = `${CAPTURE_BATCH_FILE_KEYS_PREFIX}${projectId}`
  let existing: string[] = []
  try {
    const stored = getSetting(settingKey)
    if (stored) existing = JSON.parse(stored) as string[]
  } catch {
    existing = []
  }
  const keys = new Set(existing)
  for (const job of jobs) keys.add(projectSyncJobKey(job))
  setSetting(settingKey, JSON.stringify([...keys]))
  return keys.size
}

export function getProjectCaptureBatchExpectedCount(projectId: number): number {
  return registerProjectBatchJobs(projectId, getProjectSyncJobs(projectId))
}

function isLiveUploadEnabled(projectId: number): boolean {
  return getSetting(liveUploadSettingKey(projectId)) === '1'
}

function getUploadStatusCounts(projectId: number) {
  const db = getDb()
  const statuses: UploadStatus[] = []
  const captures = db.select({ id: capturesTable.id }).from(capturesTable)
    .where(eq(capturesTable.projectId, projectId)).all()
  for (const capture of captures) {
    statuses.push(...db.select({ status: imageFilesTable.uploadStatus }).from(imageFilesTable)
      .where(eq(imageFilesTable.captureId, capture.id)).all().map((row) => row.status))
  }
  const groupCaptures = db.select({ id: groupCapturesTable.id }).from(groupCapturesTable)
    .where(eq(groupCapturesTable.projectId, projectId)).all()
  for (const capture of groupCaptures) {
    statuses.push(...db.select({ status: groupCaptureFilesTable.uploadStatus }).from(groupCaptureFilesTable)
      .where(eq(groupCaptureFilesTable.captureId, capture.id)).all().map((row) => row.status))
  }
  const mirroredPhotoIds = new Set(
    db.select({ id: capturesTable.legacyPhotoId }).from(capturesTable)
      .where(eq(capturesTable.projectId, projectId)).all()
      .flatMap((row) => row.id === null ? [] : [row.id]),
  )
  statuses.push(...db.select({ id: photosTable.id, status: photosTable.uploadStatus }).from(photosTable)
    .where(and(eq(photosTable.projectId, projectId), eq(photosTable.isMatched, true))).all()
    .filter((row) => !mirroredPhotoIds.has(row.id)).map((row) => row.status))
  return {
    pending: statuses.filter((status) => status === 'pending' || status === null).length,
    uploading: statuses.filter((status) => status === 'uploading').length,
    done: statuses.filter((status) => status === 'done').length,
    error: statuses.filter((status) => status === 'error').length,
    total: statuses.length,
  }
}

export function getLiveUploadState(projectId: number): LiveUploadState {
  return {
    projectId,
    enabled: isLiveUploadEnabled(projectId),
    running: activeLiveUploadRuns.has(projectId),
    cloudReady: isCloudSessionVerified(),
    ...getUploadStatusCounts(projectId),
    ...liveUploadActivity.get(projectId),
  }
}

function emitLiveUploadState(projectId: number): void {
  BrowserWindow.getAllWindows()[0]?.webContents.send('upload:liveStateChanged', getLiveUploadState(projectId))
}

function getProjectLiveUploadJobs(projectId: number, includeErrors: boolean): ProjectSyncJob[] {
  const db = getDb()
  return getProjectSyncJobs(projectId).filter((job) => {
    const status = job.kind === 'capture-file'
      ? db.select({ value: imageFilesTable.uploadStatus }).from(imageFilesTable)
        .where(eq(imageFilesTable.id, job.fileId)).get()?.value
      : job.kind === 'group-capture-file'
        ? db.select({ value: groupCaptureFilesTable.uploadStatus }).from(groupCaptureFilesTable)
          .where(eq(groupCaptureFilesTable.id, job.fileId)).get()?.value
        : db.select({ value: photosTable.uploadStatus }).from(photosTable)
          .where(eq(photosTable.id, job.photoId)).get()?.value
    return status !== 'error' || includeErrors
  })
}

async function uploadProjectJob(job: ProjectSyncJob, captureBatchKey: string): Promise<void> {
  if (job.kind === 'capture-file') {
    await uploadCaptureFile(job.captureId, job.fileId, captureBatchKey)
  } else if (job.kind === 'group-capture-file') {
    await uploadGroupCaptureFile(job.captureId, job.fileId, captureBatchKey)
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
}

async function runLiveUpload(projectId: number, includeErrors = false): Promise<void> {
  const existing = activeLiveUploadRuns.get(projectId)
  if (existing) return existing
  if (!isCloudSessionVerified()) {
    emitLiveUploadState(projectId)
    return
  }
  const project = getDb().select().from(projectsTable).where(eq(projectsTable.id, projectId)).get()
  if (!project || project.finishedAt) return

  const task = (async () => {
    try {
      const jobs = getProjectLiveUploadJobs(projectId, includeErrors)
      if (jobs.length === 0) return
      await syncGroupCloudIdentities(projectId)
      // The server keeps the greatest expected count for this retry-stable key.
      // As a shoot grows, every live upload therefore belongs to the same batch
      // that Finish My Shoot will eventually close.
      const captureBatchKey = await beginProjectCaptureBatch(
        projectId,
        registerProjectBatchJobs(projectId, jobs),
      )
      for (const job of jobs) {
        if (!isCloudSessionVerified()) break
        try {
          await uploadProjectJob(job, captureBatchKey)
          liveUploadActivity.set(projectId, { lastUploadedAt: new Date().toISOString() })
        } catch (error) {
          liveUploadActivity.set(projectId, {
            ...liveUploadActivity.get(projectId),
            lastError: String(error),
          })
          if (!isCloudSessionVerified()) break
        }
        emitLiveUploadState(projectId)
      }
    } catch (error) {
      liveUploadActivity.set(projectId, {
        ...liveUploadActivity.get(projectId),
        lastError: String(error),
      })
    } finally {
      activeLiveUploadRuns.delete(projectId)
      emitLiveUploadState(projectId)
    }
  })()
  activeLiveUploadRuns.set(projectId, task)
  emitLiveUploadState(projectId)
  return task
}

function ensureLiveUploadTimer(projectId: number): void {
  if (liveUploadTimers.has(projectId)) return
  const timer = setInterval(() => {
    if (isLiveUploadEnabled(projectId)) void runLiveUpload(projectId)
  }, LIVE_UPLOAD_INTERVAL_MS)
  timer.unref()
  liveUploadTimers.set(projectId, timer)
  void runLiveUpload(projectId)
}

function stopLiveUploadTimer(projectId: number): void {
  const timer = liveUploadTimers.get(projectId)
  if (timer) clearInterval(timer)
  liveUploadTimers.delete(projectId)
}

function kickEnabledLiveUploads(): void {
  for (const row of getDb().select().from(settingsTable).all()) {
    if (!row.key.startsWith(LIVE_UPLOAD_SETTING_PREFIX) || row.value !== '1') continue
    const projectId = Number(row.key.slice(LIVE_UPLOAD_SETTING_PREFIX.length))
    if (Number.isInteger(projectId)) ensureLiveUploadTimer(projectId)
  }
}

export function initializeLiveUploads(): void {
  kickEnabledLiveUploads()
}

export async function pauseLiveUploadForFinish(projectId: number): Promise<void> {
  setSetting(liveUploadSettingKey(projectId), '0')
  stopLiveUploadTimer(projectId)
  await activeLiveUploadRuns.get(projectId)
  emitLiveUploadState(projectId)
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
      } else if (job.kind === 'group-capture-file') {
        await uploadGroupCaptureFile(job.captureId, job.fileId, captureBatchKey)
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
  const payload = await response.json().catch(() => null)
  assertCaptureBatchComplete(payload)
}

// ─────────────────────────────────────────────────────────────────────────────
// IPC handlers
// ─────────────────────────────────────────────────────────────────────────────

export function registerUploadHandlers() {
  ipcMain.handle('upload:getLiveState', (_e, { projectId }: { projectId: number }) =>
    getLiveUploadState(projectId))
  ipcMain.handle('upload:setLiveEnabled', async (
    _e,
    { projectId, enabled }: { projectId: number; enabled: boolean },
  ) => {
    const project = getDb().select().from(projectsTable).where(eq(projectsTable.id, projectId)).get()
    if (!project || project.finishedAt) return getLiveUploadState(projectId)
    setSetting(liveUploadSettingKey(projectId), enabled ? '1' : '0')
    if (enabled) ensureLiveUploadTimer(projectId)
    else stopLiveUploadTimer(projectId)
    emitLiveUploadState(projectId)
    return getLiveUploadState(projectId)
  })
  ipcMain.handle('upload:runNow', async (_e, { projectId }: { projectId: number }) => {
    await runLiveUpload(projectId)
    await syncPendingCaptureReviews(projectId)
    return getLiveUploadState(projectId)
  })
  ipcMain.handle('upload:retryProjectFailed', async (_e, { projectId }: { projectId: number }) => {
    await runLiveUpload(projectId, true)
    await syncPendingCaptureReviews(projectId)
    return getLiveUploadState(projectId)
  })

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
        await syncPendingCaptureReviews()
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

  ipcMain.handle('upload:retryGroupFile', async (_e, { fileId }: { fileId: number }) => {
    const db = getDb()
    const file = db.select().from(groupCaptureFilesTable).where(eq(groupCaptureFilesTable.id, fileId)).get()
    if (!file) return { ok: false, error: 'Group capture file not found' }
    if (!isCloudSessionVerified()) return { ok: false, error: 'Upload is waiting for an internet connection and a verified studio session.' }
    try {
      await uploadGroupCaptureFile(file.captureId, file.id)
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
