import { Router } from "express";
import JSZip from "jszip";
import multer from "multer";
import path from "path";
import fs from "fs";
import { Readable } from "node:stream";
import { db } from "@workspace/db";
import {
  capturesTable,
  captureBatchesTable,
  captureFilesTable,
  classesTable,
  projectsTable,
  studentsTable,
  studentPhotosTable,
  studiosTable,
  groupCapturesTable,
  groupCaptureFilesTable,
  groupsTable,
} from "@workspace/db";
import { eq, and, sql, inArray, isNull } from "drizzle-orm";
import type { NextFunction, Request, Response } from "express";
import { requireAuth, getUserId } from "../lib/auth";
import { getDesktopConnection, refreshDesktopConnection, requireDesktopConnection } from "../lib/desktopAuth";
import { canAccessDesktopProject, canAccessProject } from "../lib/studioAccess";
import { logger, logPhotoDeleteRecoveryAlert } from "../lib/logger";
import { canonicalStudentFolderName, GoogleDriveBackupError } from "../lib/googleDriveBackup";
import { backupFileForStudio } from "../lib/studioStorageBackup";
import { storePhotoDurably } from "../lib/durablePhotoStorage";
import { objectStorageService } from "../lib/objectStorage";
import {
  projectAvailableGroupJpegsToStudent,
  projectGroupJpegToPhotographedStudents,
} from "../lib/groupDeliveryPhotos";
import {
  createR2CopyUpload,
  sha256File,
} from "../lib/r2UploadCopies";
import { getR2Object } from "../lib/r2Storage";
import {
  ensureR2PhotoVariant,
  getVerifiedR2CopyForPhoto,
} from "../lib/photoVariants";
import { parseCaptureEditSettings } from "../lib/captureEdits";
import { enqueueR2PhotoDeletions } from "../lib/r2PhotoDeletionOutbox";

const router = Router({ mergeParams: true });

// ---------------------------------------------------------------------------
// Member-scoped desktop authentication — desktop app → server only (POST)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// File storage — uploads/student-photos/<projectId>/<studentId>/
// ---------------------------------------------------------------------------

const UPLOADS_ROOT = path.resolve(process.cwd(), "uploads", "student-photos");

