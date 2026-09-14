import { Router } from "express";
import QRCode from "qrcode";
import { Readable } from "node:stream";
import sharp from "sharp";
import Stripe from "stripe";
import {
  db,
  deliveryAccessesTable,
  deliveryGalleriesTable,
  deliveryInvitationsTable,
  deliveryPriceSheetsTable,
  deliveryOrderItemsTable,
  deliveryOrderNotificationsTable,
  deliveryOrdersTable,
  classesTable,
  captureFilesTable,
  capturesTable,
  groupCaptureFilesTable,
  groupCapturesTable,
  groupMembersTable,
  projectsTable,
  studentPhotosTable,
  studentsTable,
  studioMembersTable,
  studiosTable,
} from "@workspace/db";
import { photoStorageCopiesTable } from "@workspace/db/schema";
import { and, asc, eq, exists, gt, ilike, inArray, isNull, isNotNull, or, sql } from "drizzle-orm";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { requireAuth, getUserId } from "../lib/auth";
import { canAccessProject, getStudioMember, isStudioManagerForProject } from "../lib/studioAccess";
import { decryptStorageValue, encryptStorageValue } from "../lib/storageCrypto";
import { objectStorageService, ObjectNotFoundError } from "../lib/objectStorage";
import { getR2Object } from "../lib/r2Storage";
import {
  ensureR2PhotoVariant,
  getVerifiedR2CopyForPhoto,
} from "../lib/photoVariants";
import { getUncachableStripeClient } from "../lib/stripeClient";
import { normalizeMarketingEmail, recordSuccessfulGalleryAccess, markContactOrder } from "../lib/marketing";
import { deliveryAmount, deliveryOrderQuantity, validateDeliverySelection } from "../lib/deliveryOfferRules";
import { materializeGroupJpegsForDelivery, projectAvailableGroupJpegsToStudent } from "../lib/groupDeliveryPhotos";
import { FailureRateLimiter } from "../lib/failureRateLimiter";
import {
  dispatchDeliveryInvitations,
  enqueueDeliveryInvitations,
  retryFailedDeliveryInvitations,
} from "../lib/deliveryInvitations";
import { logger } from "../lib/logger";
import {
  deliveryTerminology,
  normalizeDeliveryProjectType,
  type DeliveryProjectType,
} from "../lib/deliveryTerminology";
import { publicAppUrl } from "../lib/publicAppUrl";
import {
  dispatchDeliveryOrderNotifications,
  enqueueDeliveryOrderNotification,
  enqueuePaymentConfirmedNotification,
  finalizeDeliveryOrderNotification,
  retryFailedDeliveryOrderNotifications,
} from "../lib/deliveryOrderNotifications";

const router = Router();
const DELIVERY_TOKEN_TTL_SECONDS = 2 * 60 * 60;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const ACCESS_MAX_FAILURES = 5;
const ACCESS_LOCK_SECONDS = 15 * 60;
const PUBLIC_ACCESS_WINDOW_MS = 15 * 60 * 1000;
const publicAccessByIp = new FailureRateLimiter(20, PUBLIC_ACCESS_WINDOW_MS, PUBLIC_ACCESS_WINDOW_MS);
const publicAccessByGallery = new FailureRateLimiter(200, PUBLIC_ACCESS_WINDOW_MS, PUBLIC_ACCESS_WINDOW_MS);
const recoveryByIp = new FailureRateLimiter(60, PUBLIC_ACCESS_WINDOW_MS, PUBLIC_ACCESS_WINDOW_MS);
const recoveryByReference = new FailureRateLimiter(30, PUBLIC_ACCESS_WINDOW_MS, PUBLIC_ACCESS_WINDOW_MS);
const RECOVERY_TTL_MS = 90 * 24 * 60 * 60 * 1000;

function deliveryPhotoEligibility() {
  return [
    isNotNull(studentPhotosTable.durableObjectPath),
    gt(studentPhotosTable.rating, 0),
    eq(studentPhotosTable.shareWithParents, true),
    ilike(studentPhotosTable.mimeType, "image/jpeg%"),
    or(
      isNull(studentPhotosTable.sourceGroupCaptureFileId),
      exists(
        db.select({ one: sql`1` })
          .from(groupCaptureFilesTable)
          .innerJoin(groupCapturesTable, eq(groupCapturesTable.id, groupCaptureFilesTable.captureId))
          .innerJoin(groupMembersTable, and(
            eq(groupMembersTable.groupId, groupCapturesTable.groupId),
            eq(groupMembersTable.studentId, studentPhotosTable.studentId),
          ))
          .where(eq(groupCaptureFilesTable.id, studentPhotosTable.sourceGroupCaptureFileId)),
      ),
    ),
  ] as const;
}

function makeCode(length = 8): string {
  const bytes = randomBytes(length);
  return Array.from(bytes, (byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join("");
}

function hashCode(code: string): string {
  return createHash("sha256").update(code.trim().toUpperCase()).digest("hex");
}

function hashRecoveryToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function newPublicOrderReference(): string {
  return `order_${randomBytes(12).toString("base64url")}`;
}

function recoveryTokenMatches(token: string, storedHash: string | null): boolean {
  if (!storedHash || !/^[a-f0-9]{64}$/i.test(storedHash)) return false;
  const actual = Buffer.from(hashRecoveryToken(token), "hex");
  const expected = Buffer.from(storedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function isUniqueConstraintViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; cause?: unknown };
  return candidate.code === "23505" || isUniqueConstraintViolation(candidate.cause);
}

function tokenSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("SESSION_SECRET must be at least 32 characters to protect delivery access");
  }
  return secret;
}

type DeliveryTokenPayload = {
  kind: "delivery";
  version: 1;
  galleryId: number;
  accessId: number;
  accessVersion: number;
  issuedAt: number;
  expiresAt: number;
};

type MediaTokenPayload = {
  kind: "delivery-media";
  version: 1;
  galleryId: number;
  accessId: number;
  accessVersion: number;
  photoId: number;
  issuedAt: number;
  expiresAt: number;
};

function signedPayload(payload: object): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", tokenSecret()).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

function signToken(payload: Pick<DeliveryTokenPayload, "galleryId" | "accessId" | "accessVersion" | "expiresAt">): string {
  return signedPayload({
    kind: "delivery",
    version: 1,
    issuedAt: Math.floor(Date.now() / 1000),
    ...payload,
  } satisfies DeliveryTokenPayload);
}

function signMediaToken(payload: Pick<MediaTokenPayload, "galleryId" | "accessId" | "accessVersion" | "photoId" | "expiresAt">): string {
  return signedPayload({
    kind: "delivery-media",
    version: 1,
    issuedAt: Math.floor(Date.now() / 1000),
    ...payload,
  } satisfies MediaTokenPayload);
}

