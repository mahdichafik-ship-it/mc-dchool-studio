import {
  db,
  groupCaptureFilesTable,
  groupCapturesTable,
  groupMembersTable,
  groupsTable,
  studentPhotosTable,
  studentsTable,
} from "@workspace/db";
import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";

type GroupCapture = typeof groupCapturesTable.$inferSelect;
type GroupCaptureFile = typeof groupCaptureFilesTable.$inferSelect;

async function photographedStudentIdsForGroup(capture: GroupCapture): Promise<number[]> {
  const [group] = await db.select().from(groupsTable)
    .where(eq(groupsTable.id, capture.groupId)).limit(1);
  if (!group) return [];

  if (group.isDefaultClassGroup && group.classId !== null) {
    const rows = await db.selectDistinct({ studentId: studentsTable.id })
      .from(studentsTable)
      .innerJoin(studentPhotosTable, and(
        eq(studentPhotosTable.studentId, studentsTable.id),
        isNull(studentPhotosTable.sourceGroupCaptureFileId),
        isNotNull(studentPhotosTable.durableObjectPath),
      ))
      .where(and(
        eq(studentsTable.projectId, capture.projectId),
        eq(studentsTable.classId, group.classId),
      ));
    return rows.map((row) => row.studentId);
  }

  const rows = await db.selectDistinct({ studentId: groupMembersTable.studentId })
    .from(groupMembersTable)
    .innerJoin(studentPhotosTable, and(
      eq(studentPhotosTable.studentId, groupMembersTable.studentId),
      isNull(studentPhotosTable.sourceGroupCaptureFileId),
      isNotNull(studentPhotosTable.durableObjectPath),
    ))
    .where(eq(groupMembersTable.groupId, capture.groupId));
  return rows.map((row) => row.studentId);
}

export async function projectGroupJpegToPhotographedStudents(
  capture: GroupCapture,
  file: GroupCaptureFile,
): Promise<number> {
  if (file.fileRole !== "JPEG" || !file.durableObjectPath) return 0;
  const studentIds = await photographedStudentIdsForGroup(capture);
  if (studentIds.length === 0) return 0;

  await db.insert(studentPhotosTable).values(studentIds.map((studentId) => ({
    projectId: capture.projectId,
    studentId,
    fileName: file.originalFilename,
    fileUrl: file.fileUrl,
    durableObjectPath: file.durableObjectPath,
    mimeType: file.mimeType,
    capturedAt: capture.capturedAt,
    captureBatchId: file.captureBatchId,
    sourceGroupCaptureFileId: file.id,
  }))).onConflictDoNothing();
  return studentIds.length;
}

export async function materializeGroupJpegsForDelivery(projectId: number): Promise<number> {
  const rows = await db.select({
    capture: groupCapturesTable,
    file: groupCaptureFilesTable,
  }).from(groupCapturesTable)
    .innerJoin(groupCaptureFilesTable, and(
      eq(groupCaptureFilesTable.captureId, groupCapturesTable.id),
      eq(groupCaptureFilesTable.fileRole, "JPEG"),
      isNotNull(groupCaptureFilesTable.durableObjectPath),
    ))
    .where(eq(groupCapturesTable.projectId, projectId));

  let projected = 0;
  for (const row of rows) {
    projected += await projectGroupJpegToPhotographedStudents(row.capture, row.file);
  }
  return projected;
}

export async function projectAvailableGroupJpegsToStudent(
  projectId: number,
  studentId: number,
): Promise<number> {
  const [student] = await db.select().from(studentsTable)
    .where(and(eq(studentsTable.id, studentId), eq(studentsTable.projectId, projectId))).limit(1);
  if (!student) return 0;

  const defaultGroups = await db.select({ id: groupsTable.id }).from(groupsTable)
    .where(and(
      eq(groupsTable.projectId, projectId),
      eq(groupsTable.classId, student.classId),
      eq(groupsTable.isDefaultClassGroup, true),
    ));
  const memberGroups = await db.select({ id: groupMembersTable.groupId }).from(groupMembersTable)
    .innerJoin(groupsTable, and(
      eq(groupsTable.id, groupMembersTable.groupId),
      eq(groupsTable.projectId, projectId),
    ))
    .where(eq(groupMembersTable.studentId, studentId));
  const groupIds = [...new Set([...defaultGroups, ...memberGroups].map((row) => row.id))];
  if (groupIds.length === 0) return 0;

  const rows = await db.select({
    capture: groupCapturesTable,
    file: groupCaptureFilesTable,
  }).from(groupCapturesTable)
    .innerJoin(groupCaptureFilesTable, and(
      eq(groupCaptureFilesTable.captureId, groupCapturesTable.id),
      eq(groupCaptureFilesTable.fileRole, "JPEG"),
      isNotNull(groupCaptureFilesTable.durableObjectPath),
    ))
    .where(and(
      eq(groupCapturesTable.projectId, projectId),
      inArray(groupCapturesTable.groupId, groupIds),
    ));

  for (const { capture, file } of rows) {
    await db.insert(studentPhotosTable).values({
      projectId,
      studentId,
      fileName: file.originalFilename,
      fileUrl: file.fileUrl,
      durableObjectPath: file.durableObjectPath,
      mimeType: file.mimeType,
      capturedAt: capture.capturedAt,
      captureBatchId: file.captureBatchId,
      sourceGroupCaptureFileId: file.id,
    }).onConflictDoNothing();
  }
  return rows.length;
}