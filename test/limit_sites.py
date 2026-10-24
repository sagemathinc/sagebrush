"""The census of limit-like refusal sites (plan-c0 r2 section 4), for
test/limits.test.ts: a lexical change detector.

What it is, and isn't.  It lists every code line of lib/*.py, engine/**/*.rs
(not target/) and src/**/*.ts that matches the census vocabulary below, and
checks the list against a reviewed registry, test/limit-sites.json.  So a new
or changed site matching the census vocabulary needs a reviewed class and
owner in the diff; a class-3 site among those registered or matched is to be
reached only through lib/_limits.py (checked in review, recorded in the
registry; or, for item G's allowance sites, only through the host's allowance
capability).  It is NOT a proof that every hidden cap is caught: a line outside
the vocabulary slips past (`if n > 1000: raise ValueError("no")`), and the
baseline lines are not coverage.  No AST or control-flow analysis is
attempted; code review remains the backstop.

The vocabulary, case-insensitive: max (but not a call, max( or Math.max(:
the built-in function, not a cap), limit, budget, too large, exceeds,
NotImplementedError, cap and threshold (as words), unsupported, resource.
Comment-only lines are skipped.

A site's fingerprint is file :: enclosing function :: the line's text, with
whitespace outside string literals collapsed and string literals kept
verbatim, then #k for the k-th identical line in that function: moving a line
doesn't change its key; editing it, its message included, does.

The registry maps fingerprint -> {"class", "owner"}; class 1 (shared-resource,
editor, protocol, display or parser protection), 2 (memory guard), 3 (a
work/time/input-size limit of a user's computation: unlimited by default,
opt-in through lib/_limits.py or a trusted host capability, such as an
allowance armed by grading, an instructor's bundle or a server: item G),
their mixtures as the inventories write them ("2+3"), "coverage" (an
unsupported feature, not a cap), "none" (matched
text that refuses nothing).  The sites present at the seed and not yet
classified are the baseline: grandfathered, certifying nothing, and kept out
of the registry, as the first 16 hex digits of each fingerprint's sha256 in
test/limit-sites-baseline.txt (sorted; `--list-baseline REV` prints them
readably).  Only --seed writes it, and the test pins its sha256, so a site
can't be added to the baseline later; a classified site leaves it by being
registered.  A baseline hash whose line is gone is harmless and stays (the
pin is stable).

    python3 test/limit_sites.py --check           the differences (JSON); exit 1 if any
    python3 test/limit_sites.py --register CLASS OWNER [--key K ...]
                                                  register the unregistered sites (or the keys given)
    python3 test/limit_sites.py --prune           drop the registry entries that match no site
    python3 test/limit_sites.py --seed REV SEEDFILE
                                                  write the registry and the baseline from the files at
                                                  REV, classified by SEEDFILE's inventory rows
    python3 test/limit_sites.py --list-baseline REV
                                                  the baseline's sites, readably, from the files at REV
"""
import ast
import hashlib
import json
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REGISTRY = os.path.join(ROOT, "test", "limit-sites.json")
BASELINE = os.path.join(ROOT, "test", "limit-sites-baseline.txt")
VOCAB = re.compile(r"max(?!\s*\()|limit|budget|too large|exceeds|NotImplementedError|\bcap\b|\bthreshold\b|unsupported|resource", re.I)
CLASSES = {"1", "2", "3", "1+2", "1+3", "2+3", "1+2+3", "coverage", "none"}


def short(key):
    """A baseline entry: the first 16 hex digits of the fingerprint's sha256."""
    return hashlib.sha256(key.encode("utf-8")).hexdigest()[:16]


def tracked(rev=None):
    """The census's files, at REV (git) or in the working tree."""
    if rev is None:
        out = subprocess.run(["git", "ls-files"], cwd=ROOT, capture_output=True, text=True, check=True).stdout
    else:
        out = subprocess.run(["git", "ls-tree", "-r", "--name-only", rev], cwd=ROOT, capture_output=True, text=True, check=True).stdout
    keep = []
    for p in out.split("\n"):
        if re.fullmatch(r"lib/[^/]+\.py", p) or (p.startswith("engine/") and p.endswith(".rs") and "/target/" not in p) \
                or (p.startswith("src/") and p.endswith(".ts")):
            keep.append(p)
    return sorted(keep)


def read(path, rev=None):
    if rev is None:
        with open(os.path.join(ROOT, path), encoding="utf-8", errors="replace") as f:
            return f.read()
    return subprocess.run(["git", "show", "%s:%s" % (rev, path)], cwd=ROOT, capture_output=True, check=True).stdout.decode("utf-8", "replace")


def normalize(line):
    """The line's text: whitespace outside string literals collapsed to one
    space (and stripped), string literals ('', "", ``) kept verbatim."""
    out, i, n, quote, space = [], 0, len(line), None, False
    while i < n:
        c = line[i]
        if quote:
            out.append(c)
            if c == "\\" and i + 1 < n:
                out.append(line[i + 1])
                i += 2
                continue
            if c == quote:
                quote = None
        elif c in "\"'`":
            if space and out:
                out.append(" ")
            space = False
            quote = c
            out.append(c)
        elif c.isspace():
            space = True
        else:
            if space and out:
                out.append(" ")
            space = False
            out.append(c)
        i += 1
    return "".join(out)


def comment_only(t, lang):
    if lang == "py":
        return t.startswith("#")
    return t.startswith("//") or t.startswith("/*") or t.startswith("*")


