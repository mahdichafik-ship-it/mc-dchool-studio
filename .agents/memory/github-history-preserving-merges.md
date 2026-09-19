---
name: GitHub history-preserving merges
description: Preserve local commit SHAs when transferring an unpushed linear history through the installed GitHub integration.
---

When recreating commits through GitHub's Git API, derive the commit message from the raw commit object after its header separator, not from display-oriented Git formatters. The formatter can add a trailing newline and silently change every recreated commit SHA.

**Why:** GitHub's API can preserve the tree, parent, author, and committer while still producing a different object when the message bytes differ; exact SHA verification catches that before a branch or pull request is created.

**How to apply:** Build blobs and trees incrementally, verify each recreated commit SHA and parent, create a new branch only after the sequence is verified, and use a non-forced branch update plus a standard merge commit for conflict resolution.