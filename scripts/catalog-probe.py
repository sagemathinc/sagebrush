"""A value probe for the function catalog (catalog/SCHEMA.md): before an entry
is "full", its function must give upstream's answer on edge values of each
argument, not only on its examples.

    python3 scripts/catalog-probe.py --generate NAMES OUT    under CPython (the oracle): the calls,
                                                           and CPython's answer to each
    node dist/src/cli.js scripts/catalog-probe.py --run PROBES NAME
                                                           the same calls of NAME in Sagebrush
    python3 scripts/catalog-probe.py --compare PROBES SB OUT
                                                           each name's calls and the ones whose
                                                           answers differ

NAMES is a JSON list of dotted names (functions of the standard library).
A call varies one argument at a time over VALUES, the others held at a base
that CPython accepts. An answer is the repr of the result (an iterator: its
first 20 items) and the arguments after the call (for one that changes
them), or the type of the exception raised. Calls CPython does not answer
within 2 s are left out.
"""
import json
import sys

VALUES = ["0", "-1", "1", "2", "7", "2 ** 70", "-(2 ** 70)", "0.5", "-0.0", "float('nan')", "float('inf')", "-float('inf')",
          "True", "False", "None", "[]", "()", "''", "[3, 1, 2]", "(1, 2)", "'abc'", "{1: 2}", "range(5)",
          # (strings past ASCII, and callables: a function with an attribute
          # of its own, and a builtin; CORR-D1C-1 and CORR-D1C-2)
          "'Straße'", "'ǅİ'", "_fn", "len"]
BASES = ["2", "[3, 1, 2]", "'abc'", "0.5", "range(5)", "1"]


def answer(f, args_src):
    """repr of what f(*args) gives, its arguments after it, or the exception type"""
    import itertools
    import random
    random.seed(0)

    def _fn(*a, **k):
        return a
    _fn.tag = 7
    args = eval("[" + args_src + "]", {"_fn": _fn})
    try:
        r = f(*args)
    except Exception as err:
        return "raise " + type(err).__name__
    if hasattr(r, "__next__") and not isinstance(r, (str, bytes)):
        try:
            r = list(itertools.islice(r, 20))
        except Exception as err:
            return "iter raise " + type(err).__name__
    # (a function made: its own attributes too, as update_wrapper copies them)
    extra = ""
    if callable(r) and hasattr(r, "__dict__"):
        try:
            extra = " | attrs " + repr(sorted(k for k in vars(r) if not k.startswith("__")))
        except Exception as err:
            extra = " | attrs raise " + type(err).__name__
    try:
        return repr(r) + " | " + repr(args) + extra
    except Exception as err:
        return "repr raise " + type(err).__name__


def resolve(name):
    # (__import__ and attributes: Sagebrush has no importlib)
    parts = name.split(".")
    for k in range(len(parts), 0, -1):
        try:
            obj = __import__(".".join(parts[:k]))
        except Exception:
            continue
        for p in parts[1:]:
            obj = getattr(obj, p)
        return obj
    raise ImportError(name)


def arity(f):
    """(required, at most) positional arguments, from the signature"""
    import inspect
    try:
        ps = list(inspect.signature(f).parameters.values())
    except (TypeError, ValueError):
        return 1, 2
    pos = [p for p in ps if p.kind in (p.POSITIONAL_ONLY, p.POSITIONAL_OR_KEYWORD)]
    req = sum(1 for p in pos if p.default is p.empty)
    var = any(p.kind == p.VAR_POSITIONAL for p in ps)
    return max(req, 1 if var else 0), min(len(pos) + (2 if var else 0), 3)


def timed(f, src):
    import signal

    def stop(*_):
        raise TimeoutError
    signal.signal(signal.SIGALRM, stop)
    signal.alarm(2)
    try:
        return answer(f, src)
    except TimeoutError:
        return None
    finally:
        signal.alarm(0)


def generate(names_file, out_file):
    import itertools
    names = json.load(open(names_file))
    out = []
    for name in names:
        f = resolve(name)
        lo, hi = arity(f)
        calls = set()
        for n in range(lo, hi + 1):
            # (a base CPython accepts, then each argument over VALUES)
            base = next((b for b in itertools.product(BASES, repeat=n) if not (timed(f, ", ".join(b)) or "raise").startswith("raise")), None)
            if base is None:
                base = (BASES[0],) * n
            for i in range(n):
                for v in VALUES:
                    a = list(base)
                    a[i] = v
                    calls.add(", ".join(a))
            if n == 0:
                calls.add("")
        for src in sorted(calls):
            got = timed(f, src)
            if got is not None:
                out.append({"name": name, "args": src, "cpython": got})
    json.dump(out, open(out_file, "w"), indent=1)
    print("%d calls of %d functions" % (len(out), len(names)))


def run(probes_file, name):
    probes = [p for p in json.load(open(probes_file)) if p["name"] == name]
    f = resolve(name)
    print("JSON" + json.dumps([{"args": p["args"], "sagebrush": answer(f, p["args"])} for p in probes]))


def _norm(s):
    """an answer without what differs between any two runs (addresses)"""
    import re
    return re.sub(r" at 0x[0-9a-f]+", " at 0x...", s) if isinstance(s, str) else s


def compare(probes_file, sb_file, out_file):
    probes = json.load(open(probes_file))
    sb = json.load(open(sb_file))  # {name: [{args, sagebrush}] or "timeout"}
    report = {}
    for p in probes:
        r = report.setdefault(p["name"], {"calls": 0, "differ": []})
        got = sb.get(p["name"])
        if not isinstance(got, list):
            r["differ"] = [{"args": "(all)", "cpython": "answers", "sagebrush": str(got)}]
            continue
        r["calls"] += 1
        mine = next((g["sagebrush"] for g in got if g["args"] == p["args"]), None)
        if _norm(mine) != _norm(p["cpython"]):
            r["differ"].append({"args": p["args"], "cpython": p["cpython"], "sagebrush": mine})
    json.dump(report, open(out_file, "w"), indent=1, sort_keys=True)
    bad = sorted(n for n, r in report.items() if r["differ"])
    print("%d functions, %d calls; %d differ: %s" % (len(report), sum(r["calls"] for r in report.values()), len(bad), ", ".join(bad)))


if __name__ == "__main__":
    a = sys.argv[1:]
    if a[:1] == ["--generate"]:
        generate(a[1], a[2])
    elif a[:1] == ["--run"]:
        run(a[1], a[2])
    elif a[:1] == ["--compare"]:
        compare(a[1], a[2], a[3])
    else:
        print(__doc__)
