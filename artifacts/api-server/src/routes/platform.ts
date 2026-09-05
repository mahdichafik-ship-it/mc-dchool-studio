import { randomBytes } from "node:crypto";
import { Router } from "express";
import { and, asc, count, desc, eq, inArray } from "drizzle-orm";
import {
  db,
  classesTable,
  desktopConnectionsTable,
  platformActionAuditTable,
  platformInvitesTable,
  projectsTable,
  studentsTable,
  studioMembersTable,
  studioStorageAuditTable,
  studioStorageConnectionsTable,
  studiosTable,
} from "@workspace/db";
import { getUserId, requireAuth } from "../lib/auth";
import { getUserEmail } from "../lib/studioAccess";
import { platformOwnerIsConfigured, requirePlatformOwner } from "../lib/platformAccess";

const router = Router();
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function recordPlatformAction(
  actorUserId: string,
  studioId: number,
  action: string,
  targetType: string,
  targetId?: string | number | null,
  detail?: string | null,
) {
  await db.insert(platformActionAuditTable).values({
    actorUserId,
    studioId,
    action,
    targetType,
    targetId: targetId == null ? null : String(targetId),
    detail: detail?.slice(0, 500) || null,
  });
}

function studioIdParam(value: string | string[] | undefined): number | null {
  const id = Number(Array.isArray(value) ? value[0] : value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function inviteCode() {
  return randomBytes(32).toString("base64url");
}

function parseStudioUpdate(body: unknown): {
  description?: string | null;
  website?: string | null;
  contactEmail?: string | null;
} | { error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: "Studio details must be an object" };
  }

  const input = body as Record<string, unknown>;
  const result: {
    description?: string | null;
    website?: string | null;
    contactEmail?: string | null;
  } = {};

  for (const [field, maxLength] of [["description", 500], ["website", 200], ["contactEmail", 254]] as const) {
    if (!(field in input)) continue;
    const value = input[field];
    if (value !== null && typeof value !== "string") {
      return { error: `${field} must be a string or null` };
    }
    const trimmed = typeof value === "string" ? value.trim() : null;
    if (trimmed !== null && trimmed.length > maxLength) {
      return { error: `${field} must be ${maxLength} characters or fewer` };
    }
    result[field] = trimmed || null;
  }

  if (result.contactEmail && !emailPattern.test(result.contactEmail)) {
    return { error: "Contact email must be a valid email address" };
  }
  if (result.website) {
    try {
      const url = new URL(result.website);
      if (!["http:", "https:"].includes(url.protocol)) throw new Error("unsupported protocol");
    } catch {
      return { error: "Website must be a valid http(s) URL" };
    }
  }

  return result;
}

