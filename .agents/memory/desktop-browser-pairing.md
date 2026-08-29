---
name: Desktop browser pairing
description: Production reachability constraint for the Mac desktop browser sign-in flow.
---

The Mac desktop sign-in flow must use a publicly reachable production deployment; do not solve a private Replit deployment with a shared external-access credential.

**Why:** The desktop app has no trusted browser session and cannot complete its API polling/exchange through Replit's private deployment boundary without a shared bypass secret.

**How to apply:** Keep the production URL in the signed desktop build, use the normal system browser for Clerk approval, and require publishing visibility to be public before releasing the desktop build.