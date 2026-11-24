import assert from 'node:assert/strict'
import test from 'node:test'
import { photoReassignmentMoveBlockReason } from '../src/main/lib/photoReassignmentMovePolicy.ts'

const localFiles = [{ uploadStatus: null, fileUrl: null, galleryReady: false }]

test('allows a never-sent portrait and paired files to be reassigned', () => {
  assert.equal(photoReassignmentMoveBlockReason({
    projectFinished: false,
    files: localFiles,
  }), null)
})

test('blocks a portrait waiting for retry', () => {
  assert.match(photoReassignmentMoveBlockReason({
    projectFinished: false,
    files: [{ uploadStatus: 'pending' }],
  }) ?? '', /waiting for retry/)
})

test('blocks a paired capture waiting for retry even when the legacy photo looks local', () => {
  assert.match(photoReassignmentMoveBlockReason({
    projectFinished: false,
    files: [...localFiles, { uploadStatus: 'pending' }],
  }) ?? '', /waiting for retry/)
})

test('blocks active, completed, cloud-linked, and gallery-ready photos', () => {
  for (const file of [
    { uploadStatus: 'uploading' },
    { uploadStatus: 'done' },
    { uploadStatus: 'error', fileUrl: '/cloud/photo.jpg' },
    { uploadStatus: 'error', galleryReady: true },
  ]) {
    assert.match(photoReassignmentMoveBlockReason({
      projectFinished: false,
      files: [file],
    }) ?? '', /uploading or already uploaded/)
  }
})

test('blocks all reassignment in a finished project', () => {
  assert.match(photoReassignmentMoveBlockReason({
    projectFinished: true,
    files: localFiles,
  }) ?? '', /project is finished/)
})
