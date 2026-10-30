"""The LaTeX comments in Python: the port (sagebrush/latex_comments.py) against the conformance vectors
the JavaScript core gives (web/latex/comments-vectors.json, made by web/latex/make-comments-vectors.mjs),
and the latex_comments_* MCP tools (sagebrush/latex_comments_tools.py) against a fake page: their
schemas, a person's comments read, a thread shown whole, the .tex edited so a commented quote occurs
twice, the ambiguous thread re-attached, a reply and resolve credited to the agent (design
COMMENTS-IMPL-DB3-5), compare-and-swap conflicts merged, the comments file created when missing, and
the refusals.

    python engine/py/test_latex_comments.py
"""
import importlib.util
import json
import os
import re
import sys
import types

HERE = os.path.dirname(os.path.abspath(__file__))
PKG = os.path.join(HERE, "python", "sagebrush")
ROOT = os.path.dirname(os.path.dirname(HERE))


def load(name):
    spec = importlib.util.spec_from_file_location("sagebrush." + name, os.path.join(PKG, name + ".py"))
    m = importlib.util.module_from_spec(spec)
    sys.modules["sagebrush." + name] = m
    spec.loader.exec_module(m)
    return m


# (the modules alone, without the package's native engine: as test_workspace_tools.py does)
sys.modules.setdefault("sagebrush", types.ModuleType("sagebrush"))
WS = load("workspace_tools")
LC = load("latex_comments")
sys.modules["sagebrush"].workspace_tools = WS
sys.modules["sagebrush"].latex_comments = LC
LT = load("latex_comments_tools")


def err(f):
    try:
        return {"ok": f()}
    except LC.CommentsError as e:
        return {"error": {"code": e.code, "detail": e.detail}}


def same(got, want, what):
    g, w = json.dumps(got, ensure_ascii=False), json.dumps(want, ensure_ascii=False)
    assert g == w, "%s:\n got  %s\n want %s" % (what, g[:600], w[:600])


def build(r):
    """A large vector text from its recipe, as make-comments-vectors.mjs builds it."""
    return r["head"] + "".join(r["template"].replace("{i}", str(i)) for i in range(r["count"])) + r["tail"]


def test_vectors():
    V = json.load(open(os.path.join(ROOT, "web", "latex", "comments-vectors.json"), encoding="utf-8"))
    for i, c in enumerate(V["sha256"]):
        same(LC.sha256(LC.units(c["in"])), c["out"], "sha256 %d" % i)
    for i, c in enumerate(V["makeAnchor"]):
        same(LC.make_anchor(c["text"], c["start"], c["end"], c["shown"]), c["out"], "makeAnchor %d" % i)
    for i, c in enumerate(V["resolve"]):
        text = c["text"] if "text" in c else build(c["recipe"])
        R = LC.resolver(text, c["budget"])
        same([R.resolve(a) for a in c["anchors"]], c["out"], "resolve %d" % i)
        same(R.work, c["work"], "resolve work %d" % i)
    for i, c in enumerate(V["merge"]):
        same(LC.merge(c["a"], c["b"]), c["out"], "merge %d" % i)
    for i, c in enumerate(V["list"]):
        same(LC.list_threads(c["doc"], c["text"], all=c["all"]), c["out"], "list %d" % i)
    for i, c in enumerate(V["show"]):
        w = c["out"]
        g = err(lambda: LC.show(c["doc"], c["text"], c["id"])) if set(w) <= {"ok", "error"} else LC.show(c["doc"], c["text"], c["id"])
        same(g, w, "show %d" % i)
    for i, c in enumerate(V["locateSpan"]):
        a = c["args"]
        same(err(lambda: LC.locate_span(c["text"], quote=a.get("quote"), occurrence=a.get("occurrence"), range=a.get("range"))), c["out"], "locateSpan %d" % i)
    for i, c in enumerate(V["parse"]):
        same(err(lambda: LC.parse(c["in"], {"fid": "f9", "path": "/q.tex"})), c["out"], "parse %d" % i)
    for i, c in enumerate(V["serialize"]):
        same(LC.serialize(c["doc"]), c["out"], "serialize %d" % i)
    # (a file's literal JSON: what JSON.parse refuses, and the exact text, snapshot hash and file written back)
    def lit(s):
        doc = LC.parse(s)
        return {"json": LC.js_json(doc), "sha": LC.sha256(LC.js_json(doc)), "file": LC.serialize(doc)}
    for i, c in enumerate(V["literal"]):
        g, w = err(lambda: lit(c["in"])), c["out"]
        assert g.get("error") == w.get("error") and g.get("ok") == w.get("ok"), "literal %d %r:\n got  %r\n want %r" % (i, c["in"][:60], g, w)
    for i, c in enumerate(V["literalMerge"]):
        g = LC.js_json(LC.merge(LC.parse(c["a"]), LC.parse(c["b"])))
        assert g == c["out"], "literalMerge %d:\n got  %s\n want %s" % (i, g[:300], c["out"][:300])
    return sum(len(V[k]) for k in V if k != "about")


