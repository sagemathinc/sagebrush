"""Run the function catalog's examples (catalog/SCHEMA.md) on a runtime and
compare each output with the entry's `expected`.

    python3 scripts/catalog-run.py                      every mode with a runner, on node (dist/)
    python3 scripts/catalog-run.py --runtime deno       also: node-bundle, bun (build/cli/pyjs.cjs);
                                                        the browser: web/test-catalog.mjs
    python3 scripts/catalog-run.py --mode python
    python3 scripts/catalog-run.py --update             write node's outputs into the entries'
                                                        `expected` (after a deliberate change)
    python3 scripts/catalog-run.py --cpython            Python mode's examples under this CPython
                                                        with NumPy and SciPy: each output that
                                                        differs (a `differs` line to write, or a bug)

Exit status 1 when an output differs from `expected` (for --cpython: when one
differs from CPython's). The examples run in a temporary directory, so the
files they write are left nowhere.
"""
import json
import os
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "lib"))
import _catalog  # noqa: E402  (the catalog's files, read by CPython here)
import _python_examples  # noqa: E402  (its runner, for --cpython)
# (and no more of lib/: --cpython's numpy is NumPy, not Sagebrush's)
sys.path.pop(0)

BUNDLE = os.path.join(ROOT, "build", "cli", "pyjs.cjs")
COMMANDS = {
    "node": ["node", os.path.join(ROOT, "dist", "src", "cli.js")],
    "node-bundle": ["node", BUNDLE],
    "deno": ["deno", "run", "-A", BUNDLE],
    "bun": ["bun", BUNDLE],
}


def arg(name, default=None):
    return sys.argv[sys.argv.index(name) + 1] if name in sys.argv else default


def run_on(runtime, mode, entries):
    """[{name, signature, index, got}] from the runtime"""
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "entries.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump(entries, f)
        work = os.path.join(d, "work")
        os.mkdir(work)
        env = dict(os.environ, SAGEBRUSH_CATALOG="")
        cmd = COMMANDS[runtime] + ["-m", "_catalog", "--run", "--mode", mode, "--runtime", runtime.split("-")[0], "--entries", path]
        r = subprocess.run(cmd, cwd=work, capture_output=True, text=True, env=env, timeout=1800)
        if r.returncode:
            sys.exit("%s: %s" % (" ".join(cmd), r.stderr[-2000:]))
        return json.loads(r.stdout.strip().split("\n")[-1])


def compare(mode, entries, results, label):
    """The number of outputs that differ, each reported"""
    want = {(e["name"], e["signature"], i): ex["expected"] for e in entries for i, ex in enumerate(e["examples"])}
    bad = 0
    for r in results:
        key = (r["name"], r["signature"], r["index"])
        if r["got"] != want[key]:
            bad += 1
            code = entries_by_key(entries)[key]
            print("--- %s %s example %d (%s)\n    code:     %s\n    expected: %r\n    got:      %r" % (
                mode, r["name"], r["index"] + 1, label, code.replace("\n", "; "), want[key], r["got"]))
    return bad


def entries_by_key(entries):
    return {(e["name"], e["signature"], i): ex["code"] for e in entries for i, ex in enumerate(e["examples"])}


def update(mode, results):
    """Write the outputs into the entries' expected, file by file"""
    got = {(r["name"], r["signature"], r["index"]): r["got"] for r in results}
    base = _catalog.root()
    changed = 0
    for f in _catalog.files(mode, base):
        p = os.path.join(base, mode, f)
        with open(p, encoding="utf-8") as fh:
            data = json.load(fh)
        for e in data:
            for i, ex in enumerate(e.get("examples", [])):
                k = (e["name"], e["signature"], i)
                if k in got and got[k] != ex["expected"]:
                    ex["expected"] = got[k]
                    changed += 1
        with open(p, "w", encoding="utf-8") as fh:
            fh.write(json.dumps(data, indent=2, ensure_ascii=False) + "\n")
    print("%s: %d expected outputs rewritten" % (mode, changed))


def cpython(entries):
    """Python mode's examples under this CPython (NumPy, SciPy)"""
    E = _python_examples
    os.environ.setdefault("MPLBACKEND", "Agg")
    results = []
    with tempfile.TemporaryDirectory() as d:
        old = os.getcwd()
        os.chdir(d)
        try:
            for e in entries:
                for i, ex in enumerate(e["examples"]):
                    try:
                        got = E.run(ex["code"])
                    except Exception as err:
                        got = "%s: %s\n" % (type(err).__name__, err)
                    results.append({"name": e["name"], "signature": e["signature"], "index": i, "got": got})
        finally:
            os.chdir(old)
    return results


def main():
    runtime = arg("--runtime", "node")
    if runtime not in COMMANDS:
        sys.exit("--runtime must be one of %s (the browser: web/test-catalog.mjs)" % ", ".join(COMMANDS))
    modes = [arg("--mode")] if "--mode" in sys.argv else [m for m in _catalog.MODES if m in _catalog.RUNNERS]
    bad = 0
    for mode in modes:
        entries = [e for _, e in _catalog.load(mode)]
        if not entries:
            continue
        if "--cpython" in sys.argv:
            if mode != "python":
                continue
            n = compare(mode, entries, cpython(entries), "CPython %s" % sys.version.split()[0])
            total = sum(len(e["examples"]) for e in entries)
            print("python: %d of %d examples print the same under CPython %s" % (total - n, total, sys.version.split()[0]))
            bad += n
            continue
        results = run_on(runtime, mode, entries)
        if "--update" in sys.argv:
            update(mode, results)
            continue
        n = compare(mode, entries, results, runtime)
        print("%s on %s: %d examples, %d differ" % (mode, runtime, len(results), n))
        bad += n
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
