---
name: Roster re-import identity
description: Matching and ambiguity rules for repeat school and corporate roster imports.
---

Reconcile roster rows only within the target project. Prefer a supplied stable student or employee ID; use normalized email or unique name-plus-class fallbacks only when ownership is unambiguous.

**Why:** Re-imports must preserve QR, photo, group, and cloud identity without merging two people who share or cross-use primary and secondary email addresses.

**How to apply:** Index email ownership across both email slots, preflight duplicate input rows before mutation, reuse normalized class or department names, preserve internal identities on updates/moves, and fail closed on ambiguous or contradictory identifiers.