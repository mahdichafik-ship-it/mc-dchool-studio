---
name: Desktop late-student reconciliation
description: Reliability rule for students added from the capture workstation during a live or offline shoot.
---

Students added from the desktop must become usable for local manual capture immediately, even without a network connection, while retaining a stable generated student code that can be reconciled idempotently to the same cloud project and class.

**Why:** A local-only roster row appears to work during the shoot but strands its JPEG/RAW uploads later because cloud upload authorization requires an authoritative cloud student identity.

**How to apply:** Any desktop roster creation or import path must preserve the generated code across retries, create or find the matching cloud student before file upload, and never discard the local student or captures when cloud reconciliation is temporarily unavailable.