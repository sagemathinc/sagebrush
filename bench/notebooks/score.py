"""Score a corpus of published Jupyter notebooks under Sagebrush: what runs,
what doesn't, and why, so the biggest gaps are fixed first.

    python3 bench/notebooks/score.py DIR|NOTEBOOK... [--census] [-j 4]
        [--cell-timeout 120] [--timeout 1800] [--out results.json] [--table table.md]

Two levels, one JSON record per notebook:

- census (--census, no code runs): the notebook's kernel and the Sagebrush
  mode it maps to, its imports, magics and shell lines, widget libraries,
  the data files its code names (present next to it or missing), the URLs it
  fetches, and the kinds of output it was published with.
- cells (the default): the census, then every code cell run in order through
  Sagebrush's Jupyter kernel (sagebrush --jupyter-kernel, driven by nbclient),
  in a temporary copy of the notebook's directory, its working directory, so
  the files a cell writes by relative path land in the copy.  A failed cell
  does not stop the run.  Each cell gets a class
  (below), and a cell that ran is compared with the output it was published
  with.

Classes, by the first rule that matches:

  ok                   ran, and its output matches the published one (or it has none)
  missing-package      a module Sagebrush does not have (ModuleNotFoundError)
  unsupported-feature  a module Sagebrush has, without the function, argument
                       or behaviour used (ImportError of a name,
                       NotImplementedError, AttributeError, unexpected keyword)
  kernel               the notebook's kernel has no Sagebrush mode, a shell
                       line or magic, Python 2 syntax
  data-file            a file it reads is not there, or a URL it fetches
  display              a widget library, or a published figure or rich output
                       that Sagebrush did not show
  timeout              the cell ran past --cell-timeout
  crash                the kernel died
  wrong-output         ran, but printed something other than what was published
  error                any other exception
  after-failure        a NameError after an earlier cell failed: most likely
                       that failure's consequence, not a gap of its own
  not-run              after the kernel died, or after the notebook ran past
                       --timeout (the cell then running is a timeout)
  unreadable           the notebook itself is not valid notebook JSON

A notebook's class is its first failing cell's.  Sagebrush's command line has
no live network (urllib.request only replays saved snapshots), so a run
fetches nothing.

The copy is not a sandbox: the notebooks run as local code, as the user
running this, and a cell can still write by absolute path anywhere that user
can, the corpus included.  Make the corpus read-only first (chmod -R a-w
DIR: the run warns when it isn't), and run a corpus from an unknown source in
a disposable environment.

needs: node, the bundled CLI (npm run build:cli, or --cli), and for the cells level
nbclient (pip install nbclient).
"""
import argparse, collections, concurrent.futures, json, math, os, re, shutil, subprocess, sys, tempfile, time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
# (the bundled CLI, with every mode's library: npm run build:cli)
CLI = os.path.join(ROOT, "build", "cli", "pyjs")
DATA_EXT = {".mat", ".npy", ".npz", ".h5", ".hdf5", ".nc", ".csv", ".tsv", ".txt", ".dat", ".vtk", ".vtu", ".stl", ".json",
            ".pkl", ".pickle", ".bin", ".xlsx", ".xls", ".parquet", ".feather", ".fits", ".tif", ".tiff", ".png", ".jpg", ".zip"}
WIDGETS = {"ipywidgets", "plotly", "bokeh", "k3d", "ipyvolume", "pythreejs", "nglview", "altair", "holoviews", "panel", "ipyleaflet", "bqplot"}
CLASSES = ["ok", "missing-package", "unsupported-feature", "kernel", "data-file", "display", "timeout", "crash",
           "wrong-output", "error", "after-failure", "not-run", "unreadable"]
DETAIL_MAX = 160


