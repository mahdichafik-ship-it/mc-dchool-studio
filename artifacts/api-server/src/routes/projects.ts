import { Router } from "express";
import { db } from "@workspace/db";
import {
  captureBatchesTable,
  captureFilesTable,
  capturesTable,
  classesTable,
  desktopConnectionsTable,
  projectAssignmentsTable,
  projectsTable,
  studentPhotosTable,
  studentsTable,
  studioMembersTable,
} from "@workspace/db";
import { and, eq, count, inArray, isNull } from "drizzle-orm";
import { requireAuth, getUserId } from "../lib/auth";
import { accessibleProjectIds, canAccessProject, getStudioMember, isStudioManager } from "../lib/studioAccess";

const router = Router();

// GET /api/projects
router.get("/", requireAuth, async (req, res) => {
  const userId = getUserId(req);
  const ids = await accessibleProjectIds(userId);
  if (!ids.length) { res.json([]); return; }

  const projects = await db
    .select({
      id: projectsTable.id,
      schoolName: projectsTable.schoolName,
      photoDate: projectsTable.photoDate,
      address: projectsTable.address,
      contactName: projectsTable.contactName,
      contactEmail: projectsTable.contactEmail,
      contactPhone: projectsTable.contactPhone,
      notes: projectsTable.notes,
      createdAt: projectsTable.createdAt,
      updatedAt: projectsTable.updatedAt,
    })
    .from(projectsTable)
    .where(inArray(projectsTable.id, ids))
    .orderBy(projectsTable.updatedAt);

  // Enrich with counts
  const result = await Promise.all(
    projects.map(async (p) => {
      const [{ classCount }] = await db
        .select({ classCount: count() })
        .from(classesTable)
        .where(eq(classesTable.projectId, p.id));
      const [{ studentCount }] = await db
        .select({ studentCount: count() })
        .from(studentsTable)
        .where(eq(studentsTable.projectId, p.id));
      return {
        ...p,
        classCount,
        studentCount,
        createdAt: p.createdAt.toISOString(),
        updatedAt: p.updatedAt.toISOString(),
      };
    }),
  );

  // Sort by updatedAt descending (most recent first)
  result.sort(
    (a, b) =>
      new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
  );

  res.json(result);
});

// POST /api/projects
router.post("/", requireAuth, async (req, res) => {
  const userId = getUserId(req);
  const member = await getStudioMember(userId);
  if (member.status !== "active" || !["owner", "admin", "assistant"].includes(member.role)) { res.status(403).json({ error: "You do not have permission to create projects" }); return; }
  const { schoolName, photoDate, address, contactName, contactEmail, contactPhone, notes } =
    req.body;

  if (!schoolName) {
    res.status(400).json({ error: "schoolName is required" });
    return;
  }

  const [project] = await db
    .insert(projectsTable)
    .values({
      userId,
      studioId: member.studioId,
      schoolName,
      photoDate: photoDate ?? null,
      address: address ?? null,
      contactName: contactName ?? null,
      contactEmail: contactEmail ?? null,
      contactPhone: contactPhone ?? null,
      notes: notes ?? null,
    })
    .returning();

  res.status(201).json({
    ...project,
    classCount: 0,
    studentCount: 0,
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString(),
  });
});

