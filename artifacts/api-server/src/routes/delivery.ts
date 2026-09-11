import { Router } from "express";
import QRCode from "qrcode";
import { Readable } from "node:stream";
import sharp from "sharp";
import Stripe from "stripe";
import {
  db,
  deliveryAccessesTable,
  deliveryGalleriesTable,
  deliveryPriceSheetsTable,
  deliveryOrderItemsTable,
  deliveryOrdersTable,
  classesTable,
  captureFilesTable,
  capturesTable,
  projectsTable,
  studentPhotosTable,
  studentsTable,
  studiosTable,
} from "@workspace/db";
import { and, eq, gt, inArray, isNull, isNotNull } from "drizzle-orm";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { requireAuth, getUserId } from "../lib/auth";
import { canAccessProject, getStudioMember } from "../lib/studioAccess";
import { decryptStorageValue, encryptStorageValue } from "../lib/storageCrypto";
import { objectStorageService, ObjectNotFoundError } from "../lib/objectStorage";
import { getUncachableStripeClient } from "../lib/stripeClient";
import { deliveryAmount, deliveryOrderQuantity, validateDeliverySelection } from "../lib/deliveryOfferRules";
import { materializeGroupJpegsForDelivery } from "../lib/groupDeliveryPhotos";

const router = Router();
const DELIVERY_TOKEN_TTL_SECONDS = 2 * 60 * 60;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const ACCESS_MAX_FAILURES = 5;
const ACCESS_LOCK_SECONDS = 15 * 60;

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

