---
name: Lightroom rating export
description: Preserve Volume Capture star ratings for Lightroom without modifying managed originals.
---

When photographers export captures for Lightroom, write the Volume Capture rating as standard XMP metadata on the exported copy. Embed `XMP:Rating` in JPEG copies and write a same-basename `.xmp` sidecar for RAW copies. Keep the image and sidecar together when moving the export.

**Why:** Capture storage can share file identity with an ingest source through hard links. Editing metadata in place could mutate the camera/spool source or alter files used by other workflows.

**How to apply:** Apply metadata only after copying to the export destination. Keep export counts clear about embedded ratings and sidecars, and fail visibly if metadata cannot be written. Verify Lightroom ingestion on macOS before relying on the workflow for a shoot.
