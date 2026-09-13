import { Router } from "express";
import { db } from "@workspace/db";
import { projectsTable, classesTable, studentsTable } from "@workspace/db";
import { eq, and, inArray } from "drizzle-orm";
import { requireAuth, getUserId } from "../lib/auth";
import { generateUniqueStudentId } from "../lib/studentId";
import { generateSimpleQr, generateJsonQr } from "../lib/qrcode";
import { canAccessProject } from "../lib/studioAccess";
import { reconcileDefaultGroups } from "../lib/groupReconciliation";

const router = Router({ mergeParams: true });

async function verifyProject(projectId: number, userId: string, action: "view" | "edit" = "view"): Promise<boolean> {
  return canAccessProject(userId, projectId, action);
}

async function getExistingStudentIds(projectId: number): Promise<Set<string>> {
  const students = await db
    .select({ generatedStudentId: studentsTable.generatedStudentId })
    .from(studentsTable)
    .where(eq(studentsTable.projectId, projectId));
  return new Set(students.map((s) => s.generatedStudentId));
}

function normalizeOptionalString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function validateEmail(value: string | null, fieldName: string): string | null {
  if (value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    return `${fieldName} must be a valid email address`;
  }
  return null;
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
    email: s.email ?? null,
    phone: s.phone ?? null,
    secondaryEmail: s.secondaryEmail ?? null,
    jobTitle: s.jobTitle ?? null,
    officeLocation: s.officeLocation ?? null,
    photoSession: s.photoSession ?? null,
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

  if (!(await verifyProject(projectId, userId, "edit"))) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const {
    classId,
    firstName,
    lastName,
    generatedStudentId,
    email,
    phone,
    secondaryEmail,
    jobTitle,
    officeLocation,
    photoSession,
  } = req.body;

  const normalizedFirstName = normalizeOptionalString(firstName);
  const normalizedLastName = normalizeOptionalString(lastName);
  if (!classId || !normalizedFirstName || !normalizedLastName) {
    res.status(400).json({ error: "classId, firstName, and lastName are required" });
    return;
  }

  const normalizedEmail = normalizeOptionalString(email);
  const normalizedSecondaryEmail = normalizeOptionalString(secondaryEmail);
  const normalizedGeneratedStudentId = normalizeOptionalString(generatedStudentId);
  const emailError =
    validateEmail(normalizedEmail, "email") ??
    validateEmail(normalizedSecondaryEmail, "secondaryEmail");
  if (emailError) {
    res.status(400).json({ error: emailError });
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
    normalizedGeneratedStudentId && !existingIds.has(normalizedGeneratedStudentId)
      ? normalizedGeneratedStudentId
      : generateUniqueStudentId(existingIds);

  const [student] = await db
    .insert(studentsTable)
    .values({
      projectId,
      classId,
      firstName: normalizedFirstName,
      lastName: normalizedLastName,
      generatedStudentId: studentId,
      email: normalizedEmail,
      phone: normalizeOptionalString(phone),
      secondaryEmail: normalizedSecondaryEmail,
      jobTitle: normalizeOptionalString(jobTitle),
      officeLocation: normalizeOptionalString(officeLocation),
      photoSession: normalizeOptionalString(photoSession),
    })
    .returning();

  res.status(201).json(formatStudent(student, cls.className));
  await reconcileDefaultGroups(projectId);
});

// PATCH /api/projects/:projectId/students/:studentId
router.patch("/:studentId", requireAuth, async (req, res) => {
  const userId = getUserId(req);
  const projectId = parseInt(req.params.projectId as string);
  const studentId = parseInt(req.params.studentId as string);

  if (!(await verifyProject(projectId, userId, "edit"))) {
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

  const {
    firstName,
    lastName,
    generatedStudentId,
    classId,
    email,
    phone,
    secondaryEmail,
    jobTitle,
    officeLocation,
    photoSession,
  } = req.body;

  const normalizedEmail = email !== undefined ? normalizeOptionalString(email) : undefined;
  const normalizedSecondaryEmail =
    secondaryEmail !== undefined ? normalizeOptionalString(secondaryEmail) : undefined;
  const normalizedGeneratedStudentId =
    generatedStudentId !== undefined ? normalizeOptionalString(generatedStudentId) : undefined;
  const normalizedFirstName =
    firstName !== undefined ? normalizeOptionalString(firstName) : undefined;
  const normalizedLastName =
    lastName !== undefined ? normalizeOptionalString(lastName) : undefined;
  if (normalizedFirstName === null || normalizedLastName === null) {
    res.status(400).json({ error: "firstName and lastName cannot be blank" });
    return;
  }
  const identityChanged =
    (normalizedFirstName !== undefined && normalizedFirstName !== existing.firstName) ||
    (normalizedLastName !== undefined && normalizedLastName !== existing.lastName) ||
    (normalizedGeneratedStudentId !== undefined &&
      normalizedGeneratedStudentId !== null &&
      normalizedGeneratedStudentId !== existing.generatedStudentId);
  const emailError =
    validateEmail(normalizedEmail ?? null, "email") ??
    validateEmail(normalizedSecondaryEmail ?? null, "secondaryEmail");
  if (emailError) {
    res.status(400).json({ error: emailError });
    return;
  }

  const [updated] = await db
    .update(studentsTable)
    .set({
      ...(normalizedFirstName !== undefined && { firstName: normalizedFirstName }),
      ...(normalizedLastName !== undefined && { lastName: normalizedLastName }),
      ...(normalizedGeneratedStudentId !== null &&
        normalizedGeneratedStudentId !== undefined && {
          generatedStudentId: normalizedGeneratedStudentId,
        }),
      ...(classId !== undefined && { classId }),
      ...(email !== undefined && { email: normalizedEmail }),
      ...(phone !== undefined && { phone: normalizeOptionalString(phone) }),
      ...(secondaryEmail !== undefined && { secondaryEmail: normalizedSecondaryEmail }),
      ...(jobTitle !== undefined && { jobTitle: normalizeOptionalString(jobTitle) }),
      ...(officeLocation !== undefined && { officeLocation: normalizeOptionalString(officeLocation) }),
      ...(photoSession !== undefined && { photoSession: normalizeOptionalString(photoSession) }),
      // Regenerate QR if name or ID changed
      ...(identityChanged
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

  if (!(await verifyProject(projectId, userId, "edit"))) {
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

  if (!(await verifyProject(projectId, userId, "edit"))) {
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

  if (!(await verifyProject(projectId, userId, "edit"))) {
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

  // Only regenerate students that are actually missing QR codes (unless specific IDs requested)
  const needsQr = Array.isArray(studentIds) && studentIds.length > 0
    ? studentsToProcess
    : studentsToProcess.filter(r => !r.student.simpleQr);

  // Generate all QR codes in parallel (concurrency-limited to avoid OOM on huge classes)
  const BATCH = 50;
  let generated = 0;
  for (let i = 0; i < needsQr.length; i += BATCH) {
    const batch = needsQr.slice(i, i + BATCH);
    await Promise.all(
      batch.map(async ({ student, className }) => {
        const [simpleQr, jsonQr] = await Promise.all([
          generateSimpleQr(student.firstName, student.lastName, student.generatedStudentId),
          generateJsonQr(project.schoolName, className, student.firstName, student.lastName, student.generatedStudentId),
        ]);
        await db
          .update(studentsTable)
          .set({ simpleQr, jsonQr, updatedAt: new Date() })
          .where(eq(studentsTable.id, student.id));
        generated++;
      }),
    );
  }

  res.json({ generated });
});

export default router;
