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
    return sum(len(V[k]) for k in V if k != "about")


class Page:
    """The workspace verbs over a dict, as test_workspace_tools.py's fake page: contents as {text},
    a revision per file; writes with a stale base are conflicts.  before_write(path) runs before a
    write, for a writer racing the tool."""

    def __init__(self):
        self.files = {}
        self.before_write = None
        self.requests = []

    def put(self, path, text):
        rev = self.files.get(path, (None, 0))[1] + 1
        self.files[path] = (text, rev)

    def request(self, method, params, timeout):
        self.requests.append(method)
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


if __name__ == "__main__":
    n = test_vectors()
    test_tools()
    test_workflow()
    test_add_and_conflicts()
    print("ok: LaTeX comments in Python (%d conformance vectors, the tools and the agent's workflow)" % n)
