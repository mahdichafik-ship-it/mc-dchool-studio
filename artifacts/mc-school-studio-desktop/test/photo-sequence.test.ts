import { strict as assert } from 'node:assert'
import test from 'node:test'
import {
  advanceSequence,
  createSequenceState,
  registerCapturePath,
  sortCaptureFiles,
} from '../src/main/lib/photoSequence.ts'

test('assigns multiple portraits to the active student until the next marker', () => {
  const state = createSequenceState()

  assert.deepEqual(
    advanceSequence(state, { kind: 'marker', studentId: 10, reference: 'STU-10' }),
    { kind: 'marker', studentId: 10 },
  )
  assert.deepEqual(advanceSequence(state, { kind: 'portrait' }), {
    kind: 'matched',
    studentId: 10,
  })
  assert.deepEqual(advanceSequence(state, { kind: 'portrait' }), {
    kind: 'matched',
    studentId: 10,
  })

  assert.deepEqual(
    advanceSequence(state, { kind: 'marker', studentId: 20, reference: 'STU-20' }),
    { kind: 'marker', studentId: 20 },
  )
  assert.deepEqual(advanceSequence(state, { kind: 'portrait' }), {
    kind: 'matched',
    studentId: 20,
  })
})

test('clears the active student after an unknown marker', () => {
  const state = createSequenceState()
  advanceSequence(state, { kind: 'marker', studentId: 10, reference: 'STU-10' })

  assert.deepEqual(
    advanceSequence(state, { kind: 'marker', studentId: null, reference: 'UNKNOWN' }),
    {
      kind: 'review',
      reason: 'QR marker "UNKNOWN" does not match a student in this project',
    },
  )
  assert.deepEqual(advanceSequence(state, { kind: 'portrait' }), {
    kind: 'review',
    reason: 'Portrait was captured before a valid student QR marker',
  })
})

test('does not assign a portrait before the first valid marker', () => {
  const state = createSequenceState()
  assert.deepEqual(advanceSequence(state, { kind: 'portrait' }), {
    kind: 'review',
    reason: 'Portrait was captured before a valid student QR marker',
  })
})

test('starts a fresh sequence after the watcher restarts', () => {
  const previousSession = createSequenceState()
  advanceSequence(previousSession, { kind: 'marker', studentId: 10, reference: 'STU-10' })

  const restartedSession = createSequenceState()
  assert.deepEqual(advanceSequence(restartedSession, { kind: 'portrait' }), {
    kind: 'review',
    reason: 'Portrait was captured before a valid student QR marker',
  })
})

test('ignores duplicate file events within the same watcher session', () => {
  const seenPaths = new Set<string>()
  assert.equal(registerCapturePath(seenPaths, '/spool/portrait-1.jpg'), true)
  assert.equal(registerCapturePath(seenPaths, '/spool/portrait-1.jpg'), false)
  assert.equal(registerCapturePath(seenPaths, '/spool/portrait-2.jpg'), true)
})

test('sorts a capture burst by capture time with deterministic filename ties', () => {
  const sorted = sortCaptureFiles([
    { filePath: '/spool/portrait-10.jpg', fileName: 'portrait-10.jpg', capturedAtMs: 200 },
    { filePath: '/spool/portrait-2.jpg', fileName: 'portrait-2.jpg', capturedAtMs: 200 },
    { filePath: '/spool/marker.jpg', fileName: 'marker.jpg', capturedAtMs: 100 },
  ])

  assert.deepEqual(sorted.map((file) => file.fileName), [
    'marker.jpg',
    'portrait-2.jpg',
    'portrait-10.jpg',
  ])
})