def optional_modules():
    """The top-level modules of Sagebrush's optional packages (optional/*/sagebrush.json)."""
    mods = set()
    d = os.path.join(ROOT, "optional")
    for name in (os.listdir(d) if os.path.isdir(d) else []):
        try:
            meta = json.load(open(os.path.join(d, name, "sagebrush.json")))
        except (OSError, ValueError):
            continue
        mods.update(m.split(".")[0] for m in (meta.get("python") or {}).get("modules") or [])
    return mods


OPTIONAL = optional_modules()


# ---- census: what the notebook is, without running it

def mode_of(kernelspec, language):
    """The Sagebrush mode for a notebook's kernel (python, sage, magma,
    matlab), or None when there is none."""
    name = (kernelspec or "").lower()
    lang = (language or "").lower()
    # (Sagebrush's own kernels: sagebrush is Sage, sagebrush-<mode> the others)
    if name.startswith("sagebrush-"):
        return name[len("sagebrush-"):] if name[len("sagebrush-"):] in ("python", "magma", "matlab") else None
    if "sage" in name or lang == "sage":
        return "sage"
    if "magma" in name or lang == "magma":
        return "magma"
    if "matlab" in name or "octave" in name or lang in ("matlab", "octave"):
        return "matlab"
    if "python" in name or lang == "python" or (not name and not lang):
        return "python"
    return None


def cell_source(c):
    s = c.get("source", "")
    return "".join(s) if isinstance(s, list) else s


def census(path):
    nb = json.load(open(path, encoding="utf-8"))
    meta = nb.get("metadata", {})
    ks = meta.get("kernelspec", {}) or {}
    lang = (meta.get("language_info", {}) or {}).get("name") or ks.get("language")
    cells = [c for c in nb.get("cells", []) if c.get("cell_type") == "code"]
    code = "\n".join(cell_source(c) for c in cells)
    mods, magics, shell = set(), collections.Counter(), 0
    for line in code.split("\n"):
        s = line.strip()
        m = re.match(r"(?:import\s+([\w.][\w., \t]*)|from\s+([\w.]+)\s+import)\b", s.split("#")[0])
        if m:
            # (import a.b as c, d: each name's first word, and of that its top-level package)
            for part in (m.group(1) or m.group(2)).split(","):
                name = (part.split() or [""])[0]
                if name and not name.startswith("."):
                    mods.add(name.split(".")[0])
        if s.startswith("!") or re.match(r"[\w,\s]+=\s*!", s):
            shell += 1
        mm = re.match(r"%%?([A-Za-z_]\w*)", s)
        if mm:
            magics[mm.group(1)] += 1
    nbdir = os.path.dirname(os.path.abspath(path))
    refs = sorted({m.group(2) for m in re.finditer(r"""(['"])([^'"\n]{1,200}?)\1""", code)
                   if os.path.splitext(m.group(2))[1].lower() in DATA_EXT and "://" not in m.group(2)})
    present = [r for r in refs if os.path.exists(os.path.join(nbdir, os.path.expanduser(r)))]
    urls = collections.Counter(m.group(1).lower() for m in re.finditer(r"https?://([\w.-]+)", code))
    outputs = collections.Counter()
    for c in cells:
        for o in c.get("outputs", []):
            if o.get("output_type") == "stream":
                outputs["stream"] += 1
            elif o.get("output_type") == "error":
                outputs["error"] += 1
            for mime in (o.get("data") or {}):
                outputs[mime] += 1
    return {
        "kernel": ks.get("name") or "", "language": lang or "", "mode": mode_of(ks.get("name"), lang),
        "nbformat": nb.get("nbformat"), "code_cells": len(cells), "imports": sorted(mods),
        "widgets": sorted(mods & WIDGETS), "magics": dict(magics), "shell_lines": shell,
        "data_present": present, "data_missing": [r for r in refs if r not in present],
        "urls": dict(urls), "outputs": dict(outputs),
    }


# ---- classifying one failed cell

