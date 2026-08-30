import { strict as assert } from 'node:assert'
import test from 'node:test'
import { ensureLegacyColumns } from '../src/main/db/migrations.ts'

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