def py_functions(text):
    """line -> the innermost enclosing def/class qualname ("" at module level)."""
    try:
        tree = ast.parse(text)
    except SyntaxError:
        return {}
    spans = []

    def walk(node, prefix):
        for ch in ast.iter_child_nodes(node):
            if isinstance(ch, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                q = prefix + ch.name
                spans.append((ch.lineno, ch.end_lineno or ch.lineno, q))
                walk(ch, q + ".")
            else:
                walk(ch, prefix)
    walk(tree, "")
    where = {}
    for lo, hi, q in sorted(spans, key=lambda s: (s[0], -s[1])):
        for k in range(lo, hi + 1):
            where[k] = q  # (later, inner spans overwrite outer ones)
    return where


_DECL = {"rs": re.compile(r"^\s*(?:pub(?:\([^)]*\))?\s+)?(?:const\s+|async\s+|unsafe\s+|extern\s+\"[^\"]*\"\s+)*fn\s+(\w+)"),
         "ts": re.compile(r"^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\*?\s+(\w+)|(?:public\s+|private\s+|protected\s+|static\s+|readonly\s+|async\s+|get\s+|set\s+)*(\w+)\s*(?:<[^>]*>)?\s*\([^;]*\)\s*(?::\s*[^=;{]+)?\{\s*$|(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*(?::\s*[^=]+)?=>|\w+\s*=>))")}


def sites(rev=None):
    """[(fingerprint, path, line number)] of every census site."""
    out = []
    for path in tracked(rev):
        text = read(path, rev)
        lang = "py" if path.endswith(".py") else ("rs" if path.endswith(".rs") else "ts")
        funcs = py_functions(text) if lang == "py" else None
        current, seen = "", {}
        for no, line in enumerate(text.split("\n"), 1):
            if lang != "py":
                m = _DECL[lang].match(line)
                if m:
                    name = next(g for g in m.groups() if g)
                    if name not in ("if", "for", "while", "switch", "catch", "return", "function"):
                        current = name
            t = line.strip()
            if not t or comment_only(t, lang) or not VOCAB.search(line):
                continue
            fn = funcs.get(no, "") if lang == "py" else current
            base = "%s :: %s :: %s" % (path, fn, normalize(line))
            k = seen.get(base, 0)
            seen[base] = k + 1
            out.append((base + " #%d" % k, path, no))
    return out


def load():
    with open(REGISTRY, encoding="utf-8") as f:
        return json.load(f)


def save(reg):
    with open(REGISTRY, "w", encoding="utf-8") as f:
        json.dump(reg, f, indent=1, sort_keys=True, ensure_ascii=False)
        f.write("\n")


def baseline_keys():
    with open(BASELINE, encoding="utf-8") as f:
        return set(l for l in f.read().split("\n") if l)


def baseline_sha256():
    with open(BASELINE, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def check():
    reg = load()
    now = {k for k, _, _ in sites()}
    base = baseline_keys()
    bad = {
        "unregistered": sorted(k for k in now if k not in reg and short(k) not in base),
        "stale": sorted(set(reg) - now),
        "invalid": sorted(k for k, v in reg.items() if v.get("class") not in CLASSES or not v.get("owner")),
    }
    return {"baseline_sha256": baseline_sha256(), "sites": len(now), "registered": len(reg), "problems": bad}


def seed(rev, seedfile):
    """The registry from the files at rev: a site inside a seed row's file
    and line ranges gets the row's class and owner, every other "baseline"."""
    with open(seedfile, encoding="utf-8") as f:
        rows = json.load(f)["rows"]
    reg, keys = {}, []
    for key, path, no in sites(rev):
        entry = None
        for r in rows:
            for ref in r["refs"]:
                if ref["path"] == path and any(lo <= no <= hi for lo, hi in ref["lines"]):
                    entry = {"class": r["class"], "owner": r["owner"], "row": r["id"]}
                    break
            if entry:
                break
        if entry:
            reg[key] = entry
        else:
            keys.append(key)
    save(reg)
    with open(BASELINE, "w", encoding="utf-8") as f:
        f.write("".join(h + "\n" for h in sorted(set(short(k) for k in keys))))
    return len(reg) + len(keys), len(keys)


def main(argv):
    if argv[:1] == ["--check"]:
        r = check()
        print(json.dumps(r, indent=1))
        return 1 if any(r["problems"].values()) else 0
    if argv[:1] == ["--seed"] and len(argv) == 3:
        print("%d sites, %d baseline" % seed(argv[1], argv[2]))
        return 0
    if argv[:1] == ["--list-baseline"] and len(argv) == 2:
        base = baseline_keys()
        for k, _, _ in sites(argv[1]):
            if short(k) in base:
                print(k)
        return 0
    if argv[:1] == ["--prune"]:
        reg = load()
        now = {k for k, _, _ in sites()}
        drop = [k for k in reg if k not in now]
        for k in drop:
            del reg[k]
        save(reg)
        print("%d pruned" % len(drop))
        return 0
    if argv[:1] == ["--register"] and len(argv) >= 3:
        cls, owner, keys = argv[1], argv[2], argv[4::2] if "--key" in argv else None
        if cls not in CLASSES:
            print("class must be one of %s" % ", ".join(sorted(CLASSES)))
            return 2
        reg = load()
        now = {k for k, _, _ in sites()}
        base = baseline_keys()
        todo = keys if keys is not None else sorted(k for k in now if k not in reg and short(k) not in base)
        for k in todo:
            if k not in now:
                print("not a current site: %s" % k)
                return 2
            reg[k] = {"class": cls, "owner": owner}
        save(reg)
        print("%d registered" % len(todo))
        return 0
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
