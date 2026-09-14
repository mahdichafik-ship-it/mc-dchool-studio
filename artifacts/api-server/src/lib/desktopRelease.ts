import { GetDesktopReleaseResponse } from "@workspace/api-zod";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import type { Request, Response as ExpressResponse } from "express";

export const DESKTOP_RELEASE_REPOSITORY = "mahdichafik-ship-it/mc-dchool-studio";
const GITHUB_LATEST_RELEASE_URL =
  `https://api.github.com/repos/${DESKTOP_RELEASE_REPOSITORY}/releases/latest`;
const GITHUB_REPOSITORY_URL = `https://github.com/${DESKTOP_RELEASE_REPOSITORY}`;
const CACHE_TTL_MS = 10 * 60_000;
const FAILURE_CACHE_TTL_MS = 15_000;
const GITHUB_TIMEOUT_MS = 5_000;
const MAX_GITHUB_API_BYTES = 2 * 1024 * 1024;
const MAX_METADATA_BYTES = 256 * 1024;
const ALLOWED_METADATA_FINAL_HOSTS = new Set([
  "github.com",
  "release-assets.githubusercontent.com",
]);

type DesktopRelease = ReturnType<typeof GetDesktopReleaseResponse.parse>;
type GitHubAsset = {
  name?: unknown;
  browser_download_url?: unknown;
  size?: unknown;
  state?: unknown;
  digest?: unknown;
};

type GitHubRelease = {
  tag_name?: unknown;
  draft?: unknown;
  prerelease?: unknown;
  published_at?: unknown;
  html_url?: unknown;
  assets?: unknown;
};

let cachedRelease: { value: DesktopRelease; expiresAt: number } | null = null;
let cachedFailure: { error: Error; expiresAt: number } | null = null;
let inFlightRelease: Promise<DesktopRelease> | null = null;
let cacheGeneration = 0;

type UpdaterFile = { url: string; sha512: string };
type UpdaterMetadata = {
  version: string;
  files: UpdaterFile[];
  path: string;
  sha512: string;
};

function isExactGitHubUrl(value: unknown, expected: string): value is string {
  return value === expected;
}

function validPublishedAt(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function validSha512(value: string): boolean {
  if (/^[a-f\d]{128}$/i.test(value)) return true;
  if (!/^[A-Za-z\d+/]{86}==$/.test(value)) return false;
  try {
    const decoded = Buffer.from(value, "base64");
    return decoded.length === 64 && decoded.toString("base64") === value;
  } catch {
    return false;
  }
}

function validSha256Digest(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
}

function sha256Digest(value: Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function scalar(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    return trimmed.slice(1, -1);
  }
  if (trimmed.startsWith("'") || trimmed.startsWith('"')) return null;
  return trimmed;
}

/**
 * Parse the small, stable subset emitted by electron-builder. Rejecting
 * unknown structure avoids treating arbitrary YAML as updater metadata.
 */
export function parseUpdaterMetadata(value: string): UpdaterMetadata | null {
  const lines = value.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split("\n");
  let version: string | undefined;
  let path: string | undefined;
  let sha512: string | undefined;
  let filesStarted = false;
  let current: (UpdaterFile & { size?: number }) | null = null;
  const files: Array<UpdaterFile & { size?: number }> = [];
  const topKeys = new Set<string>();

  const finishFile = (): boolean => {
    if (!current || !validSha512(current.sha512) || files.some((file) => file.url === current?.url)) {
      return false;
    }
    files.push(current);
    current = null;
    return true;
  };

  for (const line of lines) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    if (line.includes("\t")) return null;

    const itemMatch = /^  - url:\s*(.*)$/.exec(line);
    if (itemMatch) {
      if (!filesStarted || (current && !finishFile())) return null;
      const url = scalar(itemMatch[1]);
      if (!url) return null;
      current = { url, sha512: "" };
      continue;
    }

    const filePropertyMatch = /^    ([A-Za-z][A-Za-z0-9]*):(?:\s*(.*))?$/.exec(line);
    if (filePropertyMatch && current) {
      const key = filePropertyMatch[1];
      const rawValue = scalar(filePropertyMatch[2] ?? "");
      if (!rawValue || (key !== "sha512" && key !== "size")) return null;
      if (key === "sha512") {
        if (current.sha512) return null;
        current.sha512 = rawValue;
      } else {
        if (current.size !== undefined || !/^[1-9]\d*$/.test(rawValue)) return null;
        current.size = Number(rawValue);
        if (!Number.isSafeInteger(current.size)) return null;
      }
      continue;
    }

    const topMatch = /^([A-Za-z][A-Za-z0-9]*):(?:\s*(.*))?$/.exec(line);
    if (!topMatch) return null;
    const key = topMatch[1];
    if (topKeys.has(key)) return null;
    topKeys.add(key);
    if (key === "files") {
      if (topMatch[2]?.trim()) return null;
      filesStarted = true;
    } else if (key === "version" || key === "path" || key === "sha512") {
      const parsed = scalar(topMatch[2] ?? "");
      if (!parsed) return null;
      if (key === "version") version = parsed;
      else if (key === "path") path = parsed;
      else sha512 = parsed;
    } else if (key !== "releaseDate") {
      return null;
    }
  }
  if (current && !finishFile()) return null;
  if (!version || !filesStarted || !path || !sha512 || !files.length || !validSha512(sha512)) {
    return null;
  }
  const preferred = files.find((file) => file.url === path);
  if (!preferred || preferred.sha512 !== sha512) return null;
  return { version, files: files.map(({ url, sha512: fileSha512 }) => ({ url, sha512: fileSha512 })), path, sha512 };
}

