---
name: macOS packaging validation
description: Environment constraint affecting Electron Builder macOS release verification.
---

On Linux, Electron Builder can package unsigned macOS x64 and arm64 ZIP artifacts, but the configured DMG target may fail before packaging if the locked `dmg-license` dependency is absent from the installed pnpm tree. Linux also cannot perform macOS code signing or notarization.

**Why:** A generated ZIP is useful packaging evidence, but it is not equivalent to a complete configured macOS release build when the DMG target fails or signing is skipped.

**How to apply:** Run the project’s configured macOS command first; report it as failed if the DMG target fails. ZIP success should be reported separately, and macOS signing/notarization must be verified on macOS.