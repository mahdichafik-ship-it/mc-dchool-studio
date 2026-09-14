/**
 * Cloud upload IPC handlers.
 *
 * Settings are stored in the SQLite settings table (key/value pairs).
 * On a photo match (called from watcher.ts) the matched photo is
 * automatically queued and uploaded to the configured API endpoint.
 */

import { BrowserWindow, ipcMain, safeStorage, dialog } from 'electron'
import { readFileSync } from 'fs'
import { createHash } from 'node:crypto'
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
import { eq, and, or, asc } from 'drizzle-orm'
import type { LiveUploadQueueItem, LiveUploadState, UploadStatus } from '../../shared/types'
import { assertCaptureBatchComplete } from '../lib/captureBatch'
import { getEligibleUploadJobs } from '../lib/uploadRetrySchedule'
import { AsyncTaskLimiter, runWithConcurrency } from '../lib/uploadConcurrency'
import { startActiveUploadRun } from '../lib/activeUploadRun'
import { classifyProjectUploadFile } from '../lib/projectUploadClassification'
import {
  assertR2VerifierResponse,
  parseR2UploadSession,
  parseUploadResponse,
  parseUploadResponseJson,
  RetryableUploadError,
} from '../lib/uploadResponseValidation'
import type { R2UploadSession } from '../lib/uploadResponseValidation'
import {
  getUploadTransferTimeoutMs,
  hasSufficientUploadWindow,
  isUploadTimeoutError,
  UPLOAD_TIMEOUT_MESSAGE,
} from '../lib/uploadTransferTimeout'

export {
  getUploadTransferTimeoutMs,
  hasSufficientUploadWindow,
  isUploadTimeoutError,
  UPLOAD_TIMEOUT_MESSAGE,
} from '../lib/uploadTransferTimeout'

export {
  assertR2VerifierResponse,
  parseR2UploadSession,
  parseUploadResponse,
  parseUploadResponseJson,
  RetryableUploadError,
} from '../lib/uploadResponseValidation'
export type { R2UploadSession } from '../lib/uploadResponseValidation'

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

/**
 * Do not expose DOM/undici TimeoutError details to photographers. Keep this
 * conversion at the upload boundary so retry scheduling still sees a
 * RetryableUploadError and the UI receives one concise, actionable message.
 */
export function normalizeUploadError(error: unknown): Error {
  if (isUploadTimeoutError(error)) {
    return new RetryableUploadError(UPLOAD_TIMEOUT_MESSAGE)
  }
  return error instanceof Error ? error : new Error(String(error))
}

export function getUploadErrorMessage(error: unknown): string {
  return normalizeUploadError(error).message
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
const activeGroupCaptureFileUploads = new Map<number, Promise<void>>()
const activeCaptureReviewSyncs = new Map<number, Promise<void>>()
const activeGroupCaptureReviewSyncs = new Map<number, Promise<void>>()
const cloudIdentityRepairs = new Map<string, Promise<void>>()
const MAX_CONCURRENT_UPLOADS = 3
const uploadLimiter = new AsyncTaskLimiter(MAX_CONCURRENT_UPLOADS)

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
  retryPendingReviewsAfterConnectionRestore()
}

export function markCloudSessionUnavailable(): void {
  cloudSessionVerified = false
}

export function markCloudSessionVerified(): void {
  if (cloudSyncDisabledForRetirement) return
  cloudSessionVerified = true
  kickEnabledLiveUploads()
  retryPendingReviewsAfterConnectionRestore()
}

export function isCloudSessionVerified(): boolean {
  return cloudSessionVerified && !cloudSyncDisabledForRetirement
}