def classify(ename, evalue, kernel=""):
    """(class, detail) for a cell that raised ename: evalue."""
    ename, evalue = ename or "", (evalue or "").strip()
    first = evalue.split("\n")[0][:DETAIL_MAX]
    if ename == "ModuleNotFoundError" or (ename == "ImportError" and evalue.startswith("No module named")):
        m = re.search(r"No module named '([\w.]+)'", evalue)
        mod = m.group(1) if m else first
        top = mod.split(".")[0]
        if top in WIDGETS:
            return ("display", top)
        # (an optional package's module: Sagebrush has it, in a package set this run did not load)
        return ("missing-package", top + " (optional)" if top in OPTIONAL else mod)
    if ename == "ImportError":
        m = re.search(r"cannot import name '(\w+)' from '([\w.]+)'", evalue)
        return ("unsupported-feature", "%s.%s" % (m.group(2), m.group(1)) if m else first)
    if ename == "NotImplementedError":
        return ("unsupported-feature", first or "NotImplementedError")
    if ename == "AttributeError":
        m = re.search(r"module '([\w.]+)' has no attribute '(\w+)'", evalue) or \
            re.search(r"'([\w.]+)' object has no attribute '(\w+)'", evalue)
        return ("unsupported-feature", "%s.%s" % m.groups() if m else first)
    if ename == "TypeError" and "unexpected keyword argument" in evalue:
        return ("unsupported-feature", re.sub(r"\(\) got an unexpected keyword argument ", "(", first) + ")")
    if ename == "UsageError":
        if "shell" in evalue or "cannot be installed" in evalue:
            return ("kernel", "shell line")
        m = re.search(r"%+\w+", evalue)
        return ("kernel", m.group(0) if m else first)
    if ename == "SyntaxError" and kernel.lower() in ("python2", "python 2") or \
            ename == "SyntaxError" and "Missing parentheses in call to 'print'" in evalue:
        return ("kernel", "Python 2")
    if ename in ("FileNotFoundError", "IsADirectoryError") or ename in ("OSError", "IOError") and "No such file" in evalue:
        m = re.search(r"'([^']+)'", evalue)
        return ("data-file", os.path.basename(m.group(1)) if m else first)
    if ename in ("URLError", "HTTPError", "ConnectionError") or "no-snapshot" in evalue:
        return ("data-file", "network")
    if ename == "RuntimeError" and "isn't available in Sagebrush" in evalue:
        return ("data-file" if " data " in evalue else "unsupported-feature", first)
    if ename == "EOFError" and "reading a line" in evalue:
        return ("kernel", "input()")
    if ename == "KeyboardInterrupt":
        return ("timeout", "")
    if ename in ("DeadKernelError", "RecursionError", "MemoryError", "SystemError", "InternalError"):
        return ("crash", ename)
    return ("error", "%s: %s" % (ename, first))


# ---- comparing a cell's output with the published one

# (the kernel's note that it ran an interact once with its defaults: the notebook page shows the controls)
KERNEL_WIDGET_NOTE = re.compile(r"\[The Sagebrush kernel can't show [^\]\n]*\]\s?")
NUM = re.compile(r"[-+]?(?:\d+\.\d*|\.\d+|\d+)(?:[eE][-+]?\d+)?")


def texts(outputs):
    out = []
    for o in outputs:
        if o.get("output_type") == "stream" and o.get("name") == "stdout":
            out.append(cell_source({"source": o.get("text", "")}))
        elif o.get("output_type") in ("execute_result", "display_data"):
            # (a figure's or widget's text/plain is a placeholder: only plain results are compared as text)
            t = (o.get("data") or {}).get("text/plain")
            if t is not None and len(o.get("data", {})) == 1:
                out.append(cell_source({"source": t}))
    s = KERNEL_WIDGET_NOTE.sub("", "\n".join(out))
    s = re.sub(r" at 0x[0-9a-fA-F]+", " at 0x?", s)
    return " ".join(s.split())


