---
name: Desktop upload concurrency
description: Safe concurrency limit and accounting rules for desktop cloud transfers.
---

Use one shared limit of three simultaneous file transfers across portrait, group, JPEG, RAW, live, and explicit Finish uploads.

**Why:** Three parallel transfers reduce end-of-shoot waiting without allowing independent queue entry points to overwhelm studio Wi-Fi, desktop memory, the API, or R2. The user explicitly chose three as the initial operating limit.

**How to apply:** Acquire the shared slot before reading file bytes and hold it through R2 verification and local success persistence. Keep per-file deduplication, retries, progress, and final batch confirmation unchanged; never treat dispatch as completion.