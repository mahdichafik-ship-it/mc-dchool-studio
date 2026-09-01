---
name: macOS smoke cleanup
description: Filesystem teardown behavior for native packaged Electron smoke tests
---

Native packaged Electron smoke tests can finish their assertions while background cleanup still has open handles or recreates entries in the temporary user-data directory. Apple silicon runners exposed this as a transient `ENOTEMPTY` failure during recursive removal even though the app test passed.

**Why:** A teardown-only filesystem race can incorrectly block a release after all application assertions succeed.

**How to apply:** Treat temporary Electron directory cleanup as retryable teardown work after the app process and test server are stopped; keep the release gate strict for assertion and process failures.