"""The run store's temporary sweep (plan-runs-tmp-sweep r4): a cleanup keeps a
live value write's temporary, named by its reservation, however old, also
from another Store or another process sharing the root; a reserved write is
charged once; a dead owner's reservation is recovered, an invalid one never
used as a path; one reservation per target.

    python engine/py/test_runs_sweep.py

(SAGEBRUSH_RUNS_MODULE=<path to runs.py>: that file instead of the installed
sagebrush.runs, for the mutation checks.)
"""
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import threading
import time

if os.environ.get("SAGEBRUSH_RUNS_MODULE"):
    _spec = importlib.util.spec_from_file_location("sagebrush_runs_under_test", os.environ["SAGEBRUSH_RUNS_MODULE"])
    R = importlib.util.module_from_spec(_spec)
    _spec.loader.exec_module(R)
else:
    from sagebrush import runs as R

HOUR = 3600


def fresh_root():
    return tempfile.mkdtemp(prefix="sb-sweep-")


def store(root, owner=None):
    s = R.Store(root=root, env={"SAGEBRUSH_RUNS_STORE_BYTES": str(256 * R.MiB)}, owner=owner)
    s._free = lambda: (10 ** 15, 10 ** 15)
    s.reserve_floor = lambda: R.GiB
    return s


def run_dir(s):
    h = s.new_handle()
    s.save({"handle": h, "state": "running", "started_at": time.time()})
    return h


class Paused:
    """os.replace held for the value write's temporary only: entered (the
    temporary written and closed), then released."""

    def __init__(self):
        self.real = os.replace
        self.entered, self.go = threading.Event(), threading.Event()
        self.src = None

    def __enter__(self):
        def replace(src, dst, *a, **k):
            if str(dst).endswith("value.json") and str(src).endswith(".tmp"):
                self.src = src
                self.entered.set()
                assert self.go.wait(60), "never released"
            return self.real(src, dst, *a, **k)
        os.replace = replace
        return self

    def __exit__(self, *a):
        os.replace = self.real


def writer(a, h, data, result):
    try:
        result["ret"] = a.write_value(h, data)
    except BaseException as e:  # (propagated by the caller)
        result["error"] = e


def join(t, result):
    t.join(60)
    assert not t.is_alive(), "the writer never finished"
    if "error" in result:
        raise result["error"]


def t1_two_stores(make_cleaner=None, name="T1"):
    """T1 (and T2 with a process as the cleaner): A writes a value, paused
    before its replace; its temporary made an hour old; B cleans; A
    resumes.  The value is written, and charged once throughout."""
    root = fresh_root()
    a, b = store(root), store(root)
    h = run_dir(a)
    data = b"v" * 5000
    base = a.walk_total()
    result = {}
    with Paused() as p:
        t = threading.Thread(target=writer, args=(a, h, data, result))
        t.start()
        assert p.entered.wait(30), "the write never reached its replace"
        old = time.time() - HOUR
        os.utime(p.src, (old, old))
        # T6: another temporary of the same target, another token, old: an orphan
        other = os.path.join(a.run_dir(h), "value.json.%s.tmp" % ("f" * 12))
        open(other, "wb").write(b"x" * 100)
        os.utime(other, (old, old))
        res = [os.path.join(root, "reservations", n) for n in os.listdir(os.path.join(root, "reservations"))]
        assert len(res) == 1, res
        rec_charge = R._charge(res[0])
        (make_cleaner or (lambda: b.cleanup()))()
        assert os.path.exists(p.src), name + ": the live temporary was swept"
        assert not os.path.exists(other), name + ": T6, the unrecorded temporary of a reserved target was kept"
        # (while A is paused, after B's cleanup: one charge, at the declared bytes)
        want = base + a.physical(len(data)) + rec_charge
        assert a.used() == b.used() == b.walk_total() == want, (name, a.used(), b.used(), b.walk_total(), want)
        # (admission sees that one charge: a block fits under a budget of it plus a block)
        blk = b.physical(1)
        b.cfg["SAGEBRUSH_RUNS_STORE_BYTES"] = want + blk
        b.admit(blk, "meta")
        try:
            b.admit(2 * blk, "meta")
            raise AssertionError(name + ": two blocks admitted")
        except R.StorageError:
            pass
        b.cfg["SAGEBRUSH_RUNS_STORE_BYTES"] = 256 * R.MiB
        p.go.set()
        join(t, result)
    path, why = result["ret"]
    assert why is None and path, (name, why)
    assert open(path, "rb").read() == data
    assert a.load(h)["state"] == "running", name + ": the run's record changed"
    assert not os.listdir(os.path.join(root, "reservations")), name
    assert a.used() == b.used() == a.walk_total() == base + R._charge(path), (name, a.used(), a.walk_total(), base)
    print(name + ": ok")


