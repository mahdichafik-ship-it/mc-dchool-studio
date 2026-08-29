import { strict as assert } from 'node:assert'
import test from 'node:test'
import { join } from 'node:path'
import { retireLocalProjects } from '../src/main/lib/retirement.ts'
import { WorkBarrier } from '../src/main/lib/workBarrier.ts'

test('retirement clears project records and only app-managed photo paths', () => {
  const root = join('/tmp', 'mc-school-studio-photos')
  const removed: string[] = []
  const events: string[] = []

  const result = retireLocalProjects(
    {
      listProjects: () => [
        { id: 7, schoolName: 'North / Academy' },
        { id: 8, schoolName: 'South School' },
      ],
      listPhotoPaths: () => [
        join(root, 'North _ Academy', 'Class A', 'portrait.jpg'),
        join(root, '8', 'student-1', 'portrait.jpg'),
        join('/tmp', 'camera-originals', 'do-not-delete.jpg'),
      ],
      clearProjects: () => events.push('database-cleared'),
    },
    {
      remove: (path) => {
        removed.push(path)
        events.push(`removed:${path}`)
      },
    },
    root,
  )

  assert.equal(result.projectsCleared, 2)
  assert(removed.includes(join(root, 'North _ Academy')))
  assert(removed.includes(join(root, 'South School')))
  assert(removed.includes(join(root, '7')))
  assert(removed.includes(join(root, '8')))
  assert(!removed.some((path) => path.includes('camera-originals')))
  assert.equal(events.at(-1), 'database-cleared', 'records are cleared only after managed files are removed')
})

test('retirement drains an in-flight cloud import before cleanup and prevents its write', async () => {
  const barrier = new WorkBarrier()
  let releaseDownload!: () => void
  const heldDownload = new Promise<void>((resolve) => {
    releaseDownload = resolve
  })
  const writes: string[] = []

  const importTask = barrier.run(async () => {
    await heldDownload
    if (barrier.isDisabled()) return
    writes.push('project roster written')
  })
  assert(importTask)

  let drainFinished = false
  const drain = barrier.disableAndDrain().then(() => {
    drainFinished = true
  })
  await Promise.resolve()
  assert.equal(drainFinished, false, 'cleanup must wait for the held cloud response')

  releaseDownload()
  await drain
  assert.deepEqual(writes, [], 'a response released after retirement must not write local student data')
  assert.equal(barrier.run(async () => writes.push('late write')), null)
})