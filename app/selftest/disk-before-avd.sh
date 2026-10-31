#!/usr/bin/env bash
# Disk for the emulator, before reactivecircus/android-emulator-runner creates
# its AVD (.github/workflows/app-mobile-selftest.yml, both emulator jobs).  The
# AVD's userdata goes under $HOME/.android/avd and needs 7372.80 MB for this
# image ("need 7372.80 MB": #384 run 41124748735 and #380 run 41154237915,
# both on runner image ubuntu-24.04 20261018.96.1, which had 4292.76 MB).
# So: print the disk, remove preinstalled toolchains these jobs never use
# (each only if present; never the Android SDK, the JDK, Rust or Node), print
# it again, and fail with its own message unless $HOME's file system has
# NEED_MB free (the emulator's own failure comes later and is less clear).
#   bash app/selftest/disk-before-avd.sh [NEED_MB]   (default 8192: the 7372.80 MB plus room for the emulator's own files)
set -euo pipefail
NEED_MB=${1:-8192}
[[ "$NEED_MB" =~ ^[0-9]+$ ]] || { echo "FAIL: NEED_MB '$NEED_MB' is not a number"; exit 2; }
UNUSED=(/usr/share/dotnet /opt/ghc /usr/local/.ghcup /usr/local/share/boost "${AGENT_TOOLSDIRECTORY:-/opt/hostedtoolcache}/CodeQL")
avail_mb() {  # free MB on the file system holding $1 (df -P: one line, column 4 in KiB)
  df -Pk "$1" | awk 'NR == 2 && $4 ~ /^[0-9]+$/ { print int($4 / 1024); found = 1 } END { if (!found) exit 1 }'
}
echo "disk before the AVD (runner image ${ImageVersion:-unknown}):"
df -h "$HOME" / || true
for d in "${UNUSED[@]}"; do
  if [ -d "$d" ]; then
    echo "removing $d (unused by this job)"
    sudo rm -rf -- "$d"
  fi
done
echo "after removing the unused toolchains:"
df -h "$HOME" / || true
have=$(avail_mb "$HOME") || { echo "FAIL: can't read the free space of $HOME from df"; exit 1; }
if [ "$have" -lt "$NEED_MB" ]; then
  echo "FAIL: $have MB free for $HOME/.android/avd, need $NEED_MB (the AVD's userdata alone is 7372.80 MB)"
  exit 1
fi
echo "ok: $have MB free for the AVD (need $NEED_MB)"
