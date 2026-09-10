---
name: Explicit project sync boundary
description: The desktop capture lifecycle separates local shooting from deliberate cloud synchronization.
---

During a shoot, Watch Folder ingestion must copy, assign, pair, preview, and review captures locally without requiring cloud availability. A photographer may deliberately enable Live Upload for background transfer, but upload and finishing remain separate actions.

**Why:** Photographers need uninterrupted capture during poor connectivity. Live Upload can reduce end-of-shoot waiting, but network state must never control capture intake or imply that a photographer has finished.

**How to apply:** Keep watcher, active-student, pairing, and local-folder code independent from upload success. Live Upload is opt-in per project, runs sequentially in the background, pauses safely offline, retains originals locally, and uses the same retry-stable photographer batch as finalization. A finish operation must pause background transfer, drain queued captures, report progress, preserve the unfinished state on any failure, and persist completion only after the server confirms the photographer batch complete.