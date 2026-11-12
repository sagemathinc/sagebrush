#!/usr/bin/env bash
# On GitHub's hosted Ubuntu runners apt reads its mirrors from
# /etc/apt/apt-mirrors.txt, Azure's mirror first. On Nov 11 neither that
# mirror nor Ubuntu's own archive answered the runners for hours, so CI drops
# Azure's mirror and puts kernel.org's Ubuntu mirror first, with the rest of
# the list behind it. apt still checks every index against Ubuntu's signing keys.
# Where that file doesn't exist (a self-hosted runner, another image), this does nothing.
set -euo pipefail
f=/etc/apt/apt-mirrors.txt
if [ ! -f "$f" ]; then
  echo "no $f: apt mirrors left as they are"
  exit 0
fi
# kernel.org's mirror can be down too (Nov 12). Put it first only if it answers
# now; otherwise leave the runner's list as it is, so apt doesn't spend each
# step waiting on a mirror that is gone.
codename=$(. /etc/os-release && echo "$VERSION_CODENAME")
if ! curl -fsS --connect-timeout 5 --max-time 10 -o /dev/null \
    http://mirrors.edge.kernel.org/ubuntu/dists/$codename/InRelease; then
  echo "kernel.org's Ubuntu mirror doesn't answer: apt mirrors left as they are"
  cat "$f"
  exit 0
fi
rest=$(grep -v -e 'azure\.archive\.ubuntu\.com' -e 'mirrors\.edge\.kernel\.org' "$f" || true)
printf 'http://mirrors.edge.kernel.org/ubuntu/\tpriority:1\n%s\n' "$rest" | sudo tee "$f" > /dev/null
echo "apt mirrors:"
cat "$f"
