/**
 * Desktop-facing API routes — authenticated with a member-scoped connection
 * token (no Clerk).
 * Used by the Electron app to list and pull cloud projects without a JSON file.
 */

import { Router } from "express";
import type { Response } from "express";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { captureBatchesTable, captureFilesTable, capturesTable, db, desktopAuthSessionsTable, desktopConnectionsTable, studentPhotosTable, studioMembersTable } from "@workspace/db";
import { photoStorageCopiesTable } from "@workspace/db/schema";
import { projectsTable, classesTable, studentsTable } from "@workspace/db";
import { and, count, eq, gt, inArray, sql } from "drizzle-orm";
import {
  getDesktopConnection,
  hashDesktopToken,
  refreshDesktopConnection,
  requireDesktopConnection,
  requireDesktopConnectionWithRetirement,
  createDesktopToken,
} from "../lib/desktopAuth";
import { assignedDesktopProjectIds, canAccessDesktopProject } from "../lib/studioAccess";
import { getStudioMember } from "../lib/studioAccess";
import { getUserId, requireAuth } from "../lib/auth";
import { isPlatformOwner } from "../lib/platformAccess";
import { generateSimpleQr, generateJsonQr } from "../lib/qrcode";
import { reconcileDefaultGroups } from "../lib/groupReconciliation";
import { groupsTable, groupMemberExclusionsTable, groupMembersTable, groupCaptureFilesTable, groupCapturesTable } from "@workspace/db";
import { verifyR2Copy } from "../lib/r2UploadCopies";

const router = Router();
const desktopAuthLifetimeMs = 10 * 60 * 1000;

async function storageCopyProjectId(
  copy: typeof photoStorageCopiesTable.$inferSelect,
): Promise<number | null> {
  if (copy.studentPhotoId !== null) {
    const [photo] = await db
      .select({ projectId: studentPhotosTable.projectId })
      .from(studentPhotosTable)
      .where(eq(studentPhotosTable.id, copy.studentPhotoId))
      .limit(1);
    return photo?.projectId ?? null;
  }
  if (copy.captureFileId !== null) {
    const [capture] = await db
      .select({ projectId: capturesTable.projectId })
      .from(captureFilesTable)
      .innerJoin(
        capturesTable,
        eq(captureFilesTable.captureId, capturesTable.id),
      )
      .where(eq(captureFilesTable.id, copy.captureFileId))
      .limit(1);
    return capture?.projectId ?? null;
  }
  if (copy.groupCaptureFileId !== null) {
    const [capture] = await db
      .select({ projectId: groupCapturesTable.projectId })
      .from(groupCaptureFilesTable)
      .innerJoin(
        groupCapturesTable,
        eq(groupCaptureFilesTable.captureId, groupCapturesTable.id),
      )
      .where(eq(groupCaptureFilesTable.id, copy.groupCaptureFileId))
      .limit(1);
    return capture?.projectId ?? null;
  }
  return null;
}

router.post(
  "/storage-copies/:copyId/r2/verify",
  requireDesktopConnection,
  async (req, res): Promise<void> => {
    const copyId = Number(req.params.copyId);
    if (!Number.isSafeInteger(copyId) || copyId <= 0) {
      res.status(400).json({ error: "Invalid storage copy identifier" });
      return;
    }
    const [copy] = await db
      .select()
      .from(photoStorageCopiesTable)
      .where(eq(photoStorageCopiesTable.id, copyId))
      .limit(1);
    const connection = getDesktopConnection(req);
    const projectId = copy ? await storageCopyProjectId(copy) : null;
    if (
      !copy ||
      projectId === null ||
      !(await canAccessDesktopProject(
        {
          id: connection.memberId,
          studioId: connection.studioId,
          role: connection.memberRole,
          userId: connection.memberUserId,
        },
        projectId,
      ))
    ) {
      res.status(404).json({ error: "Storage copy not found" });
      return;
    }
    try {
      const verified = await verifyR2Copy(copy);
      res.json({
        copy: {
          id: verified.id,
          destination: verified.destination,
          state: verified.state,
          objectKey: verified.objectKey,
          fileSize: verified.fileSize,
          sha256: verified.sha256,
          etag: verified.etag,
          verifiedAt: verified.verifiedAt,
        },
      });
    } catch (error) {
      const code =
        error instanceof Error && "code" in error
          ? String(error.code)
          : "R2_VERIFICATION_FAILED";
      res.status(code === "R2_UPLOAD_NOT_VERIFIED" ? 409 : 503).json({
        error:
          error instanceof Error ? error.message : "R2 verification failed",
        code,
      });
    }
  },
);

