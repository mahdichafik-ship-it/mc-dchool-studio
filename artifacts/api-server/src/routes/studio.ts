import { Router } from "express";
import { eq } from "drizzle-orm";
import { db, studiosTable } from "@workspace/db";
import { getUserId, requireAuth } from "../lib/auth";
import { getStudioMember } from "../lib/studioAccess";

const router = Router();
const storageProviders = ["platform_google_drive", "google_drive", "dropbox"] as const;
type StorageProvider = typeof storageProviders[number];

function isStorageProvider(value: unknown): value is StorageProvider {
  return typeof value === "string" && storageProviders.includes(value as StorageProvider);
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

export default router;