# MC School Studio — Desktop App

macOS Electron desktop app for use on photo day. Works alongside the MC School Studio web app.

## What it does

- Imports school projects from the web app (via JSON export)
- Watches the folder where SmartShooter saves tethered photos
- Automatically reads QR codes from incoming photos and assigns them to the right student
- Stores all photos locally on your computer
- Shows each student's QR code full-screen during the shoot

## Getting started on your local machine

### Prerequisites

- Node.js 18+
- pnpm 9+

### 1. Clone and install

```bash
git clone <your-repo-url>
cd <repo>
```

**Important:** The Replit workspace excludes non-Linux platform binaries by default. Before installing on Mac, comment out or remove the `overrides` block in `pnpm-workspace.yaml` (the section that excludes `@esbuild/darwin-*`, etc.).

Then:

```bash
pnpm install
pnpm approve-builds   # allow better-sqlite3, electron to compile
```

### 2. Run in development mode

```bash
pnpm --filter @workspace/mc-school-studio-desktop run dev
```

The app will open as a native window. Hot-reload is supported for the renderer.

### 3. Build an installer

```bash
# macOS .dmg (universal — Intel + Apple Silicon)
pnpm --filter @workspace/mc-school-studio-desktop run dist:mac

```

Installers are written to `artifacts/mc-school-studio-desktop/dist/release/`.

### One-time code-signing setup

Tagged releases require the signing secrets below and stop before packaging if
any required secret is missing. Keep certificate files and passwords private;
add them only as GitHub Actions repository or environment secrets, never to
the repository.

#### macOS signing and notarization

1. Join the [Apple Developer Program](https://developer.apple.com/programs/)
   and create a **Developer ID Application** certificate in
   **Certificates, Identifiers & Profiles**.
2. Install the certificate in Keychain Access, export it as a `.p12` file, and
   protect the export with a strong password.
3. Convert the `.p12` file to one-line base64 and add the result as the
   `CSC_LINK` GitHub Actions secret. For example:

   ```bash
   # macOS
   base64 -i developer-id-application.p12 | pbcopy

   # Linux
   base64 -w 0 developer-id-application.p12
   ```

4. Add the `.p12` export password as `CSC_KEY_PASSWORD`.
5. Create an app-specific password at
   [appleid.apple.com](https://appleid.apple.com/), then add these secrets for
   notarization:

   - `APPLE_ID` — the Apple ID used for the developer account
   - `APPLE_APP_SPECIFIC_PASSWORD` — the app-specific password
   - `APPLE_TEAM_ID` — the Team ID shown in Apple Developer account
     membership details

The macOS job verifies all five values before packaging and then sets
`CSC_IDENTITY_AUTO_DISCOVERY` to `true`. `electron-builder.yml` enables
notarization for the macOS target, so a tagged release cannot publish an
unsigned or unnotarized DMG.

After configuring the secrets, push a version tag and confirm the resulting
GitHub Release assets install without Gatekeeper warnings.

## CI/CD — automated installers via GitHub Actions

Pushing a `v*` tag triggers `.github/workflows/desktop-release.yml`, which
builds macOS DMG and ZIP packages for Intel and Apple Silicon. It verifies
Gatekeeper acceptance and notarization before the job can pass, and attaches
the installers, update metadata, and blockmaps to the GitHub Release
automatically.

```bash
# Tag a release and push — CI does the rest
git tag v1.0.0
git push origin v1.0.0
```

The workflow handles the Replit-only `pnpm-workspace.yaml` overrides
automatically: it runs `node scripts/strip-replit-overrides.mjs` before
`pnpm install` to remove the Linux-only platform-binary exclusions, so the
macOS runner fetches the correct native binaries.

## Workflow on photo day

1. **Prepare** — In the web app, create the school project, import students from Excel/CSV, and generate QR codes. Then go to the project's Exports tab and click **Export for Desktop** to download a `.json` file.

2. **Import** — Open the desktop app, click **Import Project**, and select the `.json` file. All classes and students load into the local database.

3. **Configure** — In the project view, click **Set watch folder** and choose the folder where SmartShooter saves photos.

4. **Shoot** — Click **Start watching**. The green "Live" indicator appears. Select a student — their QR code is displayed large on screen. The photographer captures it. SmartShooter saves the photo to the watch folder. The app detects the new file, reads the QR code, and assigns it to the student automatically.

5. **Review** — Click any student to see their photo gallery. Use **Reassign** if a photo was mismatched.

## Storage

Photos are copied to: `~/MC School Studio/photos/{projectId}/{studentGeneratedId}/`

The SQLite database is at: `~/Library/Application Support/MC School Studio/mc-school-studio.db`.

## Cloud upload

The "Upload to Cloud" feature is stubbed in the Settings screen. It will be implemented in a future update to push photos to the web app.