const storage = multer.diskStorage({
  destination(req, _file, cb) {
    const { projectId, studentId } = req.params as { projectId: string; studentId: string };
    const dir = path.join(UPLOADS_ROOT, projectId, studentId);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename(_req, file, cb) {
    const ext = path.extname(file.originalname) || ".jpg";
    const base = path.basename(file.originalname, ext).replace(/[^a-zA-Z0-9_-]/g, "_");
    cb(null, `${Date.now()}_${base}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter(_req, file, cb) {
    const allowed = ["image/jpeg", "image/jpg", "image/png", "image/webp"];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Only JPEG, PNG and WebP images are accepted"));
    }
  },
});

const RAW_EXTENSIONS = new Set([".nef", ".nrw", ".cr2", ".cr3", ".arw", ".raf", ".orf", ".rw2", ".dng"]);
const JPEG_EXTENSIONS = new Set([".jpg", ".jpeg"]);

function captureFileRole(fileName: string): "JPEG" | "RAW" | null {
  const extension = path.extname(fileName).toLowerCase();
  if (JPEG_EXTENSIONS.has(extension)) return "JPEG";
  if (RAW_EXTENSIONS.has(extension)) return "RAW";
  return null;
}

function captureFileFormat(fileName: string): string {
  return path.extname(fileName).replace(/^\./, "").toUpperCase() || "UNKNOWN";
}

const captureUpload = multer({
  storage,
  limits: { fileSize: 500 * 1024 * 1024 },
  fileFilter(_req, file, cb) {
    if (captureFileRole(file.originalname)) {
      cb(null, true);
      return;
    }
    cb(new Error("Only JPEG and supported RAW camera files are accepted"));
  },
});

const groupCaptureUpload = multer({
  storage: multer.diskStorage({
    destination(req, _file, cb) {
      const dir = path.join(UPLOADS_ROOT, String(req.params.projectId), `group-${String(req.params.groupId)}`);
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename(_req, file, cb) {
      const ext = path.extname(file.originalname) || ".jpg";
      const base = path.basename(file.originalname, ext).replace(/[^a-zA-Z0-9_-]/g, "_");
      cb(null, `${Date.now()}_${base}${ext}`);
    },
  }),
  limits: { fileSize: 500 * 1024 * 1024 },
  fileFilter(_req, file, cb) {
    if (captureFileRole(file.originalname)) cb(null, true);
    else cb(new Error("Only JPEG and supported RAW camera files are accepted"));
  },
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolve the filesystem path for a stored photo given its fileUrl column */
function resolveFilePath(fileUrl: string): string {
  // fileUrl is stored as /uploads/student-photos/... — strip leading slash
  return path.join(process.cwd(), fileUrl.replace(/^\//, ""));
}

/** Verify the student belongs to the project */
async function verifyStudent(studentId: number, projectId: number): Promise<boolean> {
  const [student] = await db
    .select({ id: studentsTable.id })
    .from(studentsTable)
    .where(and(eq(studentsTable.id, studentId), eq(studentsTable.projectId, projectId)));
  return !!student;
}

async function verifyGroup(groupId: number, projectId: number): Promise<boolean> {
  const [group] = await db.select({ id: groupsTable.id }).from(groupsTable)
    .where(and(eq(groupsTable.id, groupId), eq(groupsTable.projectId, projectId)));
  return !!group;
}

async function resolveCaptureBatch(
  projectId: number,
  batchKey: string | undefined,
  connectionId: number,
) {
  if (!batchKey) return null;
  const [batch] = await db
    .select()
    .from(captureBatchesTable)
    .where(and(
      eq(captureBatchesTable.projectId, projectId),
      eq(captureBatchesTable.batchKey, batchKey),
      eq(captureBatchesTable.desktopConnectionId, connectionId),
    ))
    .limit(1);
  return batch ?? undefined;
}

async function attachSupersededBatchFile<T extends {
  id: number;
  captureBatchId: number | null;
  clientUploadId: string | null;
}>(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  table: typeof captureFilesTable | typeof groupCaptureFilesTable | typeof studentPhotosTable,
  file: T,
  replacementBatch: typeof captureBatchesTable.$inferSelect | null | undefined,
  clientUploadId: string | null,
): Promise<T> {
  if (!clientUploadId || file.clientUploadId !== clientUploadId
    || !replacementBatch?.supersedesBatchId || file.captureBatchId !== replacementBatch.supersedesBatchId) return file;
  const [attached] = await tx.update(table as typeof captureFilesTable)
    .set({ captureBatchId: replacementBatch.id })
    .where(and(
      eq((table as typeof captureFilesTable).id, file.id),
      eq((table as typeof captureFilesTable).captureBatchId, replacementBatch.supersedesBatchId),
    ))
    .returning();
  return (attached ?? file) as T;
}

function validRouteId(value: string | string[] | undefined): value is string {
  return typeof value === "string" && /^[1-9]\d*$/.test(value);
}

function validateDesktopUploadPath(req: Request, res: Response, next: NextFunction): void {
  if (!validRouteId(req.params.projectId) || !validRouteId(req.params.studentId)) {
    res.status(400).json({ error: "Invalid projectId or studentId" });
    return;
  }
  next();
}

function validateGroupUploadPath(req: Request, res: Response, next: NextFunction): void {
  if (!validRouteId(req.params.projectId) || !validRouteId(req.params.groupId)) {
    res.status(400).json({ error: "Invalid projectId or groupId" });
    return;
  }
  next();
}

function connectionAccessMember(connection: ReturnType<typeof getDesktopConnection>) {
  return {
    id: connection.memberId,
    studioId: connection.studioId,
    role: connection.memberRole,
    userId: connection.memberUserId,
  };
}

function normalizeCaptureReviewFlags(flags: {
  favorite: boolean;
  rejected: boolean;
  selected: boolean;
}): Pick<typeof flags, "favorite" | "rejected" | "selected"> {
  // A rejected capture cannot also be selected. Rejection wins when a stale
  // client sends both values in one request.
  return {
    favorite: flags.favorite,
    rejected: flags.rejected,
    selected: flags.rejected ? false : flags.selected,
  };
}

async function authorizeDesktopUploadTarget(req: Request, res: Response, next: NextFunction): Promise<void> {
  const projectId = Number(req.params.projectId);
  const studentId = Number(req.params.studentId);
  if (!(await canAccessDesktopProject(connectionAccessMember(getDesktopConnection(req)), projectId))) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  if (!(await verifyStudent(studentId, projectId))) {
    res.status(404).json({ error: "Student not found in this project" });
    return;
  }
  next();
}

async function authorizeDesktopGroupUploadTarget(req: Request, res: Response, next: NextFunction): Promise<void> {
  const projectId = Number(req.params.projectId);
  const groupId = Number(req.params.groupId);
  const connection = getDesktopConnection(req);
  if (!(await canAccessDesktopProject(connectionAccessMember(connection), projectId))) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  if (!(await verifyGroup(groupId, projectId))) {
    res.status(404).json({ error: "Group not found in this project" });
    return;
  }
  next();
}

function discardUploadedFile(req: Request): void {
  if (!req.file) return;
  try {
    fs.unlinkSync(req.file.path);
  } catch {
    // The upload did not finish writing or the file was already removed.
  }
}

type PhotoDeleteBackup = {
  directory: string;
  filePath: string;
};

type DiscoveredPhotoDeleteBackup = PhotoDeleteBackup & {
  originalPath: string;
  fileUrl: string;
};

const PHOTO_DELETE_RECOVERY_ALERT_MARKER = ".photo-delete-recovery-alerted";

function persistPhotoDeleteRecoveryAlert(
  backupPath: string,
  originalPath: string | null,
): boolean {
  const markerPath = path.join(backupPath, PHOTO_DELETE_RECOVERY_ALERT_MARKER);
  try {
    fs.writeFileSync(markerPath, "", { flag: "wx" });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return false;
    }

    logger.warn(
      { err: error, backupPath, originalPath },
      "Could not persist a photo deletion recovery alert marker",
    );
    return true;
  }
}

function alertPhotoDeleteRecoveryRequired(
  reason: Parameters<typeof logPhotoDeleteRecoveryAlert>[0]["reason"],
  backupPath: string,
  originalPath: string | null,
  error?: unknown,
  markerDirectory = backupPath,
): void {
  if (!persistPhotoDeleteRecoveryAlert(markerDirectory, originalPath)) {
    return;
  }
  logPhotoDeleteRecoveryAlert({ reason, backupPath, originalPath, error });
}

function createPhotoDeleteBackup(filePath: string): PhotoDeleteBackup {
  if (!fs.existsSync(filePath)) {
    throw new Error("Photo file not found on server; deletion aborted");
  }

  const directory = fs.mkdtempSync(path.join(path.dirname(filePath), ".photo-delete-"));
  const backupPath = path.join(directory, path.basename(filePath));
  try {
    fs.copyFileSync(filePath, backupPath, fs.constants.COPYFILE_EXCL);
  } catch (error) {
    try {
      fs.rmSync(directory, { recursive: true, force: true });
    } catch (cleanupError) {
      console.error("Could not clean up a failed photo deletion backup", {
        error: cleanupError,
        backupPath,
      });
    }
    throw error;
  }

  return { directory, filePath: backupPath };
}

function removePhotoDeleteBackup(backup: PhotoDeleteBackup): void {
  fs.rmSync(backup.directory, { recursive: true, force: true });
}

function photoFileUrl(filePath: string): string {
  const relativePath = path.relative(process.cwd(), filePath).replace(/\\/g, "/");
  return `/${relativePath}`;
}

function discoverPhotoDeleteBackups(): DiscoveredPhotoDeleteBackup[] {
  const discovered: DiscoveredPhotoDeleteBackup[] = [];

  function visit(directory: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      console.error("Could not inspect a photo deletion directory", { error, directory });
      return;
    }

    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory() && entry.name.startsWith(".photo-delete-")) {
        let backupEntries: fs.Dirent[];
        try {
          backupEntries = fs.readdirSync(entryPath, { withFileTypes: true });
        } catch (error) {
          alertPhotoDeleteRecoveryRequired(
            "backup_directory_inspection_failed",
            entryPath,
            null,
            error,
          );
          continue;
        }

        const backupContents = backupEntries.filter(
          (backupEntry) => backupEntry.name !== PHOTO_DELETE_RECOVERY_ALERT_MARKER,
        );
        const backupFiles = backupContents.filter((backupEntry) => backupEntry.isFile());
        if (backupFiles.length !== 1 || backupContents.length !== 1) {
          // A process may have stopped before the copy completed, or a backup
          // may have been tampered with. There is no safe original path to
          // reconcile in that case, so leave it for manual inspection.
          if (backupContents.length > 0) {
            const possibleOriginalPath =
              backupFiles.length === 1 ? path.join(directory, backupFiles[0].name) : null;
            alertPhotoDeleteRecoveryRequired(
              "backup_contents_ambiguous",
              entryPath,
              possibleOriginalPath,
            );
          } else {
            // Empty temporary directories contain no uploaded bytes and can
            // be removed without making a recovery decision.
            try {
              removePhotoDeleteBackup({ directory: entryPath, filePath: "" });
            } catch (error) {
              console.error("Could not clean up an empty photo deletion backup", {
                error,
                backupDirectory: entryPath,
              });
            }
          }
          continue;
        }

        const backupFile = backupFiles[0];
        const originalPath = path.join(directory, backupFile.name);
        discovered.push({
          directory: entryPath,
          filePath: path.join(entryPath, backupFile.name),
          originalPath,
          fileUrl: photoFileUrl(originalPath),
        });
        continue;
      }

      if (entry.isDirectory()) {
        visit(entryPath);
      }
    }
  }

  if (fs.existsSync(UPLOADS_ROOT)) {
    visit(UPLOADS_ROOT);
  }
  return discovered;
}

/**
 * Reconcile deletion backups left behind by a process interruption.
 *
 * The database row is authoritative:
 * - A surviving row plus a missing original gets its original bytes restored.
 * - A surviving original is never overwritten, even if a backup exists.
 * - A deleted row permits cleanup of both the backup and its now-unreferenced
 *   original file.
 */
export async function recoverPhotoDeleteBackups(): Promise<void> {
  const backups = discoverPhotoDeleteBackups();

  for (const backup of backups) {
    try {
      const [photo] = await db
        .select()
        .from(studentPhotosTable)
        .where(eq(studentPhotosTable.fileUrl, backup.fileUrl))
        .limit(1);
      const originalExists = fs.existsSync(backup.originalPath);

      if (photo) {
        if (!originalExists) {
          fs.copyFileSync(backup.filePath, backup.originalPath, fs.constants.COPYFILE_EXCL);
          if (!fs.existsSync(backup.originalPath)) {
            throw new Error("Restored photo file was not found after copying");
          }
        }
        removePhotoDeleteBackup(backup);
        continue;
      }

      // The row deletion is durable. Only remove an original after confirming
      // there is no database row that points at this path, so a valid photo
      // can never be deleted as part of backup cleanup.
      if (originalExists) {
        const [referencingPhoto] = await db
          .select({ id: studentPhotosTable.id })
          .from(studentPhotosTable)
          .where(eq(studentPhotosTable.fileUrl, backup.fileUrl))
          .limit(1);
        if (!referencingPhoto) {
          fs.unlinkSync(backup.originalPath);
        }
      }
      removePhotoDeleteBackup(backup);
    } catch (error) {
      // Keep the backup when any part of reconciliation is uncertain. It is
      // the durable copy that makes a later retry safe.
      alertPhotoDeleteRecoveryRequired(
        "backup_reconciliation_failed",
        backup.filePath,
        backup.originalPath,
        error,
        backup.directory,
      );
    }
  }
}

function restoreDeletedPhotoFile(
  filePath: string,
  backup: PhotoDeleteBackup,
): void {
  if (!fs.existsSync(filePath)) {
    fs.copyFileSync(backup.filePath, filePath, fs.constants.COPYFILE_EXCL);
  }
}

function photoToResponse(photo: typeof studentPhotosTable.$inferSelect) {
  return {
    id: photo.id,
    projectId: photo.projectId,
    studentId: photo.studentId,
    fileName: photo.fileName,
    fileUrl: photo.fileUrl,
    mimeType: photo.mimeType,
    rating: photo.rating,
    colorLabel: photo.colorLabel,
    shareWithParents: photo.shareWithParents,
    sourceGroupCaptureFileId: photo.sourceGroupCaptureFileId,
    capturedAt: photo.capturedAt,
    createdAt: photo.createdAt.toISOString(),
  };
}

function captureStatusForFiles(files: Array<{ fileRole: string }>): "jpeg_only" | "raw_only" | "complete" {
  const hasJpeg = files.some((file) => file.fileRole === "JPEG");
  const hasRaw = files.some((file) => file.fileRole === "RAW");
  if (hasJpeg && hasRaw) return "complete";
  return hasJpeg ? "jpeg_only" : "raw_only";
}

function captureFileToResponse(file: typeof captureFilesTable.$inferSelect) {
  return {
    id: file.id,
    fileRole: file.fileRole,
    fileFormat: file.fileFormat,
    originalFilename: file.originalFilename,
    fileUrl: file.fileUrl,
    mimeType: file.mimeType,
    fileSize: file.fileSize,
  };
}

type WebCaptureExportMode =
  | "all"
  | "paired"
  | "jpeg_only"
  | "raw_only"
  | "selected"
  | "favorite"
  | "final_selection";

function webCaptureExportMode(value: unknown): WebCaptureExportMode | null {
  const normalized = String(value ?? "all").trim().toLowerCase().replace(/-/g, "_");
  return ["all", "paired", "jpeg_only", "raw_only", "selected", "favorite", "final_selection"].includes(normalized)
    ? normalized as WebCaptureExportMode
    : null;
}

function captureMatchesExportMode(capture: typeof capturesTable.$inferSelect, mode: WebCaptureExportMode): boolean {
  switch (mode) {
    case "paired":
      return capture.pairingStatus === "complete";
    case "jpeg_only":
      return capture.pairingStatus === "jpeg_only";
    case "raw_only":
      return capture.pairingStatus === "raw_only";
    case "selected":
      return capture.selected;
    case "favorite":
      return capture.favorite;
    case "final_selection":
      return capture.selected && !capture.rejected;
    case "all":
      return true;
  }
}

function safeCaptureExportName(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100) || "capture";
}

function webCaptureFileUrl(projectId: number, captureId: number, fileId: number): string {
  return `/api/projects/${projectId}/captures/${captureId}/files/${fileId}/file`;
}

function webCaptureToResponse(
  capture: typeof capturesTable.$inferSelect,
  files: typeof captureFilesTable.$inferSelect[],
  projectId: number,
) {
  return {
    id: capture.id,
    captureKey: capture.captureKey,
    baseFilename: capture.baseFilename,
    capturedAt: capture.capturedAt,
    sequence: capture.sequence,
    pairingStatus: capture.pairingStatus,
    favorite: capture.favorite,
    rejected: capture.rejected,
    selected: capture.selected,
    rating: capture.rating,
    colorLabel: capture.colorLabel,
    createdAt: capture.createdAt.toISOString(),
    updatedAt: capture.updatedAt.toISOString(),
    files: files.map((file) => ({
      id: file.id,
      fileRole: file.fileRole,
      fileFormat: file.fileFormat,
      originalFilename: file.originalFilename,
      mimeType: file.mimeType,
      fileSize: file.fileSize,
      url: webCaptureFileUrl(projectId, capture.id, file.id),
    })),
  };
}

async function captureFileBytes(file: typeof captureFilesTable.$inferSelect): Promise<Buffer> {
  if (file.durableObjectPath) {
    const object = await objectStorageService.getObjectEntityFile(file.durableObjectPath);
    const [bytes] = await object.download();
    return bytes;
  }
  return fs.promises.readFile(resolveFilePath(file.fileUrl));
}

// GET /api/projects/:projectId/captures
// Web app: list the complete capture review surface grouped by student.
router.get("/", requireAuth, async (req, res): Promise<void> => {
  const projectId = Number(req.params.projectId);
  if (!Number.isSafeInteger(projectId) || projectId <= 0) {
    res.status(400).json({ error: "Invalid projectId" });
    return;
  }
  if (!(await canAccessProject(getUserId(req), projectId, "view"))) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const [students, captures] = await Promise.all([
    db.select({
      id: studentsTable.id,
      firstName: studentsTable.firstName,
      lastName: studentsTable.lastName,
      generatedStudentId: studentsTable.generatedStudentId,
      className: classesTable.className,
    })
      .from(studentsTable)
      .leftJoin(classesTable, eq(studentsTable.classId, classesTable.id))
      .where(eq(studentsTable.projectId, projectId))
      .orderBy(classesTable.className, studentsTable.lastName, studentsTable.firstName),
    db.select()
      .from(capturesTable)
      .where(eq(capturesTable.projectId, projectId))
      .orderBy(capturesTable.sequence, capturesTable.createdAt),
  ]);

  const files = captures.length
    ? await db.select().from(captureFilesTable).where(inArray(captureFilesTable.captureId, captures.map((capture) => capture.id)))
    : [];
  const filesByCapture = new Map<number, typeof files>();
  for (const file of files) {
    const captureFiles = filesByCapture.get(file.captureId) ?? [];
    captureFiles.push(file);
    filesByCapture.set(file.captureId, captureFiles);
  }
  const capturesByStudent = new Map<number, ReturnType<typeof webCaptureToResponse>[]>();
  for (const capture of captures) {
    const studentCaptures = capturesByStudent.get(capture.studentId) ?? [];
    studentCaptures.push(webCaptureToResponse(capture, filesByCapture.get(capture.id) ?? [], projectId));
    capturesByStudent.set(capture.studentId, studentCaptures);
  }

  const groups = students
    .map((student) => ({
      studentId: student.id,
      firstName: student.firstName,
      lastName: student.lastName,
      generatedStudentId: student.generatedStudentId,
      className: student.className,
      captures: capturesByStudent.get(student.id) ?? [],
    }))
    .filter((student) => student.captures.length > 0);

  const totals = captures.reduce(
    (summary, capture) => {
      summary.captures += 1;
      if (capture.pairingStatus === "complete") summary.complete += 1;
      else if (capture.pairingStatus === "jpeg_only") summary.jpegOnly += 1;
      else if (capture.pairingStatus === "raw_only") summary.rawOnly += 1;
      return summary;
    },
    { captures: 0, complete: 0, jpegOnly: 0, rawOnly: 0 },
  );

  res.json({ projectId, students: groups, totals });
});

// GET /api/projects/:projectId/captures/export?mode=paired
// Web app: download selected capture members without exposing storage paths.
router.get("/export", requireAuth, async (req, res): Promise<void> => {
  const projectId = Number(req.params.projectId);
  const mode = webCaptureExportMode(req.query.mode ?? req.query.filter);
  if (!Number.isSafeInteger(projectId) || projectId <= 0) {
    res.status(400).json({ error: "Invalid projectId" });
    return;
  }
  if (!mode) {
    res.status(400).json({ error: "Invalid capture export mode" });
    return;
  }
  if (!(await canAccessProject(getUserId(req), projectId, "view"))) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const [project] = await db.select({
    schoolName: projectsTable.schoolName,
  }).from(projectsTable).where(eq(projectsTable.id, projectId)).limit(1);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const captures = await db.select()
    .from(capturesTable)
    .where(eq(capturesTable.projectId, projectId))
    .orderBy(capturesTable.sequence, capturesTable.createdAt);
  const matchingCaptures = captures.filter((capture) => captureMatchesExportMode(capture, mode));
  const files = matchingCaptures.length
    ? await db.select().from(captureFilesTable).where(inArray(captureFilesTable.captureId, matchingCaptures.map((capture) => capture.id)))
    : [];
  const filesByCapture = new Map<number, typeof files>();
  for (const file of files) {
    const captureFiles = filesByCapture.get(file.captureId) ?? [];
    captureFiles.push(file);
    filesByCapture.set(file.captureId, captureFiles);
  }
  const studentIds = [...new Set(matchingCaptures.map((capture) => capture.studentId))];
  const students = studentIds.length
    ? await db.select({
      id: studentsTable.id,
      firstName: studentsTable.firstName,
      lastName: studentsTable.lastName,
    }).from(studentsTable).where(inArray(studentsTable.id, studentIds))
    : [];
  const studentById = new Map(students.map((student) => [student.id, student]));

  const zip = new JSZip();
  for (const capture of matchingCaptures) {
    const student = studentById.get(capture.studentId);
    const studentName = safeCaptureExportName(student ? `${student.lastName}_${student.firstName}` : `student-${capture.studentId}`);
    const sequence = String(capture.sequence ?? capture.id).padStart(6, "0");
    const folder = `${studentName}/${sequence}_${safeCaptureExportName(capture.baseFilename)}`;
    for (const file of filesByCapture.get(capture.id) ?? []) {
      try {
        zip.file(`${folder}/${safeCaptureExportName(file.originalFilename)}`, await captureFileBytes(file));
      } catch {
        // Omit a missing member while preserving other valid capture files.
      }
    }
  }

  const zipBuffer = await zip.generateAsync({ type: "nodebuffer" });
  const safeProjectName = safeCaptureExportName(project.schoolName);
  res.set("Content-Type", "application/zip");
  res.set("Content-Disposition", `attachment; filename="${safeProjectName}_${mode}_captures.zip"`);
  res.send(zipBuffer);
});

// GET /api/projects/:projectId/captures/:captureId/files/:fileId/file
// Web app: authenticated file proxy for either a JPEG or RAW member.
router.get("/:captureId/files/:fileId/file", requireAuth, async (req, res): Promise<void> => {
  const projectId = Number(req.params.projectId);
  const captureId = Number(req.params.captureId);
  const fileId = Number(req.params.fileId);
  if (![projectId, captureId, fileId].every((value) => Number.isSafeInteger(value) && value > 0)) {
    res.status(400).json({ error: "Invalid capture file parameters" });
    return;
  }
  if (!(await canAccessProject(getUserId(req), projectId, "view"))) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const [result] = await db.select({ file: captureFilesTable, capture: capturesTable })
    .from(captureFilesTable)
    .innerJoin(capturesTable, eq(captureFilesTable.captureId, capturesTable.id))
    .where(and(
      eq(captureFilesTable.id, fileId),
      eq(captureFilesTable.captureId, captureId),
      eq(capturesTable.id, captureId),
      eq(capturesTable.projectId, projectId),
    ))
    .limit(1);
  if (!result) {
    res.status(404).json({ error: "Capture file not found" });
    return;
  }

  const fileName = result.file.originalFilename.replace(/["\r\n]/g, "_");
  res.setHeader("Content-Type", result.file.mimeType || "application/octet-stream");
  res.setHeader("Content-Disposition", `inline; filename="${fileName}"`);
  res.setHeader("Cache-Control", "private, max-age=3600");
  if (result.file.durableObjectPath) {
    const object = await objectStorageService.getObjectEntityFile(result.file.durableObjectPath);
    object.createReadStream().pipe(res);
    return;
  }
  const filePath = resolveFilePath(result.file.fileUrl);
  if (!fs.existsSync(filePath)) {
    res.status(404).json({ error: "Capture file not found on server" });
    return;
  }
  res.sendFile(filePath);
});

async function backupUploadedFile(
  projectId: number,
  studentId: number,
  filePath: string,
  fileName: string,
  fileRole: "JPEG" | "RAW",
  fileFormat: string,
  backupKey: string,
): Promise<void> {
  const [context] = await db
    .select({
      studioId: studiosTable.id,
      studioName: studiosTable.name,
      schoolName: projectsTable.schoolName,
      classId: classesTable.id,
      className: classesTable.className,
      generatedStudentId: studentsTable.generatedStudentId,
      firstName: studentsTable.firstName,
      lastName: studentsTable.lastName,
    })
    .from(studentsTable)
    .innerJoin(projectsTable, eq(projectsTable.id, studentsTable.projectId))
    .innerJoin(studiosTable, eq(studiosTable.id, projectsTable.studioId))
    .innerJoin(classesTable, eq(classesTable.id, studentsTable.classId))
    .where(and(
      eq(studentsTable.id, studentId),
      eq(studentsTable.projectId, projectId),
    ));

  if (!context) {
    throw new GoogleDriveBackupError("Could not resolve the project, class, or student for Drive backup.");
  }

  await backupFileForStudio({
    studioId: context.studioId,
    studioName: context.studioName,
    projectId,
    schoolName: context.schoolName,
    classId: context.classId,
    className: context.className,
    studentId,
    studentFolderName: canonicalStudentFolderName(
      context.firstName,
      context.lastName,
      context.generatedStudentId,
    ),
    filePath,
    fileName,
    fileRole,
    fileFormat,
    backupKey,
  });
}

async function backupGroupUploadedFile(projectId: number, groupId: number, filePath: string, fileName: string, role: "JPEG" | "RAW", format: string, key: string) {
  const [context] = await db.select({
    studioId: studiosTable.id, studioName: studiosTable.name, schoolName: projectsTable.schoolName,
    classId: classesTable.id, className: classesTable.className,
  }).from(groupsTable)
    .innerJoin(projectsTable, eq(projectsTable.id, groupsTable.projectId))
    .innerJoin(studiosTable, eq(studiosTable.id, projectsTable.studioId))
    .leftJoin(classesTable, eq(classesTable.id, groupsTable.classId))
    .where(and(eq(groupsTable.id, groupId), eq(groupsTable.projectId, projectId)));
  if (!context) throw new GoogleDriveBackupError("Could not resolve group for Drive backup.");
  await backupFileForStudio({
    studioId: context.studioId, studioName: context.studioName, projectId,
    schoolName: context.schoolName, classId: context.classId ?? 0,
    className: context.className ?? "Groups", studentId: groupId,
    studentFolderName: `Group_${groupId}`, filePath, fileName, fileRole: role,
    fileFormat: format, backupKey: key, subjectType: "group",
  });
}

/** Materialize the current capture pipeline into the legacy delivery table.
 * JPEG is the delivery representation; RAW files never create gallery rows.
 * The desktop connection/upload identity makes retries idempotent.
 */
async function projectCaptureJpegToDeliveryPhoto(
  capture: typeof capturesTable.$inferSelect,
  file: typeof captureFilesTable.$inferSelect,
): Promise<void> {
  if (file.fileRole !== "JPEG" || !file.durableObjectPath) return;
  const existing = await db.select({ id: studentPhotosTable.id })
    .from(studentPhotosTable)
    .where(and(
      eq(studentPhotosTable.projectId, capture.projectId),
      eq(studentPhotosTable.studentId, capture.studentId),
      eq(studentPhotosTable.fileName, file.originalFilename),
    )).limit(1);
  if (!existing.length) {
    await db.insert(studentPhotosTable).values({
      projectId: capture.projectId,
      studentId: capture.studentId,
      fileName: file.originalFilename,
      fileUrl: file.fileUrl,
      durableObjectPath: file.durableObjectPath,
      mimeType: file.mimeType,
      capturedAt: capture.capturedAt,
      desktopConnectionId: file.desktopConnectionId,
      clientUploadId: file.clientUploadId,
      rating: capture.rating,
      colorLabel: capture.colorLabel,
      shareWithParents: capture.colorLabel === "green",
    }).onConflictDoNothing();
  }
  await projectAvailableGroupJpegsToStudent(capture.projectId, capture.studentId);
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// POST /api/desktop/projects/:projectId/groups/:groupId/captures
router.get("/projects/:projectId/groups/:groupId/captures", requireDesktopConnection, async (req, res) => {
  const projectId = Number(req.params.projectId), groupId = Number(req.params.groupId);
  const connection = getDesktopConnection(req);
  if (!(await canAccessDesktopProject(connectionAccessMember(connection), projectId)) || !(await verifyGroup(groupId, projectId))) {
    res.status(404).json({ error: "Project or group not found" }); return;
  }
  const captures = await db.select().from(groupCapturesTable).where(eq(groupCapturesTable.groupId, groupId)).orderBy(groupCapturesTable.createdAt);
  const files = captures.length ? await db.select().from(groupCaptureFilesTable).where(inArray(groupCaptureFilesTable.captureId, captures.map(c => c.id))) : [];
  res.json(captures.map(c => ({ ...c, files: files.filter(f => f.captureId === c.id) })));
});

router.post("/projects/:projectId/groups/:groupId/captures", requireDesktopConnection, validateGroupUploadPath, authorizeDesktopGroupUploadTarget, groupCaptureUpload.single("file"), async (req, res, next) => {
  const projectId = Number(req.params.projectId), groupId = Number(req.params.groupId);
  const connection = getDesktopConnection(req);
  try {
  if (!Number.isSafeInteger(projectId) || projectId <= 0 || !Number.isSafeInteger(groupId) || groupId <= 0
      || !(await canAccessDesktopProject(connectionAccessMember(connection), projectId))
      || !(await verifyGroup(groupId, projectId))) {
      discardUploadedFile(req); res.status(404).json({ error: "Project or group not found" }); return;
    }
    const refreshed = await refreshDesktopConnection(connection.connectionId);
    if (!refreshed) { discardUploadedFile(req); res.status(401).json({ error: "Desktop connection was revoked while uploading" }); return; }
    if (!req.file) { res.status(400).json({ error: "No capture file uploaded (use field name 'file')" }); return; }
    const body = req.body as Record<string, string | undefined>;
    const role = captureFileRole(req.file.originalname);
    const captureKey = body.captureKey?.trim();
    const clientUploadId = req.get("X-MC-Upload-Id")?.trim() || null;
    if (!role || !captureKey || captureKey.length > 500 || (clientUploadId && !/^[a-zA-Z0-9:_-]{1,200}$/.test(clientUploadId))) {
      discardUploadedFile(req); res.status(400).json({ error: "Valid captureKey, file role, and upload identifier are required" }); return;
    }
     const captureBatchKey = req.get("X-MC-Capture-Batch")?.trim();
     const captureBatch = await resolveCaptureBatch(projectId, captureBatchKey, connection.connectionId);
     if (captureBatchKey && !captureBatch) {
       discardUploadedFile(req); res.status(409).json({ error: "Capture batch was not found for this desktop connection" }); return;
     }
    const relPath = path.relative(path.resolve(process.cwd(), "uploads"), req.file.path).replace(/\\/g, "/");
    const fileUrl = `/uploads/${relPath}`;
    const result = await db.transaction(async (tx) => {
      if (clientUploadId) {
        const [existing] = await tx.select({ file: groupCaptureFilesTable, capture: groupCapturesTable })
          .from(groupCaptureFilesTable).innerJoin(groupCapturesTable, eq(groupCaptureFilesTable.captureId, groupCapturesTable.id))
          .where(and(eq(groupCaptureFilesTable.desktopConnectionId, connection.connectionId), eq(groupCaptureFilesTable.clientUploadId, clientUploadId))).limit(1);
        if (existing) {
          if (existing.capture.projectId !== projectId || existing.capture.groupId !== groupId) throw new Error("Desktop upload identifier was reused for a different group");
          if (captureBatch && existing.file.captureBatchId === null) {
            const [attached] = await tx.update(groupCaptureFilesTable)
              .set({ captureBatchId: captureBatch.id })
              .where(and(
                eq(groupCaptureFilesTable.id, existing.file.id),
                isNull(groupCaptureFilesTable.captureBatchId),
              ))
              .returning();
            if (attached) return { capture: existing.capture, file: attached, backupFilePath: req.file!.path, reused: true };
            const [current] = await tx.select().from(groupCaptureFilesTable)
              .where(eq(groupCaptureFilesTable.id, existing.file.id)).limit(1);
            return { capture: existing.capture, file: current ?? existing.file, backupFilePath: req.file!.path, reused: true };
          }
          return {
            capture: existing.capture,
            file: await attachSupersededBatchFile(tx, groupCaptureFilesTable, existing.file, captureBatch, clientUploadId),
            backupFilePath: req.file!.path,
            reused: true,
          };
        }
      }
      let [capture] = await tx.select().from(groupCapturesTable).where(and(eq(groupCapturesTable.projectId, projectId), eq(groupCapturesTable.captureKey, captureKey))).limit(1);
      if (capture && capture.groupId !== groupId) throw new Error("Capture key was already assigned to a different group");
      if (!capture) [capture] = await tx.insert(groupCapturesTable).values({
        projectId, groupId, captureKey, baseFilename: body.baseFilename?.trim() || path.basename(req.file!.originalname, path.extname(req.file!.originalname)),
        capturedAt: body.capturedAt?.trim() || null, sequence: body.sequence ? Number(body.sequence) : null,
        pairingStatus: role === "JPEG" ? "jpeg_only" : "raw_only",
        rating: Math.max(0, Math.min(5, Number.parseInt(body.rating ?? "0", 10) || 0)),
      }).returning();
      const [existingRole] = await tx.select().from(groupCaptureFilesTable).where(and(eq(groupCaptureFilesTable.captureId, capture.id), eq(groupCaptureFilesTable.fileRole, role))).limit(1);
      if (existingRole) {
        const resumedFile = await attachSupersededBatchFile(tx, groupCaptureFilesTable, existingRole, captureBatch, clientUploadId);
        if (
          captureBatch
          && existingRole.captureBatchId === null
          && existingRole.desktopConnectionId === connection.connectionId
        ) {
          const [attached] = await tx.update(groupCaptureFilesTable)
            .set({ captureBatchId: captureBatch.id })
            .where(and(
              eq(groupCaptureFilesTable.id, existingRole.id),
              isNull(groupCaptureFilesTable.captureBatchId),
            ))
            .returning();
          if (attached) return { capture, file: attached, backupFilePath: req.file!.path, reused: true };
          const [current] = await tx.select().from(groupCaptureFilesTable)
            .where(eq(groupCaptureFilesTable.id, existingRole.id)).limit(1);
          return { capture, file: current ?? existingRole, backupFilePath: req.file!.path, reused: true };
        }
        return { capture, file: resumedFile, backupFilePath: req.file!.path, reused: true };
      }
      const [file] = await tx.insert(groupCaptureFilesTable).values({
        captureId: capture.id, fileRole: role, fileFormat: captureFileFormat(req.file!.originalname),
        originalFilename: req.file!.originalname, fileUrl, mimeType: req.file!.mimetype || "application/octet-stream", fileSize: req.file!.size,
        desktopConnectionId: connection.connectionId, clientUploadId,
         captureBatchId: captureBatch?.id ?? null,
      }).returning();
      const files = await tx.select({ fileRole: groupCaptureFilesTable.fileRole }).from(groupCaptureFilesTable).where(eq(groupCaptureFilesTable.captureId, capture.id));
      [capture] = await tx.update(groupCapturesTable).set({ pairingStatus: captureStatusForFiles(files), updatedAt: new Date() }).where(eq(groupCapturesTable.id, capture.id)).returning();
      return { capture, file, backupFilePath: req.file!.path, reused: false };
    });
    let uploadedGroupFile = result.file;
    if (uploadedGroupFile.fileRole === "JPEG" && !uploadedGroupFile.durableObjectPath) {
      try {
        const durableObjectPath = await storePhotoDurably(req.file.path, req.file.mimetype || "image/jpeg");
        const [updatedFile] = await db.update(groupCaptureFilesTable)
          .set({ durableObjectPath })
          .where(and(
            eq(groupCaptureFilesTable.id, uploadedGroupFile.id),
            isNull(groupCaptureFilesTable.durableObjectPath),
          ))
          .returning();
        if (updatedFile) uploadedGroupFile = updatedFile;
        else {
          const [currentFile] = await db.select().from(groupCaptureFilesTable)
            .where(eq(groupCaptureFilesTable.id, uploadedGroupFile.id)).limit(1);
          if (currentFile) uploadedGroupFile = currentFile;
        }
      } catch (error) {
        logger.error({ err: error, projectId, groupId }, "Durable group photo storage failed");
        res.status(503).json({
          error: "Group photo could not be stored safely for galleries. Please retry the upload.",
          code: "GROUP_PHOTO_STORAGE_FAILED",
        });
        return;
      }
    }
    try { await backupGroupUploadedFile(projectId, groupId, result.backupFilePath, uploadedGroupFile.originalFilename, uploadedGroupFile.fileRole as "JPEG" | "RAW", uploadedGroupFile.fileFormat, `group-capture:${result.capture.id}:${uploadedGroupFile.fileRole}`); }
    catch (error) { if (error instanceof GoogleDriveBackupError) { res.status(503).json({ error: "Capture saved locally, but Google Drive backup failed. Retry the upload.", code: "GOOGLE_DRIVE_BACKUP_FAILED" }); return; } throw error; }
    await projectGroupJpegToPhotographedStudents(result.capture, uploadedGroupFile);
    const r2Upload = await createR2CopyUpload({
      source: {
        kind: "group",
        id: uploadedGroupFile.id,
        projectId,
        captureId: result.capture.id,
      },
      originalFilename: uploadedGroupFile.originalFilename,
      mimeType: uploadedGroupFile.mimeType,
      fileSize: req.file.size,
      sha256: await sha256File(req.file.path),
    });
    if (result.reused) discardUploadedFile(req);
    res.status(result.reused ? 200 : 201).json({
      captureId: result.capture.id,
      captureKey: result.capture.captureKey,
      pairingStatus: result.capture.pairingStatus,
      file: uploadedGroupFile,
      reused: result.reused,
      galleryReady: uploadedGroupFile.fileRole !== "JPEG" || Boolean(uploadedGroupFile.durableObjectPath),
      r2Upload,
    });
  } catch (error) { discardUploadedFile(req); next(error); }
});

router.patch("/projects/:projectId/groups/:groupId/captures/:captureKey/review", requireDesktopConnection, async (req, res): Promise<void> => {
  const projectId = Number(req.params.projectId);
  const groupId = Number(req.params.groupId);
  const rating = Number(req.body?.rating);
  const connection = getDesktopConnection(req);
  const refreshedConnection = await refreshDesktopConnection(connection.connectionId);
  if (!refreshedConnection) {
    res.status(401).json({ error: "Desktop connection was revoked or retired" });
    return;
  }
  if (
    !Number.isInteger(projectId)
    || !Number.isInteger(groupId)
    || !Number.isInteger(rating)
    || rating < 0
    || rating > 5
    || !(await canAccessDesktopProject(connectionAccessMember(refreshedConnection), projectId))
  ) {
    res.status(400).json({ error: "Invalid group capture review" });
    return;
  }
  const flags = normalizeCaptureReviewFlags({
    favorite: typeof req.body?.favorite === "boolean" ? req.body.favorite : rating >= 4,
    rejected: typeof req.body?.rejected === "boolean" ? req.body.rejected : false,
    selected: typeof req.body?.selected === "boolean" ? req.body.selected : rating > 0,
  });
  const [capture] = await db.update(groupCapturesTable).set({
    rating,
    ...flags,
    updatedAt: new Date(),
  }).where(and(
    eq(groupCapturesTable.projectId, projectId),
    eq(groupCapturesTable.groupId, groupId),
    eq(groupCapturesTable.captureKey, String(req.params.captureKey)),
  )).returning();
  if (!capture) {
    res.status(404).json({ error: "Group capture not found" });
    return;
  }
  const [jpeg] = await db.select().from(groupCaptureFilesTable).where(and(
    eq(groupCaptureFilesTable.captureId, capture.id),
    eq(groupCaptureFilesTable.fileRole, "JPEG"),
  )).limit(1);
  if (jpeg) {
    await db.update(studentPhotosTable).set({
      rating,
      shareWithParents: rating > 0,
    }).where(eq(studentPhotosTable.sourceGroupCaptureFileId, jpeg.id));
    await projectGroupJpegToPhotographedStudents(capture, jpeg);
  }
  res.json({ capture });
});

// POST /api/projects/:projectId/students/:studentId/photos
// Desktop app → server: validate and authorize identifiers before Multer
// constructs a filesystem path, then authenticate the photo write to that project.
router.post("/:studentId/photos", requireDesktopConnection, validateDesktopUploadPath, authorizeDesktopUploadTarget, upload.single("photo"), async (req, res, next) => {
  const projectId = parseInt(req.params.projectId as string);
  const studentId = parseInt(req.params.studentId as string);

  try {
    // Reload the connection after streaming so a revoked device, removed member,
    // or changed role cannot commit a file that began uploading earlier.
    const refreshedConnection = await refreshDesktopConnection(getDesktopConnection(req).connectionId);
    if (!refreshedConnection) {
      discardUploadedFile(req);
      res.status(401).json({ error: "Desktop connection was revoked while uploading" });
      return;
    }
    if (!(await canAccessDesktopProject(connectionAccessMember(refreshedConnection), projectId))) {
      discardUploadedFile(req);
      res.status(404).json({ error: "Project not found" });
      return;
    }
    if (!(await verifyStudent(studentId, projectId))) {
      discardUploadedFile(req);
      res.status(404).json({ error: "Student not found in this project" });
      return;
    }
    if (!req.file) {
      res.status(400).json({ error: "No photo uploaded (use field name 'photo')" });
      return;
    }
    let durableObjectPath: string;
    try {
      durableObjectPath = await storePhotoDurably(req.file.path, req.file.mimetype);
    } catch (error) {
      logger.error({ err: error, projectId, studentId }, "Durable photo storage failed");
      discardUploadedFile(req);
      res.status(503).json({
        error: "Photo could not be stored safely. Please retry the upload.",
        code: "PHOTO_STORAGE_FAILED",
      });
      return;
    }

    const relPath = path
      .relative(path.resolve(process.cwd(), "uploads"), req.file.path)
      .replace(/\\/g, "/");
    const fileUrl = `/uploads/${relPath}`;
    const capturedAt = (req.body as Record<string, string>).capturedAt ?? null;
    const clientUploadId = req.get("X-MC-Upload-Id");
    const captureBatchKey = req.get("X-MC-Capture-Batch")?.trim();
    if (clientUploadId && !/^[1-9]\d*$/.test(clientUploadId)) {
      discardUploadedFile(req);
      res.status(400).json({ error: "Invalid desktop upload identifier" });
      return;
    }

    const savePhoto = async () => {
      const connection = getDesktopConnection(req);
      const captureBatch = await resolveCaptureBatch(projectId, captureBatchKey, connection.connectionId);
      if (captureBatchKey && !captureBatch) {
        discardUploadedFile(req);
        throw new Error("Capture batch was not found for this desktop connection");
      }
      if (!clientUploadId) {
        const [photo] = await db
          .insert(studentPhotosTable)
          .values({
            projectId,
            studentId,
            fileName: req.file!.originalname,
            fileUrl,
            durableObjectPath,
            mimeType: req.file!.mimetype,
            capturedAt: capturedAt || null,
            captureBatchId: captureBatch?.id ?? null,
          })
          .returning();
        return { photo, backupFilePath: req.file!.path, reused: false };
      }

      return db.transaction(async (tx) => {
        const lockKey = `${connection.connectionId}:${clientUploadId}`;
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${lockKey}))`);

        const [existing] = await tx
          .select()
          .from(studentPhotosTable)
          .where(and(
            eq(studentPhotosTable.desktopConnectionId, connection.connectionId),
            eq(studentPhotosTable.clientUploadId, clientUploadId),
          ))
          .limit(1);

        if (existing) {
          if (existing.projectId !== projectId || existing.studentId !== studentId) {
            throw new Error("Desktop upload identifier was reused for a different photo target");
          }
          return {
            photo: await attachSupersededBatchFile(tx, studentPhotosTable, existing, captureBatch, clientUploadId),
            backupFilePath: req.file!.path,
            reused: true,
          };
        }
        if (captureBatch?.supersedesBatchId) {
          const [superseded] = await tx.select().from(studentPhotosTable).where(and(
            eq(studentPhotosTable.captureBatchId, captureBatch.supersedesBatchId),
            eq(studentPhotosTable.clientUploadId, clientUploadId),
          )).limit(1);
          if (superseded) {
            if (superseded.projectId !== projectId || superseded.studentId !== studentId) {
              throw new Error("Desktop upload identifier was reused for a different photo target");
            }
            return {
              photo: await attachSupersededBatchFile(tx, studentPhotosTable, superseded, captureBatch, clientUploadId),
              backupFilePath: req.file!.path,
              reused: true,
            };
          }
        }

        const [photo] = await tx
          .insert(studentPhotosTable)
          .values({
            projectId,
            studentId,
            fileName: req.file!.originalname,
            fileUrl,
            durableObjectPath,
            mimeType: req.file!.mimetype,
            capturedAt: capturedAt || null,
            captureBatchId: captureBatch?.id ?? null,
            desktopConnectionId: connection.connectionId,
            clientUploadId,
          })
          .returning();
        return { photo, backupFilePath: req.file!.path, reused: false };
      });
    };

    const result = await savePhoto();
    try {
      await backupUploadedFile(
        projectId,
        studentId,
        result.backupFilePath,
        result.photo.fileName,
        "JPEG",
        "JPG",
        `photo:${result.photo.id}`,
      );
    } catch (error) {
      if (error instanceof GoogleDriveBackupError) {
        logger.error({ err: error, projectId, studentId, photoId: result.photo.id }, "Google Drive photo backup failed");
        res.status(503).json({
          error: "Photo saved locally, but Google Drive backup failed. Retry the upload.",
          code: "GOOGLE_DRIVE_BACKUP_FAILED",
        });
        return;
      }
      throw error;
    }
    await projectAvailableGroupJpegsToStudent(projectId, studentId);
    const r2Upload = await createR2CopyUpload({
      source: {
        kind: "student",
        id: result.photo.id,
        projectId,
        studentId,
      },
      originalFilename: result.photo.fileName,
      mimeType: result.photo.mimeType,
      fileSize: req.file.size,
      sha256: await sha256File(req.file.path),
    });
    if (result.reused) discardUploadedFile(req);
    res.status(result.reused ? 200 : 201).json({
      ...photoToResponse(result.photo),
      r2Upload,
    });
  } catch (error) {
    discardUploadedFile(req);
    next(error);
  }
});

