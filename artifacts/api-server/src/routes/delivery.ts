import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import {
  db,
  deliveryAccessesTable,
  deliveryGalleriesTable,
  projectsTable,
  studentPhotosTable,
  studentsTable,
  studiosTable,
} from "@workspace/db";
import { and, eq, isNull } from "drizzle-orm";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { requireAuth, getUserId } from "../lib/auth";
import { canAccessProject } from "../lib/studioAccess";
import { decryptStorageValue, encryptStorageValue } from "../lib/storageCrypto";

const router = Router();
const DELIVERY_TOKEN_TTL_SECONDS = 2 * 60 * 60;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function makeCode(length = 8): string {
  const bytes = randomBytes(length);
  return Array.from(bytes, (byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join("");
}

function hashCode(code: string): string {
  return createHash("sha256").update(code.trim().toUpperCase()).digest("hex");
}

function tokenSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("SESSION_SECRET must be at least 32 characters to protect delivery access");
  }
  return secret;
}

function signToken(payload: { galleryId: number; accessId: number; expiresAt: number }): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", tokenSecret()).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

function verifyToken(token: string, galleryId: number): { accessId: number } | null {
  const [encoded, providedSignature] = token.split(".");
  if (!encoded || !providedSignature) return null;
  const expectedSignature = createHmac("sha256", tokenSecret()).update(encoded).digest("base64url");
  if (
    expectedSignature.length !== providedSignature.length
    || !timingSafeEqual(Buffer.from(expectedSignature), Buffer.from(providedSignature))
  ) return null;

  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as {
      galleryId: number;
      accessId: number;
      expiresAt: number;
    };
    if (payload.galleryId !== galleryId || payload.expiresAt < Math.floor(Date.now() / 1000)) return null;
    return { accessId: payload.accessId };
  } catch {
    return null;
  }
}

function publicGallery(gallery: typeof deliveryGalleriesTable.$inferSelect, studio: typeof studiosTable.$inferSelect | null) {
  return {
    slug: gallery.slug,
    status: gallery.status,
    expiresAt: gallery.expiresAt?.toISOString() ?? null,
    studio: {
      name: studio?.name ?? "Volume Capture",
      tagline: studio?.tagline ?? "Private photo delivery",
      primaryColor: studio?.primaryColor ?? "#0F766E",
      accentColor: studio?.accentColor ?? "#14B8A6",
    },
  };
}

async function getGalleryBySlug(slug: string) {
  const [row] = await db
    .select({ gallery: deliveryGalleriesTable, studio: studiosTable })
    .from(deliveryGalleriesTable)
    .leftJoin(studiosTable, eq(deliveryGalleriesTable.studioId, studiosTable.id))
    .where(eq(deliveryGalleriesTable.slug, slug))
    .limit(1);
  return row ?? null;
}

function activeGallery(gallery: typeof deliveryGalleriesTable.$inferSelect): boolean {
  return gallery.status === "published" && (!gallery.expiresAt || gallery.expiresAt > new Date());
}

