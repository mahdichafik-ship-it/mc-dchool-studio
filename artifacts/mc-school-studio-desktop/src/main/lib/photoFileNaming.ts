import { basename, extname } from 'node:path'
import { createHash } from 'node:crypto'

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

function safeManagedNameSegment(value: string, fallback: string): string {
  const cleaned = value
    .normalize('NFKC')
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, ' ')
    .trim()
    .replace(/[\s._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
  const safeValue = cleaned || fallback
  let byteLength = 0
  let result = ''
  for (const character of safeValue) {
    const characterBytes = Buffer.byteLength(character)
    if (byteLength + characterBytes > 80) break
    result += character
    byteLength += characterBytes
  }
  return result.replace(/_+$/g, '') || fallback
}

function groupCaptureToken(sourceFileName: string, sourceFilePath?: string): string {
  const sourceStem = basename(sourceFileName, extname(sourceFileName))
  const frameNumber = sourceStem.match(/(?:^|[-_])(\d{1,12})$/)?.[1]
  const sourceIdentity = (() => {
    if (!sourceFilePath) return sourceStem
    const extensionlessPath = sourceFilePath.slice(0, -extname(sourceFilePath).length)
      .replaceAll('\\', '/')
    const segments = extensionlessPath.split('/')
    const parentIndex = segments.length - 2
    if (parentIndex >= 0 && /^(jpeg|raw)$/i.test(segments[parentIndex])) {
      segments.splice(parentIndex, 1)
    }
    return segments.join('/')
  })()
  const identityToken = createHash('sha256')
    .update(sourceIdentity.toLowerCase())
    .digest('hex')
    .slice(0, 10)
  return frameNumber ? `${frameNumber}_${identityToken}` : identityToken
}

export function formatGroupPhotoName(
  className: string,
  groupName: string,
  sourceFileName: string,
  sourceFilePath?: string,
): string {
  const classSegment = safeManagedNameSegment(className, 'Unassigned_Class')
  const groupSegment = safeManagedNameSegment(groupName, 'Group')
  const label = classSegment.toLowerCase() === groupSegment.toLowerCase()
    ? classSegment
    : `${classSegment}_${groupSegment}`
  return `${label}_${groupCaptureToken(sourceFileName, sourceFilePath)}${extname(sourceFileName)}`
}