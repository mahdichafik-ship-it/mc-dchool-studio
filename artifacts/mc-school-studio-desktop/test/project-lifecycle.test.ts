import { strict as assert } from 'node:assert'
import test from 'node:test'
import { hasVerifiedRemoteProjectCopy } from '../src/main/lib/projectLifecycle.ts'

const synced = {
  syncStatus: 'synced',
  finishedAt: '2026-10-29T12:00:00.000Z',
  syncCompletedFiles: 8,
  syncTotalFiles: 8,
  syncFailedFiles: 0,
}

test('only fully completed, explicitly synced projects qualify for local photo removal', () => {
  assert.equal(hasVerifiedRemoteProjectCopy(synced), true)
  assert.equal(hasVerifiedRemoteProjectCopy({ ...synced, syncStatus: 'finished_local' }), false)
  assert.equal(hasVerifiedRemoteProjectCopy({ ...synced, syncCompletedFiles: 7 }), false)
  assert.equal(hasVerifiedRemoteProjectCopy({ ...synced, syncFailedFiles: 1 }), false)
  assert.equal(hasVerifiedRemoteProjectCopy({ ...synced, finishedAt: null }), false)
  assert.equal(hasVerifiedRemoteProjectCopy(undefined), false)
})
