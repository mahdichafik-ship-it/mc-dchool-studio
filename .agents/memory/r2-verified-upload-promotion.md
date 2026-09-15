---
name: R2 verified upload promotion
description: Integrity rules for direct desktop uploads into private Cloudflare R2 storage.
---

Cloudflare R2 presigned PUT requests canonicalize the payload as `UNSIGNED-PAYLOAD`; do not treat signed metadata as proof of the uploaded bytes and do not issue client-writable URLs for accepted final keys.

**Why:** A reusable presigned URL can replace staging bytes after an earlier verification. Hashing staging and then copying to a shared final key also leaves replay and concurrent-verifier races.

**How to apply:** Give every attempt a unique staging key. Copy it to a unique server-only candidate, stream-hash the candidate, and atomically claim that exact candidate as the final copy only if the attempt still owns the storage-copy row. Losing attempts delete only their own keys.