// POST /api/projects/:projectId/students/:studentId/captures
// Desktop app → server: upload one JPEG or RAW member of a capture.
router.post("/:studentId/captures", requireDesktopConnection, validateDesktopUploadPath, authorizeDesktopUploadTarget, captureUpload.single("file"), async (req, res, next) => {
  const projectId = parseInt(req.params.projectId as string);
  const studentId = parseInt(req.params.studentId as string);

  try {
    const refreshedConnection = await refreshDesktopConnection(getDesktopConnection(req).connectionId);
    if (!refreshedConnection) {
      discardUploadedFile(req);
      res.status(401).json({ error: "Desktop connection was revoked while uploading" });
      return;
    }
    if (!(await canAccessDesktopProject(connectionAccessMember(refreshedConnection), projectId))) {
      discardUploadedFile(req);
      res.status(404).json({ error: "Project not found" });
      return;
    }
    if (!(await verifyStudent(studentId, projectId))) {
      discardUploadedFile(req);
      res.status(404).json({ error: "Student not found in this project" });
      return;
    }
    if (!req.file) {
      res.status(400).json({ error: "No capture file uploaded (use field name 'file')" });
      return;
    }
    const uploadedFile = req.file;

    const body = req.body as Record<string, string | undefined>;
    const role = captureFileRole(uploadedFile.originalname);
    const requestedRole = body.fileRole;
    const captureKey = body.captureKey?.trim();
    const clientUploadId = req.get("X-MC-Upload-Id")?.trim() || null;
    const captureBatchKey = req.get("X-MC-Capture-Batch")?.trim();
    if (!role || (requestedRole && requestedRole !== role)) {
      discardUploadedFile(req);
      res.status(400).json({ error: "Capture file role does not match its filename" });
      return;
    }
    let durableObjectPath: string;
    try {
      durableObjectPath = await storePhotoDurably(uploadedFile.path, uploadedFile.mimetype || "application/octet-stream");
    } catch (error) {
      logger.error({ err: error, projectId, studentId }, "Durable capture storage failed");
      discardUploadedFile(req);
      res.status(503).json({
        error: "Capture could not be stored safely. Please retry the upload.",
        code: "PHOTO_STORAGE_FAILED",
      });
      return;
    }
    if (!captureKey || captureKey.length > 500) {
      discardUploadedFile(req);
      res.status(400).json({ error: "A valid captureKey is required" });
      return;
    }
    if (clientUploadId && !/^[a-zA-Z0-9:_-]{1,200}$/.test(clientUploadId)) {
      discardUploadedFile(req);
      res.status(400).json({ error: "Invalid desktop upload identifier" });
      return;
    }

    const relPath = path
      .relative(path.resolve(process.cwd(), "uploads"), uploadedFile.path)
      .replace(/\\/g, "/");
    const fileUrl = `/uploads/${relPath}`;
    const connection = getDesktopConnection(req);
    const scopedCaptureKey = `desktop:${connection.connectionId}:${captureKey}`;
    const captureBatch = await resolveCaptureBatch(projectId, captureBatchKey, connection.connectionId);
    if (captureBatchKey && !captureBatch) {
      discardUploadedFile(req);
      res.status(409).json({ error: "Capture batch was not found for this desktop connection" });
      return;
    }
    const capturedAt = body.capturedAt?.trim() || null;
    const sequence = body.sequence ? Number(body.sequence) : null;
    const parsedSequence = sequence !== null && Number.isInteger(sequence) ? sequence : null;
    const rating = Math.max(0, Math.min(5, Number.parseInt(body.rating ?? "0", 10) || 0));
    const colorLabel = ["none", "red", "yellow", "green", "blue", "purple"].includes(body.colorLabel ?? "")
      ? body.colorLabel as "none" | "red" | "yellow" | "green" | "blue" | "purple"
      : "none";
    const reviewFlags = normalizeCaptureReviewFlags({
      favorite: body.favorite === "true",
      rejected: body.rejected === "true",
      selected: body.selected === "true",
    });

    const result = await db.transaction(async (tx) => {
      if (clientUploadId) {
        const [existingByClientId] = await tx
          .select({ file: captureFilesTable, capture: capturesTable })
          .from(captureFilesTable)
          .innerJoin(capturesTable, eq(captureFilesTable.captureId, capturesTable.id))
          .where(and(
            eq(captureFilesTable.desktopConnectionId, connection.connectionId),
            eq(captureFilesTable.clientUploadId, clientUploadId),
          ))
          .limit(1);
        if (existingByClientId) {
          if (
            existingByClientId.capture.projectId !== projectId
            || existingByClientId.capture.studentId !== studentId
          ) {
            return {
              conflict: "Desktop upload identifier was reused for a different capture target",
            } as const;
          }
          if (existingByClientId.file.fileRole !== role) {
            return {
              conflict: "Desktop upload identifier was reused for a different capture file role",
            } as const;
          }
          return {
            capture: existingByClientId.capture,
            file: await attachSupersededBatchFile(tx, captureFilesTable, existingByClientId.file, captureBatch, clientUploadId),
            backupFilePath: uploadedFile.path,
            reused: true,
          };
        }
        if (captureBatch?.supersedesBatchId) {
          const [superseded] = await tx.select({ file: captureFilesTable, capture: capturesTable })
            .from(captureFilesTable)
            .innerJoin(capturesTable, eq(captureFilesTable.captureId, capturesTable.id))
            .where(and(
              eq(captureFilesTable.captureBatchId, captureBatch.supersedesBatchId),
              eq(captureFilesTable.clientUploadId, clientUploadId),
            )).limit(1);
          if (superseded) {
            if (superseded.capture.projectId !== projectId || superseded.capture.studentId !== studentId
              || superseded.file.fileRole !== role) {
              return { conflict: "Desktop upload identifier was reused for a different capture target" } as const;
            }
            return {
              capture: superseded.capture,
              file: await attachSupersededBatchFile(tx, captureFilesTable, superseded.file, captureBatch, clientUploadId),
              backupFilePath: uploadedFile.path,
              reused: true,
            };
          }
        }
      }

      let [capture] = await tx
        .select()
        .from(capturesTable)
        .where(and(
          eq(capturesTable.projectId, projectId),
          eq(capturesTable.captureKey, scopedCaptureKey),
        ))
        .limit(1);

      // Older desktop releases stored project-wide keys such as
      // "legacy-photo:53". Local IDs can repeat on another photographer's Mac,
      // so only adopt an unscoped legacy capture when this same desktop
      // connection already owns one of its files.
      if (!capture) {
        const [legacyCapture] = await tx
          .select()
          .from(capturesTable)
          .where(and(
            eq(capturesTable.projectId, projectId),
            eq(capturesTable.captureKey, captureKey),
            eq(capturesTable.studentId, studentId),
          ))
          .limit(1);
        if (legacyCapture) {
          const [ownedLegacyFile] = await tx
            .select({ id: captureFilesTable.id })
            .from(captureFilesTable)
            .where(and(
              eq(captureFilesTable.captureId, legacyCapture.id),
              eq(captureFilesTable.desktopConnectionId, connection.connectionId),
            ))
            .limit(1);
          if (ownedLegacyFile) capture = legacyCapture;
        }
      }

      if (capture && capture.studentId !== studentId) {
        throw new Error("Scoped capture key was already assigned to a different student");
      }
      if (!capture) {
        [capture] = await tx
          .insert(capturesTable)
          .values({
            captureKey: scopedCaptureKey,
            projectId,
            studentId,
            baseFilename: body.baseFilename?.trim() || path.basename(uploadedFile.originalname, path.extname(uploadedFile.originalname)),
            capturedAt,
            sequence: parsedSequence,
            pairingStatus: role === "JPEG" ? "jpeg_only" : "raw_only",
            ...reviewFlags,
            rating,
            colorLabel,
          })
          .returning();
      }

      const [existingByRole] = await tx
        .select()
        .from(captureFilesTable)
        .where(and(
          eq(captureFilesTable.captureId, capture.id),
          eq(captureFilesTable.fileRole, role),
        ))
        .limit(1);
      if (existingByRole) {
        const resumedFile = await attachSupersededBatchFile(tx, captureFilesTable, existingByRole, captureBatch, clientUploadId);
        [capture] = await tx.update(capturesTable).set({
          ...reviewFlags,
          rating,
          colorLabel,
          updatedAt: new Date(),
        }).where(eq(capturesTable.id, capture.id)).returning();
        return { capture, file: resumedFile, backupFilePath: uploadedFile.path, reused: true };
      }

      const [file] = await tx
        .insert(captureFilesTable)
        .values({
          captureId: capture.id,
          fileRole: role,
          fileFormat: body.fileFormat?.trim() || captureFileFormat(uploadedFile.originalname),
          originalFilename: uploadedFile.originalname,
          fileUrl,
          durableObjectPath,
          mimeType: uploadedFile.mimetype || (role === "JPEG" ? "image/jpeg" : "application/octet-stream"),
          fileSize: uploadedFile.size,
          captureBatchId: captureBatch?.id ?? null,
          desktopConnectionId: connection.connectionId,
          clientUploadId,
        })
        .returning();
      const files = await tx
        .select({ fileRole: captureFilesTable.fileRole })
        .from(captureFilesTable)
        .where(eq(captureFilesTable.captureId, capture.id));
      const pairingStatus = captureStatusForFiles(files);
      [capture] = await tx
        .update(capturesTable)
        .set({ pairingStatus, updatedAt: new Date() })
        .where(eq(capturesTable.id, capture.id))
        .returning();
      return { capture, file, backupFilePath: uploadedFile.path, reused: false };
    });

    if ("conflict" in result) {
      discardUploadedFile(req);
      res.status(409).json({ error: result.conflict });
      return;
    }

    const fileRole = result.file.fileRole === "RAW"
      ? "RAW"
      : result.file.fileRole === "JPEG"
        ? "JPEG"
        : null;
    if (!fileRole) {
      throw new Error(`Unsupported capture file role "${result.file.fileRole}"`);
    }

    try {
      await backupUploadedFile(
        projectId,
        studentId,
        result.backupFilePath,
        result.file.originalFilename,
        fileRole,
        result.file.fileFormat,
        `capture:${result.capture.id}:${fileRole}`,
      );
    } catch (error) {
      if (error instanceof GoogleDriveBackupError) {
        logger.error({
          err: error,
          projectId,
          studentId,
          captureId: result.capture.id,
          fileId: result.file.id,
          fileRole,
        }, "Google Drive capture backup failed");
        res.status(503).json({
          error: "Capture saved locally, but Google Drive backup failed. Retry the upload.",
          code: "GOOGLE_DRIVE_BACKUP_FAILED",
        });
        return;
      }
      throw error;
    }

    // Every durable JPEG is materialized for delivery. Publishing the gallery,
    // rather than a second per-photo flag, is the parent-sharing checkpoint.
    await projectCaptureJpegToDeliveryPhoto(result.capture, result.file);
    const r2Upload = await createR2CopyUpload({
      source: {
        kind: "capture",
        id: result.file.id,
        projectId,
        captureId: result.capture.id,
      },
      originalFilename: result.file.originalFilename,
      mimeType: result.file.mimeType,
      fileSize: uploadedFile.size,
      sha256: await sha256File(uploadedFile.path),
    });
    if (result.reused) discardUploadedFile(req);
    res.status(result.reused ? 200 : 201).json({
      captureId: result.capture.id,
      captureKey: result.capture.captureKey,
      pairingStatus: result.capture.pairingStatus,
      file: captureFileToResponse(result.file),
      reused: result.reused,
      r2Upload,
    });
  } catch (error) {
    discardUploadedFile(req);
    next(error);
  }
});

