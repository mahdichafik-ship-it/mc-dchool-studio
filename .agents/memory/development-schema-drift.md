---
name: Development schema drift
description: Safety constraint when applying schema changes to the shared development database.
---

The development database contains populated tables and columns that can be absent from this checkout's Drizzle schema. A failed or narrowly filtered push can apply additive DDL before failing on an unrelated operation, so inspect the database after every push attempt. Do not use `--force` or manual DDL to bypass drift.

**Why:** A filtered push added a student JSONB column before failing on an unrelated project sequence. Existing order, notification, email-template, proof, and yearbook rows remained intact, but a failed command did not mean the database was unchanged.

**How to apply:** Reconcile Drizzle schema source with the actual development database, then use a normal non-force push and verify previously flagged tables, columns, and row counts afterward. Pause if a push proposes destructive changes.
