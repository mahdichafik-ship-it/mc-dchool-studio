import {
  and,
  asc,
  eq,
  inArray,
  isNull,
  lt,
  ne,
  or,
  sql,
} from "drizzle-orm";
import { createHash } from "node:crypto";
import {
  db,
} from "@workspace/db";
import {
  classesTable,
  deliveryAccessesTable,
  deliveryGalleriesTable,
  deliveryInvitationAccessLinksTable,
  deliveryInvitationsTable,
  projectsTable,
  studentsTable,
} from "@workspace/db/schema";
import type { Student } from "@workspace/db/schema";
import { decryptStorageValue } from "./storageCrypto";
import {
  resendConfigurationStatus,
  ResendSendError,
  sendResendEmailBatch,
} from "./resendEmail";
import { publicAppUrl } from "./publicAppUrl";

const CLAIM_STALE_MS = 15 * 60 * 1000;
const BATCH_SIZE = 100;
type DeliveryTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export function normalizeDeliveryRecipientEmail(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase() ?? "";
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalized) ? normalized : null;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * Create the recipient ledger and all access links inside the publication
 * transaction. This function intentionally has no marketing-table imports.
 */
export async function enqueueDeliveryInvitations(
  tx: DeliveryTransaction,
  galleryId: number,
  students: Student[],
): Promise<void> {
  const recipientStudents = new Map<string, Set<number>>();
  for (const student of students) {
    for (const rawEmail of [student.email, student.secondaryEmail]) {
      const email = normalizeDeliveryRecipientEmail(rawEmail);
      if (!email) continue;
      const ids = recipientStudents.get(email) ?? new Set<number>();
      ids.add(student.id);
      recipientStudents.set(email, ids);
    }
  }
  const emails = [...recipientStudents.keys()];
  if (emails.length === 0) return;

  await tx.insert(deliveryInvitationsTable).values(emails.map((recipientEmail) => ({
    galleryId,
    recipientEmail,
  }))).onConflictDoNothing();

  const invitations = await tx.select()
    .from(deliveryInvitationsTable)
    .where(and(
      eq(deliveryInvitationsTable.galleryId, galleryId),
      inArray(deliveryInvitationsTable.recipientEmail, emails),
    ));
  const accesses = await tx.select()
    .from(deliveryAccessesTable)
    .where(eq(deliveryAccessesTable.galleryId, galleryId));
  const invitationByEmail = new Map(invitations.map((invitation) => [invitation.recipientEmail, invitation]));
  const accessByStudent = new Map(accesses.map((access) => [access.studentId, access]));
  const links: Array<{ invitationId: number; accessId: number }> = [];
  for (const [email, studentIds] of recipientStudents) {
    const invitation = invitationByEmail.get(email);
    if (!invitation) continue;
    for (const studentId of studentIds) {
      const access = accessByStudent.get(studentId);
      if (access) links.push({ invitationId: invitation.id, accessId: access.id });
    }
  }
  if (links.length === 0) return;
  const newLinks = await tx.insert(deliveryInvitationAccessLinksTable)
    .values(links)
    .onConflictDoNothing()
    .returning({
      invitationId: deliveryInvitationAccessLinksTable.invitationId,
    });
  const changedInvitationIds = [...new Set(newLinks.map((link) => link.invitationId))];
  if (changedInvitationIds.length === 0) return;

  for (const invitationId of changedInvitationIds) {
    const invitation = invitations.find((item) => item.id === invitationId);
    if (!invitation || !["sent", "failed", "sending", "needs_review"].includes(invitation.status)) continue;
    // A sending row cannot safely be completed with a stale message after a
    // new access is attached; reconciliation must happen before another send.
    if (invitation.status === "sending") {
      await tx.update(deliveryInvitationsTable).set({
        status: "needs_review",
        contentRevision: sql`${deliveryInvitationsTable.contentRevision} + 1`,
        updatedAt: new Date(),
        lastError: "Invitation content changed while a provider claim was active; reconcile the earlier provider attempt",
      }).where(and(
        eq(deliveryInvitationsTable.id, invitationId),
        eq(deliveryInvitationsTable.status, "sending"),
      ));
      continue;
    }
    if (invitation.status === "needs_review") {
      await tx.update(deliveryInvitationsTable).set({
        status: "needs_review",
        contentRevision: sql`${deliveryInvitationsTable.contentRevision} + 1`,
        updatedAt: new Date(),
        lastError: "New access was linked after an uncertain provider attempt; reconcile the earlier attempt before resending",
      }).where(and(
        eq(deliveryInvitationsTable.id, invitationId),
        eq(deliveryInvitationsTable.status, "needs_review"),
      ));
      continue;
    }
    await tx.update(deliveryInvitationsTable).set({
      status: "pending",
      contentRevision: sql`${deliveryInvitationsTable.contentRevision} + 1`,
      claimedAt: null,
      sentAt: null,
      providerId: null,
      lastError: null,
      updatedAt: new Date(),
    }).where(and(
      eq(deliveryInvitationsTable.id, invitationId),
      ne(deliveryInvitationsTable.status, "needs_review"),
    ));
  }
}

