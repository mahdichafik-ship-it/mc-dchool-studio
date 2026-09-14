import { BrowserWindow, ipcMain } from 'electron'
import { eq } from 'drizzle-orm'
import { getDb } from '../db'
import { projectsTable } from '../db/schema'
import { stopProjectWatcher } from './watcher'
import {
  getUploadConfig,
  beginProjectCaptureBatch,
  finishProjectCaptureBatch,
  getProjectCaptureBatchExpectedCount,
  getProjectUploadBlockerCount,
  isCloudSessionVerified,
  syncProjectUploads,
  syncGroupCloudIdentities,
  flushPendingCaptureReviews,
  pauseLiveUploadForFinish,
} from './upload'
import type { ProjectSyncProgress } from './upload'
import type { ProjectFinishOptions, ProjectSyncProgressEvent, ProjectSyncResult, ProjectSyncStatus } from '../../shared/types'
import { hasPendingReviewSync } from '../lib/reviewSyncBarrier'

const activeSyncs = new Map<number, Promise<ProjectSyncResult>>()

function emitProgress(event: ProjectSyncProgressEvent): void {
  const win = BrowserWindow.getAllWindows()[0]
  win?.webContents.send('project:syncProgress', event)
}

function updateProjectSync(
  projectId: number,
  values: Partial<{
    syncStatus: ProjectSyncStatus
    syncCompletedFiles: number
    syncTotalFiles: number
    syncFailedFiles: number
    syncError: string | null
    finishedAt: string
    updatedAt: string
  }>,
): void {
  getDb().update(projectsTable).set(values).where(eq(projectsTable.id, projectId)).run()
}

type LocalProject = typeof projectsTable.$inferSelect
type ProjectSyncUpdate = Parameters<typeof updateProjectSync>[1]

function boundedCompleted(completed: number, total: number): number {
  return Math.min(Math.max(0, completed), Math.max(0, total))
}

export interface ProjectSyncDependencies {
  getProject: (projectId: number) => LocalProject | undefined
  updateProject: (projectId: number, values: ProjectSyncUpdate) => void
  emitProgress: (event: ProjectSyncProgressEvent) => void
  pauseLiveUploadForFinish: (projectId: number) => Promise<void>
  stopProjectWatcher: (projectId: number, options: { drain: boolean; clearTarget: boolean }) => Promise<void>
  getUploadConfig: typeof getUploadConfig
  isCloudSessionVerified: typeof isCloudSessionVerified
  getProjectCaptureBatchExpectedCount: typeof getProjectCaptureBatchExpectedCount
  getProjectUploadBlockerCount: typeof getProjectUploadBlockerCount
  syncGroupCloudIdentities: typeof syncGroupCloudIdentities
  beginProjectCaptureBatch: typeof beginProjectCaptureBatch
  syncProjectUploads: typeof syncProjectUploads
  flushPendingCaptureReviews: typeof flushPendingCaptureReviews
  finishProjectCaptureBatch: typeof finishProjectCaptureBatch
}

function createProductionDependencies(): ProjectSyncDependencies {
  return {
    getProject: (projectId) => getDb().select().from(projectsTable).where(eq(projectsTable.id, projectId)).get(),
    updateProject: updateProjectSync,
    emitProgress,
    pauseLiveUploadForFinish,
    stopProjectWatcher,
    getUploadConfig,
    isCloudSessionVerified,
    getProjectCaptureBatchExpectedCount,
    getProjectUploadBlockerCount,
    syncGroupCloudIdentities,
    beginProjectCaptureBatch,
    syncProjectUploads,
    flushPendingCaptureReviews,
    finishProjectCaptureBatch,
  }
}

