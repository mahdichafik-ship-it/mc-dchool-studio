import { basename, extname } from 'node:path'

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Extract the student reference from a Smart Shooter filename.
 *
 * Smart Shooter is configured to produce names such as:
 * Smith_John_class_school-001234.jpg
 *
 * Matching is against the known project IDs, rather than guessing a fixed
 * number of digits, so IDs remain safe if the project format changes.
 */
export function extractStudentReference(fileName: string, studentIds: string[]): string | null {
  const stem = basename(fileName, extname(fileName))
  const matches = studentIds.filter((id) => {
    if (!id) return false
    // Smart Shooter can append its numeric frame counter after the barcode
    // value (for example: Student_AB12_595.JPG). Only accept that known,
    // numeric suffix so arbitrary trailing text cannot turn into a match.
    return new RegExp(`(?:^|[-_])${escapeRegExp(id)}(?:[-_]\\d+)?$`, 'i').test(stem)
  })
  return matches.sort((a, b) => b.length - a.length)[0] ?? null
}

export function formatStudentFolderName(
  firstName: string,
  lastName: string,
  studentId: string,
): string {
  return `${firstName}_${lastName}_${studentId}`
}

export function formatStudentPhotoName(
  firstName: string,
  lastName: string,
  studentId: string,
  sourceFileName: string,
): string {
  return `${formatStudentFolderName(firstName, lastName, studentId)}${extname(sourceFileName)}`
}