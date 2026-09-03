import { Router } from "express";
import type { Request } from "express";
import { and, desc, eq, gt, isNull, ne } from "drizzle-orm";
import {
  db,
  studioMembersTable,
  studioStorageAuditTable,
  studioStorageConnectionsTable,
  studioStorageOauthStatesTable,
  studiosTable,
} from "@workspace/db";
import { getUserId, requireAuth } from "../lib/auth";
import { getStudioMember } from "../lib/studioAccess";
import { decryptStorageValue, encryptStorageValue } from "../lib/storageCrypto";
import {
  authorizationUrl,
  createOAuthState,
  createPkcePair,
  exchangeAuthorizationCode,
  hashOAuthState,
  providerIdentity,
  type ExternalStorageProvider,
} from "../lib/storageOAuth";

const router = Router();
const storageProviders = ["platform_google_drive", "google_drive", "dropbox"] as const;
type StorageProvider = typeof storageProviders[number];

function isStorageProvider(value: unknown): value is StorageProvider {
  return typeof value === "string" && storageProviders.includes(value as StorageProvider);
}

function isExternalProvider(value: unknown): value is ExternalStorageProvider {
  return value === "google_drive" || value === "dropbox";
}

function publicOrigin(req: Request): string {
  const forwardedProtocol = String(req.get("x-forwarded-proto") ?? "").split(",")[0]?.trim();
  const protocol = forwardedProtocol === "https" || forwardedProtocol === "http"
    ? forwardedProtocol
    : req.protocol;
  const forwardedHost = String(req.get("x-forwarded-host") ?? "").split(",")[0]?.trim();
  const host = forwardedHost || req.get("host");
  if (!host || !/^[a-zA-Z0-9.-]+(?::\d+)?$/.test(host)) {
    throw new Error("Could not determine a safe OAuth callback host");
  }
  return `${protocol}://${host}`;
}

async function studioContext(userId: string) {
  const member = await getStudioMember(userId);
  const [studio] = await db
    .select()
    .from(studiosTable)
    .where(eq(studiosTable.id, member.studioId))
    .limit(1);
  return { member, studio };
}

router.get("/", requireAuth, async (req, res): Promise<void> => {
  const { member, studio } = await studioContext(getUserId(req));
  if (!studio || member.status !== "active") {
    res.status(404).json({ error: "Studio not found" });
    return;
  }
  const canManageStorage = member.role === "owner" || member.role === "admin";
  const connections = canManageStorage ? await db
    .select({
      id: studioStorageConnectionsTable.id,
      provider: studioStorageConnectionsTable.provider,
      providerAccountId: studioStorageConnectionsTable.providerAccountId,
      providerAccountEmail: studioStorageConnectionsTable.providerAccountEmail,
      status: studioStorageConnectionsTable.status,
      lastVerifiedAt: studioStorageConnectionsTable.lastVerifiedAt,
      connectedAt: studioStorageConnectionsTable.createdAt,
      disconnectedAt: studioStorageConnectionsTable.disconnectedAt,
    })
    .from(studioStorageConnectionsTable)
    .where(eq(studioStorageConnectionsTable.studioId, studio.id)) : [];
  const audit = canManageStorage ? await db
    .select({
      id: studioStorageAuditTable.id,
      action: studioStorageAuditTable.action,
      provider: studioStorageAuditTable.provider,
      providerAccountEmail: studioStorageAuditTable.providerAccountEmail,
      detail: studioStorageAuditTable.detail,
      createdAt: studioStorageAuditTable.createdAt,
    })
    .from(studioStorageAuditTable)
    .where(eq(studioStorageAuditTable.studioId, studio.id))
    .orderBy(desc(studioStorageAuditTable.createdAt))
    .limit(20) : [];
  res.json({
    studio,
    member: {
      id: member.id,
      role: member.role,
      status: member.status,
    },
    activeStorageProvider: studio.storageStatus === "connected"
      ? studio.storageProvider
      : "platform_google_drive",
    connections,
    storageAudit: audit,
  });
});

