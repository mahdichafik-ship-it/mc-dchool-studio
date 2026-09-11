---
name: Delivery commerce entitlements
description: Rules that keep gallery offer pricing, payment quantities, and original-file access consistent.
---

Volume Capture is the source of truth for price-sheet offers and orders. Each offer persists its own amount, currency, selection rule, delivery methods, and allowed payment methods; Stripe, establishment payment, bank transfer, and future providers only settle an existing Volume Capture order. Reusable price sheets belong to a studio and can be assigned to multiple projects, while each gallery retains an offer snapshot for compatibility and historical stability. Access to original digital files must be derived from a paid, persisted item entitlement rather than browser state; print-only orders never entitle an original download.

**Why:** Stripe is optional and does not support every customer card market. Making its catalog authoritative blocks manual and local payment methods, while divergent client/server rules can still misprice packs or expose downloads incorrectly. Studio ownership makes catalogs reusable without leaking them across studios, and snapshots prevent later catalog edits from changing the meaning of an existing gallery or order.

**How to apply:** Calculate and persist the order before invoking an online provider. Every provider must use the order’s amount and currency, and only a verified provider callback or an authorized studio confirmation may mark it paid. Basket lines may contain different products only when they share a currency, payment method, and delivery method. Preserve the entitlement snapshot on every item and use it as the sole download authorization source.