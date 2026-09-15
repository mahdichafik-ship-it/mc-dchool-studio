---
name: Student-targeted file drops
description: Safety boundaries for importing OS-dropped capture files onto a specific student.
---

Dropped files keep the student selected at drop time and may pair only with files owned by that student.

**Why:** The active camera target can change while an import runs, and common camera filenames can repeat across students. Project-only pairing can silently combine one student's JPEG with another student's RAW.

**How to apply:** Carry an explicit immutable student target through persistence and require strict student ownership for both JPEG-first and RAW-first pairing. Do not mutate the active camera target.

Renderer-supplied paths are not trusted import authority.

**Why:** A generic IPC bridge that accepts arbitrary local paths can turn compromised renderer code into a local image read-and-upload path.

**How to apply:** Resolve actual OS-dropped File objects inside preload, authorize the import with a sender-bound closure-private capability, and reject direct raw-path IPC calls.