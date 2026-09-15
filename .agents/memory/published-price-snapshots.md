---
name: Published price snapshots
description: Why reusable price-sheet edits and repeated publish calls must not alter prices already shown to customers.
---

Once a delivery gallery is published, its saved offer snapshot is authoritative. Repeated or concurrent publish calls must reuse that snapshot rather than reread the assigned reusable price sheet.

**Why:** Reusable sheets remain editable for future projects. Reapplying an edited sheet during an idempotent publish retry would silently change live customer prices.

**How to apply:** Treat the reusable sheet as the source only while a gallery is draft. After publication, validate and preserve the gallery snapshot until the gallery is explicitly revoked.