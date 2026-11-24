import assert from 'node:assert/strict'
import test from 'node:test'
import {
  groupCaptureBatchMoveBlockReason,
  groupCaptureMoveBlockReason,
} from '../src/main/lib/groupCaptureMovePolicy.ts'

const baseMove = {
  projectFinished: false,
  sourceGroupId: 10,
  targetGroupId: 11,
  sourceIsClassGroup: true,
  targetIsClassGroup: true,
  sourceFiles: [{ uploadStatus: null, fileUrl: null, galleryReady: false }],
  sourceRating: 0,
  destinationFiveStarFiles: [],
}

test('allows a local class-photo move before upload begins', () => {
  assert.equal(groupCaptureMoveBlockReason(baseMove), null)
})

test('allows never-started local files to move even when the upload list calls them queued', () => {
  assert.equal(groupCaptureMoveBlockReason({
    ...baseMove,
    sourceFiles: [{ uploadStatus: null, fileUrl: null, galleryReady: false }],
  }), null)
})

test('blocks active, completed, and failed-attempt files waiting for retry', () => {
  for (const uploadStatus of ['pending', 'uploading', 'done']) {
    assert.match(
      groupCaptureMoveBlockReason({
        ...baseMove,
        sourceFiles: [{ uploadStatus, fileUrl: null, galleryReady: false }],
      }) ?? '',
      /upload|retry/,
    )
  }
})

test('blocks cloud URLs and gallery-ready files even if upload status is stale', () => {
  assert.match(
    groupCaptureMoveBlockReason({
      ...baseMove,
      sourceFiles: [{ uploadStatus: 'error', fileUrl: '/cloud/photo.jpg', galleryReady: false }],
    }) ?? '',
    /upload|retry/,
  )
  assert.match(
    groupCaptureMoveBlockReason({
      ...baseMove,
      sourceFiles: [{ uploadStatus: 'pending', fileUrl: null, galleryReady: true }],
    }) ?? '',
    /upload|retry/,
  )
})

test('blocks finished projects, non-class groups, and no-op moves', () => {
  assert.match(groupCaptureMoveBlockReason({ ...baseMove, projectFinished: true }) ?? '', /project is finished/)
  assert.match(groupCaptureMoveBlockReason({ ...baseMove, sourceIsClassGroup: false }) ?? '', /Only class-group photos/)
  assert.match(groupCaptureMoveBlockReason({ ...baseMove, targetGroupId: baseMove.sourceGroupId }) ?? '', /already assigned/)
})

test('does not replace an uploaded destination five-star image', () => {
  const reason = groupCaptureMoveBlockReason({
    ...baseMove,
    sourceRating: 5,
    destinationFiveStarFiles: [[{ uploadStatus: 'done', fileUrl: '/cloud/existing.jpg' }]],
  })
  assert.match(reason ?? '', /destination class already has a five-star photo/)
})

test('allows an unrated move even if the destination already has its five-star image', () => {
  assert.equal(groupCaptureMoveBlockReason({
    ...baseMove,
    sourceRating: 2,
    destinationFiveStarFiles: [[{ uploadStatus: 'done', fileUrl: '/cloud/existing.jpg' }]],
  }), null)
})

test('allows a batch of local class photos before upload starts', () => {
  assert.equal(groupCaptureBatchMoveBlockReason({
    ...baseMove,
    sourceCaptures: [
      { rating: 0, files: [{ uploadStatus: null, fileUrl: null, galleryReady: false }] },
      { rating: 3, files: [{ uploadStatus: null, fileUrl: null, galleryReady: false }] },
    ],
  }), null)
})

test('blocks the entire batch when any selected class photo is already uploading', () => {
  assert.match(groupCaptureBatchMoveBlockReason({
    ...baseMove,
    sourceCaptures: [
      { rating: 0, files: [{ uploadStatus: null, fileUrl: null, galleryReady: false }] },
      { rating: 0, files: [{ uploadStatus: 'uploading', fileUrl: null, galleryReady: false }] },
    ],
  }) ?? '', /upload|retry/)
})

test('blocks an unrated batch source when it has no files', () => {
  assert.match(groupCaptureBatchMoveBlockReason({
    ...baseMove,
    sourceCaptures: [{ rating: 0, files: [] }],
  }) ?? '', /class photo/)
})

test('blocks a five-star batch move if the destination winner is still locked', () => {
  assert.match(groupCaptureBatchMoveBlockReason({
    ...baseMove,
    sourceCaptures: [
      { rating: 0, files: [{ uploadStatus: null, fileUrl: null, galleryReady: false }] },
      { rating: 5, files: [{ uploadStatus: null, fileUrl: null, galleryReady: false }] },
    ],
    destinationFiveStarFiles: [[{ uploadStatus: 'done', fileUrl: '/cloud/existing.jpg' }]],
  }) ?? '', /destination class already has a five-star photo/)
})
