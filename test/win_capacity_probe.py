# (copied from @sagebrush-board's probe for this PR, sha256 1a4382bc...: run by .github/workflows/pypi.yml on Windows, for the log)
"""Windows capacity probe (for the D0 macOS/Windows PR, from @sagebrush-board).

Run on a Windows runner:  python win-capacity-probe.py [path/to/lib]
It prints, for each kernel32/psapi call lib/_capacity.py makes, its return value
and GetLastError, first as _capacity calls it (no argtypes/restype), then with
explicit HANDLE/BOOL types, and finally what _capacity's own _windows() and
capacity() return.  It changes nothing and needs no privileges.
"""
import ctypes
import json
import sys
from ctypes import wintypes

if sys.platform != "win32":
    sys.exit("this probe is for Windows")

print("python", sys.version.replace("\n", " "), "pointer bits", ctypes.sizeof(ctypes.c_void_p) * 8)


def report(name, ok, extra=""):
    print(f"{name:40s} -> {ok!r}  GetLastError={ctypes.get_last_error()}  {extra}")


class MEMORYSTATUSEX(ctypes.Structure):
    _fields_ = [("dwLength", ctypes.c_ulong), ("dwMemoryLoad", ctypes.c_ulong), ("ullTotalPhys", ctypes.c_ulonglong),
                ("ullAvailPhys", ctypes.c_ulonglong), ("ullTotalPageFile", ctypes.c_ulonglong), ("ullAvailPageFile", ctypes.c_ulonglong),
                ("ullTotalVirtual", ctypes.c_ulonglong), ("ullAvailVirtual", ctypes.c_ulonglong), ("ullAvailExtendedVirtual", ctypes.c_ulonglong)]


class IO_COUNTERS(ctypes.Structure):
    _fields_ = [(n, ctypes.c_ulonglong) for n in ("r", "w", "o", "rb", "wb", "ob")]


class BASIC(ctypes.Structure):
    _fields_ = [("PerProcessUserTimeLimit", ctypes.c_longlong), ("PerJobUserTimeLimit", ctypes.c_longlong), ("LimitFlags", ctypes.c_ulong),
                ("MinimumWorkingSetSize", ctypes.c_size_t), ("MaximumWorkingSetSize", ctypes.c_size_t), ("ActiveProcessLimit", ctypes.c_ulong),
                ("Affinity", ctypes.c_size_t), ("PriorityClass", ctypes.c_ulong), ("SchedulingClass", ctypes.c_ulong)]


class EXTENDED(ctypes.Structure):
    _fields_ = [("BasicLimitInformation", BASIC), ("IoInfo", IO_COUNTERS), ("ProcessMemoryLimit", ctypes.c_size_t),
                ("JobMemoryLimit", ctypes.c_size_t), ("PeakProcessMemoryUsed", ctypes.c_size_t), ("PeakJobMemoryUsed", ctypes.c_size_t)]


def run(label, typed):
    print(f"--- {label}")
    k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    if typed:
        k32.GetCurrentProcess.restype = wintypes.HANDLE
        k32.GetCurrentProcess.argtypes = []
        k32.GlobalMemoryStatusEx.restype = wintypes.BOOL
        k32.GlobalMemoryStatusEx.argtypes = [ctypes.POINTER(MEMORYSTATUSEX)]
        k32.IsProcessInJob.restype = wintypes.BOOL
        k32.IsProcessInJob.argtypes = [wintypes.HANDLE, wintypes.HANDLE, ctypes.POINTER(wintypes.BOOL)]
        k32.QueryInformationJobObject.restype = wintypes.BOOL
        k32.QueryInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD)]
    h = k32.GetCurrentProcess()
    report("GetCurrentProcess", h, f"(as {type(h).__name__})")
    m = MEMORYSTATUSEX()
    m.dwLength = ctypes.sizeof(m)
    ok = k32.GlobalMemoryStatusEx(ctypes.byref(m))
    report("GlobalMemoryStatusEx", ok, f"total={m.ullTotalPhys} avail={m.ullAvailPhys}")
    r = wintypes.BOOL()
    ok = k32.IsProcessInJob(h, None, ctypes.byref(r))
    report("IsProcessInJob(current, NULL)", ok, f"in_job={bool(r.value)}")
    info = EXTENDED()
    ret = wintypes.DWORD()
    ok = k32.QueryInformationJobObject(None, 9, ctypes.byref(info), ctypes.sizeof(info), ctypes.byref(ret) if typed else None)
    b = info.BasicLimitInformation
    report("QueryInformationJobObject(NULL, 9)", ok,
           f"LimitFlags=0x{b.LimitFlags:x} ProcessMemoryLimit={info.ProcessMemoryLimit} JobMemoryLimit={info.JobMemoryLimit} "
           f"PeakJobMemoryUsed={info.PeakJobMemoryUsed} sizeof={ctypes.sizeof(info)} returned={ret.value}")
    try:
        psapi = ctypes.WinDLL("psapi", use_last_error=True)

        class PMC(ctypes.Structure):
            _fields_ = [("cb", wintypes.DWORD), ("PageFaultCount", wintypes.DWORD)] + [(n, ctypes.c_size_t) for n in (
                "PeakWorkingSetSize", "WorkingSetSize", "QuotaPeakPagedPoolUsage", "QuotaPagedPoolUsage",
                "QuotaPeakNonPagedPoolUsage", "QuotaNonPagedPoolUsage", "PagefileUsage", "PeakPagefileUsage", "PrivateUsage")]
        p = PMC()
        p.cb = ctypes.sizeof(p)
        if typed:
            psapi.GetProcessMemoryInfo.restype = wintypes.BOOL
            psapi.GetProcessMemoryInfo.argtypes = [wintypes.HANDLE, ctypes.POINTER(PMC), wintypes.DWORD]
        ok = psapi.GetProcessMemoryInfo(h, ctypes.byref(p), p.cb)
        report("GetProcessMemoryInfo(current)", ok, f"PrivateUsage={p.PrivateUsage}")
    except Exception as e:  # (psapi missing, or a ctypes error: print it)
        print("GetProcessMemoryInfo raised", repr(e))


run("as lib/_capacity.py calls them (no argtypes/restype)", typed=False)
run("with explicit HANDLE/BOOL types", typed=True)

lib = sys.argv[1] if len(sys.argv) > 1 else None
if lib:
    sys.path.insert(0, lib)
try:
    import _capacity as cap
    print("--- lib/_capacity.py itself, from", cap.__file__)
    try:
        w = cap._CtypesWindows()
        for name in ("physical", "in_job", "job_limit"):
            try:
                print(f"_CtypesWindows.{name}() ->", getattr(w, name)())
            except Exception as e:
                print(f"_CtypesWindows.{name}() raised", repr(e), "GetLastError", ctypes.get_last_error())
    except Exception as e:
        print("_CtypesWindows() raised", repr(e))
    print("_windows() ->", cap._windows())
    rec = cap.capacity()
    print("capacity() ->", json.dumps({k: rec[k] for k in ("bytes", "unknown_parts", "domains")}), "basis sources:", [b["source"] for b in rec["basis"]])
except ImportError as e:
    print("(_capacity not importable: pass the path to lib/ or the installed sagebrush/_sagelib)", e)
