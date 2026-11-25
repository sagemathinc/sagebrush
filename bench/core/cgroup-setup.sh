#!/usr/bin/env bash
# The memory caps' cgroup (README, "Memory caps"), then a command inside it:
#   bash bench/core/cgroup-setup.sh python3 bench/core/run.py ...
# It makes the cgroup v2 directory /sys/fs/cgroup/bench-core, delegated to
# this user with the memory and cpuset controllers enabled for its children,
# moves this shell into its leaf "runner", and runs the command there,
# unprivileged.  run.py then puts each subprocess in a sibling of "runner"
# with its own memory.max (and, in the thread sweep, cpuset.cpus).  Needs sudo once per boot, on a cgroup v2 host (Ubuntu 22.04
# and later).  The privileged steps take no path from the environment: the
# root is fixed here (another root is a manual setup, README).
set -euo pipefail
ROOT=/sys/fs/cgroup/bench-core
fail() { echo "cgroup-setup: $*" >&2; exit 1; }
# (a path the privileged steps may touch: a real directory on cgroup2fs,
# never a symlink)
cgroupdir() { [ ! -L "$1" ] && [ -d "$1" ] && [ "$(stat -f -c %T -- "$1")" = cgroup2fs ]; }
cgroupdir /sys/fs/cgroup || fail "no cgroup v2 at /sys/fs/cgroup"
# (memory for the caps, cpuset for the thread sweep's pinning)
grep -qw memory /sys/fs/cgroup/cgroup.subtree_control || echo +memory | sudo tee -- /sys/fs/cgroup/cgroup.subtree_control >/dev/null
grep -qw cpuset /sys/fs/cgroup/cgroup.subtree_control || echo +cpuset | sudo tee -- /sys/fs/cgroup/cgroup.subtree_control >/dev/null
[ -L "$ROOT" ] && fail "$ROOT is a symlink"
sudo mkdir -p -- "$ROOT"
cgroupdir "$ROOT" || fail "$ROOT is not a cgroup v2 directory"
sudo chown -- "$(id -u):$(id -g)" "$ROOT" "$ROOT/cgroup.procs" "$ROOT/cgroup.subtree_control"
# (the controller is enabled while the directory holds no process)
grep -qw memory "$ROOT/cgroup.subtree_control" || echo +memory >"$ROOT/cgroup.subtree_control"
grep -qw cpuset "$ROOT/cgroup.subtree_control" || echo +cpuset >"$ROOT/cgroup.subtree_control"
mkdir -p -- "$ROOT/runner"
cgroupdir "$ROOT/runner" || fail "$ROOT/runner is not a cgroup v2 directory"
# (moving this shell needs write access to the common ancestor's procs file:
# from wherever it is now, that is the root, hence sudo; later moves of its
# children, from runner to a sibling, only need $ROOT's)
echo $$ | sudo tee -- "$ROOT/runner/cgroup.procs" >/dev/null
[ $# -gt 0 ] && exec "$@"
