"""Full-text search of Sagebrush's documentation: every public function and
method of the Sage library, its signature and its docstring.

    search_doc("elliptic rank")          in Sage mode (notebook, console, CLI)
    sagebrush --search "elliptic rank"   from a shell (--json: machine-readable)
    sagebrush --search "class group" --mode magma
                                         another language's index: sage (the
                                         default) the Sage library; python
                                         Python mode's numpy, scipy and
                                         standard library (lib/_python_docsearch.py);
                                         magma and matlab the functions those
                                         modes bind (lib/_magma_docsearch.py,
                                         lib/_matlab_docsearch.py)
    sagebrush -m _pyjs_docsearch --index the index as JSON (sagebrush.space and
                                         the MCP server's search_docs tool)

Every word of the query must occur in the name (or an alias), the summary
or the docstring; matches in the name count most.  The same ranking is in
web/index.html (docScore), and the MCP server's search_docs
(sagebrush/mcp_server.py) uses this module, both reading the JSON index.
A hit shows as describe() writes it, for agents: the call form and status,
the summary, the first example, what differs from upstream, and what to use
instead; --json gives each entry whole.
"""

import re as _re

# the public API (the modules of test/doctest-coverage.json)
PUBLIC = ["sage_all", "_sage_modular", "_sage_poly", "_sage_nf", "_sage_ff", "_sage_ffmat", "_sage_qqbar", "_sage_mpoly", "_sage_frac", "_sage_real", "_sage_rdf", "_sage_series", "_sage_nfpoly", "_sage_padic", "_sage_padic_ext", "_sage_padic_lseries", "_sage_graph", "_sage_sandpile", "_sage_lie", "_sage_crystals", "_sage_polyhedra", "_sage_coding", "_sage_manifolds", "_sage_milp", "sage_permgroup", "_sage_matrix",
          "_sage_lang", "_sage_expr", "_interact", "sage_plot", "sage_plot3d"]

_INDEX = None
_OTHER = {}  # mode -> its index

# --mode: the language whose functions are searched, and its index's module
MODES = {"sage": None, "python": "_python_docsearch", "magma": "_magma_docsearch", "matlab": "_matlab_docsearch"}


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
    # (the curated PyPI packages, importable in Sage mode too:
    # lib/_python_docsearch.py)
    try:
        out += __import__("_python_docsearch")._pypi(seen)
    except ImportError:
        pass
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
    """The index of a language (None or "sage": the Sage library's)."""
    if mode is not None and mode not in MODES:
        raise ValueError("--mode must be one of %s, not %r" % (", ".join(MODES), mode))
    if mode is None or MODES[mode] is None:
        return index()
    if mode not in _OTHER:
        try:
            # (the CPython package ships Python mode's index, made by the CLI:
            # scripts/sync-python-package.sh)
            import json, os
            with open(os.path.join(os.path.dirname(__file__), "docs-index-%s.json" % mode)) as f:
                _OTHER[mode] = json.load(f)
            return _OTHER[mode]
        except Exception:  # (as index(): no file here, or none readable)
            pass
        try:
            module = __import__(MODES[mode])
        except ImportError:
            # (the CPython package has no Magma or MATLAB index)
            raise ValueError("this installation has no %s index" % mode)
        _OTHER[mode] = module.build_index()
    return _OTHER[mode]


def _words(s):
    return [w for w in _re.split(r"[^a-z0-9]+", s.lower()) if w]


def score(entry, words, phrase):
    """The rank of an entry for the query words (0: no match).  Mirrored in
    web/docsearch.ts and sagebrush/mcp_server.py."""
    # (a catalog entry's aliases are names of it too: catalog/SCHEMA.md)
    names = [entry["name"]] + list(entry.get("aliases") or [])
    name = " ".join(names).lower()
    name_words = set(w for n in names for w in _words(n))
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
    lasts = [n.lower().split(".")[-1] for n in names]
    if phrase in lasts or phrase.replace(" ", "_") in lasts:
        total += 20
    if entry["open_problem"] and "open" in words:
        total += 5
    return total


# What a search may hand an agent (HARD-012-1): at most MAX_HITS hits; a hit
# as describe() writes it at most HIT_CHARS, each part of it clipped first;
# a whole text answer at most TOTAL_CHARS; a JSON answer at most JSON_BYTES,
# whole entries only.  Anything cut says so.
MAX_HITS = 50
HIT_CHARS = 4000
TOTAL_CHARS = 60000
JSON_BYTES = 256 * 1024
_FORMS, _LINES, _PART, _DIFFERS = 4, 12, 300, 5


def clamp_limit(limit):
    """A requested number of hits as one from 1 to MAX_HITS"""
    try:
        n = int(limit)
    except (TypeError, ValueError):
        n = 20
    return max(1, min(n, MAX_HITS))


def _clip(s, n):
    return s if len(s) <= n else s[:n] + " ...[%d more characters]" % (len(s) - n)


def _clip_lines(text, nlines=_LINES, nchars=_PART):
    lines = text.split("\n")
    out = "\n".join(lines[:nlines])
    more = len(lines) - nlines
    out = _clip(out, nchars)
    return out + ("\n...[%d more lines]" % more if more > 0 else "")


def search(query, limit=20, mode=None):
    """The best matches for query: [(score, entry)], in the index of the
    language `mode` (default: the Sage library), at most clamp_limit(limit)."""
    limit = clamp_limit(limit)
    words = _words(query)
    if not words:
        return []
    phrase = query.strip().lower()
    hits = [(score(e, words, phrase), e) for e in index_for(mode)]
    hits = [h for h in hits if h[0] > 0]
    hits.sort(key=lambda h: (-h[0], len(h[1]["name"]), h[1]["name"]))
    return hits[:limit]


