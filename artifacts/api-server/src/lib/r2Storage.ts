import {
  createHash,
  createHmac,
  type BinaryLike,
} from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";

const EMPTY_SHA256 = createHash("sha256").update("").digest("hex");
const SIGNED_HEADERS = "host;x-amz-content-sha256;x-amz-date";

export interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  region: string;
  endpoint: string;
}

export interface R2ObjectMetadata {
  contentLength: number | null;
  contentType: string | null;
  etag: string | null;
  sha256: string | null;
}

export function getR2Config(
  env: NodeJS.ProcessEnv = process.env,
): R2Config | null {
  const accountId = env.R2_ACCOUNT_ID?.trim();
  const accessKeyId = env.R2_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.R2_SECRET_ACCESS_KEY?.trim();
  const bucket = env.R2_BUCKET_NAME?.trim();
  const configured = [accountId, accessKeyId, secretAccessKey, bucket];

  if (configured.every((value) => !value)) return null;
  if (configured.some((value) => !value)) {
    throw new Error(
      "R2 configuration is incomplete; R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, and R2_BUCKET_NAME must be set together",
    );
  }

  const region = env.R2_REGION?.trim() || "auto";
  const endpoint =
    env.R2_ENDPOINT?.trim().replace(/\/+$/, "") ||
    `https://${accountId}.r2.cloudflarestorage.com`;

  return {
    accountId: accountId!,
    accessKeyId: accessKeyId!,
    secretAccessKey: secretAccessKey!,
    bucket: bucket!,
    region,
    endpoint,
  };
}

function sha256(value: BinaryLike): string {
  return createHash("sha256").update(value).digest("hex");
}

function hmac(key: BinaryLike, value: string): Buffer {
  return createHmac("sha256", key).update(value).digest();
}

function encodePath(path: string): string {
  return path
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

function signingKey(
  secretAccessKey: string,
  date: string,
  region: string,
): Buffer {
  const dateKey = hmac(`AWS4${secretAccessKey}`, date);
  const regionKey = hmac(dateKey, region);
  const serviceKey = hmac(regionKey, "s3");
  return hmac(serviceKey, "aws4_request");
}

function signedHeaders(
  config: R2Config,
  method: string,
  objectKey: string | null,
  payloadHash: string,
  now = new Date(),
): { headers: Headers; url: string } {
  const base = new URL(config.endpoint);
  const path = objectKey
    ? `/${encodePath(config.bucket)}/${encodePath(objectKey)}`
    : `/${encodePath(config.bucket)}`;
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const shortDate = amzDate.slice(0, 8);
  const canonicalHeaders =
    `host:${base.host}\n` +
    `x-amz-content-sha256:${payloadHash}\n` +
    `x-amz-date:${amzDate}\n`;
  const canonicalRequest = [
    method,
    path,
    "",
    canonicalHeaders,
    SIGNED_HEADERS,
    payloadHash,
  ].join("\n");
  const scope = `${shortDate}/${config.region}/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    sha256(canonicalRequest),
  ].join("\n");
  const signature = createHmac(
    "sha256",
    signingKey(config.secretAccessKey, shortDate, config.region),
  )
    .update(stringToSign)
    .digest("hex");
  const headers = new Headers({
    authorization:
      `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope}, ` +
      `SignedHeaders=${SIGNED_HEADERS}, Signature=${signature}`,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  });

  return { headers, url: new URL(path, `${config.endpoint}/`).toString() };
}

async function expectR2Response(
  response: Response,
  operation: string,
): Promise<Response> {
  if (response.ok) return response;
  const body = (await response.text()).slice(0, 1_000);
  throw new Error(
    `R2 ${operation} failed (${response.status} ${response.statusText})${body ? `: ${body}` : ""}`,
  );
}

export async function checkR2Bucket(
  config = getR2Config(),
): Promise<void> {
  if (!config) throw new Error("R2 is not configured");
  const request = signedHeaders(config, "HEAD", null, EMPTY_SHA256);
  await expectR2Response(
    await fetch(request.url, { method: "HEAD", headers: request.headers }),
    "bucket check",
  );
}

export async function putR2File(
  objectKey: string,
  filePath: string,
  options: { contentType?: string; sha256?: string } = {},
  config = getR2Config(),
): Promise<R2ObjectMetadata> {
  if (!config) throw new Error("R2 is not configured");
  const file = await stat(filePath);
  const payloadHash =
    options.sha256 ||
    (await new Promise<string>((resolve, reject) => {
      const hash = createHash("sha256");
      createReadStream(filePath)
        .on("data", (chunk) => hash.update(chunk))
        .on("error", reject)
        .on("end", () => resolve(hash.digest("hex")));
    }));
  const request = signedHeaders(config, "PUT", objectKey, payloadHash);
  request.headers.set("content-length", String(file.size));
  if (options.contentType) {
    request.headers.set("content-type", options.contentType);
  }
  request.headers.set("x-amz-meta-sha256", payloadHash);
  const body = Readable.toWeb(createReadStream(filePath)) as ReadableStream;
  const response = await expectR2Response(
    await fetch(request.url, {
      method: "PUT",
      headers: request.headers,
      body,
      duplex: "half",
    }),
    "upload",
  );

  return {
    contentLength: file.size,
    contentType: options.contentType || null,
    etag: response.headers.get("etag"),
    sha256: payloadHash,
  };
}

export async function headR2Object(
  objectKey: string,
  config = getR2Config(),
): Promise<R2ObjectMetadata | null> {
  if (!config) throw new Error("R2 is not configured");
  const request = signedHeaders(config, "HEAD", objectKey, EMPTY_SHA256);
  const response = await fetch(request.url, {
    method: "HEAD",
    headers: request.headers,
  });
  if (response.status === 404) return null;
  await expectR2Response(response, "object check");

  const contentLength = Number(response.headers.get("content-length"));
  return {
    contentLength: Number.isFinite(contentLength) ? contentLength : null,
    contentType: response.headers.get("content-type"),
    etag: response.headers.get("etag"),
    sha256: response.headers.get("x-amz-meta-sha256"),
  };
}

export async function getR2Object(
  objectKey: string,
  config = getR2Config(),
): Promise<Response> {
  if (!config) throw new Error("R2 is not configured");
  const request = signedHeaders(config, "GET", objectKey, EMPTY_SHA256);
  return expectR2Response(
    await fetch(request.url, { method: "GET", headers: request.headers }),
    "download",
  );
}