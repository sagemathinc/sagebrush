#!/usr/bin/env bash
# disk-before-avd.sh with a stub df and sudo (PATH first): enough space passes,
# too little, an unreadable df and a bad NEED_MB fail, and nothing outside the
# script's list is removed (the stub sudo only records what it was asked).
#   bash app/selftest/test-disk-before-avd.sh
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
mkdir "$T/bin"
cat > "$T/bin/df" <<'EOF'
#!/usr/bin/env bash
case "$*" in
  -Pk*) [ "$DF_MODE" = garbage ] && { echo "nonsense"; exit 0; }
        echo "Filesystem 1024-blocks Used Available Capacity Mounted on"
        echo "/dev/root 76026616 60000000 $DF_KB 80% /" ;;
  *) echo "(df -h stub)" ;;
esac
EOF
printf '#!/usr/bin/env bash\necho "$*" >> "%s/sudo.log"\n' "$T" > "$T/bin/sudo"
chmod +x "$T/bin/df" "$T/bin/sudo"
bad=0
run() {  # want, label, DF_MODE, DF_KB, [NEED_MB]
  local want=$1 label=$2 rc=0; : > "$T/sudo.log"
  PATH="$T/bin:$PATH" DF_MODE=$3 DF_KB=$4 AGENT_TOOLSDIRECTORY="$T/none" bash "$HERE/${SCRIPT:-disk-before-avd.sh}" ${5:+"$5"} > "$T/out" 2>&1 || rc=$?
  if [ "$rc" = "$want" ]; then echo "ok   $label -> $rc"; else echo "FAIL $label -> $rc, expected $want:"; cat "$T/out"; bad=1; fi
}
run 0 "10 GiB free, need 8192 MB" ok 10485760
run 1 "the #380 runner: 4292 MB free" ok 4395786
run 1 "1 MB short" ok 8387584
run 0 "exactly the need" ok 8388608
run 1 "df unreadable" garbage 0
run 2 "NEED_MB not a number" ok 10485760 9x
run 0 "a smaller NEED_MB" ok 4395786 4096
# exactly the listed directories that exist reach sudo, each once: a CodeQL
# directory made here (so the log is never empty), plus whichever of the fixed
# system paths this machine has (none in the project; some on a runner)
mkdir -p "$T/tools/CodeQL"
: > "$T/sudo.log"
PATH="$T/bin:$PATH" DF_MODE=ok DF_KB=10485760 AGENT_TOOLSDIRECTORY="$T/tools" bash "$HERE/${SCRIPT:-disk-before-avd.sh}" > "$T/out" 2>&1 || { echo "FAIL: the removal run failed:"; cat "$T/out"; bad=1; }
for d in /usr/share/dotnet /opt/ghc /usr/local/.ghcup /usr/local/share/boost "$T/tools/CodeQL"; do [ -d "$d" ] && echo "rm -rf -- $d"; done > "$T/want.log"
if [ -s "$T/sudo.log" ] && cmp -s "$T/want.log" "$T/sudo.log"; then
  echo "ok   sudo was asked for exactly the present listed directories ($(wc -l < "$T/sudo.log") line(s), CodeQL included)"
else
  echo "FAIL: sudo's requests differ from the present listed directories:"; diff "$T/want.log" "$T/sudo.log" || true; bad=1
fi
grep -q '^removal took [0-9]* s$' "$T/out" || { echo "FAIL: no elapsed time for the removal"; bad=1; }
[ "$bad" = 0 ] || { echo "FAIL: disk-before-avd.sh"; exit 1; }
echo "ok: disk-before-avd.sh gives every case its expected result"
