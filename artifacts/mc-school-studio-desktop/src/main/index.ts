import { app, BrowserWindow, dialog } from 'electron'
import { join } from 'path'
import { registerProjectHandlers } from './ipc/projects'
import { registerPhotoHandlers } from './ipc/photos'
import { registerWatcherHandlers } from './ipc/watcher'
import { registerDialogHandlers } from './ipc/dialog'
import { registerUploadHandlers } from './ipc/upload'
import { registerAuthHandlers } from './ipc/auth'
import { registerCloudHandlers } from './ipc/cloud'
import { registerUpdateHandlers, scheduleUpdateCheck } from './ipc/updates'
import { getDb } from './db'

const isDev = !app.isPackaged

function createWindow(): BrowserWindow {
  const mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    title: 'MC School Studio',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 16, y: 16 },
    backgroundColor: '#0f172a',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  const showWindow = () => {
    if (!mainWindow.isDestroyed()) mainWindow.show()
  }

  mainWindow.once('ready-to-show', showWindow)
  // Do not leave the app invisible if the renderer fails before ready-to-show.
  setTimeout(showWindow, 3_000)

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
    const message = `The app interface could not load (${errorCode}: ${errorDescription}).`
    console.error(message)
    dialog.showErrorBox('MC School Studio could not open', message)
    showWindow()
  })

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    const message = `The app interface stopped unexpectedly: ${details.reason}.`
    console.error(message)
    dialog.showErrorBox('MC School Studio could not open', message)
    showWindow()
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  if (isDev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return mainWindow
}

app.whenReady().then(() => {
  // Initialize database (creates tables if needed)
  getDb()

  // Register all IPC handlers
  registerProjectHandlers()
  registerPhotoHandlers()
  registerWatcherHandlers()
  registerDialogHandlers()
  registerUploadHandlers()
  registerAuthHandlers()
  registerCloudHandlers()

  const mainWindow = createWindow()
  registerUpdateHandlers(mainWindow)
  scheduleUpdateCheck()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      const window = createWindow()
      registerUpdateHandlers(window)
      scheduleUpdateCheck()
    }
  })
}).catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error)
  console.error('Failed to start MC School Studio:', message)
  dialog.showErrorBox('MC School Studio could not open', message)
  app.quit()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