router.patch("/:studentId/captures/:captureKey/review", requireDesktopConnection, async (req, res): Promise<void> => {
  const projectId = Number(req.params.projectId);
  const studentId = Number(req.params.studentId);
  const captureKey = String(req.params.captureKey);
  const connection = getDesktopConnection(req);
  const refreshedConnection = await refreshDesktopConnection(connection.connectionId);
  if (!refreshedConnection) {
    res.status(401).json({ error: "Desktop connection was revoked or retired" });
    return;
  }
  const scopedCaptureKey = `desktop:${connection.connectionId}:${captureKey}`;
  if (
    !Number.isInteger(projectId)
    || !Number.isInteger(studentId)
    || !(await canAccessDesktopProject(connectionAccessMember(refreshedConnection), projectId))
  ) {
    res.status(404).json({ error: "Capture not found" });
    return;
  }
  const colorLabel = String(req.body?.colorLabel ?? "none");
  const rating = Number(req.body?.rating ?? 0);
  if (!["none", "red", "yellow", "green", "blue", "purple"].includes(colorLabel) || !Number.isInteger(rating) || rating < 0 || rating > 5) {
    res.status(400).json({ error: "Invalid rating or color label" });
    return;
  }
  const parsedEdits = parseCaptureEditSettings(req.body);
  if (parsedEdits.error) {
    res.status(400).json({ error: parsedEdits.error });
    return;
  }
  const flags = normalizeCaptureReviewFlags({
    favorite: typeof req.body?.favorite === "boolean" ? req.body.favorite : rating >= 4,
    rejected: typeof req.body?.rejected === "boolean" ? req.body.rejected : false,
    selected: typeof req.body?.selected === "boolean" ? req.body.selected : rating > 0,
  });
  const captureUpdate = {
    ...flags,
    rating,
    colorLabel: colorLabel as "none" | "red" | "yellow" | "green" | "blue" | "purple",
    updatedAt: new Date(),
    ...(parsedEdits.provided && parsedEdits.settings
      ? parsedEdits.settings
      : parsedEdits.provided
        ? {
          cropPositionX: null,
          cropPositionY: null,
          cropScale: null,
          aspectRatio: null,
          straightenAngle: null,
          rotation: null,
        }
        : {}),
  };
  const [capture] = await db.update(capturesTable).set(captureUpdate).where(and(
    eq(capturesTable.projectId, projectId),
    eq(capturesTable.studentId, studentId),
    eq(capturesTable.captureKey, scopedCaptureKey),
  )).returning();
  if (!capture) {
    res.status(404).json({ error: "Capture not found" });
    return;
  }
  const [jpeg] = await db.select({
    file: captureFilesTable,
    originalFilename: captureFilesTable.originalFilename,
    desktopConnectionId: captureFilesTable.desktopConnectionId,
    clientUploadId: captureFilesTable.clientUploadId,
  }).from(captureFilesTable).where(and(
    eq(captureFilesTable.captureId, capture.id),
    eq(captureFilesTable.fileRole, "JPEG"),
  )).limit(1);
  if (jpeg) {
    await projectCaptureJpegToDeliveryPhoto(capture, jpeg.file);
  }
  // Keep review metadata synchronized with the projected delivery JPEG.
  await db.update(studentPhotosTable).set({
    rating,
    colorLabel: colorLabel as "none" | "red" | "yellow" | "green" | "blue" | "purple",
    shareWithParents: rating > 0,
  }).where(and(
    eq(studentPhotosTable.projectId, projectId),
    eq(studentPhotosTable.studentId, studentId),
    jpeg?.clientUploadId
      ? and(
        eq(studentPhotosTable.desktopConnectionId, jpeg.desktopConnectionId!),
        eq(studentPhotosTable.clientUploadId, jpeg.clientUploadId),
      )
      : eq(studentPhotosTable.fileName, jpeg?.originalFilename ?? capture.baseFilename),
  ));
  res.json({ capture });
});

