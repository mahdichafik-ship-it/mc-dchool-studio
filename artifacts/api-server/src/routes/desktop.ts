/**
 * Desktop-facing API routes — authenticated with a member-scoped connection
 * token (no Clerk).
 * Used by the Electron app to list and pull cloud projects without a JSON file.
 */

import { Router } from "express";
import type { Response } from "express";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { db, desktopAuthSessionsTable, desktopConnectionsTable, studioMembersTable } from "@workspace/db";
import { projectsTable, classesTable, studentsTable } from "@workspace/db";
import { and, eq, gt, inArray } from "drizzle-orm";
import {
  getDesktopConnection,
  hashDesktopToken,
  refreshDesktopConnection,
  requireDesktopConnection,
  requireDesktopConnectionWithRetirement,
  createDesktopToken,
} from "../lib/desktopAuth";
import { assignedDesktopProjectIds, canAccessAssignedDesktopProject } from "../lib/studioAccess";
import { getStudioMember } from "../lib/studioAccess";
import { getUserId, requireAuth } from "../lib/auth";
import { isPlatformOwner } from "../lib/platformAccess";

const router = Router();
const desktopAuthLifetimeMs = 10 * 60 * 1000;

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
      deviceName: "MC School Studio desktop",
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

function memberForAccess(connection: ReturnType<typeof getDesktopConnection>) {
  return {
    id: connection.memberId,
    studioId: connection.studioId,
    role: connection.memberRole,
    status: "active" as const,
  };
}

async function desktopProjectIds(connection: ReturnType<typeof getDesktopConnection>) {
  if (await isPlatformOwner(connection.memberUserId)) {
    const rows = await db.select({ id: projectsTable.id }).from(projectsTable);
    return rows.map((row) => row.id);
  }
  return assignedDesktopProjectIds(memberForAccess(connection));
}

async function canAccessDesktopProject(
  connection: ReturnType<typeof getDesktopConnection>,
  projectId: number,
) {
  if (await isPlatformOwner(connection.memberUserId)) {
    const [project] = await db
      .select({ id: projectsTable.id })
      .from(projectsTable)
      .where(eq(projectsTable.id, projectId))
      .limit(1);
    return Boolean(project);
  }
  return canAccessAssignedDesktopProject(memberForAccess(connection), projectId);
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

  if (!(await canAccessDesktopProject(connection, projectId))) {
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

  if (!(await requireStillActiveBeforeDataResponse(connection, res))) return;
  res.json({
    exportedAt: new Date().toISOString(),
    exportVersion: 1,
    project: {
      id: project.id,
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
  });
});

export default router;