// GET /api/projects/:projectId
router.get("/:projectId/collaboration", requireAuth, async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const projectId = Number(req.params.projectId);
  if (!Number.isInteger(projectId) || !(await canAccessProject(userId, projectId, "view"))) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const [
    [{ studentCount }],
    assignmentRows,
    batchRows,
    captureRows,
    legacyPhotoRows,
    unbatchedCaptureFiles,
    unbatchedLegacyPhotos,
  ] = await Promise.all([
    db.select({ studentCount: count() }).from(studentsTable).where(eq(studentsTable.projectId, projectId)),
    db
      .select({
        memberId: studioMembersTable.id,
        displayName: studioMembersTable.displayName,
        email: studioMembersTable.email,
        role: studioMembersTable.role,
        status: studioMembersTable.status,
      })
      .from(projectAssignmentsTable)
      .innerJoin(studioMembersTable, eq(projectAssignmentsTable.memberId, studioMembersTable.id))
      .where(eq(projectAssignmentsTable.projectId, projectId)),
    db
      .select({
        id: captureBatchesTable.id,
        batchKey: captureBatchesTable.batchKey,
        memberId: captureBatchesTable.memberId,
        displayName: studioMembersTable.displayName,
        email: studioMembersTable.email,
        role: studioMembersTable.role,
        deviceName: desktopConnectionsTable.deviceName,
        status: captureBatchesTable.status,
        expectedFileCount: captureBatchesTable.expectedFileCount,
        uploadedFileCount: captureBatchesTable.uploadedFileCount,
        failedFileCount: captureBatchesTable.failedFileCount,
        startedAt: captureBatchesTable.startedAt,
        lastSyncAt: captureBatchesTable.lastSyncAt,
        completedAt: captureBatchesTable.completedAt,
      })
      .from(captureBatchesTable)
      .innerJoin(studioMembersTable, eq(captureBatchesTable.memberId, studioMembersTable.id))
      .innerJoin(desktopConnectionsTable, eq(captureBatchesTable.desktopConnectionId, desktopConnectionsTable.id))
      .where(eq(captureBatchesTable.projectId, projectId)),
    db
      .select({
        id: capturesTable.id,
        studentId: capturesTable.studentId,
        pairingStatus: capturesTable.pairingStatus,
      })
      .from(capturesTable)
      .where(eq(capturesTable.projectId, projectId)),
    db
      .select({ studentId: studentPhotosTable.studentId })
      .from(studentPhotosTable)
      .where(eq(studentPhotosTable.projectId, projectId)),
    db
      .select({ count: count() })
      .from(captureFilesTable)
      .innerJoin(capturesTable, eq(captureFilesTable.captureId, capturesTable.id))
      .where(and(eq(capturesTable.projectId, projectId), isNull(captureFilesTable.captureBatchId))),
    db
      .select({ count: count() })
      .from(studentPhotosTable)
      .where(and(eq(studentPhotosTable.projectId, projectId), isNull(studentPhotosTable.captureBatchId))),
  ]);

  const studentCaptureCounts = new Map<number, number>();
  const photographedStudentIds = new Set<number>();
  const pairing = { complete: 0, jpegOnly: 0, rawOnly: 0, pending: 0 };
  for (const capture of captureRows) {
    photographedStudentIds.add(capture.studentId);
    studentCaptureCounts.set(capture.studentId, (studentCaptureCounts.get(capture.studentId) ?? 0) + 1);
    if (capture.pairingStatus === "complete") pairing.complete++;
    else if (capture.pairingStatus === "jpeg_only") pairing.jpegOnly++;
    else if (capture.pairingStatus === "raw_only") pairing.rawOnly++;
    else pairing.pending++;
  }
  for (const photo of legacyPhotoRows) photographedStudentIds.add(photo.studentId);

  const duplicateStudentCount = [...studentCaptureCounts.values()].filter((value) => value > 1).length;
  const expectedStudents = Number(studentCount);
  const photographedStudents = photographedStudentIds.size;
  const missingStudents = Math.max(0, expectedStudents - photographedStudents);
  const allBatchesComplete = batchRows.length > 0 && batchRows.every((batch) => batch.status === "complete");
  const failedFiles = batchRows.reduce((sum, batch) => sum + batch.failedFileCount, 0);
  const unbatchedFiles = Number(unbatchedCaptureFiles[0]?.count ?? 0) + Number(unbatchedLegacyPhotos[0]?.count ?? 0);

  res.json({
    summary: {
      expectedStudents,
      photographedStudents,
      completionPercent: expectedStudents === 0 ? 0 : Math.round((photographedStudents / expectedStudents) * 100),
      missingStudents,
      totalCaptures: captureRows.length,
      duplicateStudentCount,
      failedFiles,
      unbatchedFiles,
      pairing,
    },
    assignments: assignmentRows.map((assignment) => ({
      ...assignment,
      batchCount: batchRows.filter((batch) => batch.memberId === assignment.memberId).length,
      latestBatchStatus: batchRows
        .filter((batch) => batch.memberId === assignment.memberId)
        .sort((a, b) => b.lastSyncAt.getTime() - a.lastSyncAt.getTime())[0]?.status ?? "not_started",
    })),
    batches: batchRows
      .sort((a, b) => b.lastSyncAt.getTime() - a.lastSyncAt.getTime())
      .map((batch) => ({
        ...batch,
        startedAt: batch.startedAt.toISOString(),
        lastSyncAt: batch.lastSyncAt.toISOString(),
        completedAt: batch.completedAt?.toISOString() ?? null,
      })),
    completionGate: {
      ready: allBatchesComplete
        && failedFiles === 0
        && duplicateStudentCount === 0
        && pairing.jpegOnly === 0
        && pairing.rawOnly === 0
        && missingStudents === 0,
      allBatchesComplete,
      failedUploadsResolved: failedFiles === 0,
      duplicatesReviewed: duplicateStudentCount === 0,
      pairsComplete: pairing.jpegOnly === 0 && pairing.rawOnly === 0,
      missingStudentsAcknowledged: missingStudents === 0,
    },
  });
});