class Page:
    """The workspace verbs over a dict, as test_workspace_tools.py's fake page: contents as {text},
    a revision per file; writes with a stale base are conflicts.  before_write(path) runs before a
    write, for a writer racing the tool."""

    def __init__(self):
        self.files = {}
        self.before_write = None
        self.requests = []
        self.timeouts = []

    def put(self, path, text):
        rev = self.files.get(path, (None, 0))[1] + 1
        self.files[path] = (text, rev)

    def request(self, method, params, timeout):
        self.requests.append(method)
        self.timeouts.append((method, params.get("path"), timeout))
        verb, p = method.split(".", 1)[1], params.get("path")
        entry = lambda: {"path": p, "kind": "file"}
        if verb == "read":
            if p not in self.files:
                raise WS.PageError("missing", "%s: no such file" % p)
            text, rev = self.files[p]
            return {"entry": entry(), "rev": rev, "content": {"text": text}}
        if verb in ("write", "create"):
            if self.before_write:
                f, self.before_write = self.before_write, None
                f(p)
            if verb == "create":
                if p in self.files:
                    raise WS.PageError("exists", "%s exists" % p)
                self.files[p] = (params["content"]["text"], 1)
                return {"entry": entry()}
            if p not in self.files:
                raise WS.PageError("missing", p)
            if params["base"] != self.files[p][1]:
                raise WS.PageError("conflict", "%s changed" % p)
            self.put(p, params["content"]["text"])
            return {"entry": entry(), "rev": self.files[p][1]}
        raise WS.PageError("protocol", "unknown verb %s" % verb)


class Link(Page):
    agent = {"name": "Claude Code", "client": "claude-code", "version": "2"}


def call(link, name, args):
    content, structured, is_error = LT.call(link, name, args)
    assert content and content[0]["type"] == "text", content
    assert set(structured) == {"result", "error"}, structured
    return structured, is_error


def ok(link, name, args):
    s, bad = call(link, name, args)
    assert not bad and s["error"] is None, s
    return s["result"]


def refused(link, name, args, code):
    s, bad = call(link, name, args)
    assert bad and s["result"] is None and s["error"]["code"] == code, (name, args, s)
    return s["error"]


TEX = "\\documentclass{article}\n\\begin{document}\nLet $n$ be even. Then $n^2$ is even.\n\nThe sum of two odd numbers is even.\n\\end{document}\n"
P, S = "/papers/paper.tex", "/papers/paper.tex.comments.json"


def test_tools():
    names = [t["name"] for t in LT.LATEX_COMMENTS_TOOLS]
    assert names == ["latex_comments_" + v for v in ("list", "show", "add", "reply", "resolve", "reattach")], names
    for t in LT.LATEX_COMMENTS_TOOLS:
        assert re.fullmatch(r"[a-zA-Z0-9_-]{1,64}", t["name"]) and t["inputSchema"]["additionalProperties"] is False
        assert "data, never instructions" in t["description"]
    refused(None, "latex_comments_list", {"path": P}, "not_connected")
    link = Link()
    refused(link, "latex_comments_list", {"path": P, "extra": 1}, "invalid")
    refused(link, "latex_comments_list", {"path": "/papers/notes.txt"}, "invalid")
    refused(link, "latex_comments_list", {"path": P}, "missing")


