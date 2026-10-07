"""Sage-style doctests for Sagebrush's library.

    sagebrush -m _pyjs_doctest [--long] [--verbose] MODULE ...
    sagebrush -m _pyjs_doctest --coverage MODULE ...
    sagebrush -m _pyjs_doctest --open-problems MODULE ...

Every docstring's examples run, in order, in a fresh namespace: lines after
``sage:`` (continued by ``....:``) in Sage syntax with ``from sage_all
import *`` done, lines after ``>>>`` (continued by ``...``) as Python.  The
expected output follows each example up to a blank line or the next prompt.
As in Sage:

* ``...`` in the expected output matches anything;
* an expected ``Traceback (most recent call last):`` matches any traceback
  that ends with the same exception line;
* on an example's first line, ``# random`` runs it without checking the
  output, ``# not tested`` skips it, ``# long time`` runs it only with
  --long, and ``# abs tol 1e-10`` or ``# rel tol 1e-10`` compares the numbers
  in the output with that tolerance.

A docstring section ``OPEN PROBLEM:`` describes an open problem that the
examples after it illustrate: --open-problems lists them all.  They are
ordinary, tested doctests: what they show (a numerical rank, an unproved
statement raising NotImplementedError) is checked like anything else.
"""

import sys

SECTION = None  # set lazily: re is imported on first use


def _re():
    import re
    return re


# ------------------------------------------------------------------ collection

def _unwrap(v):
    """The function behind a method, staticmethod, classmethod or property."""
    for attr in ("__func__", "fget"):
        f = getattr(v, attr, None)
        if f is not None:
            return f
    return v


def _is_routine(v):
    return hasattr(_unwrap(v), "__code__")


def collect(modname):
    """[(qualname, docstring or None, kind)] for the public API defined in the
    module: its functions and classes, and their methods (also those of
    private classes, which users reach through public functions)."""
    mod = __import__(modname)
    for part in modname.split(".")[1:]:
        mod = getattr(mod, part)
    out = [(modname, getattr(mod, "__doc__", None), "module")]
    for name, v in sorted(mod.__dict__.items()):
        if getattr(v, "__module__", None) != modname:
            continue
        if isinstance(v, type):
            if not name.startswith("_"):
                out.append((name, v.__doc__ if "__doc__" in v.__dict__ else None, "class"))
            for mname, m in sorted(v.__dict__.items()):
                if mname.startswith("_") and mname not in ("__call__",):
                    continue
                if _is_routine(m):
                    out.append(("%s.%s" % (name, mname), getattr(_unwrap(m), "__doc__", None), "method"))
        elif not name.startswith("_") and _is_routine(v):
            out.append((name, getattr(v, "__doc__", None), "function"))
    return out


# ------------------------------------------------------------------ parsing

class Example:
    def __init__(self, source, want, sage, line, flags):
        self.source, self.want, self.sage, self.line, self.flags = source, want, sage, line, flags


def _flags(first):
    re = _re()
    f = {}
    m = re.search(r"#(.*)$", first)
    if m:
        c = m.group(1).lower()
        for key in ("random", "not tested", "long time", "optional", "known bug"):
            if key in c:
                f[key] = True
        t = re.search(r"(abs|rel) tol(?:erance)?\s+([0-9.eE+-]+)", c)
        if t:
            f[t.group(1) + " tol"] = float(t.group(2))
    return f


def examples(doc):
    """The examples of a docstring, in order."""
    out = []
    if not doc:
        return out
    lines = doc.expandtabs().split("\n")
    i = 0
    while i < len(lines):
        s = lines[i].lstrip()
        ind = len(lines[i]) - len(s)
        prompt = None
        if s.startswith("sage: ") or s == "sage:":
            prompt, cont, sage = "sage:", "....:", True
        elif s.startswith(">>> ") or s == ">>>":
            prompt, cont, sage = ">>>", "...", False
        if prompt is None:
            i += 1
            continue
        start = i
        src = [s[len(prompt) + 1:]]
        i += 1
        while i < len(lines):
            t = lines[i].lstrip()
            if t.startswith(cont + " ") or t == cont:
                src.append(t[len(cont) + 1:])
                i += 1
            else:
                break
        want = []
        while i < len(lines):
            t = lines[i]
            ts = t.lstrip()
            if not ts.strip() or ts.startswith("sage:") or ts.startswith(">>>"):
                break
            want.append(t[ind:] if len(t) - len(ts) >= ind else ts)
            i += 1
        out.append(Example("\n".join(src), "\n".join(want), sage, start, _flags(src[0])))
    return out


