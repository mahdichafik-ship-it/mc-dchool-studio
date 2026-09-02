import { strict as assert } from 'node:assert'
import test from 'node:test'
import { mergeMatchedPhoto } from '../src/renderer/src/lib/captureEventReconciliation.ts'

test('keeps the fast local preview when the persisted event omits it', () => {
  const previous = {
    id: -1,
    projectId: 1,
    studentId: 2,
    filePath: '/watch/DSC_0001.jpg',
    fileName: 'DSC_0001.jpg',
    capturedAt: '2026-09-02T07:23:22.000Z',
    isMatched: true,
    thumbnailData: null,
    createdAt: '2026-09-02T07:23:22.000Z',
    previewKey: 'capture-123-0',
    previewUrl: 'mc-preview://capture-123-0',
  }
  const merged = mergeMatchedPhoto(previous, {
    photo: {
      ...previous,
      id: 42,
      filePath: '/managed/Student/DSC_0001.jpg',
      previewKey: undefined,
      previewUrl: undefined,
    },
    student: {
      id: 2,
      projectId: 1,
      classId: 3,
      className: 'Class 3',
      firstName: 'Dina',
      lastName: 'Zaki',
      generatedStudentId: 'AB12',
      simpleQr: null,
      jsonQr: null,
      photoCount: 1,
      createdAt: previous.createdAt,
      updatedAt: previous.createdAt,
    },
    captureId: 7,
    previewKey: 'capture-123-0',
  })

  assert.equal(merged.id, 42)
  assert.equal(merged.filePath, '/managed/Student/DSC_0001.jpg')
  assert.equal(merged.previewKey, 'capture-123-0')
  assert.equal(merged.previewUrl, 'mc-preview://capture-123-0')
})