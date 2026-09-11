---
name: Upload retry durability
description: The backup rule for idempotent desktop uploads after restarts or deployments.
---

When a desktop upload is recognized as an existing record, the server must keep the newly uploaded temporary file available for the backup attempt. It must not delete that file and then resolve the old database filesystem path, because that path may no longer exist after a restart, deployment, or instance change.

**Why:** Production retries exposed that database records and durable object storage can outlive the request-local filesystem path. Treating an idempotent retry as a no-op for storage caused a false Google Drive failure even though the client had sent the file again.

**How to apply:** Preserve idempotent database semantics, use the current request's file as the backup source, and clean up only that redundant temporary file after backup succeeds.

Files in an error state must re-enter live upload automatically with exponential backoff, jitter, and a cap. A manual retry action may bypass the delay, but it must not be the only recovery path.

**Why:** A production desktop remained authenticated and healthy while all failed files were permanently filtered out of normal live-upload runs. The server received no further file requests, so the failure looked like an inconsistent release rather than a visible outage.

**How to apply:** Reset retry history after a confirmed success. Keep group reconciliation failures inside the group queue so portraits continue. Reconcile persisted batch manifests against files that still exist before calculating the expected count.

Never transfer or replace a capture batch across desktop connections without server-side accounting for durable files whose success response may have been lost.

**Why:** Retrying an already-committed file can return an idempotent success while leaving that file credited to the original batch. A replacement batch would then remain permanently below its expected count.

**How to apply:** Preserve cross-connection ownership until an explicit supersession design records batch membership independently or atomically transfers every reused file.