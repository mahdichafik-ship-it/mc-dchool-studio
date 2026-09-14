import { strict as assert } from 'node:assert'
import test from 'node:test'
import { ensureCaptureTables, ensureLegacyColumns } from '../src/main/db/migrations.ts'
import { reconcileLegacyPhotosAsCaptures } from '../src/main/lib/captureRepository.ts'
import { execFileSync } from 'node:child_process'
import { unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('upgrades an older local database without replacing existing rows', () => {
  const columns = new Map<string, Set<string>>([
    ['projects', new Set(['id', 'school_name'])],
    ['classes', new Set(['id', 'project_id', 'class_name'])],
    ['students', new Set(['id', 'project_id', 'class_id', 'first_name', 'last_name', 'generated_student_id'])],
    ['photos', new Set(['id', 'project_id', 'file_path'])],
  ])
  const existingRows = {
    projects: [{ id: 1, school_name: 'Existing school' }],
    students: [{ id: 1, project_id: 1, class_id: 1, first_name: 'Existing', last_name: 'Student', generated_student_id: 'EXISTING-1' }],
  }
  const migrationStatements: string[] = []
  const sqlite = {
    pragma(source: string) {
      const table = source.match(/^table_info\((\w+)\)$/)?.[1]
      return [...(columns.get(table ?? '') ?? [])].map((name) => ({ name }))
    },
    exec(source: string) {
      migrationStatements.push(source)
      if (source.startsWith("UPDATE projects SET project_type = 'school'")) return
      const match = source.match(/^ALTER TABLE (\w+) ADD COLUMN (\w+) (.+)$/)
      assert(match, `unexpected migration statement: ${source}`)
      columns.get(match[1])?.add(match[2])
    },
  }

  ensureLegacyColumns(sqlite)
  ensureLegacyColumns(sqlite)

  assert.deepEqual(existingRows, {
    projects: [{ id: 1, school_name: 'Existing school' }],
    students: [{ id: 1, project_id: 1, class_id: 1, first_name: 'Existing', last_name: 'Student', generated_student_id: 'EXISTING-1' }],
  })
  assert(columns.get('students')?.has('email'))
  assert(columns.get('students')?.has('phone'))
  assert(columns.get('projects')?.has('project_type'))
  assert(columns.get('projects')?.has('sync_status'))
  assert(columns.get('projects')?.has('sync_completed_files'))
  assert(columns.get('projects')?.has('sync_total_files'))
  assert(migrationStatements.some((statement) => /SET sync_status = 'synced'/.test(statement)))
  assert.equal(columns.get('students')?.size, 9)
})

test('backfills active, finished, and interrupted project lifecycles safely', () => {
  const dbPath = join(tmpdir(), `mc-school-migration-${process.pid}.sqlite`)
  execFileSync('sqlite3', [dbPath, `
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY,
      school_name TEXT NOT NULL,
      finished_at TEXT,
      sync_status TEXT NOT NULL DEFAULT 'active',
      sync_completed_files INTEGER NOT NULL DEFAULT 0,
      sync_total_files INTEGER NOT NULL DEFAULT 0,
      sync_failed_files INTEGER NOT NULL DEFAULT 0,
      sync_error TEXT
    );
    CREATE TABLE classes (id INTEGER PRIMARY KEY, project_id INTEGER, class_name TEXT);
    CREATE TABLE students (id INTEGER PRIMARY KEY, project_id INTEGER, class_id INTEGER, first_name TEXT, last_name TEXT, generated_student_id TEXT);
    CREATE TABLE photos (id INTEGER PRIMARY KEY, project_id INTEGER, file_path TEXT);
    INSERT INTO projects (id, school_name, sync_status, sync_completed_files, sync_total_files)
      VALUES (1, 'Active legacy', 'active', 0, 0);
    INSERT INTO projects (id, school_name, finished_at, sync_status, sync_completed_files, sync_total_files)
      VALUES (2, 'Finished legacy', '2025-01-01T00:00:00.000Z', 'active', 7, 7);
    INSERT INTO projects (id, school_name, sync_status, sync_completed_files, sync_total_files, sync_failed_files)
      VALUES (3, 'Interrupted legacy', 'syncing', 2, 5, 1);
  `])
  const sqlite = {
    pragma(source: string) {
      return JSON.parse(execFileSync('sqlite3', ['-json', dbPath, `PRAGMA ${source}`], { encoding: 'utf8' }))
    },
    exec(source: string) {
      execFileSync('sqlite3', [dbPath, source])
    },
  }

  ensureLegacyColumns(sqlite)

  const rows = JSON.parse(execFileSync('sqlite3', ['-json', dbPath, `
    SELECT id, sync_status, sync_completed_files, sync_total_files, sync_failed_files, sync_error
    FROM projects ORDER BY id
  `], { encoding: 'utf8' })) as Array<Record<string, unknown>>
  assert.deepEqual(rows, [
    { id: 1, sync_status: 'active', sync_completed_files: 0, sync_total_files: 0, sync_failed_files: 0, sync_error: null },
    { id: 2, sync_status: 'synced', sync_completed_files: 7, sync_total_files: 7, sync_failed_files: 0, sync_error: null },
    {
      id: 3,
      sync_status: 'sync_failed',
      sync_completed_files: 2,
      sync_total_files: 5,
      sync_failed_files: 1,
      sync_error: 'Cloud sync was interrupted. Reconnect and retry Upload & Finish.',
    },
  ])
  unlinkSync(dbPath)
})

test('capture migration is repeatable and keeps legacy rows as the compatibility source', () => {
  const statements: string[] = []
  const columns = new Map<string, Set<string>>([
    ['groups', new Set()],
    ['group_captures', new Set()],
    ['group_capture_files', new Set()],
  ])
  const sqlite = {
    pragma(source: string) {
      const table = source.match(/^table_info\((\w+)\)$/)?.[1]
      return [...(columns.get(table ?? '') ?? [])].map((name) => ({ name }))
    },
    exec(source: string) {
      statements.push(source)
      const match = source.match(/^ALTER TABLE (\w+) ADD COLUMN (\w+) (.+)$/)
      if (match) columns.get(match[1])?.add(match[2])
    },
  }

  ensureCaptureTables(sqlite)
  ensureCaptureTables(sqlite)

  const migrationSql = statements.join('\n')
  assert.match(migrationSql, /CREATE TABLE IF NOT EXISTS captures/)
  assert.match(migrationSql, /CREATE TABLE IF NOT EXISTS image_files/)
  assert.match(migrationSql, /CREATE TABLE IF NOT EXISTS qr_markers/)
  assert.match(migrationSql, /CREATE TABLE IF NOT EXISTS groups/)
  assert.match(migrationSql, /CREATE TABLE IF NOT EXISTS group_members/)
  assert.match(migrationSql, /CREATE TABLE IF NOT EXISTS group_captures/)
  assert.match(migrationSql, /CREATE TABLE IF NOT EXISTS group_capture_files/)
  assert.match(migrationSql, /source_path TEXT NOT NULL UNIQUE/)
  assert.match(migrationSql, /INSERT OR IGNORE INTO captures/)
  assert.match(migrationSql, /FROM photos p/)
  assert.match(migrationSql, /INSERT OR IGNORE INTO image_files/)
  assert.match(migrationSql, /WHERE NOT EXISTS/)
  assert.equal(statements.filter((statement) => statement.includes('ADD COLUMN membership_dirty')).length, 1)
  assert.equal(statements.filter((statement) => statement.includes('ADD COLUMN gallery_ready')).length, 1)
  assert.equal(statements.filter((statement) => statement.includes('group_captures ADD COLUMN rating')).length, 1)
  assert.equal(statements.filter((statement) => statement.includes('group_captures ADD COLUMN review_sync_pending')).length, 1)
})

test('gallery reconciliation retries every legacy photo without deleting or moving it', () => {
  const photos = [
    { id: 11, filePath: '/photos/student/photo-1.jpg' },
    { id: 12, filePath: '/photos/student/photo-2.jpg' },
  ]
  const mirrored: Array<{ id: number; filePath: string }> = []

  reconcileLegacyPhotosAsCaptures(
    {} as never,
    photos as never,
    (_db, photo) => {
      mirrored.push({ id: photo.id, filePath: photo.filePath })
    },
  )

  assert.deepEqual(mirrored, photos)
})