import { strict as assert } from 'node:assert'
import { spawn, execFileSync } from 'node:child_process'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  rmSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const appPath = required('MC_SCHOOL_STUDIO_APP_PATH')
const sourceVersion = required('MC_SCHOOL_STUDIO_SOURCE_VERSION')
const targetVersion = required('MC_SCHOOL_STUDIO_TARGET_VERSION')
const lifecycleLogPath = required('MC_SCHOOL_STUDIO_UPDATE_SMOKE_LOG')
const appExecutable = join(appPath, 'Contents', 'MacOS', 'MC School Studio')
const debugPort = Number(process.env.MC_SCHOOL_STUDIO_UPDATE_SMOKE_DEBUG_PORT ?? 9337)
const mainDebugPort = debugPort + 1
const root = join(tmpdir(), `mc-school-studio-update-smoke-${process.pid}`)
const userDataDir = join(root, 'user-data')
const autoUpdaterExpression = `
  process
    .getBuiltinModule('module')
    .createRequire(process.resourcesPath + '/app.asar/out/main/index.js')
    ('electron-updater')
    .autoUpdater
`
const dialogExpression = `
  process
    .getBuiltinModule('module')
    .createRequire(process.resourcesPath + '/app.asar/out/main/index.js')
    ('electron')
    .dialog
`

mkdirSync(root, { recursive: true })
mkdirSync(userDataDir, { recursive: true })
mkdirSync(join(lifecycleLogPath, '..'), { recursive: true })

const events = []
let appProcess
let cdp
let mainCdp
let appOutput = ''
let restartedPid

function required(name) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

function record(event, details = {}) {
  const entry = {
    event,
    ...details,
    recordedAt: new Date().toISOString(),
  }
  events.push(entry)
  appendFileSync(lifecycleLogPath, `${JSON.stringify(entry)}\n`)
  console.log(`Updater smoke: ${event}${details.version ? ` (${details.version})` : ''}`)
}

function bundleVersion(bundlePath) {
  return execFileSync('/usr/bin/plutil', [
    '-extract',
    'CFBundleShortVersionString',
    'raw',
    '-o',
    '-',
    join(bundlePath, 'Contents', 'Info.plist'),
  ], { encoding: 'utf8' }).trim()
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(description, check, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    try {
      const result = await check()
      if (result) return result
    } catch (error) {
      lastError = error
    }
    await wait(500)
  }
  throw new Error(
    `Timed out waiting for ${description}${lastError ? `: ${lastError}` : ''}`,
  )
}

class CdpClient {
  constructor(socket) {
    this.socket = socket
    this.nextId = 1
    this.pending = new Map()
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data))
      if (!message.id) return
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      if (message.error) pending.reject(new Error(message.error.message))
      else pending.resolve(message.result)
    })
  }

  async evaluate(expression) {
    const response = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })
    if (response.exceptionDetails) {
      throw new Error(
        response.exceptionDetails.exception?.description ??
          'Renderer evaluation failed',
      )
    }
    return response.result.value
  }

  send(method, params = {}) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }

  close() {
    this.socket.close()
  }
}

