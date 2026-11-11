#!/usr/bin/env bash
# On GitHub's hosted Ubuntu runners apt reads its mirrors from
# /etc/apt/apt-mirrors.txt, Azure's mirror first. When that mirror stops
# answering, every apt-get update stalls on it (Nov 11, for hours),
# so CI drops it and uses Ubuntu's own archive. Where that file doesn't
# exist (a self-hosted runner, another image), this does nothing.
set -euo pipefail
f=/etc/apt/apt-mirrors.txt
if [ ! -f "$f" ]; then
  echo "no $f: apt mirrors left as they are"
  exit 0
fi
sudo sed -i '/azure\.archive\.ubuntu\.com/d' "$f"
if ! grep -q '[^[:space:]]' "$f"; then
  echo 'http://archive.ubuntu.com/ubuntu/' | sudo tee "$f" > /dev/null
fi
echo "apt mirrors:"
cat "$f"
