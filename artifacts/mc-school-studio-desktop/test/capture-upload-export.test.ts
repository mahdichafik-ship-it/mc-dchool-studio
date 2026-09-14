import assert from 'node:assert/strict'
import test from 'node:test'
import {
  exportCaptureRecords,
  type CaptureExportRecord,
} from '../src/main/ipc/captureExport.ts'
import {
  syncProjectUploads,
  type ProjectSyncJob,
} from '../src/main/ipc/upload.ts'
import { parseUploadResponseJson } from '../src/main/lib/uploadResponseValidation.ts'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

function captureJob(fileId: number): ProjectSyncJob {
  return { kind: 'capture-file', captureId: 1, fileId }
}

test('uploads JPEG and RAW files as independent jobs with independent failures', async () => {
  const jpeg = captureJob(101)
  const raw = captureJob(102)
  const attempts: number[] = []

  const result = await syncProjectUploads(1, undefined, undefined, {
    getJobs: () => [jpeg, raw],
    isCloudSessionVerified: () => true,
    uploadProjectJob: async (job) => {
      const fileId = job.kind === 'capture-file' ? job.fileId : -1
      attempts.push(fileId)
      if (fileId === raw.fileId) throw new Error('RAW transfer failed')
    },
  })

  assert.equal(result.completed, 1)
  assert.equal(result.total, 2)
  assert.equal(result.failed, 1)
  assert.equal(result.error, 'RAW transfer failed')
  assert.deepEqual(attempts.sort((a, b) => a - b), [jpeg.fileId, raw.fileId])
})

test('initially unavailable capture uploads recover after reconnect and a fresh sync run', async () => {
  const jobs = [captureJob(201), captureJob(202)]
  let connected = false
  const uploaded: number[] = []

  const dependencies = {
    getJobs: () => jobs,
    isCloudSessionVerified: () => connected,
    uploadProjectJob: async (job: ProjectSyncJob) => {
      uploaded.push(job.kind === 'capture-file' ? job.fileId : -1)
    },
  }

  const offline = await syncProjectUploads(1, undefined, undefined, dependencies)
  assert.deepEqual(offline, {
    completed: 0,
    total: 2,
    failed: 2,
    error: 'Cloud sync is unavailable. Local captures are safe; reconnect and try again.',
  })

  connected = true
  const afterReconnect = await syncProjectUploads(1, undefined, undefined, dependencies)
  assert.deepEqual(afterReconnect, { completed: 2, total: 2, failed: 0 })
  assert.deepEqual(uploaded.sort((a, b) => a - b), [201, 202])
})

test('a reused server upload response still maps to one local capture-file job', async () => {
  const payload = parseUploadResponseJson({
    captureId: 1,
    captureKey: 'capture-1',
    pairingStatus: 'complete',
    file: {
      id: 301,
      fileRole: 'JPEG',
      fileFormat: 'JPG',
      originalFilename: 'portrait.jpg',
      mimeType: 'image/jpeg',
      fileSize: 10,
      fileUrl: '/uploads/portrait.jpg',
    },
    reused: true,
  }, 'capture')
  assert.equal(payload.reused, true)

  const job = captureJob(payload.file!.id as number)
  let uploadCount = 0
  const result = await syncProjectUploads(1, undefined, undefined, {
    getJobs: () => [job, job],
    isCloudSessionVerified: () => true,
    uploadProjectJob: async () => { uploadCount++ },
  })

  assert.deepEqual(result, { completed: 1, total: 1, failed: 0 })
  assert.equal(uploadCount, 1)
})

function makeRecord(
  id: number,
  pairingStatus: 'complete' | 'jpeg_only' | 'raw_only',
  options: { selected?: boolean; favorite?: boolean; rejected?: boolean } = {},
): CaptureExportRecord {
  return {
    capture: {
      id,
      pairingStatus,
      selected: options.selected ?? false,
      favorite: options.favorite ?? false,
      rejected: options.rejected ?? false,
      baseFilename: `capture-${id}`,
      sequence: id,
      capturedAt: '2026-09-14T12:00:00.000Z',
    },
    files: [],
    className: 'Class / Blue',
    student: {
      firstName: 'Ana',
      lastName: 'Olsen',
      generatedStudentId: `STUDENT-${id}`,
    },
  }
}

function addFile(
  record: CaptureExportRecord,
  fileRole: 'JPEG' | 'RAW',
  originalFilename: string,
  storedPath: string,
): void {
  record.files.push({
    fileRole,
    fileFormat: fileRole === 'JPEG' ? 'JPG' : 'CR3',
    originalFilename,
    storedPath,
  })
}