// GET /api/projects/:projectId/students/:studentId/photos
// Web app: Clerk authenticated + assignment-aware project access.
router.patch("/:studentId/photos/:photoId/share", requireAuth, async (req, res): Promise<void> => {
  const projectId = Number(req.params.projectId);
  const studentId = Number(req.params.studentId);
  const photoId = Number(req.params.photoId);
  if (![projectId, studentId, photoId].every((value) => Number.isSafeInteger(value) && value > 0)
    || typeof req.body?.shareWithParents !== "boolean") {
    res.status(400).json({ error: "A boolean shareWithParents value and valid photo identifiers are required" });
    return;
  }
  if (!(await canAccessProject(getUserId(req), projectId, "manage"))) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const [photo] = await db.update(studentPhotosTable).set({
    shareWithParents: req.body.shareWithParents,
  }).where(and(
    eq(studentPhotosTable.id, photoId),
    eq(studentPhotosTable.projectId, projectId),
    eq(studentPhotosTable.studentId, studentId),
  )).returning();
  if (!photo) {
    res.status(404).json({ error: "Photo not found" });
    return;
  }
  res.json({ photo: photoToResponse(photo) });
});

router.patch("/:studentId/photos/:photoId/review", requireAuth, async (req, res): Promise<void> => {
  const projectId = Number(req.params.projectId);
  const studentId = Number(req.params.studentId);
  const photoId = Number(req.params.photoId);
  const decision = req.body?.decision;
  const requestedRating = Number(req.body?.rating);
  if (
    ![projectId, studentId, photoId].every((value) => Number.isSafeInteger(value) && value > 0)
    || !["selected", "do_not_share"].includes(decision)
    || (decision === "selected" && (!Number.isInteger(requestedRating) || requestedRating < 1 || requestedRating > 5))
  ) {
    res.status(400).json({ error: "Select a 1–5 star rating or mark the photo Do not share" });
    return;
  }
  if (!(await canAccessProject(getUserId(req), projectId, "manage"))) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const rating = decision === "selected" ? requestedRating : 0;
  const colorLabel = decision === "selected" ? "green" : "red";
  const shareWithParents = decision === "selected";

  const [existingPhoto] = await db.select().from(studentPhotosTable).where(and(
    eq(studentPhotosTable.id, photoId),
    eq(studentPhotosTable.projectId, projectId),
    eq(studentPhotosTable.studentId, studentId),
  )).limit(1);
  if (!existingPhoto) {
    res.status(404).json({ error: "Photo not found" });
    return;
  }

  const [photo] = await db.transaction(async (tx) => {
    const updatedPhotos = existingPhoto.sourceGroupCaptureFileId !== null
      ? await tx.update(studentPhotosTable).set({
          rating,
          colorLabel,
          shareWithParents,
        }).where(eq(studentPhotosTable.sourceGroupCaptureFileId, existingPhoto.sourceGroupCaptureFileId)).returning()
      : await tx.update(studentPhotosTable).set({
          rating,
          colorLabel,
          shareWithParents,
        }).where(eq(studentPhotosTable.id, photoId)).returning();

    if (existingPhoto.sourceGroupCaptureFileId !== null) {
      const [groupFile] = await tx.select({ captureId: groupCaptureFilesTable.captureId })
        .from(groupCaptureFilesTable)
        .where(eq(groupCaptureFilesTable.id, existingPhoto.sourceGroupCaptureFileId))
        .limit(1);
      if (groupFile) {
        await tx.update(groupCapturesTable).set({
          rating,
          favorite: rating >= 4,
          selected: rating > 0,
          rejected: false,
          updatedAt: new Date(),
        }).where(eq(groupCapturesTable.id, groupFile.captureId));
      }
    } else {
      const captureIdentity = existingPhoto.clientUploadId
        ? and(
            eq(captureFilesTable.desktopConnectionId, existingPhoto.desktopConnectionId!),
            eq(captureFilesTable.clientUploadId, existingPhoto.clientUploadId),
          )
        : eq(captureFilesTable.originalFilename, existingPhoto.fileName);
      const [captureFile] = await tx.select({ captureId: captureFilesTable.captureId })
        .from(captureFilesTable)
        .innerJoin(capturesTable, eq(captureFilesTable.captureId, capturesTable.id))
        .where(and(
          eq(capturesTable.projectId, projectId),
          eq(capturesTable.studentId, studentId),
          eq(captureFilesTable.fileRole, "JPEG"),
          captureIdentity,
        ))
        .limit(1);
      if (captureFile) {
        await tx.update(capturesTable).set({
          rating,
          colorLabel,
          favorite: rating >= 4,
          selected: rating > 0,
          rejected: false,
          updatedAt: new Date(),
        }).where(eq(capturesTable.id, captureFile.captureId));
      }
    }

    return [updatedPhotos.find((candidate) => candidate.id === photoId) ?? updatedPhotos[0]];
  });

  res.json({ photo: photoToResponse(photo) });
});

