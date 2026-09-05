import { strict as assert } from 'node:assert'
import { spawn } from 'node:child_process'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

let appExecutable = process.env.MC_SCHOOL_STUDIO_APP_PATH
if (!appExecutable) throw new Error('MC_SCHOOL_STUDIO_APP_PATH must point to the packaged app executable')
if (!existsSync(appExecutable)) {
  const executableDirectory = dirname(appExecutable)
  const packagedExecutables = existsSync(executableDirectory)
    ? readdirSync(executableDirectory, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => join(executableDirectory, entry.name))
    : []
  if (packagedExecutables.length === 1) {
    appExecutable = packagedExecutables[0]
  }
}
if (!existsSync(appExecutable)) throw new Error(`Packaged app executable not found: ${appExecutable}`)
const expectedArchitecture = required('MC_SCHOOL_STUDIO_EXPECTED_ARCH')
const nativeArchitecture = {
  arm64: 'arm64',
  x86_64: 'x64',
}[execFileSync('/usr/bin/uname', ['-m'], { encoding: 'utf8' }).trim()]
if (!nativeArchitecture) throw new Error('Unsupported macOS runner architecture')
assert.equal(
  nativeArchitecture,
  expectedArchitecture,
  `retirement smoke must run on a native ${expectedArchitecture} runner`,
)
const executableArchitectures = execFileSync('/usr/bin/lipo', ['-archs', appExecutable], {
  encoding: 'utf8',
}).trim().split(/\s+/)
const expectedExecutableArchitecture = expectedArchitecture === 'arm64' ? 'arm64' : 'x86_64'
assert.deepEqual(
  executableArchitectures,
  [expectedExecutableArchitecture],
  `expected a thin ${expectedArchitecture} packaged executable, found ${executableArchitectures.join(', ')}`,
)

const appBundle = resolve(dirname(appExecutable), '..', '..')
const unpackedModules = join(appBundle, 'Contents', 'Resources', 'app.asar.unpacked', 'node_modules')
const nativeBinaries = findFiles(unpackedModules).filter(
  (path) => path.endsWith('.node') || path.endsWith('.dylib'),
)
assert(nativeBinaries.length > 0, 'packaged app must include unpacked native binaries')
for (const binary of nativeBinaries) {
  const architectures = execFileSync('/usr/bin/lipo', ['-archs', binary], {
    encoding: 'utf8',
  }).trim().split(/\s+/)
  assert(
    architectures.includes(expectedExecutableArchitecture),
    `${binary} does not include ${expectedExecutableArchitecture}; found ${architectures.join(', ')}`,
  )
}

const token = 'release-retirement-smoke-token'
const projectName = 'Release Retirement School'
const studentReference = '001234'
const root = mkdtempSync(join(tmpdir(), 'mc-school-studio-retirement-release-'))
const userDataDir = join(root, 'user-data')
const storageRoot = join(root, 'managed-photos')
const watchFolder = join(root, 'camera-originals')
const sourcePhoto = join(watchFolder, `Smith_John_release-${studentReference}.jpg`)
const managedPhotoName = `John_Smith_${studentReference}.jpg`
const debugPort = await reservePort()
let online = true
let retired = false
let acknowledgedAt = null
let uploadCount = 0

mkdirSync(userDataDir, { recursive: true })
mkdirSync(storageRoot, { recursive: true })
mkdirSync(watchFolder, { recursive: true })

function json(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}

function authorized(request) {
  return request.headers.authorization === `Bearer ${token}`
}

