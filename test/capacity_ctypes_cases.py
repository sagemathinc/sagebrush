# The collector's ctypes sources (lib/_capacity.py: _CtypesMac, _CtypesWindows) against fake system
# libraries: CPython only (pyjs has no ctypes), run by test/capacity.test.ts.  Real ctypes types and
# structures, fake libSystem and kernel32/psapi functions that write their answers through the pointers
# they're given.  It checks that every call is typed (a HANDLE is pointer-sized: an untyped call passes
# and returns a C int, which on 64-bit Windows isn't one), what each source reads, and that a failing
# call surfaces as an error naming it, which capacity() turns into an unknown figure and a diagnosis.
import ctypes
import os
import sys
import types

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "lib"))
import _capacity as C

GiB = 1 << 30
fails = []


def check(label, got, want):
    if got != want:
        fails.append("%s: got %r, want %r" % (label, got, want))


class Fn:
    """A fake C function: records argtypes/restype set on it; calls `impl`."""
    def __init__(self, impl):
        self.impl, self.argtypes, self.restype = impl, None, None
    def __call__(self, *a):
        return self.impl(*a)


def obj(p):
    return p._obj  # (what ctypes.byref(x) points at)


# ---- macOS
class LibSystem:
    def __init__(self, memsize=16 * GiB, page=16384, free=100000, inactive=150000, speculative=7777, fail=None):
        self.memsize, self.page, self.free, self.inactive, self.spec, self.fail = memsize, page, free, inactive, speculative, fail
        self.sysctlbyname = Fn(self._sysctl)
        self.mach_host_self = Fn(lambda: 0x1003)
        self.host_page_size = Fn(self._page)
        self.host_statistics64 = Fn(self._stats)
        self.counts = []
    def _sysctl(self, name, out, size, new, newlen):
        if self.fail == "sysctl" or name != b"hw.memsize" or obj(size).value != 8:
            return -1
        obj(out).value = self.memsize
        return 0
    def _page(self, host, out):
        if self.fail == "page":
            return 5
        obj(out).value = self.page
        return 0
    def _stats(self, host, flavor, out, count):
        self.counts.append((host, flavor, obj(count).value))
        if self.fail == "stats" or flavor != 4:
            return 5
        vm = obj(out)
        vm.free_count, vm.inactive_count, vm.speculative_count, vm.active_count = self.free, self.inactive, self.spec, 999999
        return 0


def fake_mac(lib):
    """_CtypesMac made over `lib` (its real __init__, with ctypes.CDLL replaced)."""
    real = ctypes.CDLL
    ctypes.CDLL = lambda *a, **k: lib
    try:
        return C._CtypesMac()
    finally:
        ctypes.CDLL = real


lib = LibSystem()
m = fake_mac(lib)
for name in ("sysctlbyname", "mach_host_self", "host_page_size", "host_statistics64"):
    f = getattr(lib, name)
    check("mac %s typed" % name, (f.argtypes is not None, f.restype is not None), (True, True))
