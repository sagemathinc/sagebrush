#!/bin/bash
# Run the notebook page's browser tests (headless Chromium) against web/dist,
# served as sagebrush.space serves it (web/serve.py).  Build first:
#   node scripts/build-cli.mjs && bun web/build.ts && bash web/run-tests.sh [test-name ...]
# Logs go to ${LOGS:-/tmp/sagebrush-web-tests}/<test>.log.
cd "$(dirname "$0")/.."
LOGS=${LOGS:-/tmp/sagebrush-web-tests}
mkdir -p "$LOGS"
tests=("$@")
[ ${#tests[@]} -eq 0 ] && tests=(kernels reactive warm widgets input replay timetravel notebook notebook-component jupyter-ui)
python3 web/serve.py 8765 > /dev/null 2>&1 &
srv=$!
sleep 1
status=0
for t in "${tests[@]}"; do
  log="$LOGS/$t.log"
  timeout 300 node "web/test-$t.mjs" > "$log" 2>&1
  code=$?
  [ $code -ne 0 ] && status=1
  echo "test-$t: exit $code, $(grep -c '^ok' "$log") ok, $(grep -c '^FAIL' "$log") FAIL"
  grep '^FAIL' "$log" | cut -c1-300 | head -5
done
kill $srv
exit $status
