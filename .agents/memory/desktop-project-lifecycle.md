---
name: Desktop project lifecycle
description: Product decisions for archiving, deleting, and retaining desktop project data.
---

Sent projects appear with archived projects, while Deleted remains a separate view. Archiving must not remove project data. Photo cleanup is strictly local: never delete anything from Volume Capture cloud or a connected backup. Require a verified remote copy before removing managed local media, and leave the photographer's original source/watch-folder files untouched. Keep project metadata available in Deleted.

**Why:** The photographer needs a safe way to reclaim local media without changing any cloud or backup copy.

**How to apply:** Keep archive actions metadata-only. Gate local cleanup on authoritative remote-copy proof, constrain file deletion to app-managed local paths, and never call a cloud or backup delete operation.
