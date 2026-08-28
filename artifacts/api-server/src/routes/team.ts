import { Router } from "express";
import { and, eq, inArray } from "drizzle-orm";
import { db, desktopConnectionsTable, projectAssignmentsTable, projectsTable, studioInvitesTable, studioMembersTable } from "@workspace/db";
import { getUserId, requireAuth } from "../lib/auth";
import { accessibleProjectIdsForMember, getStudioMember, isStudioManager } from "../lib/studioAccess";
import { createDesktopToken } from "../lib/desktopAuth";

const router = Router();
const roles = ["admin", "assistant", "photographer", "viewer"] as const;

router.get("/", requireAuth, async (req, res): Promise<void> => {
  const member = await getStudioMember(getUserId(req));
  if (member.status !== "active") { res.status(403).json({ error: "Your studio membership has been removed" }); return; }
  const canManage = member.role === "owner" || member.role === "admin";
  const members = await db.select().from(studioMembersTable).where(eq(studioMembersTable.studioId, member.studioId));
  const invites = canManage
    ? await db.select().from(studioInvitesTable).where(eq(studioInvitesTable.studioId, member.studioId))
    : [];
  const projectIds = canManage ? null : await accessibleProjectIdsForMember(member);
  const projects = canManage
    ? await db.select({ id: projectsTable.id, schoolName: projectsTable.schoolName }).from(projectsTable).where(eq(projectsTable.studioId, member.studioId))
    : projectIds!.length
      ? await db.select({ id: projectsTable.id, schoolName: projectsTable.schoolName }).from(projectsTable).where(and(eq(projectsTable.studioId, member.studioId), inArray(projectsTable.id, projectIds!)))
      : [];
  const assignments = canManage ? await db.select().from(projectAssignmentsTable) : [];
  const desktopConnections = canManage
    ? await db
      .select({
        id: desktopConnectionsTable.id,
        deviceName: desktopConnectionsTable.deviceName,
        tokenPrefix: desktopConnectionsTable.tokenPrefix,
        status: desktopConnectionsTable.status,
        lastUsedAt: desktopConnectionsTable.lastUsedAt,
        createdAt: desktopConnectionsTable.createdAt,
        revokedAt: desktopConnectionsTable.revokedAt,
        memberId: desktopConnectionsTable.memberId,
        memberEmail: studioMembersTable.email,
      })
      .from(desktopConnectionsTable)
      .innerJoin(studioMembersTable, eq(desktopConnectionsTable.memberId, studioMembersTable.id))
      .where(eq(desktopConnectionsTable.studioId, member.studioId))
    : [];
  res.json({
    currentMember: member,
    members,
    invites,
    projects,
    assignments: assignments.filter((item) => projects.some((project) => project.id === item.projectId)),
    desktopConnections,
  });
});

router.post("/invites", requireAuth, async (req, res): Promise<void> => {
  const userId = getUserId(req);
  if (!(await isStudioManager(userId))) { res.status(403).json({ error: "Only owners and admins can invite members" }); return; }
  const member = await getStudioMember(userId);
  const email = String(req.body?.email ?? "").trim().toLowerCase();
  const role = String(req.body?.role ?? "photographer");
  if (!email || !roles.includes(role as typeof roles[number])) { res.status(400).json({ error: "A valid email and role are required" }); return; }
  const [invite] = await db.insert(studioInvitesTable).values({ studioId: member.studioId, email, role: role as typeof roles[number], code: crypto.randomUUID().replaceAll("-", "") }).returning();
  res.status(201).json(invite);
});

router.patch("/members/:memberId", requireAuth, async (req, res): Promise<void> => {
  const userId = getUserId(req);
  if (!(await isStudioManager(userId))) { res.status(403).json({ error: "Only owners and admins can manage members" }); return; }
  const current = await getStudioMember(userId);
  const memberId = Number(req.params.memberId);
  const role = String(req.body?.role ?? "");
  if (!roles.includes(role as typeof roles[number])) { res.status(400).json({ error: "Invalid role" }); return; }
  const [updated] = await db.update(studioMembersTable).set({ role: role as typeof roles[number] }).where(and(eq(studioMembersTable.id, memberId), eq(studioMembersTable.studioId, current.studioId))).returning();
  if (!updated) { res.status(404).json({ error: "Member not found" }); return; }
  res.json(updated);
});

