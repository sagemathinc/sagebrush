"""Tests of score.py on notebooks made here: the census, the classes, the
output comparison, and (when nbclient and the bundled CLI are there) a run
through Sagebrush's kernel.

    python3 bench/notebooks/test_score.py
"""
import json, os, shutil, subprocess, sys, tempfile, unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import score  # noqa: E402


def cell(src, outputs=()):
    return {"cell_type": "code", "metadata": {}, "execution_count": None, "source": src, "outputs": list(outputs)}


def stdout(text):
    return {"output_type": "stream", "name": "stdout", "text": text}


def notebook(cells, kernel="python3", language="python"):
    for i, c in enumerate(cells):
        c["id"] = "c%d" % i
    return {"nbformat": 4, "nbformat_minor": 5, "cells": cells,
            "metadata": {"kernelspec": {"name": kernel, "language": language, "display_name": kernel},
                         "language_info": {"name": language}}}


def write(d, name, nb):
    p = os.path.join(d, name)
    with open(p, "w") as f:
        json.dump(nb, f)
    return p


class Census(unittest.TestCase):
    def test_modes(self):
        for k, lang, mode in [("python3", "python", "python"), ("sagemath-10.4", "sage", "sage"),
                              ("sagebrush", "sage", "sage"), ("octave", "octave", "matlab"),
                              ("imatlab", "matlab", "matlab"), ("magma", "magma", "magma"),
                              ("ir", "R", None), ("k", "sage", "sage"), ("k", "octave", "matlab"),
                              ("k", "matlab", "matlab"), ("k", "magma", "magma"), ("sagebrush-python", "python", "python"),
                              ("sagebrush-matlab", "matlab", "matlab"), ("sagebrush-rill", "r", None), ("julia-1.10", "julia", None), ("", "", "python")]:
            self.assertEqual(score.mode_of(k, lang), mode, (k, lang))

    def test_census(self):
        d = tempfile.mkdtemp()
        try:
            open(os.path.join(d, "a.csv"), "w").close()
            p = write(d, "n.ipynb", notebook([
                cell("import numpy as np, scipy.io\nfrom matplotlib import pyplot as plt\nimport ipywidgets\n"),
                cell("x = np.loadtxt('a.csv')\ny = np.load(\"data/b.npy\")\nu = 'https://example.org/z.csv'\n",
                     [{"output_type": "display_data", "data": {"image/png": "", "text/plain": "<Figure>"}, "metadata": {}}]),
                cell("%matplotlib inline\n!ls\nfiles = !ls\n%%time\n", [stdout("hi\n")]),
                {"cell_type": "markdown", "metadata": {}, "source": "import os"},
            ]))
            c = score.census(p)
            self.assertEqual(c["code_cells"], 3)
            self.assertEqual(c["imports"], ["ipywidgets", "matplotlib", "numpy", "scipy"])
            self.assertEqual(c["widgets"], ["ipywidgets"])
            self.assertEqual(c["data_present"], ["a.csv"])
            self.assertEqual(c["data_missing"], ["data/b.npy"])
            self.assertEqual(c["urls"], {"example.org": 1})
            self.assertEqual(c["shell_lines"], 2)
            self.assertEqual(c["magics"], {"matplotlib": 1, "time": 1})
            self.assertEqual(c["outputs"], {"image/png": 1, "text/plain": 1, "stream": 1})
            self.assertEqual(c["mode"], "python")
        finally:
            shutil.rmtree(d)


