import test from 'node:test'
import assert from 'node:assert/strict'
import { buildCaptureReviewStatus } from '../src/main/lib/captureReviewStatus.ts'

test('does not mark a rated portrait that has no JPEG capture', () => {
  const status = buildCaptureReviewStatus({
    portraitCaptures: [
      { captureId: 1, studentId: 10, rating: 5, rejected: false },
      { captureId: 2, studentId: 20, rating: 5, rejected: true },
      { captureId: 3, studentId: 30, rating: 5, rejected: false },
    ],
    portraitJpegCaptureIds: new Set([1, 2]),
    groupCaptures: [],
    groupJpegCaptureIds: new Set(),
    groupMembers: [],
  })

  assert.deepEqual(status.ratedPortraitStudentIds, [10])
})

test('does not mark members of a rated group until its JPEG exists', () => {
  const status = buildCaptureReviewStatus({
    portraitCaptures: [],
    portraitJpegCaptureIds: new Set(),
    groupCaptures: [
      { captureId: 11, groupId: 100, rating: 5 },
      { captureId: 12, groupId: 200, rating: 5 },
      { captureId: 13, groupId: 300, rating: 0 },
    ],
    groupJpegCaptureIds: new Set([12]),
    groupMembers: [
      { groupId: 100, studentId: 1 },
      { groupId: 200, studentId: 2 },
      { groupId: 200, studentId: 3 },
      { groupId: 300, studentId: 4 },
    ],
  })

  assert.deepEqual(status.ratedGroupStudentIds, [2, 3])
  assert.deepEqual(status.ratedGroupIds, [200])
})

test('requires a five-star JPEG portrait per photographed student, not per frame or group', () => {
  const status = buildCaptureReviewStatus({
    portraitCaptures: [
      { captureId: 1, studentId: 10, rating: 5, rejected: true },
      { captureId: 2, studentId: 10, rating: 1, rejected: false },
      { captureId: 3, studentId: 20, rating: 4, rejected: false },
      { captureId: 4, studentId: 30, rating: 0, rejected: false },
      { captureId: 5, studentId: 40, rating: 0, rejected: false },
    ],
    portraitJpegCaptureIds: new Set([1, 2, 3, 4]),
    groupCaptures: [{ captureId: 11, groupId: 100, rating: 5 }],
    groupJpegCaptureIds: new Set([11]),
    groupMembers: [{ groupId: 100, studentId: 30 }],
  })

  assert.deepEqual(status.fiveStarPortraitStudentIds, [10])
  assert.deepEqual(status.studentsMissingFiveStarPortraitIds, [20, 30])
  assert.deepEqual(status.fiveStarGroupIds, [100])
})