router.delete("/members/:memberId", requireAuth, async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const current = await getStudioMember(userId);
  if (current.status !== "active" || current.role !== "owner") { res.status(403).json({ error: "Only the owner can remove members" }); return; }
  const memberId = Number(req.params.memberId);
  const [target] = await db.select().from(studioMembersTable).where(and(eq(studioMembersTable.id, memberId), eq(studioMembersTable.studioId, current.studioId)));
  if (!target || target.role === "owner") { res.status(400).json({ error: "The workspace owner cannot be removed" }); return; }
  const [updated] = await db.update(studioMembersTable).set({ status: "removed" }).where(and(eq(studioMembersTable.id, memberId), eq(studioMembersTable.studioId, current.studioId))).returning();
  if (!updated) { res.status(404).json({ error: "Member not found" }); return; }
  res.status(204).send();
});

router.put("/projects/:projectId/assignments", requireAuth, async (req, res): Promise<void> => {
  const userId = getUserId(req);
  if (!(await isStudioManager(userId))) { res.status(403).json({ error: "Only owners and admins can assign projects" }); return; }
  const current = await getStudioMember(userId);
  const projectId = Number(req.params.projectId);
  const memberIds = Array.isArray(req.body?.memberIds) ? req.body.memberIds.map(Number).filter(Number.isInteger) : [];
  const [project] = await db.select().from(projectsTable).where(and(eq(projectsTable.id, projectId), eq(projectsTable.studioId, current.studioId)));
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }
  const allowed = await db.select({ id: studioMembersTable.id }).from(studioMembersTable).where(eq(studioMembersTable.studioId, current.studioId));
  const valid = memberIds.filter((id: number) => allowed.some((item) => item.id === id));
  await db.delete(projectAssignmentsTable).where(eq(projectAssignmentsTable.projectId, projectId));
  if (valid.length) await db.insert(projectAssignmentsTable).values(valid.map((memberId: number) => ({ projectId, memberId })));
  res.json({ projectId, memberIds: valid });
});

router.post("/desktop-connections", requireAuth, async (req, res): Promise<void> => {
  const userId = getUserId(req);
  if (!(await isStudioManager(userId))) {
    res.status(403).json({ error: "Only owners and admins can connect desktop computers" });
    return;
  }

  const current = await getStudioMember(userId);
  const memberId = Number(req.body?.memberId);
  const deviceName = String(req.body?.deviceName ?? "").trim();
  if (!Number.isInteger(memberId) || !deviceName || deviceName.length > 100) {
    res.status(400).json({ error: "A member and device name are required" });
    return;
  }

  const [member] = await db
    .select()
    .from(studioMembersTable)
    .where(and(
      eq(studioMembersTable.id, memberId),
      eq(studioMembersTable.studioId, current.studioId),
      eq(studioMembersTable.status, "active"),
    ));
  if (!member) {
    res.status(400).json({ error: "Active studio member not found" });
    return;
  }
  if (!["owner", "admin", "assistant", "photographer"].includes(member.role)) {
    res.status(400).json({ error: "Desktop connections require an owner, admin, assistant, or photographer" });
    return;
  }

  const credentials = createDesktopToken();
  const [connection] = await db.insert(desktopConnectionsTable).values({
    studioId: current.studioId,
    memberId,
    deviceName,
    tokenHash: credentials.tokenHash,
    tokenPrefix: credentials.tokenPrefix,
  }).returning({
    id: desktopConnectionsTable.id,
    deviceName: desktopConnectionsTable.deviceName,
    tokenPrefix: desktopConnectionsTable.tokenPrefix,
    memberId: desktopConnectionsTable.memberId,
    status: desktopConnectionsTable.status,
    createdAt: desktopConnectionsTable.createdAt,
  });

  res.status(201).json({ connection, token: credentials.token });
});

router.delete("/desktop-connections/:connectionId", requireAuth, async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const current = await getStudioMember(userId);
  if (current.status !== "active" || current.role !== "owner") {
    res.status(403).json({ error: "Only the studio owner can revoke desktop connections" });
    return;
  }

  const connectionId = Number(req.params.connectionId);
  if (!Number.isInteger(connectionId)) {
    res.status(400).json({ error: "Invalid desktop connection" });
    return;
  }
  const [updated] = await db
    .update(desktopConnectionsTable)
    .set({ status: "revoked", revokedAt: new Date() })
    .where(and(
      eq(desktopConnectionsTable.id, connectionId),
      eq(desktopConnectionsTable.studioId, current.studioId),
      eq(desktopConnectionsTable.status, "active"),
    ))
    .returning({ id: desktopConnectionsTable.id });
  if (!updated) {
    res.status(404).json({ error: "Active desktop connection not found" });
    return;
  }
  res.status(204).send();
});

export default router;