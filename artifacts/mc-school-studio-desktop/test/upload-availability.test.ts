import assert from 'node:assert/strict'
import test from 'node:test'
import {
  classifyProjectUploadFile,
  groupCaptureCompatibilityKey,
  isGroupCaptureCompatibilityMirror,
} from '../src/main/lib/projectUploadClassification.ts'
import { canStartUploadNow } from '../src/renderer/src/lib/uploadAvailability.ts'

test('keeps matched unrated group photos eligible while they remain private', () => {
  assert.equal(classifyProjectUploadFile({
    kind: 'group',
    associationResolved: true,
    status: null,
    fileRole: 'JPEG',
    galleryReady: false,
  }), 'ready')
})

test('continues blocking group photos without a class match', () => {
  assert.equal(classifyProjectUploadFile({
    kind: 'group',
    associationResolved: false,
    status: null,
    fileRole: 'JPEG',
    galleryReady: false,
  }), 'blocked')
})

test('recognizes only the compatibility capture for its matching group photo', () => {
  const groupCaptureKeys = new Set([
    groupCaptureCompatibilityKey(12, 'group:12:photo-1'),
  ])

  assert.equal(isGroupCaptureCompatibilityMirror({
    groupId: '12',
    captureKey: 'group:12:photo-1',
  }, groupCaptureKeys), true)
  assert.equal(isGroupCaptureCompatibilityMirror({
    groupId: '13',
    captureKey: 'group:12:photo-1',
  }, groupCaptureKeys), false)
  assert.equal(isGroupCaptureCompatibilityMirror({
    groupId: null,
    captureKey: 'group:12:photo-1',
  }, groupCaptureKeys), false)
  assert.equal(isGroupCaptureCompatibilityMirror({
    groupId: '12',
    captureKey: 'unmatched:photo-1',
  }, groupCaptureKeys), false)
})

test('allows upload only after the required portrait favorites are complete', () => {
  assert.equal(canStartUploadNow({
    actionRunning: false,
    cloudReady: true,
    projectFinished: false,
    missingFavoritePortraitCount: 0,
  }), true)
  assert.equal(canStartUploadNow({
    actionRunning: false,
    cloudReady: true,
    projectFinished: false,
    missingFavoritePortraitCount: 1,
  }), false)
})

test('blocks manual upload while an action is running, offline, or finished', () => {
  for (const input of [
    { actionRunning: true, cloudReady: true, projectFinished: false },
    { actionRunning: false, cloudReady: false, projectFinished: false },
    { actionRunning: false, cloudReady: true, projectFinished: true },
  ]) {
    assert.equal(canStartUploadNow({
      ...input,
      missingFavoritePortraitCount: 0,
    }), false)
  }
})
