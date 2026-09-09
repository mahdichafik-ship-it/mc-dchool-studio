import test from 'node:test'
import assert from 'node:assert/strict'
import {
  getNewDefaultGroupMemberIds,
  serializeDefaultGroupRosterSnapshot,
} from '../src/main/lib/groupRoster.ts'

test('snapshot preserves removals while adding genuinely new students', () => {
  assert.deepEqual(getNewDefaultGroupMemberIds([1], [1, 2], [1, 2, 3], true), [3])
})

test('first reconciliation seeds all missing class students', () => {
  assert.deepEqual(getNewDefaultGroupMemberIds([], [], [1, 2], false), [1, 2])
  assert.equal(serializeDefaultGroupRosterSnapshot([1, 2, 2]), '1,2')
})

test('dirty default pull preserves removal and adds a cloud-late student', () => {
  // Initial cloud pull includes A/B. The photographer removes B locally,
  // making the group dirty. A later pull expands the class roster with C but
  // must leave the old A/B snapshot in place until reconciliation.
  const priorSnapshot = [1, 2]
  const dirtyLocalMembers = [1]
  const pulledRoster = [1, 2, 3]
  const additions = getNewDefaultGroupMemberIds(
    dirtyLocalMembers,
    priorSnapshot,
    pulledRoster,
    true,
  )
  const reconciledMembers = [...dirtyLocalMembers, ...additions]
  const updatedSnapshot = serializeDefaultGroupRosterSnapshot(pulledRoster)

  assert.deepEqual(additions, [3])
  assert.deepEqual(reconciledMembers, [1, 3])
  assert.equal(updatedSnapshot, '1,2,3')
  assert.deepEqual({ memberStudentIds: reconciledMembers }, { memberStudentIds: [1, 3] })
})