function signMediaToken(payload: { galleryId: number; accessId: number; photoId: number; expiresAt: number }): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encoded}.${createHmac("sha256", tokenSecret()).update(encoded).digest("base64url")}`;
}

function verifyMediaToken(token: string, galleryId: number, photoId: number): { accessId: number } | null {
  const [encoded, signature] = token.split(".");
  if (!encoded || !signature) return null;
  const expected = createHmac("sha256", tokenSecret()).update(encoded).digest("base64url");
  if (expected.length !== signature.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) return null;
  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as {
      galleryId: number; accessId: number; photoId: number; expiresAt: number;
    };
    if (payload.galleryId !== galleryId || payload.photoId !== photoId || payload.expiresAt < Math.floor(Date.now() / 1000)) return null;
    return { accessId: payload.accessId };
  } catch { return null; }
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

async function materializeCaptureJpegsForDelivery(projectId: number): Promise<number> {
  const jpegCaptures = await db
    .select({
      capture: capturesTable,
      file: captureFilesTable,
    })
    .from(capturesTable)
    .innerJoin(captureFilesTable, and(
      eq(captureFilesTable.captureId, capturesTable.id),
      eq(captureFilesTable.fileRole, "JPEG"),
      isNotNull(captureFilesTable.durableObjectPath),
    ))
    .where(eq(capturesTable.projectId, projectId));

  if (jpegCaptures.length === 0) return 0;

  const existing = await db
    .select({
      studentId: studentPhotosTable.studentId,
      fileName: studentPhotosTable.fileName,
    })
    .from(studentPhotosTable)
    .where(eq(studentPhotosTable.projectId, projectId));
  const existingKeys = new Set(existing.map((photo) => `${photo.studentId}:${photo.fileName}`));
  const missing = jpegCaptures.filter(({ capture, file }) =>
    !existingKeys.has(`${capture.studentId}:${file.originalFilename}`),
  );
  if (missing.length === 0) return 0;

  await db.insert(studentPhotosTable).values(missing.map(({ capture, file }) => ({
    projectId: capture.projectId,
    studentId: capture.studentId,
    fileName: file.originalFilename,
    fileUrl: file.fileUrl,
    durableObjectPath: file.durableObjectPath,
    mimeType: file.mimeType,
    capturedAt: capture.capturedAt,
    captureBatchId: file.captureBatchId,
    desktopConnectionId: file.desktopConnectionId,
    clientUploadId: file.clientUploadId,
    rating: capture.rating,
    colorLabel: capture.colorLabel,
  }))).onConflictDoNothing();
  return missing.length;
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

type DeliveryOffer = {
  id: string; name: string; description?: string; productType: "digital" | "print" | "pack";
  stripePriceId?: string; unitAmount: number | null; currency: string | null;
  paymentMethods: Array<"stripe" | "establishment" | "bank_transfer">;
  photoCount: number; printSize?: string;
  deliveryMethods: Array<"digital" | "school" | "collection" | "shipping">; active: boolean;
  includesDigitalDownloads: boolean;
};


function parseOffers(raw: string | null): DeliveryOffer[] {
  if (!raw) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error("Saved delivery price sheet is invalid JSON"); }
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { offers?: unknown }).offers)) {
    throw new Error("Delivery price sheet must contain an offers array");
  }
  return (parsed as { offers: unknown[] }).offers.map((value): DeliveryOffer => {
    if (!value || typeof value !== "object") throw new Error("Delivery offer must be an object");
    const offer = value as Record<string, unknown>;
    const methods = offer.deliveryMethods;
    const paymentMethods = offer.paymentMethods === undefined ? ["stripe"] : offer.paymentMethods;
    const unitAmount = Number.isSafeInteger(offer.unitAmount) && Number(offer.unitAmount) >= 0
      ? Number(offer.unitAmount)
      : null;
    const currency = typeof offer.currency === "string" && /^[A-Za-z]{3}$/.test(offer.currency)
      ? offer.currency.toLowerCase()
      : null;
    if (typeof offer.id !== "string" || typeof offer.name !== "string"
      || !["digital", "print", "pack"].includes(String(offer.productType))
      || !Number.isInteger(offer.photoCount) || Number(offer.photoCount) < 1
      || !Array.isArray(methods) || methods.length === 0
      || methods.some((method) => !["digital", "school", "collection", "shipping"].includes(String(method)))
      || !Array.isArray(paymentMethods) || paymentMethods.length === 0
      || paymentMethods.some((method) => !["stripe", "establishment", "bank_transfer"].includes(String(method)))
      || typeof offer.active !== "boolean") {
      throw new Error("Invalid delivery offer; check product type, photo count, delivery methods, payment methods, and active flag");
    }
    return {
      id: offer.id, name: offer.name, description: typeof offer.description === "string" ? offer.description : undefined,
      productType: offer.productType as DeliveryOffer["productType"],
      stripePriceId: typeof offer.stripePriceId === "string" ? offer.stripePriceId : undefined,
      unitAmount,
      currency,
      paymentMethods: paymentMethods as DeliveryOffer["paymentMethods"],
      photoCount: Number(offer.photoCount), printSize: typeof offer.printSize === "string" ? offer.printSize : undefined,
      deliveryMethods: methods as DeliveryOffer["deliveryMethods"], active: offer.active,
      includesDigitalDownloads: offer.includesDigitalDownloads === true,
    };
  });
}

async function activeStripeCatalog(): Promise<Array<{ productId: string; priceId: string; name: string; amount: number; currency: string }>> {
  const stripe = await getUncachableStripeClient();
  const prices = await stripe.prices.list({ active: true, type: "one_time", limit: 100, expand: ["data.product"] });
  return prices.data.filter((price) => price.unit_amount !== null && typeof price.product !== "string" && "active" in price.product && price.product.active)
    .map((price) => {
      const product = price.product as Stripe.Product;
      return { productId: product.id, priceId: price.id, name: product.name, amount: price.unit_amount!, currency: price.currency };
    });
}

function pricedOffers(offers: DeliveryOffer[]): Array<Omit<DeliveryOffer, "unitAmount" | "currency"> & {
  unitAmount: number; currency: string; pricingRules: { selection: string; quantity: string };
}> {
  return offers.flatMap((offer) => {
    if (offer.unitAmount === null || !offer.currency) return [];
    return {
      ...offer,
      unitAmount: offer.unitAmount,
      currency: offer.currency,
      pricingRules: {
        selection: offer.productType === "digital" && offer.photoCount === 1
          ? "1..100 selected photos"
          : offer.productType === "print"
            ? "exactly 1 selected photo"
            : `exactly ${offer.photoCount} × quantity selected photos`,
        quantity: offer.productType === "print"
          ? "quantity is print copies for one selected photo"
          : offer.productType === "pack" ? "quantity is number of packs" : "derived from selected photo count",
      },
    };
  });
}

async function stripeIsAvailable(): Promise<boolean> {
  try {
    await getUncachableStripeClient();
    return true;
  } catch {
    return false;
  }
}

function manualPaymentInstructions(
  gallery: typeof deliveryGalleriesTable.$inferSelect,
  paymentMethod: "establishment" | "bank_transfer",
): string {
  if (paymentMethod === "bank_transfer") {
    return gallery.bankTransferInstructions?.trim()
      || "Use the order number as your bank transfer reference, then contact the photography studio to confirm payment.";
  }
  return gallery.establishmentPaymentInstructions?.trim()
    || "Pay at the establishment and provide the order number so the photography studio can confirm payment.";
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

function accessIsUsable(access: typeof deliveryAccessesTable.$inferSelect): boolean {
  const now = new Date();
  return !access.revokedAt
    && (!access.expiresAt || access.expiresAt > now)
    && (!access.lockedUntil || access.lockedUntil <= now);
}

function watermarkSvg(text: string): Buffer {
  const safeText = text.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&apos;",
  }[character] ?? character)).slice(0, 120);
  return Buffer.from(`<svg width="900" height="600" xmlns="http://www.w3.org/2000/svg">
    <g transform="rotate(-28 450 300)" fill="white" fill-opacity=".28"
      font-family="Arial,sans-serif" font-size="42" font-weight="700">
      <text x="-120" y="180">${safeText}</text><text x="280" y="180">${safeText}</text>
      <text x="-120" y="390">${safeText}</text><text x="280" y="390">${safeText}</text>
    </g>
  </svg>`);
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
      eq(deliveryOrderItemsTable.includesDigitalDownloads, true),
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

router.get("/delivery/:slug/catalog", async (req, res): Promise<void> => {
  const row = await getGalleryBySlug(String(req.params.slug));
  if (!row || !activeGallery(row.gallery)) { res.status(404).json({ error: "Delivery gallery not found or no longer available" }); return; }
  const offers = parseOffers(row.gallery.priceSheetJson).filter((offer) => offer.active);
  res.json({ offers: pricedOffers(offers) });
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
  // Deliberately use the same response for malformed, unknown, expired, and
  // revoked cards: card ownership must not be enumerable.
  if (!access || !accessIsUsable(access)) {
    if (access) {
      const now = new Date();
      await db.update(deliveryAccessesTable).set({
        lastAttemptAt: now,
        failedAttempts: Math.min(ACCESS_MAX_FAILURES, access.failedAttempts + 1),
        lockedUntil: access.failedAttempts + 1 >= ACCESS_MAX_FAILURES
          ? new Date(now.getTime() + ACCESS_LOCK_SECONDS * 1000)
          : access.lockedUntil,
      }).where(eq(deliveryAccessesTable.id, access.id));
    }
    res.status(401).json({ error: "That access code is not valid" });
    return;
  }
  if (access.lockedUntil && access.lockedUntil <= new Date()) {
    access.failedAttempts = 0;
    access.lockedUntil = null;
    await db.update(deliveryAccessesTable).set({ failedAttempts: 0, lockedUntil: null })
      .where(eq(deliveryAccessesTable.id, access.id));
  }

  await db.update(deliveryAccessesTable).set({
    lastAttemptAt: new Date(),
    failedAttempts: 0,
    lockedUntil: null,
  }).where(eq(deliveryAccessesTable.id, access.id));

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
  const verified = verifyToken(String(req.header("x-delivery-token") ?? req.body?.token ?? ""), row.gallery.id);
  if (!verified) {
    res.status(401).json({ error: "Delivery access has expired. Enter the code again." });
    return;
  }

  const access = await getAccessForToken(row.gallery.id, verified.accessId);
  if (!access || !accessIsUsable(access.access)) {
    res.status(401).json({ error: "Delivery access has been revoked" });
    return;
  }

  const photos = await db
    .select()
    .from(studentPhotosTable)
    .where(and(
      eq(studentPhotosTable.projectId, row.gallery.projectId),
      eq(studentPhotosTable.studentId, access.student.id),
      isNotNull(studentPhotosTable.durableObjectPath),
      gt(studentPhotosTable.rating, 0),
    ))
    .orderBy(studentPhotosTable.createdAt);

  const offers = parseOffers(row.gallery.priceSheetJson).filter((offer) => offer.active);
  const priced = pricedOffers(offers);
  const stripeOffered = priced.some((offer) => offer.paymentMethods.includes("stripe"));
  const stripeAvailable = stripeOffered ? await stripeIsAvailable() : false;

  res.json({
    gallery: publicGallery(row.gallery, row.studio),
    student: {
      firstName: access.student.firstName,
      lastName: access.student.lastName,
    },
    price: priced[0] ? { unitAmount: priced[0].unitAmount, currency: priced[0].currency } : null,
    offers: priced,
    orderingAvailable: priced.length > 0,
    stripeAvailable,
    photos: photos.map((photo) => ({
      id: photo.id,
      fileName: photo.fileName,
      mimeType: photo.mimeType,
      fileUrl: `/api/delivery/${row.gallery.slug}/photos/${photo.id}/file?preview=1&mediaToken=${encodeURIComponent(signMediaToken({ galleryId: row.gallery.id, accessId: verified.accessId, photoId: photo.id, expiresAt: Math.floor(Date.now() / 1000) + 15 * 60 }))}`,
      downloadUrl: `/api/delivery/${row.gallery.slug}/photos/${photo.id}/file?download=1&mediaToken=${encodeURIComponent(signMediaToken({ galleryId: row.gallery.id, accessId: verified.accessId, photoId: photo.id, expiresAt: Math.floor(Date.now() / 1000) + 15 * 60 }))}`,
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
  if (!access || !accessIsUsable(access.access)) {
    res.status(401).json({ error: "Delivery access has been revoked" });
    return;
  }
  const submittedItems: unknown[] = Array.isArray(req.body?.items) && req.body.items.length > 0
    ? req.body.items
    : [{
      offerId: req.body?.offerId ?? "digital-single",
      photoIds: req.body?.photoIds,
      quantity: req.body?.quantity ?? 1,
    }];
  if (submittedItems.length < 1 || submittedItems.length > 20) {
    res.status(400).json({ error: "A basket must contain between 1 and 20 products" });
    return;
  }
  const basket = submittedItems.map((value) => {
    const item = value && typeof value === "object" ? value as Record<string, unknown> : {};
    const rawPhotoIds = Array.isArray(item.photoIds) ? item.photoIds : [];
    return {
      offerId: typeof item.offerId === "string" ? item.offerId : "",
      photoIds: [...new Set(rawPhotoIds.map(Number).filter((id) => Number.isInteger(id) && id > 0))],
      quantity: Number(item.quantity ?? 1),
    };
  });
  if (basket.some((item) => !item.offerId || item.photoIds.length < 1 || item.photoIds.length > 100
    || !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 100)) {
    res.status(400).json({ error: "Every basket product needs a valid offer, photo selection, and quantity" });
    return;
  }
  const photoIds = [...new Set(basket.flatMap((item) => item.photoIds))];

  const photos = await db
    .select()
    .from(studentPhotosTable)
    .where(and(
      eq(studentPhotosTable.projectId, row.gallery.projectId),
      eq(studentPhotosTable.studentId, access.student.id),
      inArray(studentPhotosTable.id, photoIds),
      isNotNull(studentPhotosTable.durableObjectPath),
      gt(studentPhotosTable.rating, 0),
    ));
  if (photos.length !== photoIds.length) {
    res.status(400).json({ error: "One or more selected photos are not available for ordering" });
    return;
  }

  try {
    const savedOffers = parseOffers(row.gallery.priceSheetJson).filter((offer) => offer.active);
    const lines = basket.map((item) => ({
      item,
      offer: savedOffers.find((candidate) => candidate.id === item.offerId),
      photos: item.photoIds.map((id) => photos.find((photo) => photo.id === id)).filter(Boolean),
    }));
    if (lines.some((line) => !line.offer || line.photos.length !== line.item.photoIds.length
      || line.offer.unitAmount === null || !line.offer.currency)) {
      res.status(400).json({ error: "One or more basket products are not available" }); return;
    }
    const validLines = lines as Array<{
      item: { offerId: string; photoIds: number[]; quantity: number };
      offer: DeliveryOffer & { unitAmount: number; currency: string };
      photos: typeof photos;
    }>;
    const currencies = new Set(validLines.map((line) => line.offer.currency));
    if (currencies.size !== 1) {
      res.status(400).json({ error: "All basket products must use the same currency" }); return;
    }
    const deliveryMethod = String(req.body?.deliveryMethod ?? validLines[0].offer.deliveryMethods[0]);
    const paymentMethod = String(req.body?.paymentMethod ?? "");
    if (validLines.some(({ offer }) => !offer.deliveryMethods.includes(deliveryMethod as DeliveryOffer["deliveryMethods"][number]))) {
      res.status(400).json({ error: "The selected delivery method is not available for every basket product" }); return;
    }
    if (validLines.some(({ offer }) => !offer.paymentMethods.includes(paymentMethod as DeliveryOffer["paymentMethods"][number]))) {
      res.status(400).json({ error: "The selected payment method is not available for every basket product" }); return;
    }
    try {
      for (const { offer, photos: linePhotos, item } of validLines) {
        validateDeliverySelection(offer.productType, offer.photoCount, linePhotos.length, item.quantity, true);
      }
    } catch {
      res.status(400).json({ error: "A basket product has the wrong photo count or quantity" }); return;
    }
    if (deliveryMethod === "shipping" && (typeof req.body?.deliveryAddress !== "string" || !req.body.deliveryAddress.trim())) {
      res.status(400).json({ error: "A shipping address is required" }); return;
    }
    const customerName = typeof req.body?.customerName === "string" ? req.body.customerName.trim() : "";
    const customerEmail = typeof req.body?.customerEmail === "string" ? req.body.customerEmail.trim() : "";
    if (!customerName) {
      res.status(400).json({ error: "Customer name is required" }); return;
    }
    if (customerEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail)) {
      res.status(400).json({ error: "Enter a valid customer email" }); return;
    }
    const pricedLines = validLines.map((line) => {
      const orderQuantity = deliveryOrderQuantity(
        line.offer.productType, line.offer.photoCount, line.photos.length, line.item.quantity,
      );
      return { ...line, orderQuantity, lineTotal: deliveryAmount(line.offer.unitAmount, orderQuantity) };
    });
    const amountTotal = pricedLines.reduce((total, line) => total + line.lineTotal, 0);
    const currency = pricedLines[0].offer.currency;
    const order = await db.transaction(async (tx) => {
      const [created] = await tx.insert(deliveryOrdersTable).values({
        galleryId: row.gallery.id,
        accessId: access.access.id,
        status: "pending",
        paymentMethod: paymentMethod as "stripe" | "establishment" | "bank_transfer",
        stripeCheckoutSessionId: null,
        customerName,
        customerEmail: customerEmail || null,
        deliveryMethod: deliveryMethod as "digital" | "school" | "collection" | "shipping",
        deliveryAddress: deliveryMethod === "shipping" ? req.body.deliveryAddress.trim() : null,
        fulfillmentStatus: "not_required",
        amountTotal,
        currency,
      }).returning();
      const orderItems = pricedLines.flatMap(({ offer, photos: linePhotos, item }) => {
        const rows = offer.productType === "print"
          ? [{ photoId: linePhotos[0].id, quantity: item.quantity }]
          : linePhotos.map((photo) => ({ photoId: photo.id, quantity: 1 }));
        return rows.map(({ photoId, quantity }) => ({
          orderId: created.id, photoId, offerId: offer.id, productName: offer.name,
          productType: offer.productType, includesDigitalDownloads: offer.includesDigitalDownloads,
          printSize: offer.printSize ?? null, quantity, unitAmount: offer.unitAmount, currency: offer.currency,
        }));
      });
      await tx.insert(deliveryOrderItemsTable).values(orderItems);
      return created;
    });

    if (paymentMethod !== "stripe") {
      res.json({
        checkoutUrl: null,
        orderId: order.id,
        status: order.status,
        paymentMethod,
        paymentInstructions: manualPaymentInstructions(row.gallery, paymentMethod as "establishment" | "bank_transfer"),
      });
      return;
    }

    const stripe = await getUncachableStripeClient();
    const forwardedProto = req.get("x-forwarded-proto")?.split(",")[0]?.trim();
    const origin = `${forwardedProto || req.protocol}://${req.get("host")}`;
    let session;
    try {
      session = await stripe.checkout.sessions.create({
        mode: "payment",
        line_items: pricedLines.map(({ offer, orderQuantity }) => ({
          price_data: {
            currency: offer.currency,
            unit_amount: offer.unitAmount,
            product_data: {
              name: offer.name,
              ...(offer.description ? { description: offer.description } : {}),
            },
          },
          quantity: orderQuantity,
        })),
        customer_creation: "always",
        ...(customerEmail ? { customer_email: customerEmail } : {}),
        ...(deliveryMethod === "shipping" ? {
          shipping_address_collection: { allowed_countries: ["MA", "US", "CA", "GB", "AU", "NZ"] },
        } : {}),
        metadata: { orderId: String(order.id), gallerySlug: row.gallery.slug },
        success_url: `${origin}/delivery/${row.gallery.slug}?paid=1&order=${order.id}`,
        cancel_url: `${origin}/delivery/${row.gallery.slug}?cancelled=1&order=${order.id}`,
      });
    } catch (error) {
      await db.update(deliveryOrdersTable).set({ status: "cancelled" })
        .where(eq(deliveryOrdersTable.id, order.id));
      throw error;
    }
    await db.update(deliveryOrdersTable).set({
      stripeCheckoutSessionId: session.id,
    }).where(eq(deliveryOrdersTable.id, order.id));
    res.json({
      checkoutUrl: session.url,
      orderId: order.id,
      status: order.status,
      paymentMethod,
      paymentInstructions: null,
    });
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
  const verified = verifyToken(String(req.header("x-delivery-token") ?? req.body?.token ?? ""), row.gallery.id);
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
    .select({ photoId: deliveryOrderItemsTable.photoId, includesDigitalDownloads: deliveryOrderItemsTable.includesDigitalDownloads })
    .from(deliveryOrderItemsTable)
    .where(eq(deliveryOrderItemsTable.orderId, order.id));
  res.json({
    orderId: order.id,
    status: order.status,
    amountTotal: order.amountTotal,
    currency: order.currency,
    paymentMethod: order.paymentMethod,
    paidAt: order.paidAt?.toISOString() ?? null,
    photoIds: items.map((item) => item.photoId),
    downloadablePhotoIds: order.status === "paid"
      ? items.filter((item) => item.includesDigitalDownloads && item.photoId !== null).map((item) => item.photoId)
      : [],
  });
});

