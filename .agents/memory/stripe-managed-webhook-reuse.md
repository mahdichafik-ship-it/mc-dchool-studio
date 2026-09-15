---
name: Stripe managed webhook reuse
description: Compatibility rules for safely reusing legacy stripe-replit-sync managed webhooks across API restarts.
---

Legacy `stripe-replit-sync` managed-webhook rows expose the Stripe endpoint identifier under `_id`, while the package reuse path expects `id`. Normalize the identifier and retain one enabled endpoint for the current app URL instead of trusting the package's reuse method.

**Why:** The mismatch makes every development restart create another Stripe endpoint until the account's test-webhook limit is reached, even though valid managed rows already exist.

**How to apply:** Match only the current app's webhook base URL, retain one enabled endpoint, delete same-URL duplicates from Stripe and local bookkeeping, update its event configuration in place, and create a replacement only when no usable match remains.

Legacy managed endpoints append a UUID path segment, and webhook verification needs that UUID to load the endpoint-specific signing secret.

**Why:** Registering only the base webhook route means Stripe posts to an unhandled URL, while verifying a managed endpoint without its UUID uses the wrong secret path.

**How to apply:** Accept both the base route and the UUID-suffixed route, then pass the UUID to the sync library's webhook processor.