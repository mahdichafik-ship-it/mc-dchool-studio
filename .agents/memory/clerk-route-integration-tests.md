---
name: Clerk route integration tests
description: The request contract needed to exercise Clerk-protected Express routes without a live Clerk session.
---

When testing Clerk-protected Express routes without contacting Clerk, provide a branded `req.auth` function and return an auth object with `tokenType: "session_token"`; a user ID alone is treated as signed out.

**Why:** `getAuth` filters the request auth object by accepted token type before route code sees `userId`, so a minimal-looking mock can produce a misleading 401.

**How to apply:** Keep the real route authentication middleware in the test and fake only Clerk's middleware-installed request contract. Use the real database and filesystem for lifecycle assertions.