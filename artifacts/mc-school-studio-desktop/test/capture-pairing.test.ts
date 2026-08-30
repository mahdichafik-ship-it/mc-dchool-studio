import { strict as assert } from 'node:assert'
import test from 'node:test'
import {
  CapturePairingEngine,
  getCaptureFileFormat,
  getCaptureFileRole,
  normalizeBaseFilename,
} from '../src/main/lib/capturePairing.ts'

test('classifies supported JPEG and RAW formats', () => {
  assert.equal(getCaptureFileRole('DSC_8291.JPG'), 'JPEG')
  assert.equal(getCaptureFileRole('DSC_8291.jpeg'), 'JPEG')
  assert.equal(getCaptureFileRole('DSC_8291.NEF'), 'RAW')
  assert.equal(getCaptureFileRole('DSC_8291.CR3'), 'RAW')
  assert.equal(getCaptureFileRole('notes.txt'), null)
  assert.equal(getCaptureFileFormat('DSC_8291.NEF'), 'NEF')
})

test('normalizes the shared base filename for pairing', () => {
  assert.equal(normalizeBaseFilename(' DSC_8291.JPG '), 'dsc_8291')
  assert.equal(normalizeBaseFilename('DSC_8291.NEF'), 'dsc_8291')
})

test('creates one capture and pairs a delayed RAW file', () => {
  const engine = new CapturePairingEngine()
  const first = engine.ingest({
    projectId: 2,
    studentId: 10452,
    classId: 7,
    shootSessionId: 'session-1',
    filePath: '/spool/jpeg/DSC_8291.JPG',
    fileName: 'DSC_8291.JPG',
    capturedAt: '2026-08-30T12:00:00.000Z',
    fileSize: 100,
    checksum: 'jpeg-hash',
  })
  const second = engine.ingest({
    projectId: 2,
    studentId: 99999,
    classId: 99,
    shootSessionId: 'session-1',
    filePath: '/spool/raw/DSC_8291.NEF',
    fileName: 'DSC_8291.NEF',
    capturedAt: '2026-08-30T12:00:03.000Z',
    fileSize: 1000,
    checksum: 'raw-hash',
  })

  assert.equal(first.kind, 'created')
  assert.equal(second.kind, 'paired')
  assert.equal(second.capture.captureKey, first.capture.captureKey)
  assert.equal(second.capture.status, 'complete')
  assert.equal(second.capture.studentId, 10452)
  assert.equal(second.capture.classId, 7)
  assert.equal(second.capture.assignmentLocked, true)
  assert.deepEqual(second.capture.files.map((file) => file.role), ['JPEG', 'RAW'])
})

test('keeps a RAW-only capture visible while the JPEG is missing', () => {
  const engine = new CapturePairingEngine()
  const result = engine.ingest({
    projectId: 2,
    studentId: 10452,
    classId: 7,
    shootSessionId: 'session-1',
    filePath: '/spool/raw/DSC_8292.NEF',
    fileName: 'DSC_8292.NEF',
    capturedAt: '2026-08-30T12:00:04.000Z',
    fileSize: 1200,
    checksum: 'raw-only-hash',
  })

  assert.equal(result.kind, 'created')
  assert.equal(result.capture.status, 'raw_only')
  assert.deepEqual(result.capture.files.map((file) => file.role), ['RAW'])
})

test('does not create duplicate files when a watcher reports a path twice', () => {
  const engine = new CapturePairingEngine()
  const file = {
    projectId: 2,
    studentId: 10452,
    classId: 7,
    filePath: '/spool/jpeg/DSC_8291.JPG',
    fileName: 'DSC_8291.JPG',
    capturedAt: '2026-08-30T12:00:00.000Z',
    checksum: 'same-hash',
  }

  const first = engine.ingest(file)
  const duplicate = engine.ingest(file)

  assert.equal(first.kind, 'created')
  assert.equal(duplicate.kind, 'duplicate')
  assert.equal(engine.list().length, 1)
  assert.equal(engine.list()[0]?.files.length, 1)
})

test('keeps unassigned first-file ownership instead of using a later active student', () => {
  const engine = new CapturePairingEngine()
  const first = engine.ingest({
    projectId: 2,
    studentId: null,
    classId: null,
    shootSessionId: 'session-1',
    filePath: '/spool/raw/DSC_8300.NEF',
    fileName: 'DSC_8300.NEF',
    capturedAt: '2026-08-30T12:00:00.000Z',
  })
  const second = engine.ingest({
    projectId: 2,
    studentId: 10452,
    classId: 7,
    shootSessionId: 'session-1',
    filePath: '/spool/jpeg/DSC_8300.JPG',
    fileName: 'DSC_8300.JPG',
    capturedAt: '2026-08-30T12:00:02.000Z',
  })

  assert.equal(first.capture.studentId, null)
  assert.equal(second.capture.studentId, null)
  assert.equal(second.capture.status, 'complete')
})