type ClaimedInvitation = {
  id: number;
  contentRevision: number;
  attempt: number;
};

async function recoverStaleClaims(galleryId?: number): Promise<void> {
  const now = new Date();
  const staleBefore = new Date(now.getTime() - CLAIM_STALE_MS);
  await db.update(deliveryInvitationsTable).set({
    status: "needs_review",
    updatedAt: now,
    lastError: "Provider claim became stale; reconcile before retrying",
  }).where(and(
    eq(deliveryInvitationsTable.status, "sending"),
    ...(galleryId === undefined ? [] : [eq(deliveryInvitationsTable.galleryId, galleryId)]),
    or(isNull(deliveryInvitationsTable.claimedAt), lt(deliveryInvitationsTable.claimedAt, staleBefore)),
  ));
}

async function claimBatch(galleryId?: number, allowedIds?: number[]): Promise<ClaimedInvitation[]> {
  const now = new Date();
  if (allowedIds?.length === 0) return [];
  return db.transaction(async (tx) => {
    const rows = await tx.select({
      id: deliveryInvitationsTable.id,
      contentRevision: deliveryInvitationsTable.contentRevision,
    }).from(deliveryInvitationsTable)
      .where(and(
        eq(deliveryInvitationsTable.status, "pending"),
        ...(galleryId === undefined ? [] : [eq(deliveryInvitationsTable.galleryId, galleryId)]),
        ...(allowedIds === undefined ? [] : [inArray(deliveryInvitationsTable.id, allowedIds)]),
      ))
      .orderBy(asc(deliveryInvitationsTable.id))
      .limit(BATCH_SIZE)
      .for("update", { skipLocked: true });
    if (rows.length === 0) return [];
    const ids = rows.map((row) => row.id);
    const claimedRows = await tx.update(deliveryInvitationsTable).set({
      status: "sending",
      claimedAt: now,
      attempts: sql`${deliveryInvitationsTable.attempts} + 1`,
      updatedAt: now,
    }).where(and(eq(deliveryInvitationsTable.status, "pending"), inArray(deliveryInvitationsTable.id, ids)))
      .returning({
        id: deliveryInvitationsTable.id,
        attempt: deliveryInvitationsTable.attempts,
      });
    const attemptsById = new Map(claimedRows.map((row) => [row.id, row.attempt]));
    return rows
      .filter((row) => attemptsById.has(row.id))
      .map((row) => ({
        ...row,
        attempt: attemptsById.get(row.id) as number,
      }));
  });
}

type InvitationMessage = {
  invitationId: number;
  contentRevision: number;
  recipientEmail: string;
  subject: string;
  text: string;
  html: string;
};

