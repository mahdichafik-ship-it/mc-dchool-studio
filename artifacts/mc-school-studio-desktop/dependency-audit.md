# Desktop dependency audit

Audit refreshed on September 14, 2026 after upgrading Electron to 39.8.10,
electron-builder to 26.15.3, desktop Vite to 6.4.3, and Orval to 8.22.0.
Patched transitive versions are pinned at the workspace level where those current
direct parents still request vulnerable releases.

The remaining high-severity report is `extract-zip@2.0.1`, which Electron uses
only from its development-time install script to unpack the Electron distribution.
It is not bundled into the desktop application, does not process photographer or
server input, and does not run after packaging. The advisory currently declares
no patched version (`<0.0.0`), and the latest Electron release still depends on
the same package, so there is no compatible upstream upgrade or override.

Release builds continue to treat the Electron download as trusted build input,
install from the frozen pnpm lockfile, package separately on native x64 and arm64
macOS runners, and verify signing, notarization, native binary architecture,
updater checksums, and packaged launch behavior before publication.

Replit's broader dependency scanner also reports three findings outside pnpm's
remaining advisory set:

- `uuid@9.0.1` is pinned by `gaxios@6.7.1` under the latest
  `@google-cloud/storage@8.1.0`. The advisory affects the v3, v5, and v6 methods
  when callers provide an invalid output buffer. Gaxios only calls `v4()` without
  a caller-provided buffer, so the affected API is unreachable. Replacing this
  transitive CommonJS dependency with the scanner's ESM-only major upgrade would
  be a higher compatibility risk than retaining the unreachable code.
- `xlsx@0.20.3` is the maintained SheetJS Community Edition release installed
  from SheetJS's official CDN. The scanner advisories apply through 0.19.2 and
  before 0.20.2 respectively, so 0.20.3 is already newer than both fixed
  versions; the scanner does not model vendor-CDN releases correctly.

The platform scan therefore reports five high findings: two unpatched
development-only `extract-zip` advisories, one unreachable `uuid` API advisory,
and two stale SheetJS range matches. It reports no critical findings.