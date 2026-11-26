"""The host's memory ledger and the idle stop (remote r3.3, design/remote-r3.md: Limits, and its implementation
contract; step P2b).

Admission of a new kernel, and of a material buffer (a detached kernel's output, a stream's reassembly), is one
serialized decision against one host-wide ledger: synchronous, on the runner's one event-loop thread, so no two
decisions interleave between the reading and the charge (no await inside one):

  - F, the memory free now: the minimum of the host's figure (MemAvailable on Linux, the VM statistics on macOS) and
    every finite cgroup headroom on the way to the root (v2 memory.max - memory.current; v1 limit - usage), read fresh
    for each decision; unknown, or older than one tick, refuses NEW starts in words (reconnects never ask);
  - R, the system reserve, a setting (--reserve);
  - the pending charges: every admitted start not yet reconciled, and every buffer held;
  - a start of entry E is admitted only if F - R - pending >= K[E], E's measured envelope (helpers and startup buffers
    included); its charge is taken under the lock, before the process is spawned.

A start's charge is reconciled once the kernel is ready, only against a reading taken AFTER its process tree started
(so the reading already counts it): a reading from before is refused as a basis and the charge stays.  A start that
ends (failed, stopped, idle) is refunded only once its tree is reaped (the tree rule's census empty).  Free memory
decides run or refuse only; it never changes how anything runs, and nothing here chooses another way of running.

The idle stop: --idle (default 24h; 10m to 30d, or never) stops a quiescent kernel only (no page attached and no cell
running), on a monotonic clock reset by an attach, a cell's start or end, and any input.
"""

import os
import re
import subprocess
import time

GiB = 1024 ** 3
MiB = 1024 ** 2
DEFAULT_RESERVE = 1 * GiB  # (R: a setting, --reserve; what the system and the person's other programs keep)
TICK_S = 1.0  # (a reading older than this is stale: refused as a basis for a new start)
IDLE_DEFAULT_S = 24 * 3600
IDLE_RANGE_S = (10 * 60, 30 * 24 * 3600)
_DURATION = re.compile(r"([1-9][0-9]{0,6})(m|h|d)\Z")
_UNIT = {"m": 60, "h": 3600, "d": 86400}


def parse_idle(text):
    """--idle's value: seconds, or None for never; ValueError (in words) for anything else, so the host doesn't start."""
    if text == "never":
        return None
    m = _DURATION.match(text or "")
    if not m:
        raise ValueError("--idle takes a duration such as 30m, 24h or 7d (from 10m to 30d), or never: %r" % (text,))
    s = int(m.group(1)) * _UNIT[m.group(2)]
    lo, hi = IDLE_RANGE_S
    if not lo <= s <= hi:
        raise ValueError("--idle is from 10m to 30d, or never: %r" % (text,))
    return s


def parse_size(text):
    """--reserve's value: bytes from e.g. 512M, 2G; ValueError otherwise."""
    m = re.match(r"([1-9][0-9]{0,6})([MG])\Z", text or "")
    if not m:
        raise ValueError("--reserve takes a size such as 512M or 2G: %r" % (text,))
    return int(m.group(1)) * (MiB if m.group(2) == "M" else GiB)


def fmt(n):
    return "%.1f GiB" % (n / GiB) if abs(n) >= GiB else "%d MiB" % round(n / MiB)


# ---- F: the memory free now

class Reading:
    def __init__(self, available, at, how):
        self.available, self.at, self.how = available, at, how


def _meminfo(root):
    try:
        with open(os.path.join(root, "proc/meminfo"), encoding="ascii") as f:
            for line in f:
                if line.startswith("MemAvailable:"):
                    parts = line.split()
                    return int(parts[1]) * 1024 if len(parts) == 3 and parts[2] == "kB" else None
    except (OSError, ValueError):
        return None
    return None


def _read_int(path):
    try:
        with open(path, encoding="ascii") as f:
            t = f.read().strip()
    except OSError:
        return None
    if t == "max":
        return "max"
    try:
        return int(t)
    except ValueError:
        return None


def _unescape_mount(field):
    """mountinfo's octal escapes (space, tab, newline, backslash) undone."""
    return re.sub(r"\\([0-7]{3})", lambda m: chr(int(m.group(1), 8)), field)


