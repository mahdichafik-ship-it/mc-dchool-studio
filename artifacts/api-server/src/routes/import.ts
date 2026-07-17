import { Router } from "express";
import multer from "multer";
import * as XLSX from "xlsx";
import { db } from "@workspace/db";
import { projectsTable, classesTable, studentsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { requireAuth, getUserId } from "../lib/auth";
import { generateUniqueStudentId } from "../lib/studentId";

const router = Router({ mergeParams: true });
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

async function verifyProject(projectId: number, userId: string) {
  const [project] = await db
    .select()
    .from(projectsTable)
    .where(and(eq(projectsTable.id, projectId), eq(projectsTable.userId, userId)));
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

  const existingIds = new Set<string>();
  const currentStudents = await db
    .select({ generatedStudentId: studentsTable.generatedStudentId })
    .from(studentsTable)
    .where(eq(studentsTable.projectId, projectId));
  currentStudents.forEach((s) => existingIds.add(s.generatedStudentId));

  let classesCreated = 0;
  let studentsCreated = 0;

  for (const sheet of sheets) {
    const { className, firstNameColumn, lastNameColumn, studentIdColumn, rows, headers } = sheet;

    if (!className || !firstNameColumn || !lastNameColumn) {
      continue;
    }

    // Create the class (or find existing)
    let [cls] = await db
      .select()
      .from(classesTable)
      .where(and(eq(classesTable.projectId, projectId), eq(classesTable.className, className)));

    if (!cls) {
      [cls] = await db
        .insert(classesTable)
        .values({ projectId, className })
        .returning();
      classesCreated++;
    }

    // Map column indices
    const firstNameIdx = headers.indexOf(firstNameColumn);
    const lastNameIdx = headers.indexOf(lastNameColumn);
    const studentIdIdx = studentIdColumn ? headers.indexOf(studentIdColumn) : -1;

    if (firstNameIdx === -1 || lastNameIdx === -1) {
      continue;
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

      await db.insert(studentsTable).values({
        projectId,
        classId: cls.id,
        firstName,
        lastName,
        generatedStudentId,
      });

      studentsCreated++;
    }
  }

  // Update project updatedAt
  await db
    .update(projectsTable)
    .set({ updatedAt: new Date() })
    .where(eq(projectsTable.id, projectId));

  res.json({ classesCreated, studentsCreated });
});

export default router;
