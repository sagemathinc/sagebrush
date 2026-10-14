"""Write design/magma-coverage.md, the map of which Magma intrinsics work in
Sagebrush's Magma front end, from a measured corpus.

    python3 scripts/magma-coverage.py [CORPUS] > design/magma-coverage.md

CORPUS (default /scratch/magma-coverage, kept out of the repository) holds:
  handbook.json  chapters, intrinsic signatures and examples, extracted from
                 the Magma Handbook (HTML, the version in meta.json);
  results/*.json each example run on stdin under Magma (twice) and under
                 `sagebrush --magma`, split into cells;
  names.txt      the intrinsics the measured Sagebrush binds (lib/_magma.py);
  meta.json      the Magma version, the Sagebrush commit, the date.

The map has names, statuses and counts, and type signatures only for the
intrinsics Sagebrush binds; missing intrinsics appear as names with the
number of examples that call them.  No Handbook text or example code is in
this script or the map: both are read from the corpus at run time.

A cell is "stable" when Magma prints the same thing on both runs; it
"matches" when Sagebrush's output is byte for byte Magma's.  An example's
clean prefix is its cells up to the first stable cell that doesn't match;
only calls in the clean prefix count as evidence, so one failure does not
spoil the cells after it.  Status of an intrinsic in a chapter, from the
calls `Name(` in that chapter's examples:
  works     bound, and every clean call's cell matches;
  partial   bound, some clean calls' cells match and some don't;
  differs   bound, and no clean call's cell matches;
  untested  bound (possibly only for other types), with no clean call in
            this chapter's examples;
  missing   not bound in Sagebrush's Magma runtime.
"""
import collections, glob, json, os, re, sys

CORPUS = sys.argv[1] if len(sys.argv) > 1 else "/scratch/magma-coverage"

# Chapters that get one row per intrinsic, by title (in the order of the
# research priorities: foundations, elliptic curves, number fields, groups,
# low-genus curves, modular forms and symbols).
DETAIL = [
    "STATEMENTS AND EXPRESSIONS", "FUNCTIONS, PROCEDURES AND PACKAGES", "INPUT AND OUTPUT",
    "ENVIRONMENT AND OPTIONS", "SETS", "SEQUENCES", "TUPLES AND CARTESIAN PRODUCTS", "LISTS",
    "ASSOCIATIVE ARRAYS", "COPRODUCTS", "RECORDS", "MAPPINGS",
    "INTRODUCTION TO RINGS", "RING OF INTEGERS", "INTEGER RESIDUE CLASS RINGS", "RATIONAL FIELD",
    "FINITE FIELDS", "UNIVARIATE POLYNOMIAL RINGS", "MULTIVARIATE POLYNOMIAL RINGS",
    "REAL AND COMPLEX FIELDS", "MATRICES", "VECTOR SPACES",
    "ELLIPTIC CURVES", "ELLIPTIC CURVES OVER FINITE FIELDS", "ELLIPTIC CURVES OVER Q AND NUMBER FIELDS",
    "NUMBER FIELDS", "QUADRATIC FIELDS", "CYCLOTOMIC FIELDS", "ORDERS AND ALGEBRAIC FIELDS",
    "GALOIS THEORY OF NUMBER FIELDS", "CLASS FIELD THEORY",
    "GROUPS", "PERMUTATION GROUPS", "ABELIAN GROUPS",
    "HYPERELLIPTIC CURVES",
    "MODULAR FORMS", "MODULAR SYMBOLS",
]

# The first checklist (research priorities, Oct 14 2026).
CHECKLIST = [
    "Factorization", "Roots", "GroebnerBasis", "LLL", "MaximalOrder", "ClassGroup", "UnitGroup",
    "GaloisGroup", "IdentifyGroup", "Subgroups", "IsIsomorphic", "AutomorphismGroup", "CharacterTable",
    "Conductor", "MinimalModel", "RankBounds", "TorsionSubgroup", "IntegralPoints", "Chabauty",
    "ModularSymbols", "CuspidalSubspace", "NewSubspace", "NewformDecomposition", "HeckeOperator",
]

