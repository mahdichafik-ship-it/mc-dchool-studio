import {
  classesTable,
  db,
  groupMemberExclusionsTable,
  groupMembersTable,
  groupsTable,
  projectsTable,
  studentsTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { generateJsonQr, generateSimpleQr } from "./qrcode";
import { reconcileDefaultGroups } from "./groupReconciliation";

export async function renameProjectClass(projectId: number, classId: number, className: string) {
  const [project] = await db.select().from(projectsTable).where(eq(projectsTable.id, projectId)).limit(1);
  const [cls] = await db.select().from(classesTable).where(and(
    eq(classesTable.id, classId),
    eq(classesTable.projectId, projectId),
  )).limit(1);
  if (!project || !cls) return null;

  const students = await db.select().from(studentsTable).where(and(
    eq(studentsTable.projectId, projectId),
    eq(studentsTable.classId, classId),
  ));
  const qrUpdates = await Promise.all(students.map(async (student) => ({
    id: student.id,
    jsonQr: await generateJsonQr(
      project.schoolName,
      className,
      student.firstName,
      student.lastName,
      student.generatedStudentId,
    ),
  })));
  const updatedAt = new Date();
  const [updated] = await db.transaction(async (tx) => {
    const [renamed] = await tx.update(classesTable)
      .set({ className, updatedAt })
      .where(and(eq(classesTable.id, classId), eq(classesTable.projectId, projectId)))
      .returning();
    if (!renamed) return [undefined] as const;
    for (const item of qrUpdates) {
      await tx.update(studentsTable).set({ jsonQr: item.jsonQr, updatedAt })
        .where(and(eq(studentsTable.id, item.id), eq(studentsTable.projectId, projectId)));
    }
    await tx.update(groupsTable)
      .set({ name: className, updatedAt })
      .where(and(
        eq(groupsTable.projectId, projectId),
        eq(groupsTable.classId, classId),
        eq(groupsTable.isDefaultClassGroup, true),
      ));
    await tx.update(projectsTable).set({ updatedAt }).where(eq(projectsTable.id, projectId));
    return [renamed] as const;
  });
  if (!updated) return null;
  await reconcileDefaultGroups(projectId);
  return updated;
}

export async function moveProjectStudent(projectId: number, studentId: number, classId: number) {
  const [project] = await db.select().from(projectsTable).where(eq(projectsTable.id, projectId)).limit(1);
  const [student] = await db.select().from(studentsTable).where(and(
    eq(studentsTable.id, studentId),
    eq(studentsTable.projectId, projectId),
  )).limit(1);
  const [destination] = await db.select().from(classesTable).where(and(
    eq(classesTable.id, classId),
    eq(classesTable.projectId, projectId),
  )).limit(1);
  if (!project || !student || !destination) return null;
  if (student.classId === destination.id) return { student, className: destination.className };

  const [simpleQr, jsonQr] = await Promise.all([
    generateSimpleQr(student.firstName, student.lastName, student.generatedStudentId),
    generateJsonQr(
      project.schoolName,
      destination.className,
      student.firstName,
      student.lastName,
      student.generatedStudentId,
    ),
  ]);
  const updatedAt = new Date();
  const [updated] = await db.transaction(async (tx) => {
    const [current] = await tx.select().from(studentsTable).where(and(
      eq(studentsTable.id, studentId),
      eq(studentsTable.projectId, projectId),
    )).for("update").limit(1);
    if (!current) return [undefined] as const;
    const previousClassId = current.classId;
    const [moved] = await tx.update(studentsTable)
      .set({ classId: destination.id, simpleQr, jsonQr, updatedAt })
      .where(and(eq(studentsTable.id, studentId), eq(studentsTable.projectId, projectId)))
      .returning();
    const [previousDefaultGroup] = await tx.select({ id: groupsTable.id })
      .from(groupsTable)
      .where(and(
        eq(groupsTable.projectId, projectId),
        eq(groupsTable.classId, previousClassId),
        eq(groupsTable.isDefaultClassGroup, true),
      )).limit(1);
    if (previousDefaultGroup) {
      await tx.delete(groupMembersTable).where(and(
        eq(groupMembersTable.groupId, previousDefaultGroup.id),
        eq(groupMembersTable.studentId, studentId),
      ));
    }
    const [nextDefaultGroup] = await tx.select({ id: groupsTable.id })
      .from(groupsTable)
      .where(and(
        eq(groupsTable.projectId, projectId),
        eq(groupsTable.classId, destination.id),
        eq(groupsTable.isDefaultClassGroup, true),
      )).limit(1);
    if (nextDefaultGroup) {
      const [exclusion] = await tx.select({ groupId: groupMemberExclusionsTable.groupId })
        .from(groupMemberExclusionsTable)
        .where(and(
          eq(groupMemberExclusionsTable.groupId, nextDefaultGroup.id),
          eq(groupMemberExclusionsTable.studentId, studentId),
        )).limit(1);
      if (!exclusion) {
        await tx.insert(groupMembersTable)
          .values({ groupId: nextDefaultGroup.id, studentId })
          .onConflictDoNothing();
      }
    }
    return [moved] as const;
  });
  if (!updated) return null;
  await reconcileDefaultGroups(projectId);
  return { student: updated, className: destination.className };
}