router.put("/storage", requireAuth, async (req, res): Promise<void> => {
  const { member, studio } = await studioContext(getUserId(req));
  if (!studio || member.status !== "active") {
    res.status(404).json({ error: "Studio not found" });
    return;
  }
  if (member.role !== "owner" && member.role !== "admin") {
    res.status(403).json({ error: "Only studio owners and admins can manage storage" });
    return;
  }

  const provider = req.body?.provider;
  if (!isStorageProvider(provider)) {
    res.status(400).json({ error: "Choose platform Google Drive, Google Drive, or Dropbox" });
    return;
  }

  const now = new Date();
  const [updated] = await db
    .update(studiosTable)
    .set(provider === "platform_google_drive"
      ? {
        storageProvider: provider,
        storageStatus: "using_platform",
        storageRequestedAt: null,
        storageConnectedAt: null,
      }
      : {
        storageProvider: provider,
        storageStatus: "connection_requested",
        storageRequestedAt: now,
        storageConnectedAt: null,
      })
    .where(eq(studiosTable.id, studio.id))
    .returning();

  res.json({
    studio: updated,
    activeStorageProvider: updated.storageStatus === "connected"
      ? updated.storageProvider
      : "platform_google_drive",
  });
});

router.post("/storage/oauth/:provider/start", requireAuth, async (req, res): Promise<void> => {
  const provider = req.params.provider;
  if (!isExternalProvider(provider)) {
    res.status(404).json({ error: "Storage provider not found" });
    return;
  }
  const { member, studio } = await studioContext(getUserId(req));
  if (!studio || member.status !== "active") {
    res.status(404).json({ error: "Studio not found" });
    return;
  }
  if (member.role !== "owner" && member.role !== "admin") {
    res.status(403).json({ error: "Only studio owners and admins can connect storage" });
    return;
  }

  try {
    const state = createOAuthState();
    const { verifier, challenge } = createPkcePair();
    const redirectUri = `${publicOrigin(req)}/api/studio/storage/oauth/${provider}/callback`;
    const url = authorizationUrl(provider, state, challenge, redirectUri);
    const now = new Date();
    await db.transaction(async (tx) => {
      await tx.insert(studioStorageOauthStatesTable).values({
        studioId: studio.id,
        memberId: member.id,
        provider,
        stateHash: hashOAuthState(state),
        encryptedCodeVerifier: encryptStorageValue(verifier),
        redirectUri,
        expiresAt: new Date(now.getTime() + 10 * 60 * 1000),
      });
      await tx.update(studiosTable).set({
        storageProvider: provider,
        storageStatus: "connection_requested",
        storageRequestedAt: now,
        storageConnectedAt: null,
      }).where(eq(studiosTable.id, studio.id));
      await tx.insert(studioStorageAuditTable).values({
        studioId: studio.id,
        actorMemberId: member.id,
        action: "connection_started",
        provider,
      });
    });
    res.json({ authorizationUrl: url });
  } catch (error) {
    res.status(503).json({
      error: error instanceof Error ? error.message : "Storage OAuth is not configured",
    });
  }
});

