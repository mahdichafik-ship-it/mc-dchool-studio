---
name: GitHub workflow write permissions
description: Permission boundary encountered when updating GitHub Actions workflow files through the installed integration.
---

The installed GitHub connection can create and merge ordinary source-file pull requests but may reject commits that modify `.github/workflows` with a 403.

**Why:** Workflow files require an additional GitHub permission scope. Retrying different Git-tree or repository-content endpoints does not safely bypass that boundary.

**How to apply:** Leave the release and repository state unchanged when this occurs. Use an explicitly authorized workflow-write connection or an approved credential path before attempting the workflow change again.