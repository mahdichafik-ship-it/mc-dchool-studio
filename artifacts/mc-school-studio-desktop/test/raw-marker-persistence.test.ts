import { strict as assert } from 'node:assert'
import test from 'node:test'
import { persistRawAtMarkerBoundary } from '../src/main/lib/rawMarkerPersistence.ts'

test('discards a RAW when its QR marker arrives while copy I/O is blocked', async () => {
  let markerMate = false
  let releaseCopy!: () => void
  const copyBlocked = new Promise<void>((resolve) => {
    releaseCopy = resolve
  })
  let persisted = false
  let discarded = false

  const pipeline = copyBlocked.then(() => persistRawAtMarkerBoundary({
    hasMarkerMate: () => markerMate,
    discardCopiedFile: async () => {
      discarded = true
    },
    persistSynchronously: () => {
      persisted = true
      return { captureId: 1 }
    },
  }))

  markerMate = true
  releaseCopy()
  const result = await pipeline

  assert.deepEqual(result, { kind: 'discarded-marker-mate' })
  assert.equal(discarded, true)
  assert.equal(persisted, false)
})

test('persists synchronously when no marker mate exists at the boundary', async () => {
  let persisted = false
  const result = await persistRawAtMarkerBoundary({
    hasMarkerMate: () => false,
    discardCopiedFile: async () => {
      assert.fail('portrait RAW must not be discarded')
    },
    persistSynchronously: () => {
      persisted = true
      return { captureId: 7 }
    },
  })

  assert.deepEqual(result, { kind: 'persisted', value: { captureId: 7 } })
  assert.equal(persisted, true)
})