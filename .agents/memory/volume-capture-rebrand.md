---
name: Volume Capture rebrand compatibility
description: Public naming and backward-compatibility rules for the Volume Capture product rebrand.
---

Use “Volume Capture” for customer-facing web and in-app branding, update prompts,
and newly created cloud backup folders. Keep legacy internal package slugs,
application IDs, updater feed identity, database filenames, existing local
storage paths, and the packaged macOS bundle/executable identity stable until a
separately gated migration proves upgrades from the existing release.

**Why:** Existing photographer Macs must upgrade in place and continue finding
their current databases and managed originals. A release that changed the macOS
product/bundle name built, signed, and launched successfully but failed the real
installed-update restart on both Intel and Apple silicon. App ID stability alone
does not prove updater compatibility.

**How to apply:** New user-visible copy should say “Volume Capture.” Treat old
internal identifiers, macOS package identity, and the established local root path
as compatibility contracts. Keep a release draft until native upgrade-and-restart
smokes pass from the latest public version on both Mac architectures.