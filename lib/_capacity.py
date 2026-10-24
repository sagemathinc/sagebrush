"""The memory this session can see: one collector (item D0).

plan-d-memory-message-r3 §1d, amended by plan-d0-capacity-r2 §0:

- heap_figure(): the TOTAL a memory guard takes its share of (one matrix may
  use 1/4 of it, say).  In pyjs it is the runtime's own figure
  (sys._sagebrush_heap_limit: the old space the session can grow to), exactly
  as before.  In CPython it is the machine's total as this process sees it
  (cgroup, resource limits, physical memory), from a snapshot at most
  100 ms old; a nominal 1 GiB when nothing can be read, as before.
- capacity(): the memory observed free now, fresh on each call, with its
  basis and what could not be read.  It decides no admission: it goes in a
  refusal's record and in estimates' `fits`.  An observation, not a
  reservation or a promise that an allocation succeeds.
- poly_share(): the one route that does follow free memory: the default
  budget of a polynomial factorization, floor(effective_guard_bytes / 2),
  or a quarter of what is free when that is more (a small session),
  from a snapshot at most 100 ms old (a burst of small factorizations reads
  the sources once per 100 ms, not once each).

Every figure is in bytes, computed in Python integers.  Nothing here calls
the engine.  The tests replace the sources through _set_sources().
"""

import sys as _sys
import time as _time

_NOMINAL = 1 << 30                 # (a host that cannot say: as before D0)
_RESERVE_BASE = 256 << 20
_NO_CEILING = 1 << 62              # (a cgroup v1 "limit" this large is none)
_SNAPSHOT_S = 0.1


# ------------------------------------------------------------------ sources

class _Sources:
    """Where the figures are read: the real system, unless a test sets
    others (a fake root for /proc and /sys, fake resource limits, a fake
    Windows API, a fake runtime, a clock)."""

    root = ""
    platform = _sys.platform
    rlimits = None          # None: the resource module; else name -> (soft, hard)
    windows = None          # None: ctypes; else an object with the queries
    runtime = None          # None: _sbengine.capacity_parts() in pyjs
    clock = staticmethod(_time.monotonic)


_src = _Sources()


def _set_sources(**kw):
    """Tests only: replace the sources (keyword names as in _Sources);
    _set_sources() restores the real ones."""
    global _src, _poly_snap, _total_snap, _cg_dirs
    _src = _Sources()
    for k, v in kw.items():
        if not hasattr(_Sources, k):
            raise TypeError("no source %r" % k)
        setattr(_src, k, v)
    _poly_snap = _total_snap = _cg_dirs = None


def _read(path):
    try:
        with open(_src.root + path) as f:
            return f.read()
    except Exception:
        return None


def _int(text):
    try:
        return int(text.strip())
    except Exception:
        return None


def _kib_field(text, name):
    """A "Name:  1234 kB" field of /proc/meminfo or /proc/self/status, in
    bytes; None if absent."""
    if text is None:
        return None
    for line in text.splitlines():
        if line.startswith(name + ":"):
            parts = line.split()
            if len(parts) >= 2:
                n = _int(parts[1])
                if n is not None:
                    return n * 1024
    return None


# (the directories of this process's memory cgroups, found once: a
# process's cgroup doesn't change under it; their limits and usage are read
# at each call)
_cg_dirs = None


def _cgroup_dirs():
    """[("v2", source, dir) or ("v1", dirs)] from /proc/self/cgroup, or
    None when it can't be read."""
    global _cg_dirs
    if _cg_dirs is not None:
        return _cg_dirs
    text = _read("/proc/self/cgroup")
    if text is None:
        return None
    out = []
    for line in text.splitlines():
        parts = line.split(":", 2)
        if len(parts) != 3:
            continue
        if parts[0] == "0" and parts[1] == "":
            path = parts[2].strip().rstrip("/")
            seen = 0
            while True:
                # (only the groups that have the controller's files: the
                # others never will under a running process)
                if _read("/sys/fs/cgroup" + path + "/memory.max") is not None:
                    out.append(("v2", "cgroup " + (path or "/"), "/sys/fs/cgroup" + path))
                if path == "" or seen > 64:
                    break
                path = path.rsplit("/", 1)[0]
                seen += 1
        elif "memory" in parts[1].split(","):
            out.append(("v1", ("/sys/fs/cgroup/memory" + parts[2].strip().rstrip("/"), "/sys/fs/cgroup/memory")))
    _cg_dirs = out
    return out


