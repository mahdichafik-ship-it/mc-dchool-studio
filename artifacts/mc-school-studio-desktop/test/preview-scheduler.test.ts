import test from 'node:test'
import assert from 'node:assert/strict'
import { PreviewScheduler } from '../src/renderer/src/lib/previewScheduler.ts'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((nextResolve) => {
    resolve = nextResolve
  })
  return { promise, resolve }
}

test('newest live preview replaces older pending live requests', async () => {
  const scheduler = new PreviewScheduler()
  const started: string[] = []
  const cancelled: string[] = []
  const firstDecode = deferred()

  scheduler.enqueue({
    id: 'live-1',
    priority: 'live',
    execute: async () => {
      started.push('live-1')
      await firstDecode.promise
    },
    onCancelled: () => cancelled.push('live-1'),
  })
  await new Promise((resolve) => setImmediate(resolve))
  scheduler.enqueue({
    id: 'live-2',
    priority: 'live',
    execute: async () => { started.push('live-2') },
    onCancelled: () => cancelled.push('live-2'),
  })
  scheduler.enqueue({
    id: 'live-3',
    priority: 'live',
    execute: async () => { started.push('live-3') },
    onCancelled: () => cancelled.push('live-3'),
  })

  firstDecode.resolve()
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(started, ['live-1', 'live-3'])
  assert.deepEqual(cancelled, ['live-1', 'live-2'])
})

test('live preview takes priority over queued gallery work with one active job', async () => {
  const scheduler = new PreviewScheduler()
  const galleryDone = deferred()
  const started: string[] = []
  let active = 0
  let maxActive = 0
  let gallerySignal: AbortSignal | undefined

  scheduler.enqueue({
    id: 'gallery-1',
    priority: 'gallery',
    execute: async (signal) => {
      gallerySignal = signal
      active++
      maxActive = Math.max(maxActive, active)
      await galleryDone.promise
      active--
    },
  })
  scheduler.enqueue({
    id: 'gallery-2',
    priority: 'gallery',
    execute: async () => { started.push('gallery-2') },
  })

  await new Promise((resolve) => setImmediate(resolve))
  scheduler.enqueue({
    id: 'live-1',
    priority: 'live',
    execute: async () => {
      started.push('live-1')
      active++
      maxActive = Math.max(maxActive, active)
      active--
    },
  })

  assert.equal(gallerySignal?.aborted, true)
  galleryDone.resolve()
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))

  assert.deepEqual(started, ['live-1', 'gallery-2'])
  assert.equal(maxActive, 1)
})