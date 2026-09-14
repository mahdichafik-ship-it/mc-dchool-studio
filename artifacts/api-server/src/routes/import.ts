import { Router } from "express";
import multer from "multer";
import * as XLSX from "xlsx";
import { db } from "@workspace/db";
import { projectsTable, classesTable, studentsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { requireAuth, getUserId } from "../lib/auth";
import { generateUniqueStudentId, isStudentIdUniqueViolation } from "../lib/studentId";
import { canAccessProject } from "../lib/studioAccess";
import { reconcileDefaultGroups } from "../lib/groupReconciliation";

const router = Router({ mergeParams: true });
const IMPORT_FILE_MAX_BYTES = 10 * 1024 * 1024;
const IMPORT_MAX_SHEETS = 100;
const IMPORT_MAX_ROWS = 20_000;
const IMPORT_MAX_COLUMNS = 250;
const IMPORT_MAX_CELL_LENGTH = 2_000;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: IMPORT_FILE_MAX_BYTES, files: 1 } });

function normalizeOptionalString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

/**
 * Keys used for roster reconciliation. NFKC makes equivalent Unicode
 * spellings compare alike, while lower-casing provides the case-folding
 * needed for IDs, email addresses, names, and classes.
 */
function normalizeKey(value: unknown): string {
  return String(value ?? "")
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase();
}

