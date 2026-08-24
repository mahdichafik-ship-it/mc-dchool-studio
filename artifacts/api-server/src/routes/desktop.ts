/**
 * Desktop-facing API routes — authenticated with a member-scoped connection
 * token (no Clerk).
 * Used by the Electron app to list and pull cloud projects without a JSON file.
 */

import { Router } from "express";
import { db } from "@workspace/db";
import { projectsTable, classesTable, studentsTable } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { getDesktopConnection, requireDesktopConnection } from "../lib/desktopAuth";
import { assignedDesktopProjectIds, canAccessAssignedDesktopProject } from "../lib/studioAccess";

const router = Router();

function memberForAccess(connection: ReturnType<typeof getDesktopConnection>) {
  return {
    id: connection.memberId,
    studioId: connection.studioId,
    role: connection.memberRole,
    status: "active" as const,
  };
}

router.get("/me", requireDesktopConnection, async (req, res) => {
  const connection = getDesktopConnection(req);
  const projectIds = await assignedDesktopProjectIds(memberForAccess(connection));
  res.json({
    connectionId: connection.connectionId,
    deviceName: connection.deviceName,
    member: {
      id: connection.memberId,
      email: connection.memberEmail,
      role: connection.memberRole,
    },
    projectCount: projectIds.length,
  });
});

// GET /api/desktop/projects — list only projects assigned to this connection
router.get("/projects", requireDesktopConnection, async (req, res) => {
  const connection = getDesktopConnection(req);
  const projectIds = await assignedDesktopProjectIds(memberForAccess(connection));
  if (!projectIds.length) {
    res.json([]);
    return;
  }
  const projects = await db
    .select({
      id: projectsTable.id,
      schoolName: projectsTable.schoolName,
      photoDate: projectsTable.photoDate,
      address: projectsTable.address,
      contactName: projectsTable.contactName,
      createdAt: projectsTable.createdAt,
      updatedAt: projectsTable.updatedAt,
    })
    .from(projectsTable)
    .where(inArray(projectsTable.id, projectIds))
    .orderBy(projectsTable.updatedAt);

  // Add class + student counts
  const enriched = await Promise.all(
    projects.map(async (p) => {
      const classes = await db
        .select({ id: classesTable.id })
        .from(classesTable)
        .where(eq(classesTable.projectId, p.id));

      const students = await db
        .select({ id: studentsTable.id })
        .from(studentsTable)
        .where(eq(studentsTable.projectId, p.id));

      return {
        ...p,
        classCount: classes.length,
        studentCount: students.length,
        createdAt: p.createdAt instanceof Date ? p.createdAt.toISOString() : p.createdAt,
        updatedAt: p.updatedAt instanceof Date ? p.updatedAt.toISOString() : p.updatedAt,
      };
    }),
  );

  res.json(enriched);
});

// GET /api/desktop/projects/:projectId/bundle — full export bundle for import
router.get("/projects/:projectId/bundle", requireDesktopConnection, async (req, res) => {
  const connection = getDesktopConnection(req);
  const rawProjectId = Array.isArray(req.params.projectId) ? req.params.projectId[0] : req.params.projectId;
  const projectId = parseInt(rawProjectId, 10);
  if (isNaN(projectId)) {
    res.status(400).json({ error: "Invalid project ID" });
    return;
  }

  if (!(await canAccessAssignedDesktopProject(memberForAccess(connection), projectId))) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const [project] = await db
    .select()
    .from(projectsTable)
    .where(eq(projectsTable.id, projectId));

  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const classes = await db
    .select()
    .from(classesTable)
    .where(eq(classesTable.projectId, projectId))
    .orderBy(classesTable.className);

  const students = await db
    .select({
      student: studentsTable,
      className: classesTable.className,
    })
    .from(studentsTable)
    .leftJoin(classesTable, eq(studentsTable.classId, classesTable.id))
    .where(eq(studentsTable.projectId, projectId))
    .orderBy(classesTable.className, studentsTable.lastName, studentsTable.firstName);

  res.json({
    exportedAt: new Date().toISOString(),
    exportVersion: 1,
    project: {
      id: project.id,
      schoolName: project.schoolName,
      photoDate: project.photoDate,
      address: project.address,
      contactName: project.contactName,
      contactEmail: project.contactEmail,
      contactPhone: project.contactPhone,
      notes: project.notes,
      createdAt: project.createdAt instanceof Date ? project.createdAt.toISOString() : project.createdAt,
      updatedAt: project.updatedAt instanceof Date ? project.updatedAt.toISOString() : project.updatedAt,
    },
    classes: classes.map((c) => ({
      id: c.id,
      className: c.className,
      createdAt: c.createdAt instanceof Date ? c.createdAt.toISOString() : c.createdAt,
      updatedAt: c.updatedAt instanceof Date ? c.updatedAt.toISOString() : c.updatedAt,
    })),
    students: students.map(({ student: s, className }) => ({
      id: s.id,
      classId: s.classId,
      className,
      firstName: s.firstName,
      lastName: s.lastName,
      generatedStudentId: s.generatedStudentId,
      email: s.email ?? null,
      phone: s.phone ?? null,
      simpleQr: s.simpleQr,
      jsonQr: s.jsonQr,
      createdAt: s.createdAt instanceof Date ? s.createdAt.toISOString() : s.createdAt,
      updatedAt: s.updatedAt instanceof Date ? s.updatedAt.toISOString() : s.updatedAt,
    })),
  });
});

export default router;
