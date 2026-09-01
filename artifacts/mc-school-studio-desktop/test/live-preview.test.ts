import { strict as assert } from 'node:assert'
import { readFileSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import test from 'node:test'
import {
  generateLivePreview,
  LIVE_PREVIEW_EDGE,
  LIVE_PREVIEW_QUALITY,
} from '../src/main/lib/livePreview.ts'
import { NewestLivePreviewScheduler } from '../src/main/lib/livePreviewScheduler.ts'

test('creates a reduced JPEG artifact without changing the source', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mc-school-studio-preview-'))
  const sourcePath = join(root, 'capture.jpg')
  const cacheDir = join(root, 'cache')

  try {
    await sharp({
      create: {
        width: 4032,
        height: 3024,
        channels: 3,
        background: { r: 32, g: 96, b: 160 },
      },
    })
      .jpeg({ quality: 92 })
      .toFile(sourcePath)
    const sourceBytes = readFileSync(sourcePath)

    const previewPath = await generateLivePreview(sourcePath, {
      previewKey: 'capture-test-1',
      cacheDir,
    })

    assert.ok(previewPath)
    assert.notEqual(previewPath, sourcePath)
    assert.deepEqual(readFileSync(sourcePath), sourceBytes)
    assert.ok(statSync(previewPath).size < sourceBytes.length)

    const metadata = await sharp(previewPath).metadata()
    assert.ok((metadata.width ?? 0) <= LIVE_PREVIEW_EDGE)
    assert.ok((metadata.height ?? 0) <= LIVE_PREVIEW_EDGE)
    assert.equal(metadata.format, 'jpeg')
    assert.equal(LIVE_PREVIEW_QUALITY, 84)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('does not decode a RAW file when no embedded JPEG is available', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mc-school-studio-raw-preview-'))
  const sourcePath = join(root, 'capture.nef')
  const cacheDir = join(root, 'cache')
  const sourceBytes = Buffer.from('not-a-raw-file')
  await import('node:fs/promises').then(({ writeFile }) => writeFile(sourcePath, sourceBytes))

  try {
    const previewPath = await generateLivePreview(sourcePath, {
      previewKey: 'raw-test-1',
      cacheDir,
    })
    assert.equal(previewPath, null)
    assert.deepEqual(readFileSync(sourcePath), sourceBytes)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('keeps only the newest pending live-preview job while the active job runs', async () => {
  const scheduler = new NewestLivePreviewScheduler()
  const started: string[] = []
  let releaseActive!: () => void
  const activeReleased = new Promise<void>((resolve) => {
    releaseActive = resolve
  })
  const completed: string[] = []

  scheduler.enqueue({
    run: async () => {
      started.push('A')
      await activeReleased
      completed.push('A')
    },
  })
  scheduler.enqueue({ run: async () => { started.push('B'); completed.push('B') } })
  scheduler.enqueue({ run: async () => { started.push('C'); completed.push('C') } })
  scheduler.enqueue({ run: async () => { started.push('D'); completed.push('D') } })
  scheduler.enqueue({ run: async () => { started.push('E'); completed.push('E') } })

  assert.deepEqual(scheduler.snapshot(), {
    enqueued: 5,
    started: 1,
    completed: 0,
    superseded: 3,
  })

  releaseActive()
  await scheduler.waitForIdle()

  assert.deepEqual(started, ['A', 'E'])
  assert.deepEqual(completed, ['A', 'E'])
  assert.deepEqual(scheduler.snapshot(), {
    enqueued: 5,
    started: 2,
    completed: 2,
    superseded: 3,
  })
})