function validCaptureBatchKey(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9:_-]{8,200}$/.test(value);
}

function validClientSecret(secret: unknown): secret is string {
  return typeof secret === "string" && secret.length >= 32 && secret.length <= 200;
}

async function findAuthSession(publicCode: unknown) {
  if (typeof publicCode !== "string" || publicCode.length < 20 || publicCode.length > 200) return null;
  const [session] = await db
    .select()
    .from(desktopAuthSessionsTable)
    .where(eq(desktopAuthSessionsTable.publicCode, publicCode))
    .limit(1);
  return session ?? null;
}

function matchesClientSecret(expectedHash: string, clientSecret: string) {
  const expected = Buffer.from(expectedHash, "hex");
  const provided = Buffer.from(hashDesktopToken(clientSecret), "hex");
  return expected.length === provided.length && timingSafeEqual(expected, provided);
}

function isExpired(expiresAt: Date) {
  return expiresAt.getTime() <= Date.now();
}

// Start a browser-based desktop sign-in. The client secret never leaves the
// desktop process; the public code is only used to identify the browser prompt.
router.post("/auth/start", async (req, res): Promise<void> => {
  const clientSecret = req.body?.clientSecret;
  if (!validClientSecret(clientSecret)) {
    res.status(400).json({ error: "Invalid desktop sign-in request" });
    return;
  }

  const publicCode = randomBytes(24).toString("base64url");
  const expiresAt = new Date(Date.now() + desktopAuthLifetimeMs);
  await db.insert(desktopAuthSessionsTable).values({
    publicCode,
    clientSecretHash: hashDesktopToken(clientSecret),
    expiresAt,
  });
  res.status(201).json({ code: publicCode, expiresAt: expiresAt.toISOString() });
});

router.post("/auth/status", async (req, res): Promise<void> => {
  const { code, clientSecret } = req.body ?? {};
  const session = await findAuthSession(code);
  if (!session || !validClientSecret(clientSecret) || !matchesClientSecret(session.clientSecretHash, clientSecret)) {
    res.status(401).json({ error: "Invalid desktop sign-in request" });
    return;
  }
  if (session.status === "pending" && isExpired(session.expiresAt)) {
    await db.update(desktopAuthSessionsTable)
      .set({ status: "expired" })
      .where(and(eq(desktopAuthSessionsTable.id, session.id), eq(desktopAuthSessionsTable.status, "pending")));
    res.json({ status: "expired" });
    return;
  }
  res.json({ status: session.status });
});

// Approve a pending desktop sign-in from the already authenticated web app.
router.post("/auth/approve", requireAuth, async (req, res): Promise<void> => {
  const session = await findAuthSession(req.body?.code);
  if (!session || session.status !== "pending" || isExpired(session.expiresAt)) {
    res.status(409).json({ error: "This desktop sign-in request has expired. Start again from the Mac app." });
    return;
  }

  const member = await getStudioMember(getUserId(req));
  if (member.status !== "active" || !["owner", "admin", "assistant", "photographer"].includes(member.role)) {
    res.status(403).json({ error: "This account is not allowed to use the desktop app." });
    return;
  }

  const [approved] = await db
    .update(desktopAuthSessionsTable)
    .set({ status: "approved", memberId: member.id, approvedAt: new Date() })
    .where(and(
      eq(desktopAuthSessionsTable.id, session.id),
      eq(desktopAuthSessionsTable.status, "pending"),
      gt(desktopAuthSessionsTable.expiresAt, new Date()),
    ))
    .returning({ id: desktopAuthSessionsTable.id });
  if (!approved) {
    res.status(409).json({ error: "This desktop sign-in request is no longer available." });
    return;
  }
  res.json({ ok: true, member: { email: member.email, role: member.role } });
});

