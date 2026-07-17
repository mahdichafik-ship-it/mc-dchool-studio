# MC School Studio — Desktop App

Cross-platform Electron desktop app for use on photo day. Works alongside the MC School Studio web app.

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

**Important:** The Replit workspace excludes non-Linux platform binaries by default. Before installing on Mac or Windows, comment out or remove the `overrides` block in `pnpm-workspace.yaml` (the section that excludes `@esbuild/darwin-*`, `@esbuild/win32-*`, etc.).

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

# Windows .exe installer
pnpm --filter @workspace/mc-school-studio-desktop run dist:win

# Both at once
pnpm --filter @workspace/mc-school-studio-desktop run dist
```

Installers are written to `artifacts/mc-school-studio-desktop/dist/`.

## Workflow on photo day

1. **Prepare** — In the web app, create the school project, import students from Excel/CSV, and generate QR codes. Then go to the project's Exports tab and click **Export for Desktop** to download a `.json` file.

2. **Import** — Open the desktop app, click **Import Project**, and select the `.json` file. All classes and students load into the local database.

3. **Configure** — In the project view, click **Set watch folder** and choose the folder where SmartShooter saves photos.

4. **Shoot** — Click **Start watching**. The green "Live" indicator appears. Select a student — their QR code is displayed large on screen. The photographer captures it. SmartShooter saves the photo to the watch folder. The app detects the new file, reads the QR code, and assigns it to the student automatically.

5. **Review** — Click any student to see their photo gallery. Use **Reassign** if a photo was mismatched.

## Storage

Photos are copied to: `~/MC School Studio/photos/{projectId}/{studentGeneratedId}/`

The SQLite database is at: `~/Library/Application Support/MC School Studio/mc-school-studio.db` (macOS) or `%APPDATA%\MC School Studio\mc-school-studio.db` (Windows).

## Cloud upload

The "Upload to Cloud" feature is stubbed in the Settings screen. It will be implemented in a future update to push photos to the web app.
