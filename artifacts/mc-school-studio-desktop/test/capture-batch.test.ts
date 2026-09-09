import test from 'node:test'
import assert from 'node:assert/strict'
import { assertCaptureBatchComplete } from '../src/main/lib/captureBatch.ts'

test('accepts only a completed server batch', () => {
  assert.doesNotThrow(() => assertCaptureBatchComplete({ status: 'complete' }))
  assert.throws(() => assertCaptureBatchComplete({ status: 'failed' }), /failed/)
  assert.throws(() => assertCaptureBatchComplete({ status: 'in_progress' }), /in_progress/)
})

test('requires a returned completion gate to pass', () => {
  assert.doesNotThrow(() => assertCaptureBatchComplete({
    batch: { status: 'complete' },
    completionGate: { ready: true },
  }))
  assert.throws(() => assertCaptureBatchComplete({
    status: 'complete',
    completionGate: false,
  }), /completion gate/)
})