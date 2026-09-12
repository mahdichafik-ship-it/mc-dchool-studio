import { ReplitConnectors } from "@replit/connectors-sdk";
import fs from "node:fs";
import { createHash } from "node:crypto";

const CONNECTOR_NAME = "google-drive";
const ROOT_FOLDER_KEY = "mcSchoolStudioRoot";
const ROOT_FOLDER_VALUE = "backups-v1";
const ROOT_FOLDER_NAME = "Volume Capture Backups";

type DriveFile = {
  id: string;
  name?: string;
  mimeType?: string;
  webViewLink?: string;
  size?: string;
  parents?: string[];
  md5Checksum?: string;
  appProperties?: Record<string, string>;
};

type FolderCacheEntry = {
  expiresAt: number;
  file: DriveFile;
};

const FOLDER_CACHE_TTL_MS = 5 * 60_000;
const FOLDER_CACHE_MAX_ENTRIES = 1_000;
const folderCache = new Map<string, FolderCacheEntry>();
const folderInflight = new Map<string, Promise<DriveFile>>();
const metadataWaiters: Array<() => void> = [];
let activeMetadataReads = 0;
const MAX_CONCURRENT_METADATA_READS = 2;
const MAX_METADATA_WAITERS = 100;
const METADATA_TIMEOUT_MS = 15_000;
const UPLOAD_TIMEOUT_MS = 5 * 60_000;
const uploadInflight = new Map<string, Promise<DriveFile>>();
const MAX_UPLOAD_INFLIGHT = 1_000;
const MAX_FOLDER_INFLIGHT = 200;
const DIRECT_FETCH_TIMEOUT_MS = 90_000;

type DriveListResponse = {
  files?: DriveFile[];
  nextPageToken?: string;
};

export type DriveBackupInput = {
  studioId: number;
  studioName: string;
  projectId: number;
  schoolName: string;
  classId: number;
  className: string;
  studentId: number;
  studentFolderName: string;
  filePath: string;
  fileName: string;
  fileRole: "JPEG" | "RAW";
  fileFormat: string;
  backupKey: string;
  subjectType?: "student" | "group";
};

export type DriveRequester = (
  path: string,
  options?: { method?: string; headers?: Record<string, string>; body?: unknown },
) => Promise<Response>;

export class GoogleDriveBackupError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "GoogleDriveBackupError";
  }
}

function escapeQueryValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

export function canonicalStoragePathName(value: string, fallback: string): string {
  const cleaned = value.trim().replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/\s+/g, " ");
  return (cleaned || fallback).slice(0, 120);
}

function driveName(value: string, fallback: string): string {
  return canonicalStoragePathName(value, fallback);
}

export function canonicalStudentFolderName(
  firstName: string,
  lastName: string,
  generatedStudentId: string,
): string {
  return canonicalStoragePathName(
    `${firstName}_${lastName}_${generatedStudentId}`,
    `Student_${generatedStudentId || "Unknown"}`,
  );
}

export function canonicalProjectFolderName(schoolName: string, projectId: number): string {
  return canonicalStoragePathName(schoolName, `Project ${projectId}`);
}

export function stableCollisionFileName(fileName: string, backupKey: string): string {
  const dot = fileName.lastIndexOf(".");
  const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
  const extension = dot > 0 ? fileName.slice(dot) : "";
  const suffix = createHash("sha256").update(backupKey).digest("hex").slice(0, 12);
  return `${stem}__${suffix}${extension}`;
}

export function clearGoogleDriveFolderCacheForTests(): void {
  folderCache.clear();
  folderInflight.clear();
  uploadInflight.clear();
}

function folderCacheKey(
  cacheScope: string,
  parentId: string | undefined,
  appPropertyKey: string,
  appPropertyValue: string,
): string {
  return JSON.stringify([cacheScope, parentId ?? "root", appPropertyKey, appPropertyValue]);
}