function hasValidUploadedAsset(
  assets: GitHubAsset[],
  name: string,
  expectedUrl: string,
): GitHubAsset | undefined {
  return assets.find(
    (candidate) =>
      candidate !== null &&
      typeof candidate === "object" &&
      candidate.name === name &&
      candidate.state === "uploaded" &&
      candidate.browser_download_url === expectedUrl &&
      Number.isSafeInteger(candidate.size) &&
      (candidate.size as number) > 0 &&
      validSha256Digest(candidate.digest),
  );
}

function releaseAsset(
  assets: GitHubAsset[],
  version: string,
  tag: string,
  architecture: "arm64" | "x64",
  metadata: UpdaterMetadata,
): DesktopRelease["architectures"]["arm64"] | undefined {
  const assetBase = `mc-school-studio-${version}-${architecture}`;
  const releaseDownloadBase = `${GITHUB_REPOSITORY_URL}/releases/download/${tag}`;
  const dmgFilename = `${assetBase}.dmg`;
  const dmgUrl = `${releaseDownloadBase}/${dmgFilename}`;
  const requiredAssetNames = [
    dmgFilename,
    `${assetBase}.dmg.blockmap`,
    `${assetBase}.zip`,
    `${assetBase}.zip.blockmap`,
  ];
  if (
    requiredAssetNames.some(
      (name) =>
        !hasValidUploadedAsset(assets, name, `${releaseDownloadBase}/${name}`),
    )
  ) {
    return undefined;
  }
  const asset = hasValidUploadedAsset(assets, dmgFilename, dmgUrl);
  const zipFilename = `${assetBase}.zip`;
  if (!asset || !metadata.files.some((file) => file.url === zipFilename && validSha512(file.sha512))) {
    return undefined;
  }
  // ZIP SHA-512 byte validation is a signed release CI publication gate.
  // Runtime discovery validates GitHub digests and manifest structure without
  // downloading hundreds of megabytes of ZIPs to rehash them.
  return {
    displayName: architecture === "arm64" ? "Apple Silicon" : "Intel",
    asset: {
      url: dmgUrl,
      size: asset.size as number,
    },
  };
}

/**
 * Validates the untrusted response from GitHub and returns the narrow public
 * contract. This deliberately validates each architecture independently.
 */
