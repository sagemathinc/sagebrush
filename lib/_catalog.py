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
FIELDS = ["name", "aliases", "kind", "signature", "summary", "doc", "examples", "differs", "status", "alternative",
          "domains", "see_also", "upstream", "upstream_version", "tags", "source"]
REQUIRED = ["name", "kind", "signature", "summary", "examples", "differs", "status"]
# the sizes schema.json allows (what a search hands an agent stays small:
# lib/_pyjs_docsearch.py budgets, HARD-012-1)
MAX_CHARS = {"signature": 1000, "doc": 20000, "alternative": 500}
MAX_ITEMS = {"differs": 20, "examples": 10, "aliases": 20, "see_also": 20, "tags": 20, "domains": 20}
ITEM_CHARS = {"differs": 500}
CODE_CHARS, EXPECTED_CHARS = 4000, 8000

# how a mode runs one example's code: "module:function", which returns what
# the mode's prompt prints (catalog/SCHEMA.md, Examples); a mode without one
# cannot have examples run yet
RUNNERS = {"python": "_python_examples:run", "matlab": "_matlab_examples:run"}

# what a mode's examples may use without importing it, "module:NAME" (a
# string of import lines); the built index gives each example the lines it
# needs, as `setup`, so that it runs where it is copied to (CORR-012-1)
PRELUDES = {"python": "_python_examples:PRELUDE"}

# how a mode finds the object a name names, "module:function" (None: none),
# for the entry's link to its source (source_url)
SOURCES = {"python": "_python_docsearch:resolve"}
REPO = "https://github.com/sagemathinc/sagebrush"

# the public names of a mode, "module:function" returning them: each must have
# an entry or be in catalog/<mode>/missing.txt (gate 2)
PUBLIC = {"python": "_python_docsearch:public_names", "magma": "_magma_docsearch:bound_names", "matlab": "_matlab_docsearch:public_names"}
# (Magma mode's examples run through the CLI, which translates Magma code:
# test/magma-catalog.test.ts)


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


def _read(mode, base=None):
    """[(group, the file's JSON, or None and the reason it is unreadable)]"""
    base = base or root()
    if base is None:
        groups = _embedded().get(mode, {}).get("groups", {})
        return [(g, groups[g], None) for g in sorted(groups)]
    out = []
    for f in files(mode, base):
        try:
            with open(_os.path.join(base, mode, f), encoding="utf-8") as fh:
                out.append((f[:-len(".json")], _json.load(fh), None))
        except ValueError as err:
            out.append((f[:-len(".json")], None, "not JSON: %s" % err))
    return out


def load(mode, base=None):
    """[(group, entry)] for the mode, in file order: from the source tree's
    catalog/, else from the one the CLI bundle carries (a file that is no
    JSON array has none: check() reports it)"""
    out = []
    for group, data, _ in _read(mode, base):
        if isinstance(data, list):
            out.extend((group, e) for e in data)
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
    if "aliases" in entry and not (_strs(entry["aliases"]) and not any(any(c.isspace() for c in a) for a in entry["aliases"])):
        errs.append("aliases must be a list of names without spaces")
    for k in ("differs", "domains", "see_also", "tags"):
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
    for k, n in MAX_CHARS.items():
        if isinstance(entry.get(k), str) and len(entry[k]) > n:
            errs.append("%s is longer than %d characters" % (k, n))
    for k, n in MAX_ITEMS.items():
        if isinstance(entry.get(k), list) and len(entry[k]) > n:
            errs.append("%s has more than %d items" % (k, n))
    for k, n in ITEM_CHARS.items():
        if isinstance(entry.get(k), list) and any(isinstance(x, str) and len(x) > n for x in entry[k]):
            errs.append("an item of %s is longer than %d characters" % (k, n))
    for i, ex in enumerate(exs if isinstance(exs, list) else []):
        if isinstance(ex, dict) and isinstance(ex.get("code"), str) and len(ex["code"]) > CODE_CHARS:
            errs.append("examples[%d]: code is longer than %d characters" % (i, CODE_CHARS))
        if isinstance(ex, dict) and isinstance(ex.get("expected"), str) and len(ex["expected"]) > EXPECTED_CHARS:
            errs.append("examples[%d]: expected is longer than %d characters" % (i, EXPECTED_CHARS))
    src = entry.get("source")
    if "source" in entry and not (isinstance(src, str) and src.startswith("https://") and len(src) <= 300 and not any(c.isspace() for c in src)):
        errs.append("source must be an https:// URL of at most 300 characters")
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
        # (a file is one JSON array of entries, as catalog/schema.json says)
        for group, data, why in _read(mode, base):
            if why is not None or not isinstance(data, list):
                out.append("%s/%s.json: %s" % (mode, group, why or "the file must be a JSON array of entries"))
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
        for group, e in load(mode, base):
            for a in (e.get("aliases") or []) if isinstance(e, dict) and isinstance(e.get("aliases"), list) else []:
                if a in names:
                    out.append("%s/%s: %s: the alias %s is another entry's name" % (mode, group, e.get("name"), a))
        names |= _aliases(mode, base)
        for n in missing(mode, base):
            if n in names:
                out.append("%s/missing.txt: %s has an entry now: remove it from missing.txt" % (mode, n))
    return out


def _aliases(mode, base=None):
    """The names the mode's entries cover as aliases"""
    out = set()
    for _, e in load(mode, base):
        if isinstance(e, dict) and isinstance(e.get("aliases"), list):
            out.update(a for a in e["aliases"] if isinstance(a, str))
    return out


def _prelude(mode):
    spec = PRELUDES.get(mode)
    if spec is None:
        return ""
    modname, attr = spec.split(":")
    return getattr(__import__(modname), attr)


