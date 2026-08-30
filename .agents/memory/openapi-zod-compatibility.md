---
name: OpenAPI Zod compatibility
description: Compatibility constraint between the repository's Orval output and its installed Zod runtime.
---

The generated API validation package currently targets Zod 3, while the installed Orval version emits the Zod 4-style `zod.email()` helper for OpenAPI `format: email`.

**Why:** Running code generation after adding email-formatted schemas can break the library typecheck even when the API and frontend code are otherwise correct.

**How to apply:** Keep email syntax validation in the route or an explicit Zod 3-compatible schema unless the workspace's Zod/Orval versions are upgraded together.