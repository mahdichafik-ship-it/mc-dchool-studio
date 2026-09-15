import type { NextFunction, Request, Response } from "express";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function normalizedOrigin(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

export function trustedBrowserOrigins(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const origins = new Set<string>();
  const configured = [
    env.PUBLIC_APP_URL,
    ...(env.REPLIT_DOMAINS ?? "").split(",").map((host) => host.trim() ? `https://${host.trim()}` : ""),
    env.REPLIT_DEV_DOMAIN?.trim() ? `https://${env.REPLIT_DEV_DOMAIN.trim()}` : "",
  ];
  for (const value of configured) {
    const origin = normalizedOrigin(value);
    if (origin) origins.add(origin);
  }
  if (env.NODE_ENV !== "production") {
    for (const port of [3000, 5173, 26125]) {
      origins.add(`http://localhost:${port}`);
      origins.add(`http://127.0.0.1:${port}`);
    }
  }
  return origins;
}

export function browserOriginIsTrusted(origin: string | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  const normalized = normalizedOrigin(origin);
  return normalized !== null && trustedBrowserOrigins(env).has(normalized);
}

export function corsOrigin(
  origin: string | undefined,
  callback: (error: Error | null, allow?: boolean) => void,
): void {
  callback(null, origin === undefined || browserOriginIsTrusted(origin));
}

export function requireTrustedMutationOrigin(req: Request, res: Response, next: NextFunction): void {
  if (SAFE_METHODS.has(req.method)) {
    next();
    return;
  }
  const origin = req.header("origin");
  if (origin && !browserOriginIsTrusted(origin)) {
    res.status(403).json({ error: "This request origin is not allowed" });
    return;
  }
  if (!origin && req.header("sec-fetch-site") === "cross-site") {
    res.status(403).json({ error: "Cross-site mutations are not allowed" });
    return;
  }
  next();
}