class Classify(unittest.TestCase):
    def test_classes(self):
        cases = [
            ("ModuleNotFoundError", "No module named 'nosuch'", "missing-package", "nosuch"),
            ("ModuleNotFoundError", "No module named 'scipy.nosuch'", "missing-package", "scipy.nosuch"),
            ("ModuleNotFoundError", "No module named 'plotly.express'", "display", "plotly"),
            ("ImportError", "cannot import name 'thing' from 'scipy.special' (x)", "unsupported-feature", "scipy.special.thing"),
            ("NotImplementedError", "not in Sagebrush yet", "unsupported-feature", "not in Sagebrush yet"),
            ("AttributeError", "module 'numpy' has no attribute 'thing'", "unsupported-feature", "numpy.thing"),
            ("AttributeError", "'Axes' object has no attribute 'twinx'", "unsupported-feature", "Axes.twinx"),
            ("TypeError", "plot() got an unexpected keyword argument 'zorder'", "unsupported-feature", "plot('zorder')"),
            ("UsageError", "shell commands are not available in Sagebrush: no shell", "kernel", "shell line"),
            ("UsageError", "Line magic function `%load` not found (Sagebrush has %time).", "kernel", "%load"),
            ("FileNotFoundError", "[Errno 2] No such file or directory: 'data/b.npy'", "data-file", "b.npy"),
            ("URLError", "<urlopen error no-snapshot: no snapshot in this folder>", "data-file", "network"),
            ("EOFError", "EOF when reading a line", "kernel", "input()"),
            ("KeyboardInterrupt", "", "timeout", ""),
            ("RecursionError", "maximum recursion depth exceeded", "crash", "RecursionError"),
            ("ValueError", "bad value\nmore", "error", "ValueError: bad value"),
            ("PermissionError", "[Errno 13] this notebook isn't allowed to change this", "permission", "writes a file"),
            ("SyntaxError", "(unicode error) 'unicodeescape' codec can't decode bytes: unknown Unicode character name",
             "unsupported-feature", "\\N{name} string escapes"),
            ("RuntimeError", "FRED live data needs the Sagebrush web app (with your own key)", "data-file", "live data (the web app only)"),
            ("NotImplementedError", "read_csv from a URL isn't supported; download the file first", "data-file", "network"),
            ("MemoryError", "prime_range over [2, 10^11) is not supported in Sagebrush: past its heap", "unsupported-feature",
             "prime_range over [2, 10^11) is not supported in Sagebrush: past its heap"),
        ]
        for ename, evalue, cls, detail in cases:
            self.assertEqual(score.classify(ename, evalue), (cls, detail), ename + ": " + evalue)

    def test_python2(self):
        self.assertEqual(score.classify("SyntaxError", "invalid syntax", "python2"), ("kernel", "Python 2"))
        self.assertEqual(score.classify("SyntaxError", "invalid syntax", "python3")[0], "error")

    def test_optional_package(self):
        if not score.OPTIONAL:
            self.skipTest("no optional packages in this checkout")
        mod = sorted(score.OPTIONAL)[0]
        self.assertEqual(score.classify("ModuleNotFoundError", "No module named '%s'" % mod),
                         ("missing-package", mod + " (optional)"))


