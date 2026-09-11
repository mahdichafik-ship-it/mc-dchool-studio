import {
  db,
  groupCaptureFilesTable,
  groupCapturesTable,
  groupMembersTable,
  groupsTable,
  studentPhotosTable,
  studentsTable,
} from "@workspace/db";
import { and, eq, inArray, isNotNull } from "drizzle-orm";

type GroupCapture = typeof groupCapturesTable.$inferSelect;
type GroupCaptureFile = typeof groupCaptureFilesTable.$inferSelect;

async function photographedStudentIdsForGroup(capture: GroupCapture): Promise<number[]> {
  const [group] = await db.select().from(groupsTable)
    .where(eq(groupsTable.id, capture.groupId)).limit(1);
  if (!group) return [];

  const rows = await db.selectDistinct({ studentId: groupMembersTable.studentId })
    .from(groupMembersTable)
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
    rating: capture.rating,
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

  const memberGroups = await db.select({ id: groupMembersTable.groupId }).from(groupMembersTable)
    .innerJoin(groupsTable, and(
      eq(groupsTable.id, groupMembersTable.groupId),
      eq(groupsTable.projectId, projectId),
    ))
    .where(eq(groupMembersTable.studentId, studentId));
  const groupIds = [...new Set(memberGroups.map((row) => row.id))];
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
      rating: capture.rating,
    }).onConflictDoNothing();
  }
  return rows.length;
}