router.get("/:studentId/photos", requireAuth, async (req, res) => {
  const userId = getUserId(req);
  const projectId = parseInt(req.params.projectId as string);
  const studentId = parseInt(req.params.studentId as string);

  if (isNaN(projectId) || isNaN(studentId)) {
    res.status(400).json({ error: "Invalid projectId or studentId" });
    return;
  }

  if (!(await canAccessProject(userId, projectId, "view"))) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const photos = await db
    .select()
    .from(studentPhotosTable)
    .where(
      and(
        eq(studentPhotosTable.studentId, studentId),
        eq(studentPhotosTable.projectId, projectId),
      ),
    )
    .orderBy(studentPhotosTable.createdAt);

  res.json(photos.map(photoToResponse));
});

// GET /api/projects/:projectId/students/:studentId/photos/:photoId/file
// Streams the photo file — Clerk auth + assignment-aware access. Safe for use in <img src>.
// Browsers send session cookies automatically on same-origin requests.
router.get("/:studentId/photos/:photoId/file", requireAuth, async (req, res) => {
  const userId = getUserId(req);
  const projectId = parseInt(req.params.projectId as string);
  const studentId = parseInt(req.params.studentId as string);
  const photoId = parseInt(req.params.photoId as string);

  if (isNaN(projectId) || isNaN(studentId) || isNaN(photoId)) {
    res.status(400).json({ error: "Invalid parameters" });
    return;
  }

  if (!(await canAccessProject(userId, projectId, "view"))) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const [photo] = await db
    .select()
    .from(studentPhotosTable)
    .where(
      and(
        eq(studentPhotosTable.id, photoId),
        eq(studentPhotosTable.studentId, studentId),
        eq(studentPhotosTable.projectId, projectId),
      ),
    );

  if (!photo) {
    // The caller is already authorized for this project. Treat an absent photo
    // as an already-completed deletion so retries are safe after lost responses.
    res.status(204).send();
    return;
  }

  const verifiedR2Copy = await getVerifiedR2CopyForPhoto(photo);
  if (verifiedR2Copy) {
    try {
      if (req.query.download === "original") {
        const r2Response = await getR2Object(verifiedR2Copy.objectKey);
        if (!r2Response.body) throw new Error("R2 original body is missing");
        res.setHeader("Content-Type", verifiedR2Copy.mimeType || photo.mimeType || "application/octet-stream");
        res.setHeader("Content-Disposition", `attachment; filename="${photo.fileName.replace(/["\r\n]/g, "_")}"`);
        res.setHeader("Cache-Control", "private, no-store");
        Readable.fromWeb(
          r2Response.body as globalThis.ReadableStream<Uint8Array>,
        ).pipe(res);
        return;
      }
      const variantKey = await ensureR2PhotoVariant(
        verifiedR2Copy,
        req.query.size === "preview" ? "preview" : "thumbnail",
      );
      const r2Response = await getR2Object(variantKey);
      if (!r2Response.body) throw new Error("R2 variant body is missing");
      res.setHeader("Content-Type", "image/jpeg");
      res.setHeader("Cache-Control", "private, max-age=3600");
      Readable.fromWeb(
        r2Response.body as globalThis.ReadableStream<Uint8Array>,
      ).pipe(res);
      return;
    } catch {
      res.status(503).json({ error: "Photo preview is temporarily unavailable" });
      return;
    }
  }

  const filePath = resolveFilePath(photo.fileUrl);

  if (!fs.existsSync(filePath)) {
    res.status(404).json({ error: "Photo file not found on server" });
    return;
  }

  res.setHeader("Content-Type", photo.mimeType || "image/jpeg");
  if (req.query.download === "original") {
    res.setHeader("Content-Disposition", `attachment; filename="${photo.fileName.replace(/["\r\n]/g, "_")}"`);
    res.setHeader("Cache-Control", "private, no-store");
  } else {
    res.setHeader("Cache-Control", "private, max-age=3600");
  }
  res.sendFile(filePath);
});

