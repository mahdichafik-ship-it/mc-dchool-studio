---
name: Burst preview release gate
description: Validation principle for Watch Folder bursts and newest-image-wins live preview behavior.
---

The live-preview burst fix is acceptable when the newest preview avoids a multi-second final-paint delay while every capture still reaches assignment, file persistence, and the gallery record. The 200–300 ms target is an optimization goal, not a reason to sacrifice capture preservation.

**Why:** Renderer image decode can remain the dominant cost under a large burst even after obsolete live requests are superseded. Blocking the gallery or dropping persistence to chase the target would regress the capture workflow.

**How to apply:** Benchmark one capture plus 10-file and 50-file bursts. Verify the first, middle, and final statuses, superseded counts, and persisted capture/file counts before treating a live-preview scheduling change as complete.