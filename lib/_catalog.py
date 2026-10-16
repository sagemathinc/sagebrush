"""The function catalog (catalog/SCHEMA.md): every function an agent can use
in a mode, with its signature, summary, examples and their expected output,
what differs from upstream and a status, read from catalog/<mode>/*.json.

    sagebrush -m _catalog --index --mode python      the mode's index, as JSON
                                                     (web/build.ts: docs-index-python.json)
    sagebrush -m _catalog --check                    validate every mode's files
    sagebrush -m _catalog --coverage                 entries, examples and statuses per mode
    sagebrush -m _catalog --missing --mode python    the public names with no entry (missing.txt)
    sagebrush -m _catalog --run --mode python        run the mode's examples here and print
                                                     [{name, signature, index, got}] as JSON
                                                     (scripts/catalog-run.py compares them,
                                                     on every runtime)

validate() mirrors catalog/schema.json, so the check needs no JSON Schema
library and runs wherever Sagebrush does.
"""

import json as _json
import os as _os
import sys as _sys

MODES = ["python", "sage", "magma", "matlab"]
KINDS = ["function", "procedure", "class", "method", "attribute", "constant", "module", "operator", "keyword"]
STATUSES = ["full", "partial", "stub-error", "absent"]
RUNTIMES = ["node", "deno", "bun", "browser", "package"]
FIELDS = ["name", "kind", "signature", "summary", "doc", "examples", "differs", "status", "alternative",
          "see_also", "upstream", "upstream_version", "tags"]
REQUIRED = ["name", "kind", "signature", "summary", "examples", "differs", "status"]

# how a mode runs one example's code: "module:function", which returns what
# the mode's prompt prints (catalog/SCHEMA.md, Examples); a mode without one
# cannot have examples run yet
RUNNERS = {"python": "_python_examples:run"}

# the public names of a mode, "module:function" returning them: each must have
# an entry or be in catalog/<mode>/missing.txt (gate 2)
PUBLIC = {"python": "_python_docsearch:public_names"}


def root():
    """The catalog directory of a source tree: $SAGEBRUSH_CATALOG, catalog/
    beside lib/, or catalog/ in the working directory (the builds run the
    CLI bundle from the top of the tree); None without one"""
    here = _os.path.dirname(_os.path.abspath(__file__))
    for d in (_os.environ.get("SAGEBRUSH_CATALOG"), _os.path.join(here, "..", "catalog"), _os.path.join(_os.getcwd(), "catalog")):
        if d and _os.path.exists(_os.path.join(d, "schema.json")):
            return d
    return None


def _embedded():
    """The catalog the CLI bundle carries (sys._sagebrush_catalog), or {}"""
    text = getattr(_sys, "_sagebrush_catalog", None)
    return _json.loads(text) if isinstance(text, str) else {}


def files(mode, base=None):
    """The mode's catalog files, by name"""
    base = base or root()
    if base is None:
        return sorted(g + ".json" for g in _embedded().get(mode, {}).get("groups", {}))
    d = _os.path.join(base, mode)
    if not _os.path.isdir(d):
        return []
    return sorted(f for f in _os.listdir(d) if f.endswith(".json"))


def load(mode, base=None):
    """[(group, entry)] for the mode, in file order: from the source tree's
    catalog/, else from the one the CLI bundle carries"""
    base = base or root()
    out = []
    if base is None:
        groups = _embedded().get(mode, {}).get("groups", {})
        for g in sorted(groups):
            out.extend((g, e) for e in groups[g])
        return out
    for f in files(mode, base):
        with open(_os.path.join(base, mode, f), encoding="utf-8") as fh:
            data = _json.load(fh)
        for e in data if isinstance(data, list) else [data]:
            out.append((f[:-len(".json")], e))
    return out


def missing(mode, base=None):
    """The mode's public names that have no entry yet (missing.txt)"""
    base = base or root()
    if base is None:
        return list(_embedded().get(mode, {}).get("missing", []))
    p = _os.path.join(base, mode, "missing.txt")
    if not _os.path.exists(p):
        return []
    with open(p, encoding="utf-8") as fh:
        return [ln.strip() for ln in fh if ln.strip() and not ln.startswith("#")]


