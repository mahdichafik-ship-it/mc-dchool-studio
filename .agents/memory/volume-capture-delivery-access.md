---
name: Volume Capture delivery access
description: Private delivery should use guardian-friendly access codes and branded galleries rather than child-managed accounts.
---

Published delivery galleries use one random access code per student or employee. The code unlocks only that subject's gallery through a short-lived signed token; public URLs must not expose names or searchable rosters.

**Why:** School photography includes minors, and parent/guardian access codes are lower-friction and safer than requiring each child to create an account.

**How to apply:** Keep delivery separate from photographer authentication, support revocation and expiry, and move delivered photo bytes to durable object storage before relying on public delivery in production.