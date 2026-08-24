import { Router } from "express";
import { db } from "@workspace/db";
import { projectsTable, classesTable, studentsTable } from "@workspace/db";
import { eq, and, count } from "drizzle-orm";
import { requireAuth, getUserId } from "../lib/auth";
import { canAccessProject } from "../lib/studioAccess";

const router = Router({ mergeParams: true });

async function verifyProject(projectId: number, userId: string, action: "view" | "edit" = "view"): Promise<boolean> {
  return canAccessProject(userId, projectId, action);
}

// GET /api/projects/:projectId/classes
router.get("/", requireAuth, async (req, res) => {
  const userId = getUserId(req);
  const projectId = parseInt(req.params.projectId as string);

  if (!(await verifyProject(projectId, userId))) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const classes = await db
    .select()
    .from(classesTable)
    .where(eq(classesTable.projectId, projectId))
    .orderBy(classesTable.className);

  const result = await Promise.all(
    classes.map(async (c) => {
      const [{ studentCount }] = await db
        .select({ studentCount: count() })
        .from(studentsTable)
        .where(eq(studentsTable.classId, c.id));
      return {
        ...c,
        studentCount,
        createdAt: c.createdAt.toISOString(),
        updatedAt: c.updatedAt.toISOString(),
      };
    }),
  );

  res.json(result);
});

// POST /api/projects/:projectId/classes
router.post("/", requireAuth, async (req, res) => {
  const userId = getUserId(req);
  const projectId = parseInt(req.params.projectId as string);

  if (!(await verifyProject(projectId, userId, "edit"))) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const { className } = req.body;
  if (!className) {
    res.status(400).json({ error: "className is required" });
    return;
  }

  const [cls] = await db
    .insert(classesTable)
    .values({ projectId, className })
    .returning();

  // Update project updatedAt
  await db
    .update(projectsTable)
    .set({ updatedAt: new Date() })
    .where(eq(projectsTable.id, projectId));

  res.status(201).json({
    ...cls,
    studentCount: 0,
    createdAt: cls.createdAt.toISOString(),
    updatedAt: cls.updatedAt.toISOString(),
  });
});

// PATCH /api/projects/:projectId/classes/:classId
router.patch("/:classId", requireAuth, async (req, res) => {
  const userId = getUserId(req);
  const projectId = parseInt(req.params.projectId as string);
  const classId = parseInt(req.params.classId as string);

  if (!(await verifyProject(projectId, userId, "edit"))) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const { className } = req.body;
  if (!className) {
    res.status(400).json({ error: "className is required" });
    return;
  }

  const [updated] = await db
    .update(classesTable)
    .set({ className, updatedAt: new Date() })
    .where(and(eq(classesTable.id, classId), eq(classesTable.projectId, projectId)))
    .returning();

  if (!updated) {
    res.status(404).json({ error: "Class not found" });
    return;
  }

  const [{ studentCount }] = await db
    .select({ studentCount: count() })
    .from(studentsTable)
    .where(eq(studentsTable.classId, classId));

  res.json({
    ...updated,
    studentCount,
    createdAt: updated.createdAt.toISOString(),
    updatedAt: updated.updatedAt.toISOString(),
  });
});

// DELETE /api/projects/:projectId/classes/:classId
router.delete("/:classId", requireAuth, async (req, res) => {
  const userId = getUserId(req);
  const projectId = parseInt(req.params.projectId as string);
  const classId = parseInt(req.params.classId as string);

  if (!(await verifyProject(projectId, userId, "edit"))) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const [cls] = await db
    .select()
    .from(classesTable)
    .where(and(eq(classesTable.id, classId), eq(classesTable.projectId, projectId)));

  if (!cls) {
    res.status(404).json({ error: "Class not found" });
    return;
  }

  await db
    .delete(classesTable)
    .where(and(eq(classesTable.id, classId), eq(classesTable.projectId, projectId)));

  res.status(204).send();
});

export default router;
