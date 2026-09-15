---
name: Desktop release discovery
description: Durable authority and validation rules for desktop installer links shown by the web app.
---

Resolve public desktop downloads from the latest stable GitHub Release rather than copying a version or asset URL into the web application. Advertise each platform and architecture only when its complete installer and updater asset set validates independently.

**Why:** Hardcoded web links remained on an old installer after newer desktop releases shipped. A partial or malformed release must not cause photographers to download the wrong package or imply support that has not passed native release gates.

**How to apply:** Keep the repository fixed server-side; reject drafts, prereleases, unexpected tags, hosts, filenames, missing assets, and digest mismatches. Validate bounded updater metadata against the release and fail closed without stale links. Use signed native CI as the package, notarization, launch, and updater byte-validation authority. The client may recommend a confidently detected architecture but must always allow explicit selection and must not infer support for an unbuilt platform.