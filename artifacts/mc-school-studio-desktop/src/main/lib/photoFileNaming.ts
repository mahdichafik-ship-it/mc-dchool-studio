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
    return new RegExp(`(?:^|[-_])${escapeRegExp(id)}$`).test(stem)
  })
  return matches.sort((a, b) => b.length - a.length)[0] ?? null
}