def _mounts(root):
    """The cgroup mounts from /proc/self/mountinfo: [(kind, root-in-hierarchy, mountpoint)], kind "v2" or "v1"
    (v1 with the memory controller only); None if mountinfo can't be read or a line is malformed."""
    try:
        with open(os.path.join(root, "proc/self/mountinfo"), encoding="utf-8") as f:
            lines = f.read().splitlines()
    except (OSError, UnicodeDecodeError):
        return None
    out = []
    for line in lines:
        left, sep, right = line.partition(" - ")
        lf, rf = left.split(" "), right.split(" ")
        if not sep or len(lf) < 6 or len(rf) < 3:
            return None
        fstype, superopts = rf[0], rf[2].split(",")
        if fstype == "cgroup2":
            out.append(("v2", _unescape_mount(lf[3]), _unescape_mount(lf[4])))
        elif fstype == "cgroup" and "memory" in superopts:
            out.append(("v1", _unescape_mount(lf[3]), _unescape_mount(lf[4])))
    return out


def _clean_path(p):
    """A cgroup path's components, or None for anything but a plain absolute path (no ".", "..", empty parts)."""
    if not p.startswith("/"):
        return None
    parts = [x for x in p.split("/")[1:] if x != ""] if p != "/" else []
    if any(x in (".", "..") for x in parts) or "//" in p.rstrip("/") or "\0" in p:
        return None
    return parts


def _cgroup_headroom(root):
    """The smallest finite memory headroom of this process's cgroups, from its own up to the namespace's root (the
    mount's root), v2 and v1's memory controller, found through /proc/self/mountinfo (its mountpoint and its root in the
    hierarchy); "none" where no limit is set anywhere on the way; None (unknown: new starts are refused) when the
    membership can't be read, or a reported membership's mount, directory or figure is missing or malformed."""
    try:
        with open(os.path.join(root, "proc/self/cgroup"), encoding="utf-8") as f:
            lines = f.read().splitlines()
    except (OSError, UnicodeDecodeError):
        return None
    member = {}
    for line in lines:
        parts = line.split(":", 2)
        if len(parts) != 3 or not parts[0].isdigit():
            return None
        _, ctrls, path = parts
        kind = "v2" if ctrls == "" and parts[0] == "0" else "v1" if "memory" in ctrls.split(",") else None
        if kind is None:
            continue
        comps = _clean_path(path)
        if comps is None or kind in member:
            return None
        member[kind] = comps
    if not member:
        return "none"  # (no memory membership reported at all: no cgroup limit applies)
    mounts = _mounts(root)
    if mounts is None:
        return None
    best = "none"
    for kind, comps in member.items():
        mount = next((m for m in mounts if m[0] == kind), None)
        if mount is None:
            return None  # (membership reported, its hierarchy not mounted here: unknown)
        mroot = _clean_path(mount[1])
        if mroot is None or comps[:len(mroot)] != mroot:
            return None  # (the membership isn't under the mount's root: a namespace we can't see)
        rel = comps[len(mroot):]
        base = os.path.join(root, mount[2].lstrip("/"))
        limit_f, usage_f = ("memory.max", "memory.current") if kind == "v2" else ("memory.limit_in_bytes", "memory.usage_in_bytes")
        # (from the process's own cgroup up to the mount's root; the root itself has no limit file in v2)
        for depth in range(len(rel), -1, -1):
            d = os.path.join(base, *rel[:depth]) if depth else base
            if not os.path.isdir(d):
                return None
            if kind == "v2" and depth == 0:
                break
            if kind == "v2":
                # (the memory controller is on here only if the parent's subtree_control names it; then the files
                # must be there)
                parent = os.path.join(base, *rel[:depth - 1]) if depth > 1 else base
                ctl = _read_text(os.path.join(parent, "cgroup.subtree_control"))
                if ctl is None:
                    return None
                if "memory" not in ctl.split():
                    continue
            lim, use = _read_int(os.path.join(d, limit_f)), _read_int(os.path.join(d, usage_f))
            if lim is None or (lim != "max" and not isinstance(use, int)):
                return None
            # (v1's "no limit" is a huge number; anything at or past 2^62 is taken as none)
            if isinstance(lim, int) and lim < 2 ** 62:
                h = max(0, lim - use)
                best = h if best == "none" else min(best, h)
    return best


def _read_text(path):
    try:
        with open(path, encoding="ascii") as f:
            return f.read()
    except (OSError, UnicodeDecodeError):
        return None


def parse_vm_stat(out):
    """macOS's vm_stat output: free, inactive and speculative pages times the page size, or None."""
    m = re.search(r"page size of (\d+) bytes", out)
    if not m:
        return None
    page, total = int(m.group(1)), 0
    for k in ("Pages free", "Pages inactive", "Pages speculative"):
        mm = re.search(r"^%s:\s+(\d+)\.$" % k, out, re.M)
        if not mm:
            return None
        total += int(mm.group(1))
    return page * total


