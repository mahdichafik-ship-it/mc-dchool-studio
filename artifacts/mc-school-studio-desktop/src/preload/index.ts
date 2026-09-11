import { contextBridge, ipcRenderer, webUtils } from 'electron'

export type IpcChannel = string

const api = {
  invoke: (channel: IpcChannel, args?: unknown): Promise<unknown> =>
    ipcRenderer.invoke(channel, args),

  getPathForFile: (file: File): string => webUtils.getPathForFile(file),

  on: (channel: IpcChannel, listener: (...args: unknown[]) => void): (() => void) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, ...args: unknown[]) =>
      listener(...args)
    ipcRenderer.on(channel, wrappedListener)
    return () => ipcRenderer.off(channel, wrappedListener)
  },
}

contextBridge.exposeInMainWorld('api', api)
