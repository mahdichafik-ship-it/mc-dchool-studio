import assert from 'node:assert/strict'
import test from 'node:test'
import {
  addGroupFilesForMembers,
  PIXIESET_HEADERS,
  buildPixiesetCsv,
  csvEscape,
  filterPixiesetJpegs,
  isPixiesetApprovedCapture,
  isValidPixiesetEmail,
  safeCollectionName,
  uniquePath,
} from '../src/main/ipc/pixiesetExport.ts'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('Pixieset approval requires a positive rating and rejects rejected captures', () => {
  assert.equal(isPixiesetApprovedCapture({ rating: 0, rejected: false }), false)
  assert.equal(isPixiesetApprovedCapture({ rating: 1, rejected: false }), true)
  assert.equal(isPixiesetApprovedCapture({ rating: 5, rejected: true }), false)
  assert.equal(isPixiesetApprovedCapture({ rating: 5 }), true)
})

test('CSV escaping quotes commas, quotes, and newlines', () => {
  assert.equal(csvEscape('plain'), 'plain')
  assert.equal(csvEscape('A "quoted", value'), '"A ""quoted"", value"')
  assert.equal(csvEscape('line one\nline two'), '"line one\nline two"')
})

test('Pixieset CSV keeps the exact downloaded header order', () => {
  const csv = buildPixiesetCsv([{
    collectionName: 'Grade 3B - Amina El Idrissi',
    email: 'parent@example.com',
    firstName: 'Nadia',
    lastName: 'El Idrissi',
  }])
  assert.equal(csv.split('\r\n')[0], PIXIESET_HEADERS.join(','))
  assert.match(csv, /Grade 3B - Amina El Idrissi,parent@example\.com,Nadia,El Idrissi/)
})

test('collection names are deterministic and filesystem safe', () => {
  assert.equal(
    safeCollectionName('Grade 3B', 'Amina', 'El/Idrissi', 'STU-1'),
    'Grade 3B - Amina El-Idrissi',
  )
})

test('Pixieset contacts require a normal email address', () => {
  assert.equal(isValidPixiesetEmail('parent@example.com'), true)
  assert.equal(isValidPixiesetEmail('missing-at-sign'), false)
  assert.equal(isValidPixiesetEmail(''), false)
})

test('only JPEG-role JPEG files qualify for Pixieset', () => {
  const files = [
    { fileRole: 'JPEG', fileFormat: 'JPG', storedPath: '/tmp/a.jpg' },
    { fileRole: 'RAW', fileFormat: 'CR3', storedPath: '/tmp/a.cr3' },
    { fileRole: 'JPEG', fileFormat: 'PNG', storedPath: '/tmp/a.png' },
  ]
  assert.deepEqual(filterPixiesetJpegs(files), [files[0]])
})

test('approved group photos fan out to every existing group member', () => {
  const result = new Map<number, string[]>()
  addGroupFilesForMembers(result, [11, 12], ['group.jpg'])
  assert.deepEqual(result.get(11), ['group.jpg'])
  assert.deepEqual(result.get(12), ['group.jpg'])
})

test('duplicate filenames receive a new path without overwriting an existing file', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pixieset-export-'))
  try {
    writeFileSync(join(directory, 'portrait.jpg'), 'original')
    const next = uniquePath(directory, 'portrait.jpg', new Set())
    assert.equal(next, join(directory, 'portrait-2.jpg'))
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})