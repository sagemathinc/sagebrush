#!/bin/bash
# PNG plan r8 §6: the raster child is spawned without duplicating a large
# parent's commit, under strict overcommit (vm.overcommit_memory=2).  Run on
# a test VM only, alone (it changes a system-wide setting for its window),
# with the Python package installed in PY:
#   scripts/vm-png-overcommit.sh PY
# The original setting is recorded first and restored on exit, also on a
# failure; before and after are printed.
set -u
PY=${1:?usage: vm-png-overcommit.sh PYTHON}
orig=$(sysctl -n vm.overcommit_memory)
echo "before: vm.overcommit_memory=$orig ($(date -u +%H:%M:%SZ))"
restore() {
  sudo sysctl -q -w vm.overcommit_memory="$orig"
  echo "restored: vm.overcommit_memory=$(sysctl -n vm.overcommit_memory) ($(date -u +%H:%M:%SZ))"
}
trap restore EXIT
sudo sysctl -q -w vm.overcommit_memory=2
echo "during: vm.overcommit_memory=$(sysctl -n vm.overcommit_memory)"
"$PY" - <<'EOF'
import ctypes, os, sys
import sagebrush
from sagebrush.sage import *
import _sbraster

def meminfo(k):
    for line in open("/proc/meminfo"):
        if line.startswith(k + ":"):
            return int(line.split()[1]) * 1024

limit, used = meminfo("CommitLimit"), meminfo("Committed_AS")
n = int(0.6 * (limit - used))
# a private writable mapping of n bytes, never touched: under strict
# overcommit it is all committed at once, as a large session's heap would be
libc = ctypes.CDLL(None, use_errno=True)
libc.mmap.restype = ctypes.c_void_p
libc.mmap.argtypes = [ctypes.c_void_p, ctypes.c_size_t, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_long]
p = libc.mmap(None, n, 3, 0x22, -1, 0)  # PROT_READ|PROT_WRITE, MAP_PRIVATE|MAP_ANONYMOUS
assert p not in (None, ctypes.c_void_p(-1).value), "mmap: %d" % ctypes.get_errno()
print("CommitLimit %d, Committed_AS %d before, %d after mapping %d" % (limit, used, meminfo("Committed_AS"), n))
# the control: fork() must duplicate that commit, which doesn't fit
try:
    pid = os.fork()
    if pid == 0:
        os._exit(0)
    os.waitpid(pid, 0)
    print("fork: succeeded (the control has no teeth)")
    sys.exit(1)
except OSError as e:
    print("fork: refused (%s), as strict overcommit must" % e.strerror)
svg = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="30"><rect width="9" height="9"/></svg>'
png, _ = _sbraster.render(svg, 1.0, 40, 30, None, 72.0, [])
print("the raster child: started and drawn, enforced=%s, %s" % (_sbraster._child.enforced, png[:4] == b"\x89PNG"))
EOF
