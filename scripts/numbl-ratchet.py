#!/usr/bin/env python3
"""The Numbl corpus ratchet (upstream/numbl/README.md): run every vendored numbl test script through Sagebrush's
MATLAB mode and compare with the expected-pass list.

  python3 scripts/numbl-ratchet.py [--cli build/cli/pyjs.cjs] [--jobs N] [--timeout S] [--results OUT.jsonl] [--write-expected]

CI runs it on the full tier only (master pushes, the nightly schedule, a dispatch): scripts/test-numbl-corpus.mjs,
`// ci: web-runner-sync`. test/numbl-ratchet.test.ts (every pull request's node tests) keeps it there and runs
scripts/test-numbl-ratchet.py.

Red (exit 1) when:
  - the scripts found by numbl's own discovery rule differ from upstream/numbl/scripts.txt (a script lost or added);
  - a script of scripts.txt got no result (one dropped from the run);
  - expected-pass.txt names a script that isn't in scripts.txt, or one twice (names match exactly, never by prefix);
  - not-matlab.txt names a script that isn't in scripts.txt, or one twice, or one that expected-pass.txt pins;
  - a script of expected-pass.txt didn't pass (a regression).
A script that passes but isn't in expected-pass.txt is reported (a new pass, to add); that alone stays green. The
scripts of not-matlab.txt (not valid MATLAB, or asserting against MATLAB's documentation; upstream/numbl/README.md)
still run, but are never pinned: never a NEW PASS, and never written by --write-expected.
--write-expected rewrites expected-pass.txt from this run (after a reviewed fix, never to hide a regression).

A script passes when the CLI exits 0 and the script's last non-empty output line is exactly SUCCESS (numbl's rule,
its src/cli-run-tests.ts, where an error fails the script whatever it printed), after the CLI's own figure epilogue
is set aside: lines the CLI prints after a script ends for each open figure
("Plot: ...", "Figure with N plots: ...", "Saved .../sagebrush-figures-...", "(figures are removed ...)").
Each script runs with its directory as the current directory (its search path), in a copy of the corpus, with a
throwaway TMPDIR and HOME and a 60 s timeout (a timeout fails, whatever was printed before it); scripts of one
directory run one at a time.
"""
import argparse, json, os, re, shutil, subprocess, sys, tempfile, time
from concurrent.futures import ThreadPoolExecutor
from collections import defaultdict

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
CORPUS = os.path.join(ROOT, "upstream", "numbl")
SCRIPTS_DIR = os.path.join(CORPUS, "numbl_test_scripts")
MANIFEST = os.path.join(CORPUS, "scripts.txt")
EXPECTED = os.path.join(CORPUS, "expected-pass.txt")
NOT_MATLAB = os.path.join(CORPUS, "not-matlab.txt")
TIMEOUT = 60
EPILOGUE = re.compile(r"^(Plot: |Figure with \d+ plots?: |Saved .*sagebrush-figures-|\(figures are removed when sagebrush exits)")


def discover(scripts_dir):
    """numbl's rule (its src/cli-scan.ts findTestScripts): a .m file whose text contains SUCCESS, outside @class/,
    +package/ and wasm/ directories. Paths relative to scripts_dir, with / separators, sorted."""
    found = []
    for cur, dirs, files in os.walk(scripts_dir):
        dirs[:] = sorted(d for d in dirs if not d.startswith("@") and not d.startswith("+") and d != "wasm")
        for f in sorted(files):
            if f.endswith(".m"):
                p = os.path.join(cur, f)
                with open(p, encoding="utf-8", errors="replace") as fh:
                    if "SUCCESS" in fh.read():
                        found.append(os.path.relpath(p, scripts_dir).replace(os.sep, "/"))
    return sorted(found)


def passed(stdout):
    """The pass rule: the last non-empty line, after the CLI's figure epilogue, is exactly SUCCESS."""
    lines = [l.strip() for l in stdout.splitlines() if l.strip() and not EPILOGUE.match(l.strip())]
    return bool(lines) and lines[-1] == "SUCCESS"


def read_list(path):
    with open(path, encoding="utf-8") as f:
        return [l.strip() for l in f if l.strip() and not l.startswith("#")]