router.get("/delivery/:slug/photos/:photoId/file", async (req, res): Promise<void> => {
  const row = await getGalleryBySlug(String(req.params.slug));
  const photoId = Number(req.params.photoId);
  if (!row || !activeGallery(row.gallery) || !Number.isInteger(photoId)) {
    res.status(404).json({ error: "Photo not found" });
    return;
  }
  const mediaToken = String(req.query.mediaToken ?? "");
  const verified = mediaToken
    ? verifyMediaToken(mediaToken, row.gallery.id, photoId)
    : verifyToken(String(req.header("x-delivery-token") ?? req.body?.token ?? ""), row.gallery.id);
  if (!verified) {
    res.status(401).json({ error: "Delivery access has expired" });
    return;
  }
  const tokenAccess = await getAccessForToken(row.gallery.id, verified.accessId);
  if (!tokenAccess || !accessIsUsable(tokenAccess.access)) {
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
      gt(studentPhotosTable.rating, 0),
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
    const watermarkText = row.gallery.watermarkText?.trim() || row.studio?.name?.trim() || "Volume Capture";
    const transformer = sharp()
      .resize({ width: 1200, withoutEnlargement: true })
      .composite(row.gallery.watermarkEnabled ? [{ input: watermarkSvg(watermarkText), blend: "over" }] : [])
      .jpeg({ quality: 78 });
    input.pipe(transformer).pipe(res);
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
  let [gallery] = await db.select().from(deliveryGalleriesTable).where(eq(deliveryGalleriesTable.projectId, projectId)).limit(1);
  if (!gallery?.priceSheetId) {
    res.status(409).json({ error: "Select a price sheet before publishing the gallery", code: "PRICE_SHEET_REQUIRED" });
    return;
  }
  const [selectedPriceSheet] = await db.select().from(deliveryPriceSheetsTable).where(and(
    eq(deliveryPriceSheetsTable.id, gallery.priceSheetId),
    eq(deliveryPriceSheetsTable.studioId, project.studioId!),
  )).limit(1);
  if (!selectedPriceSheet || parseOffers(selectedPriceSheet.offersJson).length === 0) {
    res.status(409).json({ error: "The selected price sheet is unavailable or has no products", code: "PRICE_SHEET_INVALID" });
    return;
  }
  await materializeCaptureJpegsForDelivery(projectId);
  await materializeGroupJpegsForDelivery(projectId);
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

  const now = new Date();
  [gallery] = await db.update(deliveryGalleriesTable).set({
    status: "published",
    priceSheetJson: selectedPriceSheet.offersJson,
    publishedAt: gallery.publishedAt ?? now,
    updatedAt: now,
  }).where(eq(deliveryGalleriesTable.id, gallery.id)).returning();

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

function priceSheetResponse(sheet: typeof deliveryPriceSheetsTable.$inferSelect) {
  return {
    id: sheet.id,
    studioId: sheet.studioId,
    name: sheet.name,
    offers: parseOffers(sheet.offersJson),
    createdAt: sheet.createdAt.toISOString(),
    updatedAt: sheet.updatedAt.toISOString(),
  };
}

async function activeStudioMember(userId: string) {
  const member = await getStudioMember(userId);
  return member.status === "active" ? member : null;
}

async function manageableStudioMember(userId: string) {
  const member = await activeStudioMember(userId);
  return member && ["owner", "admin"].includes(member.role) ? member : null;
}

function validPriceSheetInput(body: unknown): { name: string; offers: DeliveryOffer[] } | null {
  const input = body as { name?: unknown; offers?: unknown } | null;
  const name = typeof input?.name === "string" ? input.name.trim() : "";
  try {
    const offers = parseOffers(JSON.stringify({ offers: input?.offers }));
    if (!name || name.length > 120 || !offers.length || offers.some((offer) => offer.unitAmount === null || !offer.currency)) return null;
    return { name, offers };
  } catch {
    return null;
  }
}

router.get("/studio/delivery/price-sheets", requireAuth, async (req, res): Promise<void> => {
  const member = await activeStudioMember(getUserId(req));
  if (!member) { res.status(403).json({ error: "Studio membership is required" }); return; }
  const sheets = await db.select().from(deliveryPriceSheetsTable)
    .where(eq(deliveryPriceSheetsTable.studioId, member.studioId))
    .orderBy(deliveryPriceSheetsTable.name);
  res.json(sheets.map(priceSheetResponse));
});

router.post("/studio/delivery/price-sheets", requireAuth, async (req, res): Promise<void> => {
  const member = await manageableStudioMember(getUserId(req));
  if (!member) { res.status(403).json({ error: "Studio owner or admin access is required" }); return; }
  const input = validPriceSheetInput(req.body);
  if (!input) { res.status(400).json({ error: "Enter a name and at least one complete product" }); return; }
  try {
    const [sheet] = await db.insert(deliveryPriceSheetsTable).values({
      studioId: member.studioId,
      name: input.name,
      offersJson: JSON.stringify({ offers: input.offers }),
    }).returning();
    res.status(201).json(priceSheetResponse(sheet));
  } catch {
    res.status(409).json({ error: "A price sheet with this name already exists" });
  }
});

router.patch("/studio/delivery/price-sheets/:priceSheetId", requireAuth, async (req, res): Promise<void> => {
  const member = await manageableStudioMember(getUserId(req));
  const priceSheetId = Number(req.params.priceSheetId);
  if (!member || !Number.isInteger(priceSheetId)) { res.status(404).json({ error: "Price sheet not found" }); return; }
  const input = validPriceSheetInput(req.body);
  if (!input) { res.status(400).json({ error: "Enter a name and at least one complete product" }); return; }
  try {
    const [sheet] = await db.update(deliveryPriceSheetsTable).set({
      name: input.name,
      offersJson: JSON.stringify({ offers: input.offers }),
      updatedAt: new Date(),
    }).where(and(
      eq(deliveryPriceSheetsTable.id, priceSheetId),
      eq(deliveryPriceSheetsTable.studioId, member.studioId),
    )).returning();
    if (!sheet) { res.status(404).json({ error: "Price sheet not found" }); return; }
    res.json(priceSheetResponse(sheet));
  } catch {
    res.status(409).json({ error: "A price sheet with this name already exists" });
  }
});

async function manageableProject(projectId: number, userId: string) {
  if (!Number.isInteger(projectId) || !(await canAccessProject(userId, projectId, "manage"))) return null;
  const [project] = await db.select().from(projectsTable).where(eq(projectsTable.id, projectId)).limit(1);
  return project ?? null;
}

router.get("/projects/:projectId/delivery/price-sheets", requireAuth, async (req, res): Promise<void> => {
  const project = await manageableProject(Number(req.params.projectId), getUserId(req));
  if (!project?.studioId) { res.status(404).json({ error: "Project not found" }); return; }
  const sheets = await db.select().from(deliveryPriceSheetsTable)
    .where(eq(deliveryPriceSheetsTable.studioId, project.studioId))
    .orderBy(deliveryPriceSheetsTable.name);
  res.json(sheets.map(priceSheetResponse));
});

router.post("/projects/:projectId/delivery/price-sheets", requireAuth, async (req, res): Promise<void> => {
  const project = await manageableProject(Number(req.params.projectId), getUserId(req));
  if (!project?.studioId) { res.status(404).json({ error: "Project not found" }); return; }
  const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
  if (!name || name.length > 120) { res.status(400).json({ error: "Enter a price sheet name" }); return; }
  let offers: DeliveryOffer[];
  try {
    offers = parseOffers(JSON.stringify({ offers: req.body?.offers }));
    if (!offers.length || offers.some((offer) => offer.unitAmount === null || !offer.currency)) throw new Error();
  } catch {
    res.status(400).json({ error: "Add at least one complete product to the price sheet" }); return;
  }
  try {
    const [sheet] = await db.insert(deliveryPriceSheetsTable).values({
      studioId: project.studioId, name, offersJson: JSON.stringify({ offers }),
    }).returning();
    res.status(201).json(priceSheetResponse(sheet));
  } catch {
    res.status(409).json({ error: "A price sheet with this name already exists" });
  }
});

router.patch("/projects/:projectId/delivery/price-sheets/:priceSheetId", requireAuth, async (req, res): Promise<void> => {
  const project = await manageableProject(Number(req.params.projectId), getUserId(req));
  const priceSheetId = Number(req.params.priceSheetId);
  if (!project?.studioId || !Number.isInteger(priceSheetId)) { res.status(404).json({ error: "Price sheet not found" }); return; }
  const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
  let offers: DeliveryOffer[];
  try {
    offers = parseOffers(JSON.stringify({ offers: req.body?.offers }));
    if (!name || name.length > 120 || !offers.length || offers.some((offer) => offer.unitAmount === null || !offer.currency)) throw new Error();
  } catch {
    res.status(400).json({ error: "Enter a name and at least one complete product" }); return;
  }
  const [sheet] = await db.update(deliveryPriceSheetsTable).set({
    name, offersJson: JSON.stringify({ offers }), updatedAt: new Date(),
  }).where(and(
    eq(deliveryPriceSheetsTable.id, priceSheetId),
    eq(deliveryPriceSheetsTable.studioId, project.studioId),
  )).returning();
  if (!sheet) { res.status(404).json({ error: "Price sheet not found" }); return; }
  res.json(priceSheetResponse(sheet));
});

router.patch("/projects/:projectId/delivery", requireAuth, async (req, res): Promise<void> => {
  const projectId = Number(req.params.projectId);
  if (!Number.isInteger(projectId) || !(await canAccessProject(getUserId(req), projectId, "manage"))) {
    res.status(404).json({ error: "Project not found" }); return;
  }
  const body = req.body ?? {};
  let priceSheetJson: string | undefined;
  if (body.offers !== undefined) {
    try {
      const offers = parseOffers(JSON.stringify({ offers: body.offers }));
      if (offers.some((offer) => offer.unitAmount === null || !offer.currency)) {
        res.status(400).json({ error: "Every offer must have a valid amount and three-letter currency" }); return;
      }
      priceSheetJson = JSON.stringify({ offers });
    } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : "Invalid offers" }); return; }
  }
  let [gallery] = await db.select().from(deliveryGalleriesTable).where(eq(deliveryGalleriesTable.projectId, projectId)).limit(1);
  if (!gallery) {
    const [project] = await db.select().from(projectsTable).where(eq(projectsTable.id, projectId)).limit(1);
    [gallery] = await db.insert(deliveryGalleriesTable).values({
      projectId,
      studioId: project.studioId,
      slug: `vc-${randomBytes(8).toString("hex")}`,
      status: "draft",
    }).returning();
  }
  if (
    gallery.status === "published"
    && body.priceSheetId !== undefined
    && Number(body.priceSheetId) !== gallery.priceSheetId
  ) {
    res.status(409).json({ error: "Revoke the published gallery before changing its price sheet" });
    return;
  }
  let assignedPriceSheet: typeof deliveryPriceSheetsTable.$inferSelect | null = null;
  if (body.priceSheetId !== undefined && body.priceSheetId !== null) {
    const priceSheetId = Number(body.priceSheetId);
    const [project] = await db.select().from(projectsTable).where(eq(projectsTable.id, projectId)).limit(1);
    const [sheet] = await db.select().from(deliveryPriceSheetsTable).where(and(
      eq(deliveryPriceSheetsTable.id, priceSheetId),
      eq(deliveryPriceSheetsTable.studioId, project.studioId!),
    )).limit(1);
    if (!sheet) { res.status(400).json({ error: "Selected price sheet is not available to this studio" }); return; }
    assignedPriceSheet = sheet;
  }
  const [updated] = await db.update(deliveryGalleriesTable).set({
    watermarkEnabled: typeof body.watermarkEnabled === "boolean" ? body.watermarkEnabled : gallery.watermarkEnabled,
    watermarkText: body.watermarkText === null || typeof body.watermarkText === "string" ? body.watermarkText : gallery.watermarkText,
    expiresAt: body.expiresAt === null ? null : body.expiresAt ? new Date(body.expiresAt) : gallery.expiresAt,
    establishmentPaymentInstructions: body.establishmentPaymentInstructions === null || typeof body.establishmentPaymentInstructions === "string"
      ? body.establishmentPaymentInstructions
      : gallery.establishmentPaymentInstructions,
    bankTransferInstructions: body.bankTransferInstructions === null || typeof body.bankTransferInstructions === "string"
      ? body.bankTransferInstructions
      : gallery.bankTransferInstructions,
    ...(assignedPriceSheet
      ? { priceSheetId: assignedPriceSheet.id, priceSheetJson: assignedPriceSheet.offersJson }
      : body.priceSheetId === null
        ? { priceSheetId: null, ...(priceSheetJson ? { priceSheetJson } : {}) }
        : priceSheetJson
          ? { priceSheetJson }
          : {}),
    updatedAt: new Date(),
  }).where(eq(deliveryGalleriesTable.id, gallery.id)).returning();
  res.json({ gallery: updated });
});

