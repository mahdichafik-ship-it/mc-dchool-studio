---
name: Delivery access and payment availability
description: Keep a private gallery’s access path available even if Stripe configuration or catalog access fails.
---

Private-gallery access and photo visibility must remain available when any payment provider is unavailable. Disable only the unavailable method; keep Volume Capture orders and all other configured payment methods available.

**Why:** A provider connection failure is an operations problem, not evidence that a family’s private access code or order is invalid. Conflating them blocks legitimate access and manual payment methods.

**How to apply:** Keep provider capability checks separate from access-token validation, photo retrieval, offer pricing, and order persistence. Do not expose provider diagnostics publicly. A failed online checkout may cancel only its matching provider attempt, never the gallery or another method.