def _vm_stat():
    """macOS: vm_stat's figure, or None."""
    try:
        out = subprocess.run(["/usr/bin/vm_stat"], capture_output=True, text=True, timeout=2, env={"PATH": "/usr/bin:/bin"}).stdout
    except (OSError, subprocess.SubprocessError):
        return None
    return parse_vm_stat(out)


def read_memory(root="/", clock=time.monotonic, platform=None):
    """F now: a Reading, or None if it can't be read (refuses new starts)."""
    platform = platform or os.uname().sysname
    host = _meminfo(root) if platform == "Linux" else _vm_stat() if platform == "Darwin" else None
    if host is None:
        return None
    how = "MemAvailable" if platform == "Linux" else "vm_stat"
    cg = _cgroup_headroom(root) if platform == "Linux" else "none"
    if cg is None:
        return None
    if cg != "none" and cg < host:
        return Reading(cg, clock(), "cgroup headroom")
    return Reading(host, clock(), how)


# ---- the ledger

class Refused(Exception):
    """A new start (or buffer) refused, in words with the numbers."""


class Charge:
    """One admitted start or buffer: its bytes are pending until reconciled (a start) or freed (a buffer); an ended
    start's bytes stay pending until its tree is reaped."""

    def __init__(self, ledger, what, need):
        self.ledger, self.what, self.need = ledger, what, need
        self.pending = need
        self.started_at = None
        self.ended = False
        self.done = False

    def started(self):
        """The process tree exists from now: a reconciling reading must be taken after this."""
        self.started_at = self.ledger.clock()

    def ended_unreaped(self):
        """It stopped (or failed) and its tree isn't reaped yet: nothing is refunded until reaped()."""
        self.ended = True

    def reaped(self):
        """The tree is gone: whatever it still has pending is refunded."""
        self.ended = True
        self.ledger._refund(self)

    def free(self):
        """A buffer's bytes given back (a buffer has no process tree)."""
        self.ledger._refund(self)


class Ledger:
    def __init__(self, envelopes, reserve=DEFAULT_RESERVE, read=read_memory, clock=time.monotonic, tick=TICK_S):
        self.k = dict(envelopes)  # (K per entry: the measured startup envelope, bytes)
        self.reserve, self.read, self.clock, self.tick = reserve, read, clock, tick
        self.charges = []

    def pending(self):
        return sum(c.pending for c in self.charges)

    def admit(self, what, need=None):
        """A charge for `what` (an entry's start, K[entry], or a buffer of `need` bytes), or Refused."""
        if need is None:
            if what not in self.k:
                raise Refused("no measured startup envelope for %s on this host's version" % what)
            need = self.k[what]
        r = self.read()
        if r is None:
            raise Refused("This computer's free memory can't be read right now, so no new kernel starts. "
                          "Running kernels and reconnects aren't affected.")
        if self.clock() - r.at > self.tick:
            raise Refused("This computer's free-memory figure is stale, so no new kernel starts.")
        p = self.pending()
        room = r.available - self.reserve - p
        if room < need:
            raise Refused("Not enough free memory on this computer to start %s: it needs %s; %s is free (%s), "
                          "%s is kept for the system, and %s is held by kernels still starting."
                          % (what, fmt(need), fmt(r.available), r.how, fmt(self.reserve), fmt(p)))
        c = Charge(self, what, need)
        self.charges.append(c)
        return c

    def reconcile(self, c):
        """A started kernel is ready: its charge ends, if a fresh reading taken after its tree started now counts it.
        True if reconciled; False (the charge stays) if no such reading is available yet."""
        if c.done or c.ended or c.started_at is None:
            return False
        r = self.read()
        if r is None or r.at <= c.started_at or self.clock() - r.at > self.tick:
            return False
        c.pending = 0
        return True

    def _refund(self, c):
        c.pending = 0
        c.done = True
        if c in self.charges:
            self.charges.remove(c)


# ---- the idle stop

class IdleClock:
    """A kernel's quiescence: stopped by idle only when no page is attached and no cell runs, `limit` seconds after the
    last attach, cell start or end, or input (monotonic)."""

    def __init__(self, limit, clock=time.monotonic):
        self.limit, self.clock = limit, clock
        self.last = clock()
        self.attached = False
        self.running = 0

    def touch(self):
        self.last = self.clock()

    def attach(self):
        self.attached = True
        self.touch()

    def detach(self):
        self.attached = False
        self.touch()

    def cell_started(self):
        self.running += 1
        self.touch()

    def cell_ended(self):
        self.running = max(0, self.running - 1)
        self.touch()

    def idle_for(self):
        return self.clock() - self.last

    def due(self):
        return self.limit is not None and not self.attached and self.running == 0 and self.idle_for() >= self.limit