function isValidEmail(value: string | null): boolean {
  return !value || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

class ImportValidationError extends Error {}

function boundedCell(value: unknown): string {
  const cell = String(value ?? "").trim();
  if (cell.length > IMPORT_MAX_CELL_LENGTH) {
    throw new ImportValidationError(`Roster cells cannot exceed ${IMPORT_MAX_CELL_LENGTH} characters`);
  }
  return cell;
}

function validateWorkbookShape(workbook: XLSX.WorkBook): void {
  if (workbook.SheetNames.length < 1 || workbook.SheetNames.length > IMPORT_MAX_SHEETS) {
    throw new ImportValidationError(`Roster files must contain between 1 and ${IMPORT_MAX_SHEETS} sheets`);
  }
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const range = sheet?.["!ref"] ? XLSX.utils.decode_range(sheet["!ref"]) : null;
    if (!range) continue;
    const rows = range.e.r - range.s.r + 1;
    const columns = range.e.c - range.s.c + 1;
    if (rows > IMPORT_MAX_ROWS + 1 || columns > IMPORT_MAX_COLUMNS) {
      throw new ImportValidationError(
        `Each roster sheet is limited to ${IMPORT_MAX_ROWS} rows and ${IMPORT_MAX_COLUMNS} columns`,
      );
    }
  }
}

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
    const workbook = XLSX.read(buffer, {
      type: "buffer",
      raw: false,
      cellFormula: false,
      cellHTML: false,
      cellNF: false,
      cellStyles: false,
      sheetRows: IMPORT_MAX_ROWS + 2,
    });
    validateWorkbookShape(workbook);

    const sheets = workbook.SheetNames.map((sheetName) => {
      const sheet = workbook.Sheets[sheetName];
      const allRows: string[][] = XLSX.utils.sheet_to_json(sheet, {
        header: 1,
        defval: "",
        raw: false,
        blankrows: false,
      }) as string[][];

      if (allRows.length === 0) {
        return { name: sheetName, headers: [], rows: [] };
      }

      const headers = allRows[0].map(boundedCell);
      const dataRows = allRows
        .slice(1)
        .filter((row) => row.some((cell) => boundedCell(cell) !== ""))
        .map((row) => row.map(boundedCell));

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
    res.status(400).json({
      error: err instanceof ImportValidationError
        ? err.message
        : "Failed to parse file. Ensure it is a valid .xlsx or .csv file.",
    });
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
  if (sheets.length > IMPORT_MAX_SHEETS) {
    res.status(400).json({ error: `A roster import cannot exceed ${IMPORT_MAX_SHEETS} sheets` });
    return;
  }

  let result: {
    classesCreated: number;
    studentsCreated: number;
    studentsUpdated: number;
    studentsMoved: number;
    studentsSkipped: number;
    conflicts: number;
  };
  try {
    result = await db.transaction(async (tx) => {
      type WorkingStudent = {
        student: typeof studentsTable.$inferSelect;
        className: string;
      };
      type ImportRow = {
        className: string;
        firstName: string;
        lastName: string;
        providedId: string | null;
        email: string | null;
        secondaryEmail: string | null;
        phone: string | null;
        jobTitle: string | null;
        officeLocation: string | null;
        photoSession: string | null;
        captureNotes: string | null;
        hasEmail: boolean;
        hasSecondaryEmail: boolean;
        hasPhone: boolean;
        hasJobTitle: boolean;
        hasOfficeLocation: boolean;
        hasPhotoSession: boolean;
        hasCaptureNotes: boolean;
      };

      const existing = await tx
        .select({ student: studentsTable, className: classesTable.className })
        .from(studentsTable)
        .innerJoin(classesTable, eq(studentsTable.classId, classesTable.id))
        .where(eq(studentsTable.projectId, projectId));

      const working: WorkingStudent[] = existing.map((row) => ({
        student: row.student,
        className: row.className,
      }));
      const stableIndex = new Map<string, WorkingStudent[]>();
      const emailIndex = new Map<string, WorkingStudent[]>();
      const nameClassIndex = new Map<string, WorkingStudent[]>();
      const allocatedIds = new Set<string>();

      const addToIndex = (index: Map<string, WorkingStudent[]>, key: string, row: WorkingStudent) => {
        if (!key) return;
        const values = index.get(key) ?? [];
        values.push(row);
        index.set(key, values);
      };
      const removeFromIndex = (index: Map<string, WorkingStudent[]>, key: string, row: WorkingStudent) => {
        if (!key) return;
        const values = index.get(key);
        if (!values) return;
        const remaining = values.filter((value) => value !== row);
        if (remaining.length) index.set(key, remaining);
        else index.delete(key);
      };
      const indexKeys = (row: WorkingStudent) => ({
        stable: normalizeKey(row.student.generatedStudentId),
        emails: [normalizeKey(row.student.email), normalizeKey(row.student.secondaryEmail)]
          .filter((value, index, values) => value && values.indexOf(value) === index),
        nameClass: [
          normalizeKey(row.student.firstName),
          normalizeKey(row.student.lastName),
          normalizeKey(row.className),
        ].join("\u0000"),
      });
      const addToIndexes = (row: WorkingStudent) => {
        const keys = indexKeys(row);
        addToIndex(stableIndex, keys.stable, row);
        keys.emails.forEach((key) => addToIndex(emailIndex, key, row));
        addToIndex(nameClassIndex, keys.nameClass, row);
        allocatedIds.add(keys.stable);
      };
      const removeFromIndexes = (row: WorkingStudent) => {
        const keys = indexKeys(row);
        removeFromIndex(stableIndex, keys.stable, row);
        keys.emails.forEach((key) => removeFromIndex(emailIndex, key, row));
        removeFromIndex(nameClassIndex, keys.nameClass, row);
      };
      working.forEach(addToIndexes);

      let classesCreated = 0;
      let studentsCreated = 0;
      let studentsUpdated = 0;
      let studentsMoved = 0;
      let studentsSkipped = 0;
      let conflicts = 0;
      const classesByKey = new Map<string, typeof classesTable.$inferSelect>();
      const classes = await tx.select().from(classesTable).where(eq(classesTable.projectId, projectId));
      classes.forEach((cls) => {
        // Keep the first legacy class deterministically if old data contains
        // case-only duplicates; never create another one for that key.
        const key = normalizeKey(cls.className);
        if (key && !classesByKey.has(key)) classesByKey.set(key, cls);
      });
      const importRows: ImportRow[] = [];
      const inputStableIds = new Map<string, string>();

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
          captureNotesColumn,
          phoneColumn,
          rows,
          headers,
        } = sheet;
        if (!Array.isArray(headers) || !Array.isArray(rows)
          || headers.length > IMPORT_MAX_COLUMNS || rows.length > IMPORT_MAX_ROWS) {
          throw new ImportValidationError(
            `Each roster sheet is limited to ${IMPORT_MAX_ROWS} rows and ${IMPORT_MAX_COLUMNS} columns`,
          );
        }

        if (!className || !firstNameColumn || !lastNameColumn) {
          continue;
        }

        // Map column indices.
        const firstNameIdx = headers.indexOf(firstNameColumn);
        const lastNameIdx = headers.indexOf(lastNameColumn);
        const studentIdIdx = studentIdColumn ? headers.indexOf(studentIdColumn) : -1;
        const emailIdx = emailColumn ? headers.indexOf(emailColumn) : -1;
        const secondaryEmailIdx = secondaryEmailColumn ? headers.indexOf(secondaryEmailColumn) : -1;
        const jobTitleIdx = jobTitleColumn ? headers.indexOf(jobTitleColumn) : -1;
        const officeLocationIdx = officeLocationColumn ? headers.indexOf(officeLocationColumn) : -1;
        const photoSessionIdx = photoSessionColumn ? headers.indexOf(photoSessionColumn) : -1;
        const captureNotesIdx = captureNotesColumn ? headers.indexOf(captureNotesColumn) : -1;
        const phoneIdx = phoneColumn ? headers.indexOf(phoneColumn) : -1;

        if (firstNameIdx === -1 || lastNameIdx === -1) {
          continue;
        }

        const displayClassName = normalizeOptionalString(className);
        if (!displayClassName) continue;

        for (const row of rows) {
          if (!Array.isArray(row) || row.length > IMPORT_MAX_COLUMNS) {
            throw new ImportValidationError(`Roster rows cannot exceed ${IMPORT_MAX_COLUMNS} columns`);
          }
          const firstName = boundedCell(row[firstNameIdx]);
          const lastName = boundedCell(row[lastNameIdx]);

          if (!firstName && !lastName) continue;

          const providedId = studentIdIdx >= 0 ? normalizeOptionalString(row[studentIdIdx]) : null;
          if (providedId) {
            const idKey = normalizeKey(providedId);
            const prior = inputStableIds.get(idKey);
            if (prior !== undefined) {
              throw new ImportValidationError(
                `Duplicate Student ID/Employee ID "${providedId}" in import input (first seen as "${prior}")`,
              );
            }
            inputStableIds.set(idKey, providedId);
          }

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
          const captureNotes =
            captureNotesIdx >= 0 ? normalizeOptionalString(row[captureNotesIdx]) : null;
          importRows.push({
            className: displayClassName,
            firstName,
            lastName,
            providedId,
            email,
            secondaryEmail,
            phone,
            jobTitle,
            officeLocation,
            photoSession,
            captureNotes,
            hasEmail: emailIdx >= 0,
            hasSecondaryEmail: secondaryEmailIdx >= 0,
            hasPhone: phoneIdx >= 0,
            hasJobTitle: jobTitleIdx >= 0,
            hasOfficeLocation: officeLocationIdx >= 0,
            hasPhotoSession: photoSessionIdx >= 0,
            hasCaptureNotes: captureNotesIdx >= 0,
          });
        }
      }

      // Preflight duplicate contact identities before creating classes or
      // students. Identical repeated rows are deterministic skips; a
      // contradictory contact identity is never allowed to collapse into the
      // first newly-created student.
      const duplicateInputRows = new Set<number>();
      const conflictingInputRows = new Set<number>();
      const inputEmailRows = new Map<string, number[]>();
      const inputFingerprint = (input: ImportRow) => [
        normalizeKey(input.firstName),
        normalizeKey(input.lastName),
        normalizeKey(input.className),
        normalizeKey(input.providedId),
        normalizeKey(input.email),
        normalizeKey(input.secondaryEmail),
        normalizeKey(input.phone),
        normalizeKey(input.jobTitle),
        normalizeKey(input.officeLocation),
        normalizeKey(input.photoSession),
        normalizeKey(input.captureNotes),
        input.hasEmail,
        input.hasSecondaryEmail,
        input.hasPhone,
        input.hasJobTitle,
        input.hasOfficeLocation,
        input.hasPhotoSession,
        input.hasCaptureNotes,
      ].join("\u0000");
      importRows.forEach((input, rowIndex) => {
        const keys = [normalizeKey(input.email), normalizeKey(input.secondaryEmail)]
          .filter((value, index, values) => value && values.indexOf(value) === index);
        keys.forEach((key) => {
          const rowsForEmail = inputEmailRows.get(key) ?? [];
          rowsForEmail.push(rowIndex);
          inputEmailRows.set(key, rowsForEmail);
        });
      });
      inputEmailRows.forEach((rowIndexes) => {
        if (rowIndexes.length < 2) return;
        const firstFingerprint = inputFingerprint(importRows[rowIndexes[0]]);
        const identical = rowIndexes.every((rowIndex) => inputFingerprint(importRows[rowIndex]) === firstFingerprint);
        if (identical) rowIndexes.slice(1).forEach((rowIndex) => duplicateInputRows.add(rowIndex));
        else rowIndexes.forEach((rowIndex) => conflictingInputRows.add(rowIndex));
      });

      for (let rowIndex = 0; rowIndex < importRows.length; rowIndex++) {
        const input = importRows[rowIndex];
        if (conflictingInputRows.has(rowIndex)) {
          conflicts++;
          continue;
        }
        if (duplicateInputRows.has(rowIndex)) {
          studentsSkipped++;
          continue;
        }
        let targetClass = classesByKey.get(normalizeKey(input.className));
        if (!targetClass) {
          [targetClass] = await tx.insert(classesTable)
            .values({ projectId, className: input.className })
            .returning();
          classesByKey.set(normalizeKey(input.className), targetClass);
          classesCreated++;
        }
        const targetClassName = targetClass.className;
        const stableKey = normalizeKey(input.providedId);
        const primaryKey = normalizeKey(input.email);
        const secondaryKey = normalizeKey(input.secondaryEmail);
        const nameClassKey = [
          normalizeKey(input.firstName),
          normalizeKey(input.lastName),
          normalizeKey(targetClassName),
        ].join("\u0000");

        let matched: WorkingStudent | undefined;
        let ambiguous = false;
        const stableMatches = stableKey ? stableIndex.get(stableKey) ?? [] : [];
        if (stableMatches.length > 1) {
          ambiguous = true;
        } else if (stableMatches.length === 1) {
          matched = stableMatches[0];
          // A stable ID and an email pointing to different people is unsafe
          // to reconcile silently.
          const emailMatches = [
            ...(primaryKey ? emailIndex.get(primaryKey) ?? [] : []),
            ...(secondaryKey ? emailIndex.get(secondaryKey) ?? [] : []),
          ];
          if (emailMatches.some((candidate) => candidate !== matched)) ambiguous = true;
        } else if (primaryKey) {
          const matches = emailIndex.get(primaryKey) ?? [];
          if (matches.length > 1) ambiguous = true;
          else if (matches.length === 1) {
            matched = matches[0];
            const secondaryMatches = secondaryKey ? emailIndex.get(secondaryKey) ?? [] : [];
            if (secondaryMatches.some((candidate) => candidate !== matched)) ambiguous = true;
          }
        }
        if (!matched && !ambiguous && secondaryKey) {
          const matches = emailIndex.get(secondaryKey) ?? [];
          if (matches.length > 1) ambiguous = true;
          else if (matches.length === 1) matched = matches[0];
        }
        if (!matched && !ambiguous) {
          const matches = nameClassIndex.get(nameClassKey) ?? [];
          if (matches.length > 1) ambiguous = true;
          else if (matches.length === 1) matched = matches[0];
        }
        if (ambiguous) {
          conflicts++;
          continue;
        }

        if (!matched) {
          let generatedStudentId = input.providedId;
          if (!generatedStudentId) {
            const rawIds = new Set(working.map((row) => row.student.generatedStudentId));
            generatedStudentId = generateUniqueStudentId(rawIds);
            while (allocatedIds.has(normalizeKey(generatedStudentId))) {
              generatedStudentId = generateUniqueStudentId(rawIds);
            }
          }
          const [created] = await tx.insert(studentsTable).values({
            projectId,
            classId: targetClass.id,
            firstName: input.firstName,
            lastName: input.lastName,
            generatedStudentId,
            email: input.email,
            phone: input.phone,
            secondaryEmail: input.secondaryEmail,
            jobTitle: input.jobTitle,
            officeLocation: input.officeLocation,
            photoSession: input.photoSession,
            captureNotes: input.captureNotes,
          }).returning();
          const row: WorkingStudent = { student: created, className: targetClassName };
          working.push(row);
          addToIndexes(row);
          studentsCreated++;
          continue;
        }

        const old = matched.student;
        const oldClassName = matched.className;
        const classChanged = normalizeKey(oldClassName) !== normalizeKey(targetClassName);
        const next = {
          firstName: input.firstName,
          lastName: input.lastName,
          classId: targetClass.id,
          ...(input.hasEmail ? { email: input.email } : {}),
          ...(input.hasPhone ? { phone: input.phone } : {}),
          ...(input.hasSecondaryEmail ? { secondaryEmail: input.secondaryEmail } : {}),
          ...(input.hasJobTitle ? { jobTitle: input.jobTitle } : {}),
          ...(input.hasOfficeLocation ? { officeLocation: input.officeLocation } : {}),
          ...(input.hasPhotoSession ? { photoSession: input.photoSession } : {}),
          ...(input.hasCaptureNotes ? { captureNotes: input.captureNotes } : {}),
        };
        const changed =
          old.firstName !== next.firstName ||
          old.lastName !== next.lastName ||
          old.classId !== next.classId ||
          (input.hasEmail && old.email !== next.email) ||
          (input.hasPhone && old.phone !== next.phone) ||
          (input.hasSecondaryEmail && old.secondaryEmail !== next.secondaryEmail) ||
          (input.hasJobTitle && old.jobTitle !== next.jobTitle) ||
          (input.hasOfficeLocation && old.officeLocation !== next.officeLocation) ||
          (input.hasPhotoSession && old.photoSession !== next.photoSession) ||
          (input.hasCaptureNotes && old.captureNotes !== next.captureNotes);
        if (!changed) {
          studentsSkipped++;
          continue;
        }
        removeFromIndexes(matched);
        const [updated] = await tx.update(studentsTable)
          .set({ ...next, updatedAt: new Date() })
          .where(and(eq(studentsTable.id, old.id), eq(studentsTable.projectId, projectId)))
          .returning();
        matched.student = updated;
        matched.className = targetClassName;
        addToIndexes(matched);
        studentsUpdated++;
        if (classChanged) studentsMoved++;
      }

      // Update project updatedAt
      await tx
        .update(projectsTable)
        .set({ updatedAt: new Date() })
        .where(eq(projectsTable.id, projectId));

      return {
        classesCreated,
        studentsCreated,
        studentsUpdated,
        studentsMoved,
        studentsSkipped,
        conflicts,
      };
    });
  } catch (error) {
    if (error instanceof ImportValidationError) {
      res.status(400).json({ error: error.message });
      return;
    }
    if (isStudentIdUniqueViolation(error)) {
      // Do not leak the conflicting row or any roster PII. The unique index is
      // the authority when another import/create races this transaction.
      res.status(409).json({
        error: "A Student ID/Employee ID is already used in this project.",
        code: "STUDENT_ID_CONFLICT",
      });
      return;
    }
    throw error;
  }

  await reconcileDefaultGroups(projectId);

  res.json(result);
});

export default router;
