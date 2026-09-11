---
name: Delivery access and payment availability
description: Keep a private gallery’s access path available even if Stripe configuration or catalog access fails.
---

Private-gallery access and photo visibility must remain available when Stripe is unavailable. Return the authenticated subject’s approved photos with ordering disabled, and tell the visitor that checkout is temporarily unavailable.

**Why:** A Stripe connection or catalog configuration failure is an operations problem, not evidence that a family’s private access code is invalid. Conflating the two blocks legitimate photo access and creates misleading support reports.

**How to apply:** Any gallery request that needs live Stripe prices must isolate that pricing work from access-token validation and photo retrieval. Treat checkout as unavailable until Stripe is restored; do not expose payment-provider diagnostics to public visitors.