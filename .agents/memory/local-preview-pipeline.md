---
name: Local preview pipeline
description: The desktop Watch Folder preview path is intentionally local and separate from durable organization and cloud synchronization.
---

The first gallery image must be produced from the stable Smart Shooter source file and emitted to the renderer before the managed copy and SQLite persistence complete. The later persisted event replaces the temporary preview using a stable capture key, without adding a second gallery item or toast.

The live preview transport should send a secure, short-lived local protocol URL that maps to the source file, rather than a base64 image payload through IPC. The renderer owns decode and post-frame paint measurement.

Native image decoders must never open or memory-map a mutable watched camera file. After file-stability checks, snapshot the bytes once and use that immutable snapshot for validation, QR analysis, preview generation, and managed persistence.

**Why:** Cloud connectivity and slow disk/database work must not determine whether a photographer can see the image they just captured. A preview path that waits for persistence or a remote URL hides the real source of latency and risks coupling live shooting to sync. On macOS, libvips can crash the entire Electron process with SIGBUS if a mapped JPEG is truncated or replaced during decode; JavaScript error handling cannot catch that native fault.

**How to apply:** Keep the preview payload local, log the full T0–T12 path when diagnostics are enabled, and preserve the explicit upload boundary. Decode JPEGs from cloned buffers or a managed immutable copy, and test source replacement, truncation, malformed bytes, duplicate events, watcher restarts, paired JPEG/RAW files, and the no-copy/no-database ordering guarantee.