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
        # (the writer released however the test ended, so join finds it done)
        self.go.set()
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


def t1_paused(a, b, h, p, data, base, root, name, make_cleaner):
    """T1's checks while A is paused before its replace."""
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
        try:
            t1_paused(a, b, h, p, data, base, root, name, make_cleaner)
        finally:
            # (released and joined however the checks ended, astra2)
            p.go.set()
            t.join(60)
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
    assert not t.is_alive(), "T5: the sweeper never ended"
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


def admits_one_block(s, want, name):
    """Admission sees exactly want: a block fits under want plus a block, two don't."""
    blk = s.physical(1)
    s.cfg["SAGEBRUSH_RUNS_STORE_BYTES"] = want + blk
    try:
        s.admit(blk, "meta")
        try:
            s.admit(2 * blk, "meta")
            raise AssertionError(name + ": two blocks admitted")
        except R.StorageError:
            pass
    finally:
        s.cfg["SAGEBRUSH_RUNS_STORE_BYTES"] = 256 * R.MiB


def t9_links_charged_as_entries():
    """T9 (daybreak2 PR136-ACCOUNT-1): a symlink in the store is charged as
    the entry it is (lstat), never at its target's size: one to an outside
    file, one to an outside directory, and one aliasing a live
    reservation's temporary (which is itself not charged)."""
    root = fresh_root()
    a, s = store(root), store(root)
    h, h2 = run_dir(s), run_dir(s)
    out = tempfile.mkdtemp(prefix="sb-out-")
    big_file = os.path.join(out, "big")
    open(big_file, "wb").write(b"b" * (2 * R.MiB))
    os.mkdir(os.path.join(out, "dir"))
    open(os.path.join(out, "dir", "inside"), "wb").write(b"i" * (2 * R.MiB))
    base = s.walk_total()
    target = os.path.join(s.run_dir(h), "value.json")
    temp = target + "." + "b" * 12 + ".tmp"
    rp = a.reserve(h, target, s.physical(3000), temp)  # (a's: live)
    open(temp, "wb").write(b"t" * 3000)
    links = [os.path.join(s.run_dir(h2), n) for n in ("to-file", "to-dir", "alias")]
    os.symlink(big_file, links[0])
    os.symlink(os.path.join(out, "dir"), links[1])
    os.symlink(temp, links[2])
    want = base + s.physical(3000) + R._charge(rp) + sum(R._charge(l) for l in links)
    s.cleanup()
    assert os.path.exists(temp) and all(os.path.islink(l) for l in links), "T9: a file was removed"
    got = s.walk_total()
    assert got == want, ("T9: links charged at their targets", got, want)
    assert s.used() == want, (s.used(), want)
    admits_one_block(s, want, "T9")
    print("T9: ok")


def swap_for_link(s, h, files):
    """h's run directory replaced by a symlink to an outside directory
    holding files ({name: bytes}); returns (that directory, the link)."""
    d = s.run_dir(h)
    for n in os.listdir(d):
        os.unlink(os.path.join(d, n))
    os.rmdir(d)
    out = tempfile.mkdtemp(prefix="sb-out-")
    for n, data in files.items():
        open(os.path.join(out, n), "wb").write(data)
    os.symlink(out, d)
    return out, d


def cleanup_then(s, out, files, name):
    """s.cleanup(), then: every file outside the store as it was, and only
    then any error the cleanup raised (it is a failure too)."""
    err = None
    try:
        s.cleanup()
    except Exception as e:
        err = e
    lost = sorted(n for n, data in files.items() if not (os.path.exists(os.path.join(out, n)) and open(os.path.join(out, n), "rb").read() == data))
    assert not lost, "%s: outside the store, removed or changed: %s" % (name, " ".join(lost))
    assert err is None, (name, err)


def t10a_linked_recovery():
    """T10a (daybreak2 PR136-RECOVERY-1): a run directory that is a symlink
    to outside the store, and a dead owner's reservation whose lexical paths
    are in the store: invalid, kept, charged at its record and bytes; the
    outside value, temporary and orphan-shaped temporary all survive
    cleanup."""
    root = fresh_root()
    s = store(root)
    h = run_dir(s)
    tmpname = "value.json." + "c" * 12 + ".tmp"
    files = {"value.json": b"V" * 1000, tmpname: b"T" * 1000, "run.json." + "d" * 12 + ".tmp": b"O" * 10,
             "run.json": json.dumps({"handle": h, "state": "running", "started_at": time.time()}).encode()}
    out, link = swap_for_link(s, h, files)
    base = s.walk_total()
    dead = {"pid": dead_pid(), "nonce": "r" * 32, "host": R._HOST}
    rp = write_record(root, "%s-00000011.json" % h, {"bytes": 4096, "target": os.path.join(link, "value.json"), "temp": os.path.join(link, tmpname), "owner": dead})
    cleanup_then(s, out, files, "T10a")
    assert os.path.exists(rp), "T10a: the record was recovered"
    assert s._reservation_kind(os.path.basename(rp), json.load(open(rp))) == "invalid", "T10a: a linked run directory's record is valid"
    want = base + R._charge(rp) + 4096
    assert s.used() == s.walk_total() == want, ("T10a", s.used(), s.walk_total(), want)
    admits_one_block(s, want, "T10a")
    print("T10a: ok")


