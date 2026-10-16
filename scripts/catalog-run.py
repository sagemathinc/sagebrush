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


# Time bounds: examples run in child processes, BATCH examples to a process
# with a deadline of EXAMPLE_SECONDS for each (at most BATCH_SECONDS); a batch past it is run again one example
# to a process, each with EXAMPLE_SECONDS (--timeout), and an example past
# that has the result "TimeoutError: ...", so that every later example still
# runs and the one that stalled is named.  (Each example's output is bounded
# by its runner: LIMIT in lib/_python_examples.py and lib/_sage_examples.py.)
BATCH = 25
BATCH_SECONDS = 600
EXAMPLE_SECONDS = 60


def _run_child(runtime, mode, entries, timeout):
    """[{name, signature, index, got}] from one child process, or None past timeout"""
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "entries.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump(entries, f)
        work = os.path.join(d, "work")
        os.mkdir(work)
        env = dict(os.environ, SAGEBRUSH_CATALOG="")
        cmd = COMMANDS[runtime] + ["-m", "_catalog", "--run", "--mode", mode, "--runtime", runtime.split("-")[0], "--entries", path]
        try:
            r = subprocess.run(cmd, cwd=work, capture_output=True, text=True, env=env, timeout=timeout)
        except subprocess.TimeoutExpired:
            return None
        if r.returncode:
            sys.exit("%s: %s" % (" ".join(cmd), r.stderr[-2000:]))
        return json.loads(r.stdout.strip().split("\n")[-1])


def run_on(runtime, mode, entries, example_seconds=EXAMPLE_SECONDS):
    """[{name, signature, index, got}] from the runtime"""
    # one (entry, example index) per example, in order, cut into batches
    items = [(e, i) for e in entries for i in range(len(e.get("examples", [])))]
    out = []
    for k in range(0, len(items), BATCH):
        batch = items[k:k + BATCH]
        # (each example as an entry of its own: index 0, mapped back below)
        alone = [dict(e, examples=[e["examples"][i]]) for e, i in batch]
        res = _run_child(runtime, mode, alone, max(example_seconds, min(BATCH_SECONDS, example_seconds * len(batch))))
        if res is None:
            res = []
            for a in alone:
                r = _run_child(runtime, mode, [a], example_seconds)
                if r is None:
                    r = [{"name": a["name"], "signature": a["signature"], "index": 0,
                          "got": "TimeoutError: the example ran for more than %d seconds\n" % example_seconds}]
                res += r
        # an example a runtime skips (`runtimes`) has no result: match by position
        it = iter(res)
        for (e, i), a in zip(batch, alone):
            if "runtimes" in a["examples"][0] and runtime.split("-")[0] not in a["examples"][0]["runtimes"]:
                continue
            r = next(it, None)
            if r is not None:
                out.append(dict(r, index=i))
        out += [dict(r, index=-1) for r in it]
    return out


def compare(mode, entries, results, runtime, label):
    """The number of problems (_catalog.compare: an output that differs, or
    an example with no result, or more than one), each reported"""
    probs = _catalog.compare(entries, results, runtime)
    for p in probs:
        print("--- %s %s (%s)" % (mode, p, label))
    return len(probs)


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
        # (a new file renamed over the old: an interruption leaves one or the other)
        tmp = p + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            fh.write(json.dumps(data, indent=2, ensure_ascii=False) + "\n")
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, p)
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
            n = compare(mode, entries, cpython(entries), None, "CPython %s" % sys.version.split()[0])
            total = sum(len(e["examples"]) for e in entries)
            print("python: %d of %d examples print the same under CPython %s" % (total - n, total, sys.version.split()[0]))
            bad += n
            continue
        results = run_on(runtime, mode, entries, int(arg("--timeout", EXAMPLE_SECONDS)))
        if "--update" in sys.argv:
            update(mode, results)
            continue
        n = compare(mode, entries, results, runtime.split("-")[0], runtime)
        print("%s on %s: %d examples, %d differ" % (mode, runtime, len(results), n))
        bad += n
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
