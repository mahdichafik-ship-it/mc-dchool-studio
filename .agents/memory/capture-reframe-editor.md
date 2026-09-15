---
name: Capture reframe editor
description: Approved interaction and safety boundaries for desktop reframing and straightening.
---

The approved editing direction opens a focused Reframe & Straighten workspace from the large capture-review stage instead of crowding editing controls into the shooting view.

**Why:** The photographer needs enough space to judge crop and horizon corrections while retaining clear capture context and avoiding accidental changes during active shooting.

Desktop preview and cloud derivatives must use the same aspect-first crop rectangle, zoom scale, and normalized focal position. A successful older sync response must never clear a newer pending edit, and finishing a batch must stop if saved edits remain unsynchronized.

**Why:** CSS transform approximations can display a different crop than gallery, download, or print output. Offline edits can otherwise be stranded when files upload after the initial edit sync attempt.

**How to apply:** Keep crop/reframe, aspect ratios, straightening, 90-degree rotation, reset, cancel, and save together. Store edits non-destructively and clearly state that original JPEG and RAW files remain untouched. Serialize edit synchronization per capture, compare the acknowledged version before clearing pending state, and flush pending edits before completing a photographer batch.