// GET /api/projects/:projectId/students/:studentId/captures/:captureId/files/:fileId/file
router.get("/:studentId/captures/:captureId/files/:fileId/file", requireAuth, async (req, res) => {
  const projectId = parseInt(req.params.projectId as string);
  const studentId = parseInt(req.params.studentId as string);
  const captureId = parseInt(req.params.captureId as string);
  const fileId = parseInt(req.params.fileId as string);
  if ([projectId, studentId, captureId, fileId].some(Number.isNaN)) {
    res.status(400).json({ error: "Invalid parameters" });
    return;
  }
  if (!(await canAccessProject(getUserId(req), projectId, "view"))) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const [file] = await db
    .select({ file: captureFilesTable, capture: capturesTable })
    .from(captureFilesTable)
    .innerJoin(capturesTable, eq(captureFilesTable.captureId, capturesTable.id))
    .where(and(
      eq(captureFilesTable.id, fileId),
      eq(captureFilesTable.captureId, captureId),
      eq(capturesTable.projectId, projectId),
      eq(capturesTable.studentId, studentId),
    ));
  if (!file) {
    res.status(404).json({ error: "Capture file not found" });
    return;
  }
  const filePath = resolveFilePath(file.file.fileUrl);
  if (!fs.existsSync(filePath)) {
    res.status(404).json({ error: "Capture file not found on server" });
    return;
  }
  res.setHeader("Content-Type", file.file.mimeType);
  res.setHeader("Cache-Control", "private, max-age=3600");
  res.sendFile(filePath);
});

