#!/bin/bash
set -euo pipefail

# Drizzle Kit 0.31.10 catches the non-TTY prompt exception and exits zero.
# Capture its output and require one of its definitive completion markers so
# an unattended setup cannot report success when a destructive diff was
# rejected before it ran.
output_file="$(mktemp)"
trap 'rm -f "$output_file"' EXIT

status=0
if pnpm --filter db push </dev/null >"$output_file" 2>&1; then
  status=0
else
  status=$?
fi

cat "$output_file"

if (( status != 0 )); then
  echo "Database schema push failed with exit status ${status}" >&2
  exit "$status"
fi

if grep -Eiq "Interactive prompts require|Found data-loss statements|THIS ACTION WILL CAUSE DATA LOSS|Do you still want to push changes|(^|[[:space:]])Error:" "$output_file"; then
  echo "Database schema push did not complete safely" >&2
  exit 1
fi

applied_count="$(grep -F -c "[✓] Changes applied" "$output_file" || true)"
unchanged_count="$(grep -F -c "[i] No changes detected" "$output_file" || true)"
if (( applied_count + unchanged_count != 1 )); then
  echo "Database schema push did not report a definitive completion marker" >&2
  exit 1
fi