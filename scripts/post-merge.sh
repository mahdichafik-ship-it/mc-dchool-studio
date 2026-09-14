#!/bin/bash
set -e
pnpm install --frozen-lockfile --prefer-offline
# Repair legacy project-scoped duplicate roster IDs and create the unique index
# in one locked transaction. Drizzle then verifies the resulting schema.
pnpm --filter db repair:student-ids
# Require a definitive Drizzle completion marker because Drizzle Kit 0.31.10
# can catch a non-TTY prompt and still exit successfully.
bash scripts/post-merge-schema.sh