def t10b_linked_release():
    """T10b: the writer's own release, after its run directory became a link."""
    s = store(fresh_root())
    h2 = run_dir(s)
    t2 = os.path.join(s.run_dir(h2), "value.json")
    tmp2 = t2 + "." + "e" * 12 + ".tmp"
    rp2 = s.reserve(h2, t2, s.physical(10), tmp2)
    files2 = {"value.json": b"W" * 10, os.path.basename(tmp2): b"X" * 10}
    out2, _ = swap_for_link(s, h2, files2)
    s.release(rp2)
    assert not os.path.exists(rp2), "T10b: the reservation stayed"
    for n, data in files2.items():
        assert open(os.path.join(out2, n), "rb").read() == data, "T10b: release unlinked %s outside the store" % n
    print("T10b: ok")


def t10c_linked_remove():
    """T10c: an expired finished run, its directory a link."""
    root3 = fresh_root()
    s3 = store(root3)
    h3 = run_dir(s3)
    files3 = {"run.json": json.dumps({"handle": h3, "state": "finished", "ended_at": time.time() - 400 * 86400}).encode(), "output.txt": b"P" * 100}
    out3, _ = swap_for_link(s3, h3, files3)
    cleanup_then(s3, out3, files3, "T10c")
    print("T10c: ok")


def t11_reservations_dir_files():
    """T11 (astra2 RESOURCE-PR136-1): a file in reservations/ that is not a
    record (notours.tmp, not of _write_atomic's form) is kept by cleanup and
    charged at its physical size."""
    root = fresh_root()
    s = store(root)
    base = s.walk_total()
    f = os.path.join(root, "reservations", "notours.tmp")
    open(f, "wb").write(b"n" * 8192)
    s.cleanup()
    assert os.path.exists(f), "T11: kept file removed"
    want = base + R._charge(f)
    assert R._charge(f) >= 8192
    assert s.used() == s.walk_total() == want, ("T11: uncharged", s.used(), s.walk_total(), want)
    admits_one_block(s, want, "T11")
    print("T11: ok")


def t12a_reservations_subdir():
    """T12a: a subdirectory in reservations/: its files charged, nothing raised."""
    root = fresh_root()
    s = store(root)
    base = s.walk_total()
    sub = os.path.join(root, "reservations", "sub")
    os.mkdir(sub)
    open(os.path.join(sub, "f"), "wb").write(b"s" * 4096)
    s.cleanup()
    assert os.path.exists(os.path.join(sub, "f")), "T12a: kept entries removed"
    want = base + R._charge(os.path.join(sub, "f"))
    assert s.used() == s.walk_total() == want, ("T12a", s.used(), s.walk_total(), want)
    admits_one_block(s, want, "T12a")
    print("T12a: ok")


def t12b_reservations_link():
    """T12b: a link in reservations/ named like a record, to an outside
    record that would be valid with a dead owner: unreadable, never
    recovered (the run's value survives), charged as the link."""
    root = fresh_root()
    s = store(root)
    h = run_dir(s)
    target = os.path.join(s.run_dir(h), "value.json")
    open(target, "wb").write(b"K" * 100)
    s.cleanup()
    base = s.walk_total()
    out = tempfile.mkdtemp(prefix="sb-out-")
    rec = os.path.join(out, "rec.json")
    with open(rec, "w") as f:
        json.dump({"bytes": 0, "target": target, "temp": target + "." + "f" * 12 + ".tmp", "owner": {"pid": dead_pid(), "nonce": "s" * 32, "host": R._HOST}}, f)
    link = os.path.join(root, "reservations", "%s-00000012.json" % h)
    os.symlink(rec, link)
    s.cleanup()
    assert os.path.exists(target) and open(target, "rb").read() == b"K" * 100, "T12b: a linked record was recovered"
    assert os.path.islink(link), "T12b: the link was removed"
    want = base + R._charge(link)
    assert s.used() == s.walk_total() == want, ("T12b", s.used(), s.walk_total(), want)
    admits_one_block(s, want, "T12b")
    print("T12b: ok")


if __name__ == "__main__":
    t1_two_stores()
    t2_process()
    t3_orphans_and_recovery()
    t4_kept()
    t5_gone_under_lock()
    t7_one_per_target()
    t8_invalid()
    t9_links_charged_as_entries()
    t10a_linked_recovery()
    t10b_linked_release()
    t10c_linked_remove()
    t11_reservations_dir_files()
    t12a_reservations_subdir()
    t12b_reservations_link()
    print("test_runs_sweep: ok")
