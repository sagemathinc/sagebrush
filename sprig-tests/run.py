"""Sprig's corpus of recorded Mathics3 outputs (design/sprig-mvp.md §7).

    python3 sprig-tests/run.py --verify              # provenance complete, every output's hash recorded
    python3 sprig-tests/run.py --regen [FILE ...]    # re-record from the oracle, files given or all
    python3 sprig-tests/run.py --regen --all         # an oracle bump: re-record everything
    python3 sprig-tests/run.py --freeze PHASE        # freeze heldout/PHASE (once, before the phase's code)

A case file is sprig-tests/<area>/test_<n>.sprig: cases separated by lines
"(*-- <id> *)" (lines before the first are comments). Its outputs are
test_<n>.out.json, written only by --regen from the oracle: each case's
result (InputForm), FullForm, printed output and messages, from a fresh
Mathics3 session (oracle.py). sprig-tests/PROVENANCE.json records the oracle's
environment, as printed by the oracle itself, and the sha256 of every case
file and output.

The oracle is run by hand, never in CI: SPRIG_ORACLE names its `mathics`
program (default: the project's black-box install). It is a black box: only
its printed output is used.

Held-out files (sprig-tests/heldout/<phase>/) are frozen by their SHA256SUMS
once committed: --regen refuses to touch a frozen held-out file (a needed fix
becomes a new visible case, design/sprig-mvp.md §7.4).

An oracle bump (a new Mathics3 version) re-records everything with --all, in
one PR that shows the diff and updates KNOWN.json; --regen of some files
refuses if the oracle's environment record no longer matches the one in
PROVENANCE.json.
"""
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
PROV = os.path.join(HERE, "PROVENANCE.json")
MATHICS = os.environ.get("SPRIG_ORACLE", "/scratch/matlab-tmp/mathics/venv/bin/mathics")
RECORD_KEYS = ["version", "versions", "orderless", "limits"]
SEPARATOR = re.compile(r"^\(\*-- (\S+) \*\)\s*$")


def sha256(path):
    return hashlib.sha256(open(path, "rb").read()).hexdigest()


def rel(path):
    return os.path.relpath(os.path.abspath(path), ROOT).replace(os.sep, "/")


def case_files():
    out = []
    for d, _, fs in os.walk(HERE):
        for f in fs:
            if f.startswith("test_") and f.endswith(".sprig"):
                out.append(os.path.join(d, f))
    return sorted(out)


def parse_cases(path):
    """[(id, code)] of a case file; ids are unique in the file."""
    cases, cur, cid = [], [], None
    for line in open(path, encoding="utf-8"):
        m = SEPARATOR.match(line)
        if m:
            if cid is not None:
                cases.append((cid, "".join(cur)))
            cid, cur = m.group(1), []
        elif line.startswith("(*--"):
            raise SystemExit("%s: a malformed case separator: %r" % (rel(path), line))
        elif cid is not None:
            cur.append(line)
    if cid is not None:
        cases.append((cid, "".join(cur)))
    ids = [c[0] for c in cases]
    if len(set(ids)) != len(ids):
        raise SystemExit("%s: repeated case ids" % rel(path))
    if not cases:
        raise SystemExit("%s: no cases" % rel(path))
    for cid, code in cases:
        if not code.strip():
            raise SystemExit("%s: case %s is empty" % (rel(path), cid))
    return cases


def out_path(path):
    return path[:-len(".sprig")] + ".out.json"


def heldout_dir(path):
    r = rel(path).split("/")
    return os.path.join(ROOT, *r[:3]) if len(r) > 3 and r[1] == "heldout" else None


def frozen(path):
    """Whether a held-out file is frozen (its directory's SHA256SUMS exists and lists it)."""
    d = heldout_dir(path)
    if d is None or not os.path.exists(os.path.join(d, "SHA256SUMS")):
        return False
    names = [l.split()[-1] for l in open(os.path.join(d, "SHA256SUMS"), encoding="utf-8") if l.strip()]
    return os.path.basename(path) in names


def load_prov():
    if os.path.exists(PROV):
        return json.load(open(PROV, encoding="utf-8"))
    return {"format": "sprig-provenance", "v": 1, "oracle": None, "files": {}}


def write_json(path, obj):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=1, sort_keys=True)
        f.write("\n")