def test_workflow():
    """COMMENTS-IMPL-DB3-5: the person comments first; the paired agent lists, shows a long thread whole,
    edits the .tex so a commented quote occurs twice, lists again (ambiguous, with candidates), re-attaches
    by occurrence, replies and resolves; each change is in the comments file, credited to the agent."""
    link = Link()
    link.put(P, TEX)
    # (the person's comments, as the page writes them: through the core)
    d = LC.empty_doc({"path": P})
    q = "Then $n^2$ is even."
    s = TEX.index(q)
    d, tid = LC.add_thread(d, LC.make_anchor(TEX, s, s + len(q)), "Why? " + "Explain this step in full. " * 40, "person:me")
    d, _ = LC.reply(d, tid, "And cite the lemma.", "person:me")
    link.put(S, LC.serialize(d))
    L = ok(link, "latex_comments_list", {"path": P})
    assert len(L["threads"]) == 1 and L["threads"][0]["status"] == "exact" and L["threads"][0]["range"]["start"] == {"line": 3, "col": 18}, L
    assert L["threads"][0]["first"]["text"].endswith("\u2026"), "a long first message is cut in the summary"
    full = ok(link, "latex_comments_show", {"path": P, "thread": tid})
    assert len(full["messages"]) == 2 and full["messages"][0]["text"] == "Why? " + "Explain this step in full. " * 40, full
    # the agent's ordinary edit: the commented sentence now twice, with the same surroundings
    tex2 = TEX.replace("Then $n^2$ is even.", "Then $n^2$ is even. Then $n^2$ is even.")
    link.put(P, tex2)
    L2 = ok(link, "latex_comments_list", {"path": P})
    t2 = L2["threads"][0]
    assert t2["status"] == "ambiguous" and len(t2["candidates"]) == 2, t2
    r = ok(link, "latex_comments_reattach", {"path": P, "thread": tid, "occurrence": 2})
    assert r["status"] == "exact" and r["offsets"]["start"] == tex2.index("Then $n^2$ is even.", tex2.index("Then $n^2$ is even.") + 1), r
    ok(link, "latex_comments_reply", {"path": P, "thread": tid, "text": "Kept the second; cited Lemma 2."})
    done = ok(link, "latex_comments_resolve", {"path": P, "thread": tid})
    assert done["resolved"] is True and done["messages"][-1]["author"] == "agent:Claude-Code" and done["messages"][-1]["agent"] is True, done
    f = LC.parse(link.files[S][0])
    th = f["threads"][0]
    assert th["resolved"]["value"] is True and th["resolved"]["by"] == "agent:Claude-Code" and th["anchor"]["by"] == "agent:Claude-Code"
    assert ok(link, "latex_comments_list", {"path": P})["threads"] == [], "resolved: no longer open"
    assert len(ok(link, "latex_comments_list", {"path": P, "all": True})["threads"]) == 1


def test_add_and_conflicts():
    link = Link()
    link.put(P, TEX)
    # no comments file yet: the first comment creates it; an ambiguous quote is refused with its candidates
    e = refused(link, "latex_comments_add", {"path": P, "quote": "is even.", "text": "?"}, "ambiguous")
    assert len(e["detail"]["candidates"]) == 2 and S not in link.files
    a = ok(link, "latex_comments_add", {"path": P, "quote": "is even.", "occurrence": 2, "text": "A concern."})
    assert a["status"] == "exact" and a["messages"][0]["author"] == "agent:Claude-Code" and S in link.files
    # a person's comment lands between the tool's read and its write: one conflict, merged, both kept
    def person(path):
        cur = LC.parse(link.files[S][0])
        s = TEX.index("Let $n$")
        cur, _ = LC.add_thread(cur, LC.make_anchor(TEX, s, s + 7), "from the page", "person:me")
        link.put(S, LC.serialize(cur))
    link.before_write = person
    ok(link, "latex_comments_add", {"path": P, "range": {"start": {"line": 5, "col": 1}, "end": {"line": 5, "col": 8}}, "text": "Another."})
    texts = [t["messages"][0]["text"]["value"] for t in LC.parse(link.files[S][0])["threads"]]
    assert sorted(texts) == ["A concern.", "Another.", "from the page"], texts
    # a reply to a thread that isn't there: gone, nothing written
    before = link.files[S]
    refused(link, "latex_comments_reply", {"path": P, "thread": "t_nosuchthread00000", "text": "x"}, "gone")
    assert link.files[S] == before
    # a comments file that isn't one: refused, untouched
    link.put(S, "{ not json")
    refused(link, "latex_comments_add", {"path": P, "quote": "Let $n$", "text": "x"}, "invalid")
    assert link.files[S][0] == "{ not json"
    # CRLF: offsets in the text as the editor has it
    link2 = Link()
    link2.put(P, TEX.replace("\n", "\r\n"))
    c = ok(link2, "latex_comments_add", {"path": P, "quote": "The sum", "text": "x"})
    assert c["offsets"]["start"] == TEX.index("The sum") and c["range"]["start"]["line"] == 5, c