def t2_process():
    """T2: the cleaner is another process, opening a Store on the same root
    (its constructor cleans, under the flock)."""
    mod = os.environ.get("SAGEBRUSH_RUNS_MODULE")
    holder = {}

    def clean():
        root = holder["root"]
        code = (
            "import importlib.util, sys, os\n"
            "m = sys.argv[1]\n"
            "if m:\n"
            "    s = importlib.util.spec_from_file_location('r', m); R = importlib.util.module_from_spec(s); s.loader.exec_module(R)\n"
            "else:\n"
            "    from sagebrush import runs as R\n"
            "st = R.Store(root=sys.argv[2], env={'SAGEBRUSH_RUNS_STORE_BYTES': str(256 * R.MiB)})\n"
            "st._free = lambda: (10 ** 15, 10 ** 15)\n"
            "st.cleanup()\n"
            "print('cleaned')\n"
        )
        out = subprocess.run([sys.executable, "-c", code, mod or "", root], capture_output=True, text=True, timeout=120)
        assert out.returncode == 0 and "cleaned" in out.stdout, out.stderr[-500:]

    # (the root is made inside t1_two_stores: catch it through tempfile)
    real_mkdtemp = tempfile.mkdtemp

    def mk(*a, **k):
        d = real_mkdtemp(*a, **k)
        holder["root"] = d
        return d
    tempfile.mkdtemp = mk
    try:
        t1_two_stores(make_cleaner=clean, name="T2 (a cleaner in another process)")
    finally:
        tempfile.mkdtemp = real_mkdtemp


def dead_pid():
    p = subprocess.Popen([sys.executable, "-c", "pass"])
    p.wait()
    return p.pid


def t3_orphans_and_recovery():
    root = fresh_root()
    s = store(root)
    h = run_dir(s)
    d = s.run_dir(h)
    # (a) temporaries no reservation names: removed, fresh or old; a name not
    # of _write_atomic's form left alone
    orphans = [os.path.join(d, "run.json.%s.tmp" % ("a" * 12)), os.path.join(root, "gone", "x.json.%s.tmp" % ("b" * 12)),
               os.path.join(d, "value.json.%s.tmp" % ("c" * 12))]
    for f in orphans:
        open(f, "wb").write(b"o")
    old = time.time() - HOUR
    os.utime(orphans[0], (old, old))
    keep = os.path.join(d, "notours.tmp")
    open(keep, "wb").write(b"k")
    s.cleanup()
    assert not any(os.path.exists(f) for f in orphans) and os.path.exists(keep)
    os.unlink(keep)
    s.cleanup()  # (the total again, without the file this test made)
    # (b) a dead owner's reservation, valid: recovered, its temporary and target with it
    base = s.walk_total()
    assert s.used() == base
    dead = store(root, owner={"pid": dead_pid(), "nonce": "d" * 32})
    target = os.path.join(d, "value.json")
    temp = target + "." + "e" * 12 + ".tmp"
    rp = dead.reserve(h, target, s.physical(3000), temp)
    open(temp, "wb").write(b"t" * 3000)
    open(target, "wb").write(b"T" * 3000)
    assert s.walk_total() == base + s.physical(3000) + R._charge(rp)
    s.cleanup()
    assert not os.path.exists(rp) and not os.path.exists(temp) and not os.path.exists(target), "T3b: not recovered"
    assert s.used() == s.walk_total() == base, (s.used(), s.walk_total(), base)
    print("T3: ok")


def write_record(root, name, rec):
    p = os.path.join(root, "reservations", name)
    with open(p, "w") as f:
        json.dump(rec, f)
    return p


def t4_kept():
    """T4: another host's reservation, and a legacy one (no temp, no host),
    are kept, their temporaries too, charged once."""
    root = fresh_root()
    s = store(root)
    h1, h2 = run_dir(s), run_dir(s)
    base = s.walk_total()
    t1 = os.path.join(s.run_dir(h1), "value.json")
    tmp1 = t1 + "." + "1" * 12 + ".tmp"
    open(tmp1, "wb").write(b"x" * 2000)
    r1 = write_record(root, h1 + "-00000001.json", {"bytes": 4096, "target": t1, "temp": tmp1, "owner": {"pid": 1, "nonce": "n" * 32, "host": "elsewhere"}})
    t2 = os.path.join(s.run_dir(h2), "value.json")
    tmp2 = t2 + "." + "2" * 12 + ".tmp"
    open(tmp2, "wb").write(b"y" * 2000)
    r2 = write_record(root, h2 + "-00000002.json", {"bytes": 4096, "target": t2, "owner": {"pid": dead_pid(), "nonce": "o" * 32}})
    s.cleanup()
    assert all(os.path.exists(f) for f in (r1, r2, tmp1, tmp2)), "T4: kept files removed"
    want = base + 2 * 4096 + R._charge(r1) + R._charge(r2)
    assert s.used() == s.walk_total() == want, (s.used(), s.walk_total(), want)
    print("T4: ok")


