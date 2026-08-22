---
name: Desktop release signing
description: Durable safeguards for signed and notarized desktop releases.
---

Tagged desktop releases must require every signing and notarization credential
before packaging, while local development builds may remain unsigned.

**Why:** electron-builder can silently skip signing when credentials are absent,
which would let a production installer trigger Gatekeeper or SmartScreen.
macOS helper signing also depends on committed hardened-runtime entitlements.

**How to apply:** Keep release preflight checks fail-closed when changing the
packaging workflow, certificate setup, or upload steps. Preserve valid main and
inherited macOS entitlements whenever hardened runtime signing is enabled.