router.get("/projects/:projectId/delivery/catalog", requireAuth, async (req, res): Promise<void> => {
  const projectId = Number(req.params.projectId);
  if (!Number.isInteger(projectId) || !(await canAccessProject(getUserId(req), projectId, "manage"))) {
    res.status(404).json({ error: "Project not found" }); return;
  }
  try {
    res.json({ prices: await activeStripeCatalog() });
  } catch (error) {
    req.log.warn({ err: error, projectId }, "optional Stripe catalog unavailable");
    res.json({ prices: [] });
  }
});

router.post("/projects/:projectId/delivery/access/:studentId/regenerate", requireAuth, async (req, res): Promise<void> => {
  const projectId = Number(req.params.projectId), studentId = Number(req.params.studentId);
  if (!(await canAccessProject(getUserId(req), projectId, "manage"))) { res.status(404).json({ error: "Project not found" }); return; }
  const [gallery] = await db.select().from(deliveryGalleriesTable).where(eq(deliveryGalleriesTable.projectId, projectId)).limit(1);
  if (!gallery) { res.status(404).json({ error: "Delivery gallery not found" }); return; }
  const code = makeCode();
  const [updated] = await db.update(deliveryAccessesTable).set({
    accessCodeHash: hashCode(code), accessCodeEncrypted: encryptStorageValue(code), accessCodeLast4: code.slice(-4),
    failedAttempts: 0, lockedUntil: null, revokedAt: null,
  }).where(and(eq(deliveryAccessesTable.galleryId, gallery.id), eq(deliveryAccessesTable.studentId, studentId))).returning();
  if (!updated) { res.status(404).json({ error: "Subject access not found" }); return; }
  res.json({ studentId, accessCode: code });
});