async function invitationMessages(claimed: ClaimedInvitation[]): Promise<InvitationMessage[]> {
  const appUrl = publicAppUrl();
  const ids = claimed.map((row) => row.id);
  const revisions = new Map(claimed.map((row) => [row.id, row.contentRevision]));
  const rows = await db.select({
    invitation: deliveryInvitationsTable,
    gallery: deliveryGalleriesTable,
    project: projectsTable,
    access: deliveryAccessesTable,
    student: studentsTable,
    className: classesTable.className,
  }).from(deliveryInvitationsTable)
    .innerJoin(deliveryGalleriesTable, eq(deliveryGalleriesTable.id, deliveryInvitationsTable.galleryId))
    .innerJoin(projectsTable, eq(projectsTable.id, deliveryGalleriesTable.projectId))
    .innerJoin(deliveryInvitationAccessLinksTable, eq(deliveryInvitationAccessLinksTable.invitationId, deliveryInvitationsTable.id))
    .innerJoin(deliveryAccessesTable, eq(deliveryAccessesTable.id, deliveryInvitationAccessLinksTable.accessId))
    .innerJoin(studentsTable, eq(studentsTable.id, deliveryAccessesTable.studentId))
    .leftJoin(classesTable, eq(classesTable.id, studentsTable.classId))
    .where(inArray(deliveryInvitationsTable.id, ids));
  const grouped = new Map<number, typeof rows>();
  for (const row of rows) {
    const list = grouped.get(row.invitation.id) ?? [];
    list.push(row);
    grouped.set(row.invitation.id, list);
  }
  return [...grouped.entries()].flatMap(([invitationId, invitationRows]) => {
    const first = invitationRows[0];
    if (!first) return [];
    const claimedRevision = revisions.get(invitationId);
    if (first.invitation.status !== "sending" || claimedRevision !== first.invitation.contentRevision) return [];
    const corporate = first.project.projectType === "corporate";
    const lines = invitationRows.map(({ access, student, className }) => {
      const code = decryptStorageValue<string>(access.accessCodeEncrypted);
      const subject = `${student.firstName} ${student.lastName}`;
      const group = className ?? "";
      const url = `${appUrl}/delivery/${first.gallery.slug}`;
      return {
        code,
        subject,
        group,
        url,
        text: `${corporate ? "Employee" : "Student"}: ${subject}${group ? `\n${corporate ? "Department" : "Class"}: ${group}` : ""}\nAccess code: ${code}\nGallery: ${url}`,
      };
    });
    const heading = corporate
      ? "Your employee gallery is ready"
      : "Your family/guardian gallery is ready";
    const subject = corporate ? "Employee gallery access" : "Family/Guardian gallery access";
    const text = `${heading}\n\n${lines.map((line) => line.text).join("\n\n")}`;
    const html = `<p>${escapeHtml(heading)}</p>${lines.map((line) =>
      `<p><strong>${escapeHtml(corporate ? "Employee" : "Student")}:</strong> ${escapeHtml(line.subject)}<br>` +
      `<strong>${escapeHtml(corporate ? "Department" : "Class")}:</strong> ${escapeHtml(line.group)}<br>` +
      `<strong>Access code:</strong> ${escapeHtml(line.code)}<br>` +
      `<a href="${escapeHtml(line.url)}">Open gallery</a></p>`,
    ).join("")}`;
    return [{
      invitationId,
      contentRevision: revisions.get(invitationId) ?? first.invitation.contentRevision,
      recipientEmail: first.invitation.recipientEmail,
      subject,
      text,
      html,
    }];
  });
}

export type DeliveryInvitationDispatchSummary = {
  dispatched: boolean;
  claimed: number;
  sent: number;
  failed: number;
  needsReview: number;
  pending: number;
  reason: string | null;
};