check("mac total", m.physical(), 16 * GiB)
check("mac available: free + inactive pages times the page size", m.available(), (100000 + 150000) * 16384)
check("mac host_statistics64's call", lib.counts[-1], (0x1003, 4, ctypes.sizeof(m.VM) // 4))
check("mac vm_statistics64's size (38 integer_t)", ctypes.sizeof(m.VM), 152)
for fail, which in (("sysctl", "physical"), ("page", "available"), ("stats", "available")):
    mm = fake_mac(LibSystem(fail=fail))
    try:
        getattr(mm, which)()
        fails.append("mac %s failing: no error" % fail)
    except OSError:
        pass
# (through capacity(): the source named, its figure the available one; a failing call leaves it unknown)
C._set_sources(platform="darwin", rlimits={"RLIMIT_AS": (-1, -1), "RLIMIT_DATA": (-1, -1)}, runtime=lambda: [])
C._api["mac"] = fake_mac(LibSystem())
rec = C.capacity()
check("mac capacity", (rec["bytes"], [b["source"] for b in rec["basis"]]), ((100000 + 150000) * 16384, ["macos-host"]))
C._set_sources(platform="darwin", rlimits={"RLIMIT_AS": (-1, -1), "RLIMIT_DATA": (-1, -1)}, runtime=lambda: [])
C._api["mac"] = fake_mac(LibSystem(fail="stats"))
rec = C.capacity()
check("mac capacity, a failing call", (rec["bytes"], rec["unknown_parts"], sorted(C.diagnosis())), (None, ["macos-host"], ["macos-host"]))


# ---- Windows
class Kernel32:
    def __init__(self, in_job=True, flags=0, job_limit=0, peak=0, avail=10 * GiB, fail=None):
        self.in_job_, self.flags, self.job_limit, self.peak, self.avail, self.fail = in_job, flags, job_limit, peak, avail, fail
        self.GetCurrentProcess = Fn(lambda: ctypes.c_void_p(-1).value)
        self.GlobalMemoryStatusEx = Fn(self._mem)
        self.IsProcessInJob = Fn(self._in_job)
        self.QueryInformationJobObject = Fn(self._query)
        self.handles = []
    def _mem(self, p):
        if self.fail == "mem":
            return 0
        m = obj(p)
        m.ullTotalPhys, m.ullAvailPhys = 16 * GiB, self.avail
        return 1
    def _in_job(self, h, job, out):
        self.handles.append(h)
        if self.fail == "in_job":
            return 0
        obj(out).value = 1 if self.in_job_ else 0
        return 1
    def _query(self, h, cls, out, size, ret):
        if self.fail == "query" or cls != 9:
            return 0
        info = obj(out)
        info.BasicLimitInformation.LimitFlags = self.flags
        info.JobMemoryLimit, info.PeakJobMemoryUsed = self.job_limit, self.peak
        return 1


class Psapi:
    def __init__(self):
        self.GetProcessMemoryInfo = Fn(self._pmi)
    def _pmi(self, h, p, cb):
        obj(p).PrivateUsage = GiB
        return 1


def fake_windows(k32):
    """_CtypesWindows made over fake kernel32 and psapi (its real __init__; ctypes.WinDLL supplied)."""
    real_dll, real_err = getattr(ctypes, "WinDLL", None), getattr(ctypes, "get_last_error", None)
    ctypes.WinDLL = lambda name, **k: k32 if name == "kernel32" else Psapi()
    ctypes.get_last_error = lambda: 87
    try:
        w = C._CtypesWindows()
    finally:
        if real_dll is None:
            del ctypes.WinDLL
        else:
            ctypes.WinDLL = real_dll
    w.c = types.SimpleNamespace(**{k: getattr(ctypes, k) for k in dir(ctypes) if not k.startswith("__")})
    w.c.get_last_error = lambda: 87
    if real_err is None:
        del ctypes.get_last_error
    else:
        ctypes.get_last_error = real_err
    return w


k = Kernel32()
w = fake_windows(k)
from ctypes import wintypes
check("windows GetCurrentProcess returns a HANDLE", k.GetCurrentProcess.restype, wintypes.HANDLE)
for name in ("GetCurrentProcess", "GlobalMemoryStatusEx", "IsProcessInJob", "QueryInformationJobObject"):
    f = getattr(k, name)
    check("windows %s typed" % name, (f.argtypes is not None, f.restype is not None), (True, True))
check("windows GetProcessMemoryInfo typed", (w.psapi.GetProcessMemoryInfo.argtypes is not None, w.psapi.GetProcessMemoryInfo.restype is not None), (True, True))
check("windows physical", w.physical(), (16 * GiB, 10 * GiB))
check("windows in a job", w.in_job(), True)
check("windows a job with no memory limit", w.job_limit(), (None, None, None))
check("windows a job limit", fake_windows(Kernel32(flags=0x200, job_limit=2 * GiB, peak=GiB)).job_limit(), (2 * GiB, GiB, "job"))
for fail, call, want in (("mem", "physical", "GlobalMemoryStatusEx failed: winerror 87"), ("in_job", "in_job", "IsProcessInJob failed: winerror 87"), ("query", "job_limit", "QueryInformationJobObject failed: winerror 87")):
    try:
        getattr(fake_windows(Kernel32(fail=fail)), call)()
        fails.append("windows %s failing: no error" % fail)
    except OSError as e:
        check("windows %s failing says which call" % fail, str(e), want)
# (through capacity(): in a job with no memory limit, the physical figure, never None; a job limit binds;
# a failing query is unknown, with its reason)
for label, kk, want in (("job, no memory limit", Kernel32(), 10 * GiB), ("job limit binds", Kernel32(flags=0x200, job_limit=2 * GiB, peak=GiB), GiB),
                        ("not in a job", Kernel32(in_job=False), 10 * GiB), ("query fails", Kernel32(fail="query"), None)):
    C._set_sources(platform="win32", runtime=lambda: [])
    C._api["windows"] = fake_windows(kk)
    rec = C.capacity()
    check("windows capacity, " + label, rec["bytes"], want)
check("windows diagnosis, query fails", C.diagnosis(), {"windows-job": "job_limit: QueryInformationJobObject failed: winerror 87"})
C._set_sources()

if fails:
    print("FAIL\n" + "\n".join(fails))
    sys.exit(1)
print("ok: the ctypes sources")
