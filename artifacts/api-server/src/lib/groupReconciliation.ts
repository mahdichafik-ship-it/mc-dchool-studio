import { db } from "@workspace/db";
import { classesTable, groupMemberExclusionsTable, groupMembersTable, groupsTable, studentsTable } from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";

/** Idempotently creates class default groups and fills them with current students. */
export async function reconcileDefaultGroups(projectId: number): Promise<void> {
  const classes = await db
    .select({
      id: classesTable.id,
      className: classesTable.className,
    })
    .from(classesTable)
    .where(eq(classesTable.projectId, projectId));
  if (classes.length === 0) return;

  const classIds = classes.map((cls) => cls.id);
  let defaultGroups = await db
    .select({
      id: groupsTable.id,
      classId: groupsTable.classId,
      name: groupsTable.name,
    })
    .from(groupsTable)
    .where(and(
      eq(groupsTable.projectId, projectId),
      eq(groupsTable.isDefaultClassGroup, true),
      inArray(groupsTable.classId, classIds),
    ));
  const groupsByClassId = new Map(defaultGroups.map((group) => [group.classId, group]));

  const missingGroups = classes
    .filter((cls) => !groupsByClassId.has(cls.id))
    .map((cls) => ({
      projectId,
      classId: cls.id,
      name: cls.className,
      isDefaultClassGroup: true,
    }));
  if (missingGroups.length > 0) {
    await db.insert(groupsTable).values(missingGroups).onConflictDoNothing();
  }

  // Re-read once after the bulk insert so a concurrent reconciler's winner is
  // also included in the membership pass.
  defaultGroups = await db
    .select({
      id: groupsTable.id,
      classId: groupsTable.classId,
      name: groupsTable.name,
    })
    .from(groupsTable)
    .where(and(
      eq(groupsTable.projectId, projectId),
      eq(groupsTable.isDefaultClassGroup, true),
      inArray(groupsTable.classId, classIds),
    ));

  const classNameById = new Map(classes.map((cls) => [cls.id, cls.className]));
  // Renames are uncommon. Keep them correct without making the normal bundle
  // path issue one update per class.
  for (const group of defaultGroups) {
    if (group.classId === null) continue;
    const className = classNameById.get(group.classId);
    if (className !== undefined && group.name !== className) {
      await db.update(groupsTable)
        .set({ name: className, updatedAt: new Date() })
        .where(eq(groupsTable.id, group.id));
    }
  }

  const groupIds = defaultGroups.map((group) => group.id);
  if (groupIds.length === 0) return;

  const [students, exclusions] = await Promise.all([
    db
      .select({
        id: studentsTable.id,
        classId: studentsTable.classId,
      })
      .from(studentsTable)
      .where(and(
        eq(studentsTable.projectId, projectId),
        inArray(studentsTable.classId, classIds),
      )),
    db
      .select({
        groupId: groupMemberExclusionsTable.groupId,
        studentId: groupMemberExclusionsTable.studentId,
      })
      .from(groupMemberExclusionsTable)
      .where(inArray(groupMemberExclusionsTable.groupId, groupIds)),
  ]);

  const groupIdByClassId = new Map(defaultGroups.map((group) => [group.classId, group.id]));
  const excluded = new Set(exclusions.map((row) => `${row.groupId}:${row.studentId}`));
  const memberships = students.flatMap((student) => {
    const groupId = groupIdByClassId.get(student.classId);
    if (groupId === undefined || excluded.has(`${groupId}:${student.id}`)) return [];
    return [{ groupId, studentId: student.id }];
  });
  if (memberships.length > 0) {
    await db.insert(groupMembersTable).values(memberships).onConflictDoNothing();
  }
}