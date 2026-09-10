---
name: Studio storage fallback
description: Rules for routing studio backups while studio-owned storage connections are pending or changed.
---

The platform owner's connected Google Drive is the canonical primary backup for every studio. A fully authorized studio-owned Google Drive or Dropbox receives an optional second copy; pending, failed, or disconnected providers never replace the primary.

**Why:** The platform owner needs a durable copy of every original JPEG and RAW file, while studios may want their own second destination. Upload success must not depend on a studio-owned connection.

**How to apply:** Write to the platform Drive first, then attempt the connected studio provider. Keep separate platform folders by studio. If the secondary copy fails, mark that connection unhealthy but keep the upload successful when the primary copy succeeded. Switching preferences must not move, rename, or delete existing files.