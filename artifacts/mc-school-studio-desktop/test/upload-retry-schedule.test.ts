import assert from 'node:assert/strict'
import test from 'node:test'
import { getEligibleUploadJobs } from '../src/main/lib/uploadRetrySchedule.ts'

test('keeps retry-delayed queued files from blocking fresh captures', () => {
  const jobs = [
    { id: 'old-retry' },
    { id: 'fresh-capture' },
    { id: 'retry-ready' },
  ]
  const retryAfter = new Map([
    ['old-retry', 20_000],
    ['retry-ready', 5_000],
  ])

  assert.deepEqual(
    getEligibleUploadJobs(jobs, (job) => job.id, retryAfter, 10_000),
    [
      { id: 'fresh-capture' },
      { id: 'retry-ready' },
    ],
  )
})

test('makes a delayed file eligible after its retry deadline', () => {
  const jobs = [{ id: 'delayed' }]
  const retryAfter = new Map([['delayed', 20_000]])

  assert.deepEqual(
    getEligibleUploadJobs(jobs, (job) => job.id, retryAfter, 20_000),
    jobs,
  )
})