function validateGitHubReleasePayload(payload: unknown): {
  version: string;
  tag: string;
  publishedAt: string;
  releasePage: string;
  updaterMetadataUrl: string;
  assets: GitHubAsset[];
  metadataDigest: string;
} | null {
  if (!payload || typeof payload !== "object") return null;
  const release = payload as GitHubRelease;
  if (
    typeof release.tag_name !== "string" ||
    !/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(release.tag_name) ||
    release.draft !== false ||
    release.prerelease !== false ||
    !validPublishedAt(release.published_at)
  ) {
    return null;
  }

  const tag = release.tag_name;
  const version = tag.slice(1);
  const releasePage = `${GITHUB_REPOSITORY_URL}/releases/tag/${tag}`;
  if (!isExactGitHubUrl(release.html_url, releasePage) || !Array.isArray(release.assets)) {
    return null;
  }

  const assets = release.assets as GitHubAsset[];
  const updaterMetadataFilename = "latest-mac.yml";
  const updaterMetadataUrl = `${GITHUB_REPOSITORY_URL}/releases/download/${tag}/${updaterMetadataFilename}`;
  const metadataAsset = hasValidUploadedAsset(assets, updaterMetadataFilename, updaterMetadataUrl);
  if (!metadataAsset) {
    return null;
  }
  return {
    version,
    tag,
    publishedAt: new Date(release.published_at).toISOString(),
    releasePage,
    updaterMetadataUrl,
    assets,
    metadataDigest: metadataAsset.digest as string,
  };
}

export function validateGitHubRelease(
  payload: unknown,
  metadataContent: string,
): DesktopRelease | null {
  const candidate = validateGitHubReleasePayload(payload);
  if (!candidate) return null;
  if (candidate.metadataDigest !== sha256Digest(Buffer.from(metadataContent, "utf8"))) {
    return null;
  }
  const metadata = parseUpdaterMetadata(metadataContent);
  if (!metadata || metadata.version !== candidate.version) return null;
  const expectedZipNames = new Set([
    `mc-school-studio-${candidate.version}-arm64.zip`,
    `mc-school-studio-${candidate.version}-x64.zip`,
  ]);
  if (!expectedZipNames.has(metadata.path)) return null;
  const architectures: DesktopRelease["architectures"] = {};
  const arm64 = releaseAsset(candidate.assets, candidate.version, candidate.tag, "arm64", metadata);
  const x64 = releaseAsset(candidate.assets, candidate.version, candidate.tag, "x64", metadata);
  if (arm64) architectures.arm64 = arm64;
  if (x64) architectures.x64 = x64;
  if (!arm64 && !x64) return null;

  return GetDesktopReleaseResponse.parse({
    version: candidate.version,
    publishedAt: candidate.publishedAt,
    releasePage: candidate.releasePage,
    platforms: ["macos"],
    architectures,
  });
}

export function clearDesktopReleaseCache(): void {
  cachedRelease = null;
  cachedFailure = null;
  inFlightRelease = null;
  cacheGeneration += 1;
}

async function fetchWithTimeout<T>(
  fetcher: typeof fetch,
  url: string,
  init: RequestInit,
  consume: (response: globalThis.Response) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GITHUB_TIMEOUT_MS);
  try {
    const response = await fetcher(url, { ...init, signal: controller.signal });
    return await consume(response);
  } finally {
    clearTimeout(timeout);
  }
}

async function readBoundedResponse(
  response: globalThis.Response,
  maxBytes: number,
  tooLargeMessage: string,
): Promise<Uint8Array> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    if (!/^\d+$/.test(declaredLength) || Number(declaredLength) > maxBytes) {
      throw new Error(tooLargeMessage);
    }
  }
  if (!response.body) throw new Error("Response has no readable body");
  const reader = response.body.getReader();
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw new Error(tooLargeMessage);
      }
      chunks.push(chunk.value);
    }
    const body = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return body;
  } finally {
    reader.releaseLock();
  }
}

