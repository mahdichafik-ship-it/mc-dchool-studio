---
name: Project-type compatibility
description: Compatibility rules for school and corporate project modes across web, API, exports, and desktop sync.
---

Store only `school` or `corporate`. Corporate projects reuse the established school, class, and student data concepts internally while the UI presents Company, Department, and Employee terminology. Missing or unknown values normalize to `school`.

**Why:** Reusing the proven capture model avoids destabilizing existing projects, desktop installations, folders, QR codes, pairing, offline work, and uploads. Legacy payloads and local databases do not contain a project type.

**How to apply:** Carry project type through every project projection, export, cloud bundle, and desktop import path. Keep capture and upload behavior shared; adapt only user-facing terminology unless a separately scoped feature requires new corporate data.