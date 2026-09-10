import { Router } from "express";
import QRCode from "qrcode";
import { Readable } from "node:stream";
import sharp from "sharp";
import Stripe from "stripe";
import {
  db,
  deliveryAccessesTable,
  deliveryGalleriesTable,
  deliveryOrderItemsTable,
  deliveryOrdersTable,
  classesTable,
  projectsTable,
  studentPhotosTable,
  studentsTable,
  studiosTable,
} from "@workspace/db";
import { and, eq, inArray, isNull, isNotNull } from "drizzle-orm";
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { requireAuth, getUserId } from "../lib/auth";
import { canAccessProject } from "../lib/studioAccess";
import { decryptStorageValue, encryptStorageValue } from "../lib/storageCrypto";
import { objectStorageService, ObjectNotFoundError } from "../lib/objectStorage";
import { getUncachableStripeClient } from "../lib/stripeClient";

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

async function getDeliveryPrice(): Promise<Stripe.Price> {
  const stripe = await getUncachableStripeClient();
  const products = await stripe.products.search({
    query: "name:'Volume Capture digital photo' AND active:'true'",
  });
  const product = products.data[0];
  if (!product) throw new Error("The delivery photo price has not been configured");
  const prices = await stripe.prices.list({ product: product.id, active: true, type: "one_time", limit: 20 });
  const price = prices.data.find((candidate) => candidate.metadata.kind === "delivery_photo") ?? prices.data[0];
  if (!price || !price.unit_amount) throw new Error("The delivery photo price has not been configured");
  return price;
}

async function getAccessForToken(galleryId: number, accessId: number) {
  const [access] = await db
    .select({ access: deliveryAccessesTable, student: studentsTable })
    .from(deliveryAccessesTable)
    .innerJoin(studentsTable, eq(deliveryAccessesTable.studentId, studentsTable.id))
    .where(and(
      eq(deliveryAccessesTable.id, accessId),
      eq(deliveryAccessesTable.galleryId, galleryId),
      isNull(deliveryAccessesTable.revokedAt),
    ))
    .limit(1);
  return access ?? null;
}

async function photoHasBeenPaid(accessId: number, photoId: number): Promise<boolean> {
  const [item] = await db
    .select({ id: deliveryOrderItemsTable.id })
    .from(deliveryOrderItemsTable)
    .innerJoin(deliveryOrdersTable, eq(deliveryOrderItemsTable.orderId, deliveryOrdersTable.id))
    .where(and(
      eq(deliveryOrdersTable.accessId, accessId),
      eq(deliveryOrdersTable.status, "paid"),
      eq(deliveryOrderItemsTable.photoId, photoId),
    ))
    .limit(1);
  return Boolean(item);
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

  const access = await getAccessForToken(row.gallery.id, verified.accessId);
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
    price: await getDeliveryPrice().then((price) => ({
      unitAmount: price.unit_amount,
      currency: price.currency,
    })),
    photos: photos.filter((photo) => photo.durableObjectPath).map((photo) => ({
      id: photo.id,
      fileName: photo.fileName,
      mimeType: photo.mimeType,
      fileUrl: `/api/delivery/${row.gallery.slug}/photos/${photo.id}/file?preview=1&token=${encodeURIComponent(String(req.header("x-delivery-token") ?? req.query.token ?? ""))}`,
      downloadUrl: `/api/delivery/${row.gallery.slug}/photos/${photo.id}/file?download=1&token=${encodeURIComponent(String(req.header("x-delivery-token") ?? req.query.token ?? ""))}`,
    })),
  });
});

router.post("/delivery/:slug/orders", async (req, res): Promise<void> => {
  const row = await getGalleryBySlug(String(req.params.slug));
  if (!row || !activeGallery(row.gallery)) {
    res.status(404).json({ error: "Delivery gallery not found or no longer available" });
    return;
  }
  const verified = verifyToken(String(req.body?.token ?? ""), row.gallery.id);
  if (!verified) {
    res.status(401).json({ error: "Delivery access has expired. Enter the code again." });
    return;
  }
  const access = await getAccessForToken(row.gallery.id, verified.accessId);
  if (!access) {
    res.status(401).json({ error: "Delivery access has been revoked" });
    return;
  }
  const rawPhotoIds: unknown[] = Array.isArray(req.body?.photoIds) ? req.body.photoIds : [];
  const photoIds: number[] = [...new Set(
    rawPhotoIds
      .map((id) => Number(id))
      .filter((id): id is number => Number.isInteger(id) && id > 0),
  )];
  if (photoIds.length < 1 || photoIds.length > 100) {
    res.status(400).json({ error: "Select between 1 and 100 photos" });
    return;
  }

  const photos = await db
    .select()
    .from(studentPhotosTable)
    .where(and(
      eq(studentPhotosTable.projectId, row.gallery.projectId),
      eq(studentPhotosTable.studentId, access.student.id),
      inArray(studentPhotosTable.id, photoIds),
      isNotNull(studentPhotosTable.durableObjectPath),
    ));
  if (photos.length !== photoIds.length) {
    res.status(400).json({ error: "One or more selected photos are not available for ordering" });
    return;
  }

  try {
    const price = await getDeliveryPrice();
    const stripe = await getUncachableStripeClient();
    const [order] = await db.insert(deliveryOrdersTable).values({
      galleryId: row.gallery.id,
      accessId: access.access.id,
      status: "pending",
      stripeCheckoutSessionId: `pending-${randomUUID()}`,
      amountTotal: price.unit_amount! * photos.length,
      currency: price.currency,
    }).returning();
    await db.insert(deliveryOrderItemsTable).values(photos.map((photo) => ({
      orderId: order.id,
      photoId: photo.id,
      unitAmount: price.unit_amount!,
      currency: price.currency,
    })));

    const forwardedProto = req.get("x-forwarded-proto")?.split(",")[0]?.trim();
    const origin = `${forwardedProto || req.protocol}://${req.get("host")}`;
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [{ price: price.id, quantity: photos.length }],
      customer_creation: "always",
      metadata: { orderId: String(order.id), gallerySlug: row.gallery.slug },
      success_url: `${origin}/delivery/${row.gallery.slug}?paid=1&order=${order.id}`,
      cancel_url: `${origin}/delivery/${row.gallery.slug}?cancelled=1`,
    });
    await db.update(deliveryOrdersTable).set({
      stripeCheckoutSessionId: session.id,
    }).where(eq(deliveryOrdersTable.id, order.id));
    res.json({ checkoutUrl: session.url, orderId: order.id });
  } catch (error) {
    res.status(503).json({ error: error instanceof Error ? error.message : "Checkout is not available yet" });
  }
});

