---
name: R2 staging cleanup
description: Concurrency and ownership rules for removing abandoned direct-upload staging objects.
---

Refresh the durable activity timestamp whenever a client retries an active direct upload. Cleanup must atomically claim an expired attempt before deleting its exact recorded key, and must reject keys outside the staging namespace.

**Why:** A presigned-URL retry can be active without changing upload state. Deleting by an old timestamp without a refreshed activity marker or compare-and-set claim can remove bytes while a desktop retry or verifier is using them.

**How to apply:** Any new direct-upload retry path must refresh activity. Any cleanup or replacement path must claim the same row, state, staging key, and expiry condition before issuing a storage delete; verified final keys are never cleanup candidates.