---
name: Desktop cloud upload identity
description: The authority contract between imported desktop roster records and cloud upload routes
---

The desktop upload route is authorized by the server-side project and student IDs, not by local SQLite row IDs. Any roster import must preserve the cloud IDs carried by the export, and legacy rows without them must be repaired from an assigned cloud bundle before constructing an upload URL.

**Why:** Local capture and matching can succeed even when cloud identity is missing, so this failure only appears after a photographer has already taken photos. Guessing from local IDs or ambiguous school names could also route files to the wrong project.

**How to apply:** Keep project/student identity repair server-authoritative, reject ambiguous project matches, and deduplicate concurrent repairs per project/student before uploading JPEG or RAW files.