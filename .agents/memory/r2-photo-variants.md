---
name: R2 photo variants
description: Durable rules for optimized thumbnails, previews, and watermark-specific derivatives.
---

Use immutable, deterministic R2 object keys derived from the verified original hash, variant settings, and watermark text. Do not overwrite a derivative when its source or watermark configuration changes.

**Why:** Persistent variants must be reusable without adding a second source-of-truth ledger, and concurrent materialization must be safe. A content/configuration-derived key makes duplicate generation converge on the same bytes and naturally invalidates stale watermark variants.

**How to apply:** Generate base thumbnail and preview variants after original verification, repair missing variants on demand, verify uploaded derivative metadata, and serve them only through authorized routes. Only signed media-token preview URLs may be shared-cacheable; session-authorized previews and originals stay private.