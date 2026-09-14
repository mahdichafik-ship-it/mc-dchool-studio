---
name: OpenAPI Zod compatibility
description: Compatibility constraint between the repository's Orval output and its installed Zod runtime.
---

The generated API validation package targets Zod 3. Newer Orval 8 releases can emit Zod 4-style top-level helpers such as `zod.email()` and `zod.int()`.

**Why:** Orval 8.33 emitted `zod.int()` throughout generated validators and broke both library typechecking and API startup. The first advisory-fixed 8.22 release retained Zod 3 output.

**How to apply:** Keep Orval on a Zod 3-compatible release and keep email syntax validation in the route or an explicit Zod 3 schema unless Zod and generated clients are upgraded together.