export async function dispatchDeliveryInvitations(
  galleryId?: number,
  allowedIds?: number[],
): Promise<DeliveryInvitationDispatchSummary> {
  await recoverStaleClaims(galleryId);
  const configuration = resendConfigurationStatus();
  if (!configuration.canDispatch) {
    const [pending] = await db.select({ count: sql<number>`count(*)` })
      .from(deliveryInvitationsTable)
      .where(and(
        eq(deliveryInvitationsTable.status, "pending"),
        ...(galleryId === undefined ? [] : [eq(deliveryInvitationsTable.galleryId, galleryId)]),
        ...(allowedIds === undefined ? [] : [inArray(deliveryInvitationsTable.id, allowedIds)]),
      ));
    return {
      dispatched: false,
      claimed: 0,
      sent: 0,
      failed: 0,
      needsReview: 0,
      pending: Number(pending?.count ?? 0),
      reason: configuration.reason,
    };
  }
  let claimedTotal = 0;
  let sentTotal = 0;
  let failedTotal = 0;
  let needsReviewTotal = 0;
  while (true) {
    const claimed = await claimBatch(galleryId, allowedIds);
    if (claimed.length === 0) break;
    claimedTotal += claimed.length;
    let messages: InvitationMessage[];
    try {
      messages = await invitationMessages(claimed);
    } catch {
      for (const item of claimed) {
        await db.update(deliveryInvitationsTable).set({
          status: "needs_review",
          claimedAt: null,
          updatedAt: new Date(),
          lastError: "Invitation content could not be prepared for dispatch",
        }).where(and(
          eq(deliveryInvitationsTable.id, item.id),
          eq(deliveryInvitationsTable.status, "sending"),
          eq(deliveryInvitationsTable.contentRevision, item.contentRevision),
        ));
        needsReviewTotal += 1;
      }
      continue;
    }
    const messagesById = new Map(messages.map((message) => [message.invitationId, message]));
    const unmatched = claimed.filter((item) => !messagesById.has(item.id));
    if (unmatched.length > 0) {
      for (const item of unmatched) {
        await db.update(deliveryInvitationsTable).set({
          status: "needs_review",
          claimedAt: null,
          updatedAt: new Date(),
          lastError: "Claimed invitation has no durable access content to send",
        }).where(and(
          eq(deliveryInvitationsTable.id, item.id),
          eq(deliveryInvitationsTable.status, "sending"),
          eq(deliveryInvitationsTable.contentRevision, item.contentRevision),
        ));
        needsReviewTotal += 1;
      }
    }
    if (messages.length === 0) continue;
    const keyMaterial = claimed
      .filter((item) => messagesById.has(item.id))
      .map((item) => `${item.id}:${item.contentRevision}:a${item.attempt}`)
      .sort()
      .join("|");
    const keyDigest = createHash("sha256").update(keyMaterial).digest("hex");
    const key = `volume-capture-delivery-invitations-v1-${keyDigest}`;
    try {
      const providerIds = await sendResendEmailBatch(messages.map((message) => ({
        to: [message.recipientEmail],
        subject: message.subject,
        text: message.text,
        html: message.html,
        headers: {},
      })), key);
      for (let index = 0; index < messages.length; index += 1) {
        const message = messages[index];
        const providerId = providerIds[index];
        const [updated] = await db.update(deliveryInvitationsTable).set({
          status: "sent",
          providerId,
          sentAt: new Date(),
          claimedAt: null,
          updatedAt: new Date(),
          lastError: null,
        }).where(and(
          eq(deliveryInvitationsTable.id, message.invitationId),
          eq(deliveryInvitationsTable.status, "sending"),
          eq(deliveryInvitationsTable.contentRevision, message.contentRevision),
        )).returning({ id: deliveryInvitationsTable.id });
        if (updated) sentTotal += 1;
        else {
          await db.update(deliveryInvitationsTable).set({
            status: "needs_review",
            claimedAt: null,
            updatedAt: new Date(),
            lastError: "Invitation content changed while provider was processing it",
          }).where(and(eq(deliveryInvitationsTable.id, message.invitationId), eq(deliveryInvitationsTable.status, "sending")));
          needsReviewTotal += 1;
        }
      }
    } catch (error) {
      const rejected = error instanceof ResendSendError && error.outcome === "rejected";
      for (const message of messages) {
        await db.update(deliveryInvitationsTable).set({
          status: rejected ? "failed" : "needs_review",
          claimedAt: null,
          updatedAt: new Date(),
          lastError: rejected ? "Resend rejected the invitation batch" : "Invitation provider result is uncertain",
        }).where(and(
          eq(deliveryInvitationsTable.id, message.invitationId),
          eq(deliveryInvitationsTable.status, "sending"),
          eq(deliveryInvitationsTable.contentRevision, message.contentRevision),
        ));
        if (rejected) failedTotal += 1;
        else needsReviewTotal += 1;
      }
    }
  }
  const [pending] = await db.select({ count: sql<number>`count(*)` })
    .from(deliveryInvitationsTable)
    .where(and(
      eq(deliveryInvitationsTable.status, "pending"),
      ...(galleryId === undefined ? [] : [eq(deliveryInvitationsTable.galleryId, galleryId)]),
      ...(allowedIds === undefined ? [] : [inArray(deliveryInvitationsTable.id, allowedIds)]),
    ));
  return {
    dispatched: true,
    claimed: claimedTotal,
    sent: sentTotal,
    failed: failedTotal,
    needsReview: needsReviewTotal,
    pending: Number(pending?.count ?? 0),
    reason: null,
  };
}

export async function retryFailedDeliveryInvitations(galleryId: number): Promise<DeliveryInvitationDispatchSummary> {
  const failed = await db.select({ id: deliveryInvitationsTable.id })
    .from(deliveryInvitationsTable)
    .where(and(
      eq(deliveryInvitationsTable.galleryId, galleryId),
      eq(deliveryInvitationsTable.status, "failed"),
    ));
  const allowedIds = failed.map((item) => item.id);
  if (allowedIds.length === 0) return dispatchDeliveryInvitations(galleryId, allowedIds);
  await db.update(deliveryInvitationsTable).set({
    status: "pending",
    claimedAt: null,
    lastError: null,
    updatedAt: new Date(),
  }).where(and(
    eq(deliveryInvitationsTable.galleryId, galleryId),
    eq(deliveryInvitationsTable.status, "failed"),
  ));
  return dispatchDeliveryInvitations(galleryId, allowedIds);
}