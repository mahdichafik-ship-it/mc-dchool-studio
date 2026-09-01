---
name: Lightweight preview artifacts
description: Durable constraints for desktop JPEG and RAW preview generation and packaging.
---

Renderer preview URLs must resolve only to reduced JPEG artifacts. Keep originals untouched, generate JPEG previews with a bounded edge and quality, and extract an embedded JPEG from RAW files without falling back to full RAW decoding.

**Why:** Mapping the renderer directly to a large original removes IPC overhead but still leaves full-resolution decode work on the visible-pixel path. Executable RAW helpers and native image libraries also fail from inside Electron ASAR unless their runtime files are unpacked.

**How to apply:** Generate the lightweight artifact before asynchronous managed-copy and database work, keep capture pairing keyed to the original source, and verify packaged builds contain runnable native image and ExifTool dependencies outside ASAR.