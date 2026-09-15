import { strict as assert } from 'node:assert'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import test from 'node:test'
import { assessImageContent } from '../src/main/lib/imageContent.ts'
import { generateLivePreview } from '../src/main/lib/livePreview.ts'

function imageBuffer(
  width: number,
  height: number,
  pixel: (x: number, y: number) => [number, number, number],
): Buffer {
  const data = Buffer.alloc(width * height * 3)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 3
      const [red, green, blue] = pixel(x, y)
      data[offset] = red
      data[offset + 1] = green
      data[offset + 2] = blue
    }
  }
  return data
}

test('rejects a valid-but-uniform blank JPEG capture and preview', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mc-school-studio-blank-portrait-'))
  const sourcePath = join(root, 'blank.jpg')
  const cacheDir = join(root, 'cache')

  try {
    await sharp({
      create: {
        width: 1600,
        height: 1200,
        channels: 3,
        background: { r: 0, g: 0, b: 0 },
      },
    }).jpeg({ quality: 92 }).toFile(sourcePath)

    const assessment = await assessImageContent(sourcePath)
    assert.equal(assessment.usable, false)
    assert.equal(assessment.reason, 'uniform-frame')
    assert.equal(
      await generateLivePreview(sourcePath, { previewKey: 'blank-capture', cacheDir }),
      null,
    )
    assert.equal(readdirSync(cacheDir, { withFileTypes: true }).some((entry) => entry.name.endsWith('.jpg')), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('accepts a very dark photograph when it contains subject detail', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mc-school-studio-dark-portrait-'))
  const sourcePath = join(root, 'dark.jpg')
  const cacheDir = join(root, 'cache')
  const width = 320
  const height = 240

  try {
    const pixels = imageBuffer(width, height, (x, y) => {
      const subject = x > 105 && x < 215 && y > 45 && y < 210
      return subject ? [22, 18, 16] : [1, 1, 2]
    })
    await sharp(pixels, { raw: { width, height, channels: 3 } })
      .jpeg({ quality: 90 })
      .toFile(sourcePath)

    const assessment = await assessImageContent(sourcePath)
    assert.equal(assessment.usable, true)
    const previewPath = await generateLivePreview(sourcePath, {
      previewKey: 'dark-capture',
      cacheDir,
    })
    assert.ok(previewPath)
    assert.equal(existsSync(previewPath), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})