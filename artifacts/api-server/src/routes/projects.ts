import { Router } from "express";
import { db } from "@workspace/db";
import { projectsTable, classesTable, studentsTable } from "@workspace/db";
import { eq, count, and } from "drizzle-orm";
import { requireAuth, getUserId } from "../lib/auth";

const router = Router();

// GET /api/projects
router.get("/", requireAuth, async (req, res) => {
  const userId = getUserId(req);

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
    .where(eq(projectsTable.userId, userId))
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
router.get("/:projectId", requireAuth, async (req, res) => {
  const userId = getUserId(req);
  const projectId = parseInt(req.params.projectId as string);

  const [project] = await db
    .select()
    .from(projectsTable)
    .where(and(eq(projectsTable.id, projectId), eq(projectsTable.userId, userId)));

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

  const [existing] = await db
    .select()
    .from(projectsTable)
    .where(and(eq(projectsTable.id, projectId), eq(projectsTable.userId, userId)));

  if (!existing) {
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
    .where(and(eq(projectsTable.id, projectId), eq(projectsTable.userId, userId)))
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

  const [existing] = await db
    .select()
    .from(projectsTable)
    .where(and(eq(projectsTable.id, projectId), eq(projectsTable.userId, userId)));

  if (!existing) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  await db
    .delete(projectsTable)
    .where(and(eq(projectsTable.id, projectId), eq(projectsTable.userId, userId)));

  res.status(204).send();
});

export default router;
