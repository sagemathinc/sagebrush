"""Full-text search of Sagebrush's documentation: every public function and
method of the Sage library, its signature and its docstring.

    search_doc("elliptic rank")          in Sage mode (notebook, console, CLI)
    sagebrush --search "elliptic rank"   from a shell (--json: machine-readable)
    sagebrush --search "class group" --mode magma
                                         another language's index: sage (the
                                         default) and python search the Sage
                                         library, which Python mode imports;
                                         magma and matlab the functions those
                                         modes bind (lib/_magma_docsearch.py,
                                         lib/_matlab_docsearch.py)
    sagebrush -m _pyjs_docsearch --index the index as JSON (sagebrush.space and
                                         the MCP server's search_docs tool)

Every word of the query must occur in the name, the summary or the docstring;
matches in the name count most.  The same ranking is in web/docsearch.ts and
in the MCP server (sagebrush/mcp_server.py), which read the JSON index.
"""

import re as _re

# the public API (the modules of test/doctest-coverage.json)
PUBLIC = ["sage_all", "_sage_modular", "_sage_poly", "_sage_nf", "_sage_ff", "_sage_ffmat", "_sage_qqbar", "_sage_mpoly", "_sage_frac", "_sage_real", "_sage_rdf", "_sage_series", "_sage_nfpoly", "_sage_graph", "_sage_sandpile", "_sage_lie", "_sage_crystals", "_sage_polyhedra", "_sage_coding", "_sage_manifolds", "_sage_milp", "sage_permgroup", "_sage_matrix",
          "_sage_lang", "_sage_expr", "_interact", "sage_plot", "sage_plot3d"]

_INDEX = None
_OTHER = {}  # mode -> its index

# --mode: the language whose functions are searched, and its index's module
MODES = {"sage": None, "python": None, "magma": "_magma_docsearch", "matlab": "_matlab_docsearch"}


def _signature(name, doc_obj, kind):
    from _pyjs_help import signature
    try:
        s = signature(doc_obj)
    except Exception:
        return ""
    if s and kind == "method" and s.startswith("(self"):
        s = "(" + s[len("(self"):].lstrip(", ")
    return s or ""


def build_index():
    """[{name, module, kind, signature, summary, doc, examples, open_problem}]
    for the public API, in module order."""
    from _pyjs_doctest import collect, examples, open_problem_sections, _unwrap
    from _pyjs_help import _cleandoc
    import sys
    out = []
    seen = set()
    for modname in PUBLIC:
        try:
            items = collect(modname)
        except Exception:
            continue
        mod = sys.modules[modname]
        for name, doc, kind in items:
            if kind == "module":
                continue
            doc = doc or ""
            if name.startswith("_") and "." not in name:
                continue
            if name in seen:
                continue
            seen.add(name)
            obj = mod
            try:
                for part in name.split("."):
                    obj = obj.__dict__[part] if isinstance(obj, type) or obj is mod else getattr(obj, part)
                obj = _unwrap(obj)
            except Exception:
                obj = None
            clean = _cleandoc(doc)
            summary = clean.split("\n\n")[0].replace("\n", " ")
            out.append({
                "name": name,
                "module": modname,
                "kind": kind,
                "signature": _signature(name, obj, kind) if obj is not None and kind != "class" else "",
                "summary": summary,
                "doc": clean,
                "examples": len(examples(doc)),
                "open_problem": bool(open_problem_sections(doc)),
            })
    return out


def index():
    """The index: docs-index.json next to this file when there is one (the
    CPython package ships it), else built from the docstrings."""
    global _INDEX
    if _INDEX is None:
        try:
            import json, os
            with open(os.path.join(os.path.dirname(__file__), "docs-index.json")) as f:
                _INDEX = json.load(f)
        except Exception:
            _INDEX = build_index()
    return _INDEX


def index_for(mode=None):
    """The index of a language (None, "sage" or "python": the Sage
    library's)."""
    if mode is not None and mode not in MODES:
        raise ValueError("--mode must be one of %s, not %r" % (", ".join(MODES), mode))
    if mode is None or MODES[mode] is None:
        return index()
    if mode not in _OTHER:
        try:
            module = __import__(MODES[mode])
        except ImportError:
            # (the CPython package has the Sage library only)
            raise ValueError("this installation has no %s index" % mode)
        _OTHER[mode] = module.build_index()
    return _OTHER[mode]


def _words(s):
    return [w for w in _re.split(r"[^a-z0-9]+", s.lower()) if w]


def score(entry, words, phrase):
    """The rank of an entry for the query words (0: no match).  Mirrored in
    web/docsearch.ts and sagebrush/mcp_server.py."""
    name = entry["name"].lower()
    name_words = set(_words(entry["name"]))
    summary = entry["summary"].lower()
    doc = entry["doc"].lower()
    total = 0
    for w in words:
        if w in name_words:
            total += 10
        elif w in name:
            total += 6
        elif w in summary:
            total += 3
        elif w in doc:
            total += 1
        else:
            return 0
    last = name.split(".")[-1]
    if phrase == last or phrase.replace(" ", "_") == last:
        total += 20
    if entry["open_problem"] and "open" in words:
        total += 5
    return total


def search(query, limit=20, mode=None):
    """The best matches for query: [(score, entry)], in the index of the
    language `mode` (default: the Sage library)."""
    words = _words(query)
    if not words:
        return []
    phrase = query.strip().lower()
    hits = [(score(e, words, phrase), e) for e in index_for(mode)]
    hits = [h for h in hits if h[0] > 0]
    hits.sort(key=lambda h: (-h[0], len(h[1]["name"]), h[1]["name"]))
    return hits[:limit]


def search_doc(query, limit=20, mode=None):
    """Search the documentation of Sagebrush's functions: every word of the
    query must occur in the name or the docstring.  obj? then shows one in
    full.

    EXAMPLES::

        sage: search_doc("selmer")  # sagebrush only
        EllipticCurve_rational_field.selmer_rank()
            The F_2-dimension of the 2-Selmer group (here for curves without
        ...
    """
    hits = search(query, limit, mode)
    if not hits:
        print("no function's documentation contains all of: %s" % query)
        return
    for _, e in hits:
        head = e["name"] + (e["signature"] or ("" if e["kind"] == "class" else "()"))
        tag = "    [%s]" % mode if mode else ""
        print(head + tag + ("    [open problem]" if e["open_problem"] else ""))
        s = e["summary"]
        print("    " + (s if len(s) <= 150 else s[:147] + "..."))


def main(argv):
    import json
    argv = list(argv)
    mode = None
    if "--mode" in argv:
        k = argv.index("--mode")
        mode = argv[k + 1] if k + 1 < len(argv) else ""
        del argv[k:k + 2]
        if mode not in MODES:
            print("sagebrush --search: --mode must be one of %s" % ", ".join(MODES))
            return 2
    if "--index" in argv:
        print(json.dumps(index_for(mode), separators=(",", ":")))
        return 0
    query = " ".join(a for a in argv if not a.startswith("--"))
    if "--json" in argv:
        hits = search(query, 50, mode)
        lang = {"language": mode} if mode else {}
        print(json.dumps([dict(e, score=s, **lang) for s, e in hits], indent=1))
        return 0
    search_doc(query, 30, mode)
    return 0


if __name__ == "__main__":
    import sys
    sys.exit(main(sys.argv[1:]))
