---
name: Desktop upload idempotency
description: Safety rule for replaying desktop capture uploads after retries or client bugs.
---

Desktop upload identifiers are scoped to the photographer desktop connection, but a replay is valid only when its project, student target, and JPEG/RAW file role match the stored upload. A mismatch must be rejected as a conflict rather than returning the original file.

**Why:** A durable retry key prevents duplicate files, but accepting that key for a different target could silently attach a capture to the wrong student or treat a JPEG upload as a RAW member.

**How to apply:** Validate the stored capture target and file role before honoring an idempotent replay; keep the existing capture/file response for matching retries and fail closed for mismatches.