def open_problem_sections(doc):
    """The text of each OPEN PROBLEM: section of a docstring."""
    re = _re()
    out = []
    if not doc:
        return out
    from _pyjs_help import _cleandoc
    lines = _cleandoc(doc).split("\n")
    i = 0
    while i < len(lines):
        if lines[i].strip().upper().startswith("OPEN PROBLEM"):
            j = i + 1
            body = []
            while j < len(lines):
                t = lines[j]
                if re.match(r"^[A-Z][A-Z ]+:+\s*$", t) or t.strip().startswith("sage:") or t.strip().startswith(">>>"):
                    break
                body.append(t.strip())
                j += 1
            head = lines[i].strip()
            head = head[head.index(":") + 1:].strip() if ":" in head else ""
            text = " ".join(x for x in [head] + body if x).rstrip(":")
            out.append(text)
            i = j
        else:
            i += 1
    return out


# ------------------------------------------------------------------ checking

def _ellipsis_match(want, got):
    re = _re()
    if "..." not in want:
        return want == got
    parts = [re.escape(p) for p in want.split("...")]
    return re.fullmatch("(?s)" + ".*?".join(parts), got) is not None


_NUM = None


def _numbers(s):
    re = _re()
    return re.findall(r"[-+]?(?:\d+\.\d*|\.\d+|\d+)(?:[eE][-+]?\d+)?", s)


def _tol_match(want, got, flags):
    re = _re()
    pat = r"[-+]?(?:\d+\.\d*|\.\d+|\d+)(?:[eE][-+]?\d+)?"
    if re.sub(pat, "#", want) != re.sub(pat, "#", got):
        return False
    for a, b in zip(_numbers(want), _numbers(got)):
        a, b = float(a), float(b)
        if "abs tol" in flags and abs(a - b) > flags["abs tol"]:
            return False
        if "rel tol" in flags and abs(a - b) > flags["rel tol"] * max(abs(a), abs(b)):
            return False
    return True


def _clean(s):
    lines = [l.rstrip() for l in s.split("\n")]
    while lines and not lines[-1]:
        lines.pop()
    return "\n".join(lines)


def check(ex, got, err):
    """None if the example passed, else a description of the failure."""
    want = _clean("\n".join("" if l.strip() == "<BLANKLINE>" else l for l in ex.want.split("\n")))
    if want.startswith("Traceback (most recent call last):"):
        if err is None:
            return "expected an exception, got:\n" + got
        w = [l for l in want.split("\n") if l.strip()][-1]
        g = [l for l in err.split("\n") if l.strip()][-1]
        return None if _ellipsis_match(w.strip(), g.strip()) else "expected:\n%s\ngot:\n%s" % (w, g)
    if err is not None:
        return "unexpected exception:\n" + (got + err)
    got = _clean(got)
    if ex.flags.get("random"):
        return None
    if "abs tol" in ex.flags or "rel tol" in ex.flags:
        ok = _tol_match(want, got, ex.flags)
    else:
        ok = want == got or _ellipsis_match(want, got)
    return None if ok else "expected:\n%s\ngot:\n%s" % (want, got)


# ------------------------------------------------------------------ running

def _fresh(sage):
    ns = type(sys)("__main__")
    ns.__dict__["__name__"] = "__main__"
    if sage:
        saved = sys.modules.get("__main__")
        sys.modules["__main__"] = ns
        try:
            out, err = __pyjs_run__("from sage_all import *", ns, True)
        finally:
            sys.modules["__main__"] = saved
        if err:
            raise RuntimeError(err)
    return ns


def _doctest_mode(on):
    import builtins
    builtins.__sagebrush_doctest__ = on


