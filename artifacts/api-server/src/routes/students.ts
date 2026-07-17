import { Router } from "express";
import { db } from "@workspace/db";
import { projectsTable, classesTable, studentsTable } from "@workspace/db";
import { eq, and, inArray } from "drizzle-orm";
import { requireAuth, getUserId } from "../lib/auth";
import { generateUniqueStudentId } from "../lib/studentId";
import { generateSimpleQr, generateJsonQr } from "../lib/qrcode";

const router = Router({ mergeParams: true });

async function verifyProject(projectId: number, userId: string): Promise<boolean> {
  const [project] = await db
    .select({ id: projectsTable.id })
    .from(projectsTable)
    .where(and(eq(projectsTable.id, projectId), eq(projectsTable.userId, userId)));
  return !!project;
}

async function getExistingStudentIds(projectId: number): Promise<Set<string>> {
  const students = await db
    .select({ generatedStudentId: studentsTable.generatedStudentId })
    .from(studentsTable)
    .where(eq(studentsTable.projectId, projectId));
  return new Set(students.map((s) => s.generatedStudentId));
}

function formatStudent(
  s: typeof studentsTable.$inferSelect,
  className: string,
) {
  return {
    id: s.id,
    projectId: s.projectId,
    classId: s.classId,
    className,
    firstName: s.firstName,
    lastName: s.lastName,
    generatedStudentId: s.generatedStudentId,
    simpleQr: s.simpleQr,
    jsonQr: s.jsonQr,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  };
}

// GET /api/projects/:projectId/students
router.get("/", requireAuth, async (req, res) => {
  const userId = getUserId(req);
  const projectId = parseInt(req.params.projectId as string);

  if (!(await verifyProject(projectId, userId))) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const rows = await db
    .select({
      student: studentsTable,
      className: classesTable.className,
    })
    .from(studentsTable)
    .innerJoin(classesTable, eq(studentsTable.classId, classesTable.id))
    .where(eq(studentsTable.projectId, projectId))
    .orderBy(classesTable.className, studentsTable.lastName, studentsTable.firstName);

  res.json(rows.map((r) => formatStudent(r.student, r.className)));
});

// POST /api/projects/:projectId/students
router.post("/", requireAuth, async (req, res) => {
  const userId = getUserId(req);
  const projectId = parseInt(req.params.projectId as string);

  if (!(await verifyProject(projectId, userId))) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const { classId, firstName, lastName, generatedStudentId } = req.body;

  if (!classId || !firstName || !lastName) {
    res.status(400).json({ error: "classId, firstName, and lastName are required" });
    return;
  }

  const [cls] = await db
    .select()
    .from(classesTable)
    .where(and(eq(classesTable.id, classId), eq(classesTable.projectId, projectId)));

  if (!cls) {
    res.status(400).json({ error: "Class not found in this project" });
    return;
  }

  const existingIds = await getExistingStudentIds(projectId);
  const studentId =
    generatedStudentId && !existingIds.has(generatedStudentId)
      ? generatedStudentId
      : generateUniqueStudentId(existingIds);

  const [student] = await db
    .insert(studentsTable)
    .values({ projectId, classId, firstName, lastName, generatedStudentId: studentId })
    .returning();

  res.status(201).json(formatStudent(student, cls.className));
});

// PATCH /api/projects/:projectId/students/:studentId
router.patch("/:studentId", requireAuth, async (req, res) => {
  const userId = getUserId(req);
  const projectId = parseInt(req.params.projectId as string);
  const studentId = parseInt(req.params.studentId as string);

  if (!(await verifyProject(projectId, userId))) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const [existing] = await db
    .select()
    .from(studentsTable)
    .where(and(eq(studentsTable.id, studentId), eq(studentsTable.projectId, projectId)));

  if (!existing) {
    res.status(404).json({ error: "Student not found" });
    return;
  }

  const { firstName, lastName, generatedStudentId, classId } = req.body;

  const [updated] = await db
    .update(studentsTable)
    .set({
      ...(firstName !== undefined && { firstName }),
      ...(lastName !== undefined && { lastName }),
      ...(generatedStudentId !== undefined && { generatedStudentId }),
      ...(classId !== undefined && { classId }),
      // Regenerate QR if name or ID changed
      ...(firstName !== undefined || lastName !== undefined || generatedStudentId !== undefined
        ? { simpleQr: null, jsonQr: null }
        : {}),
      updatedAt: new Date(),
    })
    .where(and(eq(studentsTable.id, studentId), eq(studentsTable.projectId, projectId)))
    .returning();

  const [cls] = await db
    .select()
    .from(classesTable)
    .where(eq(classesTable.id, updated.classId));

  res.json(formatStudent(updated, cls?.className ?? ""));
});

// DELETE /api/projects/:projectId/students/:studentId
router.delete("/:studentId", requireAuth, async (req, res) => {
  const userId = getUserId(req);
  const projectId = parseInt(req.params.projectId as string);
  const studentId = parseInt(req.params.studentId as string);

  if (!(await verifyProject(projectId, userId))) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  await db
    .delete(studentsTable)
    .where(and(eq(studentsTable.id, studentId), eq(studentsTable.projectId, projectId)));

  res.status(204).send();
});

// POST /api/projects/:projectId/students/bulk-delete
router.post("/bulk-delete", requireAuth, async (req, res) => {
  const userId = getUserId(req);
  const projectId = parseInt(req.params.projectId as string);

  if (!(await verifyProject(projectId, userId))) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const { studentIds } = req.body;
  if (!Array.isArray(studentIds) || studentIds.length === 0) {
    res.status(400).json({ error: "studentIds must be a non-empty array" });
    return;
  }

  await db
    .delete(studentsTable)
    .where(
      and(
        eq(studentsTable.projectId, projectId),
        inArray(studentsTable.id, studentIds),
      ),
    );

  res.json({ deleted: studentIds.length });
});

// POST /api/projects/:projectId/students/generate-qr
router.post("/generate-qr", requireAuth, async (req, res) => {
  const userId = getUserId(req);
  const projectId = parseInt(req.params.projectId as string);

  if (!(await verifyProject(projectId, userId))) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const [project] = await db
    .select()
    .from(projectsTable)
    .where(eq(projectsTable.id, projectId));

  const { studentIds } = req.body ?? {};

  let studentsToProcess;
  if (Array.isArray(studentIds) && studentIds.length > 0) {
    studentsToProcess = await db
      .select({ student: studentsTable, className: classesTable.className })
      .from(studentsTable)
      .innerJoin(classesTable, eq(studentsTable.classId, classesTable.id))
      .where(
        and(
          eq(studentsTable.projectId, projectId),
          inArray(studentsTable.id, studentIds),
        ),
      );
  } else {
    // Generate for all students in project
    studentsToProcess = await db
      .select({ student: studentsTable, className: classesTable.className })
      .from(studentsTable)
      .innerJoin(classesTable, eq(studentsTable.classId, classesTable.id))
      .where(eq(studentsTable.projectId, projectId));
  }

  let generated = 0;
  for (const { student, className } of studentsToProcess) {
    const simpleQr = await generateSimpleQr(
      student.firstName,
      student.lastName,
      student.generatedStudentId,
    );
    const jsonQr = await generateJsonQr(
      project.schoolName,
      className,
      student.firstName,
      student.lastName,
      student.generatedStudentId,
    );

    await db
      .update(studentsTable)
      .set({ simpleQr, jsonQr, updatedAt: new Date() })
      .where(eq(studentsTable.id, student.id));

    generated++;
  }

  res.json({ generated });
});

export default router;
