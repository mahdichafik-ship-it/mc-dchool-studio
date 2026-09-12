export class RetryableUploadError extends Error {}

export type R2UploadSession = {
  copyId: number
  objectKey: string
  uploadUrl: string
  uploadMethod: 'PUT'
  uploadHeaders: Record<string, string>
  expiresAt: string
  alreadyVerified: boolean
}

type JsonObject = Record<string, unknown>
export type UploadResponseKind = 'photo' | 'capture' | 'group'

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function malformedUploadResponse(message: string): never {
  throw new RetryableUploadError(`${message}; retrying safely.`)
}

/**
 * The R2 object is intentionally validated at the boundary. The server owns
 * the upload URL and object identity, so accepting a partial object here can
 * otherwise mark an upload complete without ever producing its durable copy.
 */
export function parseR2UploadSession(value: unknown): R2UploadSession {
  if (!isJsonObject(value)) malformedUploadResponse('Upload returned a malformed R2 session')

  const copyId = value.copyId
  const objectKey = value.objectKey
  const uploadUrl = value.uploadUrl
  const uploadMethod = value.uploadMethod
  const uploadHeaders = value.uploadHeaders
  const expiresAt = value.expiresAt
  const alreadyVerified = value.alreadyVerified
  if (!isPositiveSafeInteger(copyId)
    || !isNonEmptyString(objectKey)
    || typeof uploadUrl !== 'string'
    || (alreadyVerified !== true && !isNonEmptyString(uploadUrl))
    || (uploadUrl && (() => {
      try {
        return Boolean(new URL(uploadUrl))
      } catch {
        return false
      }
    })()) === false
    || uploadMethod !== 'PUT'
    || !isJsonObject(uploadHeaders)
    || !isNonEmptyString(expiresAt)
    || !Number.isFinite(Date.parse(expiresAt))
    || typeof alreadyVerified !== 'boolean'
  ) {
    malformedUploadResponse('Upload returned a malformed R2 session')
  }

  for (const header of Object.values(uploadHeaders)) {
    if (typeof header !== 'string') malformedUploadResponse('Upload returned malformed R2 session headers')
  }
  const sessionSha256 = uploadHeaders['x-amz-meta-sha256']
  if (!alreadyVerified
    && (typeof sessionSha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(sessionSha256))) {
    malformedUploadResponse('Upload returned an R2 session without a valid file hash')
  }

  return {
    copyId,
    objectKey,
    uploadUrl,
    uploadMethod,
    uploadHeaders: uploadHeaders as Record<string, string>,
    expiresAt,
    alreadyVerified,
  }
}

export function parseUploadResponseJson(responsePayload: unknown, kind: UploadResponseKind): {
  fileUrl?: string
  file?: JsonObject
  captureId?: number
  captureKey?: string
  pairingStatus?: string
  reused?: boolean
  galleryReady?: boolean
  r2Upload?: R2UploadSession | null
} {
  if (!isJsonObject(responsePayload)) {
    malformedUploadResponse(`${kind} upload returned an incomplete response`)
  }

  const r2Present = Object.prototype.hasOwnProperty.call(responsePayload, 'r2Upload')
  let r2Upload: R2UploadSession | null | undefined
  if (r2Present) {
    // null used to be treated as equivalent to an omitted field. That makes a
    // truncated or proxy-generated response indistinguishable from a legacy
    // response, so only omission remains backward compatible.
    if (responsePayload.r2Upload === null) {
      malformedUploadResponse(`${kind} upload returned a malformed r2Upload field`)
    }
    r2Upload = parseR2UploadSession(responsePayload.r2Upload)
  }

  if (kind === 'photo') {
    if (!isNonEmptyString(responsePayload.fileUrl)) {
      malformedUploadResponse('Photo upload returned an incomplete response')
    }
    return { fileUrl: responsePayload.fileUrl, r2Upload }
  }

  if (!isPositiveSafeInteger(responsePayload.captureId)
    || !isNonEmptyString(responsePayload.captureKey)
    || !['jpeg_only', 'raw_only', 'complete'].includes(String(responsePayload.pairingStatus))
    || !isJsonObject(responsePayload.file)
    || !isPositiveSafeInteger(responsePayload.file.id)
    || !['JPEG', 'RAW'].includes(String(responsePayload.file.fileRole))
    || !isNonEmptyString(responsePayload.file.fileFormat)
    || !isNonEmptyString(responsePayload.file.originalFilename)
    || !isNonEmptyString(responsePayload.file.mimeType)
    || !isNonNegativeSafeInteger(responsePayload.file.fileSize)
    || !isNonEmptyString(responsePayload.file.fileUrl)
    || typeof responsePayload.reused !== 'boolean'
  ) {
    malformedUploadResponse(`${kind} upload returned an incomplete response`)
  }

  if (kind === 'group' && typeof responsePayload.galleryReady !== 'boolean') {
    malformedUploadResponse('Group upload returned an incomplete response')
  }

  return {
    captureId: responsePayload.captureId,
    captureKey: responsePayload.captureKey,
    pairingStatus: String(responsePayload.pairingStatus),
    file: responsePayload.file,
    reused: responsePayload.reused,
    galleryReady: responsePayload.galleryReady,
    r2Upload,
  }
}

export async function parseUploadResponse(
  response: Response,
  kind: UploadResponseKind,
): Promise<ReturnType<typeof parseUploadResponseJson>> {
  try {
    return parseUploadResponseJson(await response.json(), kind)
  } catch (error) {
    if (error instanceof RetryableUploadError) throw error
    throw new RetryableUploadError(`${kind} upload returned an invalid response; retrying safely.`)
  }
}

export function assertR2VerifierResponse(responsePayload: unknown, expectedCopyId: number): void {
  const copy = isJsonObject(responsePayload) ? responsePayload.copy : undefined
  if (!isJsonObject(copy)
    || copy.id !== expectedCopyId
    || copy.destination !== 'r2'
    || copy.state !== 'ready'
    || !isNonEmptyString(copy.objectKey)
  ) {
    throw new RetryableUploadError('R2 verification returned an incomplete or non-ready copy; retrying safely.')
  }
}