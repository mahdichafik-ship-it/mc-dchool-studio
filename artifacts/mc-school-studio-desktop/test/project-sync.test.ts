import assert from 'node:assert/strict'
import test from 'node:test'
import { runProjectSync } from '../src/main/ipc/projectSync.ts'
import type { ProjectSyncDependencies } from '../src/main/ipc/projectSync.ts'
import { syncProjectUploads } from '../src/main/ipc/upload.ts'
import type { ProjectSyncJob, ProjectSyncProgress } from '../src/main/ipc/upload.ts'

type TestProject = {
  id: number
  syncStatus: 'active' | 'finished_local' | 'syncing' | 'sync_failed' | 'synced'
  syncCompletedFiles: number
  syncTotalFiles: number
  syncFailedFiles: number
  syncError: string | null
  finishedAt: string | null
}

type HarnessOptions = {
  project?: Partial<TestProject>
  cloudReady?: boolean
  expectedFiles?: number
  progress?: ProjectSyncProgress
  reviewPending?: { portrait: number; group: number }
  blockers?: number
  finishError?: Error
}

function createHarness(options: HarnessOptions = {}) {
  const state: TestProject = {
    id: 1,
    syncStatus: 'active',
    syncCompletedFiles: 0,
    syncTotalFiles: 0,
    syncFailedFiles: 0,
    syncError: null,
    finishedAt: null,
    ...options.project,
  }
  const calls: string[] = []
  const progressEvents: Array<{ phase: string; completed: number; total: number; failed: number }> = []
  const batches: Array<{ key: string; expected: number; status?: string }> = []
  const uploadBatchKeys: string[] = []
  const batchKey = 'stable-batch-key'
  const progress = options.progress ?? { completed: 0, total: options.expectedFiles ?? 0, failed: 0 }

  const deps: ProjectSyncDependencies = {
    getProject: () => state as never,
    updateProject: (_projectId, values) => Object.assign(state, values),
    emitProgress: (event) => progressEvents.push({
      phase: event.phase,
      completed: event.completed,
      total: event.total,
      failed: event.failed,
    }),
    pauseLiveUploadForFinish: async () => { calls.push('pause') },
    stopProjectWatcher: async (_projectId, options) => {
      calls.push(`stop:${options.drain ? 'drain' : 'no-drain'}:${options.clearTarget ? 'clear' : 'keep'}`)
    },
    getUploadConfig: () => options.cloudReady === false
      ? { apiUrl: '', connectionToken: '' }
      : { apiUrl: 'https://capture.test', connectionToken: 'token' },
    isCloudSessionVerified: () => options.cloudReady !== false,
    getProjectCaptureBatchExpectedCount: () => options.expectedFiles ?? progress.total,
    getProjectUploadBlockerCount: () => options.blockers ?? 0,
    syncGroupCloudIdentities: async () => { calls.push('sync-groups') },
    beginProjectCaptureBatch: async (_projectId, expected) => {
      calls.push('begin')
      batches.push({ key: batchKey, expected })
      return batchKey
    },
    syncProjectUploads: async (_projectId, onProgress, key) => {
      calls.push('uploads')
      uploadBatchKeys.push(key ?? '')
      onProgress?.(progress)
      return progress
    },
    flushPendingCaptureReviews: async () => options.reviewPending ?? { portrait: 0, group: 0 },
    finishProjectCaptureBatch: async (_projectId, key, status, failed) => {
      calls.push(`finish:${status}:${failed}`)
      const batch = batches.find((candidate) => candidate.key === key)
      if (batch) batch.status = status
      if (options.finishError) throw options.finishError
    },
  }

  return { state, calls, progressEvents, batches, uploadBatchKeys, deps }
}

test('offline finish drains and closes the local shoot before any cloud upload', async () => {
  const harness = createHarness({ cloudReady: false, expectedFiles: 3 })

  const result = await runProjectSync(1, {}, harness.deps)

  assert.equal(result.localFinished, true)
  assert.equal(result.syncStatus, 'finished_local')
  assert.equal(harness.state.syncStatus, 'finished_local')
  assert.equal(harness.state.syncTotalFiles, 3)
  assert.deepEqual(harness.calls, ['pause', 'stop:drain:clear'])
  assert.equal(harness.batches.length, 0)
  assert.deepEqual(harness.progressEvents.at(-1), {
    phase: 'finished-locally',
    completed: 0,
    total: 3,
    failed: 0,
  })
})

