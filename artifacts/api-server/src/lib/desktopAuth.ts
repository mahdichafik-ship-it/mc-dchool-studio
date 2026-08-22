import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { and, eq } from "drizzle-orm";
import { db, desktopConnectionsTable, studioMembersTable } from "@workspace/db";

export type DesktopConnection = {
  connectionId: number;
  studioId: number;
  memberId: number;
  memberUserId: string;
  memberEmail: string;
  memberRole: "owner" | "admin" | "assistant" | "photographer" | "viewer";
  deviceName: string;
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

export async function findDesktopConnection(token: string): Promise<DesktopConnection | null> {
  const tokenHash = hashDesktopToken(token);
  const [connection] = await db
    .select({
      connectionId: desktopConnectionsTable.id,
      studioId: desktopConnectionsTable.studioId,
      memberId: desktopConnectionsTable.memberId,
      memberUserId: studioMembersTable.userId,
      memberEmail: studioMembersTable.email,
      memberRole: studioMembersTable.role,
      deviceName: desktopConnectionsTable.deviceName,
      tokenHash: desktopConnectionsTable.tokenHash,
    })
    .from(desktopConnectionsTable)
    .innerJoin(studioMembersTable, eq(desktopConnectionsTable.memberId, studioMembersTable.id))
    .where(and(
      eq(desktopConnectionsTable.status, "active"),
      eq(studioMembersTable.status, "active"),
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
    })
    .from(desktopConnectionsTable)
    .innerJoin(studioMembersTable, eq(desktopConnectionsTable.memberId, studioMembersTable.id))
    .where(and(
      eq(desktopConnectionsTable.id, connectionId),
      eq(desktopConnectionsTable.status, "active"),
      eq(studioMembersTable.status, "active"),
    ))
    .limit(1);

  if (!connection) return null;
  await db
    .update(desktopConnectionsTable)
    .set({ lastUsedAt: new Date() })
    .where(eq(desktopConnectionsTable.id, connection.connectionId));
  return connection;
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

export function getDesktopConnection(req: Request): DesktopConnection {
  return (req as Request & { desktopConnection: DesktopConnection }).desktopConnection;
}