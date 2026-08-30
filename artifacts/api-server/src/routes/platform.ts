import { randomBytes } from "node:crypto";
import { Router } from "express";
import { and, asc, count, desc, eq } from "drizzle-orm";
import { db, classesTable, platformInvitesTable, projectsTable, studentsTable, studioMembersTable, studiosTable } from "@workspace/db";
import { getUserId, requireAuth } from "../lib/auth";
import { getUserEmail } from "../lib/studioAccess";
import { platformOwnerIsConfigured, requirePlatformOwner } from "../lib/platformAccess";

const router = Router();
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
  const [studios, members, projectCounts, projectRows, invites] = await Promise.all([
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
  ]);

  const ownerByStudio = new Map(
    members
      .filter((member) => member.role === "owner")
      .map((member) => [member.studioId, member]),
  );
  const projectCountByStudio = new Map(projectCounts.map((row) => [row.studioId, Number(row.count)]));
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
    studios: studios.map((studio) => ({
      ...studio,
      memberCount: members.filter((member) => member.studioId === studio.id).length,
      projectCount: projectCountByStudio.get(studio.id) ?? 0,
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