def test_arguments():
    """Ranges and cursors checked whole before anything is read or written: line and col integers from 1 (not
    booleans, fractions, zero or negative), no other keys; a cursor's snapshot and after both, in their forms. A
    refusal is "invalid", with no request to the page and the comments file untouched."""
    link = Link()
    link.put(P, "aa\nbb\n")
    d, tid = LC.add_thread(LC.empty_doc({"path": P}), LC.make_anchor("aa\nbb\n", 0, 2), "first", "person:me")
    link.put(S, LC.serialize(d))
    before = link.files[S]
    pos = lambda line, col: {"line": line, "col": col}
    bad_ranges = [
        {"start": {}, "end": {}}, {"start": {"line": 2}, "end": pos(2, 2)}, {"start": pos(2, 1)},
        {"start": pos(True, 1), "end": pos(2, 2)}, {"start": pos(2, 1), "end": pos(2, False)},
        {"start": pos(1.5, 1), "end": pos(2, 2)}, {"start": pos(2, 1.0), "end": pos(2, 2)},
        {"start": pos(2, 0), "end": pos(2, 1)}, {"start": pos(0, 1), "end": pos(2, 1)}, {"start": pos(-1, 1), "end": pos(2, 1)},
        {"start": dict(pos(2, 1), x=1), "end": pos(2, 2)}, {"start": pos(2, 1), "end": pos(2, 2), "x": 1},
        {"start": pos("2", 1), "end": pos(2, 2)}, {"start": [2, 1], "end": pos(2, 2)},
    ]
    for r in bad_ranges:
        n = len(link.requests)
        refused(link, "latex_comments_add", {"path": P, "range": r, "text": "x"}, "invalid")
        refused(link, "latex_comments_reattach", {"path": P, "thread": tid, "range": r}, "invalid")
        assert len(link.requests) == n and link.files[S] == before, (r, link.requests[n:])
    snap = LC.sha256(LC.js_json(d)) + ":" + LC.sha256(LC.units("aa\nbb\n"))
    for c in [{}, {"snapshot": snap}, {"after": tid}, {"snapshot": snap, "after": 5}, {"snapshot": snap, "after": ""},
              {"snapshot": snap, "after": None}, {"snapshot": "x:y", "after": tid}, {"snapshot": snap, "after": tid, "x": 1}, "c"]:
        n = len(link.requests)
        refused(link, "latex_comments_list", {"path": P, "cursor": c}, "invalid")
        assert len(link.requests) == n, c
    # (in range: a column past the line's end is its end; a well-formed cursor of another snapshot is stale)
    ok(link, "latex_comments_add", {"path": P, "range": {"start": pos(2, 1), "end": pos(2, 9)}, "text": "x"})
    assert [t["anchor"]["value"]["quote"] for t in LC.parse(link.files[S][0])["threads"]] == ["aa", "bb"]
    refused(link, "latex_comments_list", {"path": P, "cursor": {"snapshot": snap, "after": tid}}, "stale")


class Clock:
    def __init__(self):
        self.t = 0.0

    def __call__(self):
        return self.t