router.post("/auth/exchange", async (req, res): Promise<void> => {
  const { code, clientSecret } = req.body ?? {};
  const session = await findAuthSession(code);
  if (!session || !validClientSecret(clientSecret) || !matchesClientSecret(session.clientSecretHash, clientSecret)) {
    res.status(401).json({ error: "Invalid desktop sign-in request" });
    return;
  }
  if (session.status === "pending") {
    res.status(202).json({ status: "pending" });
    return;
  }
  if (session.status !== "approved" || isExpired(session.expiresAt) || !session.memberId) {
    res.status(409).json({ error: "This desktop sign-in request is no longer available." });
    return;
  }

  const credentials = createDesktopToken();
  const result = await db.transaction(async (tx) => {
    const [claimed] = await tx
      .update(desktopAuthSessionsTable)
      .set({ status: "used", usedAt: new Date() })
      .where(and(
        eq(desktopAuthSessionsTable.id, session.id),
        eq(desktopAuthSessionsTable.status, "approved"),
        gt(desktopAuthSessionsTable.expiresAt, new Date()),
      ))
      .returning({ memberId: desktopAuthSessionsTable.memberId });
    if (!claimed?.memberId) return null;

    const [member] = await tx
      .select()
      .from(studioMembersTable)
      .where(and(eq(studioMembersTable.id, claimed.memberId), eq(studioMembersTable.status, "active")));
    if (!member || !["owner", "admin", "assistant", "photographer"].includes(member.role)) return null;

    const [connection] = await tx.insert(desktopConnectionsTable).values({
      studioId: member.studioId,
      memberId: member.id,
      deviceName: "Volume Capture desktop",
      tokenHash: credentials.tokenHash,
      tokenPrefix: credentials.tokenPrefix,
    }).returning({ id: desktopConnectionsTable.id });
    return { connectionId: connection.id, member };
  });
  if (!result) {
    res.status(409).json({ error: "This desktop sign-in request is no longer available." });
    return;
  }
  res.json({
    token: credentials.token,
    member: { email: result.member.email, role: result.member.role },
  });
});

// Rotate a desktop credential without sending the user through browser sign-in
// again. The old credential stops working as soon as the replacement is issued.
router.post("/auth/refresh", requireDesktopConnection, async (req, res): Promise<void> => {
  const connection = getDesktopConnection(req);
  const credentials = createDesktopToken();
  const [updated] = await db
    .update(desktopConnectionsTable)
    .set({
      tokenHash: credentials.tokenHash,
      tokenPrefix: credentials.tokenPrefix,
      lastUsedAt: new Date(),
    })
    .where(and(
      eq(desktopConnectionsTable.id, connection.connectionId),
      eq(desktopConnectionsTable.status, "active"),
    ))
    .returning({ id: desktopConnectionsTable.id });
  if (!updated) {
    res.status(401).json({ error: "Invalid or revoked desktop connection" });
    return;
  }
  res.json({
    token: credentials.token,
    member: { email: connection.memberEmail, role: connection.memberRole },
  });
});

router.post("/projects/:projectId/capture-batches", requireDesktopConnection, async (req, res): Promise<void> => {
  const projectId = Number(req.params.projectId);
  const batchKey = req.body?.batchKey;
  const expectedFileCount = Number(req.body?.expectedFileCount);
  const connection = getDesktopConnection(req);
  if (!Number.isInteger(projectId) || !validCaptureBatchKey(batchKey) || !Number.isInteger(expectedFileCount) || expectedFileCount < 0) {
    res.status(400).json({ error: "A valid project, batch key, and expected file count are required" });
    return;
  }
  if (!(await canAccessDesktopProject({
    id: connection.memberId,
    studioId: connection.studioId,
    role: connection.memberRole,
    status: "active",
    userId: connection.memberUserId,
  }, projectId))) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const [existing] = await db
    .select()
    .from(captureBatchesTable)
    .where(and(
      eq(captureBatchesTable.projectId, projectId),
      eq(captureBatchesTable.batchKey, batchKey),
    ))
    .limit(1);
  if (existing && existing.desktopConnectionId !== connection.connectionId) {
    res.status(409).json({ error: "Capture batch belongs to another desktop connection" });
    return;
  }
  if (
    existing
    && existing.status === "complete"
    && expectedFileCount <= existing.expectedFileCount
  ) {
    res.status(200).json(existing);
    return;
  }
  const [batch] = existing
    ? await db
      .update(captureBatchesTable)
      .set({
        status: "uploading",
        expectedFileCount: sql`greatest(${captureBatchesTable.expectedFileCount}, ${expectedFileCount})`,
        failedFileCount: 0,
        lastSyncAt: new Date(),
        completedAt: null,
      })
      .where(eq(captureBatchesTable.id, existing.id))
      .returning()
    : await db
      .insert(captureBatchesTable)
      .values({
        batchKey,
        projectId,
        memberId: connection.memberId,
        desktopConnectionId: connection.connectionId,
        status: "uploading",
        expectedFileCount,
        failedFileCount: 0,
        lastSyncAt: new Date(),
        completedAt: null,
      })
      .returning();
  res.status(201).json(batch);
});

