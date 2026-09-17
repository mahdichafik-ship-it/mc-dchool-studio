import { Router } from "express";
import { db } from "@workspace/db";
import { projectsTable, classesTable, studentsTable } from "@workspace/db";
import { eq, and, inArray, ne, sql } from "drizzle-orm";
import { requireAuth, getUserId } from "../lib/auth";
import {
  generateUniqueStudentId,
  isStudentIdUniqueViolation,
  studentIdKey,
} from "../lib/studentId";
import { generateSimpleQr, generateJsonQr } from "../lib/qrcode";
import { canAccessProject } from "../lib/studioAccess";
import { reconcileDefaultGroups } from "../lib/groupReconciliation";
import {
  enqueueR2PhotoDeletionsForStudents,
  lockProjectStudentIds,
} from "../lib/r2PhotoDeletionOutbox";

const router = Router({ mergeParams: true });

async function verifyProject(projectId: number, userId: string, action: "view" | "edit" = "view"): Promise<boolean> {
  return canAccessProject(userId, projectId, action);
}

async function getExistingStudentIds(projectId: number): Promise<Set<string>> {
  const students = await db
    .select({ generatedStudentId: studentsTable.generatedStudentId })
    .from(studentsTable)
    .where(eq(studentsTable.projectId, projectId));
  return new Set(students.map((s) => studentIdKey(s.generatedStudentId)));
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
    schoolId: s.schoolId ?? null,
    email: s.email ?? null,
    phone: s.phone ?? null,
    secondaryEmail: s.secondaryEmail ?? null,
    guardianFirstName: s.guardianFirstName ?? null,
    guardianLastName: s.guardianLastName ?? null,
    company: s.company ?? null,
    addressLine1: s.addressLine1 ?? null,
    addressLine2: s.addressLine2 ?? null,
    city: s.city ?? null,
    stateProvince: s.stateProvince ?? null,
    zipPostalCode: s.zipPostalCode ?? null,
    country: s.country ?? null,
    contactNote: s.contactNote ?? null,
    jobTitle: s.jobTitle ?? null,
    officeLocation: s.officeLocation ?? null,
    photoSession: s.photoSession ?? null,
    captureNotes: s.captureNotes ?? null,
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
    schoolId,
    email,
    phone,
    secondaryEmail,
    guardianFirstName,
    guardianLastName,
    company,
    addressLine1,
    addressLine2,
    city,
    stateProvince,
    zipPostalCode,
    country,
    contactNote,
    jobTitle,
    officeLocation,
    photoSession,
    captureNotes,
  } = req.body;

  const normalizedFirstName =
    firstName !== undefined ? normalizeOptionalString(firstName) : undefined;
  const normalizedLastName =
    lastName !== undefined ? normalizeOptionalString(lastName) : undefined;
  if (!classId || !normalizedFirstName || !normalizedLastName) {
    res.status(400).json({ error: "classId, firstName, and lastName are required" });
    return;
  }

  const normalizedEmail = email !== undefined ? normalizeOptionalString(email) : undefined;
  const normalizedSecondaryEmail =
    secondaryEmail !== undefined ? normalizeOptionalString(secondaryEmail) : undefined;
  const normalizedGeneratedStudentId =
    generatedStudentId !== undefined ? normalizeOptionalString(generatedStudentId) : undefined;
  const emailError =
    validateEmail(normalizedEmail ?? null, "email") ??
    validateEmail(normalizedSecondaryEmail ?? null, "secondaryEmail");
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
  if (normalizedGeneratedStudentId && existingIds.has(studentIdKey(normalizedGeneratedStudentId))) {
    res.status(409).json({
      error: "That Student ID/Employee ID is already used in this project.",
      code: "STUDENT_ID_CONFLICT",
    });
    return;
  }
  const studentId = normalizedGeneratedStudentId ?? generateUniqueStudentId(existingIds);

  let student: typeof studentsTable.$inferSelect | undefined;
  try {
    [student] = await db
      .insert(studentsTable)
      .values({
        projectId,
        classId,
        firstName: normalizedFirstName,
        lastName: normalizedLastName,
        generatedStudentId: studentId,
        schoolId: normalizeOptionalString(schoolId),
        email: normalizedEmail,
        phone: normalizeOptionalString(phone),
        secondaryEmail: normalizedSecondaryEmail,
        guardianFirstName: normalizeOptionalString(guardianFirstName),
        guardianLastName: normalizeOptionalString(guardianLastName),
        company: normalizeOptionalString(company),
        addressLine1: normalizeOptionalString(addressLine1),
        addressLine2: normalizeOptionalString(addressLine2),
        city: normalizeOptionalString(city),
        stateProvince: normalizeOptionalString(stateProvince),
        zipPostalCode: normalizeOptionalString(zipPostalCode),
        country: normalizeOptionalString(country),
        contactNote: normalizeOptionalString(contactNote),
        jobTitle: normalizeOptionalString(jobTitle),
        officeLocation: normalizeOptionalString(officeLocation),
        photoSession: normalizeOptionalString(photoSession),
        captureNotes: normalizeOptionalString(captureNotes),
      })
      .returning();
  } catch (error) {
    // The index, rather than this preflight, is the concurrency authority.
    if (isStudentIdUniqueViolation(error)) {
      res.status(409).json({
        error: "That Student ID/Employee ID is already used in this project.",
        code: "STUDENT_ID_CONFLICT",
      });
      return;
    }
    throw error;
  }
  if (!student) {
    throw new Error("Student could not be created");
  }

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
    schoolId,
    guardianFirstName,
    guardianLastName,
    company,
    addressLine1,
    addressLine2,
    city,
    stateProvince,
    zipPostalCode,
    country,
    contactNote,
    jobTitle,
    officeLocation,
    photoSession,
    captureNotes,
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

  if (normalizedGeneratedStudentId) {
    const [collision] = await db
      .select({ id: studentsTable.id })
      .from(studentsTable)
      .where(and(
        eq(studentsTable.projectId, projectId),
        ne(studentsTable.id, studentId),
        sql`lower(${studentsTable.generatedStudentId}) = lower(${normalizedGeneratedStudentId})`,
      ));
    if (collision) {
      res.status(409).json({
        error: "That Student ID/Employee ID is already used in this project.",
        code: "STUDENT_ID_CONFLICT",
      });
      return;
    }
  }

  let destinationClass: typeof classesTable.$inferSelect | undefined;
  if (classId !== undefined) {
    [destinationClass] = await db
      .select()
      .from(classesTable)
      .where(and(eq(classesTable.id, Number(classId)), eq(classesTable.projectId, projectId)));
    if (!destinationClass) {
      res.status(400).json({ error: "Class not found in this project" });
      return;
    }
  }

  let updated: typeof studentsTable.$inferSelect | undefined;
  try {
    [updated] = await db
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
        ...(schoolId !== undefined && { schoolId: normalizeOptionalString(schoolId) }),
        ...(guardianFirstName !== undefined && { guardianFirstName: normalizeOptionalString(guardianFirstName) }),
        ...(guardianLastName !== undefined && { guardianLastName: normalizeOptionalString(guardianLastName) }),
        ...(company !== undefined && { company: normalizeOptionalString(company) }),
        ...(addressLine1 !== undefined && { addressLine1: normalizeOptionalString(addressLine1) }),
        ...(addressLine2 !== undefined && { addressLine2: normalizeOptionalString(addressLine2) }),
        ...(city !== undefined && { city: normalizeOptionalString(city) }),
        ...(stateProvince !== undefined && { stateProvince: normalizeOptionalString(stateProvince) }),
        ...(zipPostalCode !== undefined && { zipPostalCode: normalizeOptionalString(zipPostalCode) }),
        ...(country !== undefined && { country: normalizeOptionalString(country) }),
        ...(contactNote !== undefined && { contactNote: normalizeOptionalString(contactNote) }),
        ...(jobTitle !== undefined && { jobTitle: normalizeOptionalString(jobTitle) }),
        ...(officeLocation !== undefined && { officeLocation: normalizeOptionalString(officeLocation) }),
        ...(photoSession !== undefined && { photoSession: normalizeOptionalString(photoSession) }),
        ...(captureNotes !== undefined && { captureNotes: normalizeOptionalString(captureNotes) }),
        // Regenerate QR if name or ID changed
        ...(identityChanged
          ? { simpleQr: null, jsonQr: null }
          : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(studentsTable.id, studentId), eq(studentsTable.projectId, projectId)))
      .returning();
  } catch (error) {
    if (isStudentIdUniqueViolation(error)) {
      res.status(409).json({
        error: "That Student ID/Employee ID is already used in this project.",
        code: "STUDENT_ID_CONFLICT",
      });
      return;
    }
    throw error;
  }
  if (!updated) {
    res.status(404).json({ error: "Student not found" });
    return;
  }

  const cls = destinationClass ?? (await db
    .select()
    .from(classesTable)
    .where(and(eq(classesTable.id, updated.classId), eq(classesTable.projectId, projectId))))[0];

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

  await db.transaction(async (tx) => {
    const scopedIds = await lockProjectStudentIds(tx, projectId, [studentId]);
    if (scopedIds.length === 0) return;
    await enqueueR2PhotoDeletionsForStudents(tx, scopedIds);
    await tx.delete(studentsTable)
      .where(and(eq(studentsTable.id, studentId), eq(studentsTable.projectId, projectId)));
  });

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

  const { studentIds } = req.body ?? {};
  if (!Array.isArray(studentIds) || studentIds.length === 0) {
    res.status(400).json({ error: "studentIds must be a non-empty array" });
    return;
  }

  const deletedCount = await db.transaction(async (tx) => {
    const scopedIds = await lockProjectStudentIds(tx, projectId, studentIds);
    if (scopedIds.length === 0) return 0;
    await enqueueR2PhotoDeletionsForStudents(tx, scopedIds);
    await tx.delete(studentsTable)
      .where(and(
        eq(studentsTable.projectId, projectId),
        inArray(studentsTable.id, scopedIds),
      ));
    return scopedIds.length;
  });

  res.json({ deleted: deletedCount });
});