router.patch("/projects/:projectId/delivery/access/:studentId", requireAuth, async (req, res): Promise<void> => {
  const projectId = Number(req.params.projectId), studentId = Number(req.params.studentId);
  if (!(await canAccessProject(getUserId(req), projectId, "manage"))) { res.status(404).json({ error: "Project not found" }); return; }
  const [gallery] = await db.select({ id: deliveryGalleriesTable.id }).from(deliveryGalleriesTable)
    .where(eq(deliveryGalleriesTable.projectId, projectId)).limit(1);
  if (!gallery) { res.status(404).json({ error: "Delivery gallery not found" }); return; }
  const update: Record<string, Date | null> = {};
  if (typeof req.body?.revoked === "boolean") update.revokedAt = req.body.revoked ? new Date() : null;
  if (req.body?.expiresAt !== undefined) update.expiresAt = req.body.expiresAt ? new Date(req.body.expiresAt) : null;
  const [updated] = await db.update(deliveryAccessesTable).set(update)
    .where(and(eq(deliveryAccessesTable.galleryId, gallery.id), eq(deliveryAccessesTable.studentId, studentId))).returning();
  if (!updated) { res.status(404).json({ error: "Subject access not found" }); return; }
  res.json({ access: { studentId, revokedAt: updated.revokedAt, expiresAt: updated.expiresAt } });
});