router.get("/storage/oauth/:provider/callback", async (req, res): Promise<void> => {
  const provider = req.params.provider;
  const state = typeof req.query.state === "string" ? req.query.state : "";
  const code = typeof req.query.code === "string" ? req.query.code : "";
  if (!isExternalProvider(provider) || !state || !code) {
    res.redirect("/studio/settings?storage=connection_failed");
    return;
  }

  const now = new Date();
  const [oauthState] = await db
    .update(studioStorageOauthStatesTable)
    .set({ usedAt: now })
    .where(and(
      eq(studioStorageOauthStatesTable.stateHash, hashOAuthState(state)),
      eq(studioStorageOauthStatesTable.provider, provider),
      isNull(studioStorageOauthStatesTable.usedAt),
      gt(studioStorageOauthStatesTable.expiresAt, now),
    ))
    .returning();
  if (!oauthState) {
    res.redirect("/studio/settings?storage=invalid_state");
    return;
  }

  try {
    const verifier = decryptStorageValue<string>(oauthState.encryptedCodeVerifier);
    const credentials = await exchangeAuthorizationCode(provider, code, verifier, oauthState.redirectUri);
    const identity = await providerIdentity(provider, credentials.accessToken);
    await db.transaction(async (tx) => {
      await tx.update(studioStorageConnectionsTable).set({
        encryptedCredentials: null,
        status: "revoked",
        disconnectedAt: now,
        updatedAt: now,
      }).where(and(
        eq(studioStorageConnectionsTable.studioId, oauthState.studioId),
        ne(studioStorageConnectionsTable.provider, provider),
      ));
      await tx.insert(studioStorageConnectionsTable).values({
        studioId: oauthState.studioId,
        provider,
        providerAccountId: identity.id,
        providerAccountEmail: identity.email,
        encryptedCredentials: encryptStorageValue(credentials),
        status: "active",
        connectedByMemberId: oauthState.memberId,
        lastVerifiedAt: now,
        updatedAt: now,
        disconnectedAt: null,
      }).onConflictDoUpdate({
        target: [
          studioStorageConnectionsTable.studioId,
          studioStorageConnectionsTable.provider,
        ],
        set: {
          providerAccountId: identity.id,
          providerAccountEmail: identity.email,
          encryptedCredentials: encryptStorageValue(credentials),
          status: "active",
          connectedByMemberId: oauthState.memberId,
          lastVerifiedAt: now,
          updatedAt: now,
          disconnectedAt: null,
        },
      });
      await tx.update(studiosTable).set({
        storageProvider: provider,
        storageStatus: "connected",
        storageConnectedAt: now,
      }).where(eq(studiosTable.id, oauthState.studioId));
      await tx.insert(studioStorageAuditTable).values({
        studioId: oauthState.studioId,
        actorMemberId: oauthState.memberId,
        action: "connected",
        provider,
        providerAccountId: identity.id,
        providerAccountEmail: identity.email,
      });
    });
    res.redirect("/studio/settings?storage=connected");
  } catch (error) {
    const detail = error instanceof Error ? error.message.slice(0, 300) : "Connection failed";
    await db.transaction(async (tx) => {
      await tx.update(studiosTable).set({
        storageStatus: "connection_error",
        storageConnectedAt: null,
      }).where(eq(studiosTable.id, oauthState.studioId));
      await tx.insert(studioStorageAuditTable).values({
        studioId: oauthState.studioId,
        actorMemberId: oauthState.memberId,
        action: "connection_failed",
        provider,
        detail,
      });
    });
    res.redirect("/studio/settings?storage=connection_failed");
  }
});

router.delete("/storage/connection", requireAuth, async (req, res): Promise<void> => {
  const { member, studio } = await studioContext(getUserId(req));
  if (!studio || member.status !== "active") {
    res.status(404).json({ error: "Studio not found" });
    return;
  }
  if (member.role !== "owner" && member.role !== "admin") {
    res.status(403).json({ error: "Only studio owners and admins can disconnect storage" });
    return;
  }
  const provider = studio.storageProvider;
  if (!isExternalProvider(provider)) {
    res.status(204).end();
    return;
  }
  const [connection] = await db.select({
    providerAccountId: studioStorageConnectionsTable.providerAccountId,
    providerAccountEmail: studioStorageConnectionsTable.providerAccountEmail,
  }).from(studioStorageConnectionsTable).where(and(
    eq(studioStorageConnectionsTable.studioId, studio.id),
    eq(studioStorageConnectionsTable.provider, provider),
  )).limit(1);
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx.update(studioStorageConnectionsTable).set({
      encryptedCredentials: null,
      status: "revoked",
      disconnectedAt: now,
      updatedAt: now,
    }).where(and(
      eq(studioStorageConnectionsTable.studioId, studio.id),
      eq(studioStorageConnectionsTable.provider, provider),
    ));
    await tx.update(studiosTable).set({
      storageProvider: "platform_google_drive",
      storageStatus: "using_platform",
      storageConnectedAt: null,
      storageRequestedAt: null,
    }).where(eq(studiosTable.id, studio.id));
    await tx.insert(studioStorageAuditTable).values({
      studioId: studio.id,
      actorMemberId: member.id,
      action: "disconnected",
      provider,
      providerAccountId: connection?.providerAccountId,
      providerAccountEmail: connection?.providerAccountEmail,
    });
  });
  res.status(204).end();
});

export default router;