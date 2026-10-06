"""Run a corpus of Jupyter notebooks under Sagebrush (the pyjs CLI) and
report which run and, for the rest, the first thing missing.

    python3 bench/notebooks/score.py DIR [-j 8] [--timeout 120] [--out results.json]

Every .ipynb under DIR runs as one script: its code cells joined, in a
temporary copy of the notebook's directory (with its data files), so the
corpus is never modified.  IPython magics and
shell lines (%..., !...) are dropped.  For each notebook:

- the libraries it imports;
- its data files by extension;
- its status: ok, error (with the exception's first line), or timeout.

The summary counts the most common missing modules and errors, which is
the order to fix them in.
"""
import argparse, collections, concurrent.futures, json, os, re, shutil, subprocess, sys, tempfile, time

HERE = os.path.dirname(os.path.abspath(__file__))
CLI = os.path.join(os.path.dirname(os.path.dirname(HERE)), "dist", "src", "cli.js")
DATA_EXT = {".mat", ".npy", ".npz", ".h5", ".hdf5", ".nc", ".csv", ".txt", ".dat", ".vtk", ".vtu", ".stl", ".json", ".pkl", ".bin"}


def script(nb):
    """The notebook's code cells as one Python script."""
    out = []
    for c in nb.get("cells", []):
        if c.get("cell_type") != "code":
            continue
        src = "".join(c.get("source", []))
        lines = [l for l in src.split("\n") if not l.lstrip().startswith(("%", "!"))]
        out.append("\n".join(lines))
    return "\n\n".join(out) + "\n"


def imports(code):
    mods = set()
    for m in re.finditer(r"^\s*(?:import\s+([\w.]+)|from\s+([\w.]+)\s+import)", code, re.M):
        mods.add((m.group(1) or m.group(2)).split(".")[0])
    return sorted(mods)


def run(path, timeout):
    nb = json.load(open(path, encoding="utf-8"))
    code = script(nb)
    src = os.path.dirname(path)
    data = collections.Counter(os.path.splitext(f)[1].lower() for f in os.listdir(src)
                               if os.path.splitext(f)[1].lower() in DATA_EXT)
    work = tempfile.mkdtemp(prefix="sbscore-")
    d = os.path.join(work, "nb")
    shutil.copytree(src, d, ignore=shutil.ignore_patterns("*.ipynb", ".ipynb_checkpoints"))
    tmp = os.path.join(d, "_sbscore_.py")
    with open(tmp, "w") as f:
        f.write(code)
    t0 = time.time()
    try:
        p = subprocess.run(["node", CLI, os.path.basename(tmp)], cwd=d, capture_output=True, text=True, timeout=timeout)
        status = "ok" if p.returncode == 0 else "error"
        err = ""
        if status == "error":
            tail = [l for l in p.stderr.strip().split("\n") if l.strip()]
            err = tail[-1][:300] if tail else "exit %d" % p.returncode
    except subprocess.TimeoutExpired:
        status, err = "timeout", ""
    finally:
        shutil.rmtree(work, ignore_errors=True)
    return {"notebook": path, "status": status, "error": err, "seconds": round(time.time() - t0, 1),
            "imports": imports(code), "data": dict(data)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("dir")
    ap.add_argument("-j", type=int, default=max(1, (os.cpu_count() or 2) // 2))
    ap.add_argument("--timeout", type=int, default=120)
    ap.add_argument("--out")
    a = ap.parse_args()
    nbs = sorted(os.path.join(r, f) for r, _, fs in os.walk(a.dir) for f in fs
                 if f.endswith(".ipynb") and ".ipynb_checkpoints" not in r)
    with concurrent.futures.ThreadPoolExecutor(a.j) as pool:
        results = list(pool.map(lambda p: run(p, a.timeout), nbs))
    st = collections.Counter(r["status"] for r in results)
    print("%d notebooks: %s" % (len(results), dict(st)))
    missing = collections.Counter(m.group(1) for r in results for m in [re.search(r"No module named '([\w.]+)'", r["error"])] if m)
    errors = collections.Counter(re.sub(r"'[^']*'", "'…'", r["error"])[:120] for r in results if r["status"] == "error" and "No module named" not in r["error"])
    libs = collections.Counter(m for r in results for m in r["imports"])
    data = collections.Counter()
    for r in results:
        data.update(r["data"])
    print("\nmissing modules:", ", ".join("%s (%d)" % kv for kv in missing.most_common(20)) or "none")
    print("\nother errors:")
    for e, n in errors.most_common(20):
        print("  %3d  %s" % (n, e))
    print("\nimports:", ", ".join("%s (%d)" % kv for kv in libs.most_common(30)))
    print("data files:", ", ".join("%s (%d)" % kv for kv in data.most_common()))
    if a.out:
        json.dump(results, open(a.out, "w"), indent=1)


if __name__ == "__main__":
    main()
