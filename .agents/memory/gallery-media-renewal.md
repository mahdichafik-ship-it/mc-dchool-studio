---
name: Gallery media renewal
description: Refresh rules for short-lived private gallery media during long sessions.
---

Keep private media tokens short-lived and renew gallery content before those tokens expire, without clearing basket or order state.

**Why:** A gallery can remain open longer than one media-token lifetime. Static signed URLs then break previews and paid downloads even though gallery access is still valid.

**How to apply:** Return explicit media expiry, schedule a bounded pre-expiry content refresh, replace URLs in place, cancel timers when access changes, preserve state on transient refresh failures, and clear gallery access only on an authoritative expiry response.