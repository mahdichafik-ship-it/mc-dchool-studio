import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { and, eq, gt, inArray, isNull, or } from "drizzle-orm";
import { db, desktopConnectionsTable, studioMembersTable, studiosTable } from "@workspace/db";

export type DesktopConnection = {
  connectionId: number;
  studioId: number;
  memberId: number;
  memberUserId: string;
  memberEmail: string;
  memberRole: "owner" | "admin" | "assistant" | "photographer" | "viewer";
  deviceName: string;
  status: "active" | "retired";
  retiredAt: Date | null;
  retirementAcknowledgedAt: Date | null;
  expiresAt: Date | null;
};

type DesktopConnectionRow = DesktopConnection & {
  tokenHash: string;
};

export function hashDesktopToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function createDesktopToken(): { token: string; tokenHash: string; tokenPrefix: string } {
  const token = `mcs_desktop_${randomBytes(32).toString("base64url")}`;
  return {
    token,
    tokenHash: hashDesktopToken(token),
    tokenPrefix: token.slice(0, 20),
  };
}

export async function findDesktopConnection(
  token: string,
  options: { includeRetired?: boolean } = {},
): Promise<DesktopConnection | null> {
  const tokenHash = hashDesktopToken(token);
  const statuses = options.includeRetired ? ["active", "retired"] as const : ["active"] as const;
  const [connection] = await db
    .select({
      connectionId: desktopConnectionsTable.id,
      studioId: desktopConnectionsTable.studioId,
      memberId: desktopConnectionsTable.memberId,
      memberUserId: studioMembersTable.userId,
      memberEmail: studioMembersTable.email,
      memberRole: studioMembersTable.role,
      deviceName: desktopConnectionsTable.deviceName,
      status: desktopConnectionsTable.status,
      retiredAt: desktopConnectionsTable.retiredAt,
      retirementAcknowledgedAt: desktopConnectionsTable.retirementAcknowledgedAt,
      expiresAt: desktopConnectionsTable.expiresAt,
      tokenHash: desktopConnectionsTable.tokenHash,
    })
    .from(desktopConnectionsTable)
    .innerJoin(studioMembersTable, eq(desktopConnectionsTable.memberId, studioMembersTable.id))
    .innerJoin(studiosTable, eq(desktopConnectionsTable.studioId, studiosTable.id))
    .where(and(
      inArray(desktopConnectionsTable.status, statuses),
      eq(studioMembersTable.status, "active"),
      isNull(studiosTable.archivedAt),
      or(isNull(desktopConnectionsTable.expiresAt), gt(desktopConnectionsTable.expiresAt, new Date())),
      eq(desktopConnectionsTable.tokenHash, tokenHash),
    ))
    .limit(1);

  if (!connection) return null;
  const expected = Buffer.from(connection.tokenHash, "hex");
  const provided = Buffer.from(tokenHash, "hex");
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) return null;

  await db
    .update(desktopConnectionsTable)
    .set({ lastUsedAt: new Date() })
    .where(eq(desktopConnectionsTable.id, connection.connectionId));

  const { tokenHash: _tokenHash, ...session } = connection as DesktopConnectionRow;
  return session;
}

export async function refreshDesktopConnection(connectionId: number): Promise<DesktopConnection | null> {
  const [connection] = await db
    .select({
      connectionId: desktopConnectionsTable.id,
      studioId: desktopConnectionsTable.studioId,
      memberId: desktopConnectionsTable.memberId,
      memberUserId: studioMembersTable.userId,
      memberEmail: studioMembersTable.email,
      memberRole: studioMembersTable.role,
      deviceName: desktopConnectionsTable.deviceName,
      status: desktopConnectionsTable.status,
      retiredAt: desktopConnectionsTable.retiredAt,
      retirementAcknowledgedAt: desktopConnectionsTable.retirementAcknowledgedAt,
      expiresAt: desktopConnectionsTable.expiresAt,
    })
    .from(desktopConnectionsTable)
    .innerJoin(studioMembersTable, eq(desktopConnectionsTable.memberId, studioMembersTable.id))
    .innerJoin(studiosTable, eq(desktopConnectionsTable.studioId, studiosTable.id))
    .where(and(
      eq(desktopConnectionsTable.id, connectionId),
      eq(desktopConnectionsTable.status, "active"),
      eq(studioMembersTable.status, "active"),
      isNull(studiosTable.archivedAt),
      or(isNull(desktopConnectionsTable.expiresAt), gt(desktopConnectionsTable.expiresAt, new Date())),
    ))
    .limit(1);

  if (!connection) return null;
  await db
    .update(desktopConnectionsTable)
    .set({ lastUsedAt: new Date() })
    .where(eq(desktopConnectionsTable.id, connection.connectionId));
  return { ...connection, status: "active" };
}

export async function requireDesktopConnection(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  const connection = token ? await findDesktopConnection(token) : null;
  if (!connection) {
    res.status(401).json({ error: "Invalid or revoked desktop connection" });
    return;
  }
  (req as Request & { desktopConnection: DesktopConnection }).desktopConnection = connection;
  next();
}

export async function requireDesktopConnectionWithRetirement(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  const connection = token ? await findDesktopConnection(token, { includeRetired: true }) : null;
  if (!connection) {
    res.status(401).json({ error: "Invalid or revoked desktop connection" });
    return;
  }
  (req as Request & { desktopConnection: DesktopConnection }).desktopConnection = connection;
  next();
}

export function getDesktopConnection(req: Request): DesktopConnection {
  return (req as Request & { desktopConnection: DesktopConnection }).desktopConnection;
}