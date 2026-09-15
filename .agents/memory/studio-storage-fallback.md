---
name: Studio storage fallback
description: Rules for routing studio backups while studio-owned storage connections are pending or changed.
---

The platform owner's Google Drive is enabled by default as a managed fallback. After a studio-owned Google Drive or Dropbox is verified, owners/admins may keep both destinations or disable the platform copy.

**Why:** Studios need immediate backup coverage before OAuth setup, but the platform Drive is an optional service rather than a mandatory copy once the studio has its own verified storage.

**How to apply:** Require at least one verified destination. New studios start with platform backup enabled. Platform backup may be disabled only while a studio provider is active, and that last provider cannot be disconnected until platform backup is re-enabled. With two destinations enabled, one successful copy keeps the upload successful. Preference changes never move, rename, or delete existing files.