KEYWORDS = set(("and or not xor eq ne lt le gt ge in notin subset notsubset cat div mod join meet diff sdiff is "
                "cmpeq cmpne if then elif else end for to by do while repeat until break continue function "
                "procedure func proc return case when print printf error assert true false select where "
                "forward local quit exit vprint require delete assigned intrinsic time eval declare clear "
                "sub quo ext hom elt rec recformat ideal lideal rideal car").split())


def load():
    h = json.load(open(os.path.join(CORPUS, "handbook.json")))
    res = {}
    for f in sorted(glob.glob(os.path.join(CORPUS, "results", "*.json"))):
        r = json.load(open(f))
        res[r["id"]] = r
    names = set(open(os.path.join(CORPUS, "names.txt")).read().split())
    meta = json.load(open(os.path.join(CORPUS, "meta.json")))
    return h, res, names, meta


def code_only(lines):
    """The input without string literals and comments."""
    s = "\n".join(lines)
    s = re.sub(r'"(\\.|[^"\\])*"', '""', s)
    s = re.sub(r"//[^\n]*", "", s)
    s = re.sub(r"/\*.*?\*/", "", s, flags=re.S)
    return s


def user_names(cells):
    """Names the example itself defines (assigned, functions, loop variables)."""
    s = code_only([l for c in cells for l in c["input"]])
    out = set()
    for m in re.finditer(r"([A-Za-z_][A-Za-z0-9_]*(?:\s*,\s*[A-Za-z_~][A-Za-z0-9_]*)*)\s*(?:<[^>]*>)?\s*:=", s):
        out.update(re.findall(r"[A-Za-z_][A-Za-z0-9_]*", m.group(1)))
    out.update(re.findall(r"\b(?:function|procedure|intrinsic|for|forward)\s+([A-Za-z_][A-Za-z0-9_]*)", s))
    return out


def calls(lines, own):
    s = code_only(lines)
    out = []
    for m in re.finditer(r"(?<![A-Za-z0-9_.`'])([A-Za-z_][A-Za-z0-9_]*)\s*\(", s):
        n = m.group(1)
        if n not in KEYWORDS and n not in own:
            out.append(n)
    return out


ERR = re.compile(r"^(User error|Runtime error)", re.M)


def syntax_token(s, k):
    """The token at the caret of the syntax error reported at s[k]."""
    before = s[:k].rstrip("\n").split("\n")
    if len(before) < 2 or not before[-2].startswith(">> "):
        return "?"
    # the caret line is col + 2 spaces and "^" (col counts from 1)
    text, col = before[-2][3:], len(before[-1]) - 4
    mt = re.match(r"[A-Za-z_][A-Za-z0-9_]*|:=|\.\.|->|[^\sA-Za-z0-9_]", text[col:])
    tok = mt.group(0) if mt else "end of line"
    mp = re.search(r"([A-Za-z_][A-Za-z0-9_]*)\s*$", text[:col])
    if tok == "<" and mp:
        tok = mp.group(1) + "<"
    return tok


ERRORS = re.compile(r"User error: bad syntax|User error: syntax error at end of input|"
                    r"User error: Identifier '([^']+)' has not been declared or assigned|Runtime error[^:\n]*: ([^\n]*)")


