import { Router } from "express";
import { and, eq } from "drizzle-orm";
import { db, projectAssignmentsTable, projectsTable, studioInvitesTable, studioMembersTable } from "@workspace/db";
import { getUserId, requireAuth } from "../lib/auth";
import { getStudioMember, isStudioManager } from "../lib/studioAccess";

const router = Router();
const roles = ["admin", "assistant", "photographer", "viewer"] as const;

router.get("/", requireAuth, async (req, res): Promise<void> => {
  const member = await getStudioMember(getUserId(req));
  const members = await db.select().from(studioMembersTable).where(eq(studioMembersTable.studioId, member.studioId));
  const invites = await db.select().from(studioInvitesTable).where(eq(studioInvitesTable.studioId, member.studioId));
  const projects = await db.select({ id: projectsTable.id, schoolName: projectsTable.schoolName }).from(projectsTable).where(eq(projectsTable.studioId, member.studioId));
  const assignments = await db.select().from(projectAssignmentsTable);
  res.json({ currentMember: member, members, invites, projects, assignments: assignments.filter((item) => projects.some((project) => project.id === item.projectId)) });
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
  if (current.role !== "owner") { res.status(403).json({ error: "Only the owner can remove members" }); return; }
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

export default router;