test('reopening a locally finished or failed project preserves its durable progress independently', async () => {
  const first = createHarness({
    cloudReady: false,
    project: { id: 1, syncStatus: 'finished_local', finishedAt: '2025-01-01T00:00:00.000Z', syncCompletedFiles: 2, syncTotalFiles: 5 },
  })
  const second = createHarness({
    cloudReady: false,
    project: { id: 2, syncStatus: 'sync_failed', finishedAt: '2025-01-02T00:00:00.000Z', syncCompletedFiles: 4, syncTotalFiles: 6, syncFailedFiles: 2, syncError: 'network down' },
  })

  const [firstResult, secondResult] = await Promise.all([
    runProjectSync(1, {}, first.deps),
    runProjectSync(2, {}, second.deps),
  ])

  assert.equal(firstResult.syncStatus, 'finished_local')
  assert.equal(firstResult.completed, 2)
  assert.equal(firstResult.total, 5)
  assert.equal(secondResult.syncStatus, 'sync_failed')
  assert.equal(secondResult.completed, 4)
  assert.equal(secondResult.total, 6)
  assert.equal(secondResult.failed, 2)
  assert.deepEqual(first.calls, [])
  assert.deepEqual(second.calls, [])
})

test('network interruption preserves completed, pending, and failed files without marking the project synced', async () => {
  const harness = createHarness({
    project: { syncStatus: 'finished_local', finishedAt: '2025-01-01T00:00:00.000Z', syncTotalFiles: 3 },
    progress: { completed: 2, total: 3, failed: 1, error: 'network interrupted' },
  })

  const result = await runProjectSync(1, {}, harness.deps)

  assert.equal(result.ok, false)
  assert.equal(result.syncStatus, 'sync_failed')
  assert.equal(harness.state.syncStatus, 'sync_failed')
  assert.deepEqual(
    [harness.state.syncCompletedFiles, harness.state.syncTotalFiles, harness.state.syncFailedFiles],
    [2, 3, 1],
  )
  assert.equal(harness.state.syncError, 'network interrupted')
  assert.equal(harness.calls.includes('finish:failed:1'), true)
  assert.equal(harness.calls.includes('finish:complete:0'), false)
})

test('manual retry reuses the stable batch identity and reaches synced only after all files and reviews complete', async () => {
  const harness = createHarness({
    project: { syncStatus: 'sync_failed', finishedAt: '2025-01-01T00:00:00.000Z', syncCompletedFiles: 2, syncTotalFiles: 3, syncFailedFiles: 1 },
    progress: { completed: 3, total: 3, failed: 0 },
  })

  const result = await runProjectSync(1, { photographerComment: '  retry  ' }, harness.deps)

  assert.equal(result.ok, true)
  assert.equal(result.syncStatus, 'synced')
  assert.equal(harness.state.syncStatus, 'synced')
  assert.deepEqual(
    [harness.state.syncCompletedFiles, harness.state.syncTotalFiles, harness.state.syncFailedFiles],
    [3, 3, 0],
  )
  assert.deepEqual(harness.batches, [{ key: 'stable-batch-key', expected: 3, status: 'complete' }])
  assert.deepEqual(harness.uploadBatchKeys, ['stable-batch-key'])
  assert.equal(harness.calls.includes('finish:complete:0'), true)
})

test('pending portrait or group review edits keep a fully uploaded project retryable', async () => {
  const harness = createHarness({
    project: { syncStatus: 'finished_local', finishedAt: '2025-01-01T00:00:00.000Z' },
    progress: { completed: 4, total: 4, failed: 0 },
    reviewPending: { portrait: 1, group: 1 },
  })

  const result = await runProjectSync(1, {}, harness.deps)

  assert.equal(result.ok, false)
  assert.equal(result.syncStatus, 'sync_failed')
  assert.equal(harness.state.syncStatus, 'sync_failed')
  assert.equal(harness.state.syncCompletedFiles, 4)
  assert.match(harness.state.syncError ?? '', /2 capture review/)
  assert.equal(harness.calls.includes('finish:complete:0'), false)
  assert.equal(harness.calls.includes('finish:failed:0'), true)
})

test('already-done plus newly uploaded progress is bounded by the durable total', async () => {
  const harness = createHarness({
    project: { syncStatus: 'finished_local', finishedAt: '2025-01-01T00:00:00.000Z', syncCompletedFiles: 2, syncTotalFiles: 5 },
    progress: { completed: 5, total: 5, failed: 0 },
  })

  const result = await runProjectSync(1, {}, harness.deps)

  assert.equal(result.completed, 5)
  assert.equal(result.total, 5)
  assert.ok(result.completed <= result.total)
  assert.equal(harness.state.syncCompletedFiles, 5)
  assert.equal(harness.state.syncTotalFiles, 5)
})

