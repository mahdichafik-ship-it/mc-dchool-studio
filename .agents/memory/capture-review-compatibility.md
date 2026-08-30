---
name: Capture review compatibility
description: Compatibility rules for keeping the legacy JPEG workflow aligned with capture completeness review.
---

The legacy `photos` workflow remains the compatibility source for existing JPEG actions, but any delete or reassign operation must also update its linked capture and JPEG file record.

**Why:** The review screen reads capture/file rows while existing photographer actions still mutate legacy photo rows. Updating only one side can falsely report a complete pair or retain a deleted JPEG path.

**How to apply:** When changing photo mutations, preserve the legacy action and mirror its capture/file consequences, then emit the capture update event so project and student review counts refresh immediately.