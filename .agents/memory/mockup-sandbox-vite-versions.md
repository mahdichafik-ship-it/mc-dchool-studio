---
name: Mockup sandbox Vite versions
description: Vite major-version type mismatches that affect mockup sandbox validation
---

The mockup sandbox can render its preview successfully while `tsc` fails in `vite.config.ts` because the preview plugin and the Vite config resolve different major Vite type definitions.

**Why:** the failure is in the sandbox toolchain's plugin/config boundary, so it can be unrelated to the extracted component being previewed.

**How to apply:** When this exact `Plugin`/`DevEnvironment` mismatch appears, verify the dependency graph and align the plugin and Vite major versions before treating component code as the cause.