router.get("/", requireAuth, requirePlatformOwner, async (_req, res): Promise<void> => {
  const [studios, members, projectCounts, projectRows, invites, desktopConnections] = await Promise.all([
    db.select().from(studiosTable).orderBy(asc(studiosTable.createdAt)),
    db.select().from(studioMembersTable).where(eq(studioMembersTable.status, "active")),
    db.select({ studioId: projectsTable.studioId, count: count() }).from(projectsTable).groupBy(projectsTable.studioId),
    db.select({
      id: projectsTable.id,
      studioId: projectsTable.studioId,
      studioName: studiosTable.name,
      schoolName: projectsTable.schoolName,
      photoDate: projectsTable.photoDate,
      address: projectsTable.address,
      contactName: projectsTable.contactName,
      contactEmail: projectsTable.contactEmail,
      contactPhone: projectsTable.contactPhone,
      notes: projectsTable.notes,
      createdAt: projectsTable.createdAt,
      updatedAt: projectsTable.updatedAt,
    })
      .from(projectsTable)
      .leftJoin(studiosTable, eq(projectsTable.studioId, studiosTable.id))
      .orderBy(desc(projectsTable.updatedAt)),
    db.select().from(platformInvitesTable).orderBy(asc(platformInvitesTable.createdAt)),
    db.select({
      studioId: desktopConnectionsTable.studioId,
      status: desktopConnectionsTable.status,
      expiresAt: desktopConnectionsTable.expiresAt,
    }).from(desktopConnectionsTable),
  ]);

  const ownerByStudio = new Map(
    members
      .filter((member) => member.role === "owner")
      .map((member) => [member.studioId, member]),
  );
  const projectCountByStudio = new Map(projectCounts.map((row) => [row.studioId, Number(row.count)]));
  const desktopByStudio = new Map<number, typeof desktopConnections>();
  for (const connection of desktopConnections) {
    const connections = desktopByStudio.get(connection.studioId) ?? [];
    connections.push(connection);
    desktopByStudio.set(connection.studioId, connections);
  }
  const now = new Date();
  const healthByStudio = new Map<number, {
    severity: "healthy" | "attention" | "critical";
    alerts: Array<{ code: string; label: string; severity: "info" | "attention" | "critical" }>;
    activeMemberCount: number;
    activeDesktopCount: number;
    expiredDesktopCount: number;
  }>();

  for (const studio of studios) {
    const studioMembers = members.filter((member) => member.studioId === studio.id);
    const connections = desktopByStudio.get(studio.id) ?? [];
    const activeDesktops = connections.filter((connection) => connection.status === "active");
    const expiredDesktops = activeDesktops.filter((connection) => connection.expiresAt && connection.expiresAt <= now);
    const alerts: Array<{ code: string; label: string; severity: "info" | "attention" | "critical" }> = [];

    if (studio.archivedAt) {
      alerts.push({ code: "archived", label: "Studio is archived", severity: "info" });
    }
    if (!studioMembers.some((member) => member.role === "owner")) {
      alerts.push({ code: "owner_missing", label: "No active studio owner", severity: "critical" });
    }
    if (studioMembers.length === 0) {
      alerts.push({ code: "members_missing", label: "No active members", severity: "critical" });
    }
    if (studio.storageStatus === "connection_error") {
      alerts.push({ code: "storage_error", label: "Storage connection has an error", severity: "critical" });
    } else if (studio.storageStatus === "needs_setup") {
      alerts.push({ code: "storage_setup", label: "Studio storage is not configured", severity: "attention" });
    } else if (studio.storageStatus === "connection_requested") {
      alerts.push({ code: "storage_pending", label: "Storage connection is pending", severity: "attention" });
    } else if (studio.storageStatus === "using_platform") {
      alerts.push({ code: "platform_storage", label: "Using platform storage fallback", severity: "attention" });
    }
    if (expiredDesktops.length > 0) {
      alerts.push({
        code: "desktop_expired",
        label: `${expiredDesktops.length} desktop connection${expiredDesktops.length === 1 ? "" : "s"} expired`,
        severity: "attention",
      });
    }
    if ((projectCountByStudio.get(studio.id) ?? 0) === 0) {
      alerts.push({ code: "no_projects", label: "No school projects yet", severity: "info" });
    }

    const severity = alerts.some((alert) => alert.severity === "critical")
      ? "critical"
      : alerts.some((alert) => alert.severity === "attention")
        ? "attention"
        : "healthy";
    healthByStudio.set(studio.id, {
      severity,
      alerts,
      activeMemberCount: studioMembers.length,
      activeDesktopCount: activeDesktops.length,
      expiredDesktopCount: expiredDesktops.length,
    });
  }
  const projects = await Promise.all(
    projectRows.map(async (project) => {
      const [{ classCount }] = await db
        .select({ classCount: count() })
        .from(classesTable)
        .where(eq(classesTable.projectId, project.id));
      const [{ studentCount }] = await db
        .select({ studentCount: count() })
        .from(studentsTable)
        .where(eq(studentsTable.projectId, project.id));
      return {
        ...project,
        classCount,
        studentCount,
        createdAt: project.createdAt.toISOString(),
        updatedAt: project.updatedAt.toISOString(),
      };
    }),
  );

  res.json({
    configured: platformOwnerIsConfigured(),
    healthSummary: {
      totalStudios: studios.length,
      healthyStudios: studios.filter((studio) => healthByStudio.get(studio.id)?.severity === "healthy").length,
      attentionStudios: studios.filter((studio) => healthByStudio.get(studio.id)?.severity === "attention").length,
      criticalStudios: studios.filter((studio) => healthByStudio.get(studio.id)?.severity === "critical").length,
      archivedStudios: studios.filter((studio) => Boolean(studio.archivedAt)).length,
    },
    studios: studios.map((studio) => ({
      ...studio,
      memberCount: members.filter((member) => member.studioId === studio.id).length,
      projectCount: projectCountByStudio.get(studio.id) ?? 0,
      health: healthByStudio.get(studio.id),
      owner: ownerByStudio.get(studio.id)
        ? {
          userId: ownerByStudio.get(studio.id)!.userId,
          email: ownerByStudio.get(studio.id)!.email,
          displayName: ownerByStudio.get(studio.id)!.displayName,
        }
        : null,
    })),
    projects,
    invites,
  });
});

