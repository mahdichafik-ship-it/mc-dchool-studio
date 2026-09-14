import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const artifactDir = path.dirname(fileURLToPath(import.meta.url));

await build({
  entryPoints: [
    path.resolve(artifactDir, "test/photos.integration.test.ts"),
    path.resolve(artifactDir, "test/access.integration.test.ts"),
    path.resolve(artifactDir, "test/platform.integration.test.ts"),
    path.resolve(artifactDir, "test/groupMembership.test.ts"),
    path.resolve(artifactDir, "test/googleDriveBackup.test.ts"),
    path.resolve(artifactDir, "test/managedStripeWebhook.test.ts"),
    path.resolve(artifactDir, "test/deliveryOffers.integration.test.ts"),
    path.resolve(artifactDir, "test/deliveryR2.integration.test.ts"),
    path.resolve(artifactDir, "test/r2Storage.test.ts"),
    path.resolve(artifactDir, "test/r2UploadCopies.test.ts"),
    path.resolve(artifactDir, "test/captureEdits.test.ts"),
    path.resolve(artifactDir, "test/marketing.integration.test.ts"),
    path.resolve(artifactDir, "test/deliveryInvitations.integration.test.ts"),
    path.resolve(artifactDir, "test/deliveryOrderNotifications.integration.test.ts"),
    path.resolve(artifactDir, "test/students.integration.test.ts"),
    path.resolve(artifactDir, "test/roster.integration.test.ts"),
    path.resolve(artifactDir, "test/securityMiddleware.test.ts"),
    path.resolve(artifactDir, "test/desktopRelease.test.ts"),
    path.resolve(artifactDir, "test/launchRehearsal130.integration.test.ts"),
  ],
  outdir: path.resolve(artifactDir, "test"),
  entryNames: "[name]",
  outExtension: { ".js": ".mjs" },
  bundle: true,
  format: "esm",
  platform: "node",
  sourcemap: "inline",
  external: [
    "node:*",
    "@clerk/*",
    "drizzle-orm",
    "express",
    "multer",
    "pdfkit",
    "sharp",
  ],
  banner: {
    js: `import { createRequire as __createRequire } from "node:module";
globalThis.require = __createRequire(import.meta.url);`,
  },
  logLevel: "warning",
});