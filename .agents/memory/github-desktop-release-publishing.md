---
name: GitHub desktop release publishing
description: The workspace Git remote cannot push directly, while the installed GitHub integration can publish desktop release tags.
---

Publish desktop release tags through the authorized GitHub integration rather than relying on a direct `git push` from the workspace.

**Why:** The configured HTTPS remote rejects Git operations because no Git credential is attached to the workspace, but the existing GitHub integration can create the tag and trigger the signed macOS release workflow without exposing a token.

**How to apply:** Use the repository's existing desktop release workflow and verify the completed release contains both architecture installers, ZIPs, blockmaps, and `latest-mac.yml` before telling the user to update.