function cacheFolder(key: string, file: DriveFile): void {
  if (!file.id) throw new GoogleDriveBackupError("Google Drive returned a folder without an ID.");
  if (folderCache.size >= FOLDER_CACHE_MAX_ENTRIES) {
    const oldestKey = folderCache.keys().next().value as string | undefined;
    if (oldestKey) folderCache.delete(oldestKey);
  }
  folderCache.set(key, { expiresAt: Date.now() + FOLDER_CACHE_TTL_MS, file });
}

const connectorDriveRequest: DriveRequester = async (
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: unknown } = {},
): Promise<Response> => {
  if (process.env.NODE_ENV === "test") {
    throw new GoogleDriveBackupError("Live Google Drive connector requests are disabled in tests.");
  }
  const response = /^https:\/\//i.test(path)
    ? await fetch(path, {
      ...options as RequestInit,
      signal: AbortSignal.timeout(DIRECT_FETCH_TIMEOUT_MS),
    })
    : await new ReplitConnectors().proxy(CONNECTOR_NAME, path, options);
  return response;
};

let platformDriveRequest: DriveRequester = connectorDriveRequest;

/** Test seam used by integration tests so they never contact the configured connector. */
export function setPlatformDriveRequesterForTests(request?: DriveRequester): void {
  platformDriveRequest = request ?? connectorDriveRequest;
}

async function withMetadataReadSlot<T>(operation: () => Promise<T>): Promise<T> {
  let receivedTransferredPermit = false;
  if (activeMetadataReads >= MAX_CONCURRENT_METADATA_READS) {
    if (metadataWaiters.length >= MAX_METADATA_WAITERS) {
      throw new GoogleDriveBackupError("Google Drive metadata queue is full.");
    }
    let waiter!: () => void;
    const waiting = new Promise<void>((resolve) => {
      waiter = () => {
        receivedTransferredPermit = true;
        resolve();
      };
      metadataWaiters.push(waiter);
    });
    try {
      await withTimeout(waiting, METADATA_TIMEOUT_MS, "Google Drive metadata queue timed out.");
    } catch (error) {
      const index = metadataWaiters.indexOf(waiter);
      if (index >= 0) metadataWaiters.splice(index, 1);
      if (receivedTransferredPermit) releaseMetadataPermit();
      throw error;
    }
  }
  if (!receivedTransferredPermit) activeMetadataReads += 1;
  try {
    return await operation();
  } finally {
    releaseMetadataPermit();
  }
}

