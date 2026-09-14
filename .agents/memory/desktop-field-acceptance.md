---
name: Desktop field acceptance
description: The boundary between hosted updater smoke coverage and real photographer-Mac release acceptance.
---

Hosted macOS runners can prove architecture, signature, Gatekeeper, notarization,
download, restart, relaunch, and target-version behavior, but they cannot prove
that a photographer's existing local project and photos survive an update on
supported hardware.

**Why:** Local privacy permissions, real user data, and hardware-specific
restart behavior are outside the hosted smoke fixture.

**How to apply:** Keep a release acceptance record with exact macOS version and
build for one Intel and one Apple-silicon photographer Mac. Require the prior
signed release, an in-app update, Gatekeeper/restart/version checks, and a
non-sensitive local project/photo fixture preservation check before accepting
the release.