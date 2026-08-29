import { Router } from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import { db } from "@workspace/db";
import { studentsTable, studentPhotosTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import type { NextFunction, Request, Response } from "express";
import { requireAuth, getUserId } from "../lib/auth";
import { getDesktopConnection, refreshDesktopConnection, requireDesktopConnection } from "../lib/desktopAuth";
import { canAccessAssignedDesktopProject, canAccessProject } from "../lib/studioAccess";

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

function connectionAccessMember(connection: ReturnType<typeof getDesktopConnection>) {
  return {
    id: connection.memberId,
    studioId: connection.studioId,
    role: connection.memberRole,
  };
}

async function authorizeDesktopUploadTarget(req: Request, res: Response, next: NextFunction): Promise<void> {
  const projectId = Number(req.params.projectId);
  const studentId = Number(req.params.studentId);
  if (!(await canAccessAssignedDesktopProject(connectionAccessMember(getDesktopConnection(req)), projectId))) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  if (!(await verifyStudent(studentId, projectId))) {
    res.status(404).json({ error: "Student not found in this project" });
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

async function restoreDeletedPhoto(
  photo: typeof studentPhotosTable.$inferSelect,
  filePath: string,
  backup: PhotoDeleteBackup,
): Promise<void> {
  if (!fs.existsSync(filePath)) {
    fs.copyFileSync(backup.filePath, filePath, fs.constants.COPYFILE_EXCL);
  }
  await db.insert(studentPhotosTable).values(photo);
}

function photoToResponse(photo: typeof studentPhotosTable.$inferSelect) {
  return {
    id: photo.id,
    projectId: photo.projectId,
    studentId: photo.studentId,
    fileName: photo.fileName,
    fileUrl: photo.fileUrl,
    mimeType: photo.mimeType,
    capturedAt: photo.capturedAt,
    createdAt: photo.createdAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

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
    if (!(await canAccessAssignedDesktopProject(connectionAccessMember(refreshedConnection), projectId))) {
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

    const relPath = path
      .relative(path.resolve(process.cwd(), "uploads"), req.file.path)
      .replace(/\\/g, "/");
    const fileUrl = `/uploads/${relPath}`;
    const capturedAt = (req.body as Record<string, string>).capturedAt ?? null;

    const [photo] = await db
      .insert(studentPhotosTable)
      .values({
        projectId,
        studentId,
        fileName: req.file.originalname,
        fileUrl,
        mimeType: req.file.mimetype,
        capturedAt: capturedAt || null,
      })
      .returning();

    res.status(201).json(photoToResponse(photo));
  } catch (error) {
    discardUploadedFile(req);
    next(error);
  }
});

// GET /api/projects/:projectId/students/:studentId/photos
// Web app: Clerk authenticated + assignment-aware project access.
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
    res.status(404).json({ error: "Photo not found" });
    return;
  }

  const filePath = resolveFilePath(photo.fileUrl);

  if (!fs.existsSync(filePath)) {
    res.status(404).json({ error: "Photo file not found on server" });
    return;
  }

  res.setHeader("Content-Type", photo.mimeType || "image/jpeg");
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
    res.status(404).json({ error: "Photo not found" });
    return;
  }

  const filePath = resolveFilePath(photo.fileUrl);
  const backup = createPhotoDeleteBackup(filePath);
  let rowDeleted = false;
  let preserveBackup = false;

  try {
    const [deletedPhoto] = await db
      .delete(studentPhotosTable)
      .where(eq(studentPhotosTable.id, photoId))
      .returning({ id: studentPhotosTable.id });

    if (!deletedPhoto) {
      throw new Error("Photo could not be deleted");
    }
    rowDeleted = true;

    try {
      fs.unlinkSync(filePath);
    } catch (error) {
      try {
        await restoreDeletedPhoto(photo, filePath, backup);
        rowDeleted = false;
      } catch (restoreError) {
        preserveBackup = true;
        console.error("Could not restore a photo after file deletion failed", {
          error: restoreError,
          photoId,
          backupPath: backup.filePath,
        });
      }
      throw error;
    }

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
    // A failed compensation must retain the only durable recovery copy.
    // Otherwise, the row still exists (DB failure) or has been restored, so
    // the backup can be removed safely.
    if (!preserveBackup && (!rowDeleted || fs.existsSync(filePath))) {
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