test('exports every capture mode and keeps a JPEG/RAW pair in one sequence folder', () => {
  const root = mkdtempSync(join(tmpdir(), 'volume-capture-export-modes-'))
  try {
    const jpegPath = join(root, 'source.jpg')
    const rawPath = join(root, 'source.cr3')
    writeFileSync(jpegPath, 'jpeg-bytes')
    writeFileSync(rawPath, 'raw-bytes')

    const records = [
      makeRecord(1, 'complete', { selected: true, favorite: true }),
      makeRecord(2, 'jpeg_only'),
      makeRecord(3, 'raw_only'),
      makeRecord(4, 'complete', { selected: true, rejected: true }),
    ]
    addFile(records[0], 'JPEG', 'portrait.jpg', jpegPath)
    addFile(records[0], 'RAW', 'portrait.cr3', rawPath)
    addFile(records[1], 'JPEG', 'jpeg-only.jpg', jpegPath)
    addFile(records[2], 'RAW', 'raw-only.cr3', rawPath)
    addFile(records[3], 'JPEG', 'rejected.jpg', jpegPath)

    const expectedIds: Record<string, number[]> = {
      all: [1, 2, 3, 4],
      paired: [1, 4],
      jpeg_only: [2],
      raw_only: [3],
      selected: [1, 4],
      favorite: [1],
      final_selection: [1],
    }

    for (const [mode, ids] of Object.entries(expectedIds)) {
      const result = exportCaptureRecords({
        project: { schoolName: 'North: Shore School' },
        records,
        destinationDir: join(root, mode),
        mode: mode as 'all' | 'paired' | 'jpeg_only' | 'raw_only' | 'selected' | 'favorite' | 'final_selection',
      })
      assert.equal(result.ok, true)
      assert.equal(result.exportedCaptureCount, ids.length, mode)
      assert.equal(
        result.exportedFileCount,
        ids.reduce((count, id) => count + (id === 1 ? 2 : 1), 0),
        mode,
      )
    }

    const pairFolder = join(root, 'all', 'North- Shore School-captures', '000001_capture-1')
    assert.equal(readFileSync(join(pairFolder, 'portrait.jpg'), 'utf8'), 'jpeg-bytes')
    assert.equal(readFileSync(join(pairFolder, 'portrait.cr3'), 'utf8'), 'raw-bytes')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('reports missing files and never lets an exported filename escape its capture folder', () => {
  const root = mkdtempSync(join(tmpdir(), 'volume-capture-export-safety-'))
  try {
    const existingPath = join(root, 'existing.jpg')
    writeFileSync(existingPath, 'jpeg-bytes')
    const record = makeRecord(9, 'complete')
    addFile(record, 'JPEG', '..', existingPath)
    addFile(record, 'RAW', 'missing.cr3', join(root, 'does-not-exist.cr3'))

    const result = exportCaptureRecords({
      project: { schoolName: 'School' },
      records: [record],
      destinationDir: root,
      mode: 'paired',
    })

    assert.equal(result.exportedCaptureCount, 1)
    assert.equal(result.exportedFileCount, 1)
    assert.equal(result.skippedMissingFiles, 1)
    const captureDir = resolve(root, 'School-captures', '000009_capture-9')
    assert.equal(readFileSync(join(captureDir, 'captures'), 'utf8'), 'jpeg-bytes')
    assert.equal(existsSync(join(root, 'captures')), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('Lightroom exports are flat, pair-compatible, and idempotent', () => {
  const root = mkdtempSync(join(tmpdir(), 'volume-capture-lightroom-export-'))
  try {
    const sourcePath = join(root, 'source.jpg')
    writeFileSync(sourcePath, 'jpeg-bytes')
    const record = makeRecord(12, 'complete', { selected: true })
    addFile(record, 'JPEG', 'IMG_001.JPG', sourcePath)

    const input = {
      project: { schoolName: 'School / One' },
      records: [record],
      destinationDir: join(root, 'watch'),
      mode: 'selected' as const,
      layout: 'lightroom_watch_folder' as const,
    }
    const first = exportCaptureRecords(input)
    const second = exportCaptureRecords(input)

    assert.equal(first.exportedFileCount, 1)
    assert.equal(first.skippedExistingFiles, 0)
    assert.equal(second.exportedFileCount, 0)
    assert.equal(second.skippedExistingFiles, 1)
    assert.deepEqual(
      requireFileNames(input.destinationDir),
      ['School_-_One_Class_-_Blue_Olsen_Ana_STUDENT-12_000012_capture-12.JPG'],
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

function requireFileNames(directory: string): string[] {
  return readdirSync(directory).sort()
}