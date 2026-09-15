import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { Readable } from "node:stream";
import { File, Storage } from "@google-cloud/storage";

const REPLIT_SIDECAR_ENDPOINT = "http://127.0.0.1:1106";

export const objectStorageClient = new Storage({
  credentials: {
    audience: "replit",
    subject_token_type: "access_token",
    token_url: `${REPLIT_SIDECAR_ENDPOINT}/token`,
    type: "external_account",
    credential_source: {
      url: `${REPLIT_SIDECAR_ENDPOINT}/credential`,
      format: { type: "json", subject_token_field_name: "access_token" },
    },
    universe_domain: "googleapis.com",
  },
  projectId: "",
});

export class ObjectNotFoundError extends Error {
  constructor() {
    super("Object not found");
    this.name = "ObjectNotFoundError";
  }
}

export class ObjectStorageService {
  private privateObjectDir(): string {
    const dir = process.env.PRIVATE_OBJECT_DIR;
    if (!dir) throw new Error("PRIVATE_OBJECT_DIR is not configured");
    return dir.replace(/\/$/, "");
  }

  async getObjectEntityUploadURL(): Promise<string> {
    const [bucketName, ...dirParts] = this.privateObjectDir().replace(/^\//, "").split("/");
    const objectName = `${dirParts.join("/")}/uploads/${randomUUID()}`;
    const response = await fetch(`${REPLIT_SIDECAR_ENDPOINT}/object-storage/signed-object-url`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        bucket_name: bucketName,
        object_name: objectName,
        method: "PUT",
        expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Could not create object upload URL (${response.status})`);
    const body = await response.json() as { signed_url?: string };
    if (!body.signed_url) throw new Error("Object storage did not return an upload URL");
    return body.signed_url;
  }

  normalizeObjectEntityPath(uploadURL: string): string {
    const url = new URL(uploadURL);
    const dir = this.privateObjectDir();
    const rawObjectPath = url.pathname;
    if (!rawObjectPath.startsWith(dir)) throw new Error("Signed object URL is outside the private object directory");
    return `/objects/${rawObjectPath.slice(dir.length).replace(/^\/+/, "")}`;
  }

  async uploadLocalFile(localPath: string, contentType: string): Promise<string> {
    const uploadURL = await this.getObjectEntityUploadURL();
    const response = await fetch(uploadURL, {
      method: "PUT",
      headers: { "Content-Type": contentType },
      body: Readable.toWeb(fs.createReadStream(localPath)) as unknown as any,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    if (!response.ok) throw new Error(`Could not upload photo to object storage (${response.status})`);
    return this.normalizeObjectEntityPath(uploadURL);
  }

  async getObjectEntityFile(objectPath: string): Promise<File> {
    if (!objectPath.startsWith("/objects/")) throw new ObjectNotFoundError();
    const [bucketName, ...dirParts] = this.privateObjectDir().replace(/^\//, "").split("/");
    const objectName = [...dirParts, objectPath.slice("/objects/".length)].join("/");
    const file = objectStorageClient.bucket(bucketName).file(objectName);
    const [exists] = await file.exists();
    if (!exists) throw new ObjectNotFoundError();
    return file;
  }
}

export const objectStorageService = new ObjectStorageService();