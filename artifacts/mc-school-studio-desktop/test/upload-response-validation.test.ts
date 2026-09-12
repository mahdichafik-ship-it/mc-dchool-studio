import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assertR2VerifierResponse,
  parseUploadResponse,
  parseUploadResponseJson,
  RetryableUploadError,
} from '../src/main/lib/uploadResponseValidation.ts'

const hash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

function corePayload(kind: 'photo' | 'capture' | 'group'): Record<string, unknown> {
  if (kind === 'photo') return { fileUrl: '/uploads/photo.jpg' }
  return {
    captureId: 1,
    captureKey: 'capture-1',
    pairingStatus: 'complete',
    file: {
      id: 2,
      fileRole: 'JPEG',
      fileFormat: 'JPG',
      originalFilename: 'photo.jpg',
      mimeType: 'image/jpeg',
      fileSize: 1,
      fileUrl: '/uploads/photo.jpg',
    },
    reused: false,
    ...(kind === 'group' ? { galleryReady: true } : {}),
  }
}

function validR2Session() {
  return {
    copyId: 7,
    objectKey: 'staging/photo.jpg',
    uploadUrl: 'https://r2.example.test/upload',
    uploadMethod: 'PUT',
    uploadHeaders: {
      'x-amz-meta-sha256': hash,
      'Content-Type': 'image/jpeg',
    },
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    alreadyVerified: false,
  }
}

for (const kind of ['photo', 'capture', 'group'] as const) {
  test(`${kind} rejects an empty successful response`, () => {
    assert.throws(
      () => parseUploadResponseJson({}, kind),
      RetryableUploadError,
    )
  })

  test(`${kind} rejects malformed JSON from a successful response`, async () => {
    await assert.rejects(
      parseUploadResponse(new Response('{'), kind),
      RetryableUploadError,
    )
  })

  test(`${kind} rejects malformed r2Upload`, () => {
    assert.throws(
      () => parseUploadResponseJson({ ...corePayload(kind), r2Upload: {} }, kind),
      RetryableUploadError,
    )
  })

  test(`${kind} accepts a structurally valid legacy response`, () => {
    assert.doesNotThrow(() => parseUploadResponseJson(corePayload(kind), kind))
  })
}

test('R2 verification rejects a successful non-ready verifier response', () => {
  const session = validR2Session()
  assert.throws(
    () => assertR2VerifierResponse({
      copy: {
        id: session.copyId,
        destination: 'r2',
        state: 'uploading',
        objectKey: 'photos/final.jpg',
      },
    }, session.copyId),
    RetryableUploadError,
  )
})