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
- capacity()["domains"]: the kinds of memory this observation vouches for
  (plan-d0-domains-r2): each basis row says which DOMAINS its `used` counts
  ("includes") and which its `limit` bounds ("constrains"); a domain is in
  the set when a row with a finite remainder includes it and none with a
  finite remainder constrains it without including it.  The PNG ledger
  absorbs a resident record only for a domain in it (PNG plan r8 §2.1).
- poly_share(): the one route that does follow free memory: the default
  budget of a polynomial factorization, floor(effective_guard_bytes / 2),
  or a quarter of what is free when that is more (a small session),
  from a snapshot at most 250 ms old (a burst of small factorizations reads
  the sources once per 250 ms, not once each).

Every figure is in bytes, computed in Python integers.  Nothing here calls
the engine.  The tests replace the sources through _set_sources().
"""

import sys as _sys
try:
    # (pyjs: the runtime's own clock; importing the time module would bring
    # _pytime, _tzrules and their file reading into every mode's start)
    import _time
except ImportError:  # (CPython)
    import time as _time

_NOMINAL = 1 << 30                 # (a host that cannot say: as before D0)
_RESERVE_BASE = 256 << 20
_NO_CEILING = 1 << 62              # (a cgroup v1 "limit" this large is none)
_SNAPSHOT_S = 0.1          # (the CPython total's snapshot)
_POLY_SNAPSHOT_S = 0.25    # (poly's share: daybreak2's 250 ms, D0)

# The kinds of memory a basis row may count or bound (plan-d0-domains-r2):
# CPython's heap; descendant processes; the JS heap's objects; ArrayBuffer
# backing stores; the Sagebrush engine instance's own Memory; any other
# WebAssembly Memory (a raster instance).  One per kind, whatever the
# runtime: a kind that can't occur in one is simply never charged there.
DOMAINS = ("child", "cpython-heap", "js-arraybuffer", "js-heap", "wasm-engine", "wasm-instance")
_ALL = list(DOMAINS)
_SELF = [d for d in DOMAINS if d != "child"]   # (this process's memory)


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


try:
    # (pyjs: the runtime's own file read; open() would bring _pyjs_open and
    # io into the start of every mode whose start dispatches to the engine,
    # since each dispatch asks for poly's share, D0)
    import _fs
except ImportError:  # (CPython)
    _fs = None


def _read(path):
    try:
        if _fs is not None:
            return _fs.read(_src.root + path).decode("utf-8", "replace")
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
    """[("v2" or "v1", source, dir)] from /proc/self/cgroup, or
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
            # (v1 too: the group and each ancestor up to the hierarchy's
            # root, each limit against its own usage; a leaf unlimited, or
            # larger, leaves a tighter ancestor in force)
            path = parts[2].strip().rstrip("/")
            seen = 0
            while True:
                d = "/sys/fs/cgroup/memory" + path
                if _read(d + "/memory.limit_in_bytes") is not None:
                    out.append(("v1", "cgroup v1 " + (path or "/"), d))
                if path == "" or seen > 64:
                    break
                path = path.rsplit("/", 1)[0]
                seen += 1
    _cg_dirs = out
    return out


def _cgroups():
    """[(source, limit, used)] for this process's memory cgroup and its
    ancestors, v2 or v1; [] when it has none; None when it can't be read."""
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
            n = _int(_read(b[0] + "/memory.limit_in_bytes") or "")
            if n is not None and n < _NO_CEILING:
                out.append((a, n, _int(_read(b[0] + "/memory.usage_in_bytes") or "")))
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
    """The Windows sources: (job_limit or None, job_used, total, available,
    scope), or None when they can't be read (and then nothing finite is
    claimed).  scope: which job limit the figures are, "process" or "job"
    (_job_choice), None when not in a job or the source doesn't say."""
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
            return (None, None, total, available, None)
        got = tuple(w.job_limit())
        # (a source with no scope, as an older one: unknown, read
        # conservatively by _job_domains)
        limit, used, scope = got if len(got) == 3 else got + (None,)
        return (limit, used, total, available, scope)
    except Exception:
        return None


_PROCESS_MEMORY, _JOB_MEMORY = 0x100, 0x200   # (JOB_OBJECT_LIMIT_*_MEMORY)


def _job_choice(flags, process_limit, process_used, job_limit, job_used):
    """The job limit a Windows process is under: (limit, used, scope).  A
    per-process limit (ProcessMemoryLimit, against this process's commit)
    or one for the whole job (JobMemoryLimit, against PeakJobMemoryUsed);
    with both, the one with the smaller remainder, the per-process one on a
    tie; (None, None, None) with neither.  scope says which: a per-process
    limit neither counts nor bounds a child's memory, a job's does
    (plan-d0-domains-r2 §1.2a)."""
    best = None
    if flags & _PROCESS_MEMORY:
        best = (process_limit, process_used, "process")
    if flags & _JOB_MEMORY:
        j = (job_limit, job_used, "job")
        if best is None or j[0] - j[1] < best[0] - best[1]:
            best = j
    return best if best is not None else (None, None, None)


