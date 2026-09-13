---
name: Project-type compatibility
description: Compatibility rules for school and corporate project modes across web, API, exports, and desktop sync.
---

Store only `school` or `corporate`. Corporate projects reuse the established school, class, and student data concepts internally while the UI presents Company, Department, and Employee terminology. Missing or unknown values normalize to `school`.

School and corporate projects follow the same operational workflow end to end: roster setup, QR matching, capture, image review and selection, upload, gallery publication, customer selection, ordering, delivery, contact tracking, and marketing consent. Project type exists for naming, filtering, and statistics; it must not create different workflow rules.

**Why:** Reusing the proven capture model avoids destabilizing existing projects, desktop installations, folders, QR codes, pairing, offline work, and uploads. Legacy payloads and local databases do not contain a project type.

**How to apply:** Carry project type through every project projection, export, cloud bundle, and desktop import path. Keep all operational behavior shared and adapt only terminology, filters, and reporting unless the user explicitly scopes a future difference.