router.patch("/projects/:projectId/capture-batches/:batchKey", requireDesktopConnection, async (req, res): Promise<void> => {
  const projectId = Number(req.params.projectId);
  const batchKey = req.params.batchKey;
  const failedFileCount = Number(req.body?.failedFileCount ?? 0);
  const requestedStatus = req.body?.status;
  const connection = getDesktopConnection(req);
  if (!Number.isInteger(projectId) || !validCaptureBatchKey(batchKey) || !Number.isInteger(failedFileCount) || failedFileCount < 0 || !["failed", "complete"].includes(requestedStatus)) {
    res.status(400).json({ error: "Invalid capture batch update" });
    return;
  }
  if (!(await canAccessDesktopProject({
    id: connection.memberId,
    studioId: connection.studioId,
    role: connection.memberRole,
    status: "active",
    userId: connection.memberUserId,
  }, projectId))) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const [batch] = await db
    .select()
    .from(captureBatchesTable)
    .where(and(
      eq(captureBatchesTable.projectId, projectId),
      eq(captureBatchesTable.batchKey, batchKey),
      eq(captureBatchesTable.desktopConnectionId, connection.connectionId),
    ))
    .limit(1);
  if (!batch) {
    res.status(404).json({ error: "Capture batch not found" });
    return;
  }
  const [{ captureFileCount }] = await db
    .select({ captureFileCount: count() })
    .from(captureFilesTable)
    .where(eq(captureFilesTable.captureBatchId, batch.id));
  const [{ legacyPhotoCount }] = await db
    .select({ legacyPhotoCount: count() })
    .from(studentPhotosTable)
    .where(eq(studentPhotosTable.captureBatchId, batch.id));
  const [{ groupCaptureFileCount }] = await db
    .select({ groupCaptureFileCount: count() })
    .from(groupCaptureFilesTable)
    .where(eq(groupCaptureFilesTable.captureBatchId, batch.id));
  const uploadedFileCount = Number(captureFileCount) + Number(legacyPhotoCount) + Number(groupCaptureFileCount);
  const status = requestedStatus === "complete" && failedFileCount === 0 && uploadedFileCount >= batch.expectedFileCount
    ? "complete"
    : "failed";
  const [updated] = await db
    .update(captureBatchesTable)
    .set({
      status,
      uploadedFileCount,
      failedFileCount,
      lastSyncAt: new Date(),
      completedAt: status === "complete" ? new Date() : null,
    })
    .where(eq(captureBatchesTable.id, batch.id))
    .returning();
  res.json(updated);
});

function memberForAccess(connection: ReturnType<typeof getDesktopConnection>) {
  return {
    id: connection.memberId,
    studioId: connection.studioId,
    role: connection.memberRole,
    status: "active" as const,
    userId: connection.memberUserId,
  };
}

router.get("/projects/:projectId/groups", requireDesktopConnection, async (req, res): Promise<void> => {
  const connection = getDesktopConnection(req);
  const projectId = Number(req.params.projectId);
  if (!Number.isSafeInteger(projectId) || projectId <= 0 || !(await canAccessDesktopProject(memberForAccess(connection), projectId))) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  await reconcileDefaultGroups(projectId);
  const groups = await db.select().from(groupsTable).where(eq(groupsTable.projectId, projectId));
  const members = groups.length
    ? await db.select().from(groupMembersTable).where(inArray(groupMembersTable.groupId, groups.map((g) => g.id)))
    : [];
  res.json(groups.map((group) => ({
    ...group,
    memberStudentIds: members.filter((member) => member.groupId === group.id).map((member) => member.studentId),
  })));
});