class Page(unittest.TestCase):
    """What the notebook page wrote, read back: its error, and its saved controls."""

    def test_page_error(self):
        err = lambda t: score.page_error([{"output_type": "stream", "name": "stderr", "text": t}])
        self.assertEqual(err("Traceback (most recent call last):\n  File \"<cell>\", line 1, in <module>\n    import x\n"
                             "ModuleNotFoundError: No module named 'x'\nSagebrush runs Python in this page: it has a, b.\n"),
                         ("ModuleNotFoundError", "No module named 'x'"))
        self.assertEqual(err("  File \"<cell>\", line 1\n    print(1\n         ^\nSyntaxError: '(' was never closed\n"),
                         ("SyntaxError", "'(' was never closed"))
        self.assertEqual(err("Not run: cell 3, which this cell depends on, raised an error.\n")[0], "NotRun")
        self.assertIsNone(err("a warning: about something\n"))
        self.assertIsNone(score.page_error([{"output_type": "stream", "name": "stdout",
                                             "text": "Traceback (most recent call last):\nValueError: printed\n"}]))

    def test_judge(self):
        row = {}
        score.judge(row, ("NotRun", "Not run: cell 3, which this cell depends on"), [], [], "", "python3", False)
        self.assertEqual(row["status"], "after-failure")
        row = {}
        score.judge(row, ("ModuleNotFoundError", "No module named 'helpers'"), [], [], "", "python3", False, ["helpers"])
        self.assertEqual((row["status"], row["detail"]), ("missing-package", "helpers (a module beside the notebook)"))
        row = {}
        page = [stdout("[interactive controls: run the cell to use them]\nsum: 2.5\n")]
        score.judge(row, None, page, [stdout("sum: 2.5\n")], "", "python3", False)
        self.assertEqual(row["status"], "ok")

    def test_defines(self):
        code = "x = 1\nf(T) = T^2\ndef g(): pass\nimport numpy as np\nfor i, j in z: pass\na, b = 1, 2\nif y == 3: pass\nwith open(p) as fh: pass"
        code += "\n%time t = prime_g(10^7); t"
        for name in ("x", "f", "g", "np", "i", "j", "a", "b", "fh", "t"):
            self.assertTrue(score.defines(code, name), name)
        code += "\nplot(lambda x: prime_pi(x) - Li(x), (2, 100), plot_points=1000)"
        for name in ("y", "T", "stats", "z", "Li"):
            self.assertFalse(score.defines(code, name), name)

    def test_judge_names_and_timings(self):
        row = {}
        score.judge(row, ("NameError", "name 'stats' is not defined"), [], [], "", "sagemath", False, code="t = stats.TimeSeries(v)")
        self.assertEqual((row["status"], row["detail"]), ("unsupported-feature", "stats (not defined in the notebook)"))
        row = {}
        score.judge(row, ("NameError", "name 't' is not defined"), [], [], "", "sagemath", True, code="t = stats.TimeSeries(v)")
        self.assertEqual(row["status"], "after-failure")
        row = {}
        score.judge(row, None, [stdout("3 ms per loop\n")], [stdout("75 us per loop\n")], "%timeit f(3)", "python3", False)
        self.assertEqual((row["status"], row["output"]), ("ok", "timing"))

    def test_local_modules(self):
        d = tempfile.mkdtemp()
        try:
            open(os.path.join(d, "helpers.py"), "w").close()
            os.mkdir(os.path.join(d, "_code"))
            open(os.path.join(d, "_code", "__init__.py"), "w").close()
            os.mkdir(os.path.join(d, "data"))
            self.assertEqual(score.census(write(d, "n.ipynb", notebook([cell("1")])))["local_modules"], ["_code", "helpers"])
        finally:
            shutil.rmtree(d)


class Compare(unittest.TestCase):
    def test_text(self):
        self.assertTrue(score.same_text("x = 1.0000000001 y", "x = 1.0 y"))
        self.assertFalse(score.same_text("x = 1.01", "x = 1.0"))
        self.assertFalse(score.same_text("a 1", "b 1"))
        self.assertTrue(score.same_text("1e-20", "0"))

    def test_compare(self):
        fig = {"output_type": "display_data", "data": {"image/png": "", "text/plain": "<Figure size 640x480>"}}
        svg = {"output_type": "display_data", "data": {"image/svg+xml": "<svg/>", "text/plain": "<Figure>"}}
        widget = {"output_type": "execute_result", "data": {"application/vnd.jupyter.widget-view+json": {}, "text/plain": "Output()"}}
        html = {"output_type": "display_data", "data": {"text/html": "<b>x</b>", "text/plain": "x"}}
        err = {"output_type": "stream", "name": "stderr", "text": "a notice\n"}
        self.assertEqual(score.compare([], [stdout("x")]), "none")
        self.assertEqual(score.compare([err], [stdout("x")]), "none")
        self.assertEqual(score.compare([stdout("2\n")], [stdout("2\n")]), "same")
        self.assertEqual(score.compare([stdout("2\n")], [stdout("3\n")]), "differs")
        self.assertEqual(score.compare([fig], [svg]), "same")
        self.assertEqual(score.compare([fig], []), "missing-figure")
        self.assertEqual(score.compare([fig], [svg, stdout("a widget's text")]), "same")
        self.assertEqual(score.compare([widget], [html]), "same")
        latex = {"output_type": "execute_result", "data": {"text/plain": "1.5", "text/latex": "1.5"}}
        self.assertEqual(score.compare([stdout("1.5\n")], [latex]), "same")
        self.assertEqual(score.compare([stdout("2.5\n")], [latex]), "differs")
        self.assertEqual(score.compare([widget], [stdout("Output()")]), "missing-rich")
        self.assertEqual(score.compare([stdout("<f at 0x7f00>")], [stdout("<f at 0x5501>")]), "same")
        note = "[The Sagebrush kernel can't show interact controls in Jupyter yet, so f ran once with its default values: n=8]\n"
        self.assertEqual(score.compare([stdout("sum: 2.5\n")], [stdout(note + "sum: 2.5\n")]), "same")


