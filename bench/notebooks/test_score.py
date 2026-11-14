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
                              ("ir", "R", None), ("sagebrush-python", "python", "python"),
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
                cell("open('missing.csv')"),
                cell("print(1.0000000001)", [stdout("1.0\n")]),
                cell("print(3)", [stdout("4\n")]),
                cell("import random\nprint(random.random())", [stdout("0.25\n")]),
                cell("!ls"),
                cell("import math\nmath.no_such_function()"),
                cell("value_never_bound + 1"),
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
                ("after-failure", "NameError: name 'value_never_bound' is not defined"),
            ])
            self.assertEqual((n["cls"], n["ok_cells"], n["fully_works"]), ("missing-package", 2, False))
            r = res["r.ipynb"]
            self.assertEqual((r["cls"], r["detail"], r["ok_cells"]), ("kernel", "ir", 0))
            # (the corpus is never written to)
            self.assertEqual(res["bad.ipynb"]["cls"], "unreadable")
            self.assertEqual(sorted(os.listdir(src)), ["bad.ipynb", "d.csv", "n.ipynb", "r.ipynb"])
            self.assertIn("| missing-package | 1 | 1 |", p.stdout)
            self.assertIn("Unreadable notebooks: 1.", p.stdout)
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


if __name__ == "__main__":
    unittest.main()