def same_text(a, b, rel=1e-6):
    """a and b are the same text, numbers equal within rel."""
    if a == b:
        return True
    ta, tb = NUM.split(a), NUM.split(b)
    na, nb = NUM.findall(a), NUM.findall(b)
    if ta != tb or len(na) != len(nb):
        return False
    for x, y in zip(na, nb):
        x, y = float(x), float(y)
        if not math.isclose(x, y, rel_tol=rel, abs_tol=1e-12):
            return False
    return True


def kinds(outputs):
    k = set()
    for o in outputs:
        for mime in (o.get("data") or {}):
            if mime.startswith("image/"):
                k.add("figure")
            elif mime in ("text/html", "application/javascript") or mime.startswith("application/vnd."):
                k.add("rich")
    return k


def compare(published, ours):
    """same | differs | missing-figure | missing-rich | none (nothing was
    published to compare with)."""
    # (stderr is not compared: warnings and the notebook server's own notices differ by host)
    if not [o for o in published if o.get("data") or o.get("output_type") == "stream" and o.get("name") == "stdout"]:
        return "none"
    pk, ok_ = kinds(published), kinds(ours)
    if "figure" in pk and "figure" not in ok_:
        return "missing-figure"
    if "rich" in pk and not ok_:
        return "missing-rich"
    # (a figure-only output published: text Sagebrush shows besides is not a difference)
    pt = texts(published)
    return "same" if not pt or same_text(pt, texts(ours)) else "differs"


# ---- running one notebook

def kernelspecs(base, cli):
    """Kernel specs for each Sagebrush mode under base/kernels, named
    sbscore-<mode>, running this checkout's CLI."""
    for mode in ("python", "sage", "magma", "matlab"):
        d = os.path.join(base, "kernels", "sbscore-" + mode)
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, "kernel.json"), "w") as f:
            json.dump({"argv": ["node", cli, "--jupyter-kernel", "{connection_file}", "--mode", mode],
                       "display_name": "sbscore " + mode, "language": mode}, f)


def run_cells(path, cell_timeout, cli, budget):
    """Run the notebook's code cells in order (the worker, in a process of its
    own): one JSON line per cell on stdout.  Past budget seconds in all, the
    cell running is stopped as a timeout and the rest are not run."""
    import nbformat
    from nbclient import NotebookClient
    from nbclient.exceptions import CellTimeoutError, DeadKernelError
    deadline = time.time() + budget
    info = census(path)
    nb = nbformat.read(path, as_version=4)
    published = {i: c.get("outputs", []) for i, c in enumerate(nb.cells)}
    for c in nb.cells:
        if c.cell_type == "code":
            c.outputs = []
    work = tempfile.mkdtemp(prefix="sbscore-")
    try:
        d = os.path.join(work, "nb")
        # (links copied as the files they name: a relative write through one lands in the copy too)
        shutil.copytree(os.path.dirname(os.path.abspath(path)), d, symlinks=False, ignore_dangling_symlinks=True,
                        ignore=shutil.ignore_patterns(".ipynb_checkpoints"))
        kernelspecs(os.path.join(work, "jupyter"), cli)
        os.environ["JUPYTER_PATH"] = os.path.join(work, "jupyter")
        client = NotebookClient(nb, timeout=cell_timeout, kernel_name="sbscore-" + info["mode"], allow_errors=True,
                                interrupt_on_timeout=True, resources={"metadata": {"path": d}})
        # (the kernel's own output to /dev/null: it must not hold the score's pipe)
        with client.setup_kernel(cwd=d, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL):
            dead = failed = False
            for i, c in enumerate(nb.cells):
                if c.cell_type != "code":
                    continue
                row = {"cell": i}
                left = deadline - time.time()
                if dead or left <= 0:
                    row.update(status="not-run")
                else:
                    t0 = time.time()
                    client.timeout = max(1, math.ceil(min(cell_timeout, left)))
                    try:
                        client.execute_cell(c, i)
                    except CellTimeoutError:
                        row.update(timedout=True)
                    except DeadKernelError:
                        dead = True
                        row.update(status="crash", detail="the kernel died")
                    row["seconds"] = round(time.time() - t0, 2)
                    if "status" not in row:
                        err = next((o for o in c.outputs if o.get("output_type") == "error"), None)
                        if row.pop("timedout", False):
                            row.update(status="timeout")
                        elif err is not None:
                            cls, detail = classify(err.get("ename"), err.get("evalue"), info["kernel"])
                            if cls == "error" and failed and err.get("ename") == "NameError":
                                cls = "after-failure"
                            row.update(status=cls, detail=detail, ename=err.get("ename"))
                        else:
                            cmp = compare(published.get(i, []), c.outputs)
                            row.update(output=cmp, status={"same": "ok", "none": "ok", "differs": "wrong-output"}.get(cmp, "display"))
                            # (a cell drawing random numbers is expected to differ: said, so it can be told apart)
                            if cmp == "differs" and re.search(r"\brandom", c.source):
                                row.update(detail="random")
                            if cmp == "differs":
                                row.update(want=texts(published.get(i, []))[:DETAIL_MAX], got=texts(c.outputs)[:DETAIL_MAX])
                            elif any(KERNEL_WIDGET_NOTE.search(str(o.get("text", "")) + str((o.get("data") or {}).get("text/plain", "")))
                                     for o in c.outputs):
                                # (ran with the widgets' defaults and matched: ok, as the notebook page shows the
                                # controls; the kernel's own gap is noted)
                                row.update(note="interact controls: the kernel ran the defaults")
                failed = failed or row["status"] != "ok"
                print(json.dumps(row), flush=True)
    finally:
        shutil.rmtree(work, ignore_errors=True)


