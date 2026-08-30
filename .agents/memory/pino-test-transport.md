---
name: Bundled Node test logging
description: Why the API server logger avoids its threaded pretty transport under Node's bundled test runner.
---

The API server must not initialize Pino's threaded pretty transport when running inside Node's test context. The integration tests bundle TypeScript into ESM, where the transport's worker lookup can reference `__dirname` even though ESM does not define it.

**Why:** Importing the shared logger from a bundled test caused the test worker to fail before any test ran, while the production and normal development logger behavior remained valid.

**How to apply:** Keep the production pretty/JSON transport choice unchanged, but detect Node's test context (or an explicit test environment) before enabling the threaded pretty transport.