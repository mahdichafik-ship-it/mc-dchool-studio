import { strict as assert } from 'node:assert'
import test from 'node:test'
import { createShutdownCoordinator } from '../src/main/lib/shutdownCoordinator.ts'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((nextResolve) => {
    resolve = nextResolve
  })
  return { promise, resolve }
}

test('blocks the first quit until critical capture work drains', async () => {
  const drain = deferred()
  let prevented = 0
  let quitCount = 0
  const handleBeforeQuit = createShutdownCoordinator({
    drain: () => drain.promise,
    quit: () => {
      quitCount++
    },
  })
  const event = { preventDefault: () => { prevented++ } }

  handleBeforeQuit(event)
  handleBeforeQuit(event)
  await Promise.resolve()

  assert.equal(prevented, 1)
  assert.equal(quitCount, 0)

  drain.resolve()
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(quitCount, 1)
})

test('continues quitting when critical capture drain reports an error', async () => {
  let quitCount = 0
  let observedError: unknown
  const expectedError = new Error('capture drain failed')
  const handleBeforeQuit = createShutdownCoordinator({
    drain: async () => {
      throw expectedError
    },
    quit: () => {
      quitCount++
    },
    onError: (error) => {
      observedError = error
    },
  })

  handleBeforeQuit({ preventDefault: () => {} })
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(observedError, expectedError)
  assert.equal(quitCount, 1)
})