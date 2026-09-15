---
name: SheetJS upstream releases
description: How to interpret and maintain SheetJS dependencies after npm registry releases stopped.
---

Use a maintained SheetJS Community Edition release from the vendor's official CDN rather than the stale npm registry package.

**Why:** The npm registry stopped at an affected release. Fixed versions are distributed upstream, but some npm/OSV scanners still label those versions vulnerable because their advisory ranges do not model vendor-CDN releases.

**How to apply:** Keep spreadsheet parsing bounded independently of library fixes. When auditing, verify the installed upstream version against each advisory's fixed version instead of treating an npm scanner's “no fix” label as conclusive.