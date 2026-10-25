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

# 15. the domains each row counts and bounds, and the set derived from the
# rows with a finite remainder (plan-d0-domains-r2): observed by one, and
# contradicted by none (a row bounding a domain it doesn't count)
ALL, SELF = list(C.DOMAINS), [d for d in C.DOMAINS if d != "child"]
NONE_ROOT = os.path.join(BASE, "none")


def rows(rec):
    return [(b["source"], b["includes"], b["constrains"]) + ((b["scope"],) if "scope" in b else ()) for b in rec["basis"]]


def runtime_only(parts):
    C._set_sources(root=NONE_ROOT, platform="linux", rlimits={}, runtime=lambda: parts)
    return C.capacity()


check("vocabulary", C.DOMAINS, ("child", "cpython-heap", "js-arraybuffer", "js-heap", "wasm-engine", "wasm-instance"))
# (1) board's case: one row counts and bounds js-arraybuffer, another bounds
# it without counting it: out, though the first includes it
rec = runtime_only([("sees", GiB, 0, ["js-arraybuffer", "js-heap"], ["js-arraybuffer", "js-heap"]), ("blind", GiB, 0, [], ["js-arraybuffer"])])
check("contradicted", rec["domains"], ["js-heap"])
check("contradicted rows", rows(rec), [("sees", ["js-arraybuffer", "js-heap"], ["js-arraybuffer", "js-heap"]), ("blind", [], ["js-arraybuffer"])])
# (4) a contradicting row whose usage isn't known takes no part
rec = runtime_only([("sees", GiB, 0, ["js-arraybuffer"], ["js-arraybuffer"]), ("blind", GiB, None, [], ["js-arraybuffer"])])
check("unknown row takes no part", (rec["domains"], rows(rec)[1]), (["js-arraybuffer"], ("blind", [], ["js-arraybuffer"])))
# (5) a browser: the engine's row, and a JS heap whose use can't be read
rec = runtime_only([("wasm engine", 4 * GiB, 0, ("wasm-engine",), ("wasm-engine",)), ("js heap", 2 * GiB, None, ("js-heap",), ("js-heap",))])
check("browser", rec["domains"], ["wasm-engine"])
check("browser rows", rows(rec), [("wasm engine", ["wasm-engine"], ["wasm-engine"]), ("js heap", [], ["js-heap"])])
# (6) a part without domains (an older engine) adds nothing; (7) no bytes, no domains
rec = runtime_only([("old", GiB, 0)])
check("three-tuple", (rec["bytes"], rec["domains"], rows(rec)), (GiB, [], [("old", [], [])]))
C._set_sources(root=NONE_ROOT, platform="linux", rlimits={}, runtime=NO_RUNTIME)
check("nothing readable", (C.capacity()["bytes"], C.capacity()["domains"]), (None, []))
# (2) a cgroup counts the child, and RLIMIT_AS doesn't bound it: all six
C._set_sources(root=r, platform="linux", rlimits={"RLIMIT_AS": (3 * GiB, -1), "RLIMIT_DATA": (-1, -1)}, runtime=NO_RUNTIME)
rec = C.capacity()
check("cgroup and RLIMIT_AS", rec["domains"], ALL)
check("cgroup and RLIMIT_AS rows", rows(rec), [("cgroup /user.slice/job", ALL, ALL), ("RLIMIT_AS", SELF, SELF), ("MemAvailable", ALL, ALL)])
# (3) only the resource limits readable: nothing observes the child
r15 = tree("rlimits-only", {"/proc/self/status": status(GiB, 512 * MiB)})
C._set_sources(root=r15, platform="linux", rlimits={"RLIMIT_AS": (4 * GiB, -1), "RLIMIT_DATA": (2 * GiB, -1)}, runtime=NO_RUNTIME)
rec = C.capacity()
check("rlimits only", (rec["domains"], rows(rec)), (SELF, [("RLIMIT_AS", SELF, SELF), ("RLIMIT_DATA", SELF, SELF)]))
# (8) poly's record, the JS heap left out: its own set, without js-heap
C._set_sources(root=NONE_ROOT, platform="linux", rlimits={}, runtime=lambda: [("wasm engine", 4 * GiB, 0, ["wasm-engine"], ["wasm-engine"]), ("js heap", 2 * GiB, 0, ["js-heap"], ["js-heap"])])
rec = C.capacity()
f = C._record([b for b in rec["basis"] if b["source"] != "js heap"], [])
check("poly's record", (rec["domains"], f["domains"]), (["js-heap", "wasm-engine"], ["wasm-engine"]))

