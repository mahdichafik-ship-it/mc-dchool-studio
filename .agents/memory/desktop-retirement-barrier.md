---
name: Desktop retirement barrier
description: Safety ordering for remote retirement of photographer desktops.
---

A retired desktop must persistently fence every local data-producing path, drain active work, erase app-managed project data, and only then acknowledge retirement.

**Why:** Acknowledging before active capture or cloud-import work settles can let student data be recreated after cleanup, while an in-memory-only fence leaves a restart window before the server check completes.

**How to apply:** Treat the persisted retirement marker as authoritative at every local sync entry point. Clear it only after a successful new browser sign-in creates a new connection.