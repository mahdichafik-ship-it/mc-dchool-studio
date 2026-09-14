---
name: Offline finish lifecycle
description: Durable distinction between local shoot completion and cloud synchronization.
---

A photographer may finish a shoot locally while offline. Persist that completion before cloud work, stop local capture safely, and keep it distinct from fully synchronized completion.

**Why:** Refusing offline completion leaves shoot state unclear, while treating local completion as cloud completion can hide missing uploads. Network interruption must never erase or silently complete pending work.

**How to apply:** Keep explicit active, finished-local, syncing, retryable-failure, and synced states. Count only durably successful files as completed, retain stable batch/file identities across retries, and transition to synced only after every file and review barrier succeeds.