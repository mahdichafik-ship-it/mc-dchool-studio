---
name: Stripe migration compatibility
description: Startup behavior when stripe-replit-sync schema state and migration ledger come from different package generations.
---

When the Stripe schema already contains the modern generated-column tables but the legacy migration ledger is incomplete, reconcile the ledger only after detecting the modern schema markers; do not run legacy migrations against those tables.

**Why:** The installed sync package can expose an older ordered migration chain than the schema already present in development. Re-running legacy migrations can fail on existing triggers, columns, or incompatible subscription-item shapes and prevent webhook initialization.

**How to apply:** Keep fresh databases on the normal migration path. For an already-modern schema, use the copied migration files to calculate the exact filename-plus-content hashes before recording skipped legacy migrations, so the migration library's integrity validation still passes.