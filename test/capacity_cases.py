# The memory collector (lib/_capacity.py, item D0) on made-up systems: run
# by test/capacity.test.ts both by python3 and by Sagebrush, which must print
# the same.  sys.argv[1]: an empty directory for the made-up /proc and /sys.
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "lib"))
import _capacity as C

BASE = sys.argv[1]
MiB, GiB = 1 << 20, 1 << 30
# (pyjs has its runtime parts and its own heap figure: here neither, so
# both hosts see only the made-up system)
NO_RUNTIME = lambda: []
had_limit = getattr(sys, "_sagebrush_heap_limit", None)
if had_limit is not None:
    del sys._sagebrush_heap_limit


def tree(name, files):
    root = os.path.join(BASE, name)
    for path, text in files.items():
        p = root + path
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "w") as f:
            f.write(text)
    return root


def meminfo(total, avail):
    return "MemTotal:       %d kB\nMemFree:        1 kB\nMemAvailable:   %d kB\n" % (total // 1024, avail // 1024)


def status(vmsize, vmdata):
    return "Name:\tx\nVmSize:\t%d kB\nVmData:\t%d kB\n" % (vmsize // 1024, vmdata // 1024)


def show(label, rec):
    basis = ", ".join("%s %s/%s rem %s" % (b["source"], b["limit"], b["used"], b["remaining"]) for b in rec["basis"])
    print(label, "| bytes", rec["bytes"], "| reserve", rec["reserve_bytes"], "| effective", C.effective_guard_bytes(rec), "|", basis, "| unknown", rec["unknown_parts"])


NOLIM = {"RLIMIT_AS": (-1, -1), "RLIMIT_DATA": (-1, -1)}

# 1. a cgroup (v2, with a parent set to max) tighter than the memory available
r = tree("v2", {
    "/proc/self/cgroup": "0::/user.slice/job\n",
    "/sys/fs/cgroup/user.slice/job/memory.max": "%d\n" % GiB,
    "/sys/fs/cgroup/user.slice/job/memory.current": "%d\n" % (300 * MiB),
    "/sys/fs/cgroup/user.slice/memory.max": "max\n",
    "/sys/fs/cgroup/memory.max": "max\n",
    "/proc/meminfo": meminfo(16 * GiB, 8 * GiB),
    "/proc/self/status": status(2 * GiB, GiB),
})
C._set_sources(root=r, platform="linux", rlimits=NOLIM, runtime=NO_RUNTIME)
show("cgroup", C.capacity())
print("total", C.heap_figure(), C._machine_total())

# 2. RLIMIT_AS tighter than the cgroup; RLIMIT_DATA too, against VmData
C._set_sources(root=r, platform="linux", rlimits={"RLIMIT_AS": (3 * GiB, -1), "RLIMIT_DATA": (1200 * MiB, -1)}, runtime=NO_RUNTIME)
show("rlimit", C.capacity())
print("total", C.heap_figure())

# 3. little memory available, no cgroup limit (v2 max everywhere)
r3 = tree("low", {
    "/proc/self/cgroup": "0::/\n",
    "/sys/fs/cgroup/memory.max": "max\n",
    "/proc/meminfo": meminfo(4 * GiB, 200 * MiB),
})
C._set_sources(root=r3, platform="linux", rlimits=NOLIM, runtime=NO_RUNTIME)
show("low", C.capacity())

# 4. cgroup v1 with an absurd limit (no ceiling), and with a real one
r4 = tree("v1", {
    "/proc/self/cgroup": "12:memory:/docker/abc\n11:cpu:/x\n",
    "/sys/fs/cgroup/memory/docker/abc/memory.limit_in_bytes": "%d\n" % (2 ** 63 - 4096),
    "/sys/fs/cgroup/memory/docker/abc/memory.usage_in_bytes": "%d\n" % GiB,
    "/proc/meminfo": meminfo(8 * GiB, 6 * GiB),
})
C._set_sources(root=r4, platform="linux", rlimits=NOLIM, runtime=NO_RUNTIME)
show("v1 absurd", C.capacity())
with open(r4 + "/sys/fs/cgroup/memory/docker/abc/memory.limit_in_bytes", "w") as f:
    f.write("%d\n" % (2 * GiB))
show("v1", C.capacity())

# 5. shrinking between two calls: the cgroup's use, then RLIMIT_AS
C._set_sources(root=r, platform="linux", rlimits=NOLIM, runtime=NO_RUNTIME)
a = C.capacity()["bytes"]
with open(r + "/sys/fs/cgroup/user.slice/job/memory.current", "w") as f:
    f.write("%d\n" % (900 * MiB))
print("shrinks", a, C.capacity()["bytes"])
lim = {"RLIMIT_AS": (5 * GiB, -1), "RLIMIT_DATA": (-1, -1)}
C._set_sources(root=r3, platform="linux", rlimits=lim, runtime=NO_RUNTIME)
with open(r3 + "/proc/self/status", "w") as f:
    f.write(status(4 * GiB + 900 * MiB, GiB))
a = C.capacity()["bytes"]
lim["RLIMIT_AS"] = (4 * GiB + 950 * MiB, -1)
print("rlimit shrinks", a, C.capacity()["bytes"])

# 6. the reserve: its base, rounding up, underflow
for n in (None, 0, 10 * 1000, 10 * 1000 + 1, 256 * MiB, 300 * MiB):
    rec = {"bytes": n, "reserve_bytes": C.reserve_bytes(n)}
    print("reserve", n, rec["reserve_bytes"], C.effective_guard_bytes(rec))

# 7. the poly share: floor(effective / 2), the 250 ms snapshot
with open(r + "/sys/fs/cgroup/user.slice/job/memory.current", "w") as f:
    f.write("%d\n" % (100 * MiB))
t = [0.0]
C._set_sources(root=r, platform="linux", rlimits=NOLIM, runtime=lambda: [("wasm engine", 4 * GiB, 4 * GiB - 701 * MiB - 7)], clock=lambda: t[0])
e = C.effective_guard_bytes(C.capacity())
print("poly", e, C.poly_share(), e // 2)
r6 = tree("low2", {"/proc/self/cgroup": "0::/\n", "/proc/meminfo": meminfo(4 * GiB, 300 * MiB)})
C._src.root = r6
t[0] = 0.2499
print("poly snapshot", C.poly_share())
t[0] = 0.25
print("poly after", C.poly_share(), C.effective_guard_bytes(C.capacity()) // 2)
C._set_sources(root=os.path.join(BASE, "none"), platform="linux", rlimits={}, runtime=NO_RUNTIME)
print("poly none", C.poly_share())
# the share's arithmetic at its exact boundaries, against the formula
# written out here: the largest n the reserve exhausts, and the next; the
# first n where half the effective figure reaches a quarter of n, and the
# one before; small n; a 256 MiB session
res = lambda n: 256 * MiB + (n + 9) // 10
lo, hi = 0, 1 << 32
while lo < hi:
    m = (lo + hi + 1) // 2
    if m <= res(m):
        lo = m
    else:
        hi = m - 1
exhausted = lo
lo, hi = exhausted, 1 << 34
while lo < hi:
    m = (lo + hi) // 2
    if (m - res(m)) // 2 >= m // 4:
        hi = m
    else:
        lo = m + 1
cross = lo
for n in (0, 1, 2, 3, 4, 5, exhausted, exhausted + 1, cross - 1, cross, 256 * MiB, 4 * GiB):
    sh = C.share_of(n)
    assert n // 4 <= sh <= n // 2, n
    print("share_of", n, sh, max(0, n - res(n)) // 2, n // 4, C.reserve_bytes(n) == res(n))
print("share_of None", C.share_of(None))
# a small session: a quarter of what is free, where the reserve leaves less;
# the reserve alone leaves nothing under about 284 MiB free; the two
# figures meet near 640 MiB
for free in (100 * MiB, 284 * MiB, 285 * MiB, 300 * MiB, 639 * MiB, 641 * MiB, 2 * GiB):
    C._set_sources(root=os.path.join(BASE, "none"), platform="linux", rlimits={}, runtime=lambda free=free: [("wasm engine", free, 0)])
    rec = C.capacity()
    print("poly small", free, C.poly_share(), C.effective_guard_bytes(rec) // 2, free // 4)
C._set_sources(root=os.path.join(BASE, "none"), platform="linux", rlimits={}, runtime=NO_RUNTIME)

# 8. nothing readable: unknown parts, the nominal total
show("nothing", C.capacity())
print("total", C.heap_figure(), C._machine_total())

# 9. the runtime's parts (pyjs's), with a usage unknown
C._set_sources(root=r3, platform="linux", rlimits=NOLIM, runtime=lambda: [("wasm engine", 4 * GiB, 100 * MiB), ("js heap", 2 * GiB, None)])
show("runtime", C.capacity())
# the poly share leaves the JS heap out: the engine's memory is its own
C._set_sources(root=r, platform="linux", rlimits=NOLIM, runtime=lambda: [("wasm engine", 4 * GiB, 0), ("js heap", 2 * GiB, 2 * GiB - 10 * MiB)])
print("poly without the js heap", C.capacity()["bytes"], C.poly_share(), C.effective_guard_bytes({"bytes": 1073741824 - 100 * MiB, "reserve_bytes": C.reserve_bytes(1073741824 - 100 * MiB)}) // 2)

# 10. Windows
class Win:
    def __init__(self, job=None, fail=None):
        self.job, self.fail = job, fail
    def physical(self):
        if self.fail == "physical":
            raise OSError("GlobalMemoryStatusEx")
        return 16 * GiB, 10 * GiB
    def in_job(self):
        if self.fail == "in_job":
            raise OSError("IsProcessInJob")
        return self.job is not None
    def job_limit(self):
        if self.fail == "job_limit":
            raise OSError("QueryInformationJobObject")
        return self.job

for label, w in (("no job", Win()), ("job", Win(job=(2 * GiB, 512 * MiB))), ("job without memory limit", Win(job=(None, None))),
                 ("fail physical", Win(fail="physical")), ("fail in_job", Win(fail="in_job")), ("fail job_limit", Win(job=(GiB, 0), fail="job_limit"))):
    # (a runtime part is there too: a failed Windows source must leave the
    # figure unknown, not finite from the others)
    C._set_sources(platform="win32", windows=w, runtime=lambda: [("wasm engine", 4 * GiB, 0)])
    show("windows " + label, C.capacity())
    print("windows total", label, C.heap_figure())

# 11. the total's 100 ms snapshot, and pyjs's own figure untouched
t = [5.0]
C._set_sources(root=r, platform="linux", rlimits=NOLIM, runtime=NO_RUNTIME, clock=lambda: t[0])
a = C.heap_figure()
with open(r + "/sys/fs/cgroup/user.slice/job/memory.max", "w") as f:
    f.write("%d\n" % (512 * MiB))
t[0] = 5.0999
b = C.heap_figure()
t[0] = 5.25
print("total snapshot", a, b, C.heap_figure())
sys._sagebrush_heap_limit = 96 * MiB
print("pyjs figure", C.heap_figure())
del sys._sagebrush_heap_limit

def check(label, got, want):
    print("ok" if got == want else "WRONG", label, got if got == want else "got %r want %r" % (got, want))


# 12. a zero resource limit is a limit: the total is 0, not the next one
# (CORR-PR122-1); an unreadable one (False) and none (None) are left out
r12 = tree("zero", {"/proc/meminfo": meminfo(16 * GiB, 12 * GiB), "/proc/self/status": status(0, 0)})
for name in ("RLIMIT_AS", "RLIMIT_DATA"):
    lim = dict(NOLIM)
    lim[name] = (0, -1)
    C._set_sources(root=r12, platform="linux", rlimits=lim, runtime=NO_RUNTIME)
    check("zero " + name, (C.capacity()["bytes"], C._machine_total(), C.heap_figure()), (0, (0, [name]), 0))
    lim[name] = (1, -1)
    C._set_sources(root=r12, platform="linux", rlimits=lim, runtime=NO_RUNTIME)
    check("one byte " + name, C._machine_total(), (1, [name]))
C._set_sources(root=r12, platform="linux", rlimits={}, runtime=NO_RUNTIME)
check("unreadable limits", C._machine_total(), (16 * GiB, ["MemTotal"]))
C._set_sources(root=r12, platform="linux", rlimits=NOLIM, runtime=NO_RUNTIME)
check("no limits", C._machine_total(), (16 * GiB, ["MemTotal"]))

# 13. cgroup v1: every ancestor's limit counts, with its own usage, the
# leaf's unlimited or larger (CORR-PR122-2)
U = 2 ** 63 - 4096


def v1(name, groups):
    files = {"/proc/self/cgroup": "12:memory:/a/b/c\n", "/proc/meminfo": meminfo(16 * GiB, 12 * GiB)}
    for path, (lim, used) in groups.items():
        d = "/sys/fs/cgroup/memory" + path
        files[d + "/memory.limit_in_bytes"] = "%d\n" % lim
        files[d + "/memory.usage_in_bytes"] = "%d\n" % used
    C._set_sources(root=tree(name, files), platform="linux", rlimits=NOLIM, runtime=NO_RUNTIME)
    return C.capacity()["bytes"], C._machine_total()[0]


check("v1 unlimited leaf, finite root", v1("v1a", {"/a/b/c": (U, 10 * MiB), "/a/b": (U, 50 * MiB), "/a": (U, 60 * MiB), "": (GiB, 100 * MiB)}), (924 * MiB, GiB))
check("v1 unlimited leaf, finite parent", v1("v1b", {"/a/b/c": (U, 10 * MiB), "/a/b": (GiB, 100 * MiB), "": (U, 900 * MiB)}), (924 * MiB, GiB))
check("v1 larger leaf, tighter grandparent", v1("v1c", {"/a/b/c": (4 * GiB, 10 * MiB), "/a/b": (U, 0), "/a": (2 * GiB, 1900 * MiB)}), (148 * MiB, 2 * GiB))
check("v1 tighter leaf", v1("v1d", {"/a/b/c": (512 * MiB, 12 * MiB), "/a": (2 * GiB, 1500 * MiB)}), (500 * MiB, 512 * MiB))
check("v1 all unlimited", v1("v1e", {"/a/b/c": (U, 0), "": (U, 0)}), (12 * GiB, 16 * GiB))

# 14. the poly share's age: 0 when sampled now, its snapshot's age when
# reused, so the host's own reuse ends with the observation (CORR-PR122-3)
t = [10.0]
C._set_sources(root=os.path.join(BASE, "none"), platform="linux", rlimits={}, runtime=lambda: [("made-up", GiB, 0)], clock=lambda: t[0])
C._poly_age = None
a = C.poly_share()
check("age fresh", C._poly_age, 0.0)
t[0] = 10.249
check("age reused", (C.poly_share(), round(C._poly_age, 6)), (a, 0.249))
t[0] = 10.25
C.poly_share()
check("age resampled", C._poly_age, 0.0)

C._set_sources()
if had_limit is not None:
    sys._sagebrush_heap_limit = had_limit
