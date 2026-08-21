/**
 * Desktop-facing API routes — authenticated with PHOTO_UPLOAD_KEY (no Clerk).
 * Used by the Electron app to list and pull cloud projects without a JSON file.
 */

import { Router } from "express";
import { db } from "@workspace/db";
import { projectsTable, classesTable, studentsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import type { Request, Response, NextFunction } from "express";

const router = Router();

function requireUploadKey(req: Request, res: Response, next: NextFunction): void {
  const uploadKey = process.env.PHOTO_UPLOAD_KEY;
  if (!uploadKey) {
    res.status(503).json({ error: "Cloud upload not configured on server (PHOTO_UPLOAD_KEY missing)" });
    return;
  }
  const authHeader = req.headers.authorization;
  const provided = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!provided || provided !== uploadKey) {
    res.status(401).json({ error: "Invalid upload key" });
    return;
  }
  next();
}

// GET /api/desktop/projects — list all projects (summary)
router.get("/projects", requireUploadKey, async (_req, res) => {
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
router.get("/projects/:projectId/bundle", requireUploadKey, async (req, res) => {
  const rawProjectId = Array.isArray(req.params.projectId) ? req.params.projectId[0] : req.params.projectId;
  const projectId = parseInt(rawProjectId, 10);
  if (isNaN(projectId)) {
    res.status(400).json({ error: "Invalid project ID" });
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