const server = createServer((request, response) => {
  if (!online) {
    request.socket.destroy()
    return
  }

  const url = new URL(request.url ?? '/', 'http://127.0.0.1')
  if (request.method === 'POST' && url.pathname === '/api/desktop/auth/start') {
    json(response, 201, { code: 'release-retirement-smoke-code' })
    return
  }
  if (request.method === 'POST' && url.pathname === '/api/desktop/auth/status') {
    json(response, 200, { status: 'approved' })
    return
  }
  if (request.method === 'POST' && url.pathname === '/api/desktop/auth/exchange') {
    json(response, 200, {
      token,
      member: { email: 'release-smoke@example.test', role: 'photographer' },
    })
    return
  }
  if (!authorized(request)) {
    json(response, 401, { error: 'Invalid desktop connection' })
    return
  }
  if (request.method === 'GET' && url.pathname === '/api/desktop/me') {
    json(response, 200, {
      member: { email: 'release-smoke@example.test', role: 'photographer' },
      retirement: retired
        ? { retiredAt: '2026-08-29T12:00:00.000Z', acknowledgedAt }
        : null,
    })
    return
  }
  if (request.method === 'POST' && url.pathname === '/api/desktop/retirement/acknowledge') {
    assert.equal(retired, true, 'an active connection must not acknowledge retirement')
    acknowledgedAt ||= new Date().toISOString()
    json(response, 200, { ok: true, acknowledgedAt })
    return
  }
  if (retired) {
    json(response, 401, { error: 'Invalid or retired desktop connection' })
    return
  }
  if (request.method === 'GET' && url.pathname === '/api/desktop/projects') {
    json(response, 200, [{
      id: 41,
      schoolName: projectName,
      photoDate: '2026-09-01',
      address: null,
      contactName: null,
      classCount: 1,
      studentCount: 1,
      updatedAt: '2026-08-29T12:00:00.000Z',
    }])
    return
  }
  if (request.method === 'GET' && url.pathname === '/api/desktop/projects/41/bundle') {
    json(response, 200, {
      project: {
        id: 41,
        schoolName: projectName,
        photoDate: '2026-09-01',
        address: null,
        contactName: null,
        contactEmail: null,
        contactPhone: null,
        notes: null,
      },
      classes: [{ id: 51, className: 'Class A' }],
      students: [{
        id: 61,
        classId: 51,
        firstName: 'John',
        lastName: 'Smith',
        generatedStudentId: studentReference,
        email: null,
        phone: null,
        simpleQr: null,
        jsonQr: null,
      }],
    })
    return
  }
  if (request.method === 'POST' && url.pathname === '/api/projects/41/students/61/photos') {
    assert.match(request.headers['x-mc-upload-id'] ?? '', /^[1-9]\d*$/)
    request.resume()
    request.on('end', () => {
      uploadCount++
      json(response, 201, { fileUrl: '/uploads/release-smoke.jpg' })
    })
    return
  }
  if (request.method === 'POST' && url.pathname === '/api/projects/41/students/61/captures') {
    assert.match(request.headers['x-mc-upload-id'] ?? '', /^[1-9]\d*$/)
    request.resume()
    request.on('end', () => {
      uploadCount++
      json(response, 201, {
        file: { fileUrl: '/uploads/release-smoke.jpg' },
      })
    })
    return
  }
  json(response, 404, { error: `Unhandled smoke-test route ${request.method} ${url.pathname}` })
})
const serverSockets = new Set()
server.on('connection', (socket) => {
  serverSockets.add(socket)
  socket.once('close', () => serverSockets.delete(socket))
})

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(description, check, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    try {
      const value = await check()
      if (value) return value
    } catch (error) {
      lastError = error
    }
    await wait(250)
  }
  throw new Error(`Timed out waiting for ${description}${lastError ? `: ${lastError}` : ''}`)
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
      clearTimeout(pending.timeout)
      if (message.error) pending.reject(new Error(message.error.message))
      else pending.resolve(message.result)
    })
    socket.addEventListener('close', () => {
      for (const [id, pending] of this.pending) {
        clearTimeout(pending.timeout)
        pending.reject(new Error(`CDP socket closed while waiting for request ${id}`))
      }
      this.pending.clear()
    })
  }

  static async connect() {
    const page = await waitFor('packaged renderer debug endpoint', async () => {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`).catch(() => null)
      if (!response?.ok) return null
      const pages = await response.json()
      return pages.find((candidate) => candidate.type === 'page')
    })
    const socket = new WebSocket(page.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true })
      socket.addEventListener('error', reject, { once: true })
    })
    return new CdpClient(socket)
  }

  send(method, params = {}, timeoutMs = 60_000) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Timed out waiting for CDP ${method}`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timeout })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? 'Renderer evaluation failed')
    }
    return result.result.value
  }

  close() {
    this.socket.close()
  }
}

async function waitForProcessExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return true
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timeout)
      resolve(true)
    }
    const timeout = setTimeout(() => {
      child.off('exit', finish)
      resolve(false)
    }, timeoutMs)
    child.once('exit', finish)
  })
}

async function stopAppProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
  if (await waitForProcessExit(child, 10_000)) return
  child.kill('SIGKILL')
  if (!await waitForProcessExit(child, 5_000)) {
    throw new Error('Packaged app did not exit after SIGKILL')
  }
}

async function closeSmokeServer() {
  for (const socket of serverSockets) socket.destroy()
  server.closeAllConnections?.()
  if (!server.listening) return
  await Promise.race([
    new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    }),
    wait(5_000).then(() => {
      throw new Error('Timed out closing smoke API server')
    }),
  ])
}

function findFiles(directory) {
  if (!existsSync(directory)) return []
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? findFiles(path) : [path]
  })
}

function querySqlite(dbPath, sql) {
  return execFileSync('/usr/bin/sqlite3', [dbPath, sql], { encoding: 'utf8' }).trim()
}

function required(name) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

