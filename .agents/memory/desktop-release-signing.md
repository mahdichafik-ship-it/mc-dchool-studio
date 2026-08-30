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

Replit's GitHub OAuth connection may have repository access without permission
to modify workflow files. When that occurs, use a user-provided GitHub token with
`repo` and `workflow` scopes through Replit Secrets, never through chat.

**Why:** Ordinary source writes succeeded while `.github/workflows` writes were
blocked, even after reconnecting a healthy OAuth connection.

**How to apply:** Request the token through the secure Secrets form and use a
temporary ask-pass helper for Git pushes so the token is never printed, embedded
in a remote URL, or committed.