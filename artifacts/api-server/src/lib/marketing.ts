import { and, eq, sql } from "drizzle-orm";
import {
  db,
  marketingContactsTable,
  marketingVisitsTable,
  type MarketingContact,
} from "@workspace/db";

export const marketingEmailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeMarketingEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  return marketingEmailPattern.test(email) && email.length <= 254 ? email : null;
}

type DatabaseExecutor = Pick<typeof db, "insert" | "update">;

export async function getOrCreateContact(
  studioId: number,
  email: string,
  executor: DatabaseExecutor = db,
): Promise<MarketingContact> {
  const normalized = normalizeMarketingEmail(email);
  if (!normalized) throw new Error("A valid email address is required");
  const now = new Date();
  const [contact] = await executor.insert(marketingContactsTable).values({
    studioId,
    email: normalized,
    firstSeenAt: now,
    lastSeenAt: now,
  }).onConflictDoUpdate({
    target: [marketingContactsTable.studioId, marketingContactsTable.email],
    set: { lastSeenAt: now },
  }).returning();
  return contact;
}

export async function recordSuccessfulGalleryAccess(
  studioId: number,
  email: string,
  details: {
    galleryId: number;
    accessId: number;
    projectId: number;
    sessionMarker?: string | null;
    marketingConsent?: boolean;
  },
  executor: DatabaseExecutor = db,
): Promise<MarketingContact> {
  const normalized = normalizeMarketingEmail(email);
  if (!normalized) throw new Error("A valid email address is required");
  const now = new Date();
  const consentFields = details.marketingConsent === true ? {
    marketingConsent: true,
    consentAt: now,
    consentSource: "gallery_access",
    unsubscribedAt: null,
  } : {};
  const [contact] = await executor.insert(marketingContactsTable).values({
    studioId,
    email: normalized,
    firstSeenAt: now,
    lastSeenAt: now,
    successfulGalleryAccesses: 1,
    ...consentFields,
  }).onConflictDoUpdate({
    target: [marketingContactsTable.studioId, marketingContactsTable.email],
    set: {
      lastSeenAt: now,
      successfulGalleryAccesses: sql`${marketingContactsTable.successfulGalleryAccesses} + 1`,
      ...consentFields,
    },
  }).returning();
  await executor.insert(marketingVisitsTable).values({
    contactId: contact.id,
    studioId,
    galleryId: details.galleryId,
    accessId: details.accessId,
    projectId: details.projectId,
    visitedAt: now,
    sessionMarker: details.sessionMarker ?? null,
  });
  return contact;
}

export async function markContactOrder(
  studioId: number,
  email: string,
  contactId?: number | null,
  executor: DatabaseExecutor = db,
): Promise<MarketingContact> {
  const normalized = normalizeMarketingEmail(email);
  if (!normalized) throw new Error("A valid email address is required");
  const now = new Date();
  if (contactId) {
    const [updated] = await executor.update(marketingContactsTable).set({
      lastSeenAt: now,
      lastOrderAt: now,
    }).where(and(eq(marketingContactsTable.id, contactId), eq(marketingContactsTable.studioId, studioId))).returning();
    if (updated) return updated;
  }
  const [contact] = await executor.insert(marketingContactsTable).values({
    studioId,
    email: normalized,
    firstSeenAt: now,
    lastSeenAt: now,
    lastOrderAt: now,
  }).onConflictDoUpdate({
    target: [marketingContactsTable.studioId, marketingContactsTable.email],
    set: { lastSeenAt: now, lastOrderAt: now },
  }).returning();
  return contact;
}