# 16. Windows: the job row's scope, kept from the limit that was chosen
# (DOMAINS-R1-1, CORR-DOMAINS-R1-1); the selector itself, ties included
P, J = 0x100, 0x200
check("choice process only", C._job_choice(P, 2 * GiB, 512 * MiB, 0, 0), (2 * GiB, 512 * MiB, "process"))
check("choice job only", C._job_choice(J, 0, None, 3 * GiB, GiB), (3 * GiB, GiB, "job"))
check("choice both, process smaller", C._job_choice(P | J, 2 * GiB, 1800 * MiB, 3 * GiB, GiB), (2 * GiB, 1800 * MiB, "process"))
check("choice both, job smaller", C._job_choice(P | J, 2 * GiB, 512 * MiB, 3 * GiB, 2800 * MiB), (3 * GiB, 2800 * MiB, "job"))
check("choice both, a tie", C._job_choice(P | J, 2 * GiB, GiB, 3 * GiB, 2 * GiB), (2 * GiB, GiB, "process"))
check("choice neither", C._job_choice(0, 2 * GiB, 0, 3 * GiB, 0), (None, None, None))


class Win2(Win):
    """A job whose limit is chosen by the real selector."""
    def __init__(self, *query):
        Win.__init__(self, job=True)
        self.query = query
    def job_limit(self):
        return C._job_choice(*self.query)


def win(w):
    C._set_sources(platform="win32", windows=w, runtime=NO_RUNTIME)
    rec = C.capacity()
    job = [b for b in rec["basis"] if b["source"] == "windows job"]
    return rec, C._record(job, [])


for label, w, scope, inc, alone in (
        ("process only", Win2(P, 2 * GiB, 512 * MiB, 0, 0), "process", SELF, SELF),
        ("job only", Win2(J, 0, None, 3 * GiB, GiB), "job", ALL, ALL),
        ("both, process smaller", Win2(P | J, 2 * GiB, 1800 * MiB, 3 * GiB, GiB), "process", SELF, SELF),
        ("both, job smaller", Win2(P | J, 2 * GiB, 512 * MiB, 3 * GiB, 2800 * MiB), "job", ALL, ALL)):
    rec, job = win(w)
    check("windows " + label + " row", rows(rec), [("physical available", ALL, ALL), ("windows job", inc, inc, scope)])
    # (the job row alone; with physical, which observes the child itself,
    # every domain, the process row bounding no child)
    check("windows " + label + " alone", job["domains"], alone)
    check("windows " + label + " with physical", rec["domains"], ALL)
# (an older source, no scope: unknown, bounding the child without counting it)
rec, job = win(Win(job=(2 * GiB, 512 * MiB)))
check("windows no scope row", rows(rec)[1], ("windows job", SELF, ALL, None))
check("windows no scope", (rec["domains"], job["domains"]), (SELF, SELF))
check("windows totals unchanged", [(lambda w: (C._set_sources(platform="win32", windows=w, runtime=NO_RUNTIME), C._machine_total())[1])(w)
                                    for w in (Win(), Win(job=(2 * GiB, 512 * MiB)), Win2(P | J, 2 * GiB, 512 * MiB, 3 * GiB, 2800 * MiB))],
      [(16 * GiB, ["physical"]), (2 * GiB, ["windows job"]), (3 * GiB, ["windows job"])])

C._set_sources()
if had_limit is not None:
    sys._sagebrush_heap_limit = had_limit
