---
name: Google Drive large uploads
description: Production constraint for sending photo files through the Replit Google Drive connector.
---

Use Google Drive resumable uploads for photo backups: start the authenticated session through the connector, then PUT the bytes to Google's returned upload URL. Do not send large multipart file bodies through the connector proxy.

**Why:** In a published autoscale deployment, connector-authenticated folder and metadata requests succeeded, but a large multipart JPEG upload was blocked by a Cloudflare challenge and returned HTML with HTTP 403.

**How to apply:** Keep connector requests small and authenticated. Validate the returned resumable URL, then upload the file bytes directly to that session URL. Preserve idempotency checks before starting the session.