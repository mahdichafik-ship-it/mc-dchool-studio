---
name: Studio storage fallback
description: Rules for routing studio backups while studio-owned storage connections are pending or changed.
---

The platform work Google Drive remains the active backup destination until a studio-owned provider is fully authorized and marked connected. A saved Google Drive or Dropbox preference is only a connection request, not proof of an active connection.

**Why:** Studio setup must never create a period where original JPEG or RAW uploads have no backup destination, and the interface must not imply OAuth succeeded before it did.

**How to apply:** Route pending, deferred, and failed studio connections through the platform fallback. Separate platform folders by studio. Switching preferences must not move, rename, or delete files already backed up.