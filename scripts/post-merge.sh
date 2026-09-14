#!/bin/bash
set -e
pnpm install --frozen-lockfile
# Repair legacy project-scoped duplicate roster IDs and create the unique index
# in one locked transaction. Drizzle then verifies the resulting schema.
pnpm --filter db repair:student-ids
pnpm --filter db push