router.post("/projects/:projectId/delivery/revoke", requireAuth, async (req, res): Promise<void> => {
  const projectId = Number(req.params.projectId);
  if (!Number.isInteger(projectId) || !(await canAccessProject(getUserId(req), projectId, "manage"))) {
    res.status(404).json({ error: "Project not found" }); return;
  }
  const [gallery] = await db.update(deliveryGalleriesTable).set({ status: "revoked", updatedAt: new Date() })
    .where(eq(deliveryGalleriesTable.projectId, projectId)).returning();
  if (!gallery) { res.status(404).json({ error: "Delivery gallery not found" }); return; }
  res.json({ gallery });
});

router.get("/projects/:projectId/delivery/orders", requireAuth, async (req, res): Promise<void> => {
  const projectId = Number(req.params.projectId);
  if (!Number.isInteger(projectId) || !(await canAccessProject(getUserId(req), projectId, "view"))) {
    res.status(404).json({ error: "Project not found" }); return;
  }
  const [gallery] = await db.select({ id: deliveryGalleriesTable.id }).from(deliveryGalleriesTable)
    .where(eq(deliveryGalleriesTable.projectId, projectId)).limit(1);
  if (!gallery) { res.json({ orders: [] }); return; }
  res.json({ orders: await db.select().from(deliveryOrdersTable).where(eq(deliveryOrdersTable.galleryId, gallery.id)) });
});