// POST /api/projects/:projectId/students/generate-qr
router.post("/generate-qr", requireAuth, async (req, res) => {
  const userId = getUserId(req);
  const projectId = parseInt(req.params.projectId as string);

  if (!(await verifyProject(projectId, userId, "edit"))) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const [project] = await db.select().from(projectsTable)
    .where(eq(projectsTable.id, projectId));
  const { studentIds } = req.body ?? {};

  const studentsToProcess = Array.isArray(studentIds) && studentIds.length > 0
    ? await db.select({ student: studentsTable, className: classesTable.className })
      .from(studentsTable)
      .innerJoin(classesTable, eq(studentsTable.classId, classesTable.id))
      .where(and(eq(studentsTable.projectId, projectId), inArray(studentsTable.id, studentIds)))
    : await db.select({ student: studentsTable, className: classesTable.className })
      .from(studentsTable)
      .innerJoin(classesTable, eq(studentsTable.classId, classesTable.id))
      .where(eq(studentsTable.projectId, projectId));
  const needsQr = Array.isArray(studentIds) && studentIds.length > 0
    ? studentsToProcess
    : studentsToProcess.filter((row) => !row.student.simpleQr);

  const BATCH = 50;
  let generated = 0;
  for (let i = 0; i < needsQr.length; i += BATCH) {
    await Promise.all(needsQr.slice(i, i + BATCH).map(async ({ student, className }) => {
      const [simpleQr, jsonQr] = await Promise.all([
        generateSimpleQr(student.firstName, student.lastName, student.generatedStudentId),
        generateJsonQr(
          project.schoolName,
          className,
          student.firstName,
          student.lastName,
          student.generatedStudentId,
        ),
      ]);
      await db.update(studentsTable).set({ simpleQr, jsonQr, updatedAt: new Date() })
        .where(eq(studentsTable.id, student.id));
      generated += 1;
    }));
  }

  res.json({ generated });
});

export default router;
