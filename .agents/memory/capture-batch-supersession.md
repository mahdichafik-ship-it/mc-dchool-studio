---
name: Capture batch supersession
description: Safety rules for resuming an interrupted desktop capture batch after a Mac reconnects with a new cloud identity.
---

Resume an interrupted capture batch by creating a replacement batch that explicitly supersedes the old one. Never transfer ownership of the old batch, and reject supersession while its desktop connection remains active. Files already committed under the old batch may move to the replacement only through their retry-stable upload identity and original batch membership.

**Why:** A desktop can lose the success response after durable storage commits. Treating the retry as a new file loses accounting, while silently taking over an active Mac's batch risks cross-device corruption and double-counting.

**How to apply:** Any new portrait, group, or legacy upload path participating in capture batches must attach idempotently reused files to an explicit replacement batch and include them in replacement completion counts. Keep the old batch visible as superseded.