router.post("/projects/:projectId/groups", requireDesktopConnection, async (req, res): Promise<void> => {
  const connection = getDesktopConnection(req);
  const projectId = Number(req.params.projectId);
  if (!Number.isSafeInteger(projectId) || projectId <= 0 || !(await canAccessDesktopProject(memberForAccess(connection), projectId))) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
  const clientGroupId = typeof req.body?.clientGroupId === "string" ? req.body.clientGroupId.trim() : "";
  const classId = req.body?.classId == null ? null : Number(req.body.classId);
  const memberStudentIds = Array.isArray(req.body?.memberStudentIds) ? req.body.memberStudentIds : [];
  if (classId !== null) {
    const [cls] = await db.select({ id: classesTable.id }).from(classesTable).where(and(eq(classesTable.id, classId), eq(classesTable.projectId, projectId)));
    if (!cls) { res.status(400).json({ error: "Class not found in this project" }); return; }
  }
  if (memberStudentIds.some((id: unknown) => !Number.isInteger(id))) { res.status(400).json({ error: "Invalid memberStudentIds" }); return; }
  const validStudents = await db.select({ id: studentsTable.id }).from(studentsTable).where(and(eq(studentsTable.projectId, projectId), inArray(studentsTable.id, memberStudentIds)));
  if (validStudents.length !== memberStudentIds.length) { res.status(400).json({ error: "Students must belong to this project" }); return; }
  if (!name) {
    res.status(400).json({ error: "name is required" });
    return;
  }
  if (!clientGroupId || clientGroupId.length > 200) { res.status(400).json({ error: "clientGroupId is required" }); return; }
  const result = await db.transaction(async (tx) => {
    const [existing] = await tx.select().from(groupsTable).where(and(eq(groupsTable.projectId, projectId), eq(groupsTable.desktopConnectionId, connection.connectionId), eq(groupsTable.clientGroupId, clientGroupId))).limit(1);
    if (existing) return { group: existing, reused: true };
    const [group] = await tx.insert(groupsTable).values({ projectId, name, classId, isDefaultClassGroup: false, desktopConnectionId: connection.connectionId, clientGroupId }).returning();
    if (memberStudentIds.length) await tx.insert(groupMembersTable).values(memberStudentIds.map((studentId: number) => ({ groupId: group.id, studentId }))).onConflictDoNothing();
    return { group, reused: false };
  });
  if (result.reused) {
    await db.delete(groupMembersTable).where(eq(groupMembersTable.groupId, result.group.id));
    if (memberStudentIds.length) await db.insert(groupMembersTable).values(memberStudentIds.map((studentId: number) => ({ groupId: result.group.id, studentId }))).onConflictDoNothing();
    if (result.group.isDefaultClassGroup) {
      await db.delete(groupMemberExclusionsTable).where(eq(groupMemberExclusionsTable.groupId, result.group.id));
    }
  }
  res.status(result.reused ? 200 : 201).json({ ...result.group, memberStudentIds });
});