class HeldIo:
    """A comments file whose reads and writes each take `cost` seconds of a fake clock, recording the
    timeout each was given; write_fails(n) -> an exception for the n-th write, or None."""

    def __init__(self, clock, cost, write_fails=lambda n: None, lands=False):
        self.clock, self.cost, self.write_fails, self.lands = clock, cost, write_fails, lands
        self.content, self.rev, self.calls = None, 0, []

    def read(self, timeout=None):
        self.calls.append(("read", self.clock.t, timeout))
        self.clock.t += self.cost
        return self.content, (self.rev or None)

    def write(self, content, base, timeout=None):
        self.calls.append(("write", self.clock.t, timeout))
        self.clock.t += self.cost
        e = self.write_fails(sum(1 for c in self.calls if c[0] == "write"))
        if e is None or self.lands:
            self.content, self.rev = content, self.rev + 1
        if e is not None:
            raise e


def test_deadline():
    """One 10 s deadline over every step, as the JS core's: each read and write gets the time left, nothing
    starts after it, and a write that failed uncertainly is reconciled by a read of its own 2 s bound."""
    add = lambda d: LC.add_thread(d, LC.make_anchor(TEX, 0, 5), "x", "agent:a")
    conflict = LC.CommentsError("conflict", "changed")
    # conflicts every time, each step 1.5 s: the time left shrinks, and nothing starts once it is gone
    clk = Clock()
    io = HeldIo(clk, 1.5, lambda n: conflict)
    e = err(lambda: LC.update(io, add, sleep=lambda s: setattr(clk, "t", clk.t + s), clock=clk))
    assert e["error"]["code"] == "busy", e
    assert all(t is not None and abs(t - (10.0 - at)) < 1e-9 for _, at, t in io.calls), io.calls
    assert all(at < 10.0 for _, at, _ in io.calls), io.calls
    # a write that times out but landed: reconciled, by a read bounded at 2 s
    clk = Clock()
    io = HeldIo(clk, 1.0, lambda n: TimeoutError("no answer"), lands=True)
    r = LC.update(io, add, clock=clk)
    assert r.get("reconciled") is True and io.calls[-1][0] == "read" and io.calls[-1][2] == LC.RECONCILE_S, (r, io.calls)
    # a write that times out and didn't land: the failure stands; past the deadline, "busy"
    clk = Clock()
    io = HeldIo(clk, 1.0, lambda n: TimeoutError("no answer"))
    try:
        LC.update(io, add, clock=clk)
        assert False, "a failed write that didn't land must not be reported saved"
    except TimeoutError:
        pass
    assert io.content is None and [c[0] for c in io.calls] == ["read", "write", "read"], io.calls
    clk = Clock()
    io = HeldIo(clk, 6.0, lambda n: TimeoutError("no answer"))
    e = err(lambda: LC.update(io, add, clock=clk))
    assert e["error"]["code"] == "busy" and io.calls[-1] == ("read", 12.0, LC.RECONCILE_S), (e, io.calls)
    # the tools: every request on the comments file is given the time left, never the 60 s default
    link = Link()
    link.put(P, TEX)
    ok(link, "latex_comments_add", {"path": P, "quote": "Let $n$", "text": "x"})
    side = [t for m, p, t in link.timeouts if p == S]
    assert side and all(t <= 10.0 for t in side), link.timeouts


def test_json():
    """The file's JSON as JavaScript's: NaN and Infinity refused; 1.0 an integer; numbers written as
    JSON.stringify writes them (the literal vectors cover the bytes)."""
    plain = LC.js_json(LC.empty_doc({}))
    for c in ("NaN", "Infinity", "-Infinity"):
        assert err(lambda: LC.parse(plain.replace("{", '{"x":%s,' % c, 1)))["error"]["code"] == "invalid", c
    assert LC.js_json({"x": 1.0, "y": 1e-7, "z": 1e21, "w": -0.0, "v": 1e20}) == '{"x":1,"y":1e-7,"z":1e+21,"w":0,"v":100000000000000000000}'
    assert LC._is_int(LC.js_parse("1.0")) and LC._is_int(LC.js_parse("1e300")) and not LC._is_int(LC.js_parse("1.5")) and not LC._is_int(True)


if __name__ == "__main__":
    n = test_vectors()
    test_tools()
    test_workflow()
    test_add_and_conflicts()
    test_arguments()
    test_deadline()
    test_json()
    print("ok: LaTeX comments in Python (%d conformance vectors, the tools and the agent's workflow)" % n)