function releaseMetadataPermit(): void {
  const next = metadataWaiters.shift();
  if (next) next();
  else activeMetadataReads -= 1;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new GoogleDriveBackupError(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function metadataRequestWithRetry(
  request: DriveRequester,
  path: string,
): Promise<Response> {
  return withMetadataReadSlot(async () => {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const response = await withTimeout(
        request(path),
        METADATA_TIMEOUT_MS,
        "Google Drive metadata request timed out.",
      );
      if (response.status !== 429 && response.status < 500) return response;
      if (attempt === 3) return response;
      const retryAfterSeconds = Number(response.headers.get("retry-after"));
      const delay = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
        ? Math.min(retryAfterSeconds * 1_000, 2_000)
        : 100 * (2 ** attempt);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    throw new GoogleDriveBackupError("Google Drive metadata request retry failed.");
  });
}

async function findFileByAppProperty(
  request: DriveRequester,
  key: string,
  value: string,
  parentId?: string,
): Promise<DriveFile | null> {
  const clauses = [
    `appProperties has { key='${escapeQueryValue(key)}' and value='${escapeQueryValue(value)}' }`,
    "trashed = false",
  ];
  if (parentId) clauses.push(`'${escapeQueryValue(parentId)}' in parents`);

  const query = new URLSearchParams({
    q: clauses.join(" and "),
    fields: "files(id,name,mimeType,webViewLink,size,parents,md5Checksum,appProperties),nextPageToken",
    pageSize: "100",
  });
  const response = await metadataRequestWithRetry(request, `/drive/v3/files?${query.toString()}`);
  if (!response.ok) throw new GoogleDriveBackupError(`Google Drive returned HTTP ${response.status}`);
  const payload = await response.json() as DriveListResponse;
  return payload.files?.[0] ?? null;
}

async function findBackupFile(
  request: DriveRequester,
  backupKey: string,
  studioId: number,
  projectId: number,
  studentId: number,
  subjectType: "student" | "group",
): Promise<DriveFile | null> {
  const properties = [
    ["mcSchoolStudioBackupKey", backupKey],
    ["mcSchoolStudioStudioId", String(studioId)],
    ["mcSchoolStudioProjectId", String(projectId)],
    [subjectType === "group" ? "mcSchoolStudioGroupId" : "mcSchoolStudioStudentId", String(studentId)],
  ] as const;
  const clauses = properties.map(([key, value]) =>
    `appProperties has { key='${escapeQueryValue(key)}' and value='${escapeQueryValue(value)}' }`
  );
  clauses.push("trashed = false");
  const query = new URLSearchParams({
    q: clauses.join(" and "),
    fields: "files(id,name,mimeType,webViewLink,size,parents,md5Checksum,appProperties),nextPageToken",
    pageSize: "100",
  });
  const response = await metadataRequestWithRetry(request, `/drive/v3/files?${query}`);
  if (!response.ok) throw new GoogleDriveBackupError(`Google Drive returned HTTP ${response.status}`);
  const payload = await response.json() as DriveListResponse;
  return payload.files?.[0] ?? null;
}

async function moveFileToParent(
  request: DriveRequester,
  file: DriveFile,
  parentId: string,
): Promise<DriveFile> {
  if (file.parents?.includes(parentId)) return file;
  const query = new URLSearchParams({
    addParents: parentId,
    fields: "id,name,mimeType,webViewLink,size,parents",
  });
  if (file.parents?.length) query.set("removeParents", file.parents.join(","));
  const response = await withTimeout(
    request(`/drive/v3/files/${encodeURIComponent(file.id)}?${query}`, { method: "PATCH" }),
    METADATA_TIMEOUT_MS,
    "Google Drive file move timed out.",
  );
  if (!response.ok) throw new GoogleDriveBackupError(`Google Drive returned HTTP ${response.status}`);
  return await response.json() as DriveFile;
}

async function createFolder(
  request: DriveRequester,
  name: string,
  appPropertyKey: string,
  appPropertyValue: string,
  parentId?: string,
): Promise<DriveFile> {
  const metadata = {
    name,
    mimeType: "application/vnd.google-apps.folder",
    ...(parentId ? { parents: [parentId] } : {}),
    appProperties: {
      [appPropertyKey]: appPropertyValue,
    },
  };
  const query = new URLSearchParams({ fields: "id,name,mimeType,webViewLink" });
  const response = await withTimeout(
    request(`/drive/v3/files?${query.toString()}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(metadata),
    }),
    METADATA_TIMEOUT_MS,
    "Google Drive folder creation timed out.",
  );
  if (!response.ok) throw new GoogleDriveBackupError(`Google Drive returned HTTP ${response.status}`);
  return await response.json() as DriveFile;
}

async function renameFolder(
  request: DriveRequester,
  folder: DriveFile,
  name: string,
): Promise<DriveFile> {
  if (folder.name === name) return folder;
  const query = new URLSearchParams({ fields: "id,name,mimeType,webViewLink" });
  const response = await withTimeout(
    request(`/drive/v3/files/${encodeURIComponent(folder.id)}?${query}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    }),
    METADATA_TIMEOUT_MS,
    "Google Drive folder rename timed out.",
  );
  if (!response.ok) throw new GoogleDriveBackupError(`Google Drive returned HTTP ${response.status}`);
  return await response.json() as DriveFile;
}

async function ensureFolder(
  request: DriveRequester,
  cacheScope: string,
  name: string,
  appPropertyKey: string,
  appPropertyValue: string,
  parentId?: string,
): Promise<DriveFile> {
  const key = folderCacheKey(cacheScope, parentId, appPropertyKey, appPropertyValue);
  const cached = folderCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    const renamed = await renameFolder(request, cached.file, name);
    if (renamed !== cached.file) cacheFolder(key, renamed);
    return renamed;
  }
  if (cached) folderCache.delete(key);

  const pending = folderInflight.get(key);
  if (pending) return pending;
  if (folderInflight.size >= MAX_FOLDER_INFLIGHT) {
    throw new GoogleDriveBackupError("Google Drive folder operation queue is full.");
  }

  const operation = (async () => {
    const existing = await findFileByAppProperty(request, appPropertyKey, appPropertyValue, parentId);
    const folder = existing
      ? await renameFolder(request, existing, name)
      : await createFolder(request, name, appPropertyKey, appPropertyValue, parentId);
    cacheFolder(key, folder);
    return folder;
  })();
  folderInflight.set(key, operation);
  try {
    return await operation;
  } finally {
    if (folderInflight.get(key) === operation) folderInflight.delete(key);
  }
}

