---
name: Local preview pipeline
description: The desktop Watch Folder preview path is intentionally local and separate from durable organization and cloud synchronization.
---

The first gallery image must be produced from the stable Smart Shooter source file and emitted to the renderer before the managed copy and SQLite persistence complete. The later persisted event replaces the temporary preview using a stable capture key, without adding a second gallery item or toast.

**Why:** Cloud connectivity and slow disk/database work must not determine whether a photographer can see the image they just captured. A preview path that waits for persistence or a remote URL hides the real source of latency and risks coupling live shooting to sync.

**How to apply:** Keep the preview payload local, log the full T0–T12 path when diagnostics are enabled, and preserve the explicit upload boundary. Any change to preview event reconciliation must test duplicate events, watcher restarts, paired JPEG/RAW files, and the no-copy/no-database ordering guarantee.