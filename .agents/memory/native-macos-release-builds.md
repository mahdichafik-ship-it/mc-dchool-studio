---
name: Native macOS release builds
description: Architecture rule for packaging signed Intel and Apple-silicon desktop releases.
---

Build each thin macOS Electron package on a runner whose native CPU matches the target architecture, then combine the independently verified artifacts into one updater manifest.

**Why:** Installing native dependencies once on an Apple-silicon host can place architecture-specific SQLite, Sharp, or libvips payloads into an Intel package. Signing and notarization can still pass because they do not prove nested native binaries are runnable on the target CPU.

**How to apply:** Keep separate native x64 and arm64 build jobs, prune optional native packages for every other platform and CPU before packaging, verify unpacked native binary architectures before launching packaged smoke tests, and block publication until both packages and the combined updater metadata pass.