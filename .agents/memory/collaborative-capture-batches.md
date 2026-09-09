---
name: Collaborative capture batches
description: Durable identity and completion rules for consolidating multiple photographers into one cloud project.
---

Each photographer/device contribution is a distinct, retry-stable capture batch inside the canonical cloud project. Uploaded files retain project, student, capture, batch, member, and desktop-connection attribution; consolidation must never depend on filenames alone.

**Why:** Multiple photographers can independently create identical camera filenames and may finish at different times or retry after partial network failures. A project-wide finished flag would either overwrite provenance or hide incomplete work.

**How to apply:** Create or resume the same batch when Upload & Finish is retried, link every uploaded student or group JPEG/RAW to it, and only mark the local project finished after the server confirms that batch complete. Older unbatched uploads remain visible as compatibility data. Overall project completion is a separate owner-facing gate across all batches, failures, duplicate students, pair completeness, and acknowledged missing students.