export async function runProjectSync(
  projectId: number,
  { photographerComment }: ProjectFinishOptions,
  deps: ProjectSyncDependencies = createProductionDependencies(),
): Promise<ProjectSyncResult> {
  const normalizedComment = photographerComment?.trim().slice(0, 2000) || undefined
  try {
    const project = deps.getProject(projectId)
    if (!project) {
      return { ok: false, completed: 0, total: 0, failed: 0, error: 'Project not found.' }
    }
    if (project.syncStatus === 'synced') {
      const total = Math.max(0, project.syncTotalFiles)
      return {
        ok: true,
        completed: boundedCompleted(project.syncCompletedFiles, total),
        total,
        failed: project.syncFailedFiles,
        finishedAt: project.finishedAt,
        syncStatus: 'synced',
      }
    }

    // Finish is the durable local boundary. It is intentionally performed
    // before any cloud check so a lost connection cannot lose captures or
    // leave the watcher accepting files after the photographer is done.
    if (project.syncStatus === 'active') {
      await deps.pauseLiveUploadForFinish(projectId)
      await deps.stopProjectWatcher(projectId, { drain: true, clearTarget: true })
      const finishedAt = project.finishedAt ?? new Date().toISOString()
      const total = deps.getProjectCaptureBatchExpectedCount(projectId)
      deps.updateProject(projectId, {
        finishedAt,
        syncStatus: 'finished_local',
        syncCompletedFiles: 0,
        syncTotalFiles: total,
        syncFailedFiles: 0,
        syncError: null,
        updatedAt: finishedAt,
      })
    }

    const locallyFinished = deps.getProject(projectId)
    if (!locallyFinished) {
      return { ok: false, completed: 0, total: 0, failed: 0, error: 'Project not found.' }
    }
    const { apiUrl, connectionToken } = deps.getUploadConfig()
    if (!apiUrl || !connectionToken || !deps.isCloudSessionVerified()) {
      const offlineStatus = locallyFinished.syncStatus === 'sync_failed' ? 'sync_failed' : 'finished_local'
      const total = Math.max(0, locallyFinished.syncTotalFiles || deps.getProjectCaptureBatchExpectedCount(projectId))
      const completed = boundedCompleted(locallyFinished.syncCompletedFiles, total)
      deps.updateProject(projectId, {
        syncStatus: offlineStatus,
        syncCompletedFiles: completed,
        syncError: 'Local completion saved. Reconnect to Volume Capture and retry Upload & Finish to sync the cloud.',
        updatedAt: new Date().toISOString(),
      })
      deps.emitProgress({
        projectId,
        phase: offlineStatus === 'sync_failed' ? 'error' : 'finished-locally',
        completed,
        total,
        failed: locallyFinished.syncFailedFiles,
        error: 'Local completion saved. Reconnect to Volume Capture and retry Upload & Finish to sync the cloud.',
      })
      return {
        ok: false,
        completed,
        total,
        failed: locallyFinished.syncFailedFiles,
        localFinished: true,
        syncStatus: offlineStatus,
        finishedAt: locallyFinished.finishedAt ?? undefined,
        error: 'Local completion saved. Reconnect to Volume Capture and retry Upload & Finish to sync the cloud.',
      }
    }

    deps.updateProject(projectId, {
      syncStatus: 'syncing',
      syncError: null,
      updatedAt: new Date().toISOString(),
    })
    const blockedFileCount = deps.getProjectUploadBlockerCount(projectId)
    if (blockedFileCount > 0) {
      const message = `${blockedFileCount} local capture file${blockedFileCount === 1 ? '' : 's'} still need a student match before cloud sync can complete.`
      deps.updateProject(projectId, {
        syncStatus: 'sync_failed',
        syncCompletedFiles: boundedCompleted(locallyFinished.syncCompletedFiles, locallyFinished.syncTotalFiles),
        syncFailedFiles: blockedFileCount,
        syncError: message,
        updatedAt: new Date().toISOString(),
      })
      const result: ProjectSyncResult = {
        ok: false,
        completed: boundedCompleted(locallyFinished.syncCompletedFiles, locallyFinished.syncTotalFiles),
        total: Math.max(0, locallyFinished.syncTotalFiles),
        failed: blockedFileCount,
        localFinished: true,
        syncStatus: 'sync_failed',
        finishedAt: locallyFinished.finishedAt ?? undefined,
        error: message,
      }
      deps.emitProgress({ projectId, phase: 'error', ...result })
      return result
    }
    // Group captures use a separate cloud identity contract. Reconcile
    // every group before counting or uploading files so no group is
    // silently skipped.
    await deps.syncGroupCloudIdentities(projectId)

    const expectedFileCount = locallyFinished.syncTotalFiles || deps.getProjectCaptureBatchExpectedCount(projectId)
    const startingCompleted = boundedCompleted(locallyFinished.syncCompletedFiles, expectedFileCount)
    deps.updateProject(projectId, {
      syncTotalFiles: expectedFileCount,
      syncCompletedFiles: startingCompleted,
    })
    deps.emitProgress({
      projectId,
      phase: 'syncing',
      completed: startingCompleted,
      total: expectedFileCount,
      failed: locallyFinished.syncFailedFiles,
    })

    const captureBatchKey = await deps.beginProjectCaptureBatch(projectId, expectedFileCount)
    const progress = await deps.syncProjectUploads(projectId, (current) => {
      deps.updateProject(projectId, {
        syncStatus: 'syncing',
        syncCompletedFiles: current.completed,
        syncTotalFiles: current.total,
        syncFailedFiles: current.failed,
        syncError: current.error ?? null,
        updatedAt: new Date().toISOString(),
      })
      deps.emitProgress({
        projectId,
        phase: 'syncing',
        ...current,
      })
    }, captureBatchKey)

    if (progress.failed > 0) {
      let batchStatusError: string | undefined
      try {
        await deps.finishProjectCaptureBatch(projectId, captureBatchKey, 'failed', progress.failed, normalizedComment)
      } catch (error) {
        batchStatusError = ` Batch status could not be updated: ${String(error)}`
      }
      deps.updateProject(projectId, {
        syncStatus: 'sync_failed',
        syncCompletedFiles: progress.completed,
        syncTotalFiles: progress.total,
        syncFailedFiles: progress.failed,
        syncError: progress.error ?? 'One or more local files could not be uploaded.',
        updatedAt: new Date().toISOString(),
      })
      const result: ProjectSyncResult = {
        ok: false,
        ...progress,
        localFinished: true,
        syncStatus: 'sync_failed',
        finishedAt: locallyFinished.finishedAt ?? undefined,
        error: `${progress.error ?? 'One or more local files could not be uploaded.'}${batchStatusError ?? ''}`,
      }
      deps.emitProgress({
        projectId,
        phase: 'error',
        ...result,
      })
      return result
    }

    // File uploads and review/edit PATCHes are separate durable writes.
    // Flush the latter before closing the batch; an offline, 404, or
    // superseded response leaves its pending flag set and therefore keeps
    // Finish My Shoot retryable instead of falsely completing the shoot.
    const pendingReviews = await deps.flushPendingCaptureReviews(projectId)
    const pendingReviewCount = pendingReviews.portrait + pendingReviews.group
    if (hasPendingReviewSync(pendingReviews)) {
      let batchStatusError: string | undefined
      try {
        await deps.finishProjectCaptureBatch(projectId, captureBatchKey, 'failed', progress.failed, normalizedComment)
      } catch (error) {
        batchStatusError = ` Batch status could not be updated: ${String(error)}`
      }
      deps.updateProject(projectId, {
        syncStatus: 'sync_failed',
        syncCompletedFiles: progress.completed,
        syncTotalFiles: progress.total,
        syncFailedFiles: progress.failed,
        syncError: `${pendingReviewCount} capture review or framing change${pendingReviewCount === 1 ? '' : 's'} remains unsynced.`,
        updatedAt: new Date().toISOString(),
      })
      const result: ProjectSyncResult = {
        ok: false,
        ...progress,
        localFinished: true,
        syncStatus: 'sync_failed',
        finishedAt: locallyFinished.finishedAt ?? undefined,
        error: `${pendingReviewCount} capture review or framing change${pendingReviewCount === 1 ? ' remains' : 's remain'} unsynced. Retry Upload & Finish when the connection is available.${batchStatusError ?? ''}`,
      }
      deps.emitProgress({
        projectId,
        phase: 'error',
        ...result,
      })
      return result
    }

    try {
      await deps.finishProjectCaptureBatch(projectId, captureBatchKey, 'complete', 0, normalizedComment)
    } catch (error) {
      deps.updateProject(projectId, {
        syncStatus: 'sync_failed',
        syncCompletedFiles: progress.completed,
        syncTotalFiles: progress.total,
        syncFailedFiles: 0,
        syncError: `Files uploaded, but the photographer batch could not be confirmed. ${String(error)}`,
        updatedAt: new Date().toISOString(),
      })
      const result: ProjectSyncResult = {
        ok: false,
        ...progress,
        localFinished: true,
        syncStatus: 'sync_failed',
        finishedAt: locallyFinished.finishedAt ?? undefined,
        error: `Files uploaded, but the photographer batch could not be confirmed. Retry Upload & Finish. ${String(error)}`,
      }
      deps.emitProgress({
        projectId,
        phase: 'error',
        ...result,
      })
      return result
    }

    const finishedAt = locallyFinished.finishedAt ?? new Date().toISOString()
    deps.updateProject(projectId, {
      finishedAt,
      syncStatus: 'synced',
      syncCompletedFiles: progress.total,
      syncTotalFiles: progress.total,
      syncFailedFiles: 0,
      syncError: null,
      updatedAt: new Date().toISOString(),
    })

    const result: ProjectSyncResult = { ok: true, ...progress, completed: progress.total, finishedAt, syncStatus: 'synced' }
    deps.emitProgress({
      projectId,
      phase: 'finished',
      ...progress,
    })
    return result
  } catch (error) {
    const current = deps.getProject(projectId)
    const message = String(error instanceof Error ? error.message : error)
    const result: ProjectSyncResult = {
      ok: false,
      completed: boundedCompleted(current?.syncCompletedFiles ?? 0, current?.syncTotalFiles ?? 0),
      total: Math.max(0, current?.syncTotalFiles ?? 0),
      failed: current?.syncFailedFiles ?? 0,
      localFinished: Boolean(current?.finishedAt),
      syncStatus: current?.finishedAt ? 'sync_failed' : 'active',
      finishedAt: current?.finishedAt ?? undefined,
      error: `Cloud sync could not continue. Local captures are safe; reconnect and retry Upload & Finish. ${message}`,
    }
    if (current?.finishedAt) {
      deps.updateProject(projectId, {
        syncStatus: 'sync_failed',
        syncCompletedFiles: result.completed,
        syncError: result.error,
        updatedAt: new Date().toISOString(),
      })
    }
    deps.emitProgress({ projectId, phase: 'error', ...result })
    return result
  }
}

