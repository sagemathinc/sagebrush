#!/bin/bash
# The image's smoke test: start it, connect, run a cell; restart it, connect again with the same key, run again.
# The relay and the page are the repository's fakes (smoke_harness.py), run from the same image; nothing leaves this
# machine.  Run from the repository's root, with the image built:
#   docker/remote/smoke.sh [IMAGE]          (default sagebrush-remote:dev)
set -euo pipefail
IMAGE=${1:-sagebrush-remote:dev}
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
PORT=${SMOKE_PORT:-18987}
id=$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')
VOL=sagebrush-remote-smoke-$id RUNNER=sagebrush-remote-smoke-runner-$id HARNESS=sagebrush-remote-smoke-harness-$id
OUT=$(mktemp -d "${TMPDIR:-/tmp}/sagebrush-remote-smoke.XXXXXX")
chmod 0777 "$OUT" # (the harness runs as the image's user)
cleanup() {
  docker rm -f "$RUNNER" "$HARNESS" >/dev/null 2>&1 || true
  docker volume rm "$VOL" >/dev/null 2>&1 || true
  rm -rf "$OUT"
}
trap cleanup EXIT
wait_for() { # wait_for FILE SECONDS
  for _ in $(seq 1 "$2"); do [ -e "$1" ] && return 0; docker inspect -f '{{.State.Running}}' "$HARNESS" 2>/dev/null | grep -q true || break; sleep 1; done
  [ -e "$1" ] || { echo "smoke: FAIL waiting for $(basename "$1")"; docker logs "$HARNESS" 2>&1 | tail -20; docker logs "$RUNNER" 2>&1 | tail -20; exit 1; }
}
docker run -d --name "$HARNESS" --network host -v "$ROOT/engine/py:/t:ro" -v "$ROOT/docker/remote:/s:ro" -v "$OUT:/out" \
  --entrypoint /opt/sagebrush/tools/sagebrush/bin/python "$IMAGE" /s/smoke_harness.py /out "$PORT" >/dev/null
wait_for "$OUT/key.json" 60
# (the key into the volume, as enrollment would have left it: ~/.config/sagebrush/remote/key.json, 0600)
docker volume create "$VOL" >/dev/null
docker run --rm -i -v "$VOL:/home/sb" --entrypoint sh "$IMAGE" -c \
  'umask 077 && mkdir -p ~/.config/sagebrush/remote && cat > ~/.config/sagebrush/remote/key.json' < "$OUT/key.json"
docker run -d --name "$RUNNER" --network host -v "$VOL:/home/sb" "$IMAGE" >/dev/null
wait_for "$OUT/phase1.ok" 180
echo "smoke: phase 1 ok: connected, paired, ran print(6 * 7) -> $(cat "$OUT/phase1.ok")"
docker restart "$RUNNER" >/dev/null
wait_for "$OUT/phase2.ok" 180
echo "smoke: phase 2 ok: restarted, connected again with the key in the volume, ran it again"
docker logs "$HARNESS" 2>&1 | sed 's/^/  harness: /'
docker logs "$RUNNER" 2>&1 | sed 's/^/  runner: /' | tail -8
echo "smoke: PASS"
