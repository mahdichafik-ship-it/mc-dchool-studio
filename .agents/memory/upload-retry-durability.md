---
name: Upload retry durability
description: The backup rule for idempotent desktop uploads after restarts or deployments.
---

When a desktop upload is recognized as an existing record, the server must keep the newly uploaded temporary file available for the backup attempt. It must not delete that file and then resolve the old database filesystem path, because that path may no longer exist after a restart, deployment, or instance change.

**Why:** Production retries exposed that database records and durable object storage can outlive the request-local filesystem path. Treating an idempotent retry as a no-op for storage caused a false Google Drive failure even though the client had sent the file again.

**How to apply:** Preserve idempotent database semantics, use the current request's file as the backup source, and clean up only that redundant temporary file after backup succeeds.