def judge(manifest, expected, discovered, results, not_matlab=()):
    """The verdict, pure: (errors, new_passes). results maps script -> passed (bool) for every script that ran."""
    errors = []
    m, e, d = set(manifest), set(expected), set(discovered)
    if len(m) != len(manifest):
        errors.append("scripts.txt lists a script twice")
    if len(e) != len(expected):
        errors.append("expected-pass.txt lists a script twice")
    for s in sorted(d - m):
        errors.append(f"found but not in scripts.txt: {s}")
    for s in sorted(m - d):
        errors.append(f"in scripts.txt but not found: {s}")
    for s in sorted(e - m):
        errors.append(f"expected-pass.txt names a script not in scripts.txt: {s}")
    for s in sorted(m - set(results)):
        errors.append(f"no result (dropped from the run): {s}")
    for s in sorted(set(results) - m):
        errors.append(f"a result for a script not in scripts.txt: {s}")
    for s in sorted(e):
        if s in results and not results[s]:
            errors.append(f"REGRESSION: expected to pass, failed: {s}")
    # (scripts that aren't valid MATLAB, or whose assert contradicts MATLAB's documentation: run, never pinned)
    n = set(not_matlab)
    if len(n) != len(not_matlab):
        errors.append("not-matlab.txt lists a script twice")
    for s in sorted(n - m):
        errors.append(f"not-matlab.txt names a script not in scripts.txt: {s}")
    for s in sorted(n & e):
        errors.append(f"expected-pass.txt pins a script of not-matlab.txt: {s}")
    new = sorted(s for s in m if results.get(s) and s not in e and s not in n)
    return errors, new


def pinnable(results, not_matlab):
    """What --write-expected writes: the passing scripts, minus not-matlab.txt's."""
    return sorted(s for s, ok in results.items() if ok and s not in set(not_matlab))


def run_all(cli, scripts, jobs, node, timeout=TIMEOUT):
    work = tempfile.mkdtemp(prefix="numbl-")
    try:
        tree = os.path.join(work, "tree")
        shutil.copytree(SCRIPTS_DIR, tree)
        tmp, home = os.path.join(work, "tmp"), os.path.join(work, "home")
        os.makedirs(tmp)
        os.makedirs(home)
        env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": home, "TMPDIR": tmp, "TMP": tmp, "TEMP": tmp,
               "LANG": "C.UTF-8", "TERM": "dumb"}

        def one(rel):
            path = os.path.join(tree, rel)
            t0 = time.time()
            try:
                p = subprocess.run([node, cli, "--matlab", os.path.basename(path)], cwd=os.path.dirname(path), env=env,
                                   capture_output=True, text=True, errors="replace", timeout=timeout, stdin=subprocess.DEVNULL)
                rc, out, err = p.returncode, p.stdout, p.stderr
            except subprocess.TimeoutExpired:
                rc, out, err = "timeout", "", "TIMEOUT"
            return {"script": rel, "rc": rc, "pass": rc == 0 and passed(out), "secs": round(time.time() - t0, 2),
                    "out_tail": out[-800:], "err_tail": err[-1200:]}

        by_dir = defaultdict(list)
        for rel in scripts:
            by_dir[os.path.dirname(rel)].append(rel)
        rows = []
        with ThreadPoolExecutor(jobs) as ex:
            for res in ex.map(lambda rs: [one(r) for r in rs], list(by_dir.values())):
                rows.extend(res)
        return rows
    finally:
        shutil.rmtree(work, ignore_errors=True)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--cli", default=os.path.join(ROOT, "build", "cli", "pyjs.cjs"))
    ap.add_argument("--node", default="node")
    ap.add_argument("--jobs", type=int, default=max(1, min(8, os.cpu_count() or 1)))
    ap.add_argument("--timeout", type=float, default=TIMEOUT)
    ap.add_argument("--results")
    ap.add_argument("--write-expected", action="store_true")
    a = ap.parse_args()
    manifest, expected, not_matlab = read_list(MANIFEST), read_list(EXPECTED), read_list(NOT_MATLAB)
    discovered = discover(SCRIPTS_DIR)
    t0 = time.time()
    rows = run_all(a.cli, manifest, a.jobs, a.node, a.timeout)
    if a.results:
        with open(a.results, "w") as f:
            for r in rows:
                f.write(json.dumps(r) + "\n")
    results = {r["script"]: r["pass"] for r in rows}
    errors, new = judge(manifest, expected, discovered, results, not_matlab)
    n_pass = sum(results.values())
    print(f"numbl corpus: {n_pass}/{len(manifest)} pass, {len(expected)} expected, in {time.time() - t0:.0f} s")
    for s in new:
        print(f"NEW PASS (add to expected-pass.txt): {s}")
    if a.write_expected:
        with open(EXPECTED, "w") as f:
            f.write("# Scripts of scripts.txt that pass in Sagebrush's MATLAB mode (scripts/numbl-ratchet.py --write-expected).\n")
            for s in pinnable(results, not_matlab):
                f.write(s + "\n")
        print(f"wrote {os.path.relpath(EXPECTED, ROOT)}")
        errors = [e for e in errors if not e.startswith("REGRESSION")]
    by_script = {r["script"]: r for r in rows}
    for e in errors:
        print("ERROR " + e)
        if e.startswith("REGRESSION"):
            r = by_script[e.rsplit(": ", 1)[1]]
            tail = (r["err_tail"].strip() or r["out_tail"].strip()).splitlines()[-6:]
            print(f"  rc {r['rc']}: " + "\n  ".join(tail))
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
