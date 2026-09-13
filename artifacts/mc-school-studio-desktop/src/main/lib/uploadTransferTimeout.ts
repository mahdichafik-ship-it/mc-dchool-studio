/**
 * Transfer budgets are deliberately based on a conservative lower-bound
 * throughput rather than the photographer's current connection speed. School
 * networks can become slow without becoming fully offline, and a fixed
 * timeout would incorrectly turn a healthy large upload into a retry.
 */
export const UPLOAD_MIN_THROUGHPUT_BYTES_PER_SECOND = 128 * 1024
export const UPLOAD_SETUP_ALLOWANCE_MS = 60_000
export const UPLOAD_MIN_TRANSFER_TIMEOUT_MS = 120_000

// R2 presigned PUTs live for at most 15 minutes. Keep a two-minute reserve for
// request setup, clock skew, and the short verification call that follows.
export const UPLOAD_MAX_TRANSFER_TIMEOUT_MS = 13 * 60_000
export const UPLOAD_EXPIRY_SAFETY_MARGIN_MS = 60_000
export const UPLOAD_TIMEOUT_MESSAGE = 'Upload timed out and will retry.'

export function isUploadTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return error.name === 'TimeoutError'
    || error.name === 'AbortError'
    || /timed?\s*out|timeout/i.test(error.message)
}

/**
 * Return the deterministic timeout used for a file transfer.
 *
 * The minimum applies to legacy and modern multipart uploads alike. Modern
 * capture/group uploads and direct R2 PUTs therefore never get less than two
 * minutes, while larger files receive time proportional to their byte size.
 */
export function getUploadTransferTimeoutMs(byteSize: number): number {
  if (!Number.isFinite(byteSize) || byteSize < 0) {
    throw new RangeError('Upload size must be a finite non-negative number.')
  }

  const transferMs = Math.ceil((byteSize / UPLOAD_MIN_THROUGHPUT_BYTES_PER_SECOND) * 1_000)
  return Math.min(
    UPLOAD_MAX_TRANSFER_TIMEOUT_MS,
    Math.max(UPLOAD_MIN_TRANSFER_TIMEOUT_MS, UPLOAD_SETUP_ALLOWANCE_MS + transferMs),
  )
}

// Keep the shorter name available to callers that only need the budget.
export const getTransferTimeoutMs = getUploadTransferTimeoutMs

/**
 * A PUT must have enough signed-URL lifetime for its complete budget plus a
 * reserve. A false result is retryable: the caller should request a new
 * session instead of starting a PUT that is likely to expire mid-transfer.
 */
export function hasSufficientUploadWindow(
  expiresAt: string | number | Date,
  byteSize: number,
  nowMs = Date.now(),
): boolean {
  const expiryMs = expiresAt instanceof Date
    ? expiresAt.getTime()
    : typeof expiresAt === 'number'
      ? expiresAt
      : Date.parse(expiresAt)
  if (!Number.isFinite(expiryMs) || !Number.isFinite(nowMs)) return false

  return expiryMs - nowMs >= getUploadTransferTimeoutMs(byteSize) + UPLOAD_EXPIRY_SAFETY_MARGIN_MS
}