router.get("/:projectId", requireAuth, async (req, res) => {
  const userId = getUserId(req);
  const projectId = parseInt(req.params.projectId as string);

  if (!(await canAccessProject(userId, projectId, "view"))) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const [project] = await db.select().from(projectsTable).where(eq(projectsTable.id, projectId));

  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const [{ classCount }] = await db
    .select({ classCount: count() })
    .from(classesTable)
    .where(eq(classesTable.projectId, projectId));
  const [{ studentCount }] = await db
    .select({ studentCount: count() })
    .from(studentsTable)
    .where(eq(studentsTable.projectId, projectId));

  res.json({
    ...project,
    classCount,
    studentCount,
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString(),
  });
});

// PATCH /api/projects/:projectId
router.patch("/:projectId", requireAuth, async (req, res) => {
  const userId = getUserId(req);
  const projectId = parseInt(req.params.projectId as string);

  if (!(await canAccessProject(userId, projectId, "edit"))) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const { schoolName, photoDate, address, contactName, contactEmail, contactPhone, notes } =
    req.body;

  const [updated] = await db
    .update(projectsTable)
    .set({
      ...(schoolName !== undefined && { schoolName }),
      ...(photoDate !== undefined && { photoDate }),
      ...(address !== undefined && { address }),
      ...(contactName !== undefined && { contactName }),
      ...(contactEmail !== undefined && { contactEmail }),
      ...(contactPhone !== undefined && { contactPhone }),
      ...(notes !== undefined && { notes }),
      updatedAt: new Date(),
    })
    .where(eq(projectsTable.id, projectId))
    .returning();

  const [{ classCount }] = await db
    .select({ classCount: count() })
    .from(classesTable)
    .where(eq(classesTable.projectId, projectId));
  const [{ studentCount }] = await db
    .select({ studentCount: count() })
    .from(studentsTable)
    .where(eq(studentsTable.projectId, projectId));

  res.json({
    ...updated,
    classCount,
    studentCount,
    createdAt: updated.createdAt.toISOString(),
    updatedAt: updated.updatedAt.toISOString(),
  });
});

// DELETE /api/projects/:projectId
router.delete("/:projectId", requireAuth, async (req, res) => {
  const userId = getUserId(req);
  const projectId = parseInt(req.params.projectId as string);

  if (!(await canAccessProject(userId, projectId, "manage"))) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  await db
    .delete(projectsTable)
    .where(eq(projectsTable.id, projectId));

  res.status(204).send();
});

export default router;
