import assert from 'node:assert/strict'
import test from 'node:test'
import { canDropOnGroup, canDropOnStudent } from '../src/renderer/src/lib/dropTargetFeedback.ts'

test('student targets accept files and existing individual photos only', () => {
  assert.equal(canDropOnStudent(['Files']), true)
  assert.equal(canDropOnStudent(['application/x-volume-capture-photo']), true)
  assert.equal(canDropOnStudent(['application/x-volume-capture-group-capture']), false)
  assert.equal(canDropOnStudent(['application/x-volume-capture-student']), false)
})

test('class targets accept group-photo moves while custom groups reject them', () => {
  assert.equal(canDropOnGroup(['application/x-volume-capture-group-capture'], true), true)
  assert.equal(canDropOnGroup(['application/x-volume-capture-group-captures'], true), true)
  assert.equal(canDropOnGroup(['application/x-volume-capture-group-captures'], false), false)
})

test('group targets accept file, individual-photo, and student drops', () => {
  assert.equal(canDropOnGroup(['Files'], false), true)
  assert.equal(canDropOnGroup(['application/x-volume-capture-photo'], false), true)
  assert.equal(canDropOnGroup(['application/x-volume-capture-student'], false), true)
  assert.equal(canDropOnGroup(['text/plain'], true), false)
})
