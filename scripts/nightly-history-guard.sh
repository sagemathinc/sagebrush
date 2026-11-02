#!/usr/bin/env bash
# Stage A layer 1's guarded re-runs, nightly-ready and NOT wired into any workflow (@sagebrush, Nov 2 2026: William's
# CI-speed ruling keeps new per-PR suites out until he decides on the nightly/full tier).  The five workspace suites run
# again under history's census guard (HISTORY_GUARD=1: history ACTIVE, every source write checked to carry its token).
# Needs a built tree (pnpm run build && node scripts/build-cli.mjs && bun web/build.ts) and Chrome; about 11 minutes.
#   bash scripts/nightly-history-guard.sh        (CHROME=google-chrome by default)
set -u
cd "$(dirname "$0")/.." || exit 2
CHROME=${CHROME:-google-chrome}
failed=""
for s in test-workspace test-workspace-sync-ops test-workspace-sync-outbox test-workspace-sync-pins test-workspace-sync-d11; do
  echo "== HISTORY_GUARD=1 $s"
  HISTORY_GUARD=1 CHROME=$CHROME bun web/workspace/$s.mjs || failed="$failed $s"
done
[ -z "$failed" ] && echo "nightly-history-guard: ok (5 suites)" || { echo "nightly-history-guard: FAILED:$failed"; exit 1; }
