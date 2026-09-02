---
name: Apple notarization timeouts
description: How to classify transient Apple notary service failures during native desktop releases.
---

An Intel packaging failure with `NSURLErrorDomain Code=-1001` while polling `appstoreconnect.apple.com/notary/v2/submissions` is a transient Apple notarization timeout, not evidence of the renderer-startup or wrong-architecture failures seen in broken desktop packages.

**Why:** The native runner, x64 Electron runtime, and native dependency pruning can all be correct while Apple's notary API times out. Misclassifying that network failure encourages unnecessary package changes and obscures whether the Intel app ever reached its launch smoke.

**How to apply:** Keep publication fail-closed, confirm the failure URL and error code in the packaging log, then rerun the unchanged failed job. Accept the release only after the Intel packaged-app smoke and installed-update restart both pass.