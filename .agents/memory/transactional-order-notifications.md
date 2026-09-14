---
name: Transactional order notifications
description: Reliability and privacy rules for durable order email and Stripe attempt recovery.
---

Order-received and payment-confirmed email events must be committed atomically with their corresponding order transition in a dedicated encrypted outbox. A definitive provider rejection may be explicitly retried by an authorized studio manager; a timeout, stale claim, crash after claim, or otherwise uncertain provider outcome must remain quarantined for review and must never resend automatically.

**Why:** A process can terminate between a business commit, provider acceptance, and local result persistence. Automatic retries after an uncertain outcome can duplicate customer communication, while best-effort post-commit sends can permanently lose it.

**How to apply:** Keep immutable finalized message snapshots and recovery capabilities encrypted, validate the existing recovery hash before sending, use bounded skip-locked claims with completion fencing, and expose only safe status metadata to project-scoped Owner/Admin users. Stripe attempt recovery may call the provider again only with the exact persisted parameters and original idempotency key; legacy attempts without that payload remain reviewable without a provider call.