async function connectToDebugger(port, description, selectTarget) {
  const page = await waitFor(description, async () => {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`).catch(
      () => null,
    )
    if (!response?.ok) return null
    const pages = await response.json()
    return selectTarget(pages)
  })
  const socket = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  return new CdpClient(socket)
}

function connectToRenderer() {
  return connectToDebugger(
    debugPort,
    'packaged renderer debug endpoint',
    (pages) => pages.find((candidate) => candidate.type === 'page'),
  )
}

function connectToMainProcess() {
  return connectToDebugger(
    mainDebugPort,
    'packaged main-process debug endpoint',
    (pages) => pages[0],
  )
}

function processIsRunning(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function runningAppPids() {
  const output = execFileSync('/bin/ps', ['-axo', 'pid=,command='], {
    encoding: 'utf8',
  })
  return output
    .split('\n')
    .map((line) => /^ *(\d+) +(.*)$/.exec(line))
    .filter((match) =>
      match &&
      (match[2] === appExecutable || match[2].startsWith(`${appExecutable} `)))
    .map((match) => Number(match[1]))
}

function terminateProcess(processHandle) {
  if (processHandle && processIsRunning(processHandle.pid)) {
    processHandle.kill('SIGTERM')
  }
}

function verifySignedBundle(bundlePath) {
  execFileSync('/usr/bin/codesign', [
    '--verify',
    '--deep',
    '--strict',
    '--verbose=2',
    bundlePath,
  ], { stdio: 'inherit' })
  execFileSync('/usr/sbin/spctl', [
    '--assess',
    '--type',
    'execute',
    '--verbose=2',
    bundlePath,
  ], { stdio: 'inherit' })
  execFileSync('/usr/bin/xcrun', ['stapler', 'validate', bundlePath], {
    stdio: 'inherit',
  })
}

try {
  assert.equal(process.platform, 'darwin', 'the update smoke test requires macOS')
  assert(existsSync(appExecutable), `packaged app executable not found: ${appExecutable}`)
  assert.equal(
    bundleVersion(appPath),
    sourceVersion,
    `expected the installed app to be ${sourceVersion}`,
  )
  record('installed', { version: sourceVersion, appPath })
  verifySignedBundle(appPath)
  record('gatekeeper-accepted', { version: sourceVersion })

  appProcess = spawn(appExecutable, [
    `--remote-debugging-port=${debugPort}`,
    `--inspect=${mainDebugPort}`,
    `--user-data-dir=${userDataDir}`,
  ], {
    env: {
      ...process.env,
      CI: 'true',
      MC_SCHOOL_STUDIO_SMOKE_USER_DATA_DIR: userDataDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  appProcess.stdout.on('data', (chunk) => { appOutput += chunk })
  appProcess.stderr.on('data', (chunk) => { appOutput += chunk })
  appProcess.on('error', (error) => { appOutput += `\n${error.stack ?? error}` })

  cdp = await connectToRenderer()
  mainCdp = await connectToMainProcess()
  await waitFor('desktop renderer', () => cdp.evaluate('document.readyState === "complete"'))
  await mainCdp.evaluate(`
    (${dialogExpression}).showMessageBox = async () => ({ response: 1 })
    'dialogs-suppressed'
  `)
  record('checking')
  const checkResult = await cdp.evaluate('window.api.invoke("update:check")')
  if (checkResult?.status === 'error') {
    throw new Error(`the older release could not check for updates: ${checkResult.message}`)
  }
  assert.equal(
    checkResult?.status,
    'available',
    `expected an available update, received ${JSON.stringify(checkResult)}`,
  )
  assert.equal(checkResult.version, targetVersion)

  record('update-available', { version: targetVersion })
  record('download-requested', { version: targetVersion })
  const downloadResult = await mainCdp.evaluate(`
    new Promise((resolve, reject) => {
      const updater = ${autoUpdaterExpression}
      const timeout = setTimeout(
        () => reject(new Error('Timed out downloading the target release')),
        300000,
      )
      const cleanup = () => {
        clearTimeout(timeout)
        updater.removeListener('error', onError)
        updater.removeListener('update-downloaded', onDownloaded)
      }
      const onError = (error) => {
        cleanup()
        reject(error)
      }
      const onDownloaded = (info) => {
        cleanup()
        resolve({ version: info.version })
      }
      updater.once('error', onError)
      updater.once('update-downloaded', onDownloaded)
      updater.downloadUpdate().catch(onError)
    })
  `)
  assert.equal(downloadResult?.version, targetVersion)
  record('downloaded', { version: targetVersion })
  record('restart-requested', { version: targetVersion })
  const installResult = await mainCdp.evaluate(`
    setTimeout(
      () => (${autoUpdaterExpression}).quitAndInstall(),
      250,
    )
    'install-scheduled'
  `)
  assert.equal(installResult, 'install-scheduled')

  const sourcePid = appProcess.pid
  await waitFor('older app to exit after restart request', () => !processIsRunning(appProcess.pid))
  cdp.close()
  cdp = undefined
  mainCdp.close()
  mainCdp = undefined
  await waitFor('updated app bundle', () => {
    try {
      return bundleVersion(appPath) === targetVersion
    } catch {
      return false
    }
  }, 120_000)
  restartedPid = await waitFor('updated app process to relaunch', () => {
    return runningAppPids().find((pid) => pid !== sourcePid)
  }, 120_000)
  await wait(5_000)
  assert(
    processIsRunning(restartedPid),
    `updated app process ${restartedPid} exited before the restart smoke completed`,
  )
  verifySignedBundle(appPath)
  record('restarted', { version: bundleVersion(appPath), pid: restartedPid })
  console.log(`Updater smoke passed: ${sourceVersion} -> ${targetVersion}`)
} catch (error) {
  record('failed', {
    message: error instanceof Error ? error.message : String(error),
  })
  console.error(appOutput)
  throw error
} finally {
  cdp?.close()
  mainCdp?.close()
  terminateProcess(appProcess)
  if (restartedPid && processIsRunning(restartedPid)) {
    process.kill(restartedPid, 'SIGTERM')
    await waitFor(
      'updated app process to exit during cleanup',
      () => !processIsRunning(restartedPid),
      5_000,
    ).catch(() => {})
  }
  try {
    execFileSync('/usr/bin/pkill', ['-TERM', '-x', 'MC School Studio'])
  } catch {
    // The app may already have exited after a failed or completed smoke.
  }
  try {
    rmSync(root, {
      recursive: true,
      force: true,
      maxRetries: 20,
      retryDelay: 500,
    })
  } catch (error) {
    console.warn(`Updater smoke cleanup left temporary files at ${root}:`, error)
  }
}