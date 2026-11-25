import assert from 'node:assert/strict'
import test from 'node:test'
import { classifyProjectUploadFile } from '../src/main/lib/projectUploadClassification.ts'
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

test('allows matched photos to upload before they are rated', () => {
  assert.equal(canStartUploadNow({
    actionRunning: false,
    cloudReady: true,
    projectFinished: false,
  }), true)
})

test('blocks manual upload while an action is running, offline, or finished', () => {
  for (const input of [
    { actionRunning: true, cloudReady: true, projectFinished: false },
    { actionRunning: false, cloudReady: false, projectFinished: false },
    { actionRunning: false, cloudReady: true, projectFinished: true },
  ]) {
    assert.equal(canStartUploadNow(input), false)
  }
})
