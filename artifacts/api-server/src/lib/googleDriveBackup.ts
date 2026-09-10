import { ReplitConnectors } from "@replit/connectors-sdk";
import fs from "node:fs";

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
};

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

function driveName(value: string, fallback: string): string {
  const cleaned = value.trim().replace(/\s+/g, " ");
  return (cleaned || fallback).slice(0, 180);
}

const platformDriveRequest: DriveRequester = async (
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: unknown } = {},
): Promise<Response> => {
  const response = /^https:\/\//i.test(path)
    ? await fetch(path, options as RequestInit)
    : await new ReplitConnectors().proxy(CONNECTOR_NAME, path, options);
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new GoogleDriveBackupError(
      `Google Drive returned HTTP ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`,
    );
  }
  return response;
};

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
    fields: "files(id,name,mimeType,webViewLink,size),nextPageToken",
    pageSize: "100",
  });
  const response = await request(`/drive/v3/files?${query.toString()}`);
  if (!response.ok) throw new GoogleDriveBackupError(`Google Drive returned HTTP ${response.status}`);
  const payload = await response.json() as DriveListResponse;
  return payload.files?.[0] ?? null;
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
  const response = await request(`/drive/v3/files?${query.toString()}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(metadata),
  });
  if (!response.ok) throw new GoogleDriveBackupError(`Google Drive returned HTTP ${response.status}`);
  return await response.json() as DriveFile;
}

async function ensureFolder(
  request: DriveRequester,
  name: string,
  appPropertyKey: string,
  appPropertyValue: string,
  parentId?: string,
): Promise<DriveFile> {
  const existing = await findFileByAppProperty(request, appPropertyKey, appPropertyValue, parentId);
  if (existing) return existing;
  return createFolder(request, name, appPropertyKey, appPropertyValue, parentId);
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
): Promise<DriveFile> {
  const existing = await findFileByAppProperty(request, "mcSchoolStudioBackupKey", backupKey);
  if (existing) return existing;

  const fileBytes = fs.readFileSync(filePath);
  const metadata = JSON.stringify({
    name: fileName,
    parents: [parentId],
    appProperties: {
      mcSchoolStudioBackupKey: backupKey,
      mcSchoolStudioStudioId: String(studioId),
      mcSchoolStudioProjectId: String(projectId),
      mcSchoolStudioStudentId: String(studentId),
      mcSchoolStudioFileRole: fileRole,
    },
  });
  const query = new URLSearchParams({
    uploadType: "resumable",
    fields: "id,name,mimeType,webViewLink,size",
  });
  const sessionResponse = await request(`/upload/drive/v3/files?${query.toString()}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=UTF-8",
      "X-Upload-Content-Type": mimeType,
      "X-Upload-Content-Length": String(fileBytes.length),
    },
    body: metadata,
  });
  const uploadUrl = sessionResponse.headers.get("location");
  if (!uploadUrl || !/^https:\/\//i.test(uploadUrl)) {
    throw new GoogleDriveBackupError("Google Drive did not return a resumable upload URL.");
  }
  const response = await request(uploadUrl, {
    method: "PUT",
    headers: {
      "Content-Type": mimeType,
      "Content-Length": String(fileBytes.length),
    },
    body: fileBytes,
  });
  if (!response.ok) throw new GoogleDriveBackupError(`Google Drive returned HTTP ${response.status}`);
  return await response.json() as DriveFile;
}

export async function backupFileToGoogleDrive(
  input: DriveBackupInput,
  request: DriveRequester = platformDriveRequest,
): Promise<DriveFile> {
  if (!fs.existsSync(input.filePath)) {
    throw new GoogleDriveBackupError("The local file is missing before Google Drive backup.");
  }

  const root = await ensureFolder(request, ROOT_FOLDER_NAME, ROOT_FOLDER_KEY, ROOT_FOLDER_VALUE);
  if (!root.id) throw new GoogleDriveBackupError("Google Drive did not return the backup root folder ID.");

  const studio = await ensureFolder(
    request,
    driveName(input.studioName, `Studio ${input.studioId}`),
    "mcSchoolStudioStudioId",
    String(input.studioId),
    root.id,
  );
  if (!studio.id) throw new GoogleDriveBackupError("Google Drive did not return the studio folder ID.");

  const project = await ensureFolder(
    request,
    driveName(`${input.schoolName} (Project ${input.projectId})`, `Project ${input.projectId}`),
    "mcSchoolStudioProjectId",
    String(input.projectId),
    studio.id,
  );
  if (!project.id) throw new GoogleDriveBackupError("Google Drive did not return the project folder ID.");

  const classFolder = await ensureFolder(
    request,
    driveName(input.className, `Class ${input.classId}`),
    "mcSchoolStudioClassId",
    String(input.classId),
    project.id,
  );
  if (!classFolder.id) throw new GoogleDriveBackupError("Google Drive did not return the class folder ID.");

  const studentFolder = await ensureFolder(
    request,
    driveName(input.studentFolderName, `Student ${input.studentId}`),
    "mcSchoolStudioStudentId",
    String(input.studentId),
    classFolder.id,
  );
  if (!studentFolder.id) throw new GoogleDriveBackupError("Google Drive did not return the student folder ID.");

  const roleFolder = await ensureFolder(
    request,
    input.fileRole,
    "mcSchoolStudioRoleFolder",
    `${input.studentId}:${input.fileRole}`,
    studentFolder.id,
  );
  if (!roleFolder.id) throw new GoogleDriveBackupError("Google Drive did not return the file-role folder ID.");

  return uploadFile(
    request,
    input.filePath,
    input.fileName,
    input.fileRole === "JPEG" ? "image/jpeg" : "application/octet-stream",
    roleFolder.id,
    input.backupKey,
    input.studioId,
    input.projectId,
    input.studentId,
    input.fileRole,
  );
}