---
name: Newest live preview scheduling
description: Desktop burst behavior when capture persistence and visible preview work run on separate paths.
---

Live-preview generation must have at most one active job and one newest pending job. Superseding a pending preview must never remove the capture from assignment, persistence, pairing, gallery, or restart recovery.

**Why:** A FIFO preview queue makes visible latency scale with burst size even when every original is safely persisted. Preview generation also needs priority over large managed copies.

**How to apply:** Enqueue persistence independently for every capture, gate copy work behind the live-preview scheduler when necessary, and do not regenerate skipped live previews during persistence completion; gallery thumbnails are a separate lower-priority concern.