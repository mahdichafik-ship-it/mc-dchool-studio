export function selectCaptureRange(
  orderedCaptureIds: number[],
  anchorCaptureId: number | null,
  targetCaptureId: number,
): number[] {
  const targetIndex = orderedCaptureIds.indexOf(targetCaptureId)
  if (targetIndex < 0) return []

  const anchorIndex = anchorCaptureId === null
    ? -1
    : orderedCaptureIds.indexOf(anchorCaptureId)
  if (anchorIndex < 0) return [targetCaptureId]

  const start = Math.min(anchorIndex, targetIndex)
  const end = Math.max(anchorIndex, targetIndex)
  return orderedCaptureIds.slice(start, end + 1)
}

export function captureIdsForDrag(
  selectedCaptureIds: number[],
  draggedCaptureId: number,
): number[] {
  return selectedCaptureIds.includes(draggedCaptureId)
    ? selectedCaptureIds
    : [draggedCaptureId]
}

export function shouldReturnToLatestOnNewCapture(
  previousLatestCaptureId: number | null,
  latestCaptureId: number | null,
): boolean {
  return previousLatestCaptureId !== null
    && latestCaptureId !== null
    && latestCaptureId !== previousLatestCaptureId
}
