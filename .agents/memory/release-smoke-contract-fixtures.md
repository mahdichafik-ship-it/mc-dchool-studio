---
name: Release smoke contract fixtures
description: Keeps packaged desktop release smoke servers aligned with strict production API response validation.
---

When desktop upload response validation becomes stricter, update every packaged-release smoke server to return the complete production response contract before creating a release tag.

**Why:** A signed and notarized Mac build was correctly blocked on both architectures because the smoke fixture still returned a formerly accepted minimal capture response. The application behavior was correct; the stale fixture prevented publication.

**How to apply:** Treat mocked success responses in native release smoke tests as protocol consumers. Validate their shapes alongside focused malformed-response tests whenever upload or verification contracts change.