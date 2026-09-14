export const app = {
  getPath: () => '/tmp/mc-school-studio-test',
  getName: () => 'mc-school-studio-test',
  isPackaged: false,
  on: () => {},
  whenReady: async () => {},
}

export const BrowserWindow = {
  getAllWindows: () => [],
}

export const dialog = {}
export const ipcMain = { handle: () => {}, on: () => {} }
export const safeStorage = {
  isEncryptionAvailable: () => false,
}
export const shell = {}
export const protocol = {}