function retryPendingReviewsAfterConnectionRestore(): void {
  void Promise.all([
    syncPendingCaptureReviews(),
    syncPendingGroupCaptureReviews(),
  ]).catch((error) => {
    console.warn('[Review] Could not retry pending cloud review changes:', error)
  })
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
    return { synced: false, error: getUploadErrorMessage(error) }
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

function isConnectivityFailure(error: unknown): boolean {
  if (error instanceof RetryableUploadError) return false
  if (!(error instanceof Error)) return false
  return error.name === 'AbortError'
    || error.name === 'TimeoutError'
    || error.name === 'TypeError'
}

export async function completeR2Upload(
  session: R2UploadSession | null | undefined,
  fileBuffer: Buffer,
  apiUrl: string,
  connectionToken: string,
): Promise<void> {
  // Servers predating private R2 delivery do not return this additive field.
  if (!session) return
  session = parseR2UploadSession(session)
  if (session.alreadyVerified) return
  const expectedSha256 = session.uploadHeaders['x-amz-meta-sha256']
  const actualSha256 = createHash('sha256').update(fileBuffer).digest('hex')
  if (expectedSha256?.toLowerCase() !== actualSha256) {
    throw new Error('R2 upload session does not match the local file bytes.')
  }

  if (!hasSufficientUploadWindow(session.expiresAt, fileBuffer.byteLength)) {
    throw new RetryableUploadError('Upload session expires too soon; requesting a new upload session.')
  }

  let uploadResponse: Response
  try {
    uploadResponse = await fetch(session.uploadUrl, {
      method: session.uploadMethod,
      headers: session.uploadHeaders,
      body: new Blob([fileBuffer], {
        type: session.uploadHeaders['Content-Type'] || 'application/octet-stream',
      }),
      signal: AbortSignal.timeout(getUploadTransferTimeoutMs(fileBuffer.byteLength)),
    })
  } catch (error) {
    throw normalizeUploadError(error)
  }
  if (!uploadResponse.ok) {
    const body = await uploadResponse.text().catch(() => '')
    throw new RetryableUploadError(
      `R2 upload failed with HTTP ${uploadResponse.status}${body ? `: ${body}` : ''}`,
    )
  }

  let verifyResponse: Response
  try {
    verifyResponse = await fetch(
      `${apiUrl.replace(/\/+$/, '')}/api/desktop/storage-copies/${session.copyId}/r2/verify`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${connectionToken}` },
        signal: AbortSignal.timeout(30_000),
      },
    )
  } catch (error) {
    throw normalizeUploadError(error)
  }
  if (!verifyResponse.ok) {
    const body = await verifyResponse.text().catch(() => '')
    if (verifyResponse.status === 401) invalidateDesktopCredentials(true)
    if (verifyResponse.status === 409 || verifyResponse.status === 429 || verifyResponse.status >= 500) {
      throw new RetryableUploadError(
        `R2 verification failed with HTTP ${verifyResponse.status}${body ? `: ${body}` : ''}`,
      )
    }
    throw new Error(`R2 verification failed with HTTP ${verifyResponse.status}${body ? `: ${body}` : ''}`)
  }

  let verifierPayload: unknown
  try {
    verifierPayload = await verifyResponse.json()
  } catch {
    throw new RetryableUploadError('R2 verification returned an invalid response; retrying safely.')
  }
  assertR2VerifierResponse(verifierPayload, session.copyId)
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
      signal: AbortSignal.timeout(getUploadTransferTimeoutMs(fileBuffer.byteLength)),
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
    let fileUrl: string
    let r2Upload: R2UploadSession | null | undefined
    try {
      const payload = await parseUploadResponse(response, 'photo')
      fileUrl = payload.fileUrl!
      r2Upload = payload.r2Upload
    } catch {
      throw new RetryableUploadError('Upload succeeded but returned an invalid response; retrying safely.')
    }
    await completeR2Upload(r2Upload, fileBuffer, apiUrl, connectionToken)

    // Mark as done
    db.update(photosTable)
      .set({ uploadStatus: 'done', fileUrl })
      .where(eq(photosTable.id, photoId))
      .run()
    notifyUploadStatus(photoId, studentId, 'done')

    console.log(`[Upload] Photo ${photoId} uploaded successfully`)
  } catch (err) {
    const error = normalizeUploadError(err)
    const retryable = isRetryableUploadFailure(error)
    if (isConnectivityFailure(error)) markCloudSessionUnavailable()
    console.error(`[Upload] Upload ${retryable ? 'waiting for connectivity' : 'failed'}:`, error)
    db.update(photosTable)
      .set({ uploadStatus: retryable ? 'pending' : 'error' })
      .where(eq(photosTable.id, photoId))
      .run()
    notifyUploadStatus(photoId, studentId, retryable ? 'pending' : 'error')
    throw error
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

  const task = uploadLimiter.run(() =>
    performUploadPhoto(projectId, studentId, photoId, filePath, fileName, capturedAt, captureBatchKey),
  )
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
      signal: AbortSignal.timeout(getUploadTransferTimeoutMs(fileBuffer.byteLength)),
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
    let r2Upload: R2UploadSession | null | undefined
    try {
      const payload = await parseUploadResponse(response, 'capture')
      serverFileUrl = toServerFileUrl(payload.file!.fileUrl as string)
      r2Upload = payload.r2Upload
    } catch {
      throw new RetryableUploadError('Capture upload returned an invalid response; retrying safely.')
    }
    await completeR2Upload(r2Upload, fileBuffer, apiUrl, connectionToken)
    setCaptureFileStatus(captureId, fileId, 'done', serverFileUrl)
    console.log(`[Upload] Capture file ${fileId} (${file.fileRole}) uploaded successfully`)
  } catch (error) {
    const normalizedError = normalizeUploadError(error)
    const retryable = isRetryableUploadFailure(normalizedError)
    if (isConnectivityFailure(normalizedError)) markCloudSessionUnavailable()
    console.error(`[Upload] Capture file ${retryable ? 'waiting for connectivity' : 'failed'}:`, normalizedError)
    setCaptureFileStatus(captureId, fileId, retryable ? 'pending' : 'error', undefined)
    throw normalizedError
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
    const fileBuffer = readFileSync(file.storedPath)
    const formData = new FormData()
    const managedFilename = basename(file.storedPath)
    formData.append('file', new Blob([fileBuffer], {
      type: file.fileRole === 'JPEG' ? 'image/jpeg' : 'application/octet-stream',
    }), managedFilename)
    formData.append('captureKey', capture.captureKey)
    formData.append('baseFilename', capture.baseFilename)
    formData.append('capturedAt', capture.capturedAt)
    formData.append('rating', String(capture.rating))
    const response = await fetch(`${apiUrl.replace(/\/+$/, '')}/api/desktop/projects/${project.cloudId}/groups/${group.cloudId}/captures`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${connectionToken}`,
        'X-MC-Upload-Id': String(file.id),
        ...(captureBatchKey ? { 'X-MC-Capture-Batch': captureBatchKey } : {}),
      },
      body: formData,
      signal: AbortSignal.timeout(getUploadTransferTimeoutMs(fileBuffer.byteLength)),
    })
    if (!response.ok) {
      const text = await response.text()
      if (response.status === 401) invalidateDesktopCredentials(true)
      if (response.status === 429 || response.status >= 500) throw new RetryableUploadError(`HTTP ${response.status}: ${text}`)
      throw new Error(`HTTP ${response.status}: ${text}`)
    }
    let payload: ReturnType<typeof parseUploadResponseJson>
    try {
      payload = await parseUploadResponse(response, 'group')
    } catch {
      throw new RetryableUploadError('Group capture upload returned an invalid response; retrying safely.')
    }
    await completeR2Upload(
      payload.r2Upload,
      fileBuffer,
      apiUrl,
      connectionToken,
    )
    db.update(groupCaptureFilesTable).set({
      uploadStatus: 'done',
      fileUrl: toServerFileUrl(payload.file!.fileUrl as string),
      galleryReady: file.fileRole !== 'JPEG' || payload.galleryReady === true,
    }).where(eq(groupCaptureFilesTable.id, fileId)).run()
  } catch (error) {
    const normalizedError = normalizeUploadError(error)
    const retryable = isRetryableUploadFailure(normalizedError)
    if (isConnectivityFailure(normalizedError)) markCloudSessionUnavailable()
    db.update(groupCaptureFilesTable).set({ uploadStatus: retryable ? 'pending' : 'error' })
      .where(eq(groupCaptureFilesTable.id, fileId)).run()
    throw normalizedError
  }
}

async function performSyncGroupCaptureReview(captureId: number): Promise<void> {
  if (!isCloudSessionVerified()) return
  const db = getDb()
  const capture = db.select().from(groupCapturesTable).where(eq(groupCapturesTable.id, captureId)).get()
  if (!capture) return
  const group = db.select().from(groupsTable).where(eq(groupsTable.id, capture.groupId)).get()
  const project = db.select().from(projectsTable).where(eq(projectsTable.id, capture.projectId)).get()
  const { apiUrl, connectionToken } = getUploadConfig()
  if (!group?.cloudId || !project?.cloudId || !apiUrl || !connectionToken) return
  try {
    const response = await fetch(
      `${apiUrl.replace(/\/+$/, '')}/api/desktop/projects/${project.cloudId}/groups/${group.cloudId}/captures/${encodeURIComponent(capture.captureKey)}/review`,
      {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${connectionToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ rating: capture.rating }),
        signal: AbortSignal.timeout(10_000),
      },
    )
    if (response.status === 401) invalidateDesktopCredentials(true)
    if (response.ok) {
      // A review can be edited while this request is in flight. Only clear
      // pending when the row still contains the exact version we sent.
      const latest = db.select({ rating: groupCapturesTable.rating })
        .from(groupCapturesTable)
        .where(eq(groupCapturesTable.id, captureId))
        .get()
      if (latest?.rating !== capture.rating) return
      db.update(groupCapturesTable).set({ reviewSyncPending: false, updatedAt: new Date().toISOString() })
        .where(and(eq(groupCapturesTable.id, captureId), eq(groupCapturesTable.rating, capture.rating))).run()
      return
    }
    const body = await response.text().catch(() => '')
    console.warn(`[Review] Group review sync failed with HTTP ${response.status}${body ? `: ${body}` : ''}`)
  } catch (error) {
    if (isConnectivityFailure(error)) markCloudSessionUnavailable()
    console.warn('[Review] Group review sync deferred:', error)
  }
}

