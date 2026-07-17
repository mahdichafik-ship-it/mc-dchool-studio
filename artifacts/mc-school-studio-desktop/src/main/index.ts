import { app, BrowserWindow } from 'electron'
import { join } from 'path'
import { registerProjectHandlers } from './ipc/projects'
import { registerPhotoHandlers } from './ipc/photos'
import { registerWatcherHandlers } from './ipc/watcher'
import { registerDialogHandlers } from './ipc/dialog'
import { registerUploadHandlers } from './ipc/upload'
import { registerCloudHandlers } from './ipc/cloud'
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
  registerCloudHandlers()

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