router.get("/studios/:studioId", requireAuth, requirePlatformOwner, async (req, res): Promise<void> => {
  const studioId = studioIdParam(req.params.studioId);
  if (!studioId) {
    res.status(400).json({ error: "A valid studio ID is required" });
    return;
  }
  const [studio] = await db.select().from(studiosTable).where(eq(studiosTable.id, studioId)).limit(1);
  if (!studio) {
    res.status(404).json({ error: "Studio not found" });
    return;
  }
  const [members, projects, desktopConnections, storageConnections, storageAudit, platformAudit] = await Promise.all([
    db.select().from(studioMembersTable).where(eq(studioMembersTable.studioId, studioId)).orderBy(asc(studioMembersTable.createdAt)),
    db.select().from(projectsTable).where(eq(projectsTable.studioId, studioId)).orderBy(desc(projectsTable.updatedAt)),
    db.select({
      id: desktopConnectionsTable.id,
      memberId: desktopConnectionsTable.memberId,
      memberEmail: studioMembersTable.email,
      deviceName: desktopConnectionsTable.deviceName,
      tokenPrefix: desktopConnectionsTable.tokenPrefix,
      status: desktopConnectionsTable.status,
      lastUsedAt: desktopConnectionsTable.lastUsedAt,
      expiresAt: desktopConnectionsTable.expiresAt,
      createdAt: desktopConnectionsTable.createdAt,
      revokedAt: desktopConnectionsTable.revokedAt,
      retiredAt: desktopConnectionsTable.retiredAt,
      retirementAcknowledgedAt: desktopConnectionsTable.retirementAcknowledgedAt,
    }).from(desktopConnectionsTable)
      .innerJoin(studioMembersTable, eq(desktopConnectionsTable.memberId, studioMembersTable.id))
      .where(eq(desktopConnectionsTable.studioId, studioId))
      .orderBy(desc(desktopConnectionsTable.createdAt)),
    db.select({
      id: studioStorageConnectionsTable.id,
      provider: studioStorageConnectionsTable.provider,
      providerAccountEmail: studioStorageConnectionsTable.providerAccountEmail,
      status: studioStorageConnectionsTable.status,
      lastVerifiedAt: studioStorageConnectionsTable.lastVerifiedAt,
      createdAt: studioStorageConnectionsTable.createdAt,
      updatedAt: studioStorageConnectionsTable.updatedAt,
      disconnectedAt: studioStorageConnectionsTable.disconnectedAt,
    }).from(studioStorageConnectionsTable)
      .where(eq(studioStorageConnectionsTable.studioId, studioId))
      .orderBy(desc(studioStorageConnectionsTable.updatedAt)),
    db.select().from(studioStorageAuditTable)
      .where(eq(studioStorageAuditTable.studioId, studioId))
      .orderBy(desc(studioStorageAuditTable.createdAt))
      .limit(100),
    db.select().from(platformActionAuditTable)
      .where(eq(platformActionAuditTable.studioId, studioId))
      .orderBy(desc(platformActionAuditTable.createdAt))
      .limit(100),
  ]);
  res.json({ studio, members, projects, desktopConnections, storageConnections, storageAudit, platformAudit });
});

