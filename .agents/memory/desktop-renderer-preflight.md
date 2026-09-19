---
name: Desktop renderer preflight
description: Release workflow ordering for catching renderer compilation errors before native macOS packaging.
---

The desktop renderer build should run as an explicit preflight before architecture-specific signing and DMG packaging.

**Why:** A malformed JSX block previously caused both native macOS jobs to fail only after runner setup and signing preparation, obscuring the real failure as a generic packaging error and wasting two architecture builds.

**How to apply:** Keep the preflight in the desktop release workflow and let native jobs remain responsible for architecture-specific packaging, signing, notarization, and smoke checks. When release commits are assembled through a remote Git provider, run the preflight against that exact remote commit rather than relying only on a separate local checkout.