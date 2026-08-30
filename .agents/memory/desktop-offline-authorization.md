---
name: Desktop offline authorization
description: Security boundary between cached offline photo-day access and server-authorized cloud operations.
---

A previously verified desktop may use a cached member identity to open synced projects and capture locally while the server is unreachable. Cloud writes must remain queued until a fresh server session check succeeds, and any authoritative 401 from any desktop API path must clear both cached identity and connection credentials.

**Why:** A stored token alone cannot prove the connection is still active. Allowing it to upload before revalidation creates a race with revocation, while retaining cached credentials after a known 401 lets a revoked desktop regain offline access on restart.

**How to apply:** Gate uploads behind process-local server verification, persist photos as pending during outages, revalidate before draining the queue, and route every authenticated endpoint's 401 through the same terminal credential invalidation path.

Keep local database identities separate from authoritative cloud identities, and reconcile roster re-syncs in place rather than replacing rows that captured photos reference.

**Why:** Local autoincrement IDs are not valid API identifiers, and destructive roster replacement can orphan durable pending captures before they reconnect.

**How to apply:** Persist remote IDs on synced entities, resolve them only when constructing cloud requests, and preserve local project/student foreign keys across re-syncs.