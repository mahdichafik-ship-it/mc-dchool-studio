import { strict as assert } from 'node:assert'
import test from 'node:test'
import {
  advanceSequence,
  clearManualStudent,
  createSequenceState,
  OrderedCaptureQueue,
  registerCapturePath,
  snapshotCaptureTarget,
  setManualStudent,
  sortCaptureFiles,
} from '../src/main/lib/photoSequence.ts'

test('ordered capture drain waits for a slow marker before a fast portrait', async () => {
  const queue = new OrderedCaptureQueue<string>()
  queue.register(0)
  queue.register(1)
  const processed: string[] = []
  let releaseMarker: () => void = () => undefined
  const markerStability = new Promise<void>((resolve) => { releaseMarker = resolve })
  const markerReady = markerStability.then(() => queue.ready(0, 'marker-0'))

  queue.ready(1, 'portrait-1')
  await queue.drain(async (capture) => { processed.push(capture) })
  assert.deepEqual(processed, [])

  releaseMarker()
  await markerReady
  await queue.drain(async (capture) => { processed.push(capture) })
  assert.deepEqual(processed, ['marker-0', 'portrait-1'])
})

test('ordered capture drain processes an older portrait before a later marker', async () => {
  const queue = new OrderedCaptureQueue<string>()
  queue.register(0)
  queue.register(1)
  const processed: string[] = []
  let releasePortrait: () => void = () => undefined
  const portraitStability = new Promise<void>((resolve) => { releasePortrait = resolve })
  const portraitReady = portraitStability.then(() => queue.ready(0, 'portrait-0'))

  queue.ready(1, 'marker-1')
  const blockedDrain = queue.drain(async (capture) => { processed.push(capture) })
  await blockedDrain
  releasePortrait()
  await portraitReady
  await queue.drain(async (capture) => { processed.push(capture) })

  assert.deepEqual(processed, ['portrait-0', 'marker-1'])
})

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

test('keeps manual authority over valid, unknown, and malformed QR markers', () => {
  const state = createSequenceState(10)
  assert.deepEqual(
    advanceSequence(state, { kind: 'marker', studentId: 20, reference: 'STU-20' }),
    {
      kind: 'review',
      reason: 'QR marker "STU-20" does not match the selected student',
    },
  )
  assert.equal(state.manualStudentId, 10)
  assert.equal(state.activeStudentId, 10)
  assert.deepEqual(
    advanceSequence(state, { kind: 'marker', studentId: null, reference: 'UNKNOWN' }),
    {
      kind: 'review',
      reason: 'QR marker "UNKNOWN" was not accepted while a student is manually selected',
    },
  )
  assert.deepEqual(
    advanceSequence(state, { kind: 'marker', studentId: null, reference: 'malformed payload' }),
    {
      kind: 'review',
      reason: 'QR marker "malformed payload" was not accepted while a student is manually selected',
    },
  )
  assert.deepEqual(advanceSequence(state, { kind: 'portrait' }), {
    kind: 'matched',
    studentId: 10,
  })
})

test('rapid manual switching affects only later captures', () => {
  const state = createSequenceState()
  setManualStudent(state, 101)
  const first = advanceSequence(state, { kind: 'portrait' })
  setManualStudent(state, 202)
  const second = advanceSequence(state, { kind: 'portrait' })
  clearManualStudent(state)
  assert.deepEqual(first, { kind: 'matched', studentId: 101 })
  assert.deepEqual(second, { kind: 'matched', studentId: 202 })
  assert.deepEqual(advanceSequence(state, { kind: 'portrait' }), {
    kind: 'review',
    reason: 'Portrait was captured before a valid student QR marker',
  })
})

test('snapshots manual authority before delayed file stability and never reassigns it', () => {
  const state = createSequenceState()
  setManualStudent(state, 101)
  const first = snapshotCaptureTarget(state)

  setManualStudent(state, 202)
  const second = snapshotCaptureTarget(state)

  assert.deepEqual(first, { studentId: 101, source: 'manual' })
  assert.deepEqual(second, { studentId: 202, source: 'manual' })
})

test('uses the authoritative project target when watcher session state has drifted', () => {
  const state = createSequenceState()
  state.activeStudentId = 303

  assert.deepEqual(
    snapshotCaptureTarget(state, 101),
    { studentId: 101, source: 'manual' },
  )
  assert.equal(state.activeStudentId, 303)
  assert.equal(state.manualStudentId, null)
})

test('distinguishes QR authority from manual authority for delayed processing', () => {
  const state = createSequenceState()
  state.activeStudentId = 303
  const qrTarget = snapshotCaptureTarget(state)

  setManualStudent(state, 404)
  const manualTarget = snapshotCaptureTarget(state)

  assert.deepEqual(qrTarget, { studentId: 303, source: 'qr' })
  assert.deepEqual(manualTarget, { studentId: 404, source: 'manual' })
})

test('keeps a QR portrait target immutable while a later marker advances the sequence', () => {
  const state = createSequenceState()
  state.activeStudentId = 505
  const portraitTarget = snapshotCaptureTarget(state)

  const markerDecision = advanceSequence(state, {
    kind: 'marker',
    studentId: 606,
    reference: 'QR-606',
  })

  assert.deepEqual(portraitTarget, { studentId: 505, source: 'qr' })
  assert.deepEqual(markerDecision, { kind: 'marker', studentId: 606 })
  assert.equal(state.activeStudentId, 606)
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

  clearManualStudent(state)
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