router.get("/projects/:projectId/delivery/orders/:orderId", requireAuth, async (req, res): Promise<void> => {
  const projectId = Number(req.params.projectId), orderId = Number(req.params.orderId);
  if (!(await canAccessProject(getUserId(req), projectId, "view"))) { res.status(404).json({ error: "Project not found" }); return; }
  const [order] = await db.select({ order: deliveryOrdersTable, gallery: deliveryGalleriesTable })
    .from(deliveryOrdersTable).innerJoin(deliveryGalleriesTable, eq(deliveryOrdersTable.galleryId, deliveryGalleriesTable.id))
    .where(and(eq(deliveryOrdersTable.id, orderId), eq(deliveryGalleriesTable.projectId, projectId))).limit(1);
  if (!order) { res.status(404).json({ error: "Order not found" }); return; }
  const items = await db.select().from(deliveryOrderItemsTable).where(eq(deliveryOrderItemsTable.orderId, orderId));
  res.json({ order: order.order, items });
});

router.patch("/projects/:projectId/delivery/orders/:orderId/fulfillment", requireAuth, async (req, res): Promise<void> => {
  const projectId = Number(req.params.projectId), orderId = Number(req.params.orderId);
  const valid = ["not_required", "paid", "preparing", "printed", "ready", "dispatched", "delivered"];
  if (!Number.isInteger(projectId) || !Number.isInteger(orderId) || !valid.includes(req.body?.fulfillmentStatus)) {
    res.status(400).json({ error: "Invalid fulfillment update" }); return;
  }
  const [ownedOrder] = await db.select({ id: deliveryOrdersTable.id })
    .from(deliveryOrdersTable)
    .innerJoin(deliveryGalleriesTable, eq(deliveryOrdersTable.galleryId, deliveryGalleriesTable.id))
    .where(and(eq(deliveryOrdersTable.id, orderId), eq(deliveryGalleriesTable.projectId, projectId))).limit(1);
  if (!ownedOrder || !(await canAccessProject(getUserId(req), projectId, "manage"))) {
    res.status(404).json({ error: "Order not found" }); return;
  }
  const [updated] = await db.update(deliveryOrdersTable).set({ fulfillmentStatus: req.body.fulfillmentStatus })
    .where(eq(deliveryOrdersTable.id, orderId)).returning();
  if (!updated) { res.status(404).json({ error: "Order not found" }); return; }
  res.json({ order: updated });
});

