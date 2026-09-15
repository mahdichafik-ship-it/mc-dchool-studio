---
name: Publish-time schema changes
description: Replit managed database production schema behavior for this project.
---

Keep the Drizzle schema as the source of truth and apply it to development with the established schema-push command. Do not introduce custom migration scripts, deploy hooks, or startup-time DDL for production schema updates.

**Why:** Replit Publish compares the development and production schemas, presents the production diff for review, and applies it safely when the user publishes.

**How to apply:** Before release, ensure the development column/table change has been pushed and verified. Tell the user to review the Publish schema diff; do not bypass it with direct production database writes.