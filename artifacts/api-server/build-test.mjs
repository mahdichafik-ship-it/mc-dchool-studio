import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const artifactDir = path.dirname(fileURLToPath(import.meta.url));

await build({
  entryPoints: [
    path.resolve(artifactDir, "test/photos.integration.test.ts"),
    path.resolve(artifactDir, "test/access.integration.test.ts"),
    path.resolve(artifactDir, "test/platform.integration.test.ts"),
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
  ],
  banner: {
    js: `import { createRequire as __createRequire } from "node:module";
globalThis.require = __createRequire(import.meta.url);`,
  },
  logLevel: "warning",
});