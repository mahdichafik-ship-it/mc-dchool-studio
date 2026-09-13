export interface PendingReviewCounts {
  portrait: number
  group: number
}

export function hasPendingReviewSync(counts: PendingReviewCounts): boolean {
  return counts.portrait > 0 || counts.group > 0
}
