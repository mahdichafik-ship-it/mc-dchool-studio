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
import { join } from 'node:path'
import { Jimp } from 'jimp'
import { processWatchedPhoto, type WatchedPhotoStore } from '../src/main/lib/watchedPhotoProcessor.ts'
import { waitForStableFile } from '../src/main/lib/fileStability.ts'

const SAMPLE_COUNT = 50
const timestamp = '2026-08-31T12:00:00.000Z'

type StageSample = {
  stability: number
  assignment: number
  thumbnail: number
  notification: number
  persistence: number
  totalVisible: number
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
): Promise<StageSample[]> {
  const sourceDir = join(root, mode, 'watch')
  const organizedDir = join(root, mode, 'organized')
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
        const thumbnail = await (async () => {
          const image = await Jimp.read(context.filePath)
          image.cover({ w: 900, h: 900 })
          return image.getBase64('image/jpeg')
        })()
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
  console.log('  render        measured in the packaged renderer through T10 diagnostics')
  console.log('  database      included in persistence stage; upload/sync deferred by design')
}

const root = await mkdtemp(join(tmpdir(), 'mc-school-studio-image-benchmark-'))
try {
  const image = new Jimp({ width: 1600, height: 1200, color: 0x2f8f83ff })
  const sourceBytes = await image.getBuffer('image/jpeg')
  const jpegSamples = await runBatch(root, sourceBytes, 'jpeg')
  const pairedSamples = await runBatch(root, sourceBytes, 'jpeg+nef')
  report('JPEG benchmark', jpegSamples)
  report('JPEG + NEF benchmark', pairedSamples)
  console.log('\nBaseline architecture budget: 1,500ms stability + 500ms flush before processing.')
  console.log('Fixed architecture budget: 75ms stability check + 50ms flush before processing.')
} finally {
  await rm(root, { recursive: true, force: true })
}
