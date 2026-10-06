import assert from 'node:assert/strict'
import test from 'node:test'
import {
  groupFiveStarReplacementIds,
  portraitFiveStarReplacementIds,
} from '../src/main/lib/reviewRatingReplacement.ts'

test('replaces only the five-star portrait in the same project and student scope', () => {
  const rows = [
    { id: 1, projectId: 10, studentId: 20, groupId: null, rating: 5 },
    { id: 2, projectId: 10, studentId: 20, groupId: null, rating: 4 },
    { id: 3, projectId: 10, studentId: 21, groupId: null, rating: 5 },
    { id: 4, projectId: 11, studentId: 20, groupId: null, rating: 5 },
    { id: 5, projectId: 10, studentId: 20, groupId: 'group-1', rating: 5 },
  ] as const

  assert.deepEqual(
    portraitFiveStarReplacementIds(rows, { id: 9, projectId: 10, studentId: 20, rating: 5 }),
    [1],
  )
  assert.deepEqual(
    portraitFiveStarReplacementIds(rows, { id: 9, projectId: 10, studentId: null, rating: 5 }),
    [],
  )
  assert.deepEqual(
    portraitFiveStarReplacementIds(rows, { id: 9, projectId: 10, studentId: 20, rating: 4 }),
    [],
  )
})

test('replaces only the five-star capture in the same project and group', () => {
  const rows = [
    { id: 1, projectId: 10, groupId: 20, rating: 5 },
    { id: 2, projectId: 10, groupId: 20, rating: 4 },
    { id: 3, projectId: 10, groupId: 21, rating: 5 },
    { id: 4, projectId: 11, groupId: 20, rating: 5 },
  ] as const

  assert.deepEqual(
    groupFiveStarReplacementIds(rows, { id: 9, projectId: 10, groupId: 20, rating: 5 }),
    [1],
  )
  assert.deepEqual(
    groupFiveStarReplacementIds(rows, { id: 9, projectId: 10, groupId: 20, rating: 0 }),
    [],
  )
})