def classify(cell, r):
    """Why a stable cell does not match: (kind, detail), from the first error
    Sagebrush reports that Magma doesn't."""
    s, m = cell["sb"], cell["magma"]
    if s is None:
        err = r["sb"]["err"]
        if r["sb"]["code"] == "timeout":
            return "timeout", "Sagebrush timed out"
        if "SyntaxError" in err:
            return "invalid Python", "the translation is not valid Python"
        last = [l for l in err.strip().split("\n") if l.strip()]
        return "crash", re.sub(r"\d+", "N", last[-1][:80]) if last else "no output"
    for e in ERRORS.finditer(s):
        if e.group(0) in m:
            continue
        g = e.group(0)
        if g.endswith("bad syntax"):
            return "syntax", "syntax: '%s'" % syntax_token(s, e.start())
        if "end of input" in g:
            return "syntax", "syntax: end of input"
        if e.group(1):
            return "undeclared", e.group(1)
        msg = re.sub(r"'[^']*'", "'X'", e.group(2))
        return "runtime", re.sub(r"\d+", "N", msg)[:70]
    if re.sub(r"\s+", "", s) == re.sub(r"\s+", "", m):
        return "whitespace", "line breaks or spaces differ"
    if ERR.search(m) and not ERR.search(s):
        return "no error", "Magma reports an error, Sagebrush doesn't"
    return "differs", "output differs"


def analyze(h, res, names):
    hb_names = {s["name"] for s in h["signatures"] if s["kind"] == "call"}
    ex_by_ch = collections.defaultdict(list)
    for e in h["examples"]:
        ex_by_ch[e["chapter"]].append(e["id"])
    evidence = collections.defaultdict(lambda: {"ok": 0, "bad": 0, "why": collections.Counter()})  # (ch, name)
    used_in = collections.defaultdict(set)  # name -> example ids using it
    blockers = collections.Counter()
    blocker_kind = collections.Counter()
    blocker_ex = collections.defaultdict(list)
    ex_stats = {}
    syntax_any = collections.defaultdict(set)  # token -> examples where it fails to parse
    for i, r in res.items():
        cells = r["cells"]
        own = user_names(cells)
        clean = True
        first = None
        nstable = nmatch = 0
        for c in cells:
            names_here = calls(c["input"], own)
            for n in names_here:
                used_in[n].add(i)
            stable = c["magma"] is not None and c["magma"] == c["magma2"]
            if not stable:
                continue
            nstable += 1
            for e in re.finditer(r"User error: bad syntax", c["sb"] or ""):
                if "bad syntax" not in c["magma"]:
                    syntax_any[syntax_token(c["sb"], e.start())].add(i)
            ok = c["sb"] == c["magma"]
            nmatch += ok
            why = None if ok else classify(c, r)
            if clean:
                for n in set(names_here):
                    ev = evidence[(r["chapter"], n)]
                    if ok:
                        ev["ok"] += 1
                    else:
                        ev["bad"] += 1
                        ev["why"][why[0] if why[0] != "undeclared" else "undeclared " + why[1]] += 1
            if not ok and clean:
                clean = False
                first = why
        if first:
            kind, detail = first
            key = "missing: " + detail if kind == "undeclared" else detail if kind in ("syntax", "runtime", "crash") else kind
            if kind == "undeclared" and (detail not in hb_names or detail in own):
                key = "undeclared variable"
            blockers[key] += 1
            blocker_kind[kind] += 1
            blocker_ex[key].append(i)
        ex_stats[i] = {"cells": len(cells), "stable": nstable, "match": nmatch, "complete": first is None and nstable > 0}
    return evidence, used_in, blockers, blocker_kind, blocker_ex, ex_stats, syntax_any


def sig_text(s):
    return "%s(%s) -> %s" % (s["name"], ", ".join(s["args"]), ", ".join(s["ret"]) or "()")


def status(name, ch, names, evidence):
    if name not in names:
        return "missing", ""
    ev = evidence.get((ch, name))
    if not ev or ev["ok"] + ev["bad"] == 0:
        return "untested", ""
    note = ", ".join("%s %d" % kv for kv in ev["why"].most_common(2))
    if ev["bad"] == 0:
        return "works", "%d cells" % ev["ok"]
    if ev["ok"]:
        return "partial", "%d match; %s" % (ev["ok"], note)
    return "differs", note


def esc(s):
    return s.replace("|", "\\|").replace("<", "&lt;").replace(">", "&gt;")


