import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { classifyProjectUploadFile } from '../src/main/lib/projectUploadClassification.ts'

const projectsSource = readFileSync(
  join(import.meta.dirname, '../src/main/ipc/projects.ts'),
  'utf8',
)
const uploadSource = readFileSync(
  join(import.meta.dirname, '../src/main/ipc/upload.ts'),
  'utf8',
)

test('large roster counts stay bounded instead of querying once per person or class', () => {
  const classHandler = projectsSource.slice(
    projectsSource.indexOf("ipcMain.handle('classes:list'"),
    projectsSource.indexOf('// Students'),
  )
  const studentHandler = projectsSource.slice(
    projectsSource.indexOf("'students:list'"),
  )

  assert.match(classHandler, /\.groupBy\(studentsTable\.classId\)/)
  assert.equal(
    (classHandler.match(/\.select\(/g) ?? []).length,
    2,
    'class list should use one class query and one grouped student-count query',
  )

  assert.match(studentHandler, /\.groupBy\(capturesTable\.studentId\)/)
  assert.equal(
    (studentHandler.match(/\.select\(/g) ?? []).length,
    2,
    'student list should use one roster query and one grouped capture-count query',
  )
  assert.doesNotMatch(studentHandler, /\.all\(\)\s*\.filter\(/)
})

test('grouped lookup remains linear for a 2500-person roster', () => {
  const subjectCount = 2_500
  const groupedCounts = Array.from({ length: subjectCount }, (_, index) => ({
    studentId: index + 1,
    photoCount: index % 7,
  }))
  const countByStudent = new Map(
    groupedCounts.map(({ studentId, photoCount }) => [studentId, photoCount]),
  )

  let lookups = 0
  const roster = Array.from({ length: subjectCount }, (_, index) => {
    lookups += 1
    return {
      id: index + 1,
      photoCount: countByStudent.get(index + 1) ?? 0,
    }
  })

  assert.equal(roster.length, subjectCount)
  assert.equal(lookups, subjectCount)
  assert.equal(roster[2_499]?.photoCount, 2_499 % 7)
})

test('upload status uses joined file reads instead of querying once per capture', () => {
  const blockerHandler = uploadSource.slice(
    uploadSource.indexOf('export function getProjectUploadBlockerCount'),
    uploadSource.indexOf('function isLiveUploadEnabled'),
  )
  const statusHandler = uploadSource.slice(
    uploadSource.indexOf('function getUploadStatusCounts'),
    uploadSource.indexOf('export function getLiveUploadState'),
  )

  assert.match(blockerHandler, /loadProjectUploadSnapshot\(projectId\)/)
  assert.equal(
    (blockerHandler.match(/\.select\(/g) ?? []).length,
    0,
    'blocked-file count should reuse the bounded project snapshot',
  )
  assert.match(statusHandler, /loadProjectUploadSnapshot\(projectId\)/)
  assert.match(statusHandler, /classifyProjectUploadFile/)
  assert.doesNotMatch(statusHandler, /db\.select/)
})

test('upload job and queue reads stay bulk-loaded for large personal and group batches', () => {
  const snapshotHandler = uploadSource.slice(
    uploadSource.indexOf('function loadProjectUploadSnapshot'),
    uploadSource.indexOf('function getProjectSyncJobsFromSnapshot'),
  )
  const jobsHandler = uploadSource.slice(
    uploadSource.indexOf('function getProjectSyncJobsFromSnapshot'),
    uploadSource.indexOf('const LIVE_UPLOAD_SETTING_PREFIX'),
  )
  const queueHandler = uploadSource.slice(
    uploadSource.indexOf('function getLiveUploadQueue'),
    uploadSource.indexOf('function emitLiveUploadState'),
  )
  const liveJobsHandler = uploadSource.slice(
    uploadSource.indexOf('function getProjectLiveUploadJobs'),
    uploadSource.indexOf('async function uploadProjectJob'),
  )

  assert.match(snapshotHandler, /\.leftJoin\(imageFilesTable/)
  assert.match(snapshotHandler, /\.innerJoin\(groupCaptureFilesTable/)
  assert.match(snapshotHandler, /\.leftJoin\(studentsTable/)
  assert.match(snapshotHandler, /\.leftJoin\(groupsTable/)
  assert.equal(
    (snapshotHandler.match(/\.select\(/g) ?? []).length,
    3,
    'personal, group, and legacy inputs should use three bounded joined queries',
  )
  assert.match(jobsHandler, /getMirroredLegacyPhotoIds/)
  assert.doesNotMatch(jobsHandler, /db\.select/)
  assert.doesNotMatch(queueHandler, /db\.select/)
  assert.doesNotMatch(liveJobsHandler, /db\.select/)

  const projectRows = [
    ...Array.from({ length: 2_500 }, (_, index) => ({
      projectId: 1,
      kind: 'personal',
      captureId: index + 1,
      studentId: index + 1,
    })),
    { projectId: 1, kind: 'group', captureId: 2_501, studentId: null },
    { projectId: 1, kind: 'legacy', captureId: 2_502, studentId: 2_500 },
    { projectId: 2, kind: 'personal', captureId: 2_503, studentId: 2_501 },
  ]
  const projectOne = projectRows.filter((row) => row.projectId === 1)
  const projectOneStudents = new Map(
    projectOne
      .filter((row) => row.studentId !== null)
      .map((row) => [row.studentId, row.projectId]),
  )
  assert.equal(projectOne.length, 2_502)
  assert.equal(projectOneStudents.size, 2_500)
  assert.equal(projectOneStudents.get(2_501), undefined)
  assert.equal(projectOne.some((row) => row.kind === 'group'), true)
  assert.equal(projectOne.some((row) => row.kind === 'legacy'), true)
})

test('snapshot classifier keeps unresolved durable files blocking without changing valid group semantics', () => {
  assert.equal(classifyProjectUploadFile({
    kind: 'personal',
    associationResolved: false,
    status: null,
  }), 'blocked')
  assert.equal(classifyProjectUploadFile({
    kind: 'personal',
    associationResolved: false,
    status: 'done',
  }), 'excluded')
  assert.equal(classifyProjectUploadFile({
    kind: 'legacy',
    associationResolved: false,
    status: 'error',
  }), 'blocked')
  assert.equal(classifyProjectUploadFile({
    kind: 'legacy',
    associationResolved: false,
    status: 'done',
  }), 'excluded')
  assert.equal(classifyProjectUploadFile({
    kind: 'group',
    associationResolved: false,
    status: 'done',
    fileRole: 'JPEG',
    galleryReady: false,
  }), 'blocked')
  assert.equal(classifyProjectUploadFile({
    kind: 'group',
    associationResolved: false,
    status: 'done',
    fileRole: 'RAW',
    galleryReady: false,
  }), 'excluded')
  assert.equal(classifyProjectUploadFile({
    kind: 'group',
    associationResolved: true,
    status: 'done',
    fileRole: 'JPEG',
    galleryReady: false,
  }), 'ready')
  assert.equal(classifyProjectUploadFile({
    kind: 'group',
    associationResolved: true,
    status: 'done',
    fileRole: 'JPEG',
    galleryReady: true,
  }), 'excluded')
  assert.equal(classifyProjectUploadFile({
    kind: 'group',
    associationResolved: true,
    status: null,
    fileRole: 'JPEG',
    galleryReady: false,
  }), 'ready')
})