@unittest.skipUnless(os.path.exists(score.CLI), "the bundled CLI is not built (npm run build:cli)")
class Run(unittest.TestCase):
    """A run through Sagebrush's kernel: each class from a real cell."""

    @classmethod
    def setUpClass(cls):
        try:
            import nbclient  # noqa: F401
        except ImportError:
            raise unittest.SkipTest("nbclient is not installed")

    def test_run(self):
        d = tempfile.mkdtemp()
        try:
            src = os.path.join(d, "corpus")
            os.mkdir(src)
            with open(os.path.join(src, "d.csv"), "w") as f:
                f.write("1,2\n")
            write(src, "n.ipynb", notebook([
                cell("print(open('d.csv').read().strip())\n_ = open('written.txt', 'w').write('x')", [stdout("1,2\n")]),
                cell("import nosuchmodule_for_the_test"),
                cell("held = open('missing.csv')"),
                cell("print(1.0000000001)", [stdout("1.0\n")]),
                cell("print(3)", [stdout("4\n")]),
                cell("import random\nprint(random.random())", [stdout("0.25\n")]),
                cell("!ls"),
                cell("import math\nmath.no_such_function()"),
                cell("held + 1"),
            ]))
            write(src, "r.ipynb", notebook([cell("1 + 1")], kernel="ir", language="R"))
            with open(os.path.join(src, "bad.ipynb"), "w") as f:
                f.write("{not json")
            out = os.path.join(d, "r.json")
            p = subprocess.run([sys.executable, score.__file__, src, "-j", "2", "--cell-timeout", "120", "--out", out],
                               capture_output=True, text=True, timeout=600)
            self.assertEqual(p.returncode, 0, p.stderr)
            res = {os.path.basename(r["notebook"]): r for r in json.load(open(out))}
            n = res["n.ipynb"]
            self.assertEqual([(c["status"], c.get("detail")) for c in n["cells"]], [
                ("ok", None),
                ("missing-package", "nosuchmodule_for_the_test"),
                ("data-file", "missing.csv"),
                ("ok", None),
                ("wrong-output", None),
                ("wrong-output", "random"),
                ("kernel", "shell line"),
                ("unsupported-feature", "math.no_such_function"),
                ("after-failure", "NameError: name 'held' is not defined"),
            ])
            self.assertEqual((n["cls"], n["ok_cells"], n["fully_works"]), ("missing-package", 2, False))
            r = res["r.ipynb"]
            self.assertEqual((r["cls"], r["detail"], r["ok_cells"]), ("kernel", "ir", 0))
            # (relative writes land in the copy)
            self.assertEqual(res["bad.ipynb"]["cls"], "unreadable")
            self.assertEqual(sorted(os.listdir(src)), ["bad.ipynb", "d.csv", "n.ipynb", "r.ipynb"])
            self.assertIn("| missing-package | 1 | 1 |", p.stdout)
            self.assertIn("Unreadable notebooks: 1.", p.stdout)
            # (a corpus that can be written to is warned about: the copy is not a sandbox)
            self.assertIn("can be written to", p.stderr)
        finally:
            shutil.rmtree(d)

    def test_timeouts(self):
        d = tempfile.mkdtemp()
        try:
            src = os.path.join(d, "corpus")
            os.mkdir(src)
            write(src, "n.ipynb", notebook([cell("while True: pass"), cell("print(2)", [stdout("2\n")])]))
            out = os.path.join(d, "r.json")
            # a cell past --cell-timeout is stopped, and the next one runs
            subprocess.run([sys.executable, score.__file__, src, "--cell-timeout", "4", "--out", out],
                           capture_output=True, text=True, timeout=300)
            self.assertEqual([c["status"] for c in json.load(open(out))[0]["cells"]], ["timeout", "ok"])
            # past --timeout, the cell running is stopped and the rest are not run
            t0 = __import__("time").time()
            subprocess.run([sys.executable, score.__file__, src, "--cell-timeout", "100", "--timeout", "4", "--out", out],
                           capture_output=True, text=True, timeout=300)
            r = json.load(open(out))[0]
            self.assertEqual(([c["status"] for c in r["cells"]], r["cls"]), (["timeout", "not-run"], "timeout"))
            self.assertLess(__import__("time").time() - t0, 60)
        finally:
            shutil.rmtree(d)