function photoFilePath(fileUrl: string): string {
  return path.join(process.cwd(), fileUrl.replace(/^\//, ""));
}

// Public metadata for the code-entry page. No student or photo information is returned.
router.get("/delivery/:slug", async (req, res): Promise<void> => {
  const row = await getGalleryBySlug(String(req.params.slug));
  if (!row || !activeGallery(row.gallery)) {
    res.status(404).json({ error: "Delivery gallery not found or no longer available" });
    return;
  }
  res.json(publicGallery(row.gallery, row.studio));
});

router.post("/delivery/:slug/access", async (req, res): Promise<void> => {
  const row = await getGalleryBySlug(String(req.params.slug));
  if (!row || !activeGallery(row.gallery)) {
    res.status(404).json({ error: "Delivery gallery not found or no longer available" });
    return;
  }
  const code = String(req.body?.code ?? "").trim().toUpperCase();
  if (!/^[A-Z0-9]{8}$/.test(code)) {
    res.status(400).json({ error: "Enter the 8-character access code from your card" });
    return;
  }

  const [access] = await db
    .select()
    .from(deliveryAccessesTable)
    .where(and(
      eq(deliveryAccessesTable.galleryId, row.gallery.id),
      eq(deliveryAccessesTable.accessCodeHash, hashCode(code)),
      isNull(deliveryAccessesTable.revokedAt),
    ))
    .limit(1);
  if (!access) {
    res.status(401).json({ error: "That access code is not valid" });
    return;
  }

  const token = signToken({
    galleryId: row.gallery.id,
    accessId: access.id,
    expiresAt: Math.floor(Date.now() / 1000) + DELIVERY_TOKEN_TTL_SECONDS,
  });
  res.json({ token, expiresIn: DELIVERY_TOKEN_TTL_SECONDS });
});

router.get("/delivery/:slug/gallery", async (req, res): Promise<void> => {
  const row = await getGalleryBySlug(String(req.params.slug));
  if (!row || !activeGallery(row.gallery)) {
    res.status(404).json({ error: "Delivery gallery not found or no longer available" });
    return;
  }
  const verified = verifyToken(String(req.header("x-delivery-token") ?? req.query.token ?? ""), row.gallery.id);
  if (!verified) {
    res.status(401).json({ error: "Delivery access has expired. Enter the code again." });
    return;
  }

  const [access] = await db
    .select({ access: deliveryAccessesTable, student: studentsTable })
    .from(deliveryAccessesTable)
    .innerJoin(studentsTable, eq(deliveryAccessesTable.studentId, studentsTable.id))
    .where(and(
      eq(deliveryAccessesTable.id, verified.accessId),
      eq(deliveryAccessesTable.galleryId, row.gallery.id),
      isNull(deliveryAccessesTable.revokedAt),
    ))
    .limit(1);
  if (!access) {
    res.status(401).json({ error: "Delivery access has been revoked" });
    return;
  }

  const photos = await db
    .select()
    .from(studentPhotosTable)
    .where(and(
      eq(studentPhotosTable.projectId, row.gallery.projectId),
      eq(studentPhotosTable.studentId, access.student.id),
    ))
    .orderBy(studentPhotosTable.createdAt);

  res.json({
    gallery: publicGallery(row.gallery, row.studio),
    student: {
      firstName: access.student.firstName,
      lastName: access.student.lastName,
    },
    photos: photos.map((photo) => ({
      id: photo.id,
      fileName: photo.fileName,
      mimeType: photo.mimeType,
      fileUrl: `/api/delivery/${row.gallery.slug}/photos/${photo.id}/file?token=${encodeURIComponent(String(req.header("x-delivery-token") ?? req.query.token ?? ""))}`,
    })),
  });
});

router.get("/delivery/:slug/photos/:photoId/file", async (req, res): Promise<void> => {
  const row = await getGalleryBySlug(String(req.params.slug));
  const photoId = Number(req.params.photoId);
  if (!row || !activeGallery(row.gallery) || !Number.isInteger(photoId)) {
    res.status(404).json({ error: "Photo not found" });
    return;
  }
  const verified = verifyToken(String(req.query.token ?? req.header("x-delivery-token") ?? ""), row.gallery.id);
  if (!verified) {
    res.status(401).json({ error: "Delivery access has expired" });
    return;
  }

  const [photo] = await db
    .select({ photo: studentPhotosTable })
    .from(studentPhotosTable)
    .innerJoin(deliveryAccessesTable, eq(deliveryAccessesTable.studentId, studentPhotosTable.studentId))
    .where(and(
      eq(studentPhotosTable.id, photoId),
      eq(studentPhotosTable.projectId, row.gallery.projectId),
      eq(deliveryAccessesTable.id, verified.accessId),
      eq(deliveryAccessesTable.galleryId, row.gallery.id),
      isNull(deliveryAccessesTable.revokedAt),
    ))
    .limit(1);
  if (!photo) {
    res.status(404).json({ error: "Photo not found" });
    return;
  }

  const filePath = photoFilePath(photo.photo.fileUrl);
  if (!fs.existsSync(filePath)) {
    res.status(404).json({ error: "Photo file is not available" });
    return;
  }
  res.setHeader("Content-Type", photo.photo.mimeType || "image/jpeg");
  res.setHeader("Content-Disposition", `inline; filename="${photo.photo.fileName.replace(/["\r\n]/g, "_")}"`);
  res.setHeader("Cache-Control", "private, max-age=300");
  res.sendFile(filePath);
});

// Studio-owner/admin controls.
router.get("/projects/:projectId/delivery", requireAuth, async (req, res): Promise<void> => {
  const projectId = Number(req.params.projectId);
  if (!Number.isInteger(projectId) || !(await canAccessProject(getUserId(req), projectId, "view"))) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const [gallery] = await db.select().from(deliveryGalleriesTable).where(eq(deliveryGalleriesTable.projectId, projectId)).limit(1);
  if (!gallery) {
    res.json({ gallery: null, accessCount: 0 });
    return;
  }
  const accesses = await db.select().from(deliveryAccessesTable).where(eq(deliveryAccessesTable.galleryId, gallery.id));
  res.json({
    gallery: {
      ...gallery,
      publishedAt: gallery.publishedAt?.toISOString() ?? null,
      expiresAt: gallery.expiresAt?.toISOString() ?? null,
      createdAt: gallery.createdAt.toISOString(),
      updatedAt: gallery.updatedAt.toISOString(),
    },
    accessCount: accesses.filter((access) => !access.revokedAt).length,
  });
});

router.post("/projects/:projectId/delivery/publish", requireAuth, async (req, res): Promise<void> => {
  const projectId = Number(req.params.projectId);
  const userId = getUserId(req);
  if (!Number.isInteger(projectId) || !(await canAccessProject(userId, projectId, "manage"))) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const [project] = await db.select().from(projectsTable).where(eq(projectsTable.id, projectId)).limit(1);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  let [gallery] = await db.select().from(deliveryGalleriesTable).where(eq(deliveryGalleriesTable.projectId, projectId)).limit(1);
  const now = new Date();
  if (!gallery) {
    [gallery] = await db.insert(deliveryGalleriesTable).values({
      projectId,
      studioId: project.studioId,
      slug: `vc-${randomBytes(8).toString("hex")}`,
      status: "published",
      publishedAt: now,
      updatedAt: now,
    }).returning();
  } else {
    [gallery] = await db.update(deliveryGalleriesTable).set({
      status: "published",
      publishedAt: gallery.publishedAt ?? now,
      updatedAt: now,
    }).where(eq(deliveryGalleriesTable.id, gallery.id)).returning();
  }

  const students = await db.select().from(studentsTable).where(eq(studentsTable.projectId, projectId));
  const existing = await db.select().from(deliveryAccessesTable).where(eq(deliveryAccessesTable.galleryId, gallery.id));
  const existingByStudent = new Map(existing.map((access) => [access.studentId, access]));
  for (const student of students) {
    if (existingByStudent.has(student.id)) continue;
    const code = makeCode();
    await db.insert(deliveryAccessesTable).values({
      galleryId: gallery.id,
      studentId: student.id,
      accessCodeHash: hashCode(code),
      accessCodeEncrypted: encryptStorageValue(code),
      accessCodeLast4: code.slice(-4),
    });
  }

  res.json({
    gallery: {
      ...gallery,
      publishedAt: gallery.publishedAt?.toISOString() ?? null,
      expiresAt: gallery.expiresAt?.toISOString() ?? null,
      createdAt: gallery.createdAt.toISOString(),
      updatedAt: gallery.updatedAt.toISOString(),
    },
    publicUrl: `/delivery/${gallery.slug}`,
    message: "Delivery is published. Download the access-card list to share each private code.",
  });
});

router.get("/projects/:projectId/delivery/access-cards", requireAuth, async (req, res): Promise<void> => {
  const projectId = Number(req.params.projectId);
  if (!Number.isInteger(projectId) || !(await canAccessProject(getUserId(req), projectId, "manage"))) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const [gallery] = await db.select().from(deliveryGalleriesTable).where(eq(deliveryGalleriesTable.projectId, projectId)).limit(1);
  if (!gallery) {
    res.status(404).json({ error: "Publish the delivery gallery first" });
    return;
  }
  const rows = await db
    .select({ access: deliveryAccessesTable, student: studentsTable })
    .from(deliveryAccessesTable)
    .innerJoin(studentsTable, eq(deliveryAccessesTable.studentId, studentsTable.id))
    .where(and(eq(deliveryAccessesTable.galleryId, gallery.id), isNull(deliveryAccessesTable.revokedAt)));

  res.json(rows.map(({ access, student }) => ({
    firstName: student.firstName,
    lastName: student.lastName,
    generatedStudentId: student.generatedStudentId,
    accessCode: decryptStorageValue<string>(access.accessCodeEncrypted),
    accessUrl: `/delivery/${gallery.slug}?code=${encodeURIComponent(decryptStorageValue<string>(access.accessCodeEncrypted))}`,
  })));
});

export default router;