def regen(paths, everything):
    prov = load_prov()
    if everything or not paths:
        paths = case_files()
    paths = [os.path.abspath(p) for p in paths]
    for p in paths:
        if frozen(p):
            raise SystemExit("%s is a frozen held-out file: add a new visible case instead (design/sprig-mvp.md §7.4)" % rel(p))
    cases = [{"file": rel(p), "id": cid, "code": code} for p in paths for cid, code in parse_cases(p)]
    with tempfile.TemporaryDirectory() as d:
        cj = os.path.join(d, "cases.json")
        write_json(cj, cases)
        p = subprocess.run([sys.executable, os.path.join(HERE, "oracle.py"), MATHICS, cj], capture_output=True, text=True)
        if p.returncode:
            raise SystemExit("the oracle failed:\n%s" % p.stderr[-3000:])
        got = json.loads(p.stdout)
    results, record = got["results"], got["record"]
    if len(results) != len(cases):
        raise SystemExit("oracle returned %d results for %d cases" % (len(results), len(cases)))
    missing = [k for k in RECORD_KEYS if not record.get(k)]
    if missing:
        raise SystemExit("the oracle's environment record lacks %s" % missing)
    if prov["oracle"] and prov["oracle"]["record"] != record and not everything:
        raise SystemExit("the oracle's environment changed (an oracle bump): re-record everything with --regen --all")
    by_file = {}
    for r in results:
        by_file.setdefault(r["file"], []).append({k: r[k] for k in ("id", "result", "fullform", "output", "messages")})
    if everything:
        prov["files"] = {}
    # (entries for case files that no longer exist are dropped: a renamed or removed file)
    prov["files"] = {f: e for f, e in prov["files"].items() if os.path.exists(os.path.join(ROOT, f))}
    for p in paths:
        f = rel(p)
        write_json(out_path(p), {"format": "sprig-out", "v": 1, "file": f, "cases": by_file[f]})
        prov["files"][f] = {"sprig_sha256": sha256(p), "out_sha256": sha256(out_path(p)), "cases": len(by_file[f])}
    prov["oracle"] = {"program": "Mathics3, run as a black box (oracle.py)", "record": record,
                      "oracle_py_sha256": sha256(os.path.join(HERE, "oracle.py")),
                      "run_py_sha256": sha256(os.path.abspath(__file__))}
    write_json(PROV, prov)
    print("recorded %d cases in %d files" % (len(results), len(paths)))


def verify():
    """The same checks as test/sprig-provenance.test.ts, for local use."""
    prov = load_prov()
    problems = []
    if not prov.get("oracle") or any(not prov["oracle"].get("record", {}).get(k) for k in RECORD_KEYS):
        problems.append("PROVENANCE.json: the oracle's environment record is missing or incomplete")
    files = {rel(p) for p in case_files()}
    for f in sorted(files | set(prov["files"])):
        p = os.path.join(ROOT, f)
        e = prov["files"].get(f)
        if e is None:
            problems.append("%s: not in PROVENANCE.json (record it with --regen)" % f)
            continue
        if f not in files:
            problems.append("%s: in PROVENANCE.json but missing" % f)
            continue
        if not os.path.exists(out_path(p)):
            problems.append("%s: no recorded output" % f)
            continue
        if sha256(p) != e["sprig_sha256"]:
            problems.append("%s: changed since it was recorded (re-record it with --regen)" % f)
        if sha256(out_path(p)) != e["out_sha256"]:
            problems.append("%s: its output differs from the recorded hash (outputs come only from --regen)" % rel(out_path(p)))
        ids = [c[0] for c in parse_cases(p)]
        got = [c["id"] for c in json.load(open(out_path(p), encoding="utf-8"))["cases"]]
        if ids != got:
            problems.append("%s: case ids differ from its output's" % f)
    ignored = subprocess.run(["git", "-C", ROOT, "check-ignore", "--stdin"], input="\n".join(rel(p) for p in case_files()),
                             capture_output=True, text=True).stdout.split()
    for f in ignored:
        problems.append("%s: ignored by .gitignore, so it would not be committed (rename its directory)" % f)
    named = [f for f in prov["files"]] + [f[:-len(".sprig")] + ".out.json" for f in prov["files"]]
    tracked = set(subprocess.run(["git", "-C", ROOT, "ls-files", "--", "sprig-tests"], capture_output=True, text=True).stdout.split())
    for f in named:
        if f not in tracked:
            problems.append("%s: not tracked by git (git add it; check .gitignore)" % f)
    for p in case_files():
        d = heldout_dir(p)
        if d and os.path.exists(os.path.join(d, "SHA256SUMS")):
            for line in open(os.path.join(d, "SHA256SUMS"), encoding="utf-8"):
                if line.strip():
                    h, name = line.split()
                    q = os.path.join(d, name)
                    if not os.path.exists(q) or sha256(q) != h:
                        problems.append("%s: does not match its frozen SHA256SUMS" % rel(q))
    for x in sorted(set(problems)):
        print(x)
    print("%d case files, %d problems" % (len(files), len(set(problems))))
    return 1 if problems else 0


def freeze(phase):
    """Write heldout/<phase>/SHA256SUMS over its case files and outputs (once, before the phase's code)."""
    d = os.path.join(HERE, "heldout", phase)
    names = sorted(f for f in os.listdir(d) if f.startswith("test_") and (f.endswith(".sprig") or f.endswith(".out.json")))
    if os.path.exists(os.path.join(d, "SHA256SUMS")):
        raise SystemExit("heldout/%s is already frozen" % phase)
    with open(os.path.join(d, "SHA256SUMS"), "w", encoding="utf-8") as f:
        for n in names:
            f.write("%s  %s\n" % (sha256(os.path.join(d, n)), n))
    print("froze heldout/%s: %d files" % (phase, len(names)))


if __name__ == "__main__":
    a = sys.argv[1:]
    if a[:1] == ["--verify"]:
        sys.exit(verify())
    if a[:1] == ["--regen"]:
        regen([x for x in a[1:] if x != "--all"], "--all" in a)
        sys.exit(0)
    if a[:1] == ["--freeze"] and len(a) == 2:
        freeze(a[1])
        sys.exit(0)
    sys.exit(__doc__)
