---
name: Desktop release signing
description: Durable safeguards for signed and notarized desktop releases.
---

Tagged desktop releases must require every signing and notarization credential
before packaging, while local development builds may remain unsigned.
Platform jobs must stage verified artifacts rather than publishing independently;
one dependent job should validate the complete set, upload it as a draft, and
publish only after the remote assets match.

**Why:** electron-builder can silently skip signing when credentials are absent,
which would let a production installer trigger Gatekeeper or SmartScreen.
Independent platform uploads can also expose a partial release if another build
fails. macOS helper signing depends on committed hardened-runtime entitlements.

**How to apply:** Keep release preflight checks fail-closed when changing the
packaging workflow, certificate setup, or upload steps. Preserve valid main and
inherited macOS entitlements whenever hardened runtime signing is enabled.
Verify both installer and updater payload signatures before staging, reject
missing or unexpected assets, and keep the GitHub Release in draft state until
the complete uploaded asset set has been checked.

For macOS update metadata, accept that electron-builder may list both ZIP and
DMG payloads. Validate every listed payload's SHA-512, require both architectures,
and require each installer's sibling blockmap before staging. The preferred
top-level update path must still be a ZIP.

**Why:** The pinned builder emitted architecture-specific ZIP and DMG entries in
`latest-mac.yml` during the signed release. Assuming ZIP-only metadata rejected
valid, signed output after packaging had already succeeded.

**How to apply:** Check generated metadata against the produced installers rather
than a ZIP-only fixture. Keep strict name, version, checksum, preferred-path, and
blockmap validation for the complete release set.

Installed-app update smoke tests must drive the already-published older binary;
do not rely on test hooks added only to the target release. A launch-time
Electron main-process inspector can exercise that older binary's real updater
singleton without weakening production behavior.

**Why:** New environment flags or IPC hooks do not exist in the signed source
release being upgraded, while hosted macOS UI scripting depends on Accessibility
permissions that are not reliable across runner images.

**How to apply:** Trigger the packaged source app's real update check, download,
install, bundle replacement, and relaunch. Require a distinct target process to
stay alive and re-run signature, Gatekeeper, and notarization checks afterward.
For an externalized updater in an ESM inspector context, load it with
`process.getBuiltinModule('module').createRequire()` rooted at the packaged
`app.asar` main entry. Suppress unattended native update dialogs in the harness,
and disconnect every debugger before requesting restart because Squirrel waits
for attached debuggers to leave before the source app can exit.

Use GitHub's current standard Intel runner label rather than a retired image.
As of 2026, `macos-15-intel` is the supported standard x86_64 label; a
`macos-13` job can remain queued indefinitely.

**Why:** The updater downloaded correctly on both architectures but the smoke
test deadlocked while its own main-process debugger remained attached. Separately,
the retired Intel image never acquired a hosted runner.

**How to apply:** Keep both packaged retirement and installed-update smoke jobs
on supported native architecture labels. Treat prolonged queueing on a retired
label as runner configuration, not authentication failure.

Replit's GitHub OAuth connection may have repository access without permission
to modify workflow files. When that occurs, use a user-provided GitHub token with
`repo` and `workflow` scopes through Replit Secrets, never through chat.

**Why:** Ordinary source writes succeeded while `.github/workflows` writes were
blocked, even after reconnecting a healthy OAuth connection.

**How to apply:** Request the token through the secure Secrets form and use a
temporary ask-pass helper for Git pushes so the token is never printed, embedded
in a remote URL, or committed.