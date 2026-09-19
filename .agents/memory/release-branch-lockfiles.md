---
name: Release branch lockfiles
description: Release branch ancestry and platform-only dependency synchronization for frozen CI installs
---

Release branches must start from the current protected `main` tree and preserve its package manifests and lockfile together. Platform-only packaging dependencies such as `dmg-license` may be removed by the Linux preinstall cleanup locally, but must remain in the committed macOS manifest and lockfile.

**Why:** A release branch created from a stale local checkout omitted a main-branch packaging dependency while retaining the lockfile entry. GitHub’s frozen install rejected the release before any tests ran.

**How to apply:** Before creating a release PR, compare the candidate tree with `main`, keep platform-only dependencies in `package.json`, and reproduce `pnpm install --frozen-lockfile` from the exact PR commit.