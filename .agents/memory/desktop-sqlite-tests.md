---
name: Desktop SQLite tests
description: How to keep desktop file-processing tests runnable without a native SQLite binary in the workspace Node runtime.
---

Desktop file-processing tests should exercise persistence behavior through a small injectable store interface, with production using the real Drizzle-backed adapter.

**Why:** The workspace Node runtime does not have a loadable `better-sqlite3` native binding, and rebuilding the dependency does not produce one. Tests coupled directly to SQLite fail before reaching the behavior under test.

**How to apply:** For desktop main-process logic that needs filesystem and persistence coverage, keep the production database adapter thin and use an in-memory store in Node tests. Continue validating the real adapter with TypeScript and the Electron production build.