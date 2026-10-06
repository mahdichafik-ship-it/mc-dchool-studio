type PortraitReviewRow = {
  id: number
  projectId: number
  studentId: number | null
  groupId: string | null
  rating: number
}

type GroupReviewRow = {
  id: number
  projectId: number
  groupId: number
  rating: number
}

/**
 * Returns the existing portrait winners that must be cleared when `target`
 * becomes the new five-star winner. Group-linked compatibility captures are
 * intentionally excluded from this per-student scope.
 */
export function portraitFiveStarReplacementIds(
  rows: readonly PortraitReviewRow[],
  target: Pick<PortraitReviewRow, 'id' | 'projectId' | 'studentId' | 'rating'>,
): number[] {
  if (target.studentId === null || target.rating !== 5) return []
  return rows
    .filter((row) => row.id !== target.id
      && row.projectId === target.projectId
      && row.studentId === target.studentId
      && row.groupId === null
      && row.rating === 5)
    .map((row) => row.id)
}

/**
 * Returns the existing group winners that must be cleared when `target`
 * becomes the new five-star winner.
 */
export function groupFiveStarReplacementIds(
  rows: readonly GroupReviewRow[],
  target: Pick<GroupReviewRow, 'id' | 'projectId' | 'groupId' | 'rating'>,
): number[] {
  if (target.rating !== 5) return []
  return rows
    .filter((row) => row.id !== target.id
      && row.projectId === target.projectId
      && row.groupId === target.groupId
      && row.rating === 5)
    .map((row) => row.id)
}