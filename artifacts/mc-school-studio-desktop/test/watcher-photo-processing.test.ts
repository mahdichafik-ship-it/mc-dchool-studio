import { strict as assert } from 'node:assert'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import type { WatchedPhotoStore } from '../src/main/lib/watchedPhotoProcessor.ts'
import { processWatchedPhoto } from '../src/main/lib/watchedPhotoProcessor.ts'

const jpegBytes = Buffer.from('sample-smart-shooter-jpeg')
const timestamp = '2026-08-28T12:00:00.000Z'

function createStore() {
  const projects = [
    { id: 1, schoolName: 'Example School', photoDate: null, address: null, contactName: null, contactEmail: null, contactPhone: null, notes: null, watchFolder: null, createdAt: timestamp, updatedAt: timestamp },
    { id: 2, schoolName: 'Other School', photoDate: null, address: null, contactName: null, contactEmail: null, contactPhone: null, notes: null, watchFolder: null, createdAt: timestamp, updatedAt: timestamp },
  ]
  const classes = [
    { id: 1, projectId: 1, className: 'Class 3', createdAt: timestamp, updatedAt: timestamp },
    { id: 2, projectId: 2, className: 'Class 9', createdAt: timestamp, updatedAt: timestamp },
  ]
  const students = [
    { id: 1, projectId: 1, classId: 1, firstName: 'John', lastName: 'Smith', generatedStudentId: '001234', email: null, phone: null, simpleQr: null, jsonQr: null, createdAt: timestamp, updatedAt: timestamp },
    { id: 2, projectId: 2, classId: 2, firstName: 'Other', lastName: 'Student', generatedStudentId: '009999', email: null, phone: null, simpleQr: null, jsonQr: null, createdAt: timestamp, updatedAt: timestamp },
  ]
  const photos: ReturnType<WatchedPhotoStore['insertPhoto']>[] = []

  const store: WatchedPhotoStore = {
    findProject: (projectId) => projects.find((project) => project.id === projectId),
    listStudents: (projectId) => students.filter((student) => student.projectId === projectId),
    findStudent: (projectId, generatedStudentId) =>
      students.find(
        (student) =>
          student.projectId === projectId &&
          student.generatedStudentId === generatedStudentId,
      ),
    findClass: (classId) => classes.find((classRow) => classRow.id === classId),
    insertPhoto: (photo) => {
      const saved = {
        id: photos.length + 1,
        uploadStatus: null,
        fileUrl: null,
        createdAt: timestamp,
        ...photo,
      }
      photos.push(saved)
      return saved
    },
  }

  return { store, photos }
}

function createFixture(fileName: string) {
  const root = mkdtempSync(join(tmpdir(), 'mc-school-studio-watcher-'))
  const sourcePath = join(root, 'smart-shooter', fileName)
  mkdirSync(dirname(sourcePath), { recursive: true })
  writeFileSync(sourcePath, jpegBytes)
  return { root, sourcePath, photosDir: join(root, 'organized') }
}

function cleanup(root: string) {
  rmSync(root, { recursive: true, force: true })
}

test('copies a Smart Shooter JPEG to project/class/student folders and keeps the source', async () => {
  const fixture = createFixture('Smith_John_class_school-001234.jpg')
  const { store, photos } = createStore()

  try {
    const result = await processWatchedPhoto(1, fixture.sourcePath, {
      store,
      photosDir: fixture.photosDir,
      readQr: async () => {
        throw new Error('filename match should not need QR fallback')
      },
    })

    assert.equal(result.kind, 'matched')
    if (result.kind !== 'matched') return
    assert.equal(result.student.id, 1)

    const destination = join(
      fixture.photosDir,
      'Example School',
      'Class 3',
      '001234_Smith_John',
      'Smith_John_class_school-001234.jpg',
    )
    assert.equal(existsSync(destination), true)
    assert.deepEqual(readFileSync(destination), jpegBytes)
    assert.equal(existsSync(fixture.sourcePath), true)
    assert.deepEqual(readFileSync(fixture.sourcePath), jpegBytes)
    assert.equal(photos[0]?.studentId, 1)
    assert.equal(photos[0]?.isMatched, true)
    assert.equal(photos[0]?.filePath, destination)
  } finally {
    cleanup(fixture.root)
  }
})

test('matches a barcode-renamed JPEG with a numeric frame suffix without QR fallback', async () => {
  const fixture = createFixture('Smith_John_class_school_001234_595.JPG')
  const { store, photos } = createStore()
  let qrReadAttempted = false

  try {
    const result = await processWatchedPhoto(1, fixture.sourcePath, {
      store,
      photosDir: fixture.photosDir,
      readQr: async () => {
        qrReadAttempted = true
        return { studentId: '009999' }
      },
    })

    assert.equal(result.kind, 'matched')
    assert.equal(qrReadAttempted, false)
    if (result.kind !== 'matched') return
    assert.equal(result.student.id, 1)

    const destination = join(
      fixture.photosDir,
      'Example School',
      'Class 3',
      '001234_Smith_John',
      'Smith_John_class_school_001234_595.JPG',
    )
    assert.equal(existsSync(destination), true)
    assert.equal(existsSync(fixture.sourcePath), true)
    assert.deepEqual(readFileSync(destination), jpegBytes)
    assert.deepEqual(readFileSync(fixture.sourcePath), jpegBytes)
    assert.equal(photos[0]?.studentId, 1)
    assert.equal(photos[0]?.filePath, destination)
  } finally {
    cleanup(fixture.root)
  }
})

test('matches a barcode-renamed JPEG when Smart Shooter changes ID casing', async () => {
  const fixture = createFixture('ZAKI_Dina_class_school-ab12_596.JPG', 'jpeg-source')
  try {
    let qrRead = false
    const result = await processWatchedPhoto(1, fixture.sourcePath, {
      store: createStore({
        students: [{
          id: 4,
          projectId: 1,
          classId: 10,
          generatedStudentId: 'AB12',
          firstName: 'Dina',
          lastName: 'Zaki',
        }],
      }),
      photosDir: fixture.photosDir,
      readQr: async () => {
        qrRead = true
        return null
      },
    })

    assert.equal(result.kind, 'matched')
    assert.equal(qrRead, false)
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('leaves an ID belonging to another project unmatched', async () => {
  const fixture = createFixture('Smith_John_class_school-009999.jpg')
  const { store, photos } = createStore()

  try {
    const result = await processWatchedPhoto(1, fixture.sourcePath, {
      store,
      photosDir: fixture.photosDir,
      readQr: async () => null,
    })

    assert.equal(result.kind, 'unmatched')
    assert.equal(existsSync(fixture.sourcePath), true)
    assert.equal(photos[0]?.studentId, null)
    assert.equal(photos[0]?.isMatched, false)
    assert.equal(existsSync(fixture.photosDir), false)
  } finally {
    cleanup(fixture.root)
  }
})

test('leaves malformed Smart Shooter filenames unmatched instead of guessing a student', async () => {
  const fixture = createFixture('Smith_John_class_school.jpg')
  const { store, photos } = createStore()

  try {
    const result = await processWatchedPhoto(1, fixture.sourcePath, {
      store,
      photosDir: fixture.photosDir,
      readQr: async () => null,
    })

    assert.equal(result.kind, 'unmatched')
    assert.equal(existsSync(fixture.sourcePath), true)
    assert.equal(photos[0]?.studentId, null)
    assert.equal(photos[0]?.isMatched, false)
  } finally {
    cleanup(fixture.root)
  }
})