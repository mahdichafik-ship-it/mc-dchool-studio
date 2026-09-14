export interface RosterShortcutStudent {
  id: number
  photoCount: number
}

export type RosterShortcutAction<T extends RosterShortcutStudent> =
  | { type: 'none' }
  | { type: 'focus-search' }
  | { type: 'clear-search' }
  | { type: 'clear-target' }
  | { type: 'select-student'; student: T }

interface ResolveRosterShortcutOptions<T extends RosterShortcutStudent> {
  key: string
  students: T[]
  selectedStudentId: number | null
  activeStudentId: number | null
  hasSearch: boolean
  hasActiveTarget: boolean
  blocked: boolean
}

export function isRosterShortcutEditingTarget(target: {
  tagName?: string
  isContentEditable?: boolean
} | null): boolean {
  const tagName = target?.tagName?.toUpperCase()
  return (
    tagName === 'INPUT' ||
    tagName === 'TEXTAREA' ||
    tagName === 'SELECT' ||
    target?.isContentEditable === true
  )
}

export function resolveRosterShortcut<T extends RosterShortcutStudent>({
  key,
  students,
  selectedStudentId,
  activeStudentId,
  hasSearch,
  hasActiveTarget,
  blocked,
}: ResolveRosterShortcutOptions<T>): RosterShortcutAction<T> {
  if (blocked) return { type: 'none' }
  if (key === '/') return { type: 'focus-search' }

  if (key === 'Escape') {
    if (hasSearch) return { type: 'clear-search' }
    return hasActiveTarget ? { type: 'clear-target' } : { type: 'none' }
  }

  if (students.length === 0) return { type: 'none' }

  const currentId = selectedStudentId ?? activeStudentId
  const currentIndex = currentId === null
    ? -1
    : students.findIndex((student) => student.id === currentId)

  if (key === 'ArrowUp') {
    return {
      type: 'select-student',
      student: students[currentIndex > 0 ? currentIndex - 1 : 0],
    }
  }

  if (key === 'ArrowDown') {
    const nextIndex =
      currentIndex >= 0 && currentIndex < students.length - 1
        ? currentIndex + 1
        : currentIndex >= 0
          ? currentIndex
          : 0
    return { type: 'select-student', student: students[nextIndex] }
  }

  if (key === 'n' || key === 'N') {
    const startIndex = currentIndex >= 0 ? currentIndex + 1 : 0
    const ordered = [...students.slice(startIndex), ...students.slice(0, startIndex)]
    const student = ordered.find((candidate) => candidate.photoCount === 0)
    return student ? { type: 'select-student', student } : { type: 'none' }
  }

  return { type: 'none' }
}