"""The census of rich-output DOM sinks (OUT-ISO plan r3, phase 1), for
test/rich-sinks.test.ts: a lexical change detector, like test/limit_sites.py.

What it is, and isn't.  It lists every code line of the web app's own sources
(web/**/*.{js,mjs,ts,mts} and web/**/*.html, not built output, vendored code
or tests) that matches the sink vocabulary below, and checks the list against a
reviewed registry, test/rich-sinks.json.  So a new or changed site that can put
markup into a live DOM needs a reviewed kind and owner in the diff.  Registered
means accounted for, not safe and not migrated (astra, Nov 7).  It is NOT a
proof that every sink is caught: a sink outside the vocabulary slips past, and
code review remains the backstop.  The security inventory with its detailed
cases stays internal (astra's); this registry records sites, kinds and owners.

The vocabulary: assignment to innerHTML or outerHTML (and +=), insertAdjacentHTML(,
srcdoc (as a property or an attribute), createContextualFragment(, document.write(,
setHTMLUnsafe(, parseHTMLUnsafe( and DOMParser; and, per the census addendum of
Nov 6 (the terminal renderer and its addons), new Terminal(, .loadAddon(,
registerLinkProvider( and imports from @xterm/.  Comment-only lines are skipped.

A site's fingerprint is file :: enclosing function :: the line's text, as
limit_sites.py makes it (whitespace outside string literals collapsed, literals
kept), then #k for the k-th identical line in that function.

The registry maps fingerprint -> {"kind", "owner"} and, for kind "rich", the
"readers" of what the sink renders (host code that reads that DOM back: output
text for agents, pictures, pixel recounts, TimeTravel, boards, Print/Present),
each "file :: function", possibly none:
- "rich": document-controlled content (a notebook's outputs, Markdown, SVG, a
  shared page) can reach the sink.  "owner" is the OUT-ISO phase that moves it
  into the isolated renderer: "phase-2" (HTML/Markdown), "phase-3" (SVG and
  interactive), "phase-4" (saved/imported/replayed, boards, previews, export,
  print), "phase-5" (remaining fallbacks), or "terminal" (the remote terminal's
  renderer, the census addendum of Nov 6).
- "host": only the page's own fixed markup or text it escapes itself reaches it.
- "renderer": the isolated renderer's own code (web/output-shell), or the host
  side that only sends to it.
- "none": matched text that sinks nothing (a name, a test of support).

  python3 test/rich_sinks.py --check     (exit 1 on unregistered or stale sites)
  python3 test/rich_sinks.py --list      (every site: fingerprint, kind, line)
  python3 test/rich_sinks.py --check --root DIR   (another checkout)
"""
import json
import os
import re
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import limit_sites as L  # noqa: E402  (its normalize, comment_only and declaration matcher)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REGISTRY = os.path.join(ROOT, "test", "rich-sinks.json")
# (host code that reads rendered output back: the readers each migration must move with its sinks, plan I-4)
READERS = re.compile(r"\.(?:out|md)\.(?:textContent|innerText|innerHTML|outerHTML|querySelector(?:All)?|children|childNodes|firstChild|lastChild)\b(?!\s*=[^=])|\boutputText\(|\bpictures\(|\brecountPictures\(")
VOCAB = re.compile(r"\.(?:inner|outer)HTML\s*\+?=(?!=)|insertAdjacentHTML\s*\(|\bsrcdoc\b|createContextualFragment\s*\(|document\.write(?:ln)?\s*\(|setHTMLUnsafe\s*\(|parseHTMLUnsafe\s*\(|\bDOMParser\b|\bnew Terminal\s*\(|\.loadAddon\s*\(|registerLinkProvider\s*\(|from\s+[\x22']@xterm/")
KINDS = {"rich", "host", "renderer", "none"}
OWNERS = {"phase-2", "phase-3", "phase-4", "phase-5", "terminal"}
SKIP = re.compile(r"(^|/)(dist|node_modules|vendor|site/public)/|(^|/)test[-_][^/]*$|\.test\.(ts|mjs|js)$|(^|/)tests?/")


