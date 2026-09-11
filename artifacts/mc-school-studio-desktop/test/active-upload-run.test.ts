import assert from 'node:assert/strict'
import test from 'node:test'
import { startActiveUploadRun } from '../src/main/lib/activeUploadRun.ts'

test('empty queue releases its lock and a later capture uploads without restart', async () => {
  const runs = new Map<number, Promise<void>>()
  const queue: string[] = []
  const uploaded: string[] = []
  const work = async () => {
    if (!queue.length) return
    uploaded.push(...queue.splice(0))
  }
  for (let index = 0; index < 3; index++) {
    await startActiveUploadRun(runs, 1, work, () => {})
    assert.equal(runs.size, 0)
    queue.push(`capture-${index}`)
    await startActiveUploadRun(runs, 1, work, () => {})
    assert.equal(runs.size, 0)
  }
  assert.deepEqual(uploaded, ['capture-0', 'capture-1', 'capture-2'])
})

test('concurrent ticks share one run and cleanup precedes notification', async () => {
  const runs = new Map<number, Promise<void>>()
  let executions = 0
  const work = async () => { executions++ }
  const first = startActiveUploadRun(runs, 1, work, () => assert.equal(runs.has(1), false))
  const second = startActiveUploadRun(runs, 1, work, () => {})
  assert.equal(first, second)
  await first
  assert.equal(executions, 1)
})

test('synchronous failures release the lock for the next attempt', async () => {
  const runs = new Map<number, Promise<void>>()
  await assert.rejects(startActiveUploadRun(runs, 1, () => {
    throw new Error('enumeration failed')
  }, () => {}), /enumeration failed/)
  assert.equal(runs.size, 0)
  await startActiveUploadRun(runs, 1, async () => {}, () => {})
  assert.equal(runs.size, 0)
})