function decodeVerifiedPayload(token: string): Record<string, unknown> | null {
  const [encoded, signature] = token.split(".");
  if (!encoded || !signature || token.split(".").length !== 2) return null;
  const expected = createHmac("sha256", tokenSecret()).update(encoded).digest("base64url");
  if (expected.length !== signature.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) return null;
  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as unknown;
    return payload && typeof payload === "object" && !Array.isArray(payload)
      ? payload as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function validTokenTimes(payload: Record<string, unknown>, maxTtlSeconds: number): boolean {
  const now = Math.floor(Date.now() / 1000);
  return Number.isSafeInteger(payload.issuedAt)
    && Number.isSafeInteger(payload.expiresAt)
    && Number(payload.issuedAt) <= now + 60
    && Number(payload.expiresAt) > now
    && Number(payload.expiresAt) - Number(payload.issuedAt) <= maxTtlSeconds;
}

function verifyMediaToken(token: string, galleryId: number, photoId: number): { accessId: number; accessVersion: number } | null {
  const payload = decodeVerifiedPayload(token);
  const keys = payload ? Object.keys(payload).sort().join(",") : "";
  if (!payload
    || keys !== "accessId,accessVersion,expiresAt,galleryId,issuedAt,kind,photoId,version"
    || payload.kind !== "delivery-media"
    || payload.version !== 1
    || payload.galleryId !== galleryId
    || payload.photoId !== photoId
    || !Number.isSafeInteger(payload.accessId)
    || !Number.isSafeInteger(payload.accessVersion)
    || !validTokenTimes(payload, 15 * 60)) return null;
  return { accessId: Number(payload.accessId), accessVersion: Number(payload.accessVersion) };
}

function verifyToken(token: string, galleryId: number): { accessId: number; accessVersion: number } | null {
  const payload = decodeVerifiedPayload(token);
  const keys = payload ? Object.keys(payload).sort().join(",") : "";
  if (!payload
    || keys !== "accessId,accessVersion,expiresAt,galleryId,issuedAt,kind,version"
    || payload.kind !== "delivery"
    || payload.version !== 1
    || payload.galleryId !== galleryId
    || !Number.isSafeInteger(payload.accessId)
    || !Number.isSafeInteger(payload.accessVersion)
    || !validTokenTimes(payload, DELIVERY_TOKEN_TTL_SECONDS)) return null;
  return { accessId: Number(payload.accessId), accessVersion: Number(payload.accessVersion) };
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
      shareWithParents: capture.rating > 0,
  }))).onConflictDoNothing();
  return missing.length;
}

