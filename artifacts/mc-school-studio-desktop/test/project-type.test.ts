import { strict as assert } from 'node:assert'
import test from 'node:test'
import { ensureLegacyColumns } from '../src/main/db/migrations.ts'
import { normalizeProjectType } from '../src/shared/types.ts'

test('legacy and unknown project types remain school projects', () => {
  assert.equal(normalizeProjectType(undefined), 'school')
  assert.equal(normalizeProjectType(null), 'school')
  assert.equal(normalizeProjectType('agency'), 'school')
  assert.equal(normalizeProjectType('corporate'), 'corporate')
})

test('desktop migration adds and repairs the project type column', () => {
  const statements: string[] = []
  ensureLegacyColumns({
    pragma: () => [],
    exec: (source) => statements.push(source),
  })

  assert.ok(statements.some((source) =>
    source.includes("ALTER TABLE projects ADD COLUMN project_type TEXT NOT NULL DEFAULT 'school'"),
  ))
  assert.ok(statements.some((source) =>
    source.includes("UPDATE projects SET project_type = 'school'"),
  ))
})