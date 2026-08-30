import pino from "pino";

const isProduction = process.env.NODE_ENV === "production";
const isTest = process.env.NODE_ENV === "test" || !!process.env.NODE_TEST_CONTEXT;

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: [
    "req.headers.authorization",
    "req.headers.cookie",
    "res.headers['set-cookie']",
  ],
  ...(isProduction || isTest
    ? {}
    : {
        transport: {
          target: "pino-pretty",
          options: { colorize: true },
        },
      }),
});

const emittedPhotoDeleteRecoveryAlerts = new Set<string>();

export type PhotoDeleteRecoveryAlert = {
  reason:
    | "backup_directory_inspection_failed"
    | "backup_contents_ambiguous"
    | "backup_compensation_failed"
    | "backup_reconciliation_failed";
  backupPath: string;
  originalPath: string | null;
  error?: unknown;
};

/**
 * Emit a stable, searchable alert for a photo deletion backup that needs
 * manual recovery. The in-process guard prevents repeated recovery passes
 * from producing duplicate alerts; callers persist the same key when the
 * backup itself must survive a process restart.
 */
export function logPhotoDeleteRecoveryAlert({
  reason,
  backupPath,
  originalPath,
  error,
}: PhotoDeleteRecoveryAlert): void {
  const alertKey = `photo-delete-backup:${backupPath}:${originalPath ?? "unknown"}`;
  if (emittedPhotoDeleteRecoveryAlerts.has(alertKey)) {
    return;
  }
  emittedPhotoDeleteRecoveryAlerts.add(alertKey);

  logger.error(
    {
      event: "photo_delete_backup_recovery_required",
      alertKey,
      reason,
      backupPath,
      originalPath,
      ...(error === undefined ? {} : { err: error }),
    },
    "Photo deletion backup requires manual recovery",
  );
}