test('durable project progress clamps stale completed counters to the total', async () => {
  const harness = createHarness({
    cloudReady: false,
    project: {
      syncStatus: 'finished_local',
      finishedAt: '2025-01-01T00:00:00.000Z',
      syncCompletedFiles: 9,
      syncTotalFiles: 3,
    },
  })

  const result = await runProjectSync(1, {}, harness.deps)

  assert.equal(result.completed, 3)
  assert.equal(result.total, 3)
  assert.equal(harness.state.syncCompletedFiles, 3)
  assert.ok(harness.progressEvents.every((event) => event.completed <= event.total))
})

test('a blocked unmatched file stops cloud completion while preserving local captures', async () => {
  const harness = createHarness({
    project: { syncStatus: 'finished_local', finishedAt: '2025-01-01T00:00:00.000Z', syncCompletedFiles: 1, syncTotalFiles: 2 },
    blockers: 1,
  })

  const result = await runProjectSync(1, {}, harness.deps)

  assert.equal(result.syncStatus, 'sync_failed')
  assert.equal(result.failed, 1)
  assert.match(result.error ?? '', /student match/)
  assert.equal(harness.calls.includes('uploads'), false)
})

function captureJob(fileId: number): ProjectSyncJob {
  return { kind: 'capture-file', captureId: fileId, fileId }
}

async function aggregateUploads(
  allJobs: ProjectSyncJob[],
  pendingJobs: ProjectSyncJob[],
  failures: Set<number> = new Set(),
) {
  const events: ProjectSyncProgress[] = []
  const progress = await syncProjectUploads(
    1,
    (current) => events.push(current),
    'batch-for-aggregation-test',
    {
      getJobs: (_projectId, includeDone) => includeDone ? allJobs : pendingJobs,
      isCloudSessionVerified: () => true,
      uploadProjectJob: async (job) => {
        if (failures.has(job.kind === 'capture-file' ? job.fileId : -1)) {
          throw new Error(`file ${job.kind === 'capture-file' ? job.fileId : 'unknown'} failed`)
        }
      },
    },
  )
  return { progress, events }
}

test('real upload aggregation reports three failures as zero completed and three failed', async () => {
  const { progress, events } = await aggregateUploads(
    [captureJob(1), captureJob(2), captureJob(3)],
    [captureJob(1), captureJob(2), captureJob(3)],
    new Set([1, 2, 3]),
  )

  assert.deepEqual(progress, { completed: 0, total: 3, failed: 3, error: 'file 1 failed' })
  assert.ok(events.every((event) => event.completed + (event.total - event.completed) === event.total))
  assert.ok(events.every((event) => event.completed <= event.total))
})

test('real upload aggregation combines already-done files with new success and failure', async () => {
  const { progress } = await aggregateUploads(
    [captureJob(1), captureJob(2), captureJob(3)],
    [captureJob(2), captureJob(3)],
    new Set([3]),
  )

  assert.deepEqual(progress, { completed: 2, total: 3, failed: 1, error: 'file 3 failed' })
  assert.ok(progress.completed <= progress.total)
})

test('real upload aggregation converts only successful files on retry', async () => {
  const allJobs = [captureJob(1), captureJob(2)]
  let pendingJobs = [...allJobs]
  const first = await aggregateUploads(allJobs, pendingJobs, new Set([2]))
  assert.deepEqual(first.progress, { completed: 1, total: 2, failed: 1, error: 'file 2 failed' })

  pendingJobs = [captureJob(2)]
  const second = await aggregateUploads(allJobs, pendingJobs)
  assert.deepEqual(second.progress, { completed: 2, total: 2, failed: 0 })
})

test('real upload aggregation de-duplicates repeated capture, RAW, group, and legacy records', async () => {
  const duplicateCapture = captureJob(7)
  const groupJob: ProjectSyncJob = { kind: 'group-capture-file', captureId: 4, fileId: 9 }
  const legacyJob: ProjectSyncJob = {
    kind: 'legacy-photo',
    projectId: 1,
    studentId: 2,
    photoId: 11,
    filePath: '/photos/11.jpg',
    fileName: '11.jpg',
    capturedAt: '2025-01-01T00:00:00.000Z',
  }
  const { progress } = await aggregateUploads(
    [duplicateCapture, duplicateCapture, groupJob, groupJob, legacyJob, legacyJob],
    [duplicateCapture, duplicateCapture, groupJob, groupJob, legacyJob, legacyJob],
  )

  assert.deepEqual(progress, { completed: 3, total: 3, failed: 0 })
})