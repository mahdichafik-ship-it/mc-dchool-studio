# Desktop dependency advisory acceptance

**Reviewed:** 2026-09-14

## Classification and remediation

- **Runtime:** Electron was upgraded from 33.4.11 to 39.8.10, the first
  maintained line containing fixes for every Electron advisory reported by the
  dependency scan. The updater identity is unchanged: the application ID,
  executable name, artifact naming, GitHub owner, and GitHub repository remain
  the values in `electron-builder.yml`.
- **Build and packaging:** electron-builder was upgraded from 25.1.8 to
  26.15.3. Fixed patch versions of its remaining transitive archive, YAML, URI,
  and glob dependencies are enforced through workspace overrides because the
  latest compatible parent packages still resolve older versions. The signing
  toolchain is held on compatible `plist@3.1.0`, which resolves the unaffected
  xmldom 0.8 line; forcing fixed xmldom 0.9.12 directly breaks plist parsing.
- **Frontend tooling:** the desktop Vite toolchain was upgraded from 5.4.21 to
  6.4.3. Fixed transitive PostCSS, Nano ID, and Browserslist versions are
  enforced until their direct parents resolve those patches.
- **API generation tooling:** Orval was upgraded from 8.21.0 to the current
  compatible 8.x release selected by the lockfile, with a fixed `fast-uri`
  override for the parser's AJV dependency.

The platform dependency scan changed from 55 high / 0 critical records to 5
high / 0 critical records. `pnpm audit` reports 2 high / 0 critical records;
the difference is the platform scanner's UUID and SheetJS findings below.

## Accepted residual advisory

Both remaining high records refer to `extract-zip@2.0.1`, reached only through
the development dependency `electron`. Electron uses this package in its npm
installation script to unpack the Electron distribution downloaded from the
Electron release service. It is not imported by the Volume Capture main,
preload, or renderer processes and is not included in the packaged application.

The advisories require an attacker-controlled archive or crafted symbolic-link
entry. The release build does not accept an archive, URL, or extraction target
from an application user. It installs the version-pinned Electron distribution
in an isolated CI workspace, then signs, notarizes, and validates the resulting
application. The advisory currently reports no patched `extract-zip` release,
so there is no fixed version to select or compatible parent upgrade that removes
it.

**Acceptance:** retain these two build-time records until Electron replaces
`extract-zip` or a patched release becomes available. Reassess on every Electron
upgrade. Do not treat this acceptance as permission to extract untrusted
archives with the package.

The platform scanner also reports one high record for `uuid@9.0.1` through
Google's `gaxios` HTTP client. The vulnerable operation is UUID validation; this
dependency path only generates request identifiers and does not use UUID
validation as an authorization or trust boundary. The latest direct
`@google-cloud/storage` parent still resolves this version, and forcing the
scanner's major-version replacement into Google's client would bypass its
declared compatibility range. Retain it until the direct Google parent adopts a
fixed UUID release.

Two platform records refer to `xlsx@0.20.3`. This is the maintained SheetJS
Community Edition release installed from SheetJS's official CDN, not the stale
npm-registry release on which those advisory ranges are based. The vendor moved
fixed Community Edition releases off npm, and the scanner does not model that
distribution channel. Spreadsheet imports remain bounded and user-initiated.
Retain the vendor-CDN dependency and reassess against SheetJS upstream releases,
not the obsolete npm package.

## Release validation boundary

Linux validation can compile the app and produce unsigned architecture-specific
macOS bundles only with native dependency rebuilding disabled. Those bundles
are identity evidence, not runnable native-package evidence. Electron Builder
26 correctly refuses to cross-compile `better-sqlite3` from Linux. Linux also
cannot prove Apple signing, notarization, Gatekeeper, or installed updater
behavior.

The existing Desktop Release workflow remains the release authority: native x64
and arm64 runners build separately, require all Apple credentials, verify native
architectures and signatures, notarize and staple both packages, merge and
validate updater metadata, stage the complete asset set, and run installed-update
smoke checks. A release remains blocked until that signed path and the separate
photographer-Mac acceptance record pass.

## Validation results

- Workspace typecheck: pass.
- Desktop Electron/Vite production build: pass.
- API generation with pinned Orval 8.22.0 and generated-library typecheck: pass.
- Frozen pnpm install: pass; Electron and better-sqlite3 install scripts are
  explicitly allowlisted.
- Desktop updater metadata contract: 11/11 pass.
- Desktop offline, watcher, live-preview, database migration, retirement,
  capture/upload/export, and project-sync regressions: 59/59 pass.
- Unsigned identity packaging: x64 and arm64 Electron 39.8.10 ZIPs and blockmaps
  generated; the main executables are Mach-O x86_64 and arm64 respectively;
  bundle ID, executable name, and version are unchanged; `extract-zip` is absent
  from `app.asar`.
- Complete local updater-asset validation: correctly blocked because Linux
  cannot produce the required signed/notarized DMGs and blockmaps.
- Release-history gate: correctly blocked because this task branch is not yet
  merged to the protected main branch.
- SAST: 0 high/critical, 2 medium.
- Privacy/dataflow scan: 0 findings.