def _chrome():
    c = os.environ.get("CHROME") or shutil.which("chromium") or shutil.which("google-chrome")
    return c if c and os.path.exists(c) else None


@unittest.skipUnless(os.path.exists(os.path.join(score.ROOT, "web", "dist", "index.html")) and _chrome(),
                     "the browser level needs the built site (bun web/build.ts) and Chromium (CHROME=...)")
class Browser(unittest.TestCase):
    """The browser level: a notebook on the notebook page, reactively and top to bottom."""

    def test_sidecar_files(self):
        # the files beside a notebook that the browser level serves: regular files only, no symlink followed
        p = subprocess.run(["node", os.path.join(os.path.dirname(os.path.abspath(__file__)), "test-sidecar.mjs")], capture_output=True, text=True)
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)

    def test_page(self):
        d = tempfile.mkdtemp(prefix="sbp-")
        try:
            src = os.path.join(d, "c")
            os.mkdir(src)
            with open(os.path.join(src, "d.csv"), "w") as f:
                f.write("1,2\n")
            write(src, "n.ipynb", notebook([
                cell("print(open('d.csv').read().strip())", [stdout("1,2\n")]),
                cell("import nosuchmodule_for_the_test"),
                cell("print(3)", [stdout("4\n")]),
                cell("open('out.txt', 'w').write('x')"),
                cell("print(1"),
                cell("print('last')", [stdout("last\n")]),
            ]))
            env = dict(os.environ, CHROME=_chrome(), TMPDIR="/tmp")
            for extra in ([], ["--classic"]):
                out = os.path.join(d, "r.json")
                p = subprocess.run([sys.executable, score.__file__, src, "--browser", "--cell-timeout", "60", "--out", out] + extra,
                                   capture_output=True, text=True, timeout=600, env=env)
                self.assertEqual(p.returncode, 0, p.stderr)
                r = json.load(open(out))[0]
                self.assertEqual([(c["status"], c.get("detail")) for c in r["cells"]], [
                    ("ok", None),
                    ("missing-package", "nosuchmodule_for_the_test"),
                    ("wrong-output", None),
                    ("permission", "writes a file"),
                    ("error", "SyntaxError: '(' was never closed"),
                    ("ok", None),
                ], extra)
                self.assertEqual(sorted(os.listdir(src)), ["d.csv", "n.ipynb"])
        finally:
            shutil.rmtree(d)


if __name__ == "__main__":
    unittest.main()
