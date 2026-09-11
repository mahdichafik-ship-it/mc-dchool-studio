import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { randomBytes } from 'node:crypto'
import type { DroppedCaptureBatchResult } from '../shared/types'

export type IpcChannel = string

// This token stays in the preload closure. The renderer receives only the
// result of the dedicated drop method, never the capability itself.
const dropCapabilityToken = randomBytes(32).toString('base64url')
ipcRenderer.send('watcher:registerDropCapability', dropCapabilityToken)

const api = {
  invoke: (channel: IpcChannel, args?: unknown): Promise<unknown> =>
    ipcRenderer.invoke(channel, args),

  ingestDroppedFiles: async (
    projectId: number,
    studentId: number,
    files: File[],
  ): Promise<DroppedCaptureBatchResult> => {
    if (!Array.isArray(files) || files.length === 0) {
      throw new Error('No dropped files were provided')
    }
    const filePaths = files.map((file, index) => {
      let filePath = ''
      try {
        filePath = webUtils.getPathForFile(file)
      } catch {
        filePath = ''
      }
      if (!filePath.trim()) {
        throw new Error(`Dropped file ${index + 1} has no local filesystem path`)
      }
      return filePath
    })
    return ipcRenderer.invoke('watcher:ingestDroppedFiles', {
      capabilityToken: dropCapabilityToken,
      projectId,
      studentId,
      filePaths,
    })
  },

  on: (channel: IpcChannel, listener: (...args: unknown[]) => void): (() => void) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, ...args: unknown[]) =>
      listener(...args)
    ipcRenderer.on(channel, wrappedListener)
    return () => ipcRenderer.off(channel, wrappedListener)
  },
}

contextBridge.exposeInMainWorld('api', api)
