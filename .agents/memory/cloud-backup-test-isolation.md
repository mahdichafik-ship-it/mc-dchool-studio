---
name: Cloud backup test isolation
description: Why backup tests must explicitly isolate external storage providers.
---

Backup tests must mock every external storage destination and fail closed if a real connector would be called.

**Why:** The platform Drive is shared by development and production. Live inspection found integration-test studio folders in the real backup root; test database rows alone do not isolate cloud side effects.

**How to apply:** Compile tests from current sources, inject provider requesters, and keep live connector calls disabled in test mode. Never treat an old bundled test artifact as verification of modified source.