def _strs(v):
    return isinstance(v, list) and all(isinstance(x, str) and x for x in v)


def validate(entry):
    """The ways entry breaks catalog/schema.json: [] when it is valid"""
    errs = []
    if not isinstance(entry, dict):
        return ["an entry must be an object"]
    for k in entry:
        if k not in FIELDS:
            errs.append("unknown field %r" % k)
    for k in REQUIRED:
        if k not in entry:
            errs.append("missing %r" % k)
    name = entry.get("name")
    if "name" in entry and not (isinstance(name, str) and name and not any(c.isspace() for c in name)):
        errs.append("name must be a non-empty string without spaces")
    if "kind" in entry and entry["kind"] not in KINDS:
        errs.append("kind must be one of %s" % ", ".join(KINDS))
    for k in ("signature", "doc"):
        if k in entry and not isinstance(entry[k], str):
            errs.append("%s must be a string" % k)
    s = entry.get("summary")
    if "summary" in entry and not (isinstance(s, str) and 0 < len(s) <= 150):
        errs.append("summary must be a string of 1 to 150 characters")
    status = entry.get("status")
    if "status" in entry and status not in STATUSES:
        errs.append("status must be one of %s" % ", ".join(STATUSES))
    for k in ("differs", "see_also", "tags"):
        if k in entry and not _strs(entry[k]):
            errs.append("%s must be a list of non-empty strings" % k)
    for k in ("alternative", "upstream", "upstream_version"):
        if k in entry and not (isinstance(entry[k], str) and entry[k]):
            errs.append("%s must be a non-empty string" % k)
    exs = entry.get("examples")
    if "examples" in entry:
        if not isinstance(exs, list):
            errs.append("examples must be a list")
            exs = []
        for i, ex in enumerate(exs):
            where = "examples[%d]" % i
            if not isinstance(ex, dict):
                errs.append(where + " must be an object")
                continue
            for k in ex:
                if k not in ("code", "expected", "runtimes"):
                    errs.append("%s: unknown field %r" % (where, k))
            if not (isinstance(ex.get("code"), str) and ex["code"]):
                errs.append(where + ": code must be a non-empty string")
            exp = ex.get("expected")
            if not isinstance(exp, str) or (exp and not exp.endswith("\n")):
                errs.append(where + ": expected must be a string, empty or ending with a newline")
            if "runtimes" in ex and not (isinstance(ex["runtimes"], list) and ex["runtimes"] and all(r in RUNTIMES for r in ex["runtimes"])):
                errs.append("%s: runtimes must be a non-empty list of %s" % (where, ", ".join(RUNTIMES)))
    if status == "absent" and "alternative" not in entry:
        errs.append("an absent entry needs an alternative")
    if status in ("full", "partial", "stub-error") and isinstance(exs, list) and not exs:
        errs.append("a %s entry needs at least one example" % status)
    if status == "partial" and not entry.get("differs"):
        errs.append("a partial entry must say in differs what does not work")
    return errs


def check(modes=None, base=None):
    """Every problem of the catalog's files: ["mode/group: name: problem"]"""
    out = []
    for mode in modes or MODES:
        seen = {}
        for group, e in load(mode, base):
            where = "%s/%s: %s" % (mode, group, e.get("name", "?") if isinstance(e, dict) else "?")
            out.extend("%s: %s" % (where, p) for p in validate(e))
            if isinstance(e, dict):
                key = (e.get("name"), e.get("signature"))
                if key in seen:
                    out.append("%s: (name, signature) also in %s/%s" % (where, mode, seen[key]))
                seen.setdefault(key, group)
        names = set(e.get("name") for _, e in load(mode, base) if isinstance(e, dict))
        for n in missing(mode, base):
            if n in names:
                out.append("%s/missing.txt: %s has an entry now: remove it from missing.txt" % (mode, n))
    return out


def _module(name, group):
    return name.rsplit(".", 1)[0] if "." in name else group