def setup(prelude, code):
    """The lines of prelude (import statements) that code needs: each
    reduced to the names code uses, as a word, in the order given"""
    import re
    used = set(re.findall(r"[A-Za-z_][A-Za-z0-9_]*", code))
    out = []
    for line in prelude.split("\n"):
        line = line.strip()
        if line.startswith("from ") and " import " in line:
            head, names = line.split(" import ", 1)
            keep = [n.strip() for n in names.split(",") if (n.split(" as ")[-1].strip()) in used]
            if keep:
                out.append(head + " import " + ", ".join(keep))
        elif line.startswith("import "):
            keep = [n.strip() for n in line[len("import "):].split(",") if n.split(" as ")[-1].strip().split(".")[0] in used]
            if keep:
                out.append("import " + ", ".join(keep))
    return "\n".join(out)


def source_ref():
    """The commit the source links name: $SAGEBRUSH_SOURCE_REF (empty: none),
    else the one the CLI bundle was built from (sys._sagebrush_commit), else
    None (no links)"""
    ref = _os.environ.get("SAGEBRUSH_SOURCE_REF")
    if ref is not None:
        return ref or None
    c = getattr(_sys, "_sagebrush_commit", None)
    return c if isinstance(c, str) and c else None


def _lib_text(rel):
    """The text of lib/<rel>: the CLI bundle's own copy, else the file"""
    reader = getattr(_sys, "_sagebrush_lib_file", None)
    if reader is not None:
        text = reader(rel)
        if isinstance(text, str):
            return text
    try:
        with open(_os.path.join(_os.path.dirname(_os.path.abspath(__file__)), rel), encoding="utf-8") as fh:
            return fh.read()
    except OSError:
        return None


def _span(lines, first):
    """The last line of the definition starting at line `first` (1-based):
    the line before the next one indented no more than it (blank and
    comment lines aside, trailing ones not counted)"""
    head = lines[first - 1]
    indent = len(head) - len(head.lstrip())
    last = first
    k = first
    # (decorators, then the def or class line itself)
    while k <= len(lines) and lines[k - 1].lstrip().startswith("@"):
        k += 1
    for n in range(k + 1, len(lines) + 1):
        line = lines[n - 1]
        s = line.strip()
        if not s or s.startswith("#"):
            continue
        if len(line) - len(line.lstrip()) <= indent:
            break
        last = n
    return max(last, k)


def source_url(obj, ref):
    """The GitHub link to the lines of lib/ that define obj, at the commit
    ref: .../blob/REF/lib/FILE#Lstart-Lend; None for what is not Python of
    lib/ (the runtime's own functions, in TypeScript)"""
    obj = getattr(obj, "__wrapped__", obj)
    code = getattr(obj, "__code__", None)
    if code is not None:
        path, first = getattr(code, "co_filename", None), getattr(code, "co_firstlineno", None)
    elif isinstance(obj, type):
        mod = _sys.modules.get(getattr(obj, "__module__", None) or "")
        path, first = getattr(mod, "__file__", None), obj.__dict__.get("__firstlineno__")
    else:
        return None
    if not isinstance(path, str) or not isinstance(first, int) or first < 1:
        return None
    libdir = _os.path.dirname(_os.path.abspath(__file__))
    if not path.startswith(libdir + "/"):
        return None
    rel = path[len(libdir) + 1:]
    text = _lib_text(rel)
    if text is None:
        return None
    lines = text.split("\n")
    if first > len(lines):
        return None
    return "%s/blob/%s/lib/%s#L%d-L%d" % (REPO, ref, rel, first, _span(lines, first))


def _module(name, group):
    return name.rsplit(".", 1)[0] if "." in name else group


def index(mode, base=None):
    """The mode's built index: each entry, in schema order, with `mode` and
    `module`, and `open_problem` (False) for the readers of the older index"""
    out = []
    prelude = _prelude(mode)
    ref = source_ref()
    resolve = _call(SOURCES, mode) if ref else None
    for group, e in load(mode, base):
        d = {k: e[k] for k in FIELDS if k in e}
        if "source" not in d and resolve is not None:
            try:
                url = source_url(resolve(e["name"]), ref)
            except Exception:
                url = None
            if url:
                d["source"] = url
        if prelude and isinstance(d.get("examples"), list):
            d["examples"] = [dict(x, setup=setup(prelude, x["code"])) for x in d["examples"]]
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
    have = set(e.get("name") for _, e in load(mode, base)) | _aliases(mode, base)
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


def compare(entries, results, runtime):
    """The problems of a runtime's results for entries: each example that
    runs on runtime (None: every example) needs exactly one result, equal to
    its expected output (a missing, extra or repeated result is a problem
    too)"""
    want = {}
    for e in entries:
        for i, ex in enumerate(e.get("examples", [])):
            if runtime is None or "runtimes" not in ex or runtime in ex["runtimes"]:
                want[(e["name"], e["signature"], i)] = ex
    probs = []
    seen = set()
    for r in results:
        key = (r.get("name"), r.get("signature"), r.get("index"))
        label = "%s example %s" % (key[0], key[2] + 1 if isinstance(key[2], int) else "?")
        if key in seen:
            probs.append("%s: a second result" % label)
            continue
        seen.add(key)
        ex = want.get(key)
        if ex is None:
            probs.append("%s: a result for no such example" % label)
        elif r.get("got") != ex["expected"]:
            probs.append("%s\n    code:     %s\n    expected: %r\n    got:      %r" % (label, ex["code"].replace("\n", "; "), ex["expected"], r.get("got")))
    for key in want:
        if key not in seen:
            probs.append("%s example %d: no result" % (key[0], key[2] + 1))
    return probs


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
        have = set(e.get("name") for _, e in load(mode or "python")) | _aliases(mode or "python")
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
