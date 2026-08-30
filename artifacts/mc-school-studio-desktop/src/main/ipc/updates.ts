import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { autoUpdater, type ProgressInfo, type UpdateInfo } from 'electron-updater'

export type UpdateStatus =
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'downloaded'
  | 'error'
  | 'unsupported'

export interface UpdateState {
  status: UpdateStatus
  version?: string
  percent?: number
  message?: string
}

export interface UpdateCheckResult extends UpdateState {}

let mainWindow: BrowserWindow | null = null
let currentState: UpdateState = { status: 'unsupported' }
let checkPromise: Promise<UpdateCheckResult> | null = null
let updateDialogShowing = false
let installDialogShowing = false
let updaterEventsRegistered = false
let ipcHandlersRegistered = false
let availableUpdate: UpdateInfo | null = null

function setState(state: UpdateState) {
  currentState = state
  console.log('Desktop updater state:', JSON.stringify(state))
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('update:status', state)
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function promptToDownload(info: UpdateInfo) {
  if (updateDialogShowing || !mainWindow || mainWindow.isDestroyed()) return

  updateDialogShowing = true
  try {
    const result = await dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'Update available',
      message: `MC School Studio ${info.version} is available.`,
      detail: 'Download the update now. The app will ask before restarting to install it.',
      buttons: ['Download update', 'Later'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    })

    if (result.response === 0) {
      try {
        console.log('Desktop updater lifecycle: download-requested')
        await autoUpdater.downloadUpdate()
      } catch (error) {
        setState({ status: 'error', message: errorMessage(error) })
      }
    }
  } finally {
    updateDialogShowing = false
  }
}

async function promptToInstall() {
  if (installDialogShowing || !mainWindow || mainWindow.isDestroyed()) return

  installDialogShowing = true
  try {
    const result = await dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'Update ready to install',
      message: 'The latest version of MC School Studio has finished downloading.',
      detail: 'Restart the app now to install the update, or choose Later to install it when the app closes.',
      buttons: ['Restart and install', 'Later'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    })

    if (result.response === 0) {
      console.log('Desktop updater lifecycle: install-requested')
      autoUpdater.quitAndInstall()
    }
  } finally {
    installDialogShowing = false
  }
}

function registerUpdaterEvents() {
  autoUpdater.on('checking-for-update', () => {
    setState({ status: 'checking' })
  })

  autoUpdater.on('update-available', (info) => {
    availableUpdate = info
    setState({ status: 'available', version: info.version })
    void promptToDownload(info)
  })

  autoUpdater.on('update-not-available', (info) => {
    setState({ status: 'not-available', version: info.version })
  })

  autoUpdater.on('download-progress', (progress: ProgressInfo) => {
    setState({
      status: 'downloading',
      percent: progress.percent,
      message: `${Math.round(progress.percent)}%`,
    })
  })

  autoUpdater.on('update-downloaded', (info) => {
    availableUpdate = null
    setState({ status: 'downloaded', version: info.version, percent: 100 })
    console.log(
      'Desktop updater lifecycle:',
      JSON.stringify({ event: 'update-downloaded', version: info.version }),
    )
    void promptToInstall()
  })

  autoUpdater.on('error', (error) => {
    console.error(
      'Desktop updater lifecycle:',
      JSON.stringify({ event: 'error', message: errorMessage(error) }),
    )
    console.error('Failed to check for desktop updates:', error)
    setState({ status: 'error', message: errorMessage(error) })
  })
}

function checkForUpdates(): Promise<UpdateCheckResult> {
  // The updater requires a packaged app and a signed release feed. Avoid
  // contacting GitHub when running the local Electron development build.
  if (!app.isPackaged) {
    const state: UpdateCheckResult = {
      status: 'unsupported',
      message: 'Updates are checked from an installed release.',
    }
    setState(state)
    return Promise.resolve(state)
  }

  if (checkPromise) return checkPromise

  setState({ status: 'checking' })
  checkPromise = Promise.resolve()
    .then(() => autoUpdater.checkForUpdates())
    .then((result) => {
      if (!result) {
        return currentState
      }

      return currentState.status === 'checking'
        ? { status: 'not-available' as const, version: result.updateInfo.version }
        : currentState
    })
    .catch((error: unknown) => {
      const state: UpdateCheckResult = { status: 'error', message: errorMessage(error) }
      setState(state)
      return state
    })
    .finally(() => {
      checkPromise = null
    })

  return checkPromise
}

export function registerUpdateHandlers(window: BrowserWindow) {
  mainWindow = window
  if (!updaterEventsRegistered) {
    registerUpdaterEvents()
    updaterEventsRegistered = true
  }

  if (!ipcHandlersRegistered) {
    ipcMain.handle('update:getState', () => currentState)
    ipcMain.handle('update:check', () => checkForUpdates())
    ipcMain.handle('update:install', () => {
      if (currentState.status !== 'downloaded') {
        return {
          status: 'error' as const,
          message: 'No downloaded update is ready to install.',
        }
      }

      autoUpdater.quitAndInstall()
      return currentState
    })
    ipcHandlersRegistered = true
  }

  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true

  if (availableUpdate) void promptToDownload(availableUpdate)
  if (currentState.status === 'downloaded') void promptToInstall()
}

export function scheduleUpdateCheck() {
  if (!mainWindow || mainWindow.isDestroyed()) return

  // Checking after the first render keeps startup responsive and ensures the
  // native prompt has a window to attach to.
  setTimeout(() => {
    void checkForUpdates()
  }, 1_500)
}