async function readMetadataResponse(
  response: globalThis.Response,
): Promise<{ content: string; digest: string }> {
  const body = await readBoundedResponse(
    response,
    MAX_METADATA_BYTES,
    "Updater metadata response is too large",
  );
  const content = new TextDecoder("utf-8", { fatal: true }).decode(body);
  return { content, digest: sha256Digest(body) };
}

async function fetchReleaseUncached(fetcher: typeof fetch): Promise<DesktopRelease> {
  const payload = await fetchWithTimeout(
    fetcher,
    GITHUB_LATEST_RELEASE_URL,
    {
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
    async (response) => {
      if (!response.ok) {
        throw new Error(`GitHub Releases API returned ${response.status}`);
      }
      const body = await readBoundedResponse(
        response,
        MAX_GITHUB_API_BYTES,
        "GitHub Releases API response is too large",
      );
      let parsed: unknown;
      try {
        parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
      } catch {
        throw new Error("GitHub Releases API returned invalid JSON");
      }
      if (!validateGitHubReleasePayload(parsed)) {
        throw new Error("GitHub latest release did not contain valid desktop assets");
      }
      return parsed;
    },
  );
  const candidate = validateGitHubReleasePayload(payload);
  if (!candidate) {
    throw new Error("GitHub latest release did not contain valid desktop assets");
  }
  return fetchWithTimeout(
    fetcher,
    candidate.updaterMetadataUrl,
    {
      headers: { Accept: "text/plain, application/yaml" },
    },
    async (metadataResponse) => {
      if (!metadataResponse.ok) {
        throw new Error(`Updater metadata returned ${metadataResponse.status}`);
      }
      if (metadataResponse.url) {
        const finalUrl = new URL(metadataResponse.url);
        if (finalUrl.protocol !== "https:" || !ALLOWED_METADATA_FINAL_HOSTS.has(finalUrl.hostname)) {
          throw new Error("Updater metadata redirected to an unexpected host");
        }
      }
      const metadata = await readMetadataResponse(metadataResponse);
      if (metadata.digest !== candidate.metadataDigest) {
        throw new Error("Updater metadata digest did not match the GitHub asset");
      }
      const release = validateGitHubRelease(payload, metadata.content);
      if (!release) {
        throw new Error("Updater metadata did not contain valid desktop assets");
      }
      return release;
    },
  );
}

export async function fetchDesktopRelease(fetcher: typeof fetch = fetch): Promise<DesktopRelease> {
  if (cachedRelease && cachedRelease.expiresAt > Date.now()) {
    return cachedRelease.value;
  }
  if (cachedFailure && cachedFailure.expiresAt > Date.now()) {
    throw cachedFailure.error;
  }
  if (inFlightRelease) {
    return inFlightRelease;
  }
  const generation = cacheGeneration;
  let request: Promise<DesktopRelease> | undefined;
  request = (async () => {
    try {
      const release = await fetchReleaseUncached(fetcher);
      if (generation === cacheGeneration) {
        cachedRelease = { value: release, expiresAt: Date.now() + CACHE_TTL_MS };
        cachedFailure = null;
      }
      return release;
    } catch (error) {
      const failure = error instanceof Error ? error : new Error("Desktop release lookup failed");
      if (generation === cacheGeneration) {
        cachedFailure = { error: failure, expiresAt: Date.now() + FAILURE_CACHE_TTL_MS };
      }
      throw failure;
    } finally {
      if (request && inFlightRelease === request) inFlightRelease = null;
    }
  })();
  inFlightRelease = request;
  return request;
}

export function createDesktopReleaseHandler(
  releaseFetcher: () => Promise<DesktopRelease> = fetchDesktopRelease,
) {
  return async (
    req: Request & { log?: { warn: (context: object, message: string) => void } },
    res: ExpressResponse,
  ): Promise<void> => {
    try {
      res.json(await releaseFetcher());
    } catch (error) {
      req.log?.warn({ err: error }, "Desktop release metadata unavailable");
      res.status(503).json({ error: "A current desktop release is unavailable." });
    }
  };
}
