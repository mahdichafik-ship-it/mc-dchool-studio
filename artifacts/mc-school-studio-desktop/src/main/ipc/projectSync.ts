import { BrowserWindow, ipcMain } from 'electron'
import { eq } from 'drizzle-orm'
import { getDb } from '../db'
import { projectsTable } from '../db/schema'
import { stopProjectWatcher } from './watcher'
import {
  getUploadConfig,
  beginProjectCaptureBatch,
  finishProjectCaptureBatch,
  getProjectSyncJobCount,
  isCloudSessionVerified,
  syncProjectUploads,
} from './upload'
import type { ProjectSyncProgressEvent, ProjectSyncResult } from '../../shared/types'

const activeSyncs = new Map<number, Promise<ProjectSyncResult>>()

function emitProgress(event: ProjectSyncProgressEvent): void {
  const win = BrowserWindow.getAllWindows()[0]
  win?.webContents.send('project:syncProgress', event)
}

export function registerProjectSyncHandlers(): void {
  ipcMain.handle(
    'project:uploadAndFinish',
    async (_event, { projectId }: { projectId: number }): Promise<ProjectSyncResult> => {
      const existing = activeSyncs.get(projectId)
      if (existing) return existing

      const task = (async (): Promise<ProjectSyncResult> => {
        const db = getDb()
        const project = db
          .select()
          .from(projectsTable)
          .where(eq(projectsTable.id, projectId))
          .get()
        if (!project) {
          return { ok: false, completed: 0, total: 0, failed: 0, error: 'Project not found.' }
        }
        if (project.finishedAt) {
          return {
            ok: true,
            completed: 0,
            total: 0,
            failed: 0,
            finishedAt: project.finishedAt,
          }
        }

        const { apiUrl, connectionToken } = getUploadConfig()
        if (!apiUrl || !connectionToken || !isCloudSessionVerified()) {
          return {
            ok: false,
            completed: 0,
            total: 0,
            failed: 0,
            error: 'Connect to Volume Capture before finishing this project. Local captures remain safe.',
          }
        }

        // Stop accepting new files first, then finish processing anything
        // already detected in the native Watch Folder queue.
        await stopProjectWatcher(projectId, { drain: true, clearTarget: true })

        emitProgress({
          projectId,
          phase: 'syncing',
          completed: 0,
          total: 0,
          failed: 0,
        })

        const expectedFileCount = getProjectSyncJobCount(projectId)
        const captureBatchKey = await beginProjectCaptureBatch(projectId, expectedFileCount)
        const progress = await syncProjectUploads(projectId, (current) => {
          emitProgress({
            projectId,
            phase: 'syncing',
            ...current,
          })
        }, captureBatchKey)

        if (progress.failed > 0) {
          let batchStatusError: string | undefined
          try {
            await finishProjectCaptureBatch(projectId, captureBatchKey, 'failed', progress.failed)
          } catch (error) {
            batchStatusError = ` Batch status could not be updated: ${String(error)}`
          }
          const result: ProjectSyncResult = {
            ok: false,
            ...progress,
            error: `${progress.error ?? 'One or more local files could not be uploaded.'}${batchStatusError ?? ''}`,
          }
          emitProgress({
            projectId,
            phase: 'error',
            ...result,
          })
          return result
        }

        try {
          await finishProjectCaptureBatch(projectId, captureBatchKey, 'complete', 0)
        } catch (error) {
          const result: ProjectSyncResult = {
            ok: false,
            ...progress,
            error: `Files uploaded, but the photographer batch could not be confirmed. Retry Upload & Finish. ${String(error)}`,
          }
          emitProgress({
            projectId,
            phase: 'error',
            ...result,
          })
          return result
        }

        const finishedAt = new Date().toISOString()
        db.update(projectsTable)
          .set({ finishedAt, updatedAt: finishedAt })
          .where(eq(projectsTable.id, projectId))
          .run()

        const result: ProjectSyncResult = { ok: true, ...progress, finishedAt }
        emitProgress({
          projectId,
          phase: 'finished',
          ...progress,
        })
        return result
      })()

      activeSyncs.set(projectId, task)
      try {
        return await task
      } finally {
        activeSyncs.delete(projectId)
      }
    },
  )
}