# (each mode's prompt and continuation, for an example's code)
PROMPTS = {None: ("sage: ", "....:"), "sage": ("sage: ", "....:"), "python": (">>> ", "..."), "matlab": (">> ", None), "magma": ("> ", None)}


def prompted(code, first=">>> ", cont="..."):
    """code as typed at a prompt: `first` before each statement, `cont` and a
    space before the lines of a block (and a decorator's def), and a `cont`
    line ending it; a mode without continuations (cont None): `first` before
    every line"""
    if cont is None:
        return "\n".join(first + line for line in code.split("\n"))
    out, block, prev = [], False, ""
    for line in code.split("\n"):
        indented = line.startswith((" ", "\t"))
        if block and not indented and not prev.lstrip().startswith("@"):
            out.append(cont)
            block = False
        c = block and (indented or prev.lstrip().startswith("@"))
        out.append((cont + " " if c else first) + line)
        if line.startswith("@") or line.rstrip().endswith(":") or c:
            block = True
        prev = line
    if block:
        out.append(cont)
    return "\n".join(out)


def call_form(e, form):
    """A signature as written after its name: `(a, b)` follows the name; any
    other form (MATLAB's `M = max(A)`, `[M, I] = max(___)`) is a whole call,
    shown as it is (catalog/SCHEMA.md, CORR-012-2)"""
    if form and not form.startswith("("):
        return form
    return e["name"] + (form or ("" if e["kind"] in ("class", "constant", "module", "keyword") else "()"))


def describe(e, mode=None):
    """An entry as an agent reads it: the call form with its status, the
    summary, and for a catalog entry its first example (at the mode's
    prompt, then what it prints), what differs from upstream, and what to
    use instead"""
    forms = [_clip(f, _PART) for f in (e.get("signature") or "").split("\n")]
    head = call_form(e, forms[0])
    tags = ("    [%s]" % mode if mode else "") + ("    [open problem]" if e.get("open_problem") else "")
    if e.get("status") and e["status"] != "full":
        tags += "    [%s]" % e["status"]
    out = [head + tags]
    extra = [f for f in forms[1:] if f]
    out.extend("    also: " + call_form(e, f) for f in extra[:_FORMS])
    if len(extra) > _FORMS:
        out.append("    ...[%d more call forms]" % (len(extra) - _FORMS))
    s = e["summary"]
    out.append("    " + (s if len(s) <= 150 else s[:147] + "..."))
    exs = e.get("examples")
    if isinstance(exs, list) and exs:
        first, cont = PROMPTS.get(mode, PROMPTS[None])
        # (with the imports it needs, so that it runs where it is copied to)
        code = ((exs[0].get("setup") or "") + "\n" + exs[0]["code"]).lstrip("\n")
        out.extend("    " + ln for ln in _clip_lines(prompted(code, first, cont)).split("\n"))
        if exs[0]["expected"]:
            out.extend("    " + ln for ln in _clip_lines(exs[0]["expected"].rstrip("\n")).split("\n"))
    differs = list(e.get("differs") or [])
    out.extend("    differs: " + _clip(d, _PART) for d in differs[:_DIFFERS])
    if len(differs) > _DIFFERS:
        out.append("    ...[%d more differs lines: --json has them]" % (len(differs) - _DIFFERS))
    if e.get("alternative"):
        out.append("    instead: " + _clip(e["alternative"], _PART))
    if e.get("source"):
        out.append("    source: " + _clip(e["source"], _PART))
    return _clip("\n".join(out), HIT_CHARS)


def within(texts, budget=TOTAL_CHARS):
    """As many of texts, in order, as fit in budget characters, and a last
    line saying how many did not"""
    out, used = [], 0
    room = budget - 80  # (for the marker, and a clipped text's own)
    for i, t in enumerate(texts):
        if used + len(t) > room:
            if not out:
                # (a first text longer than the whole budget: clipped, HARD-0E9-1)
                out.append(_clip(t, max(room, 0)))
                i += 1
            if i < len(texts):
                out.append("...[%d more hits not shown: narrow the query]" % (len(texts) - i))
            break
        out.append(t)
        used += len(t) + 1
    return out


def bounded_entries(entries, budget=JSON_BYTES, wrap=lambda xs: xs):
    """(the entries, in order, whose JSON fits in budget bytes, whole; how
    many did not fit), measured as wrap(entries) prints"""
    import json
    # (measured as printed, in the list: at most MAX_HITS entries, so the
    # list is serialized at most that many times)
    out = []
    for i, e in enumerate(entries):
        if len(json.dumps(wrap(out + [e]), indent=1).encode("utf-8")) > budget:
            return out, len(entries) - i
        out.append(e)
    return out, 0


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
    print("\n".join(within([describe(e, mode) for _, e in hits])))


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
    limit = 10
    if "--limit" in argv:
        # (--limit N: at most N hits, from 1 to MAX_HITS; 10 by default)
        k = argv.index("--limit")
        limit = clamp_limit(argv[k + 1] if k + 1 < len(argv) else 10)
        del argv[k:k + 2]
    query = " ".join(a for a in argv if not a.startswith("--"))
    if "--json" in argv:
        hits = search(query, limit, mode)
        lang = {"language": mode} if mode else {}
        # (whole entries, as many as fit: HARD-012-1; the rest counted on stderr)
        entries, omitted = bounded_entries([dict(e, score=s, **lang) for s, e in hits])
        print(json.dumps(entries, indent=1))
        if omitted:
            import sys
            print("sagebrush --search: %d more matching entries not shown (%d bytes at most): narrow the query" % (omitted, JSON_BYTES), file=sys.stderr)
        return 0
    search_doc(query, limit, mode)
    return 0


if __name__ == "__main__":
    import sys
    sys.exit(main(sys.argv[1:]))
