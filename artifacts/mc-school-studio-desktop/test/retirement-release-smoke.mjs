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
import sharp from 'sharp'

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
const sharpPackagesDirectory = join(unpackedModules, '@img')
const expectedSharpPackages = [
  `sharp-darwin-${expectedArchitecture === 'arm64' ? 'arm64' : 'x64'}`,
  `sharp-libvips-darwin-${expectedArchitecture === 'arm64' ? 'arm64' : 'x64'}`,
].sort()
const packagedSharpPackages = existsSync(sharpPackagesDirectory)
  ? readdirSync(sharpPackagesDirectory)
    .filter((name) => name.startsWith('sharp-'))
    .sort()
  : []
assert.deepEqual(
  packagedSharpPackages,
  expectedSharpPackages,
  `packaged Sharp optional dependencies must contain only ${expectedSharpPackages.join(', ')}, found ${packagedSharpPackages.join(', ')}`,
)
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
const droppedStudentOneDir = join(root, 'finder-drop', 'student-one')
const droppedStudentTwoDir = join(root, 'finder-drop', 'student-two')
const droppedJpegOne = join(droppedStudentOneDir, 'DSC_9000.JPG')
const droppedRawOne = join(droppedStudentOneDir, 'DSC_9000.CR3')
const droppedJpegTwo = join(droppedStudentTwoDir, 'DSC_9000.JPG')
const droppedRawTwo = join(droppedStudentTwoDir, 'DSC_9000.CR3')
const dbPath = join(userDataDir, 'mc-school-studio.db')
const legacyPhotoPath = join(root, 'legacy-existing', 'Legacy_Portrait.jpg')
const releasePreviewFixture = await createReleasePreviewFixture()
const jpegFixture = Buffer.from(releasePreviewFixture)
const debugPort = await reservePort()
let online = true
let retired = false
let acknowledgedAt = null
let uploadCount = 0

mkdirSync(userDataDir, { recursive: true })
mkdirSync(storageRoot, { recursive: true })
mkdirSync(watchFolder, { recursive: true })
mkdirSync(droppedStudentOneDir, { recursive: true })
mkdirSync(droppedStudentTwoDir, { recursive: true })
mkdirSync(dirname(legacyPhotoPath), { recursive: true })
writeFileSync(legacyPhotoPath, releasePreviewFixture)
writeFileSync(droppedJpegOne, jpegFixture)
writeFileSync(droppedRawOne, 'student-one-raw')
writeFileSync(droppedJpegTwo, jpegFixture)
writeFileSync(droppedRawTwo, 'student-two-raw')

// Seed a database from before the capture/file model existed. The packaged
// app must upgrade it in place and keep the legacy portrait in review.
execFileSync('sqlite3', [dbPath, `
  CREATE TABLE projects (
    id INTEGER PRIMARY KEY,
    school_name TEXT NOT NULL,
    photo_date TEXT,
    address TEXT,
    contact_name TEXT,
    contact_email TEXT,
    contact_phone TEXT,
    notes TEXT,
    watch_folder TEXT,
    finished_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE classes (
    id INTEGER PRIMARY KEY,
    project_id INTEGER NOT NULL,
    class_name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE students (
    id INTEGER PRIMARY KEY,
    project_id INTEGER NOT NULL,
    class_id INTEGER NOT NULL,
    first_name TEXT NOT NULL,
    last_name TEXT NOT NULL,
    generated_student_id TEXT NOT NULL,
    simple_qr TEXT,
    json_qr TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE photos (
    id INTEGER PRIMARY KEY,
    project_id INTEGER NOT NULL,
    student_id INTEGER,
    file_path TEXT NOT NULL,
    file_name TEXT NOT NULL,
    captured_at TEXT NOT NULL,
    is_matched INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  INSERT INTO projects (id, school_name, created_at, updated_at)
    VALUES (91, 'Existing Legacy Release Project', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  INSERT INTO classes (id, project_id, class_name, created_at, updated_at)
    VALUES (92, 91, 'Legacy Class', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  INSERT INTO students (id, project_id, class_id, first_name, last_name, generated_student_id, created_at, updated_at)
    VALUES (93, 91, 92, 'Legacy', 'Portrait', 'LEGACY-RELEASE', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  INSERT INTO photos (id, project_id, student_id, file_path, file_name, captured_at, is_matched, created_at)
    VALUES (94, 91, 93, '${legacyPhotoPath.replaceAll("'", "''")}', 'Legacy_Portrait.jpg', '2026-01-01T12:00:00.000Z', 1, '2026-01-01T12:00:00.000Z');
`])

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
      studentCount: 2,
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
      students: [
        {
          id: 61,
          classId: 51,
          firstName: 'John',
          lastName: 'Smith',
          generatedStudentId: studentReference,
          email: null,
          phone: null,
          simpleQr: null,
          jsonQr: null,
        },
        {
          id: 62,
          classId: 51,
          firstName: 'Maya',
          lastName: 'Chen',
          generatedStudentId: '005678',
          email: null,
          phone: null,
          simpleQr: null,
          jsonQr: null,
        },
      ],
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
        captureId: 71,
        captureKey: 'release-smoke-capture',
        pairingStatus: 'complete',
        file: {
          id: 72,
          fileRole: 'JPEG',
          fileFormat: 'JPG',
          originalFilename: managedPhotoName,
          mimeType: 'image/jpeg',
          fileSize: 1,
          fileUrl: '/uploads/release-smoke.jpg',
        },
        reused: false,
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
  let lastValue
  while (Date.now() < deadline) {
    try {
      const value = await check()
      lastValue = value
      if (value) return value
    } catch (error) {
      lastError = error
    }
    await wait(250)
  }
  const lastObservation = lastValue === undefined ? '' : `; last observation: ${JSON.stringify(lastValue)}`
  throw new Error(`Timed out waiting for ${description}${lastError ? `: ${lastError}` : ''}${lastObservation}`)
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

