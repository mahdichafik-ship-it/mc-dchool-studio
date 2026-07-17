/**
 * strip-replit-overrides.mjs
 *
 * Removes the Replit-only platform-binary exclusions from pnpm-workspace.yaml
 * so that `pnpm install` fetches the correct native binaries on macOS and
 * Windows CI runners.
 *
 * The root pnpm-workspace.yaml contains `overrides` entries of the form:
 *
 *   "esbuild>@esbuild/darwin-arm64": "-"
 *
 * These tell pnpm to skip non-Linux-x64 platform packages, which is desirable
 * inside Replit (Linux-only) but breaks builds on other OSes.  This script
 * strips those lines while preserving any non-platform overrides (e.g. version
 * pins and security aliases).
 *
 * Usage (called automatically by .github/workflows/desktop-release.yml):
 *   node scripts/strip-replit-overrides.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const workspacePath = resolve(__dirname, '..', 'pnpm-workspace.yaml');

const original = readFileSync(workspacePath, 'utf8');

// Match override lines that set a platform-specific sub-package to "-"
// e.g.  "esbuild>@esbuild/darwin-arm64": "-"
//        "@tailwindcss/oxide>@tailwindcss/oxide-win32-x64-msvc": "-"
// Both double-quoted ("-") and single-quoted ('-') forms are handled.
const PLATFORM_EXCLUSION = /^\s+"[^"]+>[^"]+": ["']-["']/;

const cleaned = original
  .split('\n')
  .filter(line => !PLATFORM_EXCLUSION.test(line))
  .join('\n');

writeFileSync(workspacePath, cleaned, 'utf8');

const removedCount = original.split('\n').length - cleaned.split('\n').length;
console.log(`strip-replit-overrides: removed ${removedCount} platform-exclusion override line(s) from pnpm-workspace.yaml`);
