import { strict as assert } from 'node:assert'
import test from 'node:test'
import {
  advanceSequence,
  clearManualStudent,
  createSequenceState,
  registerCapturePath,
  setManualStudent,
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

test('routes portraits to a manually selected student and supports target changes', () => {
  const state = createSequenceState()
  setManualStudent(state, 10)
  assert.deepEqual(advanceSequence(state, { kind: 'portrait' }), {
    kind: 'matched',
    studentId: 10,
  })

  setManualStudent(state, 20)
  assert.deepEqual(advanceSequence(state, { kind: 'portrait' }), {
    kind: 'matched',
    studentId: 20,
  })

  clearManualStudent(state)
  assert.deepEqual(advanceSequence(state, { kind: 'portrait' }), {
    kind: 'review',
    reason: 'Portrait was captured before a valid student QR marker',
  })
})

test('lets a valid QR marker replace the previous manual target', () => {
  const state = createSequenceState(10)
  assert.deepEqual(
    advanceSequence(state, { kind: 'marker', studentId: 20, reference: 'STU-20' }),
    {
      kind: 'marker',
      studentId: 20,
    },
  )
  assert.deepEqual(advanceSequence(state, { kind: 'portrait' }), {
    kind: 'matched',
    studentId: 20,
  })
})

test('keeps the exact offline A/B/QR-C capture sequence assigned without auto-advancing', () => {
  const state = createSequenceState()
  const assigned: number[] = []

  setManualStudent(state, 101)
  for (let index = 0; index < 3; index++) {
    const decision = advanceSequence(state, { kind: 'portrait' })
    assert.equal(decision.kind, 'matched')
    if (decision.kind === 'matched') assigned.push(decision.studentId)
  }

  setManualStudent(state, 202)
  for (let index = 0; index < 2; index++) {
    const decision = advanceSequence(state, { kind: 'portrait' })
    assert.equal(decision.kind, 'matched')
    if (decision.kind === 'matched') assigned.push(decision.studentId)
  }

  assert.deepEqual(
    advanceSequence(state, { kind: 'marker', studentId: 303, reference: 'STU-303' }),
    { kind: 'marker', studentId: 303 },
  )
  for (let index = 0; index < 4; index++) {
    const decision = advanceSequence(state, { kind: 'portrait' })
    assert.equal(decision.kind, 'matched')
    if (decision.kind === 'matched') assigned.push(decision.studentId)
  }

  assert.deepEqual(assigned, [101, 101, 101, 202, 202, 303, 303, 303, 303])
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