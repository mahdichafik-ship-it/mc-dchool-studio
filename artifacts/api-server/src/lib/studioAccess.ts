import { and, eq, isNull } from "drizzle-orm";
import { db, projectsTable, projectAssignmentsTable, studioInvitesTable, studioMembersTable, studiosTable } from "@workspace/db";

export type StudioRole = "owner" | "admin" | "assistant" | "photographer" | "viewer";
export type ProjectAction = "view" | "edit" | "shoot" | "manage";

async function clerkEmail(userId: string): Promise<string> {
  const key = process.env.CLERK_SECRET_KEY;
  if (!key) return `${userId}@member.local`;
  const response = await fetch(`https://api.clerk.com/v1/users/${encodeURIComponent(userId)}`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!response.ok) return `${userId}@member.local`;
  const user = await response.json() as { primary_email_address_id?: string; email_addresses?: { id: string; email_address: string }[]; first_name?: string; last_name?: string };
  return user.email_addresses?.find((item) => item.id === user.primary_email_address_id)?.email_address
    ?? user.email_addresses?.[0]?.email_address
    ?? `${userId}@member.local`;
}

export async function ensureStudioForUser(userId: string) {
  const existing = await db.select().from(studioMembersTable).where(and(eq(studioMembersTable.userId, userId), eq(studioMembersTable.status, "active"))).limit(1);
  if (existing[0]) return existing[0];
  const email = (await clerkEmail(userId)).toLowerCase();
  const invite = await db.select().from(studioInvitesTable).where(and(eq(studioInvitesTable.email, email), eq(studioInvitesTable.status, "pending"))).limit(1);
  if (invite[0]) {
    const [member] = await db.insert(studioMembersTable).values({ studioId: invite[0].studioId, userId, email, role: invite[0].role }).returning();
    await db.update(studioInvitesTable).set({ status: "accepted" }).where(eq(studioInvitesTable.id, invite[0].id));
    return member;
  }
  const [studio] = await db.insert(studiosTable).values({ name: "My Studio", createdByUserId: userId }).returning();
  const [member] = await db.insert(studioMembersTable).values({ studioId: studio.id, userId, email, role: "owner" }).returning();
  await db.update(projectsTable).set({ studioId: studio.id }).where(and(eq(projectsTable.userId, userId), isNull(projectsTable.studioId)));
  return member;
}

export async function getStudioMember(userId: string) {
  return ensureStudioForUser(userId);
}

export async function canAccessProject(userId: string, projectId: number, action: ProjectAction = "view") {
  const member = await ensureStudioForUser(userId);
  return canAccessProjectForMember(member, projectId, action);
}

export async function canAccessProjectForMember(
  member: Pick<typeof studioMembersTable.$inferSelect, "id" | "studioId" | "role">,
  projectId: number,
  action: ProjectAction = "view",
) {
  const [project] = await db.select().from(projectsTable).where(eq(projectsTable.id, projectId));
  if (!project || project.studioId !== member.studioId) return false;
  if (member.role === "owner" || member.role === "admin") return true;
  const assignments = await db.select().from(projectAssignmentsTable).where(and(eq(projectAssignmentsTable.projectId, projectId), eq(projectAssignmentsTable.memberId, member.id))).limit(1);
  if (!assignments[0]) return false;
  if (action === "view" || action === "shoot") return member.role === "assistant" || member.role === "photographer";
  return member.role === "assistant";
}

export async function accessibleProjectIds(userId: string) {
  const member = await ensureStudioForUser(userId);
  return accessibleProjectIdsForMember(member);
}

export async function accessibleProjectIdsForMember(
  member: Pick<typeof studioMembersTable.$inferSelect, "id" | "studioId" | "role">,
) {
  if (member.role === "owner" || member.role === "admin") {
    const rows = await db.select({ id: projectsTable.id }).from(projectsTable).where(eq(projectsTable.studioId, member.studioId));
    return rows.map((row) => row.id);
  }
  const rows = await db.select({ projectId: projectAssignmentsTable.projectId })
    .from(projectAssignmentsTable)
    .innerJoin(projectsTable, eq(projectAssignmentsTable.projectId, projectsTable.id))
    .where(and(eq(projectAssignmentsTable.memberId, member.id), eq(projectsTable.studioId, member.studioId)));
  return rows.map((row) => row.projectId);
}

export async function canAccessAssignedDesktopProject(
  member: Pick<typeof studioMembersTable.$inferSelect, "id" | "studioId" | "role">,
  projectId: number,
) {
  if (member.role !== "assistant" && member.role !== "photographer") return false;
  const [project] = await db
    .select({ id: projectsTable.id })
    .from(projectsTable)
    .where(and(eq(projectsTable.id, projectId), eq(projectsTable.studioId, member.studioId)));
  if (!project) return false;
  const [assignment] = await db
    .select({ id: projectAssignmentsTable.id })
    .from(projectAssignmentsTable)
    .where(and(
      eq(projectAssignmentsTable.projectId, projectId),
      eq(projectAssignmentsTable.memberId, member.id),
    ))
    .limit(1);
  return !!assignment;
}

export async function assignedDesktopProjectIds(
  member: Pick<typeof studioMembersTable.$inferSelect, "id" | "studioId" | "role">,
) {
  if (member.role !== "assistant" && member.role !== "photographer") return [];
  const rows = await db.select({ projectId: projectAssignmentsTable.projectId })
    .from(projectAssignmentsTable)
    .innerJoin(projectsTable, eq(projectAssignmentsTable.projectId, projectsTable.id))
    .where(and(eq(projectAssignmentsTable.memberId, member.id), eq(projectsTable.studioId, member.studioId)));
  return rows.map((row) => row.projectId);
}

export async function isStudioManager(userId: string) {
  const member = await ensureStudioForUser(userId);
  return member.role === "owner" || member.role === "admin";
}