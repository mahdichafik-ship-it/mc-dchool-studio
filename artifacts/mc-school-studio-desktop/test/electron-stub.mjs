export const app = {
  getPath: (name) => {
    if (name === 'userData') return process.env.MC_SCHOOL_STUDIO_TEST_USER_DATA_DIR || '/tmp/mc-school-studio-test'
    if (name === 'home') return process.env.MC_SCHOOL_STUDIO_TEST_HOME_DIR || '/tmp/mc-school-studio-test'
    return '/tmp/mc-school-studio-test'
  },
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