export function syncGroupCaptureReview(captureId: number): Promise<void> {
  const previous = activeGroupCaptureReviewSyncs.get(captureId) ?? Promise.resolve()
  const task = previous.catch(() => {}).then(() => performSyncGroupCaptureReview(captureId))
  activeGroupCaptureReviewSyncs.set(captureId, task)
  void task.finally(() => {
    if (activeGroupCaptureReviewSyncs.get(captureId) === task) {
      activeGroupCaptureReviewSyncs.delete(captureId)
    }
  }).catch(() => {})
  return task
}

export function uploadCaptureFile(captureId: number, fileId: number, captureBatchKey?: string): Promise<void> {
  if (!isCloudSessionVerified()) return Promise.resolve()
  const existing = activeCaptureFileUploads.get(fileId)
  if (existing) return existing

  const task = uploadLimiter.run(() => performUploadCaptureFile(captureId, fileId, captureBatchKey))
  activeCaptureFileUploads.set(fileId, task)
  activeUploads.add(task)
  void task.finally(() => {
    activeUploads.delete(task)
    activeCaptureFileUploads.delete(fileId)
  }).catch(() => {})
  return task
}

async function performSyncCaptureReview(captureId: number): Promise<void> {
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
      `${apiUrl.replace(/\/+$/, '')}/api/desktop/projects/${project.cloudId}/students/${student.cloudId}/captures/${encodeURIComponent(capture.captureKey)}/review`,
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
          editSettings: {
            // Desktop stores crop position as a centered percentage (-100..100);
            // the cloud contract stores the normalized focal point (0..1).
            cropPositionX: Math.max(0, Math.min(1, ((capture.cropX ?? 0) + 100) / 200)),
            cropPositionY: Math.max(0, Math.min(1, ((capture.cropY ?? 0) + 100) / 200)),
            // Desktop stores scale as a percentage (100..300); cloud uses 1..3.
            cropScale: Math.max(1, Math.min(3, (capture.cropScale ?? 100) / 100)),
            aspectRatio: capture.aspectRatio && capture.aspectRatio !== 'original'
              ? capture.aspectRatio
              : null,
            // Defaults from legacy captures are 0/0/100/original, which is
            // an identity edit in this normalized representation.
            straightenAngle: capture.straightenAngle ?? 0,
            rotation: capture.rotation ?? 0,
          },
        }),
        signal: AbortSignal.timeout(10_000),
      },
    )
    if (response.status === 401) {
      invalidateDesktopCredentials(true)
      return
    }
    if (response.ok) {
      // Do not let an older response acknowledge a newer local edit. The
      // explicit review/framing values are the sent version; updatedAt is
      // included as an additional guard for unrelated local writes.
      const latest = db.select().from(capturesTable)
        .where(eq(capturesTable.id, captureId))
        .get()
      if (!latest || latest.updatedAt !== capture.updatedAt
        || latest.favorite !== capture.favorite
        || latest.rejected !== capture.rejected
        || latest.selected !== capture.selected
        || latest.rating !== capture.rating
        || latest.colorLabel !== capture.colorLabel
        || latest.cropX !== capture.cropX
        || latest.cropY !== capture.cropY
        || latest.cropScale !== capture.cropScale
        || latest.aspectRatio !== capture.aspectRatio
        || latest.straightenAngle !== capture.straightenAngle
        || latest.rotation !== capture.rotation) {
        return
      }
      db.update(capturesTable)
        .set({ reviewSyncPending: false, reframePending: false, updatedAt: new Date().toISOString() })
        .where(and(eq(capturesTable.id, captureId), eq(capturesTable.updatedAt, capture.updatedAt)))
        .run()
      return
    }
    const body = await response.text().catch(() => '')
    console.warn(`[Review] Portrait review sync failed with HTTP ${response.status}${body ? `: ${body}` : ''}`)
  } catch (error) {
    if (isConnectivityFailure(error)) markCloudSessionUnavailable()
    console.warn('[Review] Cloud review sync deferred:', error)
  }
}

