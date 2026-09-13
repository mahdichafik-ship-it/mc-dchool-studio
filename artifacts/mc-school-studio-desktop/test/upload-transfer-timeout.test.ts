import assert from 'node:assert/strict'
import test from 'node:test'
import {
  getUploadTransferTimeoutMs,
  hasSufficientUploadWindow,
  isUploadTimeoutError,
  UPLOAD_TIMEOUT_MESSAGE,
  UPLOAD_EXPIRY_SAFETY_MARGIN_MS,
  UPLOAD_MAX_TRANSFER_TIMEOUT_MS,
  UPLOAD_MIN_TRANSFER_TIMEOUT_MS,
  UPLOAD_MIN_THROUGHPUT_BYTES_PER_SECOND,
  UPLOAD_SETUP_ALLOWANCE_MS,
} from '../src/main/lib/uploadTransferTimeout.ts'

test('transfer budget includes setup allowance and scales with file size', () => {
  assert.equal(getUploadTransferTimeoutMs(0), UPLOAD_MIN_TRANSFER_TIMEOUT_MS)
  const size = UPLOAD_MIN_THROUGHPUT_BYTES_PER_SECOND * 10
  assert.equal(
    getUploadTransferTimeoutMs(size),
    UPLOAD_SETUP_ALLOWANCE_MS + 10_000,
  )
})

test('transfer budget is capped below the signed URL lifetime', () => {
  assert.equal(
    getUploadTransferTimeoutMs(Number.MAX_SAFE_INTEGER),
    UPLOAD_MAX_TRANSFER_TIMEOUT_MS,
  )
  assert.throws(() => getUploadTransferTimeoutMs(-1), RangeError)
})

test('signed URL expiry safety rejects a session without enough time', () => {
  const now = Date.parse('2025-01-01T00:00:00.000Z')
  const budget = getUploadTransferTimeoutMs(0)
  assert.equal(
    hasSufficientUploadWindow(
      now + budget + UPLOAD_EXPIRY_SAFETY_MARGIN_MS,
      0,
      now,
    ),
    true,
  )
  assert.equal(
    hasSufficientUploadWindow(
      now + budget + UPLOAD_EXPIRY_SAFETY_MARGIN_MS - 1,
      0,
      now,
    ),
    false,
  )
  assert.equal(hasSufficientUploadWindow('not-a-date', 0, now), false)
})

test('timeout failures have a concise retry message', () => {
  const timeout = new Error('The operation was aborted due to timeout')
  timeout.name = 'TimeoutError'
  assert.equal(isUploadTimeoutError(timeout), true)
  assert.equal(UPLOAD_TIMEOUT_MESSAGE, 'Upload timed out and will retry.')
  assert.equal(isUploadTimeoutError(new Error('HTTP 500')), false)
})