def _cgroups():
    """[(source, limit, used)] for this process's memory cgroup, v2 and its
    ancestors, or v1; [] when it has none; None when it can't be read."""
    dirs = _cgroup_dirs()
    if dirs is None:
        return None
    out = []
    for kind, a, *b in dirs:
        if kind == "v2":
            lim = _read(b[0] + "/memory.max")
            if lim is not None and lim.strip() != "max":
                n, used = _int(lim), _int(_read(b[0] + "/memory.current") or "")
                if n is not None:
                    out.append((a, n, used))
        else:
            for d in a:
                n = _int(_read(d + "/memory.limit_in_bytes") or "")
                if n is not None:
                    if n < _NO_CEILING:
                        out.append(("cgroup v1", n, _int(_read(d + "/memory.usage_in_bytes") or "")))
                    break
    return out


_resource_mod = 0  # (0: not tried yet; None: there is none)


def _resource():
    """The resource module, imported once (pyjs has none)."""
    global _resource_mod
    if _resource_mod == 0:
        try:
            import resource as r
        except Exception:
            r = None
        _resource_mod = r
    return _resource_mod


def _rlimit(name):
    """The soft limit `name` (RLIMIT_AS, RLIMIT_DATA): None for none, or
    False when it can't be read."""
    try:
        if _src.rlimits is not None:
            soft = _src.rlimits[name][0]
            inf = -1
        else:
            resource = _resource()
            if resource is None:
                return False
            soft = resource.getrlimit(getattr(resource, name))[0]
            inf = resource.RLIM_INFINITY
    except Exception:
        return False
    if soft == inf or soft < 0 or soft >= _NO_CEILING:
        return None
    return soft


def _windows():
    """The Windows sources: (job_limit or None, job_used, total, available),
    or None when they can't be read (and then nothing finite is claimed)."""
    w = _src.windows
    if w is None:
        try:
            w = _CtypesWindows()
        except Exception:
            return None
    try:
        total, available = w.physical()
        in_job = w.in_job()
        if not in_job:
            return (None, None, total, available)
        limit, used = w.job_limit()
        return (limit, used, total, available)
    except Exception:
        return None


class _CtypesWindows:
    """The Windows API through ctypes: physical memory, and the limit of the
    job this process is in, if any.  A job's limit is set per process
    (ProcessMemoryLimit, against this process's commit) or for the whole job
    (JobMemoryLimit, against PeakJobMemoryUsed: the API gives no current job
    commit, and the peak is at least that, so the figure errs low)."""

    def __init__(self):
        import ctypes
        from ctypes import wintypes
        self.c, self.w = ctypes, wintypes
        self.k32 = ctypes.WinDLL("kernel32", use_last_error=True)

    def physical(self):
        c = self.c

        class MEMORYSTATUSEX(c.Structure):
            _fields_ = [("dwLength", c.c_ulong), ("dwMemoryLoad", c.c_ulong), ("ullTotalPhys", c.c_ulonglong),
                        ("ullAvailPhys", c.c_ulonglong), ("ullTotalPageFile", c.c_ulonglong), ("ullAvailPageFile", c.c_ulonglong),
                        ("ullTotalVirtual", c.c_ulonglong), ("ullAvailVirtual", c.c_ulonglong), ("ullAvailExtendedVirtual", c.c_ulonglong)]
        m = MEMORYSTATUSEX()
        m.dwLength = c.sizeof(m)
        if not self.k32.GlobalMemoryStatusEx(c.byref(m)):
            raise OSError("GlobalMemoryStatusEx")
        return int(m.ullTotalPhys), int(m.ullAvailPhys)

    def in_job(self):
        c, w = self.c, self.w
        r = w.BOOL()
        if not self.k32.IsProcessInJob(self.k32.GetCurrentProcess(), None, c.byref(r)):
            raise OSError("IsProcessInJob")
        return bool(r.value)

    def job_limit(self):
        c = self.c

        class IO_COUNTERS(c.Structure):
            _fields_ = [(n, c.c_ulonglong) for n in ("r", "w", "o", "rb", "wb", "ob")]

        class BASIC(c.Structure):
            _fields_ = [("PerProcessUserTimeLimit", c.c_longlong), ("PerJobUserTimeLimit", c.c_longlong), ("LimitFlags", c.c_ulong),
                        ("MinimumWorkingSetSize", c.c_size_t), ("MaximumWorkingSetSize", c.c_size_t), ("ActiveProcessLimit", c.c_ulong),
                        ("Affinity", c.c_size_t), ("PriorityClass", c.c_ulong), ("SchedulingClass", c.c_ulong)]

        class EXTENDED(c.Structure):
            _fields_ = [("BasicLimitInformation", BASIC), ("IoInfo", IO_COUNTERS), ("ProcessMemoryLimit", c.c_size_t),
                        ("JobMemoryLimit", c.c_size_t), ("PeakProcessMemoryUsed", c.c_size_t), ("PeakJobMemoryUsed", c.c_size_t)]
        info = EXTENDED()
        if not self.k32.QueryInformationJobObject(None, 9, c.byref(info), c.sizeof(info), None):
            raise OSError("QueryInformationJobObject")
        flags = info.BasicLimitInformation.LimitFlags
        PROCESS_MEMORY, JOB_MEMORY = 0x100, 0x200
        best = None
        if flags & PROCESS_MEMORY:
            best = (int(info.ProcessMemoryLimit), self._commit())
        if flags & JOB_MEMORY:
            j = (int(info.JobMemoryLimit), int(info.PeakJobMemoryUsed))
            if best is None or j[0] - j[1] < best[0] - best[1]:
                best = j
        return best if best is not None else (None, None)

    def _commit(self):
        c, w = self.c, self.w

        class PMC(c.Structure):
            _fields_ = [("cb", w.DWORD), ("PageFaultCount", w.DWORD)] + [(n, c.c_size_t) for n in (
                "PeakWorkingSetSize", "WorkingSetSize", "QuotaPeakPagedPoolUsage", "QuotaPagedPoolUsage",
                "QuotaPeakNonPagedPoolUsage", "QuotaNonPagedPoolUsage", "PagefileUsage", "PeakPagefileUsage", "PrivateUsage")]
        p = PMC()
        p.cb = c.sizeof(p)
        psapi = c.WinDLL("psapi", use_last_error=True)
        if not psapi.GetProcessMemoryInfo(self.k32.GetCurrentProcess(), c.byref(p), p.cb):
            raise OSError("GetProcessMemoryInfo")
        return int(p.PrivateUsage)


