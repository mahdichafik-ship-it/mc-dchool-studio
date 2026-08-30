import type { NextFunction, Request, Response } from "express";
import { getUserEmail } from "./studioAccess";

function configuredPlatformOwnerIds() {
  return (process.env.PLATFORM_OWNER_USER_ID ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

export function platformOwnerIsConfigured() {
  return configuredPlatformOwnerIds().length > 0 || Boolean(process.env.PLATFORM_OWNER_EMAIL?.trim());
}

export async function isPlatformOwner(userId: string) {
  const ownerIds = configuredPlatformOwnerIds();
  if (ownerIds.includes(userId)) return true;

  const configuredEmail = process.env.PLATFORM_OWNER_EMAIL?.trim().toLowerCase();
  if (!configuredEmail) return false;
  return (await getUserEmail(userId)) === configuredEmail;
}

export async function requirePlatformOwner(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const userId = (req as any).userId as string | undefined;
  if (!userId || !(await isPlatformOwner(userId))) {
    res.status(403).json({ error: "Platform owner access is required" });
    return;
  }
  next();
}