router.patch("/projects/:projectId/groups/:groupId", requireDesktopConnection, async (req, res): Promise<void> => {
  const connection = getDesktopConnection(req), projectId = Number(req.params.projectId), groupId = Number(req.params.groupId);
  if (!Number.isSafeInteger(projectId) || projectId <= 0 || !Number.isSafeInteger(groupId) || groupId <= 0 || !(await canAccessDesktopProject(memberForAccess(connection), projectId))) return void res.status(404).json({ error: "Project not found" });
  const [existing] = await db.select().from(groupsTable).where(and(eq(groupsTable.id, groupId), eq(groupsTable.projectId, projectId)));
  if (!existing) return void res.status(404).json({ error: "Group not found" });
  const { name, classId, memberStudentIds } = req.body ?? {};
  if (existing.isDefaultClassGroup && (name !== undefined || classId !== undefined || req.body?.isDefaultClassGroup !== undefined)) return void res.status(409).json({ error: "Default group identity is protected" });
  if (name !== undefined && (typeof name !== "string" || !name.trim())) return void res.status(400).json({ error: "name must be nonempty" });
  if (classId !== undefined && classId !== null) {
    const [cls] = await db.select({ id: classesTable.id }).from(classesTable).where(and(eq(classesTable.id, Number(classId)), eq(classesTable.projectId, projectId)));
    if (!cls) return void res.status(400).json({ error: "Class not found in this project" });
  }
  if (memberStudentIds !== undefined) {
    if (!Array.isArray(memberStudentIds) || memberStudentIds.some((id: unknown) => !Number.isInteger(id))) return void res.status(400).json({ error: "Invalid memberStudentIds" });
    const valid = await db.select({ id: studentsTable.id }).from(studentsTable).where(and(eq(studentsTable.projectId, projectId), inArray(studentsTable.id, memberStudentIds)));
    if (valid.length !== memberStudentIds.length) return void res.status(400).json({ error: "Students must belong to this project" });
     const oldMembers = await db.select({ studentId: groupMembersTable.studentId }).from(groupMembersTable).where(eq(groupMembersTable.groupId, groupId));
     await db.delete(groupMembersTable).where(eq(groupMembersTable.groupId, groupId));
    if (memberStudentIds.length) await db.insert(groupMembersTable).values(memberStudentIds.map((studentId: number) => ({ groupId, studentId }))).onConflictDoNothing();
     if (existing.isDefaultClassGroup) {
       const removed = oldMembers.map((row) => row.studentId).filter((id) => !memberStudentIds.includes(id));
       if (removed.length) await db.insert(groupMemberExclusionsTable).values(removed.map((studentId) => ({ groupId, studentId }))).onConflictDoNothing();
       if (memberStudentIds.length) await db.delete(groupMemberExclusionsTable).where(and(eq(groupMemberExclusionsTable.groupId, groupId), inArray(groupMemberExclusionsTable.studentId, memberStudentIds)));
     }
  }
  const [group] = await db.update(groupsTable).set({ ...(name !== undefined ? { name: name.trim() } : {}), ...(classId !== undefined ? { classId } : {}), updatedAt: new Date() }).where(eq(groupsTable.id, groupId)).returning();
  const currentMembers = await db.select({ studentId: groupMembersTable.studentId }).from(groupMembersTable).where(eq(groupMembersTable.groupId, groupId));
  res.json({ ...group, memberStudentIds: currentMembers.map((member) => member.studentId) });
});

async function desktopProjectIds(connection: ReturnType<typeof getDesktopConnection>) {
  if (await isPlatformOwner(connection.memberUserId)) {
    const rows = await db.select({ id: projectsTable.id }).from(projectsTable);
    return rows.map((row) => row.id);
  }
  return assignedDesktopProjectIds(memberForAccess(connection));
}

async function requireStillActiveBeforeDataResponse(
  connection: ReturnType<typeof getDesktopConnection>,
  res: Response,
): Promise<boolean> {
  if (await refreshDesktopConnection(connection.connectionId)) return true;
  res.status(401).json({ error: "Invalid or retired desktop connection" });
  return false;
}

router.get("/me", requireDesktopConnectionWithRetirement, async (req, res) => {
  const connection = getDesktopConnection(req);
  const projectIds = connection.status === "active"
    ? await desktopProjectIds(connection)
    : [];
  res.json({
    connectionId: connection.connectionId,
    deviceName: connection.deviceName,
    member: {
      id: connection.memberId,
      email: connection.memberEmail,
      role: connection.memberRole,
    },
    projectCount: projectIds.length,
    retirement: connection.status === "retired"
      ? {
        retiredAt: connection.retiredAt instanceof Date ? connection.retiredAt.toISOString() : connection.retiredAt,
        acknowledgedAt: connection.retirementAcknowledgedAt instanceof Date
          ? connection.retirementAcknowledgedAt.toISOString()
          : connection.retirementAcknowledgedAt,
      }
      : null,
  });
});

router.post("/retirement/acknowledge", requireDesktopConnectionWithRetirement, async (req, res): Promise<void> => {
  const connection = getDesktopConnection(req);
  if (connection.status !== "retired") {
    res.status(409).json({ error: "This desktop connection is not retired" });
    return;
  }

  const acknowledgedAt = connection.retirementAcknowledgedAt ?? new Date();
  const [updated] = await db
    .update(desktopConnectionsTable)
    .set({ retirementAcknowledgedAt: acknowledgedAt })
    .where(and(
      eq(desktopConnectionsTable.id, connection.connectionId),
      eq(desktopConnectionsTable.status, "retired"),
    ))
    .returning({ retirementAcknowledgedAt: desktopConnectionsTable.retirementAcknowledgedAt });
  if (!updated?.retirementAcknowledgedAt) {
    res.status(409).json({ error: "This desktop retirement could not be acknowledged" });
    return;
  }
  res.json({
    ok: true,
    acknowledgedAt: updated.retirementAcknowledgedAt instanceof Date
      ? updated.retirementAcknowledgedAt.toISOString()
      : updated.retirementAcknowledgedAt,
  });
});

