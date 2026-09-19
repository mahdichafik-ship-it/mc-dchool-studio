import assert from 'node:assert/strict'
import test from 'node:test'
import {
  capturePreviewViewportStyle,
  fitCapturePreviewLayout,
  getCaptureCropGeometry,
} from '../src/renderer/src/lib/captureFraming.ts'
import { hasPendingReviewSync } from '../src/main/lib/reviewSyncBarrier.ts'

const landscapeSource = { width: 4000, height: 3000 }

function framing(aspectRatio: '1:1' | '4:5' | '5:7' | '7:5', cropScale: number, cropX = 0, cropY = 0) {
  return {
    cropX,
    cropY,
    cropScale,
    aspectRatio,
    straightenAngle: 0,
    rotation: 0 as const,
  }
}

test('landscape 1:1 crop matches server fit/scale/focal geometry', () => {
  assert.deepEqual(
    getCaptureCropGeometry(landscapeSource.width, landscapeSource.height, framing('1:1', 100)),
    {
      sourceWidth: 4000,
      sourceHeight: 3000,
      transformedWidth: 4000,
      transformedHeight: 3000,
      cropWidth: 3000,
      cropHeight: 3000,
      cropLeft: 500,
      cropTop: 0,
      aspectRatio: 1,
      rotation: 0,
      straightenAngle: 0,
    },
  )
  // At scale 1 the fitted crop fills the available width/height, so focal
  // coordinates correctly cannot move its rectangle further.
  assert.equal(getCaptureCropGeometry(4000, 3000, framing('1:1', 100, 100, 100)).cropLeft, 500)
  assert.equal(getCaptureCropGeometry(4000, 3000, framing('1:1', 100, 100, 100)).cropTop, 0)
  assert.deepEqual(
    getCaptureCropGeometry(4000, 3000, framing('1:1', 200, 0, 100)),
    { ...getCaptureCropGeometry(4000, 3000, framing('1:1', 200)), cropLeft: 1250, cropTop: 1500 },
  )
  assert.deepEqual(
    getCaptureCropGeometry(4000, 3000, framing('1:1', 200, 100)),
    { ...getCaptureCropGeometry(4000, 3000, framing('1:1', 200)), cropLeft: 2000 },
  )
})

test('landscape 4:5 crop matches server fit/scale/focal geometry', () => {
  assert.deepEqual(
    getCaptureCropGeometry(landscapeSource.width, landscapeSource.height, framing('4:5', 100)),
    {
      sourceWidth: 4000,
      sourceHeight: 3000,
      transformedWidth: 4000,
      transformedHeight: 3000,
      cropWidth: 2400,
      cropHeight: 3000,
      cropLeft: 800,
      cropTop: 0,
      aspectRatio: 0.8,
      rotation: 0,
      straightenAngle: 0,
    },
  )
  assert.deepEqual(
    getCaptureCropGeometry(4000, 3000, framing('4:5', 100, 100, 100)),
    getCaptureCropGeometry(4000, 3000, framing('4:5', 100)),
  )
  assert.deepEqual(
    getCaptureCropGeometry(4000, 3000, framing('4:5', 200, 100, 100)),
    {
      sourceWidth: 4000,
      sourceHeight: 3000,
      transformedWidth: 4000,
      transformedHeight: 3000,
      cropWidth: 1200,
      cropHeight: 1500,
      cropLeft: 2000,
      cropTop: 1500,
      aspectRatio: 0.8,
      rotation: 0,
      straightenAngle: 0,
    },
  )
  assert.deepEqual(
    getCaptureCropGeometry(4000, 3000, framing('4:5', 200)),
    {
      ...getCaptureCropGeometry(4000, 3000, framing('4:5', 200, 100, 100)),
      cropLeft: 1400,
      cropTop: 750,
    },
  )
  assert.deepEqual(
    getCaptureCropGeometry(4000, 3000, framing('4:5', 200, 100)),
    { ...getCaptureCropGeometry(4000, 3000, framing('4:5', 200)), cropLeft: 2000 },
  )
  assert.deepEqual(
    getCaptureCropGeometry(4000, 3000, framing('4:5', 200, 0, 100)),
    { ...getCaptureCropGeometry(4000, 3000, framing('4:5', 200)), cropTop: 1500 },
  )
})

test('5:7 portrait and 7:5 landscape framing preserve the requested new-photo guides', () => {
  const portrait = getCaptureCropGeometry(4000, 3000, framing('5:7', 100))
  const landscape = getCaptureCropGeometry(4000, 3000, framing('7:5', 100))

  assert.ok(Math.abs(portrait.aspectRatio - (5 / 7)) < 0.001)
  assert.ok(Math.abs(landscape.aspectRatio - (7 / 5)) < 0.001)
  assert.ok(portrait.cropHeight > portrait.cropWidth)
  assert.ok(landscape.cropWidth > landscape.cropHeight)
})

test('review barrier stays clear only when every pending queue is empty', () => {
  assert.equal(hasPendingReviewSync({ portrait: 0, group: 0 }), false)
  assert.equal(hasPendingReviewSync({ portrait: 1, group: 0 }), true)
  assert.equal(hasPendingReviewSync({ portrait: 0, group: 2 }), true)
})

test('portrait crop viewport preserves 4:5 when full-width height exceeds the cap', () => {
  const layout = fitCapturePreviewLayout(1200, 430, 4 / 5)
  assert.deepEqual(layout, { width: 344, height: 430, aspectRatio: 0.8 })
  assert.equal(layout.width / layout.height, 4 / 5)

  const geometry = getCaptureCropGeometry(4000, 3000, framing('4:5', 100))
  assert.deepEqual(capturePreviewViewportStyle(geometry, '430px'), {
    width: 'min(100%, calc(430px * 0.8))',
    maxHeight: '430px',
    aspectRatio: '2400 / 3000',
  })
})