def _job_domains(scope):
    """(includes, constrains) of the Windows job row by its scope."""
    if scope == "job":
        return _ALL, _ALL
    if scope == "process":
        return _SELF, _SELF
    return _SELF, _ALL   # (unknown: bounds the child, never seen counting it)


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
        commit = self._commit() if flags & _PROCESS_MEMORY else None
        return _job_choice(flags, int(info.ProcessMemoryLimit), commit, int(info.JobMemoryLimit), int(info.PeakJobMemoryUsed))

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
    limit, used, includes, constrains)]; [] in CPython.  A part with no
    domains, (source, limit, used) from an older engine or a test, gets
    none: it can never widen capacity()["domains"]."""
    if _src.runtime is not None:
        parts = list(_src.runtime())
    elif not hasattr(_sys, "_sagebrush_heap_limit"):
        return []
    else:
        try:
            import _sbengine
            parts = list(_sbengine.capacity_parts())
        except Exception:
            return None
    out = []
    for p in parts:
        p = tuple(p)
        if len(p) >= 5:
            out.append((p[0], p[1], p[2], [d for d in DOMAINS if d in p[3]], [d for d in DOMAINS if d in p[4]]))
        else:
            out.append((p[0], p[1], p[2], [], []))
    return out


# ------------------------------------------------------------------ the total

def heap_figure():
    """The total a memory guard takes its share of, in bytes: pyjs's heap
    limit, unchanged; in CPython the least of the cgroup limit, RLIMIT_AS,
    RLIMIT_DATA, the Windows job limit and physical memory, read now; a
    nominal 1 GiB when none can be read."""
    n = getattr(_sys, "_sagebrush_heap_limit", None)
    if n:
        return int(n)
    # (a total, not a usage: a snapshot at most 100 ms old; a
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
        job, _, total, _, _ = w
        limits.append(("physical", total))
        if job is not None:
            limits.append(("windows job", job))
    else:
        for name, lim, _ in (_cgroups() or []):
            limits.append((name, lim))
        for r in ("RLIMIT_AS", "RLIMIT_DATA"):
            v = _rlimit(r)
            # (0 is a limit: only none, None, and unreadable, False, are not)
            if v is not None and v is not False:
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

    def add(source, limit, used, includes=_ALL, constrains=_ALL, **extra):
        if limit is None:
            return
        rem = None if used is None else max(0, int(limit) - int(used))
        # (a usage not read counts nothing)
        row = {"source": source, "limit": int(limit), "used": None if used is None else int(used), "remaining": rem,
               "includes": [] if used is None else list(includes), "constrains": list(constrains)}
        row.update(extra)
        basis.append(row)
        if rem is None:
            unknown.append(source + " usage")

    if _src.platform == "win32":
        w = _windows()
        if w is None:
            # (then the figure is unknown, whatever the other parts say: _record)
            unknown.append("windows-job")
        else:
            job, job_used, total, available, scope = w
            add("physical available", total, total - available)
            if job is not None:
                inc, con = _job_domains(scope)
                add("windows job", job, job_used, inc, con, scope=scope)
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
                # (this process's address space: not a child's)
                add(r, v, used, _SELF, _SELF)
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
        for source, lim, used, inc, con in parts:
            add(source, lim, used, inc, con)
    return _record(basis, unknown)


def _record(basis, unknown):
    rems = [b["remaining"] for b in basis if b["remaining"] is not None]
    # (Windows with its sources unread: unknown, never a finite figure from
    # the others)
    n = None if ("windows-job" in unknown or not rems) else min(rems)
    return {"bytes": n, "basis": basis, "unknown_parts": unknown, "observed_at": _time.time(),
            "reserve_bytes": reserve_bytes(n), "domains": [] if n is None else _domains(basis)}


def _domains(basis):
    """The domains the rows with a finite remainder vouch for: included by
    one of them (observed), and constrained by none that doesn't include
    it (not contradicted) (plan-d0-domains-r2 §1.3)."""
    rows = [b for b in basis if b["remaining"] is not None]
    seen = {d for b in rows for d in b.get("includes", ())}
    blind = {d for b in rows for d in b.get("constrains", ()) if d not in b.get("includes", ())}
    return [d for d in DOMAINS if d in seen and d not in blind]


def reserve_bytes(n):
    """256 MiB + ceil(n / 10): never smaller than stated; 256 MiB for None."""
    return _RESERVE_BASE if n is None else _RESERVE_BASE + -(-n // 10)


def effective_guard_bytes(record):
    """max(0, bytes - reserve_bytes), or None when bytes is None."""
    n = record["bytes"]
    return None if n is None else max(0, n - record["reserve_bytes"])


# ------------------------------------------------------------------ poly

_poly_snap = None
# (the age in seconds of the observation poly_share last returned: the
# host's engine.ts reuses a pushed share only until that observation is
# 250 ms old, one freshness budget for both caches, D0)
_poly_age = 0.0


def poly_share():
    """The memory of one default polynomial factorization, in bytes:
    share_of(the bytes observed free), or None (the engine then keeps its
    512 MiB), from a snapshot at most 250 ms old.  The JS heap is left out
    of it: the engine allocates its own (WebAssembly) memory, outside it.

    (Top-level factorizations in one host worker are serialized: one
    interpreter thread calls the engine.  The share is a per-factorization
    cap, not an aggregate one: concurrent native top-level factorizations
    would each get it, and would need their own aggregate admission
    review, daybreak2's D0 r2 condition.)"""
    global _poly_snap, _poly_age
    now = _src.clock()
    if _poly_snap is not None and now - _poly_snap[0] < _POLY_SNAPSHOT_S:
        _poly_age = now - _poly_snap[0]
        return _poly_snap[1]
    # (the engine's memory is its own: the JS heap does not bound it)
    rec = capacity()
    rec = _record([b for b in rec["basis"] if b["source"] != "js heap"], [u for u in rec["unknown_parts"] if u != "js heap usage"])
    share = share_of(rec["bytes"])
    _poly_snap = (now, share)
    _poly_age = 0.0
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
