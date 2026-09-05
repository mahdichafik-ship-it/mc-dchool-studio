import { app, BrowserWindow, dialog } from 'electron'
import { join } from 'path'
import { registerProjectHandlers } from './ipc/projects'
import { registerPhotoHandlers } from './ipc/photos'
import { registerWatcherHandlers, stopAllWatchersForShutdown } from './ipc/watcher'
import { registerDialogHandlers } from './ipc/dialog'
import { registerUploadHandlers } from './ipc/upload'
import { registerCaptureExportHandlers } from './ipc/captureExport'
import { registerProjectSyncHandlers } from './ipc/projectSync'
import { fetchCurrentSession, registerAuthHandlers } from './ipc/auth'
import { registerCloudHandlers } from './ipc/cloud'
import { registerUpdateHandlers, scheduleUpdateCheck } from './ipc/updates'
import { getDb } from './db'
import { registerLocalPreviewProtocol, registerLocalPreviewScheme } from './lib/localPreviewProtocol'
import { createShutdownCoordinator } from './lib/shutdownCoordinator'

const isDev = !app.isPackaged
const handleBeforeQuit = createShutdownCoordinator({
  drain: stopAllWatchersForShutdown,
  quit: () => app.quit(),
  onError: (error) => console.error('Failed to drain Watch Folder captures before shutdown:', error),
})

registerLocalPreviewScheme()
app.on('before-quit', handleBeforeQuit)

const smokeUserDataDir = process.env.CI === 'true'
  ? process.env.MC_SCHOOL_STUDIO_SMOKE_USER_DATA_DIR?.trim()
  : undefined
if (smokeUserDataDir) app.setPath('userData', smokeUserDataDir)

function createWindow(): BrowserWindow {
  const mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    title: 'Volume Capture',
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
    dialog.showErrorBox('Volume Capture could not open', message)
    showWindow()
  })

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    const message = `The app interface stopped unexpectedly: ${details.reason}.`
    console.error(message)
    dialog.showErrorBox('Volume Capture could not open', message)
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

function monitorRetirement(mainWindow: BrowserWindow): void {
  const checkRetirement = async () => {
    const session = await fetchCurrentSession()
    if (!session.signedIn && session.error?.startsWith('This desktop was retired')) {
      mainWindow.webContents.send('auth:retired', session)
    }
  }
  void checkRetirement()
  const retirementTimer = setInterval(() => void checkRetirement(), 15_000)
  retirementTimer.unref()
  mainWindow.on('closed', () => clearInterval(retirementTimer))
}

app.whenReady().then(() => {
  registerLocalPreviewProtocol()
  // Initialize database (creates tables if needed)
  getDb()

  // Register all IPC handlers
  registerProjectHandlers()
  registerPhotoHandlers()
  registerWatcherHandlers()
  registerDialogHandlers()
  registerUploadHandlers()
  registerCaptureExportHandlers()
  registerProjectSyncHandlers()
  registerAuthHandlers()
  registerCloudHandlers()

  const mainWindow = createWindow()
  monitorRetirement(mainWindow)
  registerUpdateHandlers(mainWindow)
  scheduleUpdateCheck()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      const window = createWindow()
      monitorRetirement(window)
      registerUpdateHandlers(window)
      scheduleUpdateCheck()
    }
  })
}).catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error)
  console.error('Failed to start Volume Capture:', message)
  dialog.showErrorBox('Volume Capture could not open', message)
  app.quit()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