router.patch("/studios/:studioId/lifecycle", requireAuth, requirePlatformOwner, async (req, res): Promise<void> => {
  const studioId = studioIdParam(req.params.studioId);
  const action = String(req.body?.action ?? "");
  const reason = String(req.body?.reason ?? "").trim();
  if (!studioId || !["archive", "restore"].includes(action)) {
    res.status(400).json({ error: "A valid studio and lifecycle action are required" });
    return;
  }
  const actorUserId = getUserId(req);
  const now = new Date();
  const [updated] = await db.update(studiosTable).set(action === "archive"
    ? { archivedAt: now, archivedByUserId: actorUserId, archiveReason: reason.slice(0, 500) || null }
    : { archivedAt: null, archivedByUserId: null, archiveReason: null })
    .where(eq(studiosTable.id, studioId))
    .returning();
  if (!updated) {
    res.status(404).json({ error: "Studio not found" });
    return;
  }
  if (action === "archive") {
    await db.update(desktopConnectionsTable)
      .set({ status: "revoked", revokedAt: now })
      .where(and(eq(desktopConnectionsTable.studioId, studioId), inArray(desktopConnectionsTable.status, ["active", "retired"])));
  }
  await recordPlatformAction(actorUserId, studioId, `studio_${action}d`, "studio", studioId, reason);
  res.json(updated);
});

router.patch("/studios/:studioId/members/:memberId/access", requireAuth, requirePlatformOwner, async (req, res): Promise<void> => {
  const studioId = studioIdParam(req.params.studioId);
  const memberId = studioIdParam(req.params.memberId);
  const status = String(req.body?.status ?? "");
  if (!studioId || !memberId || !["active", "removed"].includes(status)) {
    res.status(400).json({ error: "A valid member access status is required" });
    return;
  }
  const [updated] = await db.update(studioMembersTable)
    .set({ status: status as "active" | "removed" })
    .where(and(eq(studioMembersTable.id, memberId), eq(studioMembersTable.studioId, studioId)))
    .returning();
  if (!updated) {
    res.status(404).json({ error: "Studio member not found" });
    return;
  }
  if (status === "removed") {
    await db.update(desktopConnectionsTable)
      .set({ status: "revoked", revokedAt: new Date() })
      .where(and(eq(desktopConnectionsTable.studioId, studioId), eq(desktopConnectionsTable.memberId, memberId), inArray(desktopConnectionsTable.status, ["active", "retired"])));
  }
  await recordPlatformAction(getUserId(req), studioId, status === "active" ? "member_reactivated" : "member_suspended", "studio_member", memberId);
  res.json(updated);
});

router.patch("/studios/:studioId/desktop-connections/:connectionId", requireAuth, requirePlatformOwner, async (req, res): Promise<void> => {
  const studioId = studioIdParam(req.params.studioId);
  const connectionId = studioIdParam(req.params.connectionId);
  const action = String(req.body?.action ?? "");
  if (!studioId || !connectionId || !["revoke", "retire", "set_expiry"].includes(action)) {
    res.status(400).json({ error: "A valid desktop connection action is required" });
    return;
  }
  let update: Record<string, unknown>;
  if (action === "revoke") update = { status: "revoked", revokedAt: new Date() };
  else if (action === "retire") update = { status: "retired", retiredAt: new Date(), retirementAcknowledgedAt: null };
  else {
    const days = Number(req.body?.days);
    if (!Number.isInteger(days) || days < 1 || days > 365) {
      res.status(400).json({ error: "Desktop access duration must be between 1 and 365 days" });
      return;
    }
    update = { expiresAt: new Date(Date.now() + days * 24 * 60 * 60 * 1000) };
  }
  const [updated] = await db.update(desktopConnectionsTable).set(update)
    .where(and(eq(desktopConnectionsTable.id, connectionId), eq(desktopConnectionsTable.studioId, studioId)))
    .returning();
  if (!updated) {
    res.status(404).json({ error: "Desktop connection not found" });
    return;
  }
  await recordPlatformAction(getUserId(req), studioId, `desktop_${action}`, "desktop_connection", connectionId, action === "set_expiry" ? `${req.body.days} days` : null);
  res.json(updated);
});

