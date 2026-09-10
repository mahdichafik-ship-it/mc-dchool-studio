import fs from "node:fs";
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  db,
  studioStorageAuditTable,
  studioStorageConnectionsTable,
  studiosTable,
} from "@workspace/db";
import {
  backupFileToGoogleDrive,
  canonicalProjectFolderName,
  stableCollisionFileName,
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

const STORAGE_FETCH_TIMEOUT_MS = 90_000;

function safePathPart(value: string, fallback: string): string {
  const cleaned = value.trim().replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/\s+/g, " ");
  return (cleaned || fallback).slice(0, 120);
}

export function dropboxContentHash(bytes: Buffer): string {
  const blockHashes: Buffer[] = [];
  const blockSize = 4 * 1024 * 1024;
  for (let offset = 0; offset < bytes.length; offset += blockSize) {
    blockHashes.push(createHash("sha256").update(bytes.subarray(offset, offset + blockSize)).digest());
  }
  return createHash("sha256").update(Buffer.concat(blockHashes)).digest("hex");
}

export function studioDriveCacheScope(connectionId: number, providerAccountId: string): string {
  return `google-drive:studio-connection:${connectionId}:account:${providerAccountId}`;
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
    const url = /^https:\/\//i.test(path) ? path : `https://www.googleapis.com${path}`;
    return fetch(url, {
      method: options.method,
      headers,
      body: options.body as any,
      signal: AbortSignal.timeout(STORAGE_FETCH_TIMEOUT_MS),
    });
  };
}

async function dropboxRequest(
  accessToken: string,
  path: string,
  body: unknown,
  fetcher: typeof fetch,
): Promise<Response> {
  return fetcher(`https://api.dropboxapi.com/2${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(STORAGE_FETCH_TIMEOUT_MS),
  });
}

async function ensureDropboxFolder(accessToken: string, path: string, fetcher: typeof fetch): Promise<void> {
  const response = await dropboxRequest(accessToken, "/files/create_folder_v2", {
    path,
    autorename: false,
  }, fetcher);
  if (response.ok) return;
  const payload = await response.text();
  if (response.status === 409 && payload.includes("conflict")) return;
  throw new Error(`Dropbox folder creation failed with HTTP ${response.status}`);
}

export async function backupToDropbox(
  input: DriveBackupInput,
  accessToken: string,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const parts = [
    "Volume Capture Backups",
    safePathPart(input.studioName, `Studio ${input.studioId}`),
    canonicalProjectFolderName(input.schoolName, input.projectId),
    safePathPart(input.className, `Class ${input.classId}`),
    safePathPart(input.studentFolderName, `Student ${input.studentId}`),
  ];
  let folderPath = "";
  for (const part of parts) {
    folderPath += `/${part}`;
    await ensureDropboxFolder(accessToken, folderPath, fetcher);
  }
  const fileBytes = fs.readFileSync(input.filePath);
  const expectedHash = dropboxContentHash(fileBytes);
  const isIdentical = async (destination: string): Promise<boolean> => {
    const metadataResponse = await dropboxRequest(accessToken, "/files/get_metadata", {
      path: destination,
      include_deleted: false,
    }, fetcher);
    if (!metadataResponse.ok) {
      if (metadataResponse.status === 409) return false;
      throw new Error(`Dropbox metadata lookup failed with HTTP ${metadataResponse.status}`);
    }
    const metadata = await metadataResponse.json() as { size?: number; content_hash?: string };
    return metadata.size === fileBytes.length && metadata.content_hash === expectedHash;
  };
  const upload = (destination: string) => fetcher("https://content.dropboxapi.com/2/files/upload", {
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
    body: fileBytes,
    signal: AbortSignal.timeout(STORAGE_FETCH_TIMEOUT_MS),
  });
  const originalName = safePathPart(input.fileName, `${input.backupKey}.${input.fileFormat}`);
  const originalDestination = `${folderPath}/${originalName}`;
  let response = await upload(originalDestination);
  if (response.ok) return;
  const payload = await response.text();
  if (response.status === 409 && payload.includes("conflict")) {
    if (await isIdentical(originalDestination)) return;
    const fallbackDestination = `${folderPath}/${stableCollisionFileName(originalName, input.backupKey)}`;
    response = await upload(fallbackDestination);
    if (response.ok) return;
    const retryPayload = await response.text();
    if (
      response.status === 409
      && retryPayload.includes("conflict")
      && await isIdentical(fallbackDestination)
    ) return;
  }
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
    platformBackupEnabled: studiosTable.platformBackupEnabled,
  }).from(studiosTable).where(eq(studiosTable.id, input.studioId)).limit(1);
  const provider = studio?.storageProvider;
  if (!studio) {
    throw new GoogleDriveBackupError("Could not resolve the studio backup configuration.");
  }

  const hasStudioProvider = studio.storageStatus === "connected"
    && (provider === "google_drive" || provider === "dropbox");
  if (!studio.platformBackupEnabled && !hasStudioProvider) {
    throw new GoogleDriveBackupError("No backup destination is enabled for this studio.");
  }

  let platformError: unknown;
  let studioProviderError: unknown;
  let successfulCopies = 0;

  const platformBackup = async (): Promise<boolean> => {
    if (!studio.platformBackupEnabled) return false;
    try {
      await backupFileToGoogleDrive(input);
      return true;
    } catch (error) {
      platformError = error;
      logger.error({ err: error, studioId: input.studioId }, "Platform Google Drive backup failed");
      return false;
    }
  };

  const studioBackup = async (): Promise<boolean> => {
    if (!hasStudioProvider) return false;
    try {
      const [connection] = await db.select().from(studioStorageConnectionsTable).where(and(
        eq(studioStorageConnectionsTable.studioId, input.studioId),
        eq(studioStorageConnectionsTable.provider, provider),
        eq(studioStorageConnectionsTable.status, "active"),
      )).limit(1);
      if (!connection || connection.studioId !== input.studioId) {
        throw new Error("No active credential exists for this studio and provider");
      }
      const credentials = await usableCredentials(connection);
      if (provider === "google_drive") {
        await backupFileToGoogleDrive(
          input,
          googleRequester(credentials.accessToken),
          studioDriveCacheScope(connection.id, connection.providerAccountId),
        );
      } else {
        await backupToDropbox(input, credentials.accessToken);
      }
      await db.update(studioStorageConnectionsTable).set({
        lastVerifiedAt: new Date(),
        updatedAt: new Date(),
      }).where(eq(studioStorageConnectionsTable.id, connection.id));
      return true;
    } catch (error) {
      studioProviderError = error;
      const detail = error instanceof Error ? error.message : "Studio storage backup failed";
      logger.error({
        err: error,
        studioId: input.studioId,
        provider,
        platformBackupEnabled: studio.platformBackupEnabled,
      }, "Studio-owned storage backup failed");
      try {
        await markConnectionError(input.studioId, provider, detail);
      } catch (auditError) {
        logger.error({ err: auditError, studioId: input.studioId, provider }, "Could not record storage connection failure");
      }
      return false;
    }
  };

  const results = await Promise.allSettled([platformBackup(), studioBackup()]);
  successfulCopies = results.filter(
    (result): result is PromiseFulfilledResult<boolean> => result.status === "fulfilled" && result.value,
  ).length;
  for (const result of results) {
    if (result.status === "rejected") studioProviderError ??= result.reason;
  }

  if (successfulCopies === 0) {
    const cause = studioProviderError ?? platformError;
    throw new GoogleDriveBackupError("All enabled backup destinations failed.", { cause });
  }
}