import assert from 'node:assert/strict'
import test from 'node:test'
import {
  captureIdsForDrag,
  selectCaptureRange,
  shouldReturnToLatestOnNewCapture,
} from '../src/renderer/src/lib/groupCaptureSelection.ts'

test('shift selection returns the inclusive range from the anchor to the clicked frame', () => {
  assert.deepEqual(selectCaptureRange([10, 11, 12, 13, 14], 11, 14), [11, 12, 13, 14])
})

test('shift selection works in reverse and keeps camera-roll order', () => {
  assert.deepEqual(selectCaptureRange([10, 11, 12, 13, 14], 14, 11), [11, 12, 13, 14])
})

test('a missing anchor starts a new single-frame selection', () => {
  assert.deepEqual(selectCaptureRange([10, 11, 12], 99, 11), [11])
})

test('dragging a selected frame includes the selected set, otherwise only that frame', () => {
  assert.deepEqual(captureIdsForDrag([11, 12, 13], 12), [11, 12, 13])
  assert.deepEqual(captureIdsForDrag([11, 12, 13], 14), [14])
})

test('a new group capture returns review to the latest frame after manual browsing', () => {
  assert.equal(shouldReturnToLatestOnNewCapture(14, 15), true)
  assert.equal(shouldReturnToLatestOnNewCapture(14, 14), false)
  assert.equal(shouldReturnToLatestOnNewCapture(null, 14), false)
  assert.equal(shouldReturnToLatestOnNewCapture(14, null), false)
})
