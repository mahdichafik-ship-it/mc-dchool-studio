import { Router } from "express";
import multer from "multer";
import * as XLSX from "xlsx";
import { db } from "@workspace/db";
import { projectsTable, classesTable, studentsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { requireAuth, getUserId } from "../lib/auth";
import { generateUniqueStudentId } from "../lib/studentId";
import { canAccessProject } from "../lib/studioAccess";
import { reconcileDefaultGroups } from "../lib/groupReconciliation";

const router = Router({ mergeParams: true });
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

function normalizeOptionalString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function isValidEmail(value: string | null): boolean {
  return !value || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

class ImportValidationError extends Error {}

async function verifyProject(projectId: number, userId: string) {
  if (!(await canAccessProject(userId, projectId, "edit"))) return null;
  const [project] = await db.select().from(projectsTable).where(eq(projectsTable.id, projectId));
  return project ?? null;
}

// POST /api/projects/:projectId/import/parse
router.post("/parse", requireAuth, upload.single("file"), async (req, res) => {
  const userId = getUserId(req);
  const projectId = parseInt(req.params.projectId as string);

  if (!(await verifyProject(projectId, userId))) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  if (!req.file) {
    res.status(400).json({ error: "No file uploaded" });
    return;
  }

  const { originalname, buffer } = req.file;
  const isCSV =
    originalname.toLowerCase().endsWith(".csv") ||
    req.file.mimetype === "text/csv";

  try {
    const workbook = XLSX.read(buffer, { type: "buffer", raw: false });

    const sheets = workbook.SheetNames.map((sheetName) => {
      const sheet = workbook.Sheets[sheetName];
      const allRows: string[][] = XLSX.utils.sheet_to_json(sheet, {
        header: 1,
        defval: "",
        raw: false,
      }) as string[][];

      if (allRows.length === 0) {
        return { name: sheetName, headers: [], rows: [] };
      }

      const headers = allRows[0].map((h) => String(h ?? "").trim());
      const dataRows = allRows
        .slice(1)
        .filter((row) => row.some((cell) => String(cell ?? "").trim() !== ""))
        .map((row) => row.map((cell) => String(cell ?? "").trim()));

      return {
        name: sheetName,
        headers,
        rows: dataRows.slice(0, 5), // Preview first 5 rows
      };
    });

    // For CSV with a single sheet: attach the csvClassName from body if provided
    const csvClassName = isCSV ? (req.body?.csvClassName ?? "") : null;
    if (isCSV && sheets.length === 1 && csvClassName) {
      sheets[0].name = csvClassName;
    }

    res.json({ sheets });
  } catch (err) {
    res.status(400).json({ error: "Failed to parse file. Ensure it is a valid .xlsx or .csv file." });
  }
});

// POST /api/projects/:projectId/import/confirm
router.post("/confirm", requireAuth, async (req, res) => {
  const userId = getUserId(req);
  const projectId = parseInt(req.params.projectId as string);

  const project = await verifyProject(projectId, userId);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const { sheets } = req.body;
  if (!Array.isArray(sheets) || sheets.length === 0) {
    res.status(400).json({ error: "sheets is required" });
    return;
  }

  let result: { classesCreated: number; studentsCreated: number };
  try {
    result = await db.transaction(async (tx) => {
      const existingIds = new Set<string>();
      const currentStudents = await tx
        .select({ generatedStudentId: studentsTable.generatedStudentId })
        .from(studentsTable)
        .where(eq(studentsTable.projectId, projectId));
      currentStudents.forEach((s) => existingIds.add(s.generatedStudentId));

      let classesCreated = 0;
      let studentsCreated = 0;

      for (const sheet of sheets) {
        const {
          className,
          firstNameColumn,
          lastNameColumn,
          studentIdColumn,
          emailColumn,
          secondaryEmailColumn,
          jobTitleColumn,
          officeLocationColumn,
          photoSessionColumn,
          phoneColumn,
          rows,
          headers,
        } = sheet;

        if (!className || !firstNameColumn || !lastNameColumn) {
          continue;
        }

        // Map column indices
        const firstNameIdx = headers.indexOf(firstNameColumn);
        const lastNameIdx = headers.indexOf(lastNameColumn);
        const studentIdIdx = studentIdColumn ? headers.indexOf(studentIdColumn) : -1;
        const emailIdx = emailColumn ? headers.indexOf(emailColumn) : -1;
        const secondaryEmailIdx = secondaryEmailColumn ? headers.indexOf(secondaryEmailColumn) : -1;
        const jobTitleIdx = jobTitleColumn ? headers.indexOf(jobTitleColumn) : -1;
        const officeLocationIdx = officeLocationColumn ? headers.indexOf(officeLocationColumn) : -1;
        const photoSessionIdx = photoSessionColumn ? headers.indexOf(photoSessionColumn) : -1;
        const phoneIdx = phoneColumn ? headers.indexOf(phoneColumn) : -1;

        if (firstNameIdx === -1 || lastNameIdx === -1) {
          continue;
        }

        // Create the class (or find existing)
        let [cls] = await tx
          .select()
          .from(classesTable)
          .where(and(eq(classesTable.projectId, projectId), eq(classesTable.className, className)));

        if (!cls) {
          [cls] = await tx
            .insert(classesTable)
            .values({ projectId, className })
            .returning();
          classesCreated++;
        }

        for (const row of rows) {
          const firstName = String(row[firstNameIdx] ?? "").trim();
          const lastName = String(row[lastNameIdx] ?? "").trim();

          if (!firstName && !lastName) continue;

          const providedId = studentIdIdx >= 0 ? String(row[studentIdIdx] ?? "").trim() : "";
          const generatedStudentId =
            providedId && !existingIds.has(providedId)
              ? providedId
              : generateUniqueStudentId(existingIds);

          existingIds.add(generatedStudentId);

          const email = emailIdx >= 0 ? normalizeOptionalString(row[emailIdx]) : null;
          const secondaryEmail =
            secondaryEmailIdx >= 0 ? normalizeOptionalString(row[secondaryEmailIdx]) : null;
          if (!isValidEmail(email) || !isValidEmail(secondaryEmail)) {
            throw new ImportValidationError(`Invalid email address for ${firstName} ${lastName}`);
          }
          const phone = phoneIdx >= 0 ? normalizeOptionalString(row[phoneIdx]) : null;
          const jobTitle = jobTitleIdx >= 0 ? normalizeOptionalString(row[jobTitleIdx]) : null;
          const officeLocation =
            officeLocationIdx >= 0 ? normalizeOptionalString(row[officeLocationIdx]) : null;
          const photoSession =
            photoSessionIdx >= 0 ? normalizeOptionalString(row[photoSessionIdx]) : null;

          await tx.insert(studentsTable).values({
            projectId,
            classId: cls.id,
            firstName,
            lastName,
            generatedStudentId,
            email,
            phone,
            secondaryEmail,
            jobTitle,
            officeLocation,
            photoSession,
          });

          studentsCreated++;
        }
      }

      // Update project updatedAt
      await tx
        .update(projectsTable)
        .set({ updatedAt: new Date() })
        .where(eq(projectsTable.id, projectId));

      return { classesCreated, studentsCreated };
    });
  } catch (error) {
    if (error instanceof ImportValidationError) {
      res.status(400).json({ error: error.message });
      return;
    }
    throw error;
  }

  await reconcileDefaultGroups(projectId);

  res.json(result);
});

export default router;
