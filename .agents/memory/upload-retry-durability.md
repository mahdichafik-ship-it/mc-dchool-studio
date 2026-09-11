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

Retry deadlines apply to every retryable job even when its persisted status is “pending,” and a newly persisted capture must wake the live-upload scheduler.

**Why:** Retryable HTTP and network failures are intentionally returned to the queued state. Filtering delays only for the error state caused old timed-out jobs to be selected repeatedly while fresh captures accumulated behind them.

**How to apply:** Exclude any job whose retry deadline is still in the future, prioritize jobs without retry history, and clear project-level delay when a new capture is ready.

Files without a destination identity are blocked local captures, not queued uploads.

**Why:** Counting unmatched capture files as queued created a permanent nonzero queue even though the uploader correctly excluded them; the detailed queue and headline count then disagreed.

**How to apply:** Exclude unmatched files from uploadable pending counts, preserve them locally, and show them separately with the reason they cannot upload.

Never transfer or replace a capture batch across desktop connections without server-side accounting for durable files whose success response may have been lost.

**Why:** Retrying an already-committed file can return an idempotent success while leaving that file credited to the original batch. A replacement batch would then remain permanently below its expected count.

**How to apply:** Preserve cross-connection ownership until an explicit supersession design records batch membership independently or atomically transfers every reused file.