def score(path, a):
    try:
        rec = {"notebook": path, "census": census(path)}
    except (OSError, ValueError, AttributeError, TypeError) as e:
        return {"notebook": path, "cls": "unreadable", "detail": ("%s: %s" % (type(e).__name__, e))[:DETAIL_MAX]}
    c = rec["census"]
    t0 = time.time()
    if a.census:
        pass
    elif c["mode"] is None:
        rec.update(cls="kernel", detail=c["kernel"] or c["language"],
                   cells=[{"cell": None, "status": "not-run"}] * c["code_cells"])
    else:
        cmd = [sys.executable, os.path.abspath(__file__), "--worker", path, "--cell-timeout", str(a.cell_timeout),
               "--timeout", str(a.timeout), "--cli", a.cli]
        p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True)
        try:
            # (the worker keeps to the notebook's time itself; this is in case it can't)
            out, err = p.communicate(timeout=a.timeout + 120)
        except subprocess.TimeoutExpired:
            os.killpg(p.pid, 9)
            out, err = p.communicate()
            rec["timedout"] = True
        cells = [json.loads(l) for l in out.split("\n") if l.startswith("{")]
        cells += [{"cell": None, "status": "not-run"}] * max(0, c["code_cells"] - len(cells))
        if p.returncode not in (0, None) and not rec.get("timedout") and not any(x["status"] != "not-run" for x in cells):
            rec["harness_error"] = (err.strip().split("\n") or [""])[-1][:DETAIL_MAX]
        rec["cells"] = cells
        first = next((x for x in cells if x["status"] != "ok"), None)
        rec["cls"] = "ok" if first is None else first["status"]
        rec["detail"] = "" if first is None else first.get("detail", "")
    if "cells" in rec:
        rec["ok_cells"] = sum(x["status"] == "ok" for x in rec["cells"])
        rec["fully_works"] = rec["ok_cells"] == c["code_cells"]
    rec["seconds"] = round(time.time() - t0, 1)
    return rec


# ---- the summary