export function syncCaptureReview(captureId: number): Promise<void> {
  // Serialize each capture independently. This avoids an unbounded set of
  // overlapping PATCHes while still allowing different captures to sync in
  // parallel. The sent-version checks above protect the response boundary.
  const previous = activeCaptureReviewSyncs.get(captureId) ?? Promise.resolve()
  const task = previous.catch(() => {}).then(() => performSyncCaptureReview(captureId))
  activeCaptureReviewSyncs.set(captureId, task)
  void task.finally(() => {
    if (activeCaptureReviewSyncs.get(captureId) === task) {
      activeCaptureReviewSyncs.delete(captureId)
    }
  }).catch(() => {})
  return task
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

async function syncPendingGroupCaptureReviews(projectId?: number): Promise<void> {
  if (!isCloudSessionVerified()) return
  const db = getDb()
  const captures = db.select({ id: groupCapturesTable.id }).from(groupCapturesTable)
    .where(projectId === undefined
      ? eq(groupCapturesTable.reviewSyncPending, true)
      : and(eq(groupCapturesTable.reviewSyncPending, true), eq(groupCapturesTable.projectId, projectId)))
    .all()
  for (const capture of captures) {
    if (!isCloudSessionVerified()) return
    await syncGroupCaptureReview(capture.id)
  }
}

/**
 * Finish uses this as a hard review barrier. A failed/offline/404 response
 * intentionally leaves the durable pending flags set, so this returns a
 * non-zero count and Finish My Shoot remains retryable.
 */
export async function flushPendingCaptureReviews(projectId: number): Promise<{
  portrait: number
  group: number
}> {
  await syncPendingCaptureReviews(projectId)
  await syncPendingGroupCaptureReviews(projectId)
  const db = getDb()
  return {
    portrait: db.select({ id: capturesTable.id }).from(capturesTable)
      .where(and(eq(capturesTable.projectId, projectId), eq(capturesTable.reviewSyncPending, true)))
      .all().length,
    group: db.select({ id: groupCapturesTable.id }).from(groupCapturesTable)
      .where(and(eq(groupCapturesTable.projectId, projectId), eq(groupCapturesTable.reviewSyncPending, true)))
      .all().length,
  }
}

function uploadGroupCaptureFile(captureId: number, fileId: number, captureBatchKey?: string): Promise<void> {
  if (!isCloudSessionVerified()) return Promise.resolve()
  const existing = activeGroupCaptureFileUploads.get(fileId)
  if (existing) return existing
  const task = uploadLimiter.run(() => performUploadGroupCaptureFile(captureId, fileId, captureBatchKey))
  activeGroupCaptureFileUploads.set(fileId, task)
  activeUploads.add(task)
  void task.finally(() => {
    activeUploads.delete(task)
    activeGroupCaptureFileUploads.delete(fileId)
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

export type ProjectSyncJob =
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

function uniqueProjectSyncJobs(jobs: ProjectSyncJob[]): ProjectSyncJob[] {
  const seen = new Set<string>()
  return jobs.filter((job) => {
    const key = projectSyncJobKey(job)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

type ProjectUploadCapture = {
  capture: typeof capturesTable.$inferSelect
  student: typeof studentsTable.$inferSelect | undefined
}

type ProjectUploadGroupCapture = {
  capture: typeof groupCapturesTable.$inferSelect
  group: typeof groupsTable.$inferSelect | undefined
}

type ProjectUploadLegacyPhoto = {
  photo: typeof photosTable.$inferSelect
  student: typeof studentsTable.$inferSelect | undefined
}

type ProjectUploadSnapshot = {
  captures: Map<number, ProjectUploadCapture>
  captureFiles: Map<number, typeof imageFilesTable.$inferSelect>
  captureFilesByCapture: Map<number, typeof imageFilesTable.$inferSelect[]>
  groupCaptures: Map<number, ProjectUploadGroupCapture>
  groupCaptureFiles: Map<number, typeof groupCaptureFilesTable.$inferSelect>
  groupCaptureFilesByCapture: Map<number, typeof groupCaptureFilesTable.$inferSelect[]>
  legacyPhotos: Map<number, ProjectUploadLegacyPhoto>
}

/**
 * Load all upload inputs for one project with a fixed number of joined
 * queries. In particular, do not turn this into a lookup inside one of the
 * job loops: large school rosters commonly have thousands of files.
 *
 * The project predicates on the parent rows, plus the project predicates in
 * the optional metadata joins, are intentional. IDs are database-global, but
 * upload IPC must never use a student/group from another project if a stale
 * local row points at one.
 */
function loadProjectUploadSnapshot(projectId: number): ProjectUploadSnapshot {
  const db = getDb()
  const personalRows = db
    .select({
      capture: capturesTable,
      file: imageFilesTable,
      student: studentsTable,
    })
    .from(capturesTable)
    .leftJoin(imageFilesTable, eq(imageFilesTable.captureId, capturesTable.id))
    .leftJoin(studentsTable, and(
      eq(studentsTable.id, capturesTable.studentId),
      eq(studentsTable.projectId, projectId),
    ))
    .where(eq(capturesTable.projectId, projectId))
    .orderBy(asc(capturesTable.id), asc(imageFilesTable.id))
    .all()
  const groupRows = db
    .select({
      capture: groupCapturesTable,
      file: groupCaptureFilesTable,
      group: groupsTable,
    })
    .from(groupCapturesTable)
    .innerJoin(groupCaptureFilesTable, eq(groupCaptureFilesTable.captureId, groupCapturesTable.id))
    .leftJoin(groupsTable, and(
      eq(groupsTable.id, groupCapturesTable.groupId),
      eq(groupsTable.projectId, projectId),
    ))
    .where(eq(groupCapturesTable.projectId, projectId))
    .orderBy(asc(groupCapturesTable.id), asc(groupCaptureFilesTable.id))
    .all()
  const legacyRows = db
    .select({
      photo: photosTable,
      student: studentsTable,
    })
    .from(photosTable)
    .leftJoin(studentsTable, and(
      eq(studentsTable.id, photosTable.studentId),
      eq(studentsTable.projectId, projectId),
    ))
    .where(eq(photosTable.projectId, projectId))
    .orderBy(asc(photosTable.id))
    .all()

  const captures = new Map<number, ProjectUploadCapture>()
  const captureFiles = new Map<number, typeof imageFilesTable.$inferSelect>()
  const captureFilesByCapture = new Map<number, typeof imageFilesTable.$inferSelect[]>()
  for (const row of personalRows) {
    if (!captures.has(row.capture.id)) {
      captures.set(row.capture.id, { capture: row.capture, student: row.student ?? undefined })
    }
    if (!row.file) continue
    captureFiles.set(row.file.id, row.file)
    const files = captureFilesByCapture.get(row.capture.id) ?? []
    files.push(row.file)
    captureFilesByCapture.set(row.capture.id, files)
  }

  const groupCaptures = new Map<number, ProjectUploadGroupCapture>()
  const groupCaptureFiles = new Map<number, typeof groupCaptureFilesTable.$inferSelect>()
  const groupCaptureFilesByCapture = new Map<number, typeof groupCaptureFilesTable.$inferSelect[]>()
  for (const row of groupRows) {
    if (!groupCaptures.has(row.capture.id)) {
      groupCaptures.set(row.capture.id, { capture: row.capture, group: row.group ?? undefined })
    }
    groupCaptureFiles.set(row.file.id, row.file)
    const files = groupCaptureFilesByCapture.get(row.capture.id) ?? []
    files.push(row.file)
    groupCaptureFilesByCapture.set(row.capture.id, files)
  }

  const legacyPhotos = new Map<number, ProjectUploadLegacyPhoto>()
  for (const row of legacyRows) {
    legacyPhotos.set(row.photo.id, { photo: row.photo, student: row.student ?? undefined })
  }

  return {
    captures,
    captureFiles,
    captureFilesByCapture,
    groupCaptures,
    groupCaptureFiles,
    groupCaptureFilesByCapture,
    legacyPhotos,
  }
}

function getProjectSyncJobsFromSnapshot(
  projectId: number,
  snapshot: ProjectUploadSnapshot,
  includeDone = false,
): ProjectSyncJob[] {
  const jobs: ProjectSyncJob[] = []
  for (const { capture, group } of snapshot.groupCaptures.values()) {
    for (const file of snapshot.groupCaptureFilesByCapture.get(capture.id) ?? []) {
      const classification = classifyProjectUploadFile({
        kind: 'group',
        associationResolved: group !== undefined,
        status: file.uploadStatus,
        fileRole: file.fileRole,
        galleryReady: file.galleryReady,
      })
      if (!group || (!includeDone && classification !== 'ready')) continue
      jobs.push({ kind: 'group-capture-file', captureId: capture.id, fileId: file.id })
    }
  }

  for (const { capture, student } of snapshot.captures.values()) {
    for (const file of snapshot.captureFilesByCapture.get(capture.id) ?? []) {
      const classification = classifyProjectUploadFile({
        kind: 'personal',
        associationResolved: capture.studentId !== null && student !== undefined,
        status: file.uploadStatus,
      })
      if (capture.studentId === null || !student || (!includeDone && classification !== 'ready')) continue
      jobs.push({ kind: 'capture-file', captureId: capture.id, fileId: file.id })
    }
  }

  const mirroredPhotoIds = getMirroredLegacyPhotoIds(snapshot)
  for (const { photo, student } of snapshot.legacyPhotos.values()) {
    const classification = classifyProjectUploadFile({
      kind: 'legacy',
      associationResolved: photo.studentId !== null && student !== undefined,
      status: photo.uploadStatus,
    })
    if (
      !photo.isMatched
      || mirroredPhotoIds.has(photo.id)
      || photo.studentId === null
      || !student
      || (!includeDone && classification !== 'ready')
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

  return uniqueProjectSyncJobs(jobs)
}

function getMirroredLegacyPhotoIds(snapshot: ProjectUploadSnapshot): Set<number> {
  return new Set(
    [...snapshot.captures.values()]
      .flatMap(({ capture }) => capture.legacyPhotoId === null ? [] : [capture.legacyPhotoId]),
  )
}

function getProjectUploadAccountingKeys(snapshot: ProjectUploadSnapshot): Set<string> {
  const keys = new Set<string>()
  const mirroredPhotoIds = getMirroredLegacyPhotoIds(snapshot)
  for (const { capture, student } of snapshot.captures.values()) {
    for (const file of snapshot.captureFilesByCapture.get(capture.id) ?? []) {
      const classification = classifyProjectUploadFile({
        kind: 'personal',
        associationResolved: capture.studentId !== null && student !== undefined,
        status: file.uploadStatus,
      })
      if (classification !== 'excluded' || (capture.studentId !== null && student !== undefined)) {
        keys.add(`capture:${file.id}`)
      }
    }
  }
  for (const { capture, group } of snapshot.groupCaptures.values()) {
    for (const file of snapshot.groupCaptureFilesByCapture.get(capture.id) ?? []) {
      const classification = classifyProjectUploadFile({
        kind: 'group',
        associationResolved: group !== undefined,
        status: file.uploadStatus,
        fileRole: file.fileRole,
        galleryReady: file.galleryReady,
      })
      if (classification !== 'excluded' || group !== undefined) keys.add(`group:${file.id}`)
    }
  }
  for (const { photo, student } of snapshot.legacyPhotos.values()) {
    if (!photo.isMatched || mirroredPhotoIds.has(photo.id)) continue
    const classification = classifyProjectUploadFile({
      kind: 'legacy',
      associationResolved: photo.studentId !== null && student !== undefined,
      status: photo.uploadStatus,
    })
    if (classification !== 'excluded' || (photo.studentId !== null && student !== undefined)) {
      keys.add(`legacy:${photo.id}`)
    }
  }
  return keys
}

function getProjectSyncJobs(projectId: number, includeDone = false): ProjectSyncJob[] {
  return getProjectSyncJobsFromSnapshot(projectId, loadProjectUploadSnapshot(projectId), includeDone)
}

const LIVE_UPLOAD_SETTING_PREFIX = 'live_upload:'
const CAPTURE_BATCH_FILE_KEYS_PREFIX = 'capture_batch_files:'
const LIVE_UPLOAD_INTERVAL_MS = 2_500
const FAILED_UPLOAD_RETRY_BASE_MS = 30_000
const FAILED_UPLOAD_RETRY_MAX_MS = 5 * 60_000
const liveUploadTimers = new Map<number, NodeJS.Timeout>()
const activeLiveUploadRuns = new Map<number, Promise<void>>()
const liveUploadActivity = new Map<number, { lastUploadedAt?: string; lastError?: string }>()
const failedUploadRetryAfter = new Map<string, number>()
const failedLiveRunRetryAfter = new Map<number, number>()
const failedUploadAttempts = new Map<string, number>()
const failedLiveRunAttempts = new Map<number, number>()
const failedUploadErrors = new Map<string, string>()

function retryDelay(attempt: number): number {
  const exponential = Math.min(
    FAILED_UPLOAD_RETRY_MAX_MS,
    FAILED_UPLOAD_RETRY_BASE_MS * (2 ** Math.max(0, attempt - 1)),
  )
  return Math.min(
    FAILED_UPLOAD_RETRY_MAX_MS,
    Math.round(exponential * (0.8 + Math.random() * 0.4)),
  )
}

function deferFailedJob(job: ProjectSyncJob, error: unknown): void {
  const key = projectSyncJobKey(job)
  const attempt = (failedUploadAttempts.get(key) ?? 0) + 1
  failedUploadAttempts.set(key, attempt)
  failedUploadRetryAfter.set(key, Date.now() + retryDelay(attempt))
  failedUploadErrors.set(key, getUploadErrorMessage(error))
}

function deferFailedRun(projectId: number): void {
  const attempt = (failedLiveRunAttempts.get(projectId) ?? 0) + 1
  failedLiveRunAttempts.set(projectId, attempt)
  failedLiveRunRetryAfter.set(projectId, Date.now() + retryDelay(attempt))
}

function liveUploadSettingKey(projectId: number): string {
  return `${LIVE_UPLOAD_SETTING_PREFIX}${projectId}`
}

function projectSyncJobKey(job: ProjectSyncJob): string {
  if (job.kind === 'capture-file') return `capture:${job.fileId}`
  if (job.kind === 'group-capture-file') return `group:${job.fileId}`
  return `legacy:${job.photoId}`
}

function registerProjectBatchJobs(
  projectId: number,
  jobs: ProjectSyncJob[],
  snapshot = loadProjectUploadSnapshot(projectId),
): number {
  const settingKey = `${CAPTURE_BATCH_FILE_KEYS_PREFIX}${projectId}`
  let existing: string[] = []
  try {
    const stored = getSetting(settingKey)
    if (stored) existing = JSON.parse(stored) as string[]
  } catch {
    existing = []
  }
  const validKeys = getProjectUploadAccountingKeys(snapshot)
  const keys = new Set(existing.filter((key) => validKeys.has(key)))
  // Include completed files too. Older releases may have durable done rows
  // without a local batch-key setting, and those files still belong in the
  // expected total/progress accounting for explicit Finish.
  for (const key of validKeys) keys.add(key)
  for (const job of jobs) keys.add(projectSyncJobKey(job))
  setSetting(settingKey, JSON.stringify([...keys]))
  return keys.size
}

export function getProjectCaptureBatchExpectedCount(projectId: number): number {
  const snapshot = loadProjectUploadSnapshot(projectId)
  return registerProjectBatchJobs(
    projectId,
    getProjectSyncJobsFromSnapshot(projectId, snapshot),
    snapshot,
  )
}

/** Files that are durable locally but cannot be sent until a student match exists. */
export function getProjectUploadBlockerCount(projectId: number): number {
  const snapshot = loadProjectUploadSnapshot(projectId)
  const mirroredPhotoIds = getMirroredLegacyPhotoIds(snapshot)
  let blocked = 0
  for (const { capture, student } of snapshot.captures.values()) {
    for (const file of snapshot.captureFilesByCapture.get(capture.id) ?? []) {
      if (classifyProjectUploadFile({
        kind: 'personal',
        associationResolved: capture.studentId !== null && student !== undefined,
        status: file.uploadStatus,
      }) === 'blocked') blocked += 1
    }
  }
  for (const { capture, group } of snapshot.groupCaptures.values()) {
    for (const file of snapshot.groupCaptureFilesByCapture.get(capture.id) ?? []) {
      if (classifyProjectUploadFile({
        kind: 'group',
        associationResolved: group !== undefined,
        status: file.uploadStatus,
        fileRole: file.fileRole,
        galleryReady: file.galleryReady,
      }) === 'blocked') blocked += 1
    }
  }
  for (const { photo, student } of snapshot.legacyPhotos.values()) {
    if (!photo.isMatched || mirroredPhotoIds.has(photo.id)) continue
    if (classifyProjectUploadFile({
      kind: 'legacy',
      associationResolved: photo.studentId !== null && student !== undefined,
      status: photo.uploadStatus,
    }) === 'blocked') blocked += 1
  }
  return blocked
}

function isLiveUploadEnabled(projectId: number): boolean {
  return getSetting(liveUploadSettingKey(projectId)) === '1'
}

function getUploadStatusCounts(projectId: number) {
  const snapshot = loadProjectUploadSnapshot(projectId)
  const statuses: UploadStatus[] = []
  let blocked = 0
  for (const { capture, student } of snapshot.captures.values()) {
    const associationResolved = capture.studentId !== null && student !== undefined
    for (const file of snapshot.captureFilesByCapture.get(capture.id) ?? []) {
      const classification = classifyProjectUploadFile({
        kind: 'personal',
        associationResolved,
        status: file.uploadStatus,
      })
      if (classification === 'blocked') blocked += 1
      else if (associationResolved) statuses.push(file.uploadStatus)
    }
  }
  for (const { capture, group } of snapshot.groupCaptures.values()) {
    const associationResolved = group !== undefined
    for (const file of snapshot.groupCaptureFilesByCapture.get(capture.id) ?? []) {
      const classification = classifyProjectUploadFile({
        kind: 'group',
        associationResolved,
        status: file.uploadStatus,
        fileRole: file.fileRole,
        galleryReady: file.galleryReady,
      })
      if (classification === 'blocked') blocked += 1
      else if (associationResolved) {
        statuses.push(
          file.fileRole === 'JPEG' && file.uploadStatus === 'done' && !file.galleryReady
            ? 'pending'
            : file.uploadStatus,
        )
      }
    }
  }
  const mirroredPhotoIds = getMirroredLegacyPhotoIds(snapshot)
  for (const { photo, student } of snapshot.legacyPhotos.values()) {
    if (!photo.isMatched || mirroredPhotoIds.has(photo.id)) continue
    const associationResolved = photo.studentId !== null && student !== undefined
    const classification = classifyProjectUploadFile({
      kind: 'legacy',
      associationResolved,
      status: photo.uploadStatus,
    })
    if (classification === 'blocked') blocked += 1
    else if (associationResolved) statuses.push(photo.uploadStatus)
  }
  return {
    pending: statuses.filter((status) => status === 'pending' || status === null).length,
    uploading: statuses.filter((status) => status === 'uploading').length,
    done: statuses.filter((status) => status === 'done').length,
    error: statuses.filter((status) => status === 'error').length,
    blocked,
    total: statuses.length + blocked,
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

function getLiveUploadQueue(projectId: number): LiveUploadQueueItem[] {
  const snapshot = loadProjectUploadSnapshot(projectId)
  const uploadableItems = getProjectSyncJobsFromSnapshot(projectId, snapshot).map((job) => {
    const key = projectSyncJobKey(job)
    const retryAt = failedUploadRetryAfter.get(key)
    const attempts = failedUploadAttempts.get(key) ?? 0
    const lastError = failedUploadErrors.get(key)
    if (job.kind === 'capture-file') {
      const capture = snapshot.captures.get(job.captureId)
      const file = snapshot.captureFiles.get(job.fileId)
      const student = capture?.student
      return {
        key,
        kind: 'portrait',
        fileName: file?.originalFilename ?? basename(file?.storedPath ?? key),
        fileRole: file?.fileRole ?? 'JPEG',
        subject: student ? `${student.firstName} ${student.lastName}` : 'Unassigned portrait',
        capturedAt: capture?.capture.capturedAt ?? file?.createdAt ?? '',
        status: file?.uploadStatus === 'uploading'
          ? 'uploading'
          : file?.uploadStatus === 'error' ? 'failed' : 'queued',
        attempts,
        ...(retryAt ? { retryAt: new Date(retryAt).toISOString() } : {}),
        ...(lastError ? { lastError } : {}),
      } satisfies LiveUploadQueueItem
    }
    if (job.kind === 'group-capture-file') {
      const capture = snapshot.groupCaptures.get(job.captureId)
      const file = snapshot.groupCaptureFiles.get(job.fileId)
      const group = capture?.group
      return {
        key,
        kind: 'group',
        fileName: file?.originalFilename ?? basename(file?.storedPath ?? key),
        fileRole: file?.fileRole ?? 'JPEG',
        subject: group?.name ?? 'Group photo',
        capturedAt: capture?.capture.capturedAt ?? file?.createdAt ?? '',
        status: file?.fileRole === 'JPEG' && file.uploadStatus === 'done' && !file.galleryReady
          ? 'preparing_gallery'
          : file?.uploadStatus === 'uploading'
            ? 'uploading'
            : file?.uploadStatus === 'error' ? 'failed' : 'queued',
        attempts,
        ...(retryAt ? { retryAt: new Date(retryAt).toISOString() } : {}),
        ...(lastError ? { lastError } : {}),
      } satisfies LiveUploadQueueItem
    }
    const photo = snapshot.legacyPhotos.get(job.photoId)
    const student = photo?.student
    return {
      key,
      kind: 'legacy',
      fileName: photo?.photo.fileName ?? basename(job.filePath),
      fileRole: 'JPEG',
      subject: student ? `${student.firstName} ${student.lastName}` : 'Legacy portrait',
      capturedAt: photo?.photo.capturedAt ?? job.capturedAt,
      status: photo?.photo.uploadStatus === 'uploading'
        ? 'uploading'
        : photo?.photo.uploadStatus === 'error' ? 'failed' : 'queued',
      attempts,
      ...(retryAt ? { retryAt: new Date(retryAt).toISOString() } : {}),
      ...(lastError ? { lastError } : {}),
    } satisfies LiveUploadQueueItem
  })
  const blockedItems: LiveUploadQueueItem[] = []
  for (const { capture, student } of snapshot.captures.values()) {
    const associationResolved = capture.studentId !== null && student !== undefined
    for (const file of snapshot.captureFilesByCapture.get(capture.id) ?? []) {
      if (classifyProjectUploadFile({
        kind: 'personal',
        associationResolved,
        status: file.uploadStatus,
      }) !== 'blocked') continue
      blockedItems.push({
        key: `capture:${file.id}`,
        kind: 'portrait',
        fileName: file.originalFilename,
        fileRole: file.fileRole,
        subject: 'Waiting for student match',
        capturedAt: capture.capturedAt,
        status: 'blocked',
        blockedReason: 'This capture has no student match yet.',
        attempts: 0,
      })
    }
  }
  for (const { capture, group } of snapshot.groupCaptures.values()) {
    const associationResolved = group !== undefined
    for (const file of snapshot.groupCaptureFilesByCapture.get(capture.id) ?? []) {
      if (classifyProjectUploadFile({
        kind: 'group',
        associationResolved,
        status: file.uploadStatus,
        fileRole: file.fileRole,
        galleryReady: file.galleryReady,
      }) !== 'blocked') continue
      blockedItems.push({
        key: `group:${file.id}`,
        kind: 'group',
        fileName: file.originalFilename,
        fileRole: file.fileRole,
        subject: 'Waiting for group match',
        capturedAt: capture.capturedAt,
        status: 'blocked',
        blockedReason: 'This capture has no group match yet.',
        attempts: 0,
      })
    }
  }
  const mirroredPhotoIds = getMirroredLegacyPhotoIds(snapshot)
  for (const { photo, student } of snapshot.legacyPhotos.values()) {
    if (!photo.isMatched || mirroredPhotoIds.has(photo.id)) continue
    if (classifyProjectUploadFile({
      kind: 'legacy',
      associationResolved: photo.studentId !== null && student !== undefined,
      status: photo.uploadStatus,
    }) !== 'blocked') continue
    blockedItems.push({
      key: `legacy:${photo.id}`,
      kind: 'legacy',
      fileName: photo.fileName,
      fileRole: 'JPEG',
      subject: 'Waiting for student match',
      capturedAt: photo.capturedAt,
      status: 'blocked',
      blockedReason: 'This legacy portrait has no student match yet.',
      attempts: 0,
    })
  }
  return [...uploadableItems, ...blockedItems]
}

function emitLiveUploadState(projectId: number): void {
  BrowserWindow.getAllWindows()[0]?.webContents.send('upload:liveStateChanged', getLiveUploadState(projectId))
}

function getProjectLiveUploadJobs(projectId: number, includeErrors: boolean): ProjectSyncJob[] {
  const snapshot = loadProjectUploadSnapshot(projectId)
  const jobs = getProjectSyncJobsFromSnapshot(projectId, snapshot).filter((job) => {
    const status = job.kind === 'capture-file'
      ? snapshot.captureFiles.get(job.fileId)?.uploadStatus
      : job.kind === 'group-capture-file'
        ? snapshot.groupCaptureFiles.get(job.fileId)?.uploadStatus
        : snapshot.legacyPhotos.get(job.photoId)?.photo.uploadStatus
    return status !== 'error' || includeErrors
  })
  if (includeErrors) return jobs
  return getEligibleUploadJobs(jobs, projectSyncJobKey, failedUploadRetryAfter, Date.now())
}

async function uploadProjectJob(job: ProjectSyncJob, captureBatchKey?: string): Promise<void> {
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
  if (!includeErrors && (failedLiveRunRetryAfter.get(projectId) ?? 0) > Date.now()) return

  const task = startActiveUploadRun(activeLiveUploadRuns, projectId, async () => {
    try {
      const jobs = getProjectLiveUploadJobs(projectId, includeErrors)
      if (jobs.length === 0) return
      // The server keeps the greatest expected count for this retry-stable key.
      // As a shoot grows, every live upload therefore belongs to the same batch
      // that Finish My Shoot will eventually close.
      const captureBatchKey = await beginProjectCaptureBatch(
        projectId,
        registerProjectBatchJobs(projectId, jobs),
      )
      failedLiveRunRetryAfter.delete(projectId)
      failedLiveRunAttempts.delete(projectId)
      let groupIdentityPromise: Promise<void> | undefined
      await runWithConcurrency(jobs, MAX_CONCURRENT_UPLOADS, async (job) => {
        if (!isCloudSessionVerified()) return
        try {
          if (job.kind === 'group-capture-file') {
            groupIdentityPromise ??= syncGroupCloudIdentities(projectId)
            await groupIdentityPromise
          }
          await uploadProjectJob(job, captureBatchKey)
          failedUploadRetryAfter.delete(projectSyncJobKey(job))
          failedUploadAttempts.delete(projectSyncJobKey(job))
          failedUploadErrors.delete(projectSyncJobKey(job))
          liveUploadActivity.set(projectId, { lastUploadedAt: new Date().toISOString() })
        } catch (error) {
          deferFailedJob(job, error)
          liveUploadActivity.set(projectId, {
            ...liveUploadActivity.get(projectId),
            lastError: getUploadErrorMessage(error),
          })
          if (!isCloudSessionVerified()) return
        }
        emitLiveUploadState(projectId)
      })
    } catch (error) {
      deferFailedRun(projectId)
      liveUploadActivity.set(projectId, {
        ...liveUploadActivity.get(projectId),
        lastError: getUploadErrorMessage(error),
      })
    }
  }, () => emitLiveUploadState(projectId))
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

export function notifyLiveUploadJobQueued(projectId: number): void {
  if (!isLiveUploadEnabled(projectId)) return
  failedLiveRunRetryAfter.delete(projectId)
  failedLiveRunAttempts.delete(projectId)
  ensureLiveUploadTimer(projectId)
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
 * photographer. A bounded worker pool shortens the wait while per-file
 * completion remains explicit and an offline transition cannot silently count
 * skipped work as complete.
 */
export interface ProjectSyncUploadDependencies {
  getJobs: (projectId: number, includeDone?: boolean) => ProjectSyncJob[]
  isCloudSessionVerified: () => boolean
  uploadProjectJob: (job: ProjectSyncJob, captureBatchKey?: string) => Promise<void>
}

export async function syncProjectUploads(
  projectId: number,
  onProgress?: (progress: ProjectSyncProgress) => void,
  captureBatchKey?: string,
  dependencies: ProjectSyncUploadDependencies = {
    getJobs: getProjectSyncJobs,
    isCloudSessionVerified,
    uploadProjectJob,
  },
): Promise<ProjectSyncProgress> {
  const allJobs = uniqueProjectSyncJobs(dependencies.getJobs(projectId, true))
  const allJobKeys = new Set(allJobs.map(projectSyncJobKey))
  const jobs = uniqueProjectSyncJobs(dependencies.getJobs(projectId))
    .filter((job) => allJobKeys.has(projectSyncJobKey(job)))
  // Count already-done JPEG, RAW, legacy, and gallery-preparation work so a
  // retry reports durable whole-project progress rather than restarting at 0.
  let completed = Math.min(allJobs.length, Math.max(0, allJobs.length - jobs.length))
  let failed = 0
  let firstError: string | undefined
  const report = () => onProgress?.({
    completed,
    total: allJobs.length,
    failed,
    error: firstError,
  })
  report()

  await runWithConcurrency(jobs, MAX_CONCURRENT_UPLOADS, async (job) => {
    let uploaded = false
    try {
      if (!dependencies.isCloudSessionVerified()) {
        throw new Error('Cloud sync is unavailable. Local captures are safe; reconnect and try again.')
      }
      await dependencies.uploadProjectJob(job, captureBatchKey)
      uploaded = true
    } catch (error) {
      failed++
      firstError ??= getUploadErrorMessage(error)
    }
    // A failed job remains pending/retryable. Only durable upload success
    // may advance completed, which keeps completed + remaining coherent.
    if (uploaded) completed = Math.min(allJobs.length, completed + 1)
    report()
  })

  return {
    completed,
    total: allJobs.length,
    failed,
    ...(firstError ? { error: firstError } : {}),
  }
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
  photographerComment?: string,
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
    body: JSON.stringify({
      status,
      failedFileCount,
      ...(photographerComment?.trim() ? { handoffComment: photographerComment.trim() } : {}),
    }),
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
  ipcMain.handle('upload:deleteUnmatched', async (_e, { projectId, key }: { projectId: number; key: string }) => {
    if (!/^capture:\d+$/.test(key)) throw new Error('Only unmatched capture files can be deleted here.')
    const fileId = Number(key.slice('capture:'.length))
    const db = getDb()
    const file = db.select().from(imageFilesTable).where(eq(imageFilesTable.id, fileId)).get()
    const capture = file && db.select().from(capturesTable).where(eq(capturesTable.id, file.captureId)).get()
    if (!file || !capture || capture.projectId !== projectId || capture.studentId !== null
      || file.uploadStatus === 'done' || file.uploadStatus === 'uploading') {
      throw new Error('This file is no longer an unmatched, waiting capture.')
    }
    const confirmation = await dialog.showMessageBox({
      type: 'warning',
      title: 'Delete unmatched file?',
      message: `Delete ${file.originalFilename} from Volume Capture?`,
      detail: 'This removes this file from the project and blocked queue. Original camera files and existing disk copies are kept. This source will not be automatically imported again.',
      buttons: ['Cancel', 'Delete from project'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    })
    if (confirmation.response !== 1) return { deleted: false }
    db.transaction(() => {
      const current = db.select().from(capturesTable).where(eq(capturesTable.id, capture.id)).get()
      const currentFile = db.select().from(imageFilesTable).where(eq(imageFilesTable.id, fileId)).get()
      if (!current || current.studentId !== null || !currentFile
        || currentFile.uploadStatus === 'done' || currentFile.uploadStatus === 'uploading') {
        throw new Error('The capture changed while confirming. Nothing was deleted.')
      }
      for (const path of [file.sourcePath, file.storedPath]) {
        if (path) setSetting(`discarded_capture_source:${path}`, '1')
      }
      db.delete(imageFilesTable).where(eq(imageFilesTable.id, fileId)).run()
      if (file.fileRole === 'JPEG' && current.legacyPhotoId !== null) {
        db.update(capturesTable).set({ legacyPhotoId: null }).where(eq(capturesTable.id, current.id)).run()
        db.delete(photosTable).where(eq(photosTable.id, current.legacyPhotoId)).run()
      }
      const remaining = db.select().from(imageFilesTable).where(eq(imageFilesTable.captureId, current.id)).all()
      if (!remaining.length) db.delete(capturesTable).where(eq(capturesTable.id, current.id)).run()
      else db.update(capturesTable).set({
        pairingStatus: remaining.some((row) => row.fileRole === 'JPEG') ? 'jpeg_only' : 'raw_only',
      }).where(eq(capturesTable.id, current.id)).run()
    })
    emitLiveUploadState(projectId)
    BrowserWindow.getAllWindows()[0]?.webContents.send('capture:updated', {
      projectId, captureId: capture.id, studentId: null,
    })
    return { deleted: true }
  })
  ipcMain.handle('upload:getLiveState', (_e, { projectId }: { projectId: number }) => {
    if (isLiveUploadEnabled(projectId)) ensureLiveUploadTimer(projectId)
    return getLiveUploadState(projectId)
  })
  ipcMain.handle('upload:getQueue', (_e, { projectId }: { projectId: number }) =>
    getLiveUploadQueue(projectId))
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
    await syncPendingGroupCaptureReviews(projectId)
    return getLiveUploadState(projectId)
  })
  ipcMain.handle('upload:retryProjectFailed', async (_e, { projectId }: { projectId: number }) => {
    await runLiveUpload(projectId, true)
    await syncPendingCaptureReviews(projectId)
    await syncPendingGroupCaptureReviews(projectId)
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
        await syncPendingGroupCaptureReviews()
        return { ok: true }
      }
      if (response.status === 401) invalidateDesktopCredentials(true)
      else if (response.status >= 500) markCloudSessionUnavailable()
      const body = await response.json().catch(() => ({})) as { error?: string }
      return { ok: false, error: body.error ?? `Server returned ${response.status}` }
    } catch (err) {
      markCloudSessionUnavailable()
      return { ok: false, error: getUploadErrorMessage(err) }
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
      return { ok: false, error: getUploadErrorMessage(err) }
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
      return { ok: false, error: getUploadErrorMessage(error) }
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
      return { ok: false, error: getUploadErrorMessage(error) }
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