def _runtime_parts():
    """pyjs's own parts, from the runtime (never guessed here): [(source,
    limit, used)]; [] in CPython."""
    if _src.runtime is not None:
        return list(_src.runtime())
    if not hasattr(_sys, "_sagebrush_heap_limit"):
        return []
    try:
        import _sbengine
        return [tuple(p) for p in _sbengine.capacity_parts()]
    except Exception:
        return None


# ------------------------------------------------------------------ the total

def heap_figure():
    """The total a memory guard takes its share of, in bytes: pyjs's heap
    limit, unchanged; in CPython the least of the cgroup limit, RLIMIT_AS,
    RLIMIT_DATA, the Windows job limit and physical memory, read now; a
    nominal 1 GiB when none can be read."""
    n = getattr(_sys, "_sagebrush_heap_limit", None)
    if n:
        return int(n)
    # (a total, not a usage: a snapshot at most 100 ms old, as poly's; a
    # read costs about 90 us, and a guard runs at each matrix made)
    global _total_snap
    now = _src.clock()
    if _total_snap is None or now - _total_snap[0] >= _SNAPSHOT_S:
        _total_snap = (now, _machine_total()[0])
    return _total_snap[1]


_total_snap = None


def _machine_total():
    """(total, basis): see heap_figure."""
    limits = []
    if _src.platform == "win32":
        w = _windows()
        if w is None:
            return _NOMINAL, ["nominal"]
        job, _, total, _ = w
        limits.append(("physical", total))
        if job is not None:
            limits.append(("windows job", job))
    else:
        for name, lim, _ in (_cgroups() or []):
            limits.append((name, lim))
        for r in ("RLIMIT_AS", "RLIMIT_DATA"):
            v = _rlimit(r)
            if v:
                limits.append((r, v))
        t = _kib_field(_read("/proc/meminfo"), "MemTotal")
        if t:
            limits.append(("MemTotal", t))
    if not limits:
        return _NOMINAL, ["nominal"]
    m = min(v for _, v in limits)
    return m, [k for k, v in limits if v == m]


# ------------------------------------------------------------------ free now