def index(mode, base=None):
    """The mode's built index: each entry, in schema order, with `mode` and
    `module`, and `open_problem` (False) for the readers of the older index"""
    out = []
    for group, e in load(mode, base):
        d = {k: e[k] for k in FIELDS if k in e}
        d["mode"] = mode
        d["module"] = _module(e["name"], group)
        d["open_problem"] = False
        out.append(d)
    return out


def _call(table, mode):
    spec = table.get(mode)
    if spec is None:
        return None
    modname, fn = spec.split(":")
    return getattr(__import__(modname), fn)


def uncovered(mode, base=None):
    """(the public names with no entry and not in missing.txt, the names in
    missing.txt that are no public name); None for a mode that does not list
    its public names yet"""
    public = _call(PUBLIC, mode)
    if public is None:
        return None
    names = set(public())
    have = set(e.get("name") for _, e in load(mode, base))
    miss = set(missing(mode, base))
    return sorted(names - have - miss), sorted(miss - names)


def coverage(base=None):
    """{mode: {entries, with_examples, examples, full, partial, stub-error, absent, missing}}"""
    out = {}
    for mode in MODES:
        es = [e for _, e in load(mode, base)]
        c = {"entries": len(es), "with_examples": sum(1 for e in es if e.get("examples")),
             "examples": sum(len(e.get("examples", [])) for e in es)}
        for s in STATUSES:
            c[s] = sum(1 for e in es if e.get("status") == s)
        c["missing"] = len(missing(mode, base))
        out[mode] = c
    return out


def runner(mode):
    spec = RUNNERS.get(mode)
    if spec is None:
        raise ValueError("no example runner for mode %r yet (lib/_catalog.py RUNNERS)" % mode)
    modname, fn = spec.split(":")
    return getattr(__import__(modname), fn)


def run_example(mode, code):
    """What the mode's prompt prints for code; an error as the mode reports it"""
    run = runner(mode)
    try:
        return run(code)
    except BaseException as err:
        if isinstance(err, (KeyboardInterrupt, SystemExit)):
            raise
        return "%s: %s\n" % (type(err).__name__, err)


def run_all(mode, entries, runtime):
    """[{name, signature, index, got}] for each example of entries that runs
    on runtime"""
    out = []
    for e in entries:
        for i, ex in enumerate(e.get("examples", [])):
            if "runtimes" in ex and runtime not in ex["runtimes"]:
                continue
            out.append({"name": e["name"], "signature": e["signature"], "index": i, "got": run_example(mode, ex["code"])})
    return out


def main(argv):
    argv = list(argv)
    mode = None
    if "--mode" in argv:
        k = argv.index("--mode")
        mode = argv[k + 1] if k + 1 < len(argv) else ""
        del argv[k:k + 2]
        if mode not in MODES:
            print("--mode must be one of %s" % ", ".join(MODES))
            return 2
    if "--index" in argv:
        print(_json.dumps(index(mode or "python"), separators=(",", ":")))
        return 0
    if "--check" in argv:
        probs = check([mode] if mode else None)
        for p in probs:
            print(p)
        print("catalog: %d problem%s" % (len(probs), "" if len(probs) == 1 else "s"))
        return 1 if probs else 0
    if "--missing" in argv:
        # (the public names with no entry: what missing.txt should list)
        public = _call(PUBLIC, mode or "python")
        have = set(e.get("name") for _, e in load(mode or "python"))
        for n in sorted(set(public()) - have):
            print(n)
        return 0
    if "--uncovered" in argv:
        print(_json.dumps(uncovered(mode or "python")))
        return 0
    if "--coverage" in argv:
        print(_json.dumps(coverage(), indent=1))
        return 0
    if "--run" in argv:
        # (the entries on stdin when given, as scripts/catalog-run.mjs sends
        # them to a runtime without the source tree; else the mode's files)
        runtime = argv[argv.index("--runtime") + 1] if "--runtime" in argv else "node"
        if "--entries" in argv:
            with open(argv[argv.index("--entries") + 1], encoding="utf-8") as fh:
                entries = _json.load(fh)
        else:
            entries = [e for _, e in load(mode or "python")]
        print(_json.dumps(run_all(mode or "python", entries, runtime)))
        return 0
    print(__doc__)
    return 2


if __name__ == "__main__":
    _sys.exit(main(_sys.argv[1:]))
