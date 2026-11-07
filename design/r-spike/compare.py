"""Compare Rill with real R's recorded outputs (oracle.json), byte for byte.

usage:
  python3 compare.py py  LIBDIR oracle.json [ids...] > results.tsv    # in-process (CPython; development)
  python3 compare.py cli SAGEBRUSH oracle.json [ids...] > results.tsv # the sagebrush CLI, one process per case

Verdicts: EXACT (stdout identical and the error status agrees), ERRMSG (stdout identical,
both fail, the error text differs), DIFF (stdout differs), FAIL (our run crashed or errored where R did not).
"""
import io, json, os, subprocess, sys, tempfile


def run_py(libdir, code):
    sys.path.insert(0, libdir)
    import _rill
    import _rill_stats
    _rill.GLOBAL = None
    _rill_stats.RNG.mt = None
    _rill.WARNINGS[:] = []
    o, e = io.StringIO(), io.StringIO()
    so, se = sys.stdout, sys.stderr
    sys.stdout, sys.stderr = o, e
    try:
        rc = _rill.run(code)
    except BaseException as ex:  # a crash of the prototype
        rc = 99
        e.write("CRASH %s: %s\n" % (type(ex).__name__, ex))
    finally:
        sys.stdout, sys.stderr = so, se
    return o.getvalue(), e.getvalue(), rc


def run_cli(exe, code):
    with tempfile.NamedTemporaryFile("w", suffix=".R", delete=False) as f:
        f.write(code)
        path = f.name
    try:
        p = subprocess.run([exe, "--rill", path], capture_output=True, text=True, timeout=120)
        return p.stdout, p.stderr, p.returncode
    finally:
        os.unlink(path)


def first_err(s):
    for line in s.splitlines():
        if line.startswith("Error"):
            return line
    return ""


def main():
    mode, target, oracle = sys.argv[1:4]
    only = set(sys.argv[4:])
    cases = json.load(open(oracle))
    counts = {}
    rows = []
    for c in cases:
        if only and c["id"] not in only:
            continue
        if mode == "py":
            so, se, rc = run_py(target, c["code"])
        else:
            so, se, rc = run_cli(target, c["code"])
        if "CRASH" in se or "Traceback" in se:
            v = "FAIL"
        elif so == c["stdout"] and (rc != 0) == (c["rc"] != 0):
            v = "EXACT" if rc == 0 or first_err(se) == first_err(c["stderr"]) else "ERRMSG"
        elif so == c["stdout"]:
            v = "FAIL"
        else:
            v = "DIFF"
        counts[v] = counts.get(v, 0) + 1
        rows.append((v, c["id"], c["code"], c["stdout"] + c["stderr"], so + se))
    for r in rows:
        print("\t".join(json.dumps(x) if i >= 2 else x for i, x in enumerate(r)))
    sys.stderr.write("%d cases: %s\n" % (len(rows), ", ".join("%s %d" % kv for kv in sorted(counts.items()))))


if __name__ == "__main__":
    main()