// GET /api/desktop/projects — list only projects assigned to this connection
router.get("/projects", requireDesktopConnection, async (req, res) => {
  const connection = getDesktopConnection(req);
  const projectIds = await desktopProjectIds(connection);
  if (!projectIds.length) {
    if (!(await requireStillActiveBeforeDataResponse(connection, res))) return;
    res.json([]);
    return;
  }
  const projects = await db
    .select({
      id: projectsTable.id,
      projectType: projectsTable.projectType,
      schoolName: projectsTable.schoolName,
      photoDate: projectsTable.photoDate,
      address: projectsTable.address,
      contactName: projectsTable.contactName,
      createdAt: projectsTable.createdAt,
      updatedAt: projectsTable.updatedAt,
    })
    .from(projectsTable)
    .where(inArray(projectsTable.id, projectIds))
    .orderBy(projectsTable.updatedAt);

  // Add class + student counts
  const enriched = await Promise.all(
    projects.map(async (p) => {
      const classes = await db
        .select({ id: classesTable.id })
        .from(classesTable)
        .where(eq(classesTable.projectId, p.id));

      const students = await db
        .select({ id: studentsTable.id })
        .from(studentsTable)
        .where(eq(studentsTable.projectId, p.id));

      return {
        ...p,
        classCount: classes.length,
        studentCount: students.length,
        createdAt: p.createdAt instanceof Date ? p.createdAt.toISOString() : p.createdAt,
        updatedAt: p.updatedAt instanceof Date ? p.updatedAt.toISOString() : p.updatedAt,
      };
    }),
  );

  if (!(await requireStillActiveBeforeDataResponse(connection, res))) return;
  res.json(enriched);
});

// GET /api/desktop/projects/:projectId/bundle — full export bundle for import
router.get("/projects/:projectId/bundle", requireDesktopConnection, async (req, res) => {
  const connection = getDesktopConnection(req);
  const rawProjectId = Array.isArray(req.params.projectId) ? req.params.projectId[0] : req.params.projectId;
  const projectId = parseInt(rawProjectId, 10);
  if (isNaN(projectId)) {
    res.status(400).json({ error: "Invalid project ID" });
    return;
  }

  if (!(await canAccessDesktopProject(memberForAccess(connection), projectId))) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const [project] = await db
    .select()
    .from(projectsTable)
    .where(eq(projectsTable.id, projectId));

  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const classes = await db
    .select()
    .from(classesTable)
    .where(eq(classesTable.projectId, projectId))
    .orderBy(classesTable.className);

  const students = await db
    .select({
      student: studentsTable,
      className: classesTable.className,
    })
    .from(studentsTable)
    .leftJoin(classesTable, eq(studentsTable.classId, classesTable.id))
    .where(eq(studentsTable.projectId, projectId))
    .orderBy(classesTable.className, studentsTable.lastName, studentsTable.firstName);
  await reconcileDefaultGroups(projectId);
  const groups = await db.select().from(groupsTable).where(eq(groupsTable.projectId, projectId));
  const groupMembers = groups.length
    ? await db.select().from(groupMembersTable).where(inArray(groupMembersTable.groupId, groups.map((g) => g.id)))
    : [];

  if (!(await requireStillActiveBeforeDataResponse(connection, res))) return;
  res.json({
    exportedAt: new Date().toISOString(),
    exportVersion: 1,
    project: {
      id: project.id,
      projectType: project.projectType,
      schoolName: project.schoolName,
      photoDate: project.photoDate,
      address: project.address,
      contactName: project.contactName,
      contactEmail: project.contactEmail,
      contactPhone: project.contactPhone,
      notes: project.notes,
      createdAt: project.createdAt instanceof Date ? project.createdAt.toISOString() : project.createdAt,
      updatedAt: project.updatedAt instanceof Date ? project.updatedAt.toISOString() : project.updatedAt,
    },
    classes: classes.map((c) => ({
      id: c.id,
      className: c.className,
      createdAt: c.createdAt instanceof Date ? c.createdAt.toISOString() : c.createdAt,
      updatedAt: c.updatedAt instanceof Date ? c.updatedAt.toISOString() : c.updatedAt,
    })),
    students: students.map(({ student: s, className }) => ({
      id: s.id,
      classId: s.classId,
      className,
      firstName: s.firstName,
      lastName: s.lastName,
      generatedStudentId: s.generatedStudentId,
      email: s.email ?? null,
      phone: s.phone ?? null,
      simpleQr: s.simpleQr,
      jsonQr: s.jsonQr,
      createdAt: s.createdAt instanceof Date ? s.createdAt.toISOString() : s.createdAt,
      updatedAt: s.updatedAt instanceof Date ? s.updatedAt.toISOString() : s.updatedAt,
    })),
    groups: groups.map((g) => ({
      id: g.id,
      projectId: g.projectId,
      classId: g.classId,
      name: g.name,
      isDefaultClassGroup: g.isDefaultClassGroup,
      createdAt: g.createdAt.toISOString(),
      updatedAt: g.updatedAt.toISOString(),
      memberStudentIds: groupMembers.filter((m) => m.groupId === g.id).map((m) => m.studentId),
    })),
  });
});

