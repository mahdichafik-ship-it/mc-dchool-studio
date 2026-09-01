# Threat Model

## Project Overview

MC School Studio combines a Clerk-authenticated web application, an Express/PostgreSQL API, and a signed Electron desktop application used by photographers. The desktop app imports project rosters, watches local Smart Shooter folders, assigns JPEG/RAW captures to students, creates lightweight previews, stores managed copies locally, and synchronizes explicitly with the web service.

## Assets

- **Student and school data** — names, identifiers, class membership, contact details, and project metadata must remain scoped to the correct studio and project.
- **Original and managed captures** — JPEG/RAW originals, pair relationships, review decisions, and local recovery state must not be lost, overwritten, or assigned to the wrong student.
- **Desktop authorization** — connection tokens, cached identity, role scope, and retirement state control cloud access and remote data erasure.
- **Release integrity** — signing credentials, notarized application bundles, updater metadata, checksums, and GitHub release assets determine whether photographers install authentic software.
- **Application secrets** — Clerk, session, signing, notarization, GitHub, and database credentials must remain outside source code and logs.

## Trust Boundaries

- **Browser to API** — browser input is untrusted; Clerk authentication and studio/project authorization must be enforced server-side.
- **Desktop to API** — desktop connection tokens cross the network boundary; cloud reads and writes require fresh server verification and role scoping.
- **Watch folder to desktop** — camera-created filenames and file contents are untrusted input; they must not escape managed storage paths or corrupt assignment state.
- **Desktop database and filesystem** — SQLite metadata, managed copies, preview cache files, and untouched Watch Folder originals have different retention and integrity requirements.
- **Build system to photographer Macs** — GitHub Actions, Apple signing/notarization, release assets, and electron-updater metadata form the software supply-chain boundary.

## Scan Anchors

- API/auth boundaries: `artifacts/api-server/src/routes/` and `artifacts/api-server/src/lib/auth.ts`
- Desktop ingestion and assignment: `artifacts/mc-school-studio-desktop/src/main/ipc/watcher.ts`
- Capture persistence and pairing: `artifacts/mc-school-studio-desktop/src/main/lib/`
- Desktop cloud authorization: `artifacts/mc-school-studio-desktop/src/main/ipc/auth.ts`, `cloud.ts`, and `upload.ts`
- Release supply chain: `.github/workflows/desktop-release.yml`
- Packaged-app gates: `artifacts/mc-school-studio-desktop/test/*release-smoke.mjs`

## Threat Categories

### Spoofing

Desktop and web clients must never be trusted based only on locally supplied identity fields. Protected API routes must validate Clerk sessions or desktop connection tokens, and retired/revoked desktop credentials must fail closed.

### Tampering

Watch Folder originals must never be moved, renamed, modified, or deleted. Capture assignment must remain project-scoped, filename/student conflicts must not be silently overridden, and managed filenames must be sanitized before constructing destination paths. Desktop installers and updater packages must be signed, notarized, and validated against generated updater metadata.

### Repudiation

Sensitive platform-owner, studio-management, retirement, review, and release actions require durable timestamps and actor/device context sufficient to investigate unexpected changes. Diagnostic logging must not include secrets.

### Information Disclosure

API responses and desktop project downloads must remain scoped to authorized studios and roles. Connection tokens, session cookies, signing credentials, and personal data must not appear in source control, release assets, or user-facing error output.

### Denial of Service

Large camera files must not create unbounded serial work before the live-preview path. When a capture already has a valid manual or active-student target, full-image QR decoding must be bypassed so large JPEG bursts cannot starve preview generation. Preview caches and queues must remain bounded independently of capture persistence.

### Elevation of Privilege

Platform-owner and studio-admin access must be enforced by the API rather than the renderer. Desktop role scope must be verified on every authoritative cloud operation, and a local cached identity must not authorize cloud writes.

## Release Guarantees

- Publication must remain blocked unless Intel and Apple-silicon packaged retirement smoke tests pass.
- Both architectures must pass signing, Gatekeeper, notarization, updater metadata, and previous-version update-smoke checks.
- A release must contain both architecture DMGs, ZIPs, blockmaps, and `latest-mac.yml`, with metadata referencing both ZIPs.
- The release tag must exactly match the desktop package version.
- No manual GitHub release may bypass a failed required gate.