def run_docstring(name, doc, long=False, verbose=False, report=None):
    """(tried, failures) for one docstring; report(name, ex, got, err, bad)
    is called for every example run."""
    exs = examples(doc)
    if not exs:
        return 0, []
    ns = {}
    tried, failed = 0, []
    for ex in exs:
        if ex.flags.get("not tested") or ex.flags.get("optional") or ex.flags.get("known bug"):
            continue
        if ex.flags.get("long time") and not long:
            continue
        if ex.sage not in ns:
            ns[ex.sage] = _fresh(ex.sage)
        # var() and friends define names in __main__: the example's namespace
        saved = sys.modules.get("__main__")
        sys.modules["__main__"] = ns[ex.sage]
        _doctest_mode(True)
        try:
            got, err = __pyjs_run__(ex.source, ns[ex.sage], ex.sage)
        finally:
            sys.modules["__main__"] = saved
            _doctest_mode(False)
        tried += 1
        bad = check(ex, got, err)
        if report is not None:
            report(name, ex, got, err, bad)
        if verbose:
            print("%s: %s" % (name, ex.source.split("\n")[0]), "ok" if bad is None else "FAILED")
        if bad is not None:
            failed.append((ex, bad))
    return tried, failed


def run_module(modname, long=False, verbose=False):
    """Run every doctest of a module; print failures; (tried, failed)."""
    tried = nfail = 0
    for name, doc, kind in collect(modname):
        t, f = run_docstring(name, doc, long, verbose)
        tried += t
        for ex, why in f:
            nfail += 1
            print("*" * 70)
            print("File %s, in %s (line %d of its docstring)" % (modname, name, ex.line + 1))
            print("Failed example:")
            for l in ex.source.split("\n"):
                print("    " + l)
            print("\n".join("    " + l for l in why.split("\n")))
    return tried, nfail


def run_json(modname, long=False):
    """One JSON line per example run (for scripts/doctest-fix.py)."""
    import json

    real = {}

    def report(name, ex, got, err, bad):
        print(json.dumps({"module": modname, "name": real.get(name, name), "line": ex.line, "source": ex.source,
                          "want": ex.want, "got": got, "err": err, "ok": bad is None}))
    seen = set()
    for name, doc, kind in collect(modname):
        if kind == "method":
            # an alias (inverse = __invert__) reports its function's own name
            cls, _, meth = name.partition(".")
            mod = sys.modules[modname]
            f = _unwrap(getattr(mod, cls).__dict__.get(meth))
            q = getattr(f, "__qualname__", name)
            if q.split(".")[-1] != meth and q.count(".") == 1:
                real[name] = q
        key = real.get(name, name)
        if key in seen:
            continue
        seen.add(key)
        run_docstring(name, doc, long, False, report)


def coverage(modname):
    """(with examples, total, [names without])."""
    items = [(n, d, k) for n, d, k in collect(modname) if k != "module"]
    missing = [n for n, d, k in items if not examples(d)]
    return len(items) - len(missing), len(items), missing


def open_problems(modname):
    out = []
    for name, doc, kind in collect(modname):
        for text in open_problem_sections(doc):
            out.append((modname + "." + name if kind != "module" else modname, text))
    return out


def main(argv):
    long = "--long" in argv
    verbose = "--verbose" in argv
    mods = [a for a in argv if not a.startswith("--")]
    if "--coverage" in argv:
        tot_have = tot_all = 0
        for m in mods:
            have, total, missing = coverage(m)
            tot_have += have
            tot_all += total
            print("%s: %d of %d have examples (%d%%)" % (m, have, total, 100 * have // max(total, 1)))
            if verbose and missing:
                print("    missing: " + ", ".join(missing))
        if len(mods) > 1:
            print("total: %d of %d (%d%%)" % (tot_have, tot_all, 100 * tot_have // max(tot_all, 1)))
        return 0
    if "--open-problems" in argv:
        for m in mods:
            for name, text in open_problems(m):
                print("%s\n    %s\n" % (name, text))
        return 0
    if "--json" in argv:
        for m in mods:
            run_json(m, long)
        return 0
    total = fails = 0
    for m in mods:
        t, f = run_module(m, long, verbose)
        print("%s: %d examples, %d failed" % (m, t, f))
        total += t
        fails += f
    if len(mods) > 1:
        print("total: %d examples, %d failed" % (total, fails))
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