def capacity():
    """The memory observed free now (plan-d-memory-message-r3 §1d):
    {"bytes", "basis", "unknown_parts", "observed_at", "reserve_bytes"}.
    bytes is the least `remaining` over the observed sources (None if none
    is observable, and always None on Windows when its sources can't be
    read); reserve_bytes is 256 MiB + ceil(bytes / 10)."""
    basis, unknown = [], []

    def add(source, limit, used):
        if limit is None:
            return
        rem = None if used is None else max(0, int(limit) - int(used))
        basis.append({"source": source, "limit": int(limit), "used": None if used is None else int(used), "remaining": rem})
        if rem is None:
            unknown.append(source + " usage")

    if _src.platform == "win32":
        w = _windows()
        if w is None:
            # (then the figure is unknown, whatever the other parts say: _record)
            unknown.append("windows-job")
        else:
            job, job_used, total, available = w
            add("physical available", total, total - available)
            if job is not None:
                add("windows job", job, job_used)
    else:
        groups = _cgroups()
        if groups is None:
            unknown.append("cgroup")
        else:
            for name, lim, used in groups:
                add(name, lim, used)
        status = None  # (read only when a limit is set)
        for r, field in (("RLIMIT_AS", "VmSize"), ("RLIMIT_DATA", "VmData")):
            v = _rlimit(r)
            if v is False:
                unknown.append(r)
            elif v is not None:
                if status is None:
                    status = _read("/proc/self/status") or ""
                used = _kib_field(status, field)
                add(r, v, used)
        meminfo = _read("/proc/meminfo")
        avail, total = _kib_field(meminfo, "MemAvailable"), _kib_field(meminfo, "MemTotal")
        if avail is None or total is None:
            unknown.append("MemAvailable")
        else:
            add("MemAvailable", total, total - avail)
    parts = _runtime_parts()
    if parts is None:
        unknown.append("runtime")
    else:
        for source, lim, used in parts:
            add(source, lim, used)
    return _record(basis, unknown)


def _record(basis, unknown):
    rems = [b["remaining"] for b in basis if b["remaining"] is not None]
    # (Windows with its sources unread: unknown, never a finite figure from
    # the others)
    n = None if ("windows-job" in unknown or not rems) else min(rems)
    return {"bytes": n, "basis": basis, "unknown_parts": unknown, "observed_at": _time.time(),
            "reserve_bytes": reserve_bytes(n)}


def reserve_bytes(n):
    """256 MiB + ceil(n / 10): never smaller than stated; 256 MiB for None."""
    return _RESERVE_BASE if n is None else _RESERVE_BASE + -(-n // 10)


def effective_guard_bytes(record):
    """max(0, bytes - reserve_bytes), or None when bytes is None."""
    n = record["bytes"]
    return None if n is None else max(0, n - record["reserve_bytes"])


# ------------------------------------------------------------------ poly

_poly_snap = None


def poly_share():
    """The memory of one default polynomial factorization, in bytes:
    share_of(the bytes observed free), or None (the engine then keeps its
    512 MiB), from a snapshot at most 100 ms old.  The JS heap is left out
    of it: the engine allocates its own (WebAssembly) memory, outside it.

    (Top-level factorizations in one host worker are serialized: one
    interpreter thread calls the engine.  The share is a per-factorization
    cap, not an aggregate one: concurrent native top-level factorizations
    would each get it, and would need their own aggregate admission
    review, daybreak2's D0 r2 condition.)"""
    global _poly_snap
    now = _src.clock()
    if _poly_snap is not None and now - _poly_snap[0] < _SNAPSHOT_S:
        return _poly_snap[1]
    # (the engine's memory is its own: the JS heap does not bound it)
    rec = capacity()
    rec = _record([b for b in rec["basis"] if b["source"] != "js heap"], [u for u in rec["unknown_parts"] if u != "js heap usage"])
    share = share_of(rec["bytes"])
    _poly_snap = (now, share)
    return share


def share_of(n):
    """The poly share for n bytes observed free (None: None):
    max(floor(max(0, n - reserve_bytes(n)) / 2), floor(n / 4)), between
    floor(n / 4) and floor(n / 2).  The reserve sizes large sessions; a
    small one keeps a quarter of what is free (with the reserve alone,
    under about 284 MiB free every factorization, x^2 - 1 too, would be
    refused: the amendment to D0 r2 §3 and D r3 §1d, daybreak2 and astra).
    0 stays 0 (refused), as None stays None (the default)."""
    if n is None:
        return None
    return max(max(0, n - reserve_bytes(n)) // 2, n // 4)
