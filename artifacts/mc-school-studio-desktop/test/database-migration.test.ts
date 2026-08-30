import { strict as assert } from 'node:assert'
import test from 'node:test'
import { ensureCaptureTables, ensureLegacyColumns } from '../src/main/db/migrations.ts'

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
  const sqlite = {
    pragma(source: string) {
      const table = source.match(/^table_info\((\w+)\)$/)?.[1]
      return [...(columns.get(table ?? '') ?? [])].map((name) => ({ name }))
    },
    exec(source: string) {
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
  assert.equal(columns.get('students')?.size, 9)
})

test('capture migration is repeatable and keeps legacy rows as the compatibility source', () => {
  const statements: string[] = []
  const sqlite = {
    pragma() {
      return []
    },
    exec(source: string) {
      statements.push(source)
    },
  }

  ensureCaptureTables(sqlite)
  ensureCaptureTables(sqlite)

  assert.equal(statements.length, 4)
  assert.match(statements[0] ?? '', /CREATE TABLE IF NOT EXISTS captures/)
  assert.match(statements[0] ?? '', /CREATE TABLE IF NOT EXISTS image_files/)
  assert.match(statements[1] ?? '', /INSERT OR IGNORE INTO captures/)
  assert.match(statements[1] ?? '', /FROM photos p/)
  assert.match(statements[1] ?? '', /INSERT OR IGNORE INTO image_files/)
  assert.match(statements[1] ?? '', /WHERE NOT EXISTS/)
})