def table(results, census_only=False):
    """A markdown summary: classes by notebooks blocked (first failure) and
    cells, then the commonest details of each class."""
    bad = [r for r in results if "census" not in r]
    results = [r for r in results if "census" in r]
    n = len(results)
    L = ["# Notebook score", "", "%d notebooks, %d code cells." % (n, sum(r["census"]["code_cells"] for r in results)), ""]
    if not census_only:
        works = sum(r.get("fully_works", False) for r in results)
        okc = sum(r.get("ok_cells", 0) for r in results)
        allc = sum(r["census"]["code_cells"] for r in results) or 1
        L += ["Fully work: %d of %d. Cells that run and match: %d of %d (%.0f%%)." % (works, n, okc, allc, 100.0 * okc / allc), "",
              "| class | notebooks (first failure) | cells |", "|---|---:|---:|"]
        first = collections.Counter(r.get("cls") for r in results)
        cells = collections.Counter(x["status"] for r in results for x in r.get("cells", []))
        for k in CLASSES:
            if first[k] or cells[k]:
                L.append("| %s | %d | %d |" % (k, first[k], cells[k]))
        L.append("")
        for k in CLASSES[1:]:
            det = collections.Counter(x.get("detail") or "" for r in results for x in r.get("cells", []) if x["status"] == k)
            nbs = collections.Counter(r.get("detail") or "" for r in results if r.get("cls") == k)
            if det or nbs:
                L.append("**%s**: " % k + ", ".join("%s (%d nb, %d cells)" % (d or "-", nbs[d], det[d])
                                                   for d, _ in (nbs + det).most_common(12)))
                L.append("")
    cen = collections.Counter
    kern = cen("%s -> %s" % (r["census"]["kernel"] or "?", r["census"]["mode"] or "none") for r in results)
    imps = cen(m for r in results for m in r["census"]["imports"])
    miss = sum(len(r["census"]["data_missing"]) for r in results)
    L += ["Kernels: " + ", ".join("%s (%d)" % kv for kv in kern.most_common()), "",
          "Imports: " + ", ".join("%s (%d)" % kv for kv in imps.most_common(30)), "",
          "Data files named: %d present, %d missing." % (sum(len(r["census"]["data_present"]) for r in results), miss), ""]
    if bad:
        L += ["Unreadable notebooks: %d." % len(bad), ""]
    return "\n".join(L)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("paths", nargs="*")
    ap.add_argument("--census", action="store_true", help="only the census: no code runs")
    ap.add_argument("-j", type=int, default=max(1, (os.cpu_count() or 2) // 2))
    ap.add_argument("--cell-timeout", type=int, default=120)
    ap.add_argument("--timeout", type=int, default=1800, help="seconds for a whole notebook")
    ap.add_argument("--cli", default=CLI)
    ap.add_argument("--out")
    ap.add_argument("--table")
    ap.add_argument("--worker", help=argparse.SUPPRESS)
    a = ap.parse_args()
    a.cli = os.path.abspath(a.cli)
    if a.worker:
        run_cells(a.worker, a.cell_timeout, a.cli, a.timeout)
        return
    if not a.paths:
        ap.error("give a directory or notebooks")
    if not a.census and not os.path.exists(a.cli):
        ap.error("no CLI at %s: build it (npm run build:cli) or give --cli" % a.cli)
    nbs = []
    # (a cheap guard, not isolation: see the top of this file)
    writable = [p for p in a.paths if not a.census and os.access(p, os.W_OK)]
    if writable:
        sys.stderr.write("warning: %s can be written to; the notebooks run as your own code (chmod -R a-w first)\n"
                         % ", ".join(writable))
    for p in a.paths:
        if os.path.isdir(p):
            nbs += sorted(os.path.join(r, f) for r, _, fs in os.walk(p) for f in fs
                          if f.endswith(".ipynb") and ".ipynb_checkpoints" not in r)
        else:
            nbs.append(p)
    with concurrent.futures.ThreadPoolExecutor(a.j) as pool:
        results = list(pool.map(lambda p: score(p, a), nbs))
    t = table(results, a.census)
    print(t)
    if a.table:
        with open(a.table, "w") as f:
            f.write(t + "\n")
    if a.out:
        with open(a.out, "w") as f:
            json.dump(results, f, indent=1)


if __name__ == "__main__":
    main()