function publicGallery(
  gallery: typeof deliveryGalleriesTable.$inferSelect,
  studio: typeof studiosTable.$inferSelect | null,
  projectType: DeliveryProjectType = "school",
) {
  return {
    slug: gallery.slug,
    status: gallery.status,
    expiresAt: gallery.expiresAt?.toISOString() ?? null,
    projectType,
    ...deliveryTerminology(projectType),
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
    .select({ gallery: deliveryGalleriesTable, studio: studiosTable, project: projectsTable })
    .from(deliveryGalleriesTable)
    .leftJoin(studiosTable, eq(deliveryGalleriesTable.studioId, studiosTable.id))
    .innerJoin(projectsTable, eq(deliveryGalleriesTable.projectId, projectsTable.id))
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

async function dispatchOrderNotification(
  order: typeof deliveryOrdersTable.$inferSelect,
  _gallery: typeof deliveryGalleriesTable.$inferSelect,
  _itemSummary: string[],
  _recoveryUrl: string,
): Promise<void> {
  if (!order.customerEmail) return;
  await dispatchDeliveryOrderNotifications(order.id);
}

type DurableStripeCheckoutParams = Stripe.Checkout.SessionCreateParams;

function buildStripeCheckoutParams(input: {
  orderId: number;
  gallerySlug: string;
  projectId: number;
  customerEmail: string;
  deliveryMethod: string;
  pricedLines: Array<{ offer: { currency: string; unitAmount: number; name: string; description?: string | null }; orderQuantity: number }>;
  origin: string;
}): DurableStripeCheckoutParams {
  return {
    mode: "payment",
    line_items: input.pricedLines.map(({ offer, orderQuantity }) => ({
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
    ...(input.customerEmail ? { customer_email: input.customerEmail } : {}),
    ...(input.deliveryMethod === "shipping" ? {
      shipping_address_collection: { allowed_countries: ["MA", "US", "CA", "GB", "AU", "NZ"] },
    } : {}),
    metadata: {
      orderId: String(input.orderId),
      gallerySlug: input.gallerySlug,
      projectId: String(input.projectId),
    },
    success_url: `${input.origin}/delivery/${input.gallerySlug}?paid=1&order=${input.orderId}`,
    cancel_url: `${input.origin}/delivery/${input.gallerySlug}?cancelled=1&order=${input.orderId}`,
  };
}

async function performStripeCheckoutAttempt(
  orderId: number,
  idempotencyKey: string,
  params: DurableStripeCheckoutParams,
): Promise<{ status: "started" | "created" | "uncertain"; sessionId?: string; sessionUrl?: string; error?: string }> {
  // Commit the provider-attempt boundary before invoking Stripe. This makes
  // crash-before-call observable and recoverable by a later replay.
  await db.update(deliveryOrdersTable).set({
    checkoutAttemptStatus: "started",
    checkoutAttemptError: null,
  }).where(and(
    eq(deliveryOrdersTable.id, orderId),
    eq(deliveryOrdersTable.checkoutAttemptStatus, "not_started"),
  ));
  return db.transaction(async (tx) => {
    const [locked] = await tx.select().from(deliveryOrdersTable)
      .where(eq(deliveryOrdersTable.id, orderId))
      .for("update")
      .limit(1);
    if (!locked) return { status: "uncertain", error: "Order no longer exists" };
    if (locked.checkoutAttemptStatus === "created" && locked.stripeCheckoutSessionId) {
      return { status: "created", sessionId: locked.stripeCheckoutSessionId };
    }
    let stripe: Stripe;
    try {
      stripe = await getUncachableStripeClient();
    } catch (error) {
      // Keep started durable. A replay can safely retry with the same key.
      return {
        status: "started",
        error: (error instanceof Error ? error.message : "Stripe client unavailable").slice(0, 1_000),
      };
    }
    try {
      const session = await stripe.checkout.sessions.create(params, { idempotencyKey });
      if (!session?.id || !session.url) throw new Error("Stripe checkout response was incomplete");
      await tx.update(deliveryOrdersTable).set({
        stripeCheckoutSessionId: session.id,
        checkoutAttemptStatus: "created",
        checkoutAttemptError: null,
      }).where(eq(deliveryOrdersTable.id, orderId));
      await finalizeDeliveryOrderNotification(tx, {
        orderId,
        eventType: "order_received",
        status: "pending",
        instructions: "Complete payment using the secure checkout page. Your order status will update after payment is confirmed.",
      });
      return { status: "created", sessionId: session.id, sessionUrl: session.url };
    } catch (error) {
      const message = (error instanceof Error ? error.message : "Stripe checkout attempt was inconclusive").slice(0, 1_000);
      await tx.update(deliveryOrdersTable).set({
        checkoutAttemptStatus: "uncertain",
        checkoutAttemptError: message,
      }).where(eq(deliveryOrdersTable.id, orderId));
      await finalizeDeliveryOrderNotification(tx, {
        orderId,
        eventType: "order_received",
        status: "payment needs review",
        instructions: "We could not confirm the online payment attempt yet. Please do not submit the order again; the studio will review it.",
      });
      return { status: "uncertain", error: message };
    }
  });
}

async function getAccessForToken(galleryId: number, accessId: number) {
  const [access] = await db
    .select({ access: deliveryAccessesTable, student: studentsTable, className: classesTable.className })
    .from(deliveryAccessesTable)
    .innerJoin(studentsTable, eq(deliveryAccessesTable.studentId, studentsTable.id))
    .leftJoin(classesTable, eq(studentsTable.classId, classesTable.id))
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
  return Buffer.from(`<svg width="320" height="190" xmlns="http://www.w3.org/2000/svg">
    <g transform="rotate(-28 160 95)" fill="white" fill-opacity=".30"
      font-family="Arial,sans-serif" font-size="24" font-weight="700">
      <text x="-30" y="105">${safeText}</text>
    </g>
  </svg>`);
}

async function photoHasBeenPaid(accessId: number, photoId: number, print = false): Promise<boolean> {
  const paidProduct = print
    ? eq(deliveryOrderItemsTable.productType, "print")
    : eq(deliveryOrderItemsTable.includesDigitalDownloads, true);
  const [item] = await db
    .select({ id: deliveryOrderItemsTable.id })
    .from(deliveryOrderItemsTable)
    .innerJoin(deliveryOrdersTable, eq(deliveryOrderItemsTable.orderId, deliveryOrdersTable.id))
    .where(and(
      eq(deliveryOrdersTable.accessId, accessId),
      eq(deliveryOrdersTable.status, "paid"),
      eq(deliveryOrderItemsTable.photoId, photoId),
      paidProduct,
    ))
    .limit(1);
  return Boolean(item);
}

/**
 * R2 copies are deliberately selected only after the upload verifier has
 * promoted them to the immutable verified namespace.  In particular, an
 * uploading/staging copy must never become a delivery source.
 *
 * Group captures are materialized into student_photos for gallery access.  A
 * materialized row can therefore use either its own copy or the copy of the
 * source group file while the migration is in progress.
 */
// Public metadata for the code-entry page. No student or photo information is returned.
router.get("/delivery/:slug", async (req, res): Promise<void> => {
  const row = await getGalleryBySlug(String(req.params.slug));
  if (!row || !activeGallery(row.gallery)) {
    res.status(404).json({ error: "Delivery gallery not found or no longer available" });
    return;
  }
  res.json(publicGallery(row.gallery, row.studio, normalizeDeliveryProjectType(row.project.projectType)));
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
  const email = normalizeMarketingEmail(req.body?.email);
  if (!email) {
    res.status(400).json({ error: "Enter a valid email address" });
    return;
  }
  const code = String(req.body?.code ?? "").trim().toUpperCase();
  if (!/^[A-Z0-9]{8}$/.test(code)) {
    res.status(400).json({ error: "Enter the 8-character access code from your card" });
    return;
  }
  const ipKey = `ip:${req.ip ?? req.socket.remoteAddress ?? "unknown"}`;
  const galleryKey = `gallery:${row.gallery.id}`;
  if (publicAccessByIp.isBlocked(ipKey) || publicAccessByGallery.isBlocked(galleryKey)) {
    res.setHeader("Retry-After", String(ACCESS_LOCK_SECONDS));
    res.status(429).json({ error: "Too many access attempts. Try again later." });
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
    publicAccessByIp.recordFailure(ipKey);
    publicAccessByGallery.recordFailure(galleryKey);
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

  const studioId = row.gallery.studioId ?? row.project.studioId;
  if (!studioId) {
    res.status(503).json({ error: "Delivery gallery is not attached to a studio" });
    return;
  }
  await recordSuccessfulGalleryAccess(studioId, email, {
    galleryId: row.gallery.id,
    accessId: access.id,
    projectId: row.gallery.projectId,
    marketingConsent: req.body?.marketingConsent === true,
  });

  const token = signToken({
    galleryId: row.gallery.id,
    accessId: access.id,
    accessVersion: access.tokenVersion,
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
  if (!access || !accessIsUsable(access.access) || access.access.tokenVersion !== verified.accessVersion) {
    res.status(401).json({ error: "Delivery access has been revoked" });
    return;
  }
  await projectAvailableGroupJpegsToStudent(row.gallery.projectId, access.student.id);

  const photos = await db
    .select()
    .from(studentPhotosTable)
    .where(and(
      eq(studentPhotosTable.projectId, row.gallery.projectId),
      eq(studentPhotosTable.studentId, access.student.id),
      ...deliveryPhotoEligibility(),
    ))
    .orderBy(asc(studentPhotosTable.createdAt), asc(studentPhotosTable.id));

  const offers = parseOffers(row.gallery.priceSheetJson).filter((offer) => offer.active);
  const priced = pricedOffers(offers);
  const stripeOffered = priced.some((offer) => offer.paymentMethods.includes("stripe"));
  const stripeAvailable = stripeOffered ? await stripeIsAvailable() : false;
  const mediaExpiresAt = new Date(Date.now() + 15 * 60 * 1000);
  const mediaExpiryUnix = Math.floor(mediaExpiresAt.getTime() / 1000);

  res.json({
    gallery: publicGallery(row.gallery, row.studio, normalizeDeliveryProjectType(row.project.projectType)),
    student: {
      firstName: access.student.firstName,
      lastName: access.student.lastName,
      label: deliveryTerminology(normalizeDeliveryProjectType(row.project.projectType)).subjectLabel,
      departmentName: access.className,
      projectType: normalizeDeliveryProjectType(row.project.projectType),
    },
    subject: {
      firstName: access.student.firstName,
      lastName: access.student.lastName,
      displayName: `${access.student.firstName} ${access.student.lastName}`.trim(),
      organizationName: normalizeDeliveryProjectType(row.project.projectType) === "corporate"
        ? row.project.schoolName
        : null,
      label: deliveryTerminology(normalizeDeliveryProjectType(row.project.projectType)).subjectLabel,
      groupLabel: deliveryTerminology(normalizeDeliveryProjectType(row.project.projectType)).groupLabel,
      groupName: access.className || null,
    },
    price: priced[0] ? { unitAmount: priced[0].unitAmount, currency: priced[0].currency } : null,
    offers: priced,
    orderingAvailable: priced.length > 0,
    stripeAvailable,
    photos: photos.map((photo) => ({
      id: photo.id,
      fileName: photo.fileName,
      mimeType: photo.mimeType,
       fileUrl: `/api/delivery/${row.gallery.slug}/photos/${photo.id}/file?preview=1&size=thumbnail&mediaToken=${encodeURIComponent(signMediaToken({ galleryId: row.gallery.id, accessId: verified.accessId, accessVersion: verified.accessVersion, photoId: photo.id, expiresAt: mediaExpiryUnix }))}`,
       downloadUrl: `/api/delivery/${row.gallery.slug}/photos/${photo.id}/file?download=1&mediaToken=${encodeURIComponent(signMediaToken({ galleryId: row.gallery.id, accessId: verified.accessId, accessVersion: verified.accessVersion, photoId: photo.id, expiresAt: mediaExpiryUnix }))}`,
    })),
    mediaExpiresAt: mediaExpiresAt.toISOString(),
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
  if (!access || !accessIsUsable(access.access) || access.access.tokenVersion !== verified.accessVersion) {
    res.status(401).json({ error: "Delivery access has been revoked" });
    return;
  }
  const idempotencyKey = typeof req.body?.idempotencyKey === "string"
    ? req.body.idempotencyKey.trim()
    : String(req.header("Idempotency-Key") ?? "").trim();
  if (!/^[A-Za-z0-9._:-]{16,128}$/.test(idempotencyKey)) {
    res.status(400).json({ error: "A checkout idempotency key is required" });
    return;
  }
  await projectAvailableGroupJpegsToStudent(row.gallery.projectId, access.student.id);
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
      ...deliveryPhotoEligibility(),
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
    const customerEmail = normalizeMarketingEmail(req.body?.customerEmail);
    if (!customerName) {
      res.status(400).json({ error: "Customer name is required" }); return;
    }
    if (!customerEmail) {
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
    const requestFingerprint = createHash("sha256").update(JSON.stringify({
      items: basket,
      customerName,
      customerEmail,
      paymentMethod,
      deliveryMethod,
      deliveryAddress: deliveryMethod === "shipping" ? req.body.deliveryAddress.trim() : null,
      amountTotal,
      currency,
    })).digest("hex");
    const [replayedOrder] = await db.select().from(deliveryOrdersTable).where(and(
      eq(deliveryOrdersTable.galleryId, row.gallery.id),
      eq(deliveryOrdersTable.accessId, access.access.id),
      eq(deliveryOrdersTable.idempotencyKey, idempotencyKey),
    )).limit(1);
    if (replayedOrder) {
      if (replayedOrder.requestFingerprint !== requestFingerprint) {
        res.status(409).json({ error: "This checkout key was already used for a different order" });
        return;
      }
      let replayAttempt: Awaited<ReturnType<typeof performStripeCheckoutAttempt>> | null = null;
      if (replayedOrder.paymentMethod === "stripe"
        && (replayedOrder.checkoutAttemptStatus === "started"
          || replayedOrder.checkoutAttemptStatus === "uncertain")) {
        if (replayedOrder.checkoutParamsEncrypted) {
          const checkoutParams = decryptStorageValue<DurableStripeCheckoutParams>(
            replayedOrder.checkoutParamsEncrypted,
          );
          replayAttempt = await performStripeCheckoutAttempt(
            replayedOrder.id,
            `delivery-order-${replayedOrder.id}-${idempotencyKey}`,
            checkoutParams,
          );
          if (replayAttempt.status !== "started") {
            await dispatchDeliveryOrderNotifications(replayedOrder.id);
          }
        }
      }
      let checkoutUrl: string | null = null;
      const replaySessionId = replayAttempt?.sessionId ?? replayedOrder.stripeCheckoutSessionId;
      if (replaySessionId) {
        try {
          const stripe = await getUncachableStripeClient();
          const session = await stripe.checkout.sessions.retrieve(replaySessionId);
          checkoutUrl = session.url;
        } catch {
          // The durable attempt state remains authoritative; do not create
          // another Checkout session when lookup is unavailable.
        }
      }
      res.json({
        checkoutUrl,
        orderId: replayedOrder.id,
        publicReference: replayedOrder.publicReference,
        status: replayedOrder.status,
        paymentMethod: replayedOrder.paymentMethod,
        paymentInstructions: replayedOrder.paymentMethod === "stripe"
          ? null
          : manualPaymentInstructions(row.gallery, replayedOrder.paymentMethod),
        checkoutAttemptStatus: replayAttempt?.status ?? replayedOrder.checkoutAttemptStatus,
        recoveryUrl: null,
      });
      return;
    }
    const studioId = row.gallery.studioId ?? row.project.studioId;
    const contact = customerEmail && studioId
      ? await markContactOrder(studioId, customerEmail)
      : null;
    const recoveryToken = randomBytes(32).toString("base64url");
    const publicReference = newPublicOrderReference();
    const recoveryExpiresAt = new Date(Date.now() + RECOVERY_TTL_MS);
    const itemSummary = pricedLines.map(({ offer, photos: linePhotos, orderQuantity }) =>
      `${offer.name} (${linePhotos.length} photo${linePhotos.length === 1 ? "" : "s"}${orderQuantity > 1 ? ` × ${orderQuantity}` : ""})`,
    );
    const recoveryOrigin = publicAppUrl();
    const recoveryUrl = `${recoveryOrigin}/delivery/${encodeURIComponent(row.gallery.slug)}?orderRef=${encodeURIComponent(publicReference)}#recoveryToken=${encodeURIComponent(recoveryToken)}`;
    let order: typeof deliveryOrdersTable.$inferSelect;
    try {
      order = await db.transaction(async (tx) => {
        const [created] = await tx.insert(deliveryOrdersTable).values({
          galleryId: row.gallery.id,
          accessId: access.access.id,
          contactId: contact?.id ?? null,
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
          publicReference,
          recoveryTokenHash: hashRecoveryToken(recoveryToken),
          recoveryExpiresAt,
          recoveryRevokedAt: null,
          idempotencyKey,
          requestFingerprint,
          checkoutAttemptStatus: "not_started",
          checkoutAttemptError: null,
          checkoutParamsEncrypted: null,
          notificationStatus: "not_sent",
          notificationProviderId: null,
          notificationError: null,
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
        if (created.paymentMethod === "stripe") {
          await tx.update(deliveryOrdersTable).set({
            checkoutParamsEncrypted: encryptStorageValue(buildStripeCheckoutParams({
              orderId: created.id,
              gallerySlug: row.gallery.slug,
              projectId: row.gallery.projectId,
              customerEmail: created.customerEmail ?? "",
              deliveryMethod: created.deliveryMethod,
              pricedLines,
              origin: publicAppUrl(),
            })),
          }).where(eq(deliveryOrdersTable.id, created.id));
        }
        await tx.insert(deliveryOrderItemsTable).values(orderItems);
        if (created.customerEmail && created.publicReference) {
          await enqueueDeliveryOrderNotification(tx, {
            orderId: created.id,
            eventType: "order_received",
            recipientEmail: created.customerEmail,
            publicReference: created.publicReference,
            gallerySlug: row.gallery.slug,
            amountTotal: created.amountTotal,
            currency: created.currency,
            status: created.status,
            instructions: created.paymentMethod === "stripe"
              ? "Complete payment using the secure checkout page. Your order status will update after payment is confirmed."
              : manualPaymentInstructions(row.gallery, created.paymentMethod),
            itemSummary,
            recoveryUrl,
            recoveryToken,
            ...(created.paymentMethod === "stripe" ? { ready: false } : {}),
          });
        }
        return created;
      });
    } catch (error) {
      if (!isUniqueConstraintViolation(error)) throw error;
      const [winner] = await db.select().from(deliveryOrdersTable).where(and(
        eq(deliveryOrdersTable.galleryId, row.gallery.id),
        eq(deliveryOrdersTable.accessId, access.access.id),
        eq(deliveryOrdersTable.idempotencyKey, idempotencyKey),
      )).limit(1);
      if (!winner) throw error;
      if (winner.requestFingerprint !== requestFingerprint) {
        res.status(409).json({ error: "This checkout key was already used for a different order" });
        return;
      }
      let winnerAttempt: Awaited<ReturnType<typeof performStripeCheckoutAttempt>> | null = null;
      if (winner.paymentMethod === "stripe"
        && (winner.checkoutAttemptStatus === "started" || winner.checkoutAttemptStatus === "uncertain")) {
        if (winner.checkoutParamsEncrypted) {
          const checkoutParams = decryptStorageValue<DurableStripeCheckoutParams>(winner.checkoutParamsEncrypted);
          winnerAttempt = await performStripeCheckoutAttempt(
            winner.id,
            `delivery-order-${winner.id}-${idempotencyKey}`,
            checkoutParams,
          );
          if (winnerAttempt.status !== "started") await dispatchDeliveryOrderNotifications(winner.id);
        }
      }
      let checkoutUrl: string | null = null;
      const winnerSessionId = winnerAttempt?.sessionId ?? winner.stripeCheckoutSessionId;
      if (winnerSessionId) {
        try {
          const stripe = await getUncachableStripeClient();
          checkoutUrl = (await stripe.checkout.sessions.retrieve(winnerSessionId)).url;
        } catch {
          // Do not create another provider session while the winner is authoritative.
        }
      }
      res.json({
        checkoutUrl,
        orderId: winner.id,
        publicReference: winner.publicReference,
        status: winner.status,
        paymentMethod: winner.paymentMethod,
        paymentInstructions: winner.paymentMethod === "stripe"
          ? null
          : manualPaymentInstructions(row.gallery, winner.paymentMethod),
        checkoutAttemptStatus: winnerAttempt?.status ?? winner.checkoutAttemptStatus,
        recoveryUrl: null,
      });
      return;
    }

    if (paymentMethod !== "stripe") {
      await dispatchOrderNotification(order, row.gallery, itemSummary, recoveryUrl);
      res.json({
        checkoutUrl: null,
        orderId: order.id,
        publicReference,
        recoveryUrl,
        recoveryToken,
        status: order.status,
        paymentMethod,
        paymentInstructions: manualPaymentInstructions(row.gallery, paymentMethod as "establishment" | "bank_transfer"),
        checkoutAttemptStatus: order.checkoutAttemptStatus,
      });
      return;
    }

    const [durableOrder] = await db.select({
      checkoutParamsEncrypted: deliveryOrdersTable.checkoutParamsEncrypted,
    }).from(deliveryOrdersTable).where(eq(deliveryOrdersTable.id, order.id)).limit(1);
    if (!durableOrder?.checkoutParamsEncrypted) {
      res.status(202).json({
        checkoutUrl: null,
        orderId: order.id,
        publicReference,
        recoveryUrl,
        recoveryToken,
        status: order.status,
        paymentMethod,
        paymentInstructions: null,
        checkoutAttemptStatus: "uncertain",
      });
      return;
    }
    const checkoutParams = decryptStorageValue<DurableStripeCheckoutParams>(
      durableOrder.checkoutParamsEncrypted,
    );
    const attempt = await performStripeCheckoutAttempt(
      order.id,
      `delivery-order-${order.id}-${idempotencyKey}`,
      checkoutParams,
    );
    if (attempt.status !== "started") await dispatchDeliveryOrderNotifications(order.id);
    res.status(attempt.status === "started" ? 503 : attempt.status === "uncertain" ? 202 : 200).json({
      checkoutUrl: attempt.sessionUrl ?? null,
      orderId: order.id,
      publicReference,
      recoveryUrl,
      recoveryToken,
      status: order.status,
      paymentMethod,
      paymentInstructions: null,
      checkoutAttemptStatus: attempt.status,
    });
  } catch (error) {
    res.status(503).json({ error: error instanceof Error ? error.message : "Checkout is not available yet" });
  }
});

router.get("/delivery/:slug/orders/recovery/:reference", async (req, res): Promise<void> => {
  const slug = String(req.params.slug);
  const reference = String(req.params.reference);
  const token = String(req.header("x-order-recovery-token") ?? "");
  const ipKey = `ip:${req.ip ?? req.socket.remoteAddress ?? "unknown"}`;
  const referenceKey = `reference:${reference}`;
  if (recoveryByIp.isBlocked(ipKey) || recoveryByReference.isBlocked(referenceKey)) {
    res.setHeader("Retry-After", String(Math.ceil(PUBLIC_ACCESS_WINDOW_MS / 1000)));
    res.status(429).json({ error: "Too many recovery attempts. Try again later." });
    return;
  }
  const row = await getGalleryBySlug(slug);
  const [order] = row && row.gallery.status !== "revoked"
    ? await db.select().from(deliveryOrdersTable).where(and(
      eq(deliveryOrdersTable.galleryId, row.gallery.id),
      eq(deliveryOrdersTable.publicReference, reference),
    )).limit(1)
    : [];
  const valid = Boolean(order
    && token.length >= 32
    && recoveryTokenMatches(token, order.recoveryTokenHash)
    && order.recoveryRevokedAt === null
    && order.recoveryExpiresAt !== null
    && order.recoveryExpiresAt > new Date());
  if (!valid || !row || !order) {
    recoveryByIp.recordFailure(ipKey);
    recoveryByReference.recordFailure(referenceKey);
    res.status(404).json({ error: "Order recovery link is invalid or expired" });
    return;
  }
  const items = await db.select({
    productName: deliveryOrderItemsTable.productName,
    productType: deliveryOrderItemsTable.productType,
    quantity: deliveryOrderItemsTable.quantity,
  }).from(deliveryOrderItemsTable).where(eq(deliveryOrderItemsTable.orderId, order.id));
  res.json({
    reference: order.publicReference,
    status: order.status,
    paymentMethod: order.paymentMethod,
    amountTotal: order.amountTotal,
    currency: order.currency,
    createdAt: order.createdAt.toISOString(),
    paidAt: order.paidAt?.toISOString() ?? null,
    fulfillmentStatus: order.fulfillmentStatus,
    deliveryMethod: order.deliveryMethod,
    manualInstructions: order.paymentMethod === "stripe"
      ? null
      : manualPaymentInstructions(row.gallery, order.paymentMethod),
    items: items.map((item) => ({
      productName: item.productName,
      productType: item.productType,
      quantity: item.quantity,
    })),
  });
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
  const orderAccess = await getAccessForToken(row.gallery.id, verified.accessId);
  if (!orderAccess || !accessIsUsable(orderAccess.access)
    || orderAccess.access.tokenVersion !== verified.accessVersion) {
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
    .select({
      photoId: deliveryOrderItemsTable.photoId,
      includesDigitalDownloads: deliveryOrderItemsTable.includesDigitalDownloads,
      productType: deliveryOrderItemsTable.productType,
      quantity: deliveryOrderItemsTable.quantity,
    })
    .from(deliveryOrderItemsTable)
    .where(eq(deliveryOrderItemsTable.orderId, order.id));
  const responseItems = items.map((item) => ({
    ...item,
    ...(item.productType === "print" && item.photoId !== null
      ? {
        printUrl: `/api/delivery/${row.gallery.slug}/photos/${item.photoId}/file?print=1&mediaToken=${encodeURIComponent(signMediaToken({
          galleryId: row.gallery.id,
          accessId: verified.accessId,
          accessVersion: verified.accessVersion,
          photoId: item.photoId,
          expiresAt: Math.floor(Date.now() / 1000) + 15 * 60,
        }))}`,
      }
      : {}),
  }));
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
    items: responseItems,
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
  if (!tokenAccess || !accessIsUsable(tokenAccess.access)
    || tokenAccess.access.tokenVersion !== verified.accessVersion) {
    res.status(401).json({ error: "Delivery access has expired" });
    return;
  }
  await projectAvailableGroupJpegsToStudent(row.gallery.projectId, tokenAccess.student.id);

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
      ...deliveryPhotoEligibility(),
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
  const isPrint = req.query.print === "1";
  if (!isPreview && !(await photoHasBeenPaid(verified.accessId, photoId, isPrint))) {
    res.status(402).json({ error: "Complete payment before downloading this photo" });
    return;
  }

  res.setHeader("Content-Type", photo.photo.mimeType || "image/jpeg");
  res.setHeader("Content-Disposition", `${isPreview ? "inline" : "attachment"}; filename="${photo.photo.fileName.replace(/["\r\n]/g, "_")}"`);
  res.setHeader(
    "Cache-Control",
    isPreview && typeof req.query.mediaToken === "string"
      ? "public, max-age=900, s-maxage=900, immutable"
      : "private, max-age=300",
  );

  // During the storage migration, a photo may already have a verified private
  // R2 copy. Stream that copy through this authorized endpoint rather than
  // returning an R2 URL (or exposing bucket credentials). Only fall back to
  // Replit Object Storage when no verified copy exists yet.
  const verifiedR2Copy = await getVerifiedR2CopyForPhoto(photo.photo);
  if (verifiedR2Copy) {
    let r2Response: Response;
    try {
      if (isPreview) {
        const variantKind = req.query.size === "thumbnail" ? "thumbnail" : "preview";
        const watermarkText = row.gallery.watermarkEnabled
          ? row.gallery.watermarkText?.trim() || row.studio?.name?.trim() || "Volume Capture"
          : undefined;
        const variantKey = await ensureR2PhotoVariant(
          verifiedR2Copy,
          variantKind,
          watermarkText,
        );
        r2Response = await getR2Object(variantKey);
      } else {
        // Paid downloads are derivatives too: apply the saved non-destructive
        // capture edit while keeping the verified camera original immutable.
        const variantKey = await ensureR2PhotoVariant(
          verifiedR2Copy,
          isPrint ? "print" : "download",
        );
        r2Response = await getR2Object(variantKey);
      }
    } catch {
      res.status(503).json({ error: "Photo file is temporarily unavailable" });
      return;
    }
    if (!r2Response.body) {
      res.status(503).json({ error: "Photo file is temporarily unavailable" });
      return;
    }
    const input = Readable.fromWeb(r2Response.body as globalThis.ReadableStream<Uint8Array>);
    if (isPreview || isPrint) res.setHeader("Content-Type", "image/jpeg");
    input.pipe(res);
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
  const input = objectFile.createReadStream();
  if (isPreview) {
    res.setHeader("Content-Type", "image/jpeg");
    const watermarkText = row.gallery.watermarkText?.trim() || row.studio?.name?.trim() || "Volume Capture";
    const transformer = sharp()
      .resize({ width: req.query.size === "thumbnail" ? 480 : 1600, withoutEnlargement: true })
      .composite(row.gallery.watermarkEnabled ? [{ input: watermarkSvg(watermarkText), tile: true, blend: "over" }] : [])
      .jpeg({ quality: req.query.size === "thumbnail" ? 72 : 82, progressive: true });
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
  const [project] = await db.select({ projectType: projectsTable.projectType, schoolName: projectsTable.schoolName })
    .from(projectsTable)
    .where(eq(projectsTable.id, projectId))
    .limit(1);
  const projectType: DeliveryProjectType = project?.projectType === "corporate" ? "corporate" : "school";
  const accesses = await db.select().from(deliveryAccessesTable).where(eq(deliveryAccessesTable.galleryId, gallery.id));
  res.json({
    gallery: {
      ...gallery,
      publishedAt: gallery.publishedAt?.toISOString() ?? null,
      expiresAt: gallery.expiresAt?.toISOString() ?? null,
      createdAt: gallery.createdAt.toISOString(),
      updatedAt: gallery.updatedAt.toISOString(),
    },
    projectType,
    ...deliveryTerminology(projectType),
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
  const [undeliverableCapture, undeliverableGroup, undeliverableLegacyPhoto] = await Promise.all([
    db.select({ id: captureFilesTable.id })
      .from(capturesTable)
      .innerJoin(captureFilesTable, and(
        eq(captureFilesTable.captureId, capturesTable.id),
        eq(captureFilesTable.fileRole, "JPEG"),
        isNull(captureFilesTable.durableObjectPath),
      ))
      .where(and(eq(capturesTable.projectId, projectId), gt(capturesTable.rating, 0)))
      .limit(1),
    db.select({ id: groupCaptureFilesTable.id })
      .from(groupCapturesTable)
      .innerJoin(groupCaptureFilesTable, and(
        eq(groupCaptureFilesTable.captureId, groupCapturesTable.id),
        eq(groupCaptureFilesTable.fileRole, "JPEG"),
        isNull(groupCaptureFilesTable.durableObjectPath),
      ))
      .innerJoin(groupMembersTable, eq(groupMembersTable.groupId, groupCapturesTable.groupId))
      .where(and(eq(groupCapturesTable.projectId, projectId), gt(groupCapturesTable.rating, 0)))
      .limit(1),
    db.select({ id: studentPhotosTable.id })
      .from(studentPhotosTable)
      .where(and(
        eq(studentPhotosTable.projectId, projectId),
        gt(studentPhotosTable.rating, 0),
        eq(studentPhotosTable.shareWithParents, true),
        ilike(studentPhotosTable.mimeType, "image/jpeg%"),
        isNull(studentPhotosTable.durableObjectPath),
      ))
      .limit(1),
  ]);
  if (undeliverableCapture[0] || undeliverableGroup[0] || undeliverableLegacyPhoto[0]) {
    res.status(409).json({
      error: "Some photos are not in durable storage yet. Re-upload them before publishing delivery.",
      code: "PHOTO_STORAGE_INCOMPLETE",
    });
    return;
  }

  const students = await db.select().from(studentsTable).where(eq(studentsTable.projectId, projectId));
  const now = new Date();
  gallery = await db.transaction(async (tx) => {
    const [published] = await tx.update(deliveryGalleriesTable).set({
      status: "published",
      priceSheetJson: selectedPriceSheet.offersJson,
      publishedAt: sql`coalesce(${deliveryGalleriesTable.publishedAt}, ${now})`,
      updatedAt: now,
    }).where(eq(deliveryGalleriesTable.id, gallery.id)).returning();
    if (students.length > 0) {
      const existing = await tx.select({ studentId: deliveryAccessesTable.studentId })
        .from(deliveryAccessesTable)
        .where(eq(deliveryAccessesTable.galleryId, published.id));
      const existingStudentIds = new Set(existing.map((access) => access.studentId));
      const missingStudents = students.filter((student) => !existingStudentIds.has(student.id));
      if (missingStudents.length > 0) await tx.insert(deliveryAccessesTable).values(missingStudents.map((student) => {
        const code = makeCode();
        return {
          galleryId: published.id,
          studentId: student.id,
          accessCodeHash: hashCode(code),
          accessCodeEncrypted: encryptStorageValue(code),
          accessCodeLast4: code.slice(-4),
        };
      })).onConflictDoNothing();
    }
    await enqueueDeliveryInvitations(tx, published.id, students);
    return published;
  });

  let invitationSummary;
  try {
    invitationSummary = await dispatchDeliveryInvitations(gallery.id);
  } catch (error) {
    logger.error({ err: error, galleryId: gallery.id }, "Delivery invitation dispatch failed after publication");
    invitationSummary = {
      dispatched: false,
      claimed: 0,
      sent: 0,
      failed: 0,
      needsReview: 0,
      pending: 0,
      reason: "Invitation dispatch failed after publication",
    };
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
    invitationSummary,
  });
});

async function prepareDeliveryAccesses(galleryId: number, projectId: number): Promise<void> {
  await db.transaction(async (tx) => {
    const students = await tx.select({ id: studentsTable.id })
      .from(studentsTable)
      .where(eq(studentsTable.projectId, projectId));
    if (students.length === 0) return;
    const existing = await tx.select({ studentId: deliveryAccessesTable.studentId })
      .from(deliveryAccessesTable)
      .where(eq(deliveryAccessesTable.galleryId, galleryId));
    const existingStudentIds = new Set(existing.map((access) => access.studentId));
    const missingStudents = students.filter((student) => !existingStudentIds.has(student.id));
    if (missingStudents.length > 0) {
      await tx.insert(deliveryAccessesTable).values(missingStudents.map((student) => {
        const code = makeCode();
        return {
          galleryId,
          studentId: student.id,
          accessCodeHash: hashCode(code),
          accessCodeEncrypted: encryptStorageValue(code),
          accessCodeLast4: code.slice(-4),
        };
      })).onConflictDoNothing();
    }
  });
}

async function ensureDeliveryGalleryForPreparation(projectId: number) {
  return db.transaction(async (tx) => {
    const [existing] = await tx.select().from(deliveryGalleriesTable)
      .where(eq(deliveryGalleriesTable.projectId, projectId)).limit(1);
    if (existing) return existing;
    const [project] = await tx.select({
      studioId: projectsTable.studioId,
    }).from(projectsTable).where(eq(projectsTable.id, projectId)).limit(1);
    if (!project) return null;
    await tx.insert(deliveryGalleriesTable).values({
      projectId,
      studioId: project.studioId,
      slug: `vc-${randomBytes(8).toString("hex")}`,
      status: "draft",
    }).onConflictDoNothing();
    const [created] = await tx.select().from(deliveryGalleriesTable)
      .where(eq(deliveryGalleriesTable.projectId, projectId)).limit(1);
    return created ?? null;
  });
}

async function deliveryAccessCards(
  gallery: typeof deliveryGalleriesTable.$inferSelect,
  projectType: DeliveryProjectType,
  projectName: string | null,
) {
  const terminology = deliveryTerminology(projectType);
  const rows = await db
    .select({ access: deliveryAccessesTable, student: studentsTable, className: classesTable.className })
    .from(deliveryAccessesTable)
    .innerJoin(studentsTable, eq(deliveryAccessesTable.studentId, studentsTable.id))
    .leftJoin(classesTable, eq(studentsTable.classId, classesTable.id))
    .where(and(eq(deliveryAccessesTable.galleryId, gallery.id), isNull(deliveryAccessesTable.revokedAt)));
  const origin = publicAppUrl();
  return Promise.all(rows.map(async ({ access, student, className }) => {
    const accessCode = decryptStorageValue<string>(access.accessCodeEncrypted);
    const accessUrl = `${origin}/delivery/${gallery.slug}`;
    const qrUrl = `${accessUrl}#code=${encodeURIComponent(accessCode)}`;
    return {
      firstName: student.firstName,
      lastName: student.lastName,
      subjectLabel: terminology.subjectLabel,
      groupLabel: terminology.groupLabel,
      companyName: projectType === "corporate" ? projectName : null,
      studentId: student.id,
      subjectId: student.id,
      generatedStudentId: student.generatedStudentId,
      className,
      departmentName: className,
      accessCode,
      accessUrl,
      qrUrl,
      qrDataUrl: await QRCode.toDataURL(qrUrl, {
        errorCorrectionLevel: "M",
        margin: 2,
        width: 320,
      }),
    };
  }));
}

router.post("/projects/:projectId/delivery/access-cards/prepare", requireAuth, async (req, res): Promise<void> => {
  const projectId = Number(req.params.projectId);
  const userId = getUserId(req);
  if (!Number.isInteger(projectId) || !(await canAccessProject(userId, projectId, "manage"))) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  try {
    publicAppUrl();
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Invalid public application URL" });
    return;
  }
  const gallery = await ensureDeliveryGalleryForPreparation(projectId);
  if (!gallery) {
    res.status(404).json({ error: "Delivery gallery not found" });
    return;
  }
  if (gallery.status === "revoked") {
    res.status(409).json({ error: "Delivery gallery is revoked", code: "DELIVERY_GALLERY_REVOKED" });
    return;
  }

  // The transaction only inserts missing rows. The response is built from a
  // fresh read below, so a losing concurrent generator is never returned.
  await prepareDeliveryAccesses(gallery.id, projectId);
  const [studentCount] = await db.select({ count: sql<number>`count(*)` })
    .from(studentsTable).where(eq(studentsTable.projectId, projectId));
  const [preparedCount] = await db.select({ count: sql<number>`count(*)` })
    .from(deliveryAccessesTable)
    .innerJoin(studentsTable, eq(deliveryAccessesTable.studentId, studentsTable.id))
    .where(and(
      eq(deliveryAccessesTable.galleryId, gallery.id),
      eq(studentsTable.projectId, projectId),
      isNull(deliveryAccessesTable.revokedAt),
    ));
  const [project] = await db.select({ projectType: projectsTable.projectType, schoolName: projectsTable.schoolName })
    .from(projectsTable).where(eq(projectsTable.id, projectId)).limit(1);
  const projectType: DeliveryProjectType = project?.projectType === "corporate" ? "corporate" : "school";
  const cards = await deliveryAccessCards(gallery, projectType, project?.schoolName ?? null);
  res.json({
    gallery: {
      id: gallery.id,
      slug: gallery.slug,
      status: gallery.status,
    },
    preparedCount: Number(preparedCount?.count ?? 0),
    studentCount: Number(studentCount?.count ?? 0),
    cards,
    message: "Access cards prepared. Preparation does not publish the gallery.",
  });
});

router.post("/projects/:projectId/delivery/invitations/retry", requireAuth, async (req, res): Promise<void> => {
  const projectId = Number(req.params.projectId);
  const userId = getUserId(req);
  if (!Number.isInteger(projectId)) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const [targetProject] = await db.select({
    studioId: projectsTable.studioId,
  }).from(projectsTable).where(eq(projectsTable.id, projectId)).limit(1);
  if (!targetProject?.studioId) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const [targetMember] = await db.select({ role: studioMembersTable.role })
    .from(studioMembersTable)
    .where(and(
      eq(studioMembersTable.studioId, targetProject.studioId),
      eq(studioMembersTable.userId, userId),
      eq(studioMembersTable.status, "active"),
    ))
    .limit(1);
  if (targetMember?.role !== "owner" && targetMember?.role !== "admin") {
    res.status(403).json({ error: "Studio owner or admin required" });
    return;
  }
  if (!(await canAccessProject(userId, projectId, "manage"))) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const [gallery] = await db.select().from(deliveryGalleriesTable)
    .where(eq(deliveryGalleriesTable.projectId, projectId)).limit(1);
  if (!gallery) {
    res.status(404).json({ error: "Publish the delivery gallery first" });
    return;
  }
  const invitationSummary = await retryFailedDeliveryInvitations(gallery.id);
  res.json({
    gallery: { id: gallery.id, slug: gallery.slug, status: gallery.status },
    invitationSummary,
  });
});

router.get("/projects/:projectId/delivery/access-cards", requireAuth, async (req, res): Promise<void> => {
  const projectId = Number(req.params.projectId);
  if (!Number.isInteger(projectId) || !(await canAccessProject(getUserId(req), projectId, "manage"))) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  try {
    publicAppUrl();
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Invalid public application URL" });
    return;
  }
  const [gallery] = await db.select().from(deliveryGalleriesTable).where(eq(deliveryGalleriesTable.projectId, projectId)).limit(1);
  if (!gallery) {
    res.status(404).json({ error: "Publish the delivery gallery first" });
    return;
  }
  const [project] = await db.select({ projectType: projectsTable.projectType, schoolName: projectsTable.schoolName })
    .from(projectsTable)
    .where(eq(projectsTable.id, projectId))
    .limit(1);
  const projectType: DeliveryProjectType = project?.projectType === "corporate" ? "corporate" : "school";
  res.json(await deliveryAccessCards(gallery, projectType, project?.schoolName ?? null));
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
    tokenVersion: sql`${deliveryAccessesTable.tokenVersion} + 1`,
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
  const update: Record<string, Date | null | ReturnType<typeof sql>> = {
    tokenVersion: sql`${deliveryAccessesTable.tokenVersion} + 1`,
  };
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

async function safeOrderDto(
  order: typeof deliveryOrdersTable.$inferSelect,
  includeNotificationOperations = false,
) {
  const safe = {
    id: order.id,
    publicReference: order.publicReference,
    status: order.status,
    paymentMethod: order.paymentMethod,
    customerName: order.customerName,
    customerEmail: order.customerEmail,
    fulfillmentStatus: order.fulfillmentStatus,
    deliveryMethod: order.deliveryMethod,
    deliveryAddress: order.deliveryAddress,
    amountTotal: order.amountTotal,
    currency: order.currency,
    createdAt: order.createdAt,
    paidAt: order.paidAt,
  };
  if (!includeNotificationOperations) return safe;
  const rows = await db.select({
    eventType: deliveryOrderNotificationsTable.eventType,
    status: deliveryOrderNotificationsTable.status,
    attempts: deliveryOrderNotificationsTable.attempts,
    sentAt: deliveryOrderNotificationsTable.sentAt,
  }).from(deliveryOrderNotificationsTable)
    .where(eq(deliveryOrderNotificationsTable.orderId, order.id));
  const byEvent = new Map(rows.map((row) => [row.eventType, row]));
  return {
    ...safe,
    notifications: {
      orderReceived: notificationStateDto(byEvent.get("order_received")),
      paymentConfirmed: notificationStateDto(byEvent.get("payment_confirmed")),
    },
  };
}

function notificationStateDto(
  row: {
    status: "pending" | "sending" | "sent" | "failed" | "needs_review";
    attempts: number;
    sentAt: Date | null;
  } | undefined,
) {
  return row ? {
    status: row.status,
    sentAt: row.sentAt?.toISOString() ?? null,
    attempts: row.attempts,
    retryAllowed: row.status === "failed",
  } : null;
}

function safeOrderItemDto(item: typeof deliveryOrderItemsTable.$inferSelect) {
  return {
    id: item.id,
    photoId: item.photoId,
    offerId: item.offerId,
    productName: item.productName,
    productType: item.productType,
    includesDigitalDownloads: item.includesDigitalDownloads,
    printSize: item.printSize,
    quantity: item.quantity,
    unitAmount: item.unitAmount,
    currency: item.currency,
  };
}

router.get("/projects/:projectId/delivery/orders", requireAuth, async (req, res): Promise<void> => {
  const projectId = Number(req.params.projectId);
  if (!Number.isInteger(projectId) || !(await canAccessProject(getUserId(req), projectId, "view"))) {
    res.status(404).json({ error: "Project not found" }); return;
  }
  const [gallery] = await db.select({ id: deliveryGalleriesTable.id }).from(deliveryGalleriesTable)
    .where(eq(deliveryGalleriesTable.projectId, projectId)).limit(1);
  if (!gallery) { res.json({ orders: [] }); return; }
  const includeNotificationOperations = await isStudioManagerForProject(getUserId(req), projectId);
  const orders = await db.select().from(deliveryOrdersTable).where(eq(deliveryOrdersTable.galleryId, gallery.id));
  res.json({
    orders: await Promise.all(orders.map((order) => safeOrderDto(order, includeNotificationOperations))),
  });
});

router.get("/projects/:projectId/delivery/operations", requireAuth, async (req, res): Promise<void> => {
  const projectId = Number(req.params.projectId);
  if (!Number.isInteger(projectId)
    || !(await isStudioManagerForProject(getUserId(req), projectId))) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const [gallery] = await db.select({ id: deliveryGalleriesTable.id })
    .from(deliveryGalleriesTable)
    .where(eq(deliveryGalleriesTable.projectId, projectId))
    .limit(1);
  if (!gallery) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const invitationRows = await db.select({
    status: deliveryInvitationsTable.status,
    count: sql<number>`count(*)`,
  }).from(deliveryInvitationsTable)
    .where(eq(deliveryInvitationsTable.galleryId, gallery.id))
    .groupBy(deliveryInvitationsTable.status);
  const orderNotificationRows = await db.select({
    status: deliveryOrderNotificationsTable.status,
    count: sql<number>`count(*)`,
  }).from(deliveryOrderNotificationsTable)
    .innerJoin(deliveryOrdersTable, eq(deliveryOrdersTable.id, deliveryOrderNotificationsTable.orderId))
    .where(eq(deliveryOrdersTable.galleryId, gallery.id))
    .groupBy(deliveryOrderNotificationsTable.status);
  const counts = <T extends string>(rows: Array<{ status: T; count: number }>) => ({
    pending: Number(rows.find((row) => row.status === "pending")?.count ?? 0),
    sending: Number(rows.find((row) => row.status === "sending")?.count ?? 0),
    sent: Number(rows.find((row) => row.status === "sent")?.count ?? 0),
    failed: Number(rows.find((row) => row.status === "failed")?.count ?? 0),
    needsReview: Number(rows.find((row) => row.status === "needs_review")?.count ?? 0),
  });
  const invitations = counts(invitationRows);
  const orderNotifications = counts(orderNotificationRows);
  res.json({
    invitations,
    orderNotifications,
    issues: {
      invitations: invitations.failed + invitations.needsReview,
      orderNotifications: orderNotifications.failed + orderNotifications.needsReview,
    },
  });
});

router.get("/projects/:projectId/delivery/orders/:orderId", requireAuth, async (req, res): Promise<void> => {
  const projectId = Number(req.params.projectId), orderId = Number(req.params.orderId);
  if (!(await canAccessProject(getUserId(req), projectId, "view"))) { res.status(404).json({ error: "Project not found" }); return; }
  const [order] = await db.select({ order: deliveryOrdersTable, gallery: deliveryGalleriesTable })
    .from(deliveryOrdersTable).innerJoin(deliveryGalleriesTable, eq(deliveryOrdersTable.galleryId, deliveryGalleriesTable.id))
    .where(and(eq(deliveryOrdersTable.id, orderId), eq(deliveryGalleriesTable.projectId, projectId))).limit(1);
  if (!order) { res.status(404).json({ error: "Order not found" }); return; }
  const items = await db.select().from(deliveryOrderItemsTable).where(eq(deliveryOrderItemsTable.orderId, orderId));
  const includeNotificationOperations = await isStudioManagerForProject(getUserId(req), projectId);
  res.json({
    order: await safeOrderDto(order.order, includeNotificationOperations),
    items: items.map(safeOrderItemDto),
  });
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
  res.json({ order: await safeOrderDto(updated) });
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
  const [updated] = await db.transaction(async (tx) => {
    const [next] = await tx.update(deliveryOrdersTable).set({
      status: status as "pending" | "paid" | "cancelled" | "refunded",
      paidAt: status === "paid" ? (ownedOrder.order.paidAt ?? new Date()) : null,
      ...(status === "paid" ? { fulfillmentStatus: hasPhysicalItem ? "paid" as const : "not_required" as const } : {}),
    }).where(eq(deliveryOrdersTable.id, orderId)).returning();
    if (next && status === "paid" && ownedOrder.order.status !== "paid") {
      await enqueuePaymentConfirmedNotification(tx, {
        orderId,
        status: "paid",
        instructions: "Your payment was confirmed. The studio will prepare your order and update its status here.",
      });
    }
    return [next];
  });
  if (!updated) { res.status(404).json({ error: "Order not found" }); return; }
  if (status === "paid" && updated.customerEmail) {
    const [gallery] = await db.select({ studioId: deliveryGalleriesTable.studioId, projectId: deliveryGalleriesTable.projectId })
      .from(deliveryGalleriesTable).where(eq(deliveryGalleriesTable.id, updated.galleryId)).limit(1);
    if (gallery?.studioId) await markContactOrder(gallery.studioId, updated.customerEmail, updated.contactId);
  }
  if (status === "paid" && ownedOrder.order.status !== "paid") {
    await dispatchDeliveryOrderNotifications(orderId);
  }
  res.json({ order: await safeOrderDto(updated) });
});

router.post("/projects/:projectId/delivery/orders/:orderId/notifications/retry", requireAuth, async (req, res): Promise<void> => {
  const projectId = Number(req.params.projectId);
  const orderId = Number(req.params.orderId);
  if (!Number.isInteger(projectId) || !Number.isInteger(orderId)
    || !await isStudioManagerForProject(getUserId(req), projectId)) {
    res.status(404).json({ error: "Order not found" });
    return;
  }
  const [order] = await db.select({ id: deliveryOrdersTable.id })
    .from(deliveryOrdersTable)
    .innerJoin(deliveryGalleriesTable, eq(deliveryOrdersTable.galleryId, deliveryGalleriesTable.id))
    .where(and(
      eq(deliveryOrdersTable.id, orderId),
      eq(deliveryGalleriesTable.projectId, projectId),
    ))
    .limit(1);
  if (!order) {
    res.status(404).json({ error: "Order not found" });
    return;
  }
  res.json(await retryFailedDeliveryOrderNotifications(order.id));
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