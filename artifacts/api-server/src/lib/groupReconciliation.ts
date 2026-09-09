import { db } from "@workspace/db";
import { classesTable, groupMemberExclusionsTable, groupMembersTable, groupsTable, studentsTable } from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";

/** Idempotently creates class default groups and fills them with current students. */
export async function reconcileDefaultGroups(projectId: number): Promise<void> {
  const classes = await db.select().from(classesTable).where(eq(classesTable.projectId, projectId));
  for (const cls of classes) {
    const [existing] = await db.select().from(groupsTable).where(and(
      eq(groupsTable.projectId, projectId),
      eq(groupsTable.classId, cls.id),
      eq(groupsTable.isDefaultClassGroup, true),
    )).limit(1);
    const [group] = existing
      ? await db.update(groupsTable).set({ name: cls.className, updatedAt: new Date() }).where(eq(groupsTable.id, existing.id)).returning()
      : await db.insert(groupsTable).values({
        projectId, classId: cls.id, name: cls.className, isDefaultClassGroup: true,
      }).returning();
    const students = await db.select({ id: studentsTable.id }).from(studentsTable).where(eq(studentsTable.classId, cls.id));
    const exclusions = await db.select({ studentId: groupMemberExclusionsTable.studentId })
      .from(groupMemberExclusionsTable).where(eq(groupMemberExclusionsTable.groupId, group.id));
    const excluded = new Set(exclusions.map((row) => row.studentId));
    if (students.length) {
      await db.insert(groupMembersTable).values(students.filter((student) => !excluded.has(student.id))
        .map((student) => ({ groupId: group.id, studentId: student.id }))).onConflictDoNothing();
    }
  }
}