function spawnPackagedApp() {
  const child = spawn(appExecutable, [`--remote-debugging-port=${debugPort}`], {
    env: {
      ...process.env,
      CI: 'true',
      MC_SCHOOL_STUDIO_SMOKE_API_URL: apiUrl,
      MC_SCHOOL_STUDIO_SMOKE_SKIP_BROWSER: '1',
      MC_SCHOOL_STUDIO_SMOKE_USER_DATA_DIR: userDataDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (chunk) => { appOutput += chunk })
  child.stderr.on('data', (chunk) => { appOutput += chunk })
  child.once('error', (error) => { appProcessError = error })
  child.once('exit', (code, signal) => {
    appOutput += `\n[smoke] packaged app exited code=${code ?? 'null'} signal=${signal ?? 'null'}\n`
  })
  return child
}

async function dropFilesOnStudent(client, studentId, files) {
  const point = await client.evaluate(`(() => {
    const row = document.querySelector('[data-student-row="${studentId}"]')
    if (!row) return null
    const rect = row.getBoundingClientRect()
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
  })()`)
  assert(point, `student ${studentId} must be visible before dropping files`)
  const data = {
    items: [],
    files,
    dragOperationsMask: 1,
  }
  await client.send('Input.dispatchDragEvent', {
    type: 'dragEnter',
    x: point.x,
    y: point.y,
    data,
  })
  await client.send('Input.dispatchDragEvent', {
    type: 'drop',
    x: point.x,
    y: point.y,
    data,
  })
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

async function installPreviewEventProbe(cdp, studentId, expectedFileName) {
  const ready = await cdp.evaluate(`(() => {
    window.__releaseSmokePreviewUnsubscribe?.()
    window.__releaseSmokePreviewEvents = []
    window.__releaseSmokePreviewReady = false
    window.__releaseSmokePreviewUnsubscribe = window.api.on('photo:matched', (event) => {
      if (
        event.student.id === ${studentId}
        && event.photo.fileName === ${JSON.stringify(expectedFileName)}
        && event.preview
      ) {
        window.__releaseSmokePreviewEvents.push({
          studentId: event.student.id,
          captureId: event.captureId ?? null,
          fileName: event.photo.fileName,
          filePath: event.photo.filePath,
          previewKey: event.previewKey ?? null,
          previewUrl: event.photo.previewUrl ?? null,
        })
      }
    })
    window.__releaseSmokePreviewReady = true
    return window.__releaseSmokePreviewReady
      && Boolean(document.querySelector('[data-student-row="${studentId}"][aria-pressed="true"]'))
      && Boolean(document.querySelector('[data-filmstrip-capture]'))
  })()`)
  assert.equal(
    ready,
    true,
    `selected student renderer was not ready to observe ${expectedFileName}`,
  )
}

async function waitForPreviewEvent(cdp, expectedFileName) {
  return waitFor(`renderer preview event for ${expectedFileName}`, () => cdp.evaluate(`(() => {
    if (!window.__releaseSmokePreviewReady) return null
    return window.__releaseSmokePreviewEvents?.find((event) =>
      event.fileName === ${JSON.stringify(expectedFileName)}
      && event.previewUrl?.startsWith('mc-preview://')
      && event.previewKey
    ) ?? null
  })()`), 40_000)
}

async function waitForLivePreview(cdp, expectedPreview) {
  return waitFor(`live mc-preview JPEG for ${expectedPreview.fileName} to paint visible pixels`, async () => {
    const state = await cdp.evaluate(`(async () => {
    const canvas = document.querySelector('canvas[role="img"][aria-label^="Latest capture"]')
    const image = document.querySelector('img[alt^="Latest capture"]')
    const url = canvas?.dataset.previewUrl || image?.currentSrc || image?.src || null
    const state = {
      url,
      protocolStatus: null,
      contentType: null,
      responseBytes: null,
      decodedWidth: null,
      decodedHeight: null,
      decodeError: null,
      canvasWidth: canvas?.width ?? null,
      canvasHeight: canvas?.height ?? null,
      canvasVisiblePixels: null,
      canvasDisplay: canvas ? getComputedStyle(canvas).display : null,
      canvasError: null,
    }
    if (!url) return state

    const response = await fetch(url)
    state.protocolStatus = response.status
    state.contentType = response.headers.get('content-type')
    const bytes = await response.arrayBuffer()
    state.responseBytes = bytes.byteLength
    if (!response.ok || !/^image\\/jpeg(?:;|$)/i.test(state.contentType ?? '')) return state

    try {
      const bitmap = await createImageBitmap(new Blob([bytes], { type: state.contentType ?? '' }))
      state.decodedWidth = bitmap.width
      state.decodedHeight = bitmap.height
      bitmap.close()
    } catch (error) {
      state.decodeError = String(error)
      return state
    }

    if (canvas && canvas.width > 0 && canvas.height > 0) {
      try {
        const pixels = canvas.getContext('2d')?.getImageData(0, 0, canvas.width, canvas.height).data
        if (pixels) {
          let visible = 0
          for (let index = 0; index < pixels.length; index += 4) {
            if (pixels[index + 3] > 0 && pixels[index] + pixels[index + 1] + pixels[index + 2] > 30) {
              visible++
            }
          }
          state.canvasVisiblePixels = visible
        }
      } catch (error) {
        state.canvasError = String(error)
      }
    }
    return state
  })()`)
    const ready = state.url === expectedPreview.previewUrl
      && state.url?.startsWith('mc-preview://')
      && state.protocolStatus === 200
      && /^image\/jpeg(?:;|$)/i.test(state.contentType ?? '')
      && state.responseBytes > 0
      && state.decodedWidth > 0
      && state.decodedHeight > 0
      && state.canvasWidth > 0
      && state.canvasHeight > 0
      && state.canvasDisplay !== 'none'
      && state.canvasVisiblePixels > 0
    if (ready) return state
    throw new Error(`live preview not ready: ${JSON.stringify(state)}`)
  }, 40_000)
}

async function createReleasePreviewFixture() {
  const width = 1_600
  const height = 1_200
  const pixels = Buffer.alloc(width * height * 3)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 3
      const portrait = x > 420 && x < 1_180 && y > 120 && y < 1_100
      const stripe = (Math.floor(x / 60) + Math.floor(y / 60)) % 2 === 0
      pixels[offset] = portrait ? (stripe ? 220 : 170) : 20 + Math.round((x / width) * 55)
      pixels[offset + 1] = portrait ? (stripe ? 75 : 42) : 50 + Math.round((y / height) * 60)
      pixels[offset + 2] = portrait
        ? (stripe ? 40 : 18)
        : 120 + Math.round(((x + y) / (width + height)) * 60)
    }
  }
  return sharp(pixels, { raw: { width, height, channels: 3 } })
    .jpeg({ quality: 88 })
    .toBuffer()
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

let appOutput = ''
let appProcessError
let appProcess = spawnPackagedApp()

let cdp
try {
  cdp = await CdpClient.connect()
  await waitFor('sign-in screen', () => cdp.evaluate(
    `document.body.innerText.includes('Sign in with your studio account')`,
  ))

  const signedIn = await cdp.evaluate(`window.api.invoke('auth:signIn')`)
  assert.equal(signedIn.signedIn, true)

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
    { ok: true, classesImported: 1, studentsImported: 2 },
  )

  const localProjects = await cdp.evaluate(`window.api.invoke('projects:list')`)
  assert.equal(localProjects.length, 2)
  const legacyProject = localProjects.find((project) => project.schoolName === 'Existing Legacy Release Project')
  assert(legacyProject, 'the pre-update project must survive the packaged database upgrade')
  const legacyStudents = await cdp.evaluate(
    `window.api.invoke('students:list', { projectId: ${legacyProject.id} })`,
  )
  assert.equal(legacyStudents.length, 1)
  const legacyReview = await cdp.evaluate(
    `window.api.invoke('captures:list', { studentId: ${legacyStudents[0].id} })`,
  )
  assert.equal(legacyReview.captures.length, 1, 'legacy JPEG must render as one review capture')
  assert.equal(legacyReview.captures[0].legacyPhoto.filePath, legacyPhotoPath)
  assert.equal(legacyReview.captures[0].files[0].storedPath, legacyPhotoPath)
  assert.equal(existsSync(legacyPhotoPath), true, 'upgrade must not move or delete the legacy portrait')
  await cdp.evaluate('location.reload()')
  await waitFor('legacy project card for cold-cache preview', () => cdp.evaluate(
    `Boolean(document.querySelector('[data-project-card="${legacyProject.id}"]'))`,
  ))
  await cdp.evaluate(`document.querySelector('[data-project-card="${legacyProject.id}"]').click()`)
  await waitFor('legacy student row for cold-cache preview', () => cdp.evaluate(
    `Boolean(document.querySelector('[data-student-row="${legacyStudents[0].id}"]'))`,
  ))
  await cdp.evaluate(`document.querySelector('[data-student-row="${legacyStudents[0].id}"]').click()`)
  const legacyPreview = await waitFor('migrated legacy portrait to paint after lazy hydration', () => cdp.evaluate(
    `(() => {
      const image = [...document.querySelectorAll('.shoot-preview img[alt^="Capture "]')]
        .find((candidate) => candidate.src.startsWith('mc-preview://'))
      if (!image || !image.complete || image.naturalWidth <= 0 || image.naturalHeight <= 0) return false
      return {
        url: image.src,
        width: image.naturalWidth,
        height: image.naturalHeight,
      }
    })()`,
  ), 40_000)
  assert.match(legacyPreview.url, /^mc-preview:\/\//)
  assert(legacyPreview.width > 0 && legacyPreview.height > 0)
  await cdp.evaluate(`document.querySelector('button[aria-label="Back to projects"]').click()`)

  const localProject = localProjects.find((project) => project.schoolName === projectName)
  assert(localProject, 'the pulled project must be available after the upgrade')
  const localProjectId = localProject.id
  const localStudents = await cdp.evaluate(
    `window.api.invoke('students:list', { projectId: ${localProjectId} })`,
  )
  const localStudentOne = localStudents.find(
    (student) => student.generatedStudentId === studentReference,
  )
  const localStudentTwo = localStudents.find(
    (student) => student.generatedStudentId === '005678',
  )
  assert(localStudentOne, 'the first cloud student must have a local SQLite identity')
  assert(localStudentTwo, 'the second cloud student must have a local SQLite identity')
  const localStudentOneId = localStudentOne.id
  const localStudentTwoId = localStudentTwo.id
  await cdp.evaluate(`window.api.invoke('app:setPhotosDir', { dir: ${JSON.stringify(storageRoot)} })`)
  await cdp.evaluate(`window.api.invoke('projects:setWatchFolder', {
    projectId: ${localProjectId},
    folderPath: ${JSON.stringify(watchFolder)}
  })`)
  await cdp.evaluate(`window.api.invoke('watcher:start', { projectId: ${localProjectId} })`)

  // Exercise the secure preload bridge with actual native file drops. Both
  // students receive the same camera basename, so cross-student pairing would
  // be visible as missing or mixed review captures after restart.
  await cdp.evaluate('location.reload()')
  await waitFor('pulled project card after renderer auth refresh', () => cdp.evaluate(
    `Boolean(document.querySelector('[data-project-card="${localProjectId}"]'))`,
  ))
  await cdp.evaluate(`(() => {
    const card = document.querySelector('[data-project-card="${localProjectId}"]')
    if (card?.tagName !== 'BUTTON') {
      throw new Error('Pulled project card must render as a BUTTON, found ' + (card?.tagName ?? 'nothing'))
    }
    if (card.disabled) {
      throw new Error('Pulled project card must be enabled')
    }
    card.click()
    return true
  })()`)
  await waitFor('project roster', () => cdp.evaluate(
    `Boolean(
      document.querySelector('[data-student-row="${localStudentOneId}"]')
      && document.querySelector('[data-student-row="${localStudentTwoId}"]')
    )`,
  ))
  await cdp.evaluate(`window.api.invoke('watcher:setActiveStudent', {
    projectId: ${localProjectId},
    studentId: ${localStudentOneId}
  })`)
  online = false
  const dropSession = await cdp.evaluate(`window.api.invoke('auth:getSession')`)
  assert.equal(dropSession.offline, true)
  await cdp.evaluate(`window.api.invoke('upload:setLiveEnabled', {
    projectId: ${localProjectId},
    enabled: true
  })`)
  await dropFilesOnStudent(cdp, localStudentOneId, [droppedJpegOne, droppedRawOne])
  await dropFilesOnStudent(cdp, localStudentTwoId, [droppedJpegTwo, droppedRawTwo])
  assert.equal(
    await cdp.evaluate(`window.api.invoke('watcher:getActiveStudent', { projectId: ${localProjectId} })`),
    localStudentOneId,
    'dropping files on another student must not change the selected camera target',
  )

  const readDroppedCaptureState = async () => {
    const first = await cdp.evaluate(
      `window.api.invoke('captures:list', { studentId: ${localStudentOneId} })`,
    )
    const second = await cdp.evaluate(
      `window.api.invoke('captures:list', { studentId: ${localStudentTwoId} })`,
    )
    const queue = await cdp.evaluate(
      `window.api.invoke('upload:getQueue', { projectId: ${localProjectId} })`,
    )
    return { first, second, queue }
  }

  const findDroppedCapture = (review, expectedFiles) => review.captures.find((capture) => {
    const files = capture.files.map((file) => ({
      fileRole: file.fileRole,
      originalFilename: file.originalFilename,
      storedFilename: basename(file.storedPath),
    })).sort((left, right) => left.fileRole.localeCompare(right.fileRole))
    return JSON.stringify(files) === JSON.stringify(expectedFiles)
  })
  const firstDroppedFiles = [
    {
      fileRole: 'JPEG',
      originalFilename: `John_Smith_${studentReference}.JPG`,
      storedFilename: `John_Smith_${studentReference}.JPG`,
    },
    {
      fileRole: 'RAW',
      originalFilename: `John_Smith_${studentReference}.CR3`,
      storedFilename: `John_Smith_${studentReference}.CR3`,
    },
  ]
  const secondDroppedFiles = [
    {
      fileRole: 'JPEG',
      originalFilename: 'Maya_Chen_005678.JPG',
      storedFilename: 'Maya_Chen_005678.JPG',
    },
    {
      fileRole: 'RAW',
      originalFilename: 'Maya_Chen_005678.CR3',
      storedFilename: 'Maya_Chen_005678.CR3',
    },
  ]
  const expectedDroppedQueue = [
    `John Smith:JPEG:John_Smith_${studentReference}.JPG`,
    `John Smith:RAW:John_Smith_${studentReference}.CR3`,
    'Maya Chen:JPEG:Maya_Chen_005678.JPG',
    'Maya Chen:RAW:Maya_Chen_005678.CR3',
  ].sort()

  const hasDurableDroppedCaptureState = ({ first, second, queue }) => {
    const firstDropped = findDroppedCapture(first, firstDroppedFiles)
    const secondDropped = findDroppedCapture(second, secondDroppedFiles)
    if (
      !firstDropped
      || firstDropped.studentId !== localStudentOneId
      || firstDropped.pairingStatus !== 'complete'
      || !secondDropped
      || secondDropped.studentId !== localStudentTwoId
      || secondDropped.pairingStatus !== 'complete'
    ) return false

    const hasExpectedRoles = (capture) =>
      capture.files.map((file) => file.fileRole).sort().join(',') === 'JPEG,RAW'
    if (!hasExpectedRoles(firstDropped) || !hasExpectedRoles(secondDropped)) return false

    return JSON.stringify(
      queue.map((item) => `${item.subject}:${item.fileRole}:${item.fileName}`).sort(),
    ) === JSON.stringify(expectedDroppedQueue)
  }

  let droppedCaptureState
  await waitFor('durable dropped captures and transfer queue', async () => {
    droppedCaptureState = await readDroppedCaptureState()
    return hasDurableDroppedCaptureState(droppedCaptureState)
  }, 40_000)

  const assertDroppedCaptures = async (state) => {
    state ??= await readDroppedCaptureState()
    for (const [review, expectedStudent, expectedFiles] of [
      [state.first, localStudentOneId, firstDroppedFiles],
      [state.second, localStudentTwoId, secondDroppedFiles],
    ]) {
      const dropped = findDroppedCapture(review, expectedFiles)
      assert(dropped, `student ${expectedStudent} must retain the dropped capture`)
      assert.equal(dropped.studentId, expectedStudent)
      assert.equal(dropped.pairingStatus, 'complete')
      assert.deepEqual(
        dropped.files.map((file) => file.fileRole).sort(),
        ['JPEG', 'RAW'],
      )
      assert.deepEqual(
        dropped.files.map((file) => ({
          fileRole: file.fileRole,
          originalFilename: file.originalFilename,
          storedFilename: basename(file.storedPath),
        })).sort((left, right) => left.fileRole.localeCompare(right.fileRole)),
        expectedFiles,
        `student ${expectedStudent} must retain only its own renamed dropped files`,
      )
    }
    const { queue } = state
    assert.deepEqual(
      queue.map((item) => `${item.subject}:${item.fileRole}:${item.fileName}`).sort(),
      expectedDroppedQueue,
    )
  }
  await assertDroppedCaptures(droppedCaptureState)

  cdp.close()
  cdp = undefined
  await stopAppProcess(appProcess)
  appProcess = spawnPackagedApp()
  cdp = await CdpClient.connect()
  await waitFor('restarted signed desktop session', () => cdp.evaluate(
    `document.body.innerText.includes(${JSON.stringify(projectName)})`,
  ))
  await assertDroppedCaptures()
  const restartedLiveUpload = await cdp.evaluate(
    `window.api.invoke('upload:getLiveState', { projectId: ${localProjectId} })`,
  )
  assert.equal(restartedLiveUpload.enabled, true)
  assert.equal(restartedLiveUpload.pending, 4)
  await cdp.evaluate(`window.api.invoke('upload:setLiveEnabled', {
    projectId: ${localProjectId},
    enabled: false
  })`)

  // Return to the pulled project after the restart above so the live preview
  // reaches the real selected-student renderer rather than only the main process.
  await waitFor('pulled project card for portrait preview', () => cdp.evaluate(
    `Boolean(document.querySelector('[data-project-card="${localProjectId}"]'))`,
  ))
  await cdp.evaluate(`(() => {
    const card = document.querySelector('[data-project-card="${localProjectId}"]')
    if (card?.tagName !== 'BUTTON') {
      throw new Error('Pulled project card must render as a BUTTON, found ' + (card?.tagName ?? 'nothing'))
    }
    if (card.disabled) {
      throw new Error('Pulled project card must be enabled')
    }
    card.click()
  })()`)
  await waitFor('first student row for portrait preview', () => cdp.evaluate(
    `Boolean(document.querySelector('[data-student-row="${localStudentOneId}"]'))`,
  ))
  await cdp.evaluate(`window.api.invoke('watcher:stop', { projectId: ${localProjectId} })`)
  await cdp.evaluate(`window.api.invoke('watcher:start', { projectId: ${localProjectId} })`)
  await cdp.evaluate(`document.querySelector('[data-student-row="${localStudentOneId}"]').click()`)
  await waitFor('first student selected for portrait preview', () => cdp.evaluate(
    `document.querySelector('[data-student-row="${localStudentOneId}"]')?.getAttribute('aria-pressed') === 'true'`,
  ))
  await waitFor('selected student capture detail ready for live preview', () => cdp.evaluate(
    `Boolean(document.querySelector('[data-filmstrip-capture]'))`,
  ))
  // Capture while disconnected. This exercises cached authorization, local
  // matching, durable pending state, and remote-ID mapping. Reconnecting must
  // not silently upload; the photographer explicitly retries the pending file.
  const expectedPreviewFileName = `John_Smith_${studentReference}-2.jpg`
  await installPreviewEventProbe(cdp, localStudentOneId, expectedPreviewFileName)
  online = false
  writeFileSync(sourcePhoto, releasePreviewFixture)

  const expectedPreview = await waitForPreviewEvent(cdp, expectedPreviewFileName)
  assert.equal(expectedPreview.studentId, localStudentOneId)
  assert.equal(expectedPreview.fileName, expectedPreviewFileName)
  assert(expectedPreview.previewKey)
  assert.match(expectedPreview.previewUrl, /^mc-preview:\/\//)
  const livePreview = await waitForLivePreview(cdp, expectedPreview)
  assert.equal(
    livePreview.url,
    expectedPreview.previewUrl,
    `rendered preview did not belong to ${expectedPreviewFileName}`,
  )
  assert.equal(livePreview.protocolStatus, 200, `mc-preview protocol failed: ${JSON.stringify(livePreview)}`)
  assert.match(
    livePreview.contentType,
    /^image\/jpeg(?:;|$)/i,
    `mc-preview returned the wrong MIME type: ${JSON.stringify(livePreview)}`,
  )
  assert(
    livePreview.decodedWidth <= 1_440
      && livePreview.decodedHeight <= 1_440
      && (livePreview.decodedWidth < 1_600 || livePreview.decodedHeight < 1_200),
    `live preview dimensions were not reduced from 1600x1200: ${JSON.stringify(livePreview)}`,
  )
  assert(
    livePreview.canvasVisiblePixels > 0,
    `live preview canvas remained blank: ${JSON.stringify(livePreview)}`,
  )

  await waitFor('managed photo copy and SQLite photo row', async () => {
    const project = await cdp.evaluate(`window.api.invoke('projects:get', { projectId: ${localProjectId} })`)
    return project?.photoCount === 3 && findFiles(storageRoot).some((path) => basename(path) === managedPhotoName)
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
  const sourcePhotoUpload = waitingUploads.reduce(
    (latest, photo) => !latest || photo.id > latest.id ? photo : latest,
    null,
  )
  assert(sourcePhotoUpload, 'the later watched JPEG must have a durable upload row')
  assert.equal(
    sourcePhotoUpload.uploadStatus,
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
  assert.equal(
    stillPendingAfterReconnect.find((photo) => photo.id === sourcePhotoUpload.id)?.uploadStatus,
    null,
  )

  const retryResult = await cdp.evaluate(
    `window.api.invoke('upload:retry', { photoId: ${sourcePhotoUpload.id} })`,
  )
  assert.equal(retryResult.ok, true)
  await waitFor('explicit pending upload retry', async () => {
    const statuses = await cdp.evaluate(
      `window.api.invoke('upload:getProjectStatus', { projectId: ${localProjectId} })`,
    )
    return uploadCount === 1
      && statuses.find((photo) => photo.id === sourcePhotoUpload.id)?.uploadStatus === 'done'
  }, 35_000)
  assert.equal(uploadCount, 1, 'the explicit retry must upload exactly once')

  // A roster re-sync must reconcile the student in place so captured photos
  // keep their local student foreign key.
  const resynced = await cdp.evaluate(`window.api.invoke('cloud:pullProject', { cloudProjectId: 41 })`)
  assert.equal(resynced.ok, true)
  const photosAfterResync = await cdp.evaluate(
    `window.api.invoke('upload:getProjectStatus', { projectId: ${localProjectId} })`,
  )
  assert.equal(photosAfterResync.length, 3)
  assert.equal(
    photosAfterResync.find((photo) => photo.id === sourcePhotoUpload.id)?.uploadStatus,
    'done',
  )

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
  const annotation = String(error?.stack ?? error)
    .replaceAll('%', '%25')
    .replaceAll('\r', '%0D')
    .replaceAll('\n', '%0A')
  console.error(`::error title=Packaged retirement smoke failed::${annotation}`)
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
  try {
    rmSync(root, {
      recursive: true,
      force: true,
      maxRetries: 20,
      retryDelay: 100,
    })
  } catch (error) {
    console.warn(
      `[smoke] Could not remove temporary directory after all release assertions passed: ${error}`,
    )
  }
}