def t5_gone_under_lock():
    """T5: test_runs' gone case, as the runner's cleanup races it: a run
    removed under the lock always leaves its tombstone."""
    root = fresh_root()
    s = store(root)
    other = store(root)
    stop = threading.Event()
    errors = []

    def sweeper():
        try:
            while not stop.is_set():
                other.cleanup()
        except BaseException as e:
            errors.append(e)
    t = threading.Thread(target=sweeper)
    t.start()
    try:
        for _ in range(200):
            h = s.new_handle()
            rec = {"handle": h, "state": "finished", "ended_at": time.time()}
            s.save(rec)
            with s.lock:
                s._remove(rec, "count", time.time())
            got = s.load(h)
            assert got is not None and got.get("state") == "gone", got
    finally:
        stop.set()
        t.join(60)
    assert not errors, errors
    print("T5: ok")


def t7_one_per_target():
    root = fresh_root()
    a, b = store(root), store(root)
    h = run_dir(a)
    target = os.path.join(a.run_dir(h), "value.json")
    p = a.reserve(h, target, a.physical(10), target + "." + "3" * 12 + ".tmp")
    for who in (a, b):
        try:
            who.reserve(h, target, who.physical(10), target + "." + "4" * 12 + ".tmp")
            raise AssertionError("T7: a second reservation of one target admitted")
        except R.StorageError as e:
            assert "already being written" in str(e), e
    path, why = b.write_value(h, b"z")
    assert path is None and "already being written" in why, why
    a.release(p)
    path, why = a.write_value(h, b"after")
    assert why is None and open(path, "rb").read() == b"after"
    assert a.used() == a.walk_total()
    print("T7: ok")


def t8_invalid():
    """T8: invalid records, their owners dead: kept, never used as paths,
    charged at their record plus non-negative int bytes only."""
    root = fresh_root()
    s = store(root)
    h, h2 = run_dir(s), run_dir(s)
    base = s.walk_total()
    dead = {"pid": dead_pid(), "nonce": "q" * 32, "host": R._HOST}
    tgt = os.path.join(s.run_dir(h), "value.json")
    decoy_out = os.path.join(tempfile.mkdtemp(prefix="sb-decoy-"), "value.json")
    decoy_other = os.path.join(s.run_dir(h2), "value.json")
    for f in (decoy_out, decoy_other):
        open(f, "wb").write(b"keep me")
    base = s.walk_total()  # (decoy_other is inside the store: charged)
    recs = [
        ("%s-0000000a.json" % h, {"bytes": -1000000, "target": tgt, "temp": tgt + "." + "5" * 12 + ".tmp", "owner": dead}, 0),
        ("%s-0000000b.json" % h, {"bytes": "x", "target": tgt, "temp": tgt + "." + "6" * 12 + ".tmp", "owner": dead}, 0),
        ("%s-0000000c.json" % h, {"bytes": True, "target": tgt, "temp": tgt + "." + "7" * 12 + ".tmp", "owner": dead}, 0),
        ("%s-0000000d.json" % h, {"bytes": 4096, "target": decoy_out, "temp": decoy_out + "." + "8" * 12 + ".tmp", "owner": dead}, 4096),
        ("%s-0000000e.json" % h, {"bytes": 0, "target": decoy_other, "temp": decoy_other + "." + "9" * 12 + ".tmp", "owner": dead}, 0),
        ("%s-0000000f.json" % h, {"bytes": 0, "target": tgt, "temp": tgt + ".bad.tmp", "owner": dead}, 0),
        ("%s-00000010.json" % h2, {"bytes": 0, "target": tgt, "temp": tgt + "." + "a" * 12 + ".tmp", "owner": dead}, 0),
    ]
    paths = [write_record(root, n, r) for n, r, _ in recs]
    s.cleanup()
    assert all(os.path.exists(p) for p in paths), "T8: an invalid record was recovered"
    assert all(open(f, "rb").read() == b"keep me" for f in (decoy_out, decoy_other)), "T8: a decoy was unlinked"
    want = base + sum(R._charge(p) for p in paths) + sum(c for _, _, c in recs)
    assert s.used() == s.walk_total() == want, (s.used(), s.walk_total(), want)
    blk = s.physical(1)
    s.cfg["SAGEBRUSH_RUNS_STORE_BYTES"] = want + blk
    s.admit(blk, "meta")
    try:
        s.admit(2 * blk, "meta")
        raise AssertionError("T8: two blocks admitted")
    except R.StorageError:
        pass
    print("T8: ok")


if __name__ == "__main__":
    t1_two_stores()
    t2_process()
    t3_orphans_and_recovery()
    t4_kept()
    t5_gone_under_lock()
    t7_one_per_target()
    t8_invalid()
    print("test_runs_sweep: ok")
