import { strict as assert } from 'node:assert'
import { readFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import test from 'node:test'
import {
  generateLivePreview,
  LIVE_PREVIEW_EDGE,
  LIVE_PREVIEW_QUALITY,
} from '../src/main/lib/livePreview.ts'
import { assessImageContent } from '../src/main/lib/imageContent.ts'
import { readStableFile } from '../src/main/lib/fileStability.ts'
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

test('uses the immutable snapshot when the watched source is replaced after snapshot', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mc-school-studio-preview-snapshot-'))
  const sourcePath = join(root, 'capture.jpg')
  const cacheDir = join(root, 'cache')
  try {
    const sourcePixels = Buffer.alloc(64 * 64 * 3)
    for (let index = 0; index < sourcePixels.length; index += 3) {
      sourcePixels[index] = index % 6 === 0 ? 220 : 12
      sourcePixels[index + 1] = index % 9 === 0 ? 180 : 16
      sourcePixels[index + 2] = 24
    }
    await sharp(sourcePixels, { raw: { width: 64, height: 64, channels: 3 } })
      .jpeg({ quality: 92 })
      .toFile(sourcePath)

    const snapshot = await readStableFile(sourcePath, statSync(sourcePath).size)
    writeFileSync(sourcePath, snapshot.subarray(0, 24))

    const assessment = await assessImageContent(snapshot)
    assert.equal(assessment.usable, true)
    const previewPath = await generateLivePreview(sourcePath, {
      previewKey: 'replaced-after-snapshot',
      cacheDir,
      sourceBuffer: snapshot,
    })
    assert.ok(previewPath)
    assert.equal((await sharp(previewPath).metadata()).format, 'jpeg')
    assert.equal((await assessImageContent(readFileSync(sourcePath))).usable, false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('rejects malformed and truncated JPEG bytes before preview generation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mc-school-studio-preview-truncated-'))
  const sourcePath = join(root, 'truncated.jpg')
  const cacheDir = join(root, 'cache')
  try {
    const valid = await sharp({
      create: {
        width: 640,
        height: 480,
        channels: 3,
        background: { r: 48, g: 96, b: 160 },
      },
    }).jpeg({ quality: 92 }).toBuffer()
    const truncated = valid.subarray(0, Math.max(2, valid.length - 24))
    writeFileSync(sourcePath, truncated)

    assert.equal((await assessImageContent(truncated)).usable, false)
    assert.equal(
      await generateLivePreview(sourcePath, {
        previewKey: 'truncated-jpeg',
        cacheDir,
        sourceBuffer: truncated,
      }),
      null,
    )
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