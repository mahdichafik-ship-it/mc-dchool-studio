export function getNewDefaultGroupMemberIds(
  existingMemberIds: Iterable<number>,
  rosterSnapshotIds: Iterable<number>,
  currentRosterIds: Iterable<number>,
  hasSnapshot: boolean,
): number[] {
  const existing = new Set(existingMemberIds)
  const snapshot = new Set(rosterSnapshotIds)
  return [...currentRosterIds].filter((studentId) =>
    !existing.has(studentId) && (!hasSnapshot || !snapshot.has(studentId)))
}

export function serializeDefaultGroupRosterSnapshot(studentIds: Iterable<number>): string {
  return [...new Set(studentIds)].join(',')
}