router.get("/delivery/:slug/orders/:orderId", async (req, res): Promise<void> => {
  const row = await getGalleryBySlug(String(req.params.slug));
  const orderId = Number(req.params.orderId);
  if (!row || !activeGallery(row.gallery) || !Number.isInteger(orderId)) {
    res.status(404).json({ error: "Order not found" });
    return;
  }
  const verified = verifyToken(String(req.query.token ?? req.header("x-delivery-token") ?? ""), row.gallery.id);
  if (!verified) {
    res.status(401).json({ error: "Delivery access has expired" });
    return;
  }
  const [order] = await db
    .select()
    .from(deliveryOrdersTable)
    .where(and(
      eq(deliveryOrdersTable.id, orderId),
      eq(deliveryOrdersTable.galleryId, row.gallery.id),
      eq(deliveryOrdersTable.accessId, verified.accessId),
    ))
    .limit(1);
  if (!order) {
    res.status(404).json({ error: "Order not found" });
    return;
  }
  const items = await db
    .select({ photoId: deliveryOrderItemsTable.photoId })
    .from(deliveryOrderItemsTable)
    .where(eq(deliveryOrderItemsTable.orderId, order.id));
  res.json({
    orderId: order.id,
    status: order.status,
    amountTotal: order.amountTotal,
    currency: order.currency,
    paidAt: order.paidAt?.toISOString() ?? null,
    photoIds: items.map((item) => item.photoId),
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

  if (!photo.photo.durableObjectPath) {
    res.status(404).json({ error: "Photo is not available for delivery" });
    return;
  }
  const isPreview = req.query.preview === "1";
  if (!isPreview && !(await photoHasBeenPaid(verified.accessId, photoId))) {
    res.status(402).json({ error: "Complete payment before downloading this photo" });
    return;
  }
  let objectFile;
  try {
    objectFile = await objectStorageService.getObjectEntityFile(photo.photo.durableObjectPath);
  } catch (error) {
    if (error instanceof ObjectNotFoundError) {
      res.status(404).json({ error: "Photo file is not available" });
      return;
    }
    throw error;
  }
  res.setHeader("Content-Type", photo.photo.mimeType || "image/jpeg");
  res.setHeader("Content-Disposition", `${isPreview ? "inline" : "attachment"}; filename="${photo.photo.fileName.replace(/["\r\n]/g, "_")}"`);
  res.setHeader("Cache-Control", "private, max-age=300");
  const input = objectFile.createReadStream();
  if (isPreview) {
    res.setHeader("Content-Type", "image/jpeg");
    input.pipe(sharp().resize({ width: 1200, withoutEnlargement: true }).jpeg({ quality: 78 })).pipe(res);
    return;
  }
  input.pipe(res);
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
  const [undeliverablePhoto] = await db
    .select({ id: studentPhotosTable.id })
    .from(studentPhotosTable)
    .where(and(
      eq(studentPhotosTable.projectId, projectId),
      isNull(studentPhotosTable.durableObjectPath),
    ))
    .limit(1);
  if (undeliverablePhoto) {
    res.status(409).json({
      error: "Some photos are not in durable storage yet. Re-upload them before publishing delivery.",
      code: "PHOTO_STORAGE_INCOMPLETE",
    });
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
    .select({ access: deliveryAccessesTable, student: studentsTable, className: classesTable.className })
    .from(deliveryAccessesTable)
    .innerJoin(studentsTable, eq(deliveryAccessesTable.studentId, studentsTable.id))
    .leftJoin(classesTable, eq(studentsTable.classId, classesTable.id))
    .where(and(eq(deliveryAccessesTable.galleryId, gallery.id), isNull(deliveryAccessesTable.revokedAt)));

  const forwardedProtocol = String(req.get("x-forwarded-proto") ?? "").split(",")[0].trim();
  const forwardedHost = String(req.get("x-forwarded-host") ?? "").split(",")[0].trim();
  const origin = `${forwardedProtocol || req.protocol}://${forwardedHost || req.get("host")}`;
  res.json(await Promise.all(rows.map(async ({ access, student, className }) => {
    const accessCode = decryptStorageValue<string>(access.accessCodeEncrypted);
    const accessUrl = `/delivery/${gallery.slug}?code=${encodeURIComponent(accessCode)}`;
    return {
      firstName: student.firstName,
      lastName: student.lastName,
      generatedStudentId: student.generatedStudentId,
      className,
      accessCode,
      accessUrl,
      qrDataUrl: await QRCode.toDataURL(`${origin}${accessUrl}`, {
        errorCorrectionLevel: "M",
        margin: 2,
        width: 320,
      }),
    };
  })));
});

export default router;