# macOS Release Stage Report

**Checked:** 2026-09-01  
**Desktop version:** `1.0.25`  
**Release tag required by CI:** `v1.0.25`

## Stage results

| Stage | Command | Result |
| --- | --- | --- |
| Source and renderer typecheck | `pnpm --filter @workspace/mc-school-studio-desktop run typecheck` | PASS |
| Electron production compilation | `pnpm --filter @workspace/mc-school-studio-desktop run build` | PASS |
| Configured Mac release | `pnpm --filter @workspace/mc-school-studio-desktop run dist:mac` | FAIL at DMG builder startup |
| Unpacked x64 `.app` | `pnpm --filter @workspace/mc-school-studio-desktop exec electron-builder --mac dir --x64 --publish never` | PASS; unsigned Linux build |
| Unpacked arm64 `.app` | `pnpm --filter @workspace/mc-school-studio-desktop exec electron-builder --mac dir --arm64 --publish never` | PASS; unsigned Linux build |
| Combined x64/arm64 ZIPs | `pnpm --filter @workspace/mc-school-studio-desktop exec electron-builder --mac zip --x64 --arm64 --publish never` | PASS; both ZIPs and blockmaps generated |
| Updater contract tests | `pnpm --filter @workspace/mc-school-studio-desktop run test:updater` | PASS |
| Generated updater metadata against complete release set | `pnpm --filter @workspace/mc-school-studio-desktop run validate:updater dist/release/latest-mac.yml 1.0.25` | Correctly fails locally because the four DMG assets are absent |

### Exact configured-command failure

The configured `dist:mac` command reaches electron-builder and fails before
creating a DMG:

```text
Cannot find module 'dmg-license'
Require stack:
- .../dmg-builder@25.1.8/node_modules/dmg-builder/out/dmgLicense.js
- .../app-builder-lib@25.1.8/.../macPackager.js
...
```

`dmg-license@1.0.11` is an optional Darwin-only dependency in
`dmg-builder@25.1.8`. It is present in the lockfile but is correctly absent
from this Linux installation. The macOS workflow strips the Replit-only
platform overrides and performs a fresh install on `macos-14`, where this
dependency is installable. No Linux-only package override or architecture
change should be added to emulate that environment.

## Independent packaging evidence

- The x64 bundle contains a Mach-O `x86_64` executable.
- The arm64 bundle contains a Mach-O `arm64` executable.
- Both bundles contain `Contents/Resources/app.asar`.
- Both emitted `Info.plist` files contain:
  - `CFBundleIdentifier=com.mcschoolstudio.desktop`
  - `CFBundleShortVersionString=1.0.25`
  - `LSMinimumSystemVersion=11.0`
  - `NSDocumentsFolderUsageDescription`
  - `NSDownloadsFolderUsageDescription`
- Linux logs explicitly report that macOS application code signing was
  skipped. Signing, notarization, Gatekeeper assessment, and stapling require
  the existing macOS CI jobs and Apple credentials.

## Mac compatibility review

- `mc-preview://` is registered as a privileged secure standard scheme before
  `app.whenReady()`, and its handler maps short-lived session keys to local
  files through `net.fetch(pathToFileURL(...))`.
- Production path resolution uses `__dirname` for the preload and renderer,
  and the packaged app confirms those files are inside `app.asar`.
- The renderer uses `contextIsolation: true`, `nodeIntegration: false`, and
  `sandbox: false`. The last setting is explicit and remains compatible with
  the current preload/native SQLite packaging.
- The Mac config now explicitly sets `hardenedRuntime: true` and uses both
  hardened-runtime entitlement files. No App Sandbox entitlement is declared,
  so Watch Folder access remains based on the user-selected native directory
  dialog and macOS privacy controls rather than security-scoped bookmarks.
- `src/renderer/index.html` does not declare a Content-Security-Policy, and no
  runtime CSP is installed. This is a hardening gap, not a packaging failure;
  the renderer is still isolated from Node and native IPC is exposed only by
  the preload bridge.
- Watch Folder paths are selected with `dialog.showOpenDialog({ openDirectory:
  true })`, persisted as local paths, and consumed by chokidar without
  platform-specific path assumptions.

## CI source of truth

The existing GitHub `Desktop Release` workflow:

1. Requires the tag to match `v` plus the desktop package version.
2. Requires all signing and notarization secrets before the Mac job starts.
3. Installs on `macos-14` after removing only Replit/Linux platform
   exclusions.
4. Builds both x64 and arm64 DMGs and ZIPs.
5. Validates signatures, Gatekeeper, stapling, updater metadata, and the
   packaged retirement flow before publishing.

The latest recorded workflow run for `v1.0.25` completed successfully. The
new `extendInfo` shape and explicit hardened-runtime setting still need to be
confirmed by the next Mac CI run because Linux cannot perform Apple signing or
notarization.

## Recommendation

**NO-GO for a complete release from this Linux workspace.** The application
and both architecture-specific `.app`/ZIP packaging paths are healthy, but the
configured DMG path and complete updater asset validation cannot pass here.

**Conditional GO on macOS CI:** run the existing workflow with tag `v1.0.25`.
Do not publish `v1.9.27`: it does not match the current desktop package version,
and the workflow will reject that tag before packaging.