def main():
    h, res, names, meta = load()
    evidence, used_in, blockers, blocker_kind, blocker_ex, ex_stats, syntax_any = analyze(h, res, names)
    chs = h["chapters"]
    sigs_by = collections.defaultdict(lambda: collections.defaultdict(list))
    for s in h["signatures"]:
        if s["kind"] == "call":
            sigs_by[s["chapter"]][s["name"]].append(s)
    ops_by = collections.Counter(s["chapter"] for s in h["signatures"] if s["kind"] != "call")
    P = print
    P("# Magma coverage map")
    P()
    P("Which of Magma's intrinsics work in Sagebrush's Magma front end (`src/magma.ts`, `lib/_magma.py`),")
    P("measured by running the Handbook's examples under both systems. Generated by")
    P("`scripts/magma-coverage.py` from a corpus kept outside the repository; do not edit by hand.")
    P()
    P("- Magma: %s (the oracle), and the intrinsic list of its Handbook." % meta["magma"])
    P("- Sagebrush: commit `%s` (%s)." % (meta["sagebrush"][:12], meta.get("sagebrush_branch", "")))
    P("- Measured: %s. Each example is one program read on stdin (a session) by both systems," % meta["date"])
    P("  split into cells at the Handbook's outputs; Magma runs it twice to find unstable output.")
    P()
    P("Status of an intrinsic in a chapter, from the calls to it in that chapter's examples. Only cells")
    P("before an example's first mismatch count, and a status covers only the calls the examples make, not")
    P("every signature:")
    P()
    P("- **works**: Sagebrush binds it and every such cell matches Magma byte for byte;")
    P("- **partial**: some of those cells match and some don't; **differs**: none match;")
    P("- **untested**: the name is bound (possibly only for other types), but no example in the chapter")
    P("  reaches a call to it;")
    P("- **missing**: not bound in Sagebrush's Magma runtime.")
    P()
    P("The evidence column counts the cells and, for failures, why they failed (the first error).")
    P()
    allstable = sum(e["stable"] for e in ex_stats.values())
    allmatch = sum(e["match"] for e in ex_stats.values())
    complete = sum(e["complete"] for e in ex_stats.values())
    P("## Summary")
    P()
    total_names = sum(len(v) for v in sigs_by.values())
    st_all = collections.Counter()
    for c in chs:
        for n in sigs_by[c["n"]]:
            st_all[status(n, c["n"], names, evidence)[0]] += 1
    P("| | count |")
    P("|---|---:|")
    P("| examples run | %d |" % len(ex_stats))
    P("| examples whose every stable cell matches | %d |" % complete)
    P("| stable cells | %d |" % allstable)
    P("| cells that match byte for byte | %d (%.1f%%) |" % (allmatch, 100.0 * allmatch / max(1, allstable)))
    P("| intrinsic signatures (named, not operators) | %d |" % sum(len(l) for v in sigs_by.values() for l in v.values()))
    P("| intrinsics (name, chapter) | %d |" % total_names)
    for k in ("works", "partial", "differs", "untested", "missing"):
        P("| ... %s | %d |" % (k, st_all[k]))
    P("| names bound by the Sagebrush runtime | %d |" % len(names))
    P()
    P("## What stops the examples")
    P()
    P("The first stable cell that doesn't match, per example, by kind:")
    P()
    P("| kind | examples |")
    P("|---|---:|")
    for k, v in blocker_kind.most_common():
        P("| %s | %d |" % (k, v))
    P()
    P("The 60 most common first blockers (`missing: X` is an intrinsic Sagebrush doesn't bind; `syntax: 'T'` is")
    P("where the translator stopped):")
    P()
    P("| first blocker | examples |")
    P("|---|---:|")
    for k, v in blockers.most_common(60):
        P("| %s | %d |" % (esc(k), v))
    P()
    P("## Syntax the translator rejects")
    P()
    P("By the number of examples where a stable cell fails to parse at that token (anywhere, not only first):")
    P()
    P("| token | examples |")
    P("|---|---:|")
    for n, v in sorted(syntax_any.items(), key=lambda kv: (-len(kv[1]), kv[0]))[:50]:
        P("| `%s` | %d |" % (esc(n), len(v)))
    P()
    P("## Missing intrinsics used by the examples")
    P()
    hb_names = {s["name"] for s in h["signatures"] if s["kind"] == "call"}
    unbound = sorted(((len(v), n) for n, v in used_in.items() if n in hb_names and n not in names), key=lambda kn: (-kn[0], kn[1]))
    listed = [(k, n) for k, n in unbound if k >= 2]
    P("%d of the Handbook's %d intrinsic names are not bound in Sagebrush; %d of them are called by the" % (
        len(hb_names - names), len(hb_names), len(unbound)))
    P("examples. Those called by at least 2 examples (%d), by the number of examples:" % len(listed))
    P()
    P("| intrinsic | examples |")
    P("|---|---:|")
    for k, n in listed:
        P("| %s | %d |" % (n, k))
    P()
    P("## The first checklist")
    P()
    P("Status in each chapter that documents it (chapter numbers as in the table below).")
    P()
    P("| intrinsic | signatures | chapters | bound | measured |")
    P("|---|---:|---:|---|---|")
    for n in CHECKLIST:
        per, nsig, nch, untested = [], 0, 0, 0
        for c in chs:
            if n in sigs_by[c["n"]]:
                nsig += len(sigs_by[c["n"]][n])
                nch += 1
                st = status(n, c["n"], names, evidence)[0]
                if st == "untested":
                    untested += 1
                elif st != "missing":
                    per.append("%d %s" % (c["n"], st))
        if untested:
            per.append("untested in %d" % untested)
        P("| %s | %d | %d | %s | %s |" % (n, nsig, nch, "yes" if n in names else "no", "; ".join(per) or "-"))
    P()
    P("## Chapters")
    P()
    P("| # | chapter | examples | complete | cells matched | intrinsics | works | partial | differs | untested | missing | operators |")
    P("|---:|---|---:|---:|---|---:|---:|---:|---:|---:|---:|---:|")
    for c in chs:
        exs = [ex_stats[e["id"]] for e in h["examples"] if e["chapter"] == c["n"] and e["id"] in ex_stats]
        st = collections.Counter(status(n, c["n"], names, evidence)[0] for n in sigs_by[c["n"]])
        stable = sum(e["stable"] for e in exs)
        P("| %d | %s | %d | %d | %d/%d | %d | %d | %d | %d | %d | %d | %d |" % (
            c["n"], c["title"].title(), len(exs), sum(e["complete"] for e in exs), sum(e["match"] for e in exs), stable,
            len(sigs_by[c["n"]]), st["works"], st["partial"], st["differs"], st["untested"], st["missing"], ops_by[c["n"]]))
    P()
    P("## Intrinsics, chapter by chapter")
    P()
    P("Chapters in priority order: the intrinsics Sagebrush binds, with the argument and return types")
    P("of their documented signatures.")
    for t in DETAIL:
        c = next((c for c in chs if c["title"] == t), None)
        if c is None:
            continue
        P()
        P("### %d. %s" % (c["n"], c["title"].title()))
        P()
        rows = [n for n in sorted(sigs_by[c["n"]], key=str.lower) if n in names]
        missing = len(sigs_by[c["n"]]) - len(rows)
        if not rows:
            P("Nothing bound yet; %d intrinsics missing." % missing)
            continue
        P("%d intrinsics bound; %d missing (not listed here)." % (len(rows), missing))
        P()
        P("| intrinsic | status | evidence | signatures |")
        P("|---|---|---|---|")
        for n in rows:
            st, note = status(n, c["n"], names, evidence)
            # one entry per distinct signature (the Handbook repeats a
            # signature when only the optional parameters differ)
            texts = list(dict.fromkeys(sig_text(s) for s in sigs_by[c["n"]][n]))
            sig = "<br>".join("`%s`" % t.replace("|", "\\|") for t in texts)
            P("| %s | %s | %s | %s |" % (n, st, esc(note), sig))


if __name__ == "__main__":
    main()
