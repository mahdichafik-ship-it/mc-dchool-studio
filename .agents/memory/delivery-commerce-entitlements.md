---
name: Delivery commerce entitlements
description: Rules that keep gallery offer pricing, payment quantities, and original-file access consistent.
---

Price-sheet offers must use their own active Stripe Price ID and a single selection/quantity rule across the public gallery, checkout creation, and persisted order items. Access to original digital files must be derived from paid, persisted item entitlements rather than browser state; print-only orders never entitle an original download.

**Why:** Divergent client and server rules can show a different price than Stripe charges, reject a valid pack or multi-copy print purchase, or expose digital originals after a physical-only order.

**How to apply:** When changing digital, print, or pack offers, update the shared server rule and return the same calculated pricing/selection information to the client. Preserve the entitlement snapshot on every order item and use it as the sole authorization source for downloads.