router.delete("/studios/:studioId/storage-connections/:connectionId", requireAuth, requirePlatformOwner, async (req, res): Promise<void> => {
  const studioId = studioIdParam(req.params.studioId);
  const connectionId = studioIdParam(req.params.connectionId);
  if (!studioId || !connectionId) {
    res.status(400).json({ error: "A valid storage connection is required" });
    return;
  }
  const now = new Date();
  const [updated] = await db.update(studioStorageConnectionsTable).set({
    encryptedCredentials: null,
    status: "revoked",
    disconnectedAt: now,
    updatedAt: now,
  }).where(and(eq(studioStorageConnectionsTable.id, connectionId), eq(studioStorageConnectionsTable.studioId, studioId)))
    .returning();
  if (!updated) {
    res.status(404).json({ error: "Storage connection not found" });
    return;
  }
  await db.update(studiosTable).set({
    storageProvider: "platform_google_drive",
    storageStatus: "using_platform",
    storageConnectedAt: null,
    storageRequestedAt: null,
  }).where(eq(studiosTable.id, studioId));
  await db.insert(studioStorageAuditTable).values({
    studioId,
    action: "disconnected",
    provider: updated.provider,
    providerAccountId: updated.providerAccountId,
    providerAccountEmail: updated.providerAccountEmail,
    detail: "Revoked by platform owner",
  });
  await recordPlatformAction(getUserId(req), studioId, "storage_revoked", "storage_connection", connectionId, updated.provider);
  res.status(204).send();
});

router.patch("/studios/:studioId", requireAuth, requirePlatformOwner, async (req, res): Promise<void> => {
  const studioId = Number(req.params.studioId);
  if (!Number.isInteger(studioId) || studioId < 1) {
    res.status(400).json({ error: "A valid studio ID is required" });
    return;
  }

  const update = parseStudioUpdate(req.body);
  if ("error" in update) {
    res.status(400).json({ error: update.error });
    return;
  }
  if (Object.keys(update).length === 0) {
    res.status(400).json({ error: "At least one studio detail is required" });
    return;
  }

  const [updated] = await db
    .update(studiosTable)
    .set(update)
    .where(eq(studiosTable.id, studioId))
    .returning();
  if (!updated) {
    res.status(404).json({ error: "Studio not found" });
    return;
  }
  await recordPlatformAction(getUserId(req), studioId, "studio_details_updated", "studio", studioId);
  res.json(updated);
});

router.post("/invites", requireAuth, requirePlatformOwner, async (req, res): Promise<void> => {
  const email = String(req.body?.email ?? "").trim().toLowerCase();
  if (!emailPattern.test(email)) {
    res.status(400).json({ error: "A valid email address is required" });
    return;
  }

  const [existing] = await db
    .select()
    .from(platformInvitesTable)
    .where(and(eq(platformInvitesTable.email, email), eq(platformInvitesTable.status, "pending")))
    .limit(1);
  if (existing) {
    res.status(409).json({ error: "A pending studio-owner invitation already exists for this email" });
    return;
  }

  const [invite] = await db
    .insert(platformInvitesTable)
    .values({
      email,
      code: inviteCode(),
      invitedByUserId: getUserId(req),
    })
    .returning();
  res.status(201).json(invite);
});

