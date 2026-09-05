import { strict as assert } from 'node:assert'
import test from 'node:test'
import { buildLightroomFilename } from '../src/main/lib/lightroomExport.ts'

test('builds stable Lightroom filenames that keep JPEG and RAW pairs together', () => {
  const base = {
    schoolName: 'North: Shore School',
    className: 'Grade 3 / Blue',
    student: {
      firstName: 'Ana María',
      lastName: 'Olsen',
      generatedStudentId: 'NS-0042',
    },
    captureId: 81,
    sequence: 7,
  }

  const jpeg = buildLightroomFilename({
    ...base,
    originalFilename: 'IMG_1001.JPG',
    fileRole: 'JPEG',
    fileFormat: 'JPG',
  })
  const raw = buildLightroomFilename({
    ...base,
    originalFilename: 'IMG_1001.CR3',
    fileRole: 'RAW',
    fileFormat: 'CR3',
  })

  assert.equal(jpeg, 'North-_Shore_School_Grade_3_-_Blue_Olsen_Ana_María_NS-0042_000007_capture-81.JPG')
  assert.equal(raw.replace(/\.CR3$/, ''), jpeg.replace(/\.JPG$/, ''))
})

test('labels unmatched captures without exposing unsafe path characters', () => {
  const filename = buildLightroomFilename({
    schoolName: '../School',
    className: null,
    student: null,
    captureId: 12,
    sequence: null,
    originalFilename: 'capture.nef',
    fileRole: 'RAW',
    fileFormat: 'NEF',
  })

  assert.equal(filename, 'School_Unassigned_Unmatched_000012_capture-12.nef')
  assert.doesNotMatch(filename, /[/:\\]/)
})