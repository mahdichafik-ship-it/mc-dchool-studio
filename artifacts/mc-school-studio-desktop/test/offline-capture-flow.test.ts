import { strict as assert } from 'node:assert'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import {
  advanceSequence,
  createSequenceState,
  setManualStudent,
} from '../src/main/lib/photoSequence.ts'
import { CapturePairingEngine } from '../src/main/lib/capturePairing.ts'

test('captures the full A/B/QR-C workflow locally while cloud connectivity is unavailable', () => {
  const root = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'mc-school-studio-offline-'))
  const state = createSequenceState()
  const pairing = new CapturePairingEngine()
  const assignedStudents: number[] = []
  let captureNumber = 0

  const capturePortrait = (studentId: number) => {
    const decision = advanceSequence(state, { kind: 'portrait' })
    assert.deepEqual(decision, { kind: 'matched', studentId })
    assignedStudents.push(studentId)

    const baseFilename = `capture-${captureNumber++}`
    const studentFolder = join(root, `student-${studentId}`)
    mkdirSync(studentFolder, { recursive: true })
    const jpegPath = join(studentFolder, `${baseFilename}.JPG`)
    const rawPath = join(studentFolder, `${baseFilename}.NEF`)
    writeFileSync(jpegPath, `jpeg-${baseFilename}`)
    writeFileSync(rawPath, `raw-${baseFilename}`)

    const jpeg = pairing.ingest({
      projectId: 1,
      studentId,
      classId: studentId,
      shootSessionId: 'offline-session',
      cameraSerial: 'camera-1',
      filePath: jpegPath,
      fileName: `${baseFilename}.JPG`,
      capturedAt: `2026-08-31T10:00:${String(captureNumber).padStart(2, '0')}.000Z`,
    })
    const raw = pairing.ingest({
      projectId: 1,
      studentId: 999,
      classId: 999,
      shootSessionId: 'offline-session',
      cameraSerial: 'camera-1',
      filePath: rawPath,
      fileName: `${baseFilename}.NEF`,
      capturedAt: `2026-08-31T10:00:${String(captureNumber).padStart(2, '0')}.000Z`,
    })

    assert.equal(jpeg.kind, 'created')
    assert.equal(raw.kind, 'paired')
    assert.equal(raw.capture.studentId, studentId)
    assert.equal(raw.capture.status, 'complete')
    assert.equal(existsSync(jpegPath), true)
    assert.equal(existsSync(rawPath), true)
  }

  try {
    setManualStudent(state, 101)
    for (let index = 0; index < 3; index++) capturePortrait(101)

    setManualStudent(state, 202)
    for (let index = 0; index < 2; index++) capturePortrait(202)

    assert.deepEqual(
      advanceSequence(state, { kind: 'marker', studentId: 303, reference: 'STU-303' }),
      { kind: 'marker', studentId: 303 },
    )
    for (let index = 0; index < 4; index++) capturePortrait(303)

    assert.deepEqual(assignedStudents, [
      101, 101, 101,
      202, 202,
      303, 303, 303, 303,
    ])
    assert.equal(pairing.list().length, 9)
    assert.equal(pairing.list().every((capture) => capture.status === 'complete'), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})