export function registerProjectSyncHandlers(): void {
  ipcMain.handle(
    'project:uploadAndFinish',
    async (
      _event,
      { projectId, photographerComment }: { projectId: number } & ProjectFinishOptions,
    ): Promise<ProjectSyncResult> => {
      const existing = activeSyncs.get(projectId)
      if (existing) return existing
      const task = runProjectSync(projectId, { photographerComment })
      activeSyncs.set(projectId, task)
      try {
        return await task
      } finally {
        activeSyncs.delete(projectId)
      }
    },
  )
}

function registerProjectSyncHandlersLegacy(): void {
  ipcMain.handle(
    'project:uploadAndFinish',
    async (
      _event,
      {
        projectId,
        photographerComment,
      }: { projectId: number } & ProjectFinishOptions,
    ): Promise<ProjectSyncResult> => {
      const existing = activeSyncs.get(projectId)
      if (existing) return existing

      const task = (async (): Promise<ProjectSyncResult> => {
        const db = getDb()
        const normalizedComment = photographerComment?.trim().slice(0, 2000) || undefined
        const project = db
          .select()
          .from(projectsTable)
          .where(eq(projectsTable.id, projectId))
          .get()
        if (!project) {
          return { ok: false, completed: 0, total: 0, failed: 0, error: 'Project not found.' }
        }
        if (project.syncStatus === 'synced') {
          return {
            ok: true,
            completed: project.syncCompletedFiles,
            total: project.syncTotalFiles,
            failed: project.syncFailedFiles,
            finishedAt: project.finishedAt,
            syncStatus: 'synced',
          }
        }

        // Finish is the durable local boundary. It is intentionally performed
        // before any cloud check so a lost connection cannot lose captures or
        // leave the watcher accepting files after the photographer is done.
        if (project.syncStatus === 'active') {
          await pauseLiveUploadForFinish(projectId)
          await stopProjectWatcher(projectId, { drain: true, clearTarget: true })
          const finishedAt = project.finishedAt ?? new Date().toISOString()
          const total = getProjectCaptureBatchExpectedCount(projectId)
          updateProjectSync(projectId, {
            finishedAt,
            syncStatus: 'finished_local',
            syncCompletedFiles: 0,
            syncTotalFiles: total,
            syncFailedFiles: 0,
            syncError: null,
            updatedAt: finishedAt,
          })
        }

        const locallyFinished = db.select().from(projectsTable).where(eq(projectsTable.id, projectId)).get()
        if (!locallyFinished) {
          return { ok: false, completed: 0, total: 0, failed: 0, error: 'Project not found.' }
        }
        const { apiUrl, connectionToken } = getUploadConfig()
        if (!apiUrl || !connectionToken || !isCloudSessionVerified()) {
          updateProjectSync(projectId, {
            syncStatus: 'finished_local',
            syncError: 'Local completion saved. Reconnect to Volume Capture and retry Upload & Finish to sync the cloud.',
            updatedAt: new Date().toISOString(),
          })
          const total = locallyFinished.syncTotalFiles || getProjectCaptureBatchExpectedCount(projectId)
          emitProgress({
            projectId,
            phase: 'finished-locally',
            completed: locallyFinished.syncCompletedFiles,
            total,
            failed: locallyFinished.syncFailedFiles,
            error: 'Local completion saved. Reconnect to Volume Capture and retry Upload & Finish to sync the cloud.',
          })
          return {
            ok: false,
            completed: locallyFinished.syncCompletedFiles,
            total,
            failed: locallyFinished.syncFailedFiles,
            localFinished: true,
            syncStatus: 'finished_local',
            finishedAt: locallyFinished.finishedAt ?? undefined,
            error: 'Local completion saved. Reconnect to Volume Capture and retry Upload & Finish to sync the cloud.',
          }
        }

        updateProjectSync(projectId, {
          syncStatus: 'syncing',
          syncError: null,
          updatedAt: new Date().toISOString(),
        })
        const blockedFileCount = getProjectUploadBlockerCount(projectId)
        if (blockedFileCount > 0) {
          const message = `${blockedFileCount} local capture file${blockedFileCount === 1 ? '' : 's'} still need a student match before cloud sync can complete.`
          updateProjectSync(projectId, {
            syncStatus: 'sync_failed',
            syncFailedFiles: blockedFileCount,
            syncError: message,
            updatedAt: new Date().toISOString(),
          })
          const result: ProjectSyncResult = {
            ok: false,
            completed: locallyFinished.syncCompletedFiles,
            total: locallyFinished.syncTotalFiles,
            failed: blockedFileCount,
            localFinished: true,
            syncStatus: 'sync_failed',
            finishedAt: locallyFinished.finishedAt ?? undefined,
            error: message,
          }
          emitProgress({ projectId, phase: 'error', ...result })
          return result
        }
        // Group captures use a separate cloud identity contract. Reconcile
        // every group before counting or uploading files so no group is
        // silently skipped.
        await syncGroupCloudIdentities(projectId)

        const expectedFileCount = locallyFinished.syncTotalFiles || getProjectCaptureBatchExpectedCount(projectId)
        updateProjectSync(projectId, { syncTotalFiles: expectedFileCount })
        emitProgress({
          projectId,
          phase: 'syncing',
          completed: locallyFinished.syncCompletedFiles,
          total: expectedFileCount,
          failed: locallyFinished.syncFailedFiles,
        })

        const captureBatchKey = await beginProjectCaptureBatch(projectId, expectedFileCount)
        const progress = await syncProjectUploads(projectId, (current) => {
          updateProjectSync(projectId, {
            syncStatus: 'syncing',
            syncCompletedFiles: current.completed,
            syncTotalFiles: current.total,
            syncFailedFiles: current.failed,
            syncError: current.error ?? null,
            updatedAt: new Date().toISOString(),
          })
          emitProgress({
            projectId,
            phase: 'syncing',
            ...current,
          })
        }, captureBatchKey)

        if (progress.failed > 0) {
          let batchStatusError: string | undefined
          try {
            await finishProjectCaptureBatch(projectId, captureBatchKey, 'failed', progress.failed, normalizedComment)
          } catch (error) {
            batchStatusError = ` Batch status could not be updated: ${String(error)}`
          }
          updateProjectSync(projectId, {
            syncStatus: 'sync_failed',
            syncCompletedFiles: progress.completed,
            syncTotalFiles: progress.total,
            syncFailedFiles: progress.failed,
            syncError: progress.error ?? 'One or more local files could not be uploaded.',
            updatedAt: new Date().toISOString(),
          })
          const result: ProjectSyncResult = {
            ok: false,
            ...progress,
            localFinished: true,
            syncStatus: 'sync_failed',
            finishedAt: locallyFinished.finishedAt ?? undefined,
            error: `${progress.error ?? 'One or more local files could not be uploaded.'}${batchStatusError ?? ''}`,
          }
          emitProgress({
            projectId,
            phase: 'error',
            ...result,
          })
          return result
        }

        // File uploads and review/edit PATCHes are separate durable writes.
        // Flush the latter before closing the batch; an offline, 404, or
        // superseded response leaves its pending flag set and therefore keeps
        // Finish My Shoot retryable instead of falsely completing the shoot.
        const pendingReviews = await flushPendingCaptureReviews(projectId)
        const pendingReviewCount = pendingReviews.portrait + pendingReviews.group
        if (hasPendingReviewSync(pendingReviews)) {
          let batchStatusError: string | undefined
          try {
            await finishProjectCaptureBatch(projectId, captureBatchKey, 'failed', progress.failed, normalizedComment)
          } catch (error) {
            batchStatusError = ` Batch status could not be updated: ${String(error)}`
          }
          updateProjectSync(projectId, {
            syncStatus: 'sync_failed',
            syncCompletedFiles: progress.completed,
            syncTotalFiles: progress.total,
            syncFailedFiles: progress.failed,
            syncError: `${pendingReviewCount} capture review or framing change${pendingReviewCount === 1 ? '' : 's'} remains unsynced.`,
            updatedAt: new Date().toISOString(),
          })
          const result: ProjectSyncResult = {
            ok: false,
            ...progress,
            localFinished: true,
            syncStatus: 'sync_failed',
            finishedAt: locallyFinished.finishedAt ?? undefined,
            error: `${pendingReviewCount} capture review or framing change${pendingReviewCount === 1 ? ' remains' : 's remain'} unsynced. Retry Upload & Finish when the connection is available.${batchStatusError ?? ''}`,
          }
          emitProgress({
            projectId,
            phase: 'error',
            ...result,
          })
          return result
        }

        try {
          await finishProjectCaptureBatch(projectId, captureBatchKey, 'complete', 0, normalizedComment)
        } catch (error) {
          updateProjectSync(projectId, {
            syncStatus: 'sync_failed',
            syncCompletedFiles: progress.completed,
            syncTotalFiles: progress.total,
            syncFailedFiles: 0,
            syncError: `Files uploaded, but the photographer batch could not be confirmed. ${String(error)}`,
            updatedAt: new Date().toISOString(),
          })
          const result: ProjectSyncResult = {
            ok: false,
            ...progress,
            localFinished: true,
            syncStatus: 'sync_failed',
            finishedAt: locallyFinished.finishedAt ?? undefined,
            error: `Files uploaded, but the photographer batch could not be confirmed. Retry Upload & Finish. ${String(error)}`,
          }
          emitProgress({
            projectId,
            phase: 'error',
            ...result,
          })
          return result
        }

        const finishedAt = locallyFinished.finishedAt ?? new Date().toISOString()
        updateProjectSync(projectId, {
          finishedAt,
          syncStatus: 'synced',
          syncCompletedFiles: progress.total,
          syncTotalFiles: progress.total,
          syncFailedFiles: 0,
          syncError: null,
          updatedAt: new Date().toISOString(),
        })

        const result: ProjectSyncResult = { ok: true, ...progress, completed: progress.total, finishedAt, syncStatus: 'synced' }
        emitProgress({
          projectId,
          phase: 'finished',
          ...progress,
        })
        return result
      })().catch((error): ProjectSyncResult => {
        const current = getDb().select().from(projectsTable).where(eq(projectsTable.id, projectId)).get()
        const message = String(error instanceof Error ? error.message : error)
        const result: ProjectSyncResult = {
          ok: false,
          completed: current?.syncCompletedFiles ?? 0,
          total: current?.syncTotalFiles ?? 0,
          failed: current?.syncFailedFiles ?? 0,
          localFinished: Boolean(current?.finishedAt),
          syncStatus: current?.finishedAt ? 'sync_failed' : 'active',
          finishedAt: current?.finishedAt ?? undefined,
          error: `Cloud sync could not continue. Local captures are safe; reconnect and retry Upload & Finish. ${message}`,
        }
        if (current?.finishedAt) {
          updateProjectSync(projectId, {
            syncStatus: 'sync_failed',
            syncError: result.error,
            updatedAt: new Date().toISOString(),
          })
        }
        emitProgress({ projectId, phase: 'error', ...result })
        return result
      })

      activeSyncs.set(projectId, task)
      try {
        return await task
      } finally {
        activeSyncs.delete(projectId)
      }
    },
  )
}