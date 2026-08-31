import { strict as assert } from 'node:assert'
import { performance } from 'node:perf_hooks'
import {
  copyFile,
  mkdir,
  mkdtemp,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { Jimp } from 'jimp'
import { processWatchedPhoto, type WatchedPhotoStore } from '../src/main/lib/watchedPhotoProcessor.ts'
import { waitForStableFile } from '../src/main/lib/fileStability.ts'

const SAMPLE_COUNT = 50
const timestamp = '2026-08-31T12:00:00.000Z'
type PreviewStrategy = 'thumbnail-data-url' | 'thumbnail-disk' | 'direct-local-jpeg'

type StageSample = {
  stability: number
  assignment: number
  thumbnail: number
  notification: number
  persistence: number
  totalVisible: number
}

type BurstResult = {
  latencies: number[]
  strategy: PreviewStrategy
}

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]
}

function createStore(): WatchedPhotoStore {
  const project = {
    id: 1,
    schoolName: 'Benchmark School',
    photoDate: null,
    address: null,
    contactName: null,
    contactEmail: null,
    contactPhone: null,
    notes: null,
    watchFolder: null,
    finishedAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  }
  const classRow = {
    id: 1,
    projectId: 1,
    className: 'Class 1',
    createdAt: timestamp,
    updatedAt: timestamp,
  }
  const student = {
    id: 1,
    projectId: 1,
    classId: 1,
    firstName: 'Benchmark',
    lastName: 'Student',
    generatedStudentId: 'BENCHMARK-001',
    email: null,
    phone: null,
    simpleQr: null,
    jsonQr: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  }
  let nextPhotoId = 1
  return {
    findProject: (projectId) => (projectId === project.id ? project : undefined),
    listStudents: (projectId) => (projectId === project.id ? [student] : []),
    findStudent: (projectId, generatedStudentId) =>
      projectId === project.id && generatedStudentId === student.generatedStudentId
        ? student
        : undefined,
    findClass: (classId) => (classId === classRow.id ? classRow : undefined),
    insertPhoto: (photo) => ({
      id: nextPhotoId++,
      uploadStatus: null,
      fileUrl: null,
      createdAt: timestamp,
      ...photo,
    }),
  }
}

async function runBatch(
  root: string,
  sourceBytes: Buffer,
  mode: 'jpeg' | 'jpeg+nef',
  previewStrategy: PreviewStrategy,
): Promise<StageSample[]> {
  const sourceDir = join(root, mode, previewStrategy, 'watch')
  const organizedDir = join(root, mode, previewStrategy, 'organized')
  await mkdir(sourceDir, { recursive: true })
  const samples: StageSample[] = []
  const store = createStore()

  for (let index = 0; index < SAMPLE_COUNT; index++) {
    const fileName = `capture-${String(index + 1).padStart(3, '0')}.jpg`
    const filePath = join(sourceDir, fileName)
    const nefPath = join(sourceDir, fileName.replace(/\.jpg$/i, '.NEF'))
    const eventAt = performance.now()
    await writeFile(filePath, sourceBytes)
    if (mode === 'jpeg+nef') await copyFile(filePath, nefPath)

    const stableAtStart = performance.now()
    const stable = await waitForStableFile(filePath, (path) => stat(path))
    const stableAt = performance.now()
    assert.equal(stable.size, sourceBytes.length)

    let assignmentAt = stableAt
    let thumbnailAt = stableAt
    let notificationAt = stableAt
    const persistenceAtStart = performance.now()
    const result = await processWatchedPhoto(1, filePath, {
      store,
      photosDir: organizedDir,
      readQr: async () => null,
      targetStudentId: 1,
      capturedAt: timestamp,
      onPreviewReady: async (context) => {
        assignmentAt = performance.now()
        const thumbnailStart = performance.now()
        let thumbnail: string
        if (previewStrategy === 'direct-local-jpeg') {
          thumbnail = context.filePath
        } else {
          const image = await Jimp.read(context.filePath)
          image.cover({ w: 900, h: 900 })
          if (previewStrategy === 'thumbnail-data-url') {
            thumbnail = await image.getBase64('image/jpeg')
          } else {
            const previewPath = join(root, mode, previewStrategy, 'previews', fileName)
            await mkdir(join(root, mode, previewStrategy, 'previews'), { recursive: true })
            const previewBytes = await image.getBuffer('image/jpeg')
            await writeFile(previewPath, previewBytes)
            thumbnail = previewPath
          }
        }
        thumbnailAt = performance.now()
        notificationAt = performance.now()
        return thumbnail
      },
    })
    const persistenceAt = performance.now()
    assert.equal(result.kind, 'matched')
    assert.equal(result.student.id, 1)

    samples.push({
      stability: stableAt - stableAtStart,
      assignment: assignmentAt - stableAt,
      thumbnail: thumbnailAt - assignmentAt,
      notification: notificationAt - thumbnailAt,
      persistence: persistenceAt - persistenceAtStart,
      totalVisible: notificationAt - eventAt,
    })
  }

  return samples
}

