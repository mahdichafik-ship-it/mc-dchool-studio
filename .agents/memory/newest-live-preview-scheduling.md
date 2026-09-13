---
name: Newest live preview scheduling
description: Desktop burst behavior when capture persistence and visible preview work run on separate paths.
---

Live-preview generation must have at most one active job and one newest pending job. Superseding a pending preview must never remove the capture from assignment, persistence, pairing, gallery, or restart recovery.

**Why:** A FIFO preview queue makes visible latency scale with burst size even when every original is safely persisted. Preview generation also needs priority over large managed copies.

**How to apply:** Enqueue persistence independently for every capture, gate copy work behind the live-preview scheduler when necessary, and do not regenerate skipped live previews during persistence completion; gallery thumbnails are a separate lower-priority concern.

Explicit manual or active-student targets must bypass full-image QR decoding before preview enqueue; QR decoding is only needed when the app is discovering a new marker.

**Why:** Serial QR scans of large camera JPEGs can build a minutes-long ingestion backlog before the live-preview scheduler receives any work.

**How to apply:** Preserve filename-conflict validation, but route captures with an already-known target directly to matching and local preview generation.

The large review stage must render a live preview only when that preview can be matched to the same latest capture whose metadata is shown. Capture loads must also be scoped to the currently viewed subject, and manual review should use an identity that survives optimistic-to-persisted ID replacement.

**Why:** Preview generation, SQLite persistence, realtime events, and subject navigation complete independently. Without identity checks, the UI can show one frame's pixels beside another frame's metadata or briefly expose the previous subject's review controls.

**How to apply:** Reject stale subject-load responses, clear or mask prior-subject data immediately, match live previews by stable source identity, and keep manual selection on a stable capture key rather than a temporary database ID.