// DELETE /api/projects/:projectId/students/:studentId/photos/:photoId
// Web app: Clerk authenticated + shoot permission.
router.delete("/:studentId/photos/:photoId", requireAuth, async (req, res) => {
  const userId = getUserId(req);
  const projectId = parseInt(req.params.projectId as string);
  const studentId = parseInt(req.params.studentId as string);
  const photoId = parseInt(req.params.photoId as string);

  if (!(await canAccessProject(userId, projectId, "shoot"))) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const [photo] = await db
    .select()
    .from(studentPhotosTable)
    .where(
      and(
        eq(studentPhotosTable.id, photoId),
        eq(studentPhotosTable.studentId, studentId),
        eq(studentPhotosTable.projectId, projectId),
      ),
    );

  if (!photo) {
    // The caller is already authorized for this project. Treat an absent photo
    // as an already-completed deletion so retries are safe after lost responses.
    res.status(204).send();
    return;
  }

  const filePath = resolveFilePath(photo.fileUrl);
  const backup = createPhotoDeleteBackup(filePath);
  let preserveBackup = false;

  try {
    await db.transaction(async (tx) => {
      const [lockedPhoto] = await tx
        .select({ id: studentPhotosTable.id })
        .from(studentPhotosTable)
        .where(and(
          eq(studentPhotosTable.id, photoId),
          eq(studentPhotosTable.studentId, studentId),
          eq(studentPhotosTable.projectId, projectId),
        ))
        .for("update");
      if (!lockedPhoto) {
        throw new Error("Photo could not be deleted");
      }
      await enqueueR2PhotoDeletions(tx, "student_photo", [photoId]);
      const [deleted] = await tx
        .delete(studentPhotosTable)
        .where(eq(studentPhotosTable.id, photoId))
        .returning({ id: studentPhotosTable.id });
      if (!deleted) {
        throw new Error("Photo could not be deleted");
      }
      fs.unlinkSync(filePath);
    });

    try {
      removePhotoDeleteBackup(backup);
    } catch (cleanupError) {
      // The requested deletion has succeeded. Keep any surviving backup as
      // cleanup debt rather than trying to roll back from a possibly partial
      // recursive removal.
      console.error("Could not clean up a completed photo deletion backup", {
        error: cleanupError,
        photoId,
        backupPath: backup.filePath,
      });
    }
  } catch (error) {
    // The database transaction rolls back both the source deletion and its
    // outbox item. Restore local bytes before releasing the recovery backup.
    try {
      restoreDeletedPhotoFile(filePath, backup);
    } catch (restoreError) {
      preserveBackup = true;
      alertPhotoDeleteRecoveryRequired(
        "backup_compensation_failed",
        backup.filePath,
        filePath,
        restoreError,
        backup.directory,
      );
    }
    if (!preserveBackup) {
      try {
        if (fs.existsSync(backup.directory)) {
          removePhotoDeleteBackup(backup);
        }
      } catch (cleanupError) {
        console.error("Could not clean up a photo deletion backup", {
          error: cleanupError,
          photoId,
          backupPath: backup.filePath,
        });
      }
    }
    throw error;
  }

  res.status(204).send();
});

export default router;
