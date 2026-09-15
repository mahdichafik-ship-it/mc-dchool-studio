import { strict as assert } from 'node:assert'
import test from 'node:test'
import { ensureCaptureTables, ensureLegacyColumns, ensureStudentIdentityConstraint } from '../src/main/db/migrations.ts'
import { reconcileLegacyPhotosAsCaptures } from '../src/main/lib/captureRepository.ts'
import { execFileSync } from 'node:child_process'
import { existsSync, unlinkSync, writeFileSync } from 'node:fs'
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
  assert(columns.get('students')?.has('secondary_email'))
  assert(columns.get('students')?.has('job_title'))
  assert(columns.get('students')?.has('office_location'))
  assert(columns.get('students')?.has('photo_session'))
  assert(columns.get('students')?.has('capture_notes'))
  assert(columns.get('projects')?.has('project_type'))
  assert(columns.get('projects')?.has('sync_status'))
  assert(columns.get('projects')?.has('sync_completed_files'))
  assert(columns.get('projects')?.has('sync_total_files'))
  assert(migrationStatements.some((statement) => /SET sync_status = 'synced'/.test(statement)))
  assert.equal(columns.get('students')?.size, 14)
})

test('repairs case-insensitive roster duplicates without changing row or capture identity', () => {
  const dbPath = join(tmpdir(), `mc-school-student-id-repair-${process.pid}.sqlite`)
  execFileSync('sqlite3', [dbPath, `
    CREATE TABLE students (
      id INTEGER PRIMARY KEY,
      project_id INTEGER NOT NULL,
      generated_student_id TEXT NOT NULL,
      updated_at TEXT
    );
    CREATE TABLE captures (
      id INTEGER PRIMARY KEY,
      student_id INTEGER,
      base_filename TEXT NOT NULL
    );
    INSERT INTO students (id, project_id, generated_student_id)
      VALUES (10, 1, 'AbC1234'), (11, 1, 'abc1234'), (12, 2, 'ABC1234');
    INSERT INTO captures (id, student_id, base_filename)
      VALUES (90, 11, 'late-jpeg'), (91, 12, 'other-project');
  `])
  const sqlite = {
    pragma(source: string) {
      return JSON.parse(execFileSync('sqlite3', ['-json', dbPath, `PRAGMA ${source}`], { encoding: 'utf8' }))
    },
    exec(source: string) {
      execFileSync('sqlite3', [dbPath, source])
    },
  }
  try {
    const before = JSON.parse(execFileSync('sqlite3', [
      '-json', dbPath, 'SELECT id, student_id FROM captures ORDER BY id',
    ], { encoding: 'utf8' }))
    ensureStudentIdentityConstraint(sqlite)
    ensureStudentIdentityConstraint(sqlite)

    const students = JSON.parse(execFileSync('sqlite3', [
      '-json', dbPath,
      'SELECT id, project_id, generated_student_id FROM students ORDER BY id',
    ], { encoding: 'utf8' })) as Array<{ id: number; project_id: number; generated_student_id: string }>
    assert.equal(students[0].generated_student_id, 'AbC1234')
    assert.notEqual(students[1].generated_student_id.toLocaleLowerCase(), 'abc1234')
    assert.equal(students[2].generated_student_id, 'ABC1234')
    assert.deepEqual(JSON.parse(execFileSync('sqlite3', [
      '-json', dbPath, 'SELECT id, student_id FROM captures ORDER BY id',
    ], { encoding: 'utf8' })), before)
    assert.throws(() => execFileSync('sqlite3', [
      dbPath,
      "INSERT INTO students (project_id, generated_student_id) VALUES (1, 'ABC1234')",
    ], { stdio: ['ignore', 'ignore', 'ignore'] }))
  } finally {
    unlinkSync(dbPath)
  }
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

test('a migrated legacy portrait remains in the student review query after restart', () => {
  const dbPath = join(tmpdir(), `mc-school-review-migration-${process.pid}.sqlite`)
  const photoPath = join(tmpdir(), `mc-school-review-legacy-${process.pid}.jpg`)
  writeFileSync(photoPath, Buffer.from('legacy portrait bytes'))
  execFileSync('sqlite3', [dbPath, `
    PRAGMA foreign_keys = ON;
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY,
      school_name TEXT NOT NULL,
      photo_date TEXT,
      address TEXT,
      contact_name TEXT,
      contact_email TEXT,
      contact_phone TEXT,
      notes TEXT,
      watch_folder TEXT,
      finished_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE classes (
      id INTEGER PRIMARY KEY,
      project_id INTEGER NOT NULL,
      class_name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE students (
      id INTEGER PRIMARY KEY,
      project_id INTEGER NOT NULL,
      class_id INTEGER NOT NULL,
      first_name TEXT NOT NULL,
      last_name TEXT NOT NULL,
      generated_student_id TEXT NOT NULL,
      simple_qr TEXT,
      json_qr TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE photos (
      id INTEGER PRIMARY KEY,
      project_id INTEGER NOT NULL,
      student_id INTEGER,
      file_path TEXT NOT NULL,
      file_name TEXT NOT NULL,
      captured_at TEXT NOT NULL,
      is_matched INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO projects (id, school_name, created_at, updated_at)
      VALUES (1, 'Legacy review project', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    INSERT INTO classes (id, project_id, class_name, created_at, updated_at)
      VALUES (2, 1, 'Class A', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    INSERT INTO students (id, project_id, class_id, first_name, last_name, generated_student_id, created_at, updated_at)
      VALUES (3, 1, 2, 'Legacy', 'Portrait', 'LEGACY-1', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    INSERT INTO photos (id, project_id, student_id, file_path, file_name, captured_at, is_matched, created_at)
      VALUES (4, 1, 3, '${photoPath.replaceAll("'", "''")}', 'Legacy_Portrait.jpg', '2026-01-01T12:00:00.000Z', 1, '2026-01-01T12:00:00.000Z');
  `])

  const sqlite = {
    pragma(source: string) {
      return JSON.parse(execFileSync('sqlite3', ['-json', dbPath, `PRAGMA ${source}`], { encoding: 'utf8' }))
    },
    exec(source: string) {
      execFileSync('sqlite3', [dbPath, source])
    },
  }

  try {
    ensureLegacyColumns(sqlite)
    ensureCaptureTables(sqlite)
    ensureLegacyColumns(sqlite)
    ensureCaptureTables(sqlite)

    const reviewRows = JSON.parse(execFileSync('sqlite3', ['-json', dbPath, `
      SELECT c.id, c.student_id, c.pairing_status, f.stored_path, p.file_path
      FROM captures c
      JOIN image_files f ON f.capture_id = c.id AND f.file_role = 'JPEG'
      JOIN photos p ON p.id = c.legacy_photo_id
      WHERE c.project_id = 1 AND c.student_id = 3 AND c.group_id IS NULL
      ORDER BY c.id;
    `], { encoding: 'utf8' })) as Array<Record<string, unknown>>

    assert.deepEqual(reviewRows, [{
      id: 1,
      student_id: 3,
      pairing_status: 'jpeg_only',
      stored_path: photoPath,
      file_path: photoPath,
    }])
    assert.equal(existsSync(photoPath), true, 'migration must not move or delete the legacy file')

    // A newer capture may already exist when a legacy photo row is still
    // present. Re-running the upgrade must link the JPEG instead of creating
    // a second capture for the same shutter event.
    execFileSync('sqlite3', [dbPath, `
      INSERT INTO captures (
        capture_key, project_id, student_id, class_id, base_filename, captured_at,
        assignment_locked, pairing_status, created_at, updated_at
      ) VALUES (
        'modern-capture', 1, 3, 2, 'Modern_Portrait', '2026-01-01T13:00:00.000Z',
        1, 'raw_only', '2026-01-01T13:00:00.000Z', '2026-01-01T13:00:00.000Z'
      );
      INSERT INTO image_files (
        capture_id, file_role, file_format, original_filename, stored_path,
        source_path, import_time, created_at
      ) VALUES (
        last_insert_rowid(), 'RAW', 'CR3', 'Modern_Portrait.cr3',
        '/legacy/Modern_Portrait.cr3', '/camera/Modern_Portrait.cr3',
        '2026-01-01T13:00:00.000Z', '2026-01-01T13:00:00.000Z'
      );
      INSERT INTO photos (
        id, project_id, student_id, file_path, file_name, captured_at, is_matched, created_at
      ) VALUES (
        5, 1, 3, '${photoPath.replaceAll("'", "''")}', 'Modern_Portrait.jpg',
        '2026-01-01T13:00:00.000Z', 1, '2026-01-01T13:00:00.000Z'
      );
    `])
    ensureCaptureTables(sqlite)

    const modernRows = JSON.parse(execFileSync('sqlite3', ['-json', dbPath, `
      SELECT c.id, c.legacy_photo_id, c.pairing_status, count(f.id) AS file_count
      FROM captures c
      JOIN image_files f ON f.capture_id = c.id
      WHERE c.base_filename = 'Modern_Portrait'
      GROUP BY c.id, c.legacy_photo_id, c.pairing_status;
    `], { encoding: 'utf8' })) as Array<Record<string, unknown>>
    assert.deepEqual(modernRows, [{
      id: 2,
      legacy_photo_id: 5,
      pairing_status: 'complete',
      file_count: 2,
    }])
  } finally {
    unlinkSync(dbPath)
    unlinkSync(photoPath)
  }
})