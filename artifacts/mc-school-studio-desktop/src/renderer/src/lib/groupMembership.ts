export function createGroupMemberStudentIdSet(
  memberStudentIds: number[],
): ReadonlySet<number> {
  return new Set(memberStudentIds)
}