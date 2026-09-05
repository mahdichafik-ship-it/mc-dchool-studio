import fs from "node:fs";
import { and, eq } from "drizzle-orm";
import {
  db,
  studioStorageAuditTable,
  studioStorageConnectionsTable,
  studiosTable,
} from "@workspace/db";
import {
  backupFileToGoogleDrive,
  GoogleDriveBackupError,
  type DriveBackupInput,
  type DriveRequester,
} from "./googleDriveBackup";
import { decryptStorageValue, encryptStorageValue } from "./storageCrypto";
import {
  refreshAccessToken,
  type ExternalStorageProvider,
  type OAuthCredentials,
} from "./storageOAuth";
import { logger } from "./logger";

function safePathPart(value: string, fallback: string): string {
  const cleaned = value.trim().replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, " ");
  return (cleaned || fallback).slice(0, 180);
}

async function usableCredentials(
  connection: typeof studioStorageConnectionsTable.$inferSelect,
): Promise<OAuthCredentials> {
  if (!connection.encryptedCredentials) throw new Error("Storage credentials are unavailable");
  let credentials = decryptStorageValue<OAuthCredentials>(connection.encryptedCredentials);
  if (credentials.expiresAt > Date.now() + 60_000) return credentials;
  credentials = await refreshAccessToken(connection.provider, credentials);
  await db.update(studioStorageConnectionsTable).set({
    encryptedCredentials: encryptStorageValue(credentials),
    lastVerifiedAt: new Date(),
    updatedAt: new Date(),
  }).where(eq(studioStorageConnectionsTable.id, connection.id));
  return credentials;
}

function googleRequester(accessToken: string): DriveRequester {
  return async (path, options = {}) => {
    const headers = new Headers(options.headers);
    headers.set("Authorization", `Bearer ${accessToken}`);
    return fetch(`https://www.googleapis.com${path}`, {
      method: options.method,
      headers,
      body: options.body as any,
    });
  };
}

async function dropboxRequest(accessToken: string, path: string, body: unknown): Promise<Response> {
  return fetch(`https://api.dropboxapi.com/2${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

async function ensureDropboxFolder(accessToken: string, path: string): Promise<void> {
  const response = await dropboxRequest(accessToken, "/files/create_folder_v2", {
    path,
    autorename: false,
  });
  if (response.ok) return;
  const payload = await response.text();
  if (response.status === 409 && payload.includes("conflict")) return;
  throw new Error(`Dropbox folder creation failed with HTTP ${response.status}`);
}

async function backupToDropbox(input: DriveBackupInput, accessToken: string): Promise<void> {
  const parts = [
    "Volume Capture Backups",
    safePathPart(input.studioName, `Studio ${input.studioId}`),
    safePathPart(`${input.schoolName} (Project ${input.projectId})`, `Project ${input.projectId}`),
    safePathPart(input.className, `Class ${input.classId}`),
    safePathPart(input.studentFolderName, `Student ${input.studentId}`),
    input.fileRole,
  ];
  let folderPath = "";
  for (const part of parts) {
    folderPath += `/${part}`;
    await ensureDropboxFolder(accessToken, folderPath);
  }
  const destination = `${folderPath}/${safePathPart(input.fileName, `${input.backupKey}.${input.fileFormat}`)}`;
  const response = await fetch("https://content.dropboxapi.com/2/files/upload", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/octet-stream",
      "Dropbox-API-Arg": JSON.stringify({
        path: destination,
        mode: "add",
        autorename: false,
        mute: true,
      }),
    },
    body: fs.readFileSync(input.filePath),
  });
  if (response.ok) return;
  const payload = await response.text();
  if (response.status === 409 && payload.includes("conflict")) return;
  throw new Error(`Dropbox upload failed with HTTP ${response.status}`);
}

async function markConnectionError(
  studioId: number,
  provider: ExternalStorageProvider,
  detail: string,
): Promise<void> {
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx.update(studioStorageConnectionsTable).set({
      status: "error",
      updatedAt: now,
    }).where(and(
      eq(studioStorageConnectionsTable.studioId, studioId),
      eq(studioStorageConnectionsTable.provider, provider),
    ));
    await tx.update(studiosTable).set({
      storageStatus: "connection_error",
      storageConnectedAt: null,
    }).where(eq(studiosTable.id, studioId));
    await tx.insert(studioStorageAuditTable).values({
      studioId,
      action: "connection_failed",
      provider,
      detail: detail.slice(0, 300),
    });
  });
}

export async function backupFileForStudio(input: DriveBackupInput): Promise<void> {
  const [studio] = await db.select({
    storageProvider: studiosTable.storageProvider,
    storageStatus: studiosTable.storageStatus,
  }).from(studiosTable).where(eq(studiosTable.id, input.studioId)).limit(1);
  const provider = studio?.storageProvider;
  if (!studio || studio.storageStatus !== "connected"
    || (provider !== "google_drive" && provider !== "dropbox")) {
    await backupFileToGoogleDrive(input);
    return;
  }

  const [connection] = await db.select().from(studioStorageConnectionsTable).where(and(
    eq(studioStorageConnectionsTable.studioId, input.studioId),
    eq(studioStorageConnectionsTable.provider, provider),
    eq(studioStorageConnectionsTable.status, "active"),
  )).limit(1);

  try {
    if (!connection || connection.studioId !== input.studioId) {
      throw new Error("No active credential exists for this studio and provider");
    }
    const credentials = await usableCredentials(connection);
    if (provider === "google_drive") {
      await backupFileToGoogleDrive(input, googleRequester(credentials.accessToken));
    } else {
      await backupToDropbox(input, credentials.accessToken);
    }
    await db.update(studioStorageConnectionsTable).set({
      lastVerifiedAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(studioStorageConnectionsTable.id, connection.id));
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Studio storage backup failed";
    logger.error({ err: error, studioId: input.studioId, provider }, "Studio storage failed; using platform fallback");
    await markConnectionError(input.studioId, provider, detail);
    try {
      await backupFileToGoogleDrive(input);
    } catch (fallbackError) {
      throw new GoogleDriveBackupError("Studio storage and platform fallback both failed", { cause: fallbackError });
    }
  }
}