---
name: Platform studio oversight
description: Safety boundaries for platform-owner access and controls inside a studio.
---

Platform-owner oversight must be visibly labeled and every control action must be recorded. Do not silently impersonate a studio owner or create a fake studio membership.

**Why:** Support needs owner-equivalent visibility and emergency controls, but silent impersonation would obscure who acted and could weaken studio isolation.

**How to apply:** Scope every oversight query and mutation to an explicit studio ID. Archive instead of hard-delete: preserve projects, files, members, and audit history while blocking ordinary web access and revoking desktop access.