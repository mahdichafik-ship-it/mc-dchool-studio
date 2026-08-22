import { ipcMain, dialog, shell } from 'electron'
import { getPhotosDir, setPhotosDir } from '../db'

export function registerDialogHandlers() {
  ipcMain.handle(
    'dialog:openFile',
    async (
      _e,
      args?: { filters?: Array<{ name: string; extensions: string[] }> },
    ): Promise<string | null> => {
      const result = await dialog.showOpenDialog({
        properties: ['openFile'],
        filters: args?.filters ?? [{ name: 'All Files', extensions: ['*'] }],
      })
      return result.canceled ? null : result.filePaths[0]
    },
  )

  ipcMain.handle('dialog:openFolder', async (): Promise<string | null> => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory'],
    })
    return result.canceled ? null : result.filePaths[0]
  })

  ipcMain.handle('app:openFile', async (_e, { filePath }: { filePath: string }) => {
    await shell.openPath(filePath)
  })

  ipcMain.handle('app:getPhotosDir', () => {
    return getPhotosDir()
  })

  ipcMain.handle('app:setPhotosDir', (_e, { dir }: { dir: string }) => {
    setPhotosDir(dir)
    return getPhotosDir()
  })
}
