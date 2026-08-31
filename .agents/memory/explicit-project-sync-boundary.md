---
name: Explicit project sync boundary
description: The desktop capture lifecycle separates local shooting from deliberate cloud synchronization.
---

During a shoot, Watch Folder ingestion must copy, assign, pair, preview, and review captures locally without requiring cloud availability. Cloud upload is a deliberate end-of-project operation, with explicit retry remaining available for failures.

**Why:** Photographers need uninterrupted capture during poor connectivity, and treating upload as part of ingestion makes local work appear dependent on the network.

**How to apply:** Keep watcher, active-student, pairing, and local-folder code independent from upload triggers. A newly captured local file has neutral upload state until an explicit upload begins; release tests must not treat connectivity recovery as an upload queue. A finish operation must drain queued captures, report progress, preserve the unfinished state on any failure, and persist completion only after all eligible local files succeed.