async function runBurst(
  root: string,
  sourceBytes: Buffer,
  previewStrategy: PreviewStrategy,
): Promise<BurstResult> {
  const sourceDir = join(root, 'burst', previewStrategy, 'watch')
  const organizedDir = join(root, 'burst', previewStrategy, 'organized')
  await mkdir(sourceDir, { recursive: true })
  const burstStartedAt = performance.now()
  const paths = Array.from({ length: SAMPLE_COUNT }, (_, index) =>
    join(sourceDir, `burst-${String(index + 1).padStart(3, '0')}.jpg`))

  await Promise.all(paths.map((filePath) => writeFile(filePath, sourceBytes)))
  const stableFiles = await Promise.all(paths.map((filePath) =>
    waitForStableFile(filePath, (path) => stat(path))))
  const store = createStore()
  const latencies: number[] = []

  // This intentionally mirrors the watcher's current serialized processing
  // queue: all filesystem events are ready, then captures are handled in
  // order. It exposes latency growth caused by a slow preview stage.
  for (let index = 0; index < paths.length; index++) {
    await processWatchedPhoto(1, paths[index], {
      store,
      photosDir: organizedDir,
      readQr: async () => null,
      targetStudentId: 1,
      capturedAt: timestamp,
      onPreviewReady: async (context) => {
        if (previewStrategy === 'direct-local-jpeg') {
          latencies.push(performance.now() - burstStartedAt)
          return context.filePath
        }
        const image = await Jimp.read(context.filePath)
        image.cover({ w: 900, h: 900 })
        if (previewStrategy === 'thumbnail-data-url') {
          const dataUrl = await image.getBase64('image/jpeg')
          latencies.push(performance.now() - burstStartedAt)
          return dataUrl
        }
        const previewPath = join(root, 'burst', previewStrategy, 'previews', basename(paths[index]))
        await mkdir(join(root, 'burst', previewStrategy, 'previews'), { recursive: true })
        await writeFile(previewPath, await image.getBuffer('image/jpeg'))
        latencies.push(performance.now() - burstStartedAt)
        return previewPath
      },
    })
    assert.equal(stableFiles[index].size, sourceBytes.length)
  }

  return { latencies, strategy: previewStrategy }
}

function report(label: string, samples: StageSample[]): void {
  const fields = ['stability', 'assignment', 'thumbnail', 'notification', 'persistence', 'totalVisible'] as const
  console.log(`\n${label} (${samples.length} captures)`)
  for (const field of fields) {
    const values = samples.map((sample) => sample[field])
    console.log(
      `  ${field.padEnd(12)} avg=${average(values).toFixed(1)}ms`
        + ` p50=${percentile(values, 0.5).toFixed(1)}ms`
        + ` p95=${percentile(values, 0.95).toFixed(1)}ms`,
    )
  }
  console.log('  render        measured in the packaged renderer through image-pipeline diagnostics')
  console.log('  database      included in persistence stage; upload/sync deferred by design')
}

const root = await mkdtemp(join(tmpdir(), 'mc-school-studio-image-benchmark-'))
try {
  const image = new Jimp({ width: 1600, height: 1200, color: 0x2f8f83ff })
  const sourceBytes = await image.getBuffer('image/jpeg')
  for (const strategy of ['thumbnail-data-url', 'thumbnail-disk', 'direct-local-jpeg'] as const) {
    const jpegSamples = await runBatch(root, sourceBytes, 'jpeg', strategy)
    const pairedSamples = await runBatch(root, sourceBytes, 'jpeg+nef', strategy)
    report(`JPEG benchmark · ${strategy}`, jpegSamples)
    report(`JPEG + NEF benchmark · ${strategy}`, pairedSamples)
  }
  for (const strategy of ['thumbnail-data-url', 'direct-local-jpeg'] as const) {
    const burst = await runBurst(root, sourceBytes, strategy)
    console.log(
      `\nBurst benchmark · ${burst.strategy} (${burst.latencies.length} captures ready from one burst)`
      + `\n  first=${burst.latencies[0].toFixed(1)}ms`
      + ` p50=${percentile(burst.latencies, 0.5).toFixed(1)}ms`
      + ` p95=${percentile(burst.latencies, 0.95).toFixed(1)}ms`
      + ` last=${burst.latencies[burst.latencies.length - 1].toFixed(1)}ms`,
    )
  }
  console.log('\nBaseline architecture budget: 1,500ms stability + 500ms flush before processing.')
  console.log('Fixed architecture budget: 75ms stability check + 50ms flush before processing.')
  console.log('Direct-local results measure preview URL readiness; actual decode and paint are reported by packaged-renderer diagnostics.')
} finally {
  await rm(root, { recursive: true, force: true })
}