async function uploadFile(
  request: DriveRequester,
  filePath: string,
  fileName: string,
  mimeType: string,
  parentId: string,
  backupKey: string,
  studioId: number,
  projectId: number,
  studentId: number,
  fileRole: "JPEG" | "RAW",
  subjectType: "student" | "group",
): Promise<DriveFile> {
  const fileBytes = fs.readFileSync(filePath);
  const contentMd5 = createHash("md5").update(fileBytes).digest("hex");
  const existing = await findBackupFile(
    request,
    backupKey,
    studioId,
    projectId,
    studentId,
    subjectType,
  );
  if (
    existing
    && existing.size === String(fileBytes.length)
    && existing.md5Checksum === contentMd5
    && existing.appProperties?.[
      subjectType === "group" ? "mcSchoolStudioGroupId" : "mcSchoolStudioStudentId"
    ] === String(studentId)
  ) {
    return moveFileToParent(request, existing, parentId);
  }
  if (existing) {
    throw new GoogleDriveBackupError(
      "Google Drive backup integrity conflict: the existing backup key has different file bytes or subject identity.",
    );
  }

  const metadata = JSON.stringify({
    name: fileName,
    parents: [parentId],
    appProperties: {
      mcSchoolStudioBackupKey: backupKey,
      mcSchoolStudioStudioId: String(studioId),
      mcSchoolStudioProjectId: String(projectId),
      [subjectType === "group" ? "mcSchoolStudioGroupId" : "mcSchoolStudioStudentId"]: String(studentId),
      mcSchoolStudioFileRole: fileRole,
    },
  });
  const query = new URLSearchParams({
    uploadType: "resumable",
    fields: "id,name,mimeType,webViewLink,size",
  });
  const sessionResponse = await withTimeout(
    request(`/upload/drive/v3/files?${query.toString()}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Type": mimeType,
        "X-Upload-Content-Length": String(fileBytes.length),
      },
      body: metadata,
    }),
    METADATA_TIMEOUT_MS,
    "Google Drive upload session creation timed out.",
  );
  if (!sessionResponse.ok) {
    throw new GoogleDriveBackupError(`Google Drive returned HTTP ${sessionResponse.status}`);
  }
  const uploadUrl = sessionResponse.headers.get("location");
  if (!uploadUrl || !/^https:\/\//i.test(uploadUrl)) {
    throw new GoogleDriveBackupError("Google Drive did not return a resumable upload URL.");
  }
  const response = await withTimeout(
    request(uploadUrl, {
      method: "PUT",
      headers: {
        "Content-Type": mimeType,
        "Content-Length": String(fileBytes.length),
      },
      body: fileBytes,
    }),
    UPLOAD_TIMEOUT_MS,
    "Google Drive upload timed out.",
  );
  if (!response.ok) throw new GoogleDriveBackupError(`Google Drive returned HTTP ${response.status}`);
  const uploaded = await response.json() as DriveFile;
  if (!uploaded.id) throw new GoogleDriveBackupError("Google Drive upload response did not include a file ID.");
  return uploaded;
}

async function resolvePlatformCacheScope(request: DriveRequester): Promise<string> {
  const query = new URLSearchParams({ fields: "user(permissionId)" });
  const response = await metadataRequestWithRetry(request, `/drive/v3/about?${query}`);
  if (!response.ok) throw new GoogleDriveBackupError(`Google Drive returned HTTP ${response.status}`);
  const payload = await response.json() as { user?: { permissionId?: string } };
  if (!payload.user?.permissionId) {
    throw new GoogleDriveBackupError("Google Drive did not return the connected account identity.");
  }
  return `google-drive:platform-account:${payload.user.permissionId}`;
}

export async function backupFileToGoogleDrive(
  input: DriveBackupInput,
  request: DriveRequester = platformDriveRequest,
  cacheScope?: string,
): Promise<DriveFile> {
  if (!fs.existsSync(input.filePath)) {
    throw new GoogleDriveBackupError("The local file is missing before Google Drive backup.");
  }

  const resolvedCacheScope = cacheScope ?? await resolvePlatformCacheScope(request);
  const inflightKey = JSON.stringify([
    resolvedCacheScope,
    input.studioId,
    input.projectId,
    input.subjectType ?? "student",
    input.studentId,
    input.backupKey,
  ]);
  const pending = uploadInflight.get(inflightKey);
  if (pending) return pending;
  if (uploadInflight.size >= MAX_UPLOAD_INFLIGHT) {
    throw new GoogleDriveBackupError("Google Drive upload queue is full.");
  }
  const operation = backupFileToGoogleDriveScoped(input, request, resolvedCacheScope);
  uploadInflight.set(inflightKey, operation);
  try {
    return await operation;
  } finally {
    if (uploadInflight.get(inflightKey) === operation) uploadInflight.delete(inflightKey);
  }
}

async function backupFileToGoogleDriveScoped(
  input: DriveBackupInput,
  request: DriveRequester,
  cacheScope: string,
): Promise<DriveFile> {
  const root = await ensureFolder(request, cacheScope, ROOT_FOLDER_NAME, ROOT_FOLDER_KEY, ROOT_FOLDER_VALUE);
  if (!root.id) throw new GoogleDriveBackupError("Google Drive did not return the backup root folder ID.");

  const studio = await ensureFolder(
    request,
    cacheScope,
    driveName(input.studioName, `Studio ${input.studioId}`),
    "mcSchoolStudioStudioId",
    String(input.studioId),
    root.id,
  );
  if (!studio.id) throw new GoogleDriveBackupError("Google Drive did not return the studio folder ID.");

  const project = await ensureFolder(
    request,
    cacheScope,
    canonicalProjectFolderName(input.schoolName, input.projectId),
    "mcSchoolStudioProjectId",
    String(input.projectId),
    studio.id,
  );
  if (!project.id) throw new GoogleDriveBackupError("Google Drive did not return the project folder ID.");

  const classFolder = await ensureFolder(
    request,
    cacheScope,
    driveName(input.className, `Class ${input.classId}`),
    "mcSchoolStudioClassId",
    String(input.classId),
    project.id,
  );
  if (!classFolder.id) throw new GoogleDriveBackupError("Google Drive did not return the class folder ID.");

  const studentFolder = await ensureFolder(
    request,
    cacheScope,
    driveName(input.studentFolderName, `Student ${input.studentId}`),
    input.subjectType === "group" ? "mcSchoolStudioGroupId" : "mcSchoolStudioStudentId",
    String(input.studentId),
    classFolder.id,
  );
  if (!studentFolder.id) throw new GoogleDriveBackupError("Google Drive did not return the student folder ID.");

  return uploadFile(
    request,
    input.filePath,
    input.fileName,
    input.fileRole === "JPEG" ? "image/jpeg" : "application/octet-stream",
    studentFolder.id,
    input.backupKey,
    input.studioId,
    input.projectId,
    input.studentId,
    input.fileRole,
    input.subjectType ?? "student",
  );
}