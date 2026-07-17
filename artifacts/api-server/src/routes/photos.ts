import { Router } from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import { db } from "@workspace/db";
import { projectsTable, studentsTable, studentPhotosTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import type { Request, Response, NextFunction } from "express";
import { requireAuth, getUserId } from "../lib/auth";

const router = Router({ mergeParams: true });

// ---------------------------------------------------------------------------
// Upload key authentication — desktop app → server only (POST)
// ---------------------------------------------------------------------------

function requireUploadKey(req: Request, res: Response, next: NextFunction): void {
  const uploadKey = process.env.PHOTO_UPLOAD_KEY;
  if (!uploadKey) {
    res.status(503).json({ error: "Cloud upload not configured on server (PHOTO_UPLOAD_KEY missing)" });
    return;
  }
  const authHeader = req.headers.authorization;
  const provided = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!provided || provided !== uploadKey) {
    res.status(401).json({ error: "Invalid upload key" });
    return;
  }
  next();
}

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

/** Verify the project exists and belongs to the authenticated user */
async function verifyProjectOwnership(projectId: number, userId: string): Promise<boolean> {
  const [project] = await db
    .select({ id: projectsTable.id })
    .from(projectsTable)
    .where(and(eq(projectsTable.id, projectId), eq(projectsTable.userId, userId)));
  return !!project;
}

/** Verify the student belongs to the project */
async function verifyStudent(studentId: number, projectId: number): Promise<boolean> {
  const [student] = await db
    .select({ id: studentsTable.id })
    .from(studentsTable)
    .where(and(eq(studentsTable.id, studentId), eq(studentsTable.projectId, projectId)));
  return !!student;
}

/** Verify the project exists (no ownership check — for upload-key-only routes) */
async function verifyProject(projectId: number): Promise<boolean> {
  const [project] = await db
    .select({ id: projectsTable.id })
    .from(projectsTable)
    .where(eq(projectsTable.id, projectId));
  return !!project;
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
// Desktop app → server: authenticated with PHOTO_UPLOAD_KEY bearer token
router.post("/:studentId/photos", requireUploadKey, upload.single("photo"), async (req, res) => {
  const projectId = parseInt(req.params.projectId as string);
  const studentId = parseInt(req.params.studentId as string);

  if (isNaN(projectId) || isNaN(studentId)) {
    res.status(400).json({ error: "Invalid projectId or studentId" });
    return;
  }

  if (!(await verifyProject(projectId))) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  if (!(await verifyStudent(studentId, projectId))) {
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
});

// GET /api/projects/:projectId/students/:studentId/photos
// Web app: Clerk authenticated + project ownership check
router.get("/:studentId/photos", requireAuth, async (req, res) => {
  const userId = getUserId(req);
  const projectId = parseInt(req.params.projectId as string);
  const studentId = parseInt(req.params.studentId as string);

  if (isNaN(projectId) || isNaN(studentId)) {
    res.status(400).json({ error: "Invalid projectId or studentId" });
    return;
  }

  if (!(await verifyProjectOwnership(projectId, userId))) {
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
// Streams the photo file — Clerk auth + ownership. Safe for use in <img src>.
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

  if (!(await verifyProjectOwnership(projectId, userId))) {
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
// Web app: Clerk authenticated + project ownership check
router.delete("/:studentId/photos/:photoId", requireAuth, async (req, res) => {
  const userId = getUserId(req);
  const projectId = parseInt(req.params.projectId as string);
  const studentId = parseInt(req.params.studentId as string);
  const photoId = parseInt(req.params.photoId as string);

  if (!(await verifyProjectOwnership(projectId, userId))) {
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

  try {
    const filePath = resolveFilePath(photo.fileUrl);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch {
    // Non-fatal
  }

  await db.delete(studentPhotosTable).where(eq(studentPhotosTable.id, photoId));

  res.status(204).send();
});

export default router;