def tracked():
    out = subprocess.run(["git", "ls-files", "web"], cwd=ROOT, capture_output=True, text=True, check=True).stdout
    return sorted(p for p in out.split("\n") if p and re.search(r"\.(js|mjs|ts|mts|html)$", p) and not SKIP.search(p))


def sites(vocab=None):
    """[(fingerprint, path, line number)] of every census site (sinks, or with vocab=READERS readers)."""
    vocab = vocab or VOCAB
    out = []
    for path in tracked():
        with open(os.path.join(ROOT, path), encoding="utf-8", errors="replace") as f:
            text = f.read()
        current, seen = "", {}
        for no, line in enumerate(text.split("\n"), 1):
            m = L._DECL["ts"].match(line)
            if m:
                name = next(g for g in m.groups() if g)
                if name not in ("if", "for", "while", "switch", "catch", "return", "function"):
                    current = name
            t = line.strip()
            if not t or L.comment_only(t, "ts") or t.startswith("<!--") or not vocab.search(line):
                continue
            base = "%s :: %s :: %s" % (path, current, L.normalize(line))
            k = seen.get(base, 0)
            seen[base] = k + 1
            out.append((base + " #%d" % k, path, no))
    return out


def load():
    if not os.path.exists(REGISTRY):
        return {"sinks": {}, "readers": {}}
    with open(REGISTRY, encoding="utf-8") as f:
        return json.load(f)


READER_ROLES = {"agent-text", "agent-pictures", "pixels", "replay", "board", "print", "selftest", "clear", "host"}


def reader_problems(reg, now):
    keys = {k for k, _, _ in now}
    out = []
    for k, path, no in now:
        e = reg.get(k)
        if e is None:
            out.append("unregistered reader: %s:%d  %s" % (path, no, k))
        elif e.get("role") not in READER_ROLES or e.get("owner") not in OWNERS | {"host"}:
            out.append("a reader needs a role and an owner phase: %s" % k)
    for k in sorted(set(reg) - keys):
        out.append("stale reader (no such line now): %s" % k)
    return out


def problems(reg, now):
    keys = {k for k, _, _ in now}
    out = []
    for k, path, no in now:
        e = reg.get(k)
        if e is None:
            out.append("unregistered: %s:%d  %s" % (path, no, k))
        elif e.get("kind") not in KINDS:
            out.append("bad kind %r: %s" % (e.get("kind"), k))
        elif e["kind"] == "rich" and (e.get("owner") not in OWNERS or not isinstance(e.get("readers"), list)):
            out.append("a rich sink needs an owner phase and a readers list: %s" % k)
    for k in sorted(set(reg) - keys):
        out.append("stale (no such line now): %s" % k)
    return out


def main(argv):
    global ROOT, REGISTRY
    if "--root" in argv:  # (another checkout: the census's own fixture cases, scripts/test-rich-sinks.mjs)
        ROOT = os.path.abspath(argv[argv.index("--root") + 1])
        REGISTRY = os.path.join(ROOT, "test", "rich-sinks.json")
    now, rnow = sites(), sites(READERS)
    full = load()
    reg, rreg = full.get("sinks", {}), full.get("readers", {})
    if "--list" in argv:
        for k, path, no in now:
            print("sink\t%s\t%s:%d\t%s" % (reg.get(k, {}).get("kind", "?"), path, no, k))
        for k, path, no in rnow:
            print("reader\t%s\t%s:%d\t%s" % (rreg.get(k, {}).get("role", "?"), path, no, k))
        return 0
    if "--check" in argv:
        p = problems(reg, now) + reader_problems(rreg, rnow)
        counts = {}
        for k, _, _ in now:
            kind = reg.get(k, {}).get("kind", "?")
            counts[kind] = counts.get(kind, 0) + 1
        print(json.dumps({"sinks": len(now), "kinds": counts, "readers": len(rnow), "problems": p}, indent=1))
        return 1 if p else 0
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
