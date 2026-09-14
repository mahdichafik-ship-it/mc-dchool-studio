import { strict as assert } from 'node:assert'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  getStudentFolderNames,
  migrateStudentFolderFiles,
  previewStudentFolderMigration,
} from '../src/main/lib/studentFolderMigration.ts'

const student = {
  id: 12,
  projectId: 4,
  classId: 8,
  firstName: 'Jane',
  lastName: 'Doe',
  generatedStudentId: 'AB123',
}

test('recognizes legacy and canonical folder names without treating the canonical folder as legacy', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mc-school-studio-folder-migration-'))
  const names = getStudentFolderNames(student)
  const classDir = join(root, 'Example School', 'Class 1')
  try {
    mkdirSync(join(classDir, names.legacy, 'QR Markers'), { recursive: true })
    writeFileSync(join(classDir, names.legacy, 'AB123_Doe_Jane.jpg'), 'jpeg')
    writeFileSync(join(classDir, names.legacy, 'portrait.nef'), 'raw')
    writeFileSync(join(classDir, names.legacy, 'QR Markers', 'marker.jpg'), 'qr')
    mkdirSync(join(classDir, names.canonical), { recursive: true })

    const preview = await previewStudentFolderMigration({
      projectId: 4,
      photosDir: root,
      project: { schoolName: 'Example School' },
      classes: [{ id: 8, className: 'Class 1' }],
      students: [student],
    })

    assert.equal(preview.legacyFolderCount, 1)
    assert.equal(preview.fileCount, 3)
    assert.equal(preview.students[0]?.canonicalFolderFound, true)
    assert.equal(preview.students[0]?.legacyFolderFound, true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('groups exact destination conflicts by student in the migration preview', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mc-school-studio-folder-conflicts-'))
  const names = getStudentFolderNames(student)
  const classDir = join(root, 'Example School', 'Class 1')
  const legacyDir = join(classDir, names.legacy)
  const canonicalDir = join(classDir, names.canonical)
  try {
    mkdirSync(join(legacyDir, 'QR Markers'), { recursive: true })
    mkdirSync(join(canonicalDir, 'QR Markers'), { recursive: true })
    writeFileSync(join(legacyDir, 'portrait.jpg'), 'legacy portrait')
    writeFileSync(join(legacyDir, 'portrait.nef'), 'legacy raw')
    writeFileSync(join(legacyDir, 'QR Markers', 'marker.jpg'), 'legacy marker')
    writeFileSync(join(canonicalDir, 'portrait.jpg'), 'canonical portrait')
    writeFileSync(join(canonicalDir, 'QR Markers', 'marker.jpg'), 'canonical marker')

    const preview = await previewStudentFolderMigration({
      projectId: 4,
      photosDir: root,
      project: { schoolName: 'Example School' },
      classes: [{ id: 8, className: 'Class 1' }],
      students: [student],
    })

    assert.equal(preview.conflictCount, 2)
    assert.equal(preview.students[0]?.studentName, 'Jane Doe')
    assert.deepEqual(
      preview.students[0]?.conflictFiles.sort(),
      ['portrait.jpg', join('QR Markers', 'marker.jpg')].sort(),
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})


test('copies photos, RAW files, and QR markers without deleting originals or duplicating on repeat', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mc-school-studio-folder-copy-'))
  const legacy = join(root, 'old')
  const canonical = join(root, 'new')
  try {
    mkdirSync(join(legacy, 'QR Markers'), { recursive: true })
    writeFileSync(join(legacy, 'portrait.jpg'), 'jpeg')
    writeFileSync(join(legacy, 'portrait.nef'), 'raw')
    writeFileSync(join(legacy, 'QR Markers', 'marker.jpg'), 'qr')

    const first = await migrateStudentFolderFiles(legacy, canonical)
    assert.deepEqual(first, { migratedFiles: 3, skippedFiles: 0, conflictCount: 0 })
    assert.equal(readFileSync(join(canonical, 'portrait.nef'), 'utf8'), 'raw')
    assert.equal(readFileSync(join(canonical, 'QR Markers', 'marker.jpg'), 'utf8'), 'qr')
    assert.equal(existsSync(join(legacy, 'portrait.jpg')), true)

    const second = await migrateStudentFolderFiles(legacy, canonical)
    assert.deepEqual(second, { migratedFiles: 0, skippedFiles: 3, conflictCount: 0 })
    assert.equal(existsSync(join(canonical, 'portrait-legacy-2.jpg')), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('keeps destination conflicts unchanged and remains repeat-safe', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mc-school-studio-folder-conflict-copy-'))
  const legacy = join(root, 'old')
  const canonical = join(root, 'new')
  try {
    mkdirSync(legacy, { recursive: true })
    mkdirSync(canonical, { recursive: true })
    writeFileSync(join(legacy, 'portrait.jpg'), 'legacy')
    writeFileSync(join(canonical, 'portrait.jpg'), 'canonical')

    const first = await migrateStudentFolderFiles(legacy, canonical)
    assert.deepEqual(first, { migratedFiles: 1, skippedFiles: 0, conflictCount: 1 })
    assert.equal(readFileSync(join(canonical, 'portrait.jpg'), 'utf8'), 'canonical')
    assert.equal(readFileSync(join(canonical, 'portrait-legacy-2.jpg'), 'utf8'), 'legacy')

    const second = await migrateStudentFolderFiles(legacy, canonical)
    assert.deepEqual(second, { migratedFiles: 0, skippedFiles: 1, conflictCount: 1 })
    assert.equal(readFileSync(join(canonical, 'portrait.jpg'), 'utf8'), 'canonical')
    assert.equal(existsSync(join(canonical, 'portrait-legacy-3.jpg')), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})