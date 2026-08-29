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

For macOS update metadata, treat ZIPs—not DMGs—as the electron-builder update
payloads. Validate each metadata SHA-512 against the corresponding ZIP and
require each ZIP's sibling blockmap before staging.

**Why:** The pinned builder emits architecture-specific ZIP entries in
`latest-mac.yml`; DMGs are separate release artifacts and do not belong in that
metadata file.

**How to apply:** Keep DMG checks in the complete release-asset verification,
while updater metadata validation checks ZIP names, versions, preferred path,
checksums, and adjacent ZIP blockmaps against generated output.