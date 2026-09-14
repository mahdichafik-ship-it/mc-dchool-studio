---
name: Transactional gallery invitations
description: Durable recipient, idempotency, and delivery-state rules for published-gallery email invitations.
---

Create one transactional invitation per normalized recipient per gallery and durably link every applicable subject access to it. Primary and secondary roster addresses are delivery contacts, never evidence of marketing consent.

**Why:** Shared family or company inboxes must receive one message without losing any subject’s private access. Publication is authoritative even when email is unavailable, and an uncertain provider response may already represent an accepted send.

**How to apply:** Create access and invitation records in the publication transaction, then contact the provider only after commit. Use durable content revisions and attempt-specific idempotency keys. Retry only definitive provider rejections; quarantine network, server, incomplete, stale, or otherwise uncertain outcomes for reconciliation. Production sends require a verified custom-domain sender and HTTPS public URL; development and tests must never reach a non-loopback email provider.