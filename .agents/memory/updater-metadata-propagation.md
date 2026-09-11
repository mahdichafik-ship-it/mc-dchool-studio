---
name: Updater metadata propagation
description: How to interpret an installed-update smoke test that sees the previous release immediately after publishing.
---

A Mac installed-update smoke test may briefly receive the previous `latest-mac.yml` immediately after a new GitHub release is published. If packaging, signing, notarization, publication, and another architecture's update smoke are healthy, rerun the unchanged failed update-smoke job after propagation.

**Why:** One architecture queried the updater immediately after publication and reported the previous version as latest, while the other architecture queried seconds later and updated successfully. The unchanged rerun then passed.

**How to apply:** Confirm the failed log says the source version is “not available” because the reported latest version is still the previous release. Do not treat different updater, launch, signing, or installation errors as propagation delays.