router.patch("/invites/:inviteId", requireAuth, requirePlatformOwner, async (req, res): Promise<void> => {
  const inviteId = Number(req.params.inviteId);
  if (!Number.isInteger(inviteId)) {
    res.status(400).json({ error: "Invalid invitation" });
    return;
  }
  const [updated] = await db
    .update(platformInvitesTable)
    .set({ status: "cancelled" })
    .where(and(eq(platformInvitesTable.id, inviteId), eq(platformInvitesTable.status, "pending")))
    .returning();
  if (!updated) {
    res.status(404).json({ error: "Pending invitation not found" });
    return;
  }
  res.json(updated);
});

router.get("/invites/:code", async (req, res): Promise<void> => {
  const code = String(req.params.code ?? "");
  const [invite] = await db
    .select({
      email: platformInvitesTable.email,
      status: platformInvitesTable.status,
      createdAt: platformInvitesTable.createdAt,
    })
    .from(platformInvitesTable)
    .where(eq(platformInvitesTable.code, code))
    .limit(1);
  if (!invite) {
    res.status(404).json({ error: "Invitation not found" });
    return;
  }
  res.json(invite);
});

router.post("/invites/:code/complete", requireAuth, async (req, res): Promise<void> => {
  const code = String(req.params.code ?? "");
  const [invite] = await db.select().from(platformInvitesTable).where(eq(platformInvitesTable.code, code)).limit(1);
  if (!invite) {
    res.status(404).json({ error: "Invitation not found" });
    return;
  }
  if (invite.status !== "pending") {
    res.status(409).json({ error: `This invitation is already ${invite.status}` });
    return;
  }

  const userId = getUserId(req);
  const email = (await getUserEmail(userId)).toLowerCase();
  if (email !== invite.email) {
    res.status(403).json({ error: "Sign in with the invited email address to continue" });
    return;
  }

  const name = String(req.body?.name ?? "").trim();
  const description = String(req.body?.description ?? "").trim();
  const website = String(req.body?.website ?? "").trim();
  if (name.length < 2 || name.length > 120) {
    res.status(400).json({ error: "Studio name must be between 2 and 120 characters" });
    return;
  }
  if (description.length > 500 || website.length > 200) {
    res.status(400).json({ error: "Studio details are too long" });
    return;
  }

  const result = await db.transaction(async (tx) => {
    const [existingMember] = await tx
      .select()
      .from(studioMembersTable)
      .where(and(eq(studioMembersTable.userId, userId), eq(studioMembersTable.status, "active")))
      .limit(1);

    let studio;
    if (existingMember) {
      const [existingStudio] = await tx.select().from(studiosTable).where(eq(studiosTable.id, existingMember.studioId)).limit(1);
      if (
        existingMember.role !== "owner" ||
        !existingStudio ||
        existingStudio.createdByUserId !== userId
      ) {
        return { error: "This account already belongs to another studio" as const };
      }
      [studio] = await tx
        .update(studiosTable)
        .set({
          name,
          description: description || null,
          website: website || null,
          contactEmail: email,
        })
        .where(eq(studiosTable.id, existingMember.studioId))
        .returning();
    } else {
      [studio] = await tx
        .insert(studiosTable)
        .values({
          name,
          description: description || null,
          website: website || null,
          contactEmail: email,
          createdByUserId: userId,
        })
        .returning();
      await tx.insert(studioMembersTable).values({
        studioId: studio.id,
        userId,
        email,
        role: "owner",
      });
    }

    await tx
      .update(platformInvitesTable)
      .set({
        status: "accepted",
        acceptedByUserId: userId,
        acceptedAt: new Date(),
      })
      .where(and(eq(platformInvitesTable.id, invite.id), eq(platformInvitesTable.status, "pending")));
    return { studio };
  });

  if ("error" in result) {
    res.status(409).json({ error: result.error });
    return;
  }
  res.status(201).json(result.studio);
});

export default router;