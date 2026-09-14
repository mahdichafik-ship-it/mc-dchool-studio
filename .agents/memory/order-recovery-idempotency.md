---
name: Order recovery idempotency
description: Durable customer recovery and uncertain payment-provider rules.
---

Every customer checkout attempt uses one project-scoped durable idempotency identity and a separate high-entropy recovery credential. Provider uncertainty must never create a second order automatically.

**Why:** A lost response can occur after Stripe accepts a session. Retrying with a new order risks duplicate charges, while trusting incomplete webhook data could grant the wrong order.

**How to apply:** Hash recovery secrets at rest, send them to APIs in headers, keep deep-link secrets in URL fragments, and expose only safe order fields. Bind a null-session uncertain Stripe order only from an authenticated completion event whose order, gallery, project, amount, currency, paid status, and customer identity are all present and exact.