router.patch("/projects/:projectId/delivery/orders/:orderId/payment", requireAuth, async (req, res): Promise<void> => {
  const projectId = Number(req.params.projectId), orderId = Number(req.params.orderId);
  const status = String(req.body?.status ?? "");
  const valid = ["pending", "paid", "cancelled", "refunded"];
  if (!Number.isInteger(projectId) || !Number.isInteger(orderId) || !valid.includes(status)) {
    res.status(400).json({ error: "Invalid payment update" }); return;
  }
  const [ownedOrder] = await db.select({ order: deliveryOrdersTable })
    .from(deliveryOrdersTable)
    .innerJoin(deliveryGalleriesTable, eq(deliveryOrdersTable.galleryId, deliveryGalleriesTable.id))
    .where(and(eq(deliveryOrdersTable.id, orderId), eq(deliveryGalleriesTable.projectId, projectId))).limit(1);
  if (!ownedOrder || !(await canAccessProject(getUserId(req), projectId, "manage"))) {
    res.status(404).json({ error: "Order not found" }); return;
  }
  if (ownedOrder.order.paymentMethod === "stripe") {
    res.status(400).json({ error: "Stripe payment status is updated automatically by its verified webhook" }); return;
  }
  const items = await db.select({ productType: deliveryOrderItemsTable.productType })
    .from(deliveryOrderItemsTable).where(eq(deliveryOrderItemsTable.orderId, orderId));
  const hasPhysicalItem = items.some((item) => item.productType === "print" || item.productType === "pack");
  const [updated] = await db.update(deliveryOrdersTable).set({
    status: status as "pending" | "paid" | "cancelled" | "refunded",
    paidAt: status === "paid" ? (ownedOrder.order.paidAt ?? new Date()) : null,
    ...(status === "paid" ? { fulfillmentStatus: hasPhysicalItem ? "paid" as const : "not_required" as const } : {}),
  }).where(eq(deliveryOrdersTable.id, orderId)).returning();
  if (!updated) { res.status(404).json({ error: "Order not found" }); return; }
  res.json({ order: updated });
});

router.get("/projects/:projectId/delivery/orders/export.csv", requireAuth, async (req, res): Promise<void> => {
  const projectId = Number(req.params.projectId);
  if (!Number.isInteger(projectId) || !(await canAccessProject(getUserId(req), projectId, "view"))) {
    res.status(404).json({ error: "Project not found" }); return;
  }
  const [gallery] = await db.select({ id: deliveryGalleriesTable.id }).from(deliveryGalleriesTable)
    .where(eq(deliveryGalleriesTable.projectId, projectId)).limit(1);
  const orders = gallery ? await db.select().from(deliveryOrdersTable).where(eq(deliveryOrdersTable.galleryId, gallery.id)) : [];
  const csv = ["orderId,status,paymentMethod,fulfillmentStatus,deliveryMethod,customerName,customerEmail,total,currency,date",
    ...orders.map((order) => [order.id, order.status, order.paymentMethod, order.fulfillmentStatus, order.deliveryMethod,
      order.customerName ?? "", order.customerEmail ?? "", order.amountTotal, order.currency, order.createdAt.toISOString()]
      .map((value) => `"${String(value).replace(/"/g, '""')}"`).join(","))].join("\n");
  res.type("text/csv").send(`${csv}\n`);
});

export default router;