// POST /api/desktop/projects/:projectId/students — add a late/new student
// from the capture workstation. The generated student ID is supplied by the
// desktop so an offline-created record can be reconciled idempotently later.
router.post("/projects/:projectId/students", requireDesktopConnection, async (req, res) => {
  const connection = getDesktopConnection(req);
  const rawProjectId = Array.isArray(req.params.projectId) ? req.params.projectId[0] : req.params.projectId;
  const projectId = parseInt(rawProjectId, 10);
  const classId = Number(req.body?.classId);
  const firstName = typeof req.body?.firstName === "string" ? req.body.firstName.trim() : "";
  const lastName = typeof req.body?.lastName === "string" ? req.body.lastName.trim() : "";
  const generatedStudentId = typeof req.body?.generatedStudentId === "string"
    ? req.body.generatedStudentId.trim().toUpperCase()
    : "";

  if (
    !Number.isInteger(projectId)
    || !Number.isInteger(classId)
    || !firstName
    || !lastName
    || firstName.length > 100
    || lastName.length > 100
    || !/^[A-Z0-9]{7}$/.test(generatedStudentId)
  ) {
    res.status(400).json({ error: "A class, first name, last name, and valid student code are required." });
    return;
  }

  if (!(await canAccessDesktopProject(memberForAccess(connection), projectId))) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const [project] = await db.select().from(projectsTable).where(eq(projectsTable.id, projectId));
  const [cls] = await db
    .select()
    .from(classesTable)
    .where(and(eq(classesTable.id, classId), eq(classesTable.projectId, projectId)));
  if (!project || !cls) {
    res.status(400).json({ error: "Class not found in this project." });
    return;
  }

  const [existing] = await db
    .select()
    .from(studentsTable)
    .where(and(
      eq(studentsTable.projectId, projectId),
      eq(studentsTable.generatedStudentId, generatedStudentId),
    ));
  if (existing) {
    res.json({
      id: existing.id,
      classId: existing.classId,
      className: cls.className,
      firstName: existing.firstName,
      lastName: existing.lastName,
      generatedStudentId: existing.generatedStudentId,
      simpleQr: existing.simpleQr,
      jsonQr: existing.jsonQr,
    });
    return;
  }

  const [simpleQr, jsonQr] = await Promise.all([
    generateSimpleQr(firstName, lastName, generatedStudentId),
    generateJsonQr(project.schoolName, cls.className, firstName, lastName, generatedStudentId),
  ]);
  const [student] = await db
    .insert(studentsTable)
    .values({
      projectId,
      classId,
      firstName,
      lastName,
      generatedStudentId,
      simpleQr,
      jsonQr,
    })
    .returning();
  await reconcileDefaultGroups(projectId);

  res.status(201).json({
    id: student.id,
    classId: student.classId,
    className: cls.className,
    firstName: student.firstName,
    lastName: student.lastName,
    generatedStudentId: student.generatedStudentId,
    simpleQr: student.simpleQr,
    jsonQr: student.jsonQr,
  });
});

export default router;
