import { extname } from 'node:path'

function safeFileSegment(value: string, fallback: string): string {
  return value
    .normalize('NFKC')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[.\s_-]+|[.\s_-]+$/g, '')
    .slice(0, 60) || fallback
}

export interface LightroomFilenameInput {
  schoolName: string
  className: string | null
  student: {
    firstName: string
    lastName: string
    generatedStudentId: string
  } | null
  captureId: number
  sequence: number | null
  originalFilename: string
  fileRole: 'JPEG' | 'RAW'
  fileFormat: string
}

/**
 * Lightroom Classic auto-import watches one flat incoming folder. A stable,
 * descriptive stem keeps JPEG/RAW pairs together and makes repeated exports
 * idempotent without changing the managed originals.
 */
export function buildLightroomFilename(input: LightroomFilenameInput): string {
  const extension = extname(input.originalFilename)
    || (input.fileRole === 'JPEG' ? '.jpg' : `.${input.fileFormat.toLowerCase()}`)
  const student = input.student
    ? [
        safeFileSegment(input.student.lastName, 'Student'),
        safeFileSegment(input.student.firstName, 'Unknown'),
        safeFileSegment(input.student.generatedStudentId, 'No-ID'),
      ].join('_')
    : 'Unmatched'
  const sequence = String(input.sequence ?? input.captureId).padStart(6, '0')

  return [
    safeFileSegment(input.schoolName, 'School'),
    safeFileSegment(input.className ?? 'Unassigned', 'Unassigned'),
    student,
    sequence,
    `capture-${input.captureId}`,
  ].join('_') + extension
}