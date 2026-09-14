---
name: R2 deletion outbox
description: Concurrency rules for durable deletion of private photo objects.
---

Photo deletion must lock the authorized parent and all descendant photo/file rows before enumerating storage copies, then enqueue deletion records for original and staging keys in the same transaction as the source deletion. Verification must reserve cleanup for each candidate before copying provider bytes and for staging before clearing its database pointer. A worker may finalize an item only when its claim token still matches the current deleting claim. Cleanup must include every current and safely attributable legacy variant.

**Why:** Cascade deletes can race new storage-copy inserts, a timed-out worker can finish after a replacement worker, presigned staging uploads can finish after their source row disappears, verification candidates exist before promotion, and generated variants are separate private objects. Missing any rule can orphan private bytes or overwrite newer cleanup state.

**How to apply:** Any new route that deletes a project, class, student, group, capture, or photo must use the shared scoped enqueue path. Scope idempotency to storage-copy/key lifecycles, reserve candidates before copy, delay staging deletion until signed PUTs expire, guard live keys, skip shared legacy prefixes, and recheck variant ownership.