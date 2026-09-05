---
name: Volume Capture rebrand compatibility
description: Public naming and backward-compatibility rules for the Volume Capture product rebrand.
---

Use “Volume Capture” for all customer-facing product branding, including the web
platform, desktop app name, update prompts, and newly created cloud backup
folders. Keep legacy internal package slugs, application IDs, updater feed
identity, database filenames, and existing local storage paths stable.

**Why:** Existing photographer Macs must upgrade in place and continue finding
their current databases and managed originals. Renaming compatibility-sensitive
identifiers during a visual rebrand can create a second application identity or
split local capture storage.

**How to apply:** New user-visible copy should say “Volume Capture.” Treat old
internal `mc-school-studio` identifiers and the established local root path as
compatibility contracts unless a separately tested migration explicitly replaces
them.