---
name: Capture review compatibility
description: Compatibility rules for keeping the legacy JPEG workflow aligned with capture completeness review.
---

The legacy `photos` workflow remains the compatibility source for existing JPEG actions, but any delete or reassign operation must also update its linked capture and JPEG file record.

**Why:** The review screen reads capture/file rows while existing photographer actions still mutate legacy photo rows. Updating only one side can falsely report a complete pair or retain a deleted JPEG path.

**How to apply:** When changing photo mutations, preserve the legacy action and mirror its capture/file consequences, then emit the capture update event so project and student review counts refresh immediately.

Unmatched-photo events must include the originating project context; otherwise a multi-project desktop session cannot refresh or filter the correct review surface.

**Why:** The watcher can process several project folders at once, so a project-agnostic unmatched event either refreshes unrelated projects or leaves the affected project’s recoverable photo hidden.

**How to apply:** Include the project identifier when emitting unmatched events and filter renderer subscriptions before reloading unmatched photos, project totals, or completeness summaries.