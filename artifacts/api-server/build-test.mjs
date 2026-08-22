import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const artifactDir = path.dirname(fileURLToPath(import.meta.url));

await build({
  entryPoints: [path.resolve(artifactDir, "test/photos.integration.test.ts")],
  outfile: path.resolve(artifactDir, "test/photos.integration.test.mjs"),
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
  ],
  banner: {
    js: `import { createRequire as __createRequire } from "node:module";
globalThis.require = __createRequire(import.meta.url);`,
  },
  logLevel: "warning",
});