---
name: Electron runtime validation
description: Packaged Electron cannot launch in the current Linux workspace without the native GLib runtime.
---

Packaged Electron smoke tests require a runtime image that provides `libglib-2.0.so.0`; TypeScript, unit tests, and electron-vite builds can still run without it.

**Why:** A missing native library causes the Electron executable to fail before the app process starts, which can otherwise be mistaken for an application regression.

**How to apply:** Treat process-level desktop smoke validation as unavailable in this workspace until the runtime dependency is supplied; keep it as a macOS/desktop CI gate rather than changing application code to work around it.