import assert from 'node:assert/strict'
import test from 'node:test'
import { AsyncTaskLimiter, runWithConcurrency } from '../src/main/lib/uploadConcurrency.ts'

test('shared upload limiter never runs more than three transfers', async () => {
  const limiter = new AsyncTaskLimiter(3)
  let active = 0
  let highestActive = 0
  const releases: Array<() => void> = []

  const tasks = Array.from({ length: 8 }, (_, index) => limiter.run(async () => {
    active++
    highestActive = Math.max(highestActive, active)
    await new Promise<void>((resolve) => { releases[index] = resolve })
    active--
  }))

  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(highestActive, 3)
  for (let index = 0; index < tasks.length; index++) {
    releases[index]?.()
    await new Promise((resolve) => setImmediate(resolve))
  }
  await Promise.all(tasks)
  assert.equal(highestActive, 3)
  assert.equal(active, 0)
})

test('three workers process every queued upload once', async () => {
  const seen: number[] = []
  let active = 0
  let highestActive = 0
  await runWithConcurrency([1, 2, 3, 4, 5, 6, 7], 3, async (item) => {
    active++
    highestActive = Math.max(highestActive, active)
    await new Promise((resolve) => setTimeout(resolve, 5))
    seen.push(item)
    active--
  })
  assert.equal(highestActive, 3)
  assert.deepEqual(seen.sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7])
})