async function reservePort() {
  const probe = createServer()
  const address = await new Promise((resolveAddress, reject) => {
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => resolveAddress(probe.address()))
  })
  await new Promise((resolveClose, reject) => {
    probe.close((error) => error ? reject(error) : resolveClose())
  })
  if (!address || typeof address === 'string') throw new Error('Could not reserve renderer debug port')
  return address.port
}

const apiAddress = await new Promise((resolve, reject) => {
  server.once('error', reject)
  server.listen(0, '127.0.0.1', () => resolve(server.address()))
})
if (!apiAddress || typeof apiAddress === 'string') throw new Error('Could not start smoke API')
const apiUrl = `http://127.0.0.1:${apiAddress.port}`

const appProcess = spawn(appExecutable, [`--remote-debugging-port=${debugPort}`], {
  env: {
    ...process.env,
    CI: 'true',
    MC_SCHOOL_STUDIO_SMOKE_API_URL: apiUrl,
    MC_SCHOOL_STUDIO_SMOKE_SKIP_BROWSER: '1',
    MC_SCHOOL_STUDIO_SMOKE_USER_DATA_DIR: userDataDir,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let appOutput = ''
appProcess.stdout.on('data', (chunk) => { appOutput += chunk })
appProcess.stderr.on('data', (chunk) => { appOutput += chunk })
let appProcessError
appProcess.once('error', (error) => { appProcessError = error })
appProcess.once('exit', (code, signal) => {
  appOutput += `\n[smoke] packaged app exited code=${code ?? 'null'} signal=${signal ?? 'null'}\n`
})

let cdp
try {
  cdp = await CdpClient.connect()
  await waitFor('sign-in screen', () => cdp.evaluate(
    `document.body.innerText.includes('Sign in with your studio account')`,
  ))

  const signedIn = await cdp.evaluate(`window.api.invoke('auth:signIn')`)
  assert.equal(signedIn.signedIn, true)

  const dbPath = join(userDataDir, 'mc-school-studio.db')
  await waitFor('desktop SQLite database', () => existsSync(dbPath))
  const storedToken = querySqlite(
    dbPath,
    "SELECT value FROM settings WHERE key = 'desktop_connection_token';",
  )
  assert.match(storedToken, /^safe:/, 'the packaged Mac must encrypt its connection token with safeStorage')

  const cloudProjects = await cdp.evaluate(`window.api.invoke('cloud:listProjects')`)
  assert.equal(cloudProjects.ok, true)
  assert.equal(cloudProjects.projects[0].schoolName, projectName)

  const pulled = await cdp.evaluate(`window.api.invoke('cloud:pullProject', { cloudProjectId: 41 })`)
  assert.deepEqual(
    { ok: pulled.ok, classesImported: pulled.classesImported, studentsImported: pulled.studentsImported },
    { ok: true, classesImported: 1, studentsImported: 1 },
  )

  const localProjects = await cdp.evaluate(`window.api.invoke('projects:list')`)
  assert.equal(localProjects.length, 1)
  const localProjectId = localProjects[0].id
  await cdp.evaluate(`window.api.invoke('app:setPhotosDir', { dir: ${JSON.stringify(storageRoot)} })`)
  await cdp.evaluate(`window.api.invoke('projects:setWatchFolder', {
    projectId: ${localProjectId},
    folderPath: ${JSON.stringify(watchFolder)}
  })`)
  await cdp.evaluate(`window.api.invoke('watcher:start', { projectId: ${localProjectId} })`)

  // Capture while disconnected. This exercises cached authorization, local
  // matching, durable pending state, and remote-ID mapping. Reconnecting must
  // not silently upload; the photographer explicitly retries the pending file.
  online = false
  writeFileSync(sourcePhoto, Buffer.from(
    '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9oADAMBAAIAAwAAABAf/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPxB//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPxB//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxB//9k=',
    'base64',
  ))

  await waitFor('managed photo copy and SQLite photo row', async () => {
    const project = await cdp.evaluate(`window.api.invoke('projects:get', { projectId: ${localProjectId} })`)
    return project?.photoCount === 1 && findFiles(storageRoot).some((path) => basename(path) === managedPhotoName)
  }, 40_000)
  const managedPhoto = findFiles(storageRoot).find((path) => basename(path) === managedPhotoName)
  assert(managedPhoto)
  assert.deepEqual(readFileSync(managedPhoto), readFileSync(sourcePhoto))

  const offlineSession = await cdp.evaluate(`window.api.invoke('auth:getSession')`)
  assert.equal(offlineSession.signedIn, true)
  assert.equal(offlineSession.offline, true, 'the running app must observe the outage')
  const waitingUploads = await cdp.evaluate(
    `window.api.invoke('upload:getProjectStatus', { projectId: ${localProjectId} })`,
  )
  assert.equal(
    waitingUploads[0].uploadStatus,
    null,
    'local capture must remain neutral until an explicit upload begins',
  )

  online = true
  const reconnectedSession = await cdp.evaluate(`window.api.invoke('auth:getSession')`)
  assert.equal(reconnectedSession.signedIn, true)
  assert.equal(reconnectedSession.offline, undefined)
  await wait(1_000)
  const stillPendingAfterReconnect = await cdp.evaluate(
    `window.api.invoke('upload:getProjectStatus', { projectId: ${localProjectId} })`,
  )
  assert.equal(uploadCount, 0, 'reconnecting must not start a background upload')
  assert.equal(stillPendingAfterReconnect[0]?.uploadStatus, null)

  const retryResult = await cdp.evaluate(
    `window.api.invoke('upload:retry', { photoId: ${waitingUploads[0].id} })`,
  )
  assert.equal(retryResult.ok, true)
  await waitFor('explicit pending upload retry', async () => {
    const statuses = await cdp.evaluate(
      `window.api.invoke('upload:getProjectStatus', { projectId: ${localProjectId} })`,
    )
    return uploadCount === 1 && statuses[0]?.uploadStatus === 'done'
  }, 35_000)
  assert.equal(uploadCount, 1, 'the explicit retry must upload exactly once')

  // A roster re-sync must reconcile the student in place so captured photos
  // keep their local student foreign key.
  const resynced = await cdp.evaluate(`window.api.invoke('cloud:pullProject', { cloudProjectId: 41 })`)
  assert.equal(resynced.ok, true)
  const photosAfterResync = await cdp.evaluate(
    `window.api.invoke('upload:getProjectStatus', { projectId: ${localProjectId} })`,
  )
  assert.equal(photosAfterResync.length, 1)
  assert.equal(photosAfterResync[0].uploadStatus, 'done')

  online = false
  retired = true
  const stillOfflineSession = await cdp.evaluate(`window.api.invoke('auth:getSession')`)
  assert.equal(stillOfflineSession.signedIn, true)
  assert.equal(stillOfflineSession.offline, true)
  assert.equal(existsSync(managedPhoto), true, 'an offline Mac cannot be erased remotely')
  assert.equal(acknowledgedAt, null)

  online = true
  const oldSessionResponse = await fetch(`${apiUrl}/api/desktop/projects`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  assert.equal(oldSessionResponse.status, 401, 'the retired token must lose cloud data access immediately')
  await waitFor('retirement acknowledgement', () => acknowledgedAt, 35_000)
  await waitFor('retirement message in the packaged UI', () => cdp.evaluate(
    `document.body.innerText.includes('Local project and photo data was cleared and cloud sync is disabled.')`,
  ))

  assert.equal(existsSync(sourcePhoto), true, 'camera originals outside app-managed storage must remain')
  assert.equal(existsSync(dirname(managedPhoto)), false, 'the managed student photo folder must be removed')
  assert.deepEqual(await cdp.evaluate(`window.api.invoke('projects:list')`), [])
  const blockedCloud = await cdp.evaluate(`window.api.invoke('cloud:listProjects')`)
  assert.equal(blockedCloud.ok, false)
  assert.match(blockedCloud.error, /Sign in/)

  assert.equal(querySqlite(dbPath, 'SELECT count(*) FROM projects;'), '0')
  assert.equal(querySqlite(dbPath, 'SELECT count(*) FROM students;'), '0')
  assert.equal(querySqlite(dbPath, 'SELECT count(*) FROM photos;'), '0')
  assert.equal(
    querySqlite(dbPath, "SELECT value FROM settings WHERE key = 'desktop_retired';"),
    '1',
  )
  assert.equal(
    querySqlite(dbPath, "SELECT value FROM settings WHERE key = 'desktop_connection_token';"),
    '',
  )

  console.log('Packaged retirement smoke test passed.')
} catch (error) {
  console.error([
    `[smoke] runner=${execFileSync('/usr/bin/uname', ['-a'], { encoding: 'utf8' }).trim()}`,
    `[smoke] executable=${appExecutable}`,
    `[smoke] executable architectures=${executableArchitectures.join(',')}`,
    `[smoke] debug port=${debugPort}`,
    `[smoke] process pid=${appProcess.pid ?? 'none'} exit=${appProcess.exitCode ?? 'running'} signal=${appProcess.signalCode ?? 'none'}`,
    appProcessError ? `[smoke] spawn error=${appProcessError.stack ?? appProcessError}` : '',
    appOutput,
  ].filter(Boolean).join('\n'))
  throw error
} finally {
  cdp?.close()
  await stopAppProcess(appProcess)
  await closeSmokeServer()
  rmSync(root, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 100,
  })
}