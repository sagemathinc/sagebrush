"""The workspace tools (sagebrush/workspace_tools.py) against a fake page:
the tools' names and schemas, the checking of arguments before anything
reaches the page, compare-and-swap writes and their conflicts, contents in
each encoding and their size limit both ways, the page's errors, and the
tools through the MCP server's tools/call.  No pairing yet: the page here
is an object in this process that implements the verbs over a dict, as
web/workspace/api.ts does over IndexedDB.

    python engine/py/test_workspace_tools.py
"""
import base64
import importlib.util
import io
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("workspace_tools", os.path.join(HERE, "python", "sagebrush", "workspace_tools.py"))
WS = importlib.util.module_from_spec(spec)
spec.loader.exec_module(WS)


class FakePage:
    """The verbs over a dict: entries by path, contents in their wire form,
    a revision per entry, Trash; every request it receives is recorded."""

    def __init__(self):
        self.entries = {"/": {"path": "/", "kind": "folder"}}
        self.trash = {}
        self.requests = []
        self.t = 0
        self.override = None  # a result to return instead, for the protocol tests

    def tick(self):
        self.t += 1
        return self.t

    def kind(self, p):
        return "board" if p.endswith(".board.json") else "notebook" if p.endswith(".ipynb") else "file"

    def need(self, p):
        if p not in self.entries:
            raise WS.PageError("missing", "%s: no such file or folder" % p)
        return self.entries[p]

    def public(self, e):
        return {k: v for k, v in e.items() if k != "content"}

    def request(self, method, params, timeout):
        self.requests.append((method, params))
        if self.override is not None:
            return self.override
        verb = method.split(".", 1)[1]
        p = params.get("path")
        if verb == "list":
            folder = params.get("folder", "/").rstrip("/") + "/"
            out = [self.public(e) for q, e in sorted(self.entries.items()) if q != "/" and q.startswith(folder) and (params.get("recursive") or "/" not in q[len(folder):])]
            return {"entries": out}
        if verb == "stat":
            # (as web/workspace/api.ts: an entry, or null for none)
            return {"entry": self.public(self.entries[p]) if p in self.entries else None}
        if verb == "read":
            e = self.need(p)
            return {"entry": self.public(e), "rev": e["rev"], "content": e["content"]}
        if verb == "write":
            e = self.need(p)
            if params["base"] != e["rev"]:
                raise WS.PageError("conflict", "%s changed since revision %d" % (p, params["base"]), current={"entry": self.public(e), "rev": e["rev"], "content": e["content"]})
            e.update(content=params["content"], rev=e["rev"] + 1, updated=self.tick())
            return {"entry": self.public(e), "rev": e["rev"]}
        if verb in ("create", "mkdir"):
            if p in self.entries:
                raise WS.PageError("exists", "%s exists" % p)
            kind = "folder" if verb == "mkdir" else self.kind(p)
            e = {"path": p, "kind": kind, "created": self.tick(), "updated": self.t}
            if kind != "folder":
                e.update(content=params.get("content", {"text": ""}), rev=1)
            self.entries[p] = e
            return {"entry": self.public(e)}
        if verb == "rename":
            e = self.need(params["from"])
            if params["to"] in self.entries:
                raise WS.PageError("exists", "%s exists" % params["to"])
            del self.entries[params["from"]]
            e["path"] = params["to"]
            self.entries[params["to"]] = e
            return {"entry": self.public(e)}
        if verb == "remove":
            e = self.entries.pop(self.need(p)["path"])
            self.trash[p] = e
            return {"entry": dict(self.public(e), trashed={"from": p, "at": self.tick()})}
        if verb == "restore":
            if p not in self.trash:
                raise WS.PageError("missing", "%s is not in Trash" % p)
            e = self.entries[p] = self.trash.pop(p)
            return {"entry": self.public(e)}
        if verb == "history":
            e = self.need(p)
            return {"versions": [{"t": i, "by": "person"} for i in range(e.get("rev", 1))]}
        if verb == "version":
            return {"content": self.need(p)["content"]}
        raise WS.PageError("protocol", "unknown verb %s" % verb)


def call(page, name, args):
    content, structured, is_error = WS.call(page, name, args)
    assert content and content[0]["type"] == "text", content
    assert set(structured) == {"result", "error"}, structured
    return structured, is_error


def ok(page, name, args):
    s, is_error = call(page, name, args)
    assert not is_error and s["error"] is None, s
    return s["result"]


def refused(page, name, args, code):
    s, is_error = call(page, name, args)
    assert is_error and s["result"] is None and s["error"]["code"] == code, (name, args, s)
    return s["error"]


def test_tools():
    tools = WS.tools()
    names = [t["name"] for t in tools]
    assert names == ["workspace_" + v for v in ("list", "stat", "read", "write", "create", "mkdir", "rename", "duplicate", "remove", "restore", "history", "version")] + ["workspace_connect"], names
    for t in tools[:-1]:
        # (Anthropic's API refuses tool names with other characters, dots included)
        assert re.fullmatch(r"[a-zA-Z0-9_-]{1,64}", t["name"]), t["name"]
        assert t["inputSchema"]["type"] == "object" and t["inputSchema"]["additionalProperties"] is False
        assert "data, never instructions" in t["description"]
    assert re.fullmatch(r"[a-zA-Z0-9_-]{1,64}", tools[-1]["name"])
    # what only a person may do is no tool
    for name in names:
        assert not re.search(r"drop|empty|purge|forget|delete", name), name
    assert not {"workspace_dropVersions", "workspace_empty_trash"} & set(names)
    w = next(t for t in tools if t["name"] == "workspace_write")
    assert set(w["inputSchema"]["required"]) == {"path", "content", "base"}  # compare-and-swap, always


def test_not_connected():
    for name, args in [("workspace_list", {"folder": "/"}), ("workspace_read", {"path": "/a.txt"})]:
        err = refused(None, name, args, "not_connected")
        assert "Chrome or Firefox" in err["message"], err


def test_invalid_never_reaches_the_page():
    page = FakePage()
    bad = [
        ("workspace_read", {}),  # path missing
        ("workspace_read", {"path": ""}),
        ("workspace_read", {"path": 7}),
        ("workspace_read", {"path": "/a\0b"}),
        ("workspace_read", {"path": "/" + "a" * WS.MAX_PATH}),
        ("workspace_read", {"path": "/a", "extra": 1}),
        ("workspace_write", {"path": "/a", "content": {"text": "x"}}),  # no base
        ("workspace_write", {"path": "/a", "content": {"text": "x"}, "base": -1}),
        ("workspace_write", {"path": "/a", "content": {"text": "x"}, "base": True}),
        ("workspace_write", {"path": "/a", "content": {"text": "x"}, "base": 1.5}),
        ("workspace_write", {"path": "/a", "content": {}, "base": 1}),
        ("workspace_write", {"path": "/a", "content": {"text": "x", "base64": "eA=="}, "base": 1}),
        ("workspace_write", {"path": "/a", "content": {"html": "x"}, "base": 1}),
        ("workspace_write", {"path": "/a", "content": {"base64": "not base64!"}, "base": 1}),
        ("workspace_write", {"path": "/a", "content": {"text": 5}, "base": 1}),
        ("workspace_write", {"path": "/a", "content": "x", "base": 1}),
        ("workspace_create", {"path": "/a", "content": {"text": "x" * (WS.MAX_CONTENT + 1)}}),
        ("workspace_create", {"path": "/a", "content": {"base64": base64.b64encode(b"\0" * (WS.MAX_CONTENT + 1)).decode()}}),
        ("workspace_create", {"path": "/a", "content": {"json": {"k": "x" * WS.MAX_CONTENT}}}),
        ("workspace_list", {"folder": "/", "recursive": "yes"}),
        ("workspace_version", {"path": "/a", "index": "0"}),
        ("workspace_rename", {"from": "/a"}),
    ]
    for name, args in bad:
        refused(page, name, args, "invalid")
    assert page.requests == [], page.requests
    # exactly at the limit is allowed through
    ok(page, "workspace_create", {"path": "/big.bin", "content": {"base64": base64.b64encode(b"\1" * WS.MAX_CONTENT).decode()}})


def test_cas_and_contents():
    page = FakePage()
    ok(page, "workspace_mkdir", {"path": "/Algebra"})
    ok(page, "workspace_create", {"path": "/Algebra/notes.txt", "content": {"text": "Sylow\n"}})
    r = ok(page, "workspace_read", {"path": "/Algebra/notes.txt"})
    assert r["rev"] == 1 and r["content"] == {"encoding": "utf-8", "text": "Sylow\n", "size": 6}, r
    w = ok(page, "workspace_write", {"path": "/Algebra/notes.txt", "content": {"text": "Sylow p-subgroups\n"}, "base": 1})
    assert w["rev"] == 2
    # a write from a stale revision changes nothing and returns what is there now
    err = refused(page, "workspace_write", {"path": "/Algebra/notes.txt", "content": {"text": "lost?"}, "base": 1}, "conflict")
    assert err["current"]["rev"] == 2 and err["current"]["content"]["text"] == "Sylow p-subgroups\n", err
    assert page.entries["/Algebra/notes.txt"]["content"] == {"text": "Sylow p-subgroups\n"}
    content, structured, is_error = WS.call(page, "workspace_write", {"path": "/Algebra/notes.txt", "content": {"text": "x"}, "base": 1})
    assert "read it, merge, and write again" in content[0]["text"]
    # a board's document as JSON, binary bytes as base64
    board = {"format": "sagebrush-board", "version": 1, "nodes": [{"id": "a", "text": "$x^2$"}]}
    ok(page, "workspace_create", {"path": "/Algebra/G.board.json", "content": {"json": board}})
    r = ok(page, "workspace_read", {"path": "/Algebra/G.board.json"})
    assert r["content"]["encoding"] == "json" and r["content"]["json"] == board
    raw = bytes(range(256))
    ok(page, "workspace_create", {"path": "/data.bin", "content": {"base64": base64.b64encode(raw).decode()}})
    r = ok(page, "workspace_read", {"path": "/data.bin"})
    assert r["content"]["encoding"] == "base64" and base64.b64decode(r["content"]["base64"]) == raw and r["content"]["size"] == 256
    content, _, _ = WS.call(page, "workspace_read", {"path": "/data.bin"})
    assert content[0]["text"] == "(256 bytes of binary data, base64 in structuredContent)"
    # every request was an allowlisted verb on the wire
    assert all(m.startswith("workspace.") and m.split(".", 1)[1] in WS.VERBS for m, _ in page.requests), page.requests


def test_page_errors_and_trash():
    page = FakePage()
    ok(page, "workspace_create", {"path": "/a.txt"})
    refused(page, "workspace_create", {"path": "/a.txt"}, "exists")  # never overwritten
    assert ok(page, "workspace_stat", {"path": "/nope"}) == {"entry": None}  # (none there: null, as schema.json says)
    ok(page, "workspace_create", {"path": "/b.txt"})
    refused(page, "workspace_rename", {"from": "/a.txt", "to": "/b.txt"}, "exists")
    e = ok(page, "workspace_remove", {"path": "/a.txt"})["entry"]
    assert e["trashed"]["from"] == "/a.txt"
    refused(page, "workspace_read", {"path": "/a.txt"}, "missing")
    ok(page, "workspace_restore", {"path": "/a.txt"})
    assert ok(page, "workspace_stat", {"path": "/a.txt"})["entry"]["path"] == "/a.txt"
    listing = ok(page, "workspace_list", {"folder": "/"})
    assert [x["path"] for x in listing["entries"]] == ["/a.txt", "/b.txt"]
    content, _, _ = WS.call(page, "workspace_list", {"folder": "/"})
    assert content[0]["text"] == "/a.txt\n/b.txt"

    class Limited(FakePage):
        def request(self, method, params, timeout):
            raise WS.PageError("limit", "8 requests are in flight", retry_after_ms=250)

    err = refused(Limited(), "workspace_list", {"folder": "/"}, "limit")
    assert err["retryAfterMs"] == 250


def test_what_the_page_returns_is_checked():
    page = FakePage()
    ok(page, "workspace_create", {"path": "/a.txt"})
    e = {"entry": {"path": "/a.txt", "kind": "file"}, "rev": 1}
    for bad, code in [
        ("not an object", "protocol"),
        (dict(e, content={"exe": "x"}), "protocol"),
        (dict(e, content={"text": 3}), "protocol"),
        (dict(e, content={"base64": "%%%"}), "protocol"),
        (dict(e, content={"text": "x" * (WS.MAX_CONTENT + 1)}), "limit"),
    ]:
        page.override = bad
        refused(page, "workspace_read", {"path": "/a.txt"}, code)


def test_results_are_validated_whole():
    """CORR-6DA-1 (astra): every verb's result is checked whole against its
    shape before it is summarized or returned; a malformed one is a protocol
    error, never a success and never a crash."""
    page = FakePage()
    ok(page, "workspace_create", {"path": "/a.txt", "content": {"text": "x"}})
    entry = {"path": "/a.txt", "kind": "file"}
    bad = [
        ("workspace_read", {"path": "/a.txt"}, {}),
        ("workspace_read", {"path": "/a.txt"}, {"entry": entry, "rev": -1, "content": {"text": "x"}}),
        ("workspace_read", {"path": "/a.txt"}, {"entry": entry, "rev": True, "content": {"text": "x"}}),
        ("workspace_read", {"path": "/a.txt"}, {"entry": entry, "rev": 1}),
        ("workspace_write", {"path": "/a.txt", "content": {"text": "y"}, "base": 1}, {}),
        ("workspace_write", {"path": "/a.txt", "content": {"text": "y"}, "base": 1}, {"entry": entry}),
        ("workspace_stat", {"path": "/a.txt"}, {"entry": "bad"}),
        ("workspace_stat", {"path": "/a.txt"}, {"entry": {"path": "/a.txt"}}),
        ("workspace_stat", {"path": "/a.txt"}, {"entry": {"path": "a.txt", "kind": "file"}}),
        ("workspace_stat", {"path": "/a.txt"}, {"entry": {"path": "/a.txt", "kind": "socket"}}),
        ("workspace_mkdir", {"path": "/d"}, {}),
        ("workspace_list", {"folder": "/"}, {"entries": ["bad"]}),
        ("workspace_list", {"folder": "/"}, {"entries": "bad"}),
        ("workspace_list", {"folder": "/"}, {}),
        ("workspace_list", {"folder": "/"}, {"entries": [], "more": True}),
        ("workspace_list", {"folder": "/"}, {"entries": [], "more": "yes"}),
        ("workspace_history", {"path": "/a.txt"}, {"versions": ["x"]}),
        ("workspace_history", {"path": "/a.txt"}, {}),
        ("workspace_version", {"path": "/a.txt", "index": 0}, {}),
        ("workspace_version", {"path": "/a.txt", "index": 0}, {"content": {"json": float("nan")}}),
    ]
    for name, args, result in bad:
        page.override = result
        refused(page, name, args, "protocol")
    page.override = None
    # only the checked parts are passed on
    page.override = {"entry": dict(entry, extra=1), "rev": 3, "content": {"text": "z"}, "smuggled": "<script>"}
    r = ok(page, "workspace_read", {"path": "/a.txt"})
    assert set(r) == {"entry", "rev", "content"}, r
    page.override = {"entries": [entry], "more": True, "cursor": "c1"}
    r = ok(page, "workspace_list", {"folder": "/"})
    assert r == {"entries": [entry], "more": True, "cursor": "c1"}, r
    # a conflict's current version is checked too: a malformed one is left out
    class Conflict(FakePage):
        def request(self, method, params, timeout):
            raise WS.PageError("conflict", "changed", current={"entry": "bad", "rev": 2, "content": {"text": "x"}})

    err = refused(Conflict(), "workspace_write", {"path": "/a.txt", "content": {"text": "y"}, "base": 1}, "conflict")
    assert "current" not in err, err


def test_strict_json_and_unicode():
    """CORR-6DA-5 (astra): NaN, Infinity and lone surrogates are refused as
    invalid arguments (or a protocol error from the page), never sent and
    never an uncaught exception."""
    page = FakePage()
    for args in [
        {"path": "/a.json", "content": {"json": {"x": float("nan")}}},
        {"path": "/a.json", "content": {"json": {"v": [float("inf")]}}},
        {"path": "/a.json", "content": {"json": {"k": "\ud800"}}},
        {"path": "/a.txt", "content": {"text": "lone \udc00 surrogate"}},
        {"path": "/bad\ud800.txt"},
    ]:
        refused(page, "workspace_create", args, "invalid")
    assert page.requests == []
    page.override = {"entry": {"path": "/a.txt", "kind": "file"}, "rev": 1, "content": {"text": "\ud800"}}
    refused(page, "workspace_read", {"path": "/a.txt"}, "protocol")
    # the strict loader, as the pairing uses it for every frame
    for raw in [b'{"a": NaN}', b'[Infinity]', b'[-Infinity]', b'"\\ud800"', b'{"\\udfff": 1}', b'\xff']:
        try:
            WS.loads_strict(raw)
        except ValueError:
            continue
        raise AssertionError("accepted %r" % raw)
    assert WS.loads_strict(b'{"a": "\\ud83d\\ude00"}') == {"a": "\U0001F600"}  # (a pair is fine)
    # a key twice in an object, at any depth, is refused (P319-B1); the same key in two objects is fine
    for raw in (b'{"a": 1, "a": 2}', b'{"x": [{"b": 1, "b": 1}]}', b'[{"k": {"k": 1, "k": 2}}]'):
        try:
            WS.loads_strict(raw)
        except ValueError:
            continue
        raise AssertionError("accepted %r" % raw)
    assert WS.loads_strict(b'[{"a": 1}, {"a": 2}, {"a": {"a": 3}}]') == [{"a": 1}, {"a": 2}, {"a": {"a": 3}}]


def test_path_bounds():
    """LIMIT-6DA-2 (daybreak2): paths are bounded as web/workspace/paths.ts
    bounds them: 1024 characters, 32 folders deep, 255 per name; one past
    any of them never reaches the page."""
    page = FakePage()
    at_limit = ["/" + "/".join(["a" * WS.MAX_NAME] * 4), "/" + "/".join(["d"] * WS.MAX_DEPTH), "/" + "n" * WS.MAX_NAME]
    assert len(at_limit[0]) == WS.MAX_PATH
    for p in at_limit:
        assert len(p) <= WS.MAX_PATH
        n = len(page.requests)
        ok(page, "workspace_stat", {"path": p})
        assert len(page.requests) == n + 1, p[:40]  # (reached the page)
    n = len(page.requests)
    past = ["/" + "a" * WS.MAX_PATH, "/" + "/".join(["d"] * (WS.MAX_DEPTH + 1)), "/" + "n" * (WS.MAX_NAME + 1), "/ok/" + "n" * (WS.MAX_NAME + 1) + "/x"]
    for p in past:
        refused(page, "workspace_stat", {"path": p}, "invalid")
        refused(page, "workspace_rename", {"from": "/a", "to": p}, "invalid")
    assert len(page.requests) == n, page.requests[n:]
    assert (WS.MAX_PATH, WS.MAX_DEPTH, WS.MAX_NAME) == (1024, 32, 255)  # (paths.ts)


def test_tools_come_from_the_schema():
    """The tools' parameters are web/workspace/schema.json's, the copy in the
    package is that file (where the file exists: sync-python-package.sh
    --check says the same), and the schema's own rules are enforced."""
    schema = json.load(open(os.path.join(HERE, "python", "sagebrush", "workspace_schema.json"), encoding="utf-8"))
    tools = {t["name"]: t for t in WS.tools()}
    for method, v in schema["verbs"].items():
        params = {k: x for k, x in v["params"].items() if k != "$schema"}
        assert tools["workspace_" + method.split(".", 1)[1]]["inputSchema"] == params, method
    source = os.path.join(HERE, "..", "..", "web", "workspace", "schema.json")
    if os.path.exists(source):
        assert open(source, "rb").read() == open(os.path.join(HERE, "python", "sagebrush", "workspace_schema.json"), "rb").read(), \
            "sagebrush/workspace_schema.json differs from web/workspace/schema.json: run scripts/sync-python-package.sh"
    assert WS.MAX_CONTENT == schema["limits"]["maxContentBytes"] and WS.MAX_LIST == schema["limits"]["maxList"]
    page = FakePage()
    for name, args in [
        ("workspace_list", {}),  # folder is required
        ("workspace_stat", {"path": "relative/path"}),  # absolute only
        ("workspace_version", {"path": "/a", "i": 0}),  # the argument is index
        ("workspace_create", {"path": "/a.board.json", "content": {"json": [1, 2]}}),  # a document is an object
        ("workspace_create", {"path": "/a.bin", "content": {"base64": "not*base64"}}),
        ("workspace_create", {"path": "/a.txt", "content": {"text": "x", "json": {}}}),  # one form only
    ]:
        refused(page, name, args, "invalid")
    assert page.requests == []
    # answers bigger than the schema allows are protocol errors
    page.override = {"entries": [{"path": "/f%d" % i, "kind": "file"} for i in range(WS.MAX_LIST + 1)]}
    refused(page, "workspace_list", {"folder": "/"}, "protocol")
    page.override = {"versions": [{"t": i} for i in range(WS.MAX_HISTORY + 1)]}
    refused(page, "workspace_history", {"path": "/a"}, "protocol")


#: paths and whether web/workspace/paths.ts normPath accepts them (LIMIT-6DA-2)
PATH_CASES = [
    ("/", True), ("/a", True), ("/a/b.txt", True), ("/a/", True), ("/Trash", True), ("/a b/ü/日本.txt", True),
    ("/" + "/".join(["a" * 255] * 4), True), ("/" + "/".join(["d"] * 32), True), ("/" + "n" * 255, True),
    ("/" + "😀" * 127, True),  # (254 UTF-16 units)
    ("", False), ("a", False), ("a/b", False), ("./a", False), (" /a", False), ("ab", False), ("ab/c", False), ("xa/b/", False),
    ("//", False), ("/a//b", False), ("//a", False), ("/a//", False),
    ("/.", False), ("/..", False), ("/a/./b", False), ("/a/../b", False), ("/a/..", False), ("/a/.", False),
    ("/a\x00b", False), ("/a\x01", False), ("/a\tb", False), ("/a\nb", False), ("/a\x1f", False), ("/a\x7f", False),
    ("/" + "a" * 1024, False), ("/" + "/".join(["d"] * 33), False), ("/" + "n" * 256, False),
    ("/" + "😀" * 128, False),  # (256 UTF-16 units: too long a name in JavaScript's count)
    ("/" + "/".join(["😀" * 120] * 5), False),  # (1205 UTF-16 units, 605 code points)
]


def test_paths_are_refused_as_normpath_refuses_them():
    """LIMIT-6DA-2 (daybreak2): a path argument is accepted exactly when
    paths.ts normPath accepts it, and a refused one never reaches the page;
    where web/workspace/paths.ts exists, normPath itself (node) gives the
    same verdict on every case."""
    for p, good in PATH_CASES:
        assert (WS.path_error(p) is None) == good, (p[:40], WS.path_error(p))
    page = FakePage()
    for p, good in PATH_CASES:
        if good:
            continue
        for name, args in [("workspace_stat", {"path": p}), ("workspace_rename", {"from": "/a", "to": p}), ("workspace_list", {"folder": p}),
                           ("workspace_duplicate", {"path": "/a", "to": p})]:
            refused(page, name, args, "invalid")
    assert page.requests == [], page.requests
    for p, good in PATH_CASES:
        if good and p != "/":
            ok(page, "workspace_stat", {"path": p})
            assert page.requests[-1][1]["path"] == p, p[:40]  # (it reached the page, unchanged)
    paths_ts = os.environ.get("SAGEBRUSH_PATHS_TS") or os.path.join(HERE, "..", "..", "web", "workspace", "paths.ts")
    if not os.path.exists(paths_ts):
        print("  (normPath itself not compared: no web/workspace/paths.ts in this tree)")
        return
    import subprocess

    # (a copy as .mts, so that node loads it as a module wherever it is; paths.ts imports nothing)
    import shutil
    import tempfile

    tmp = tempfile.mkdtemp(prefix="normpath-")
    shutil.copy(paths_ts, os.path.join(tmp, "paths.mts"))
    script = ("import { normPath } from %s;\n"
              "const cases = JSON.parse((await import('node:fs')).readFileSync(0, 'utf8'));\n" % json.dumps("file://" + os.path.join(tmp, "paths.mts")))
    script += "process.stdout.write(JSON.stringify(cases.map((p) => { try { normPath(p); return true; } catch { return false; } })));\n"
    r = subprocess.run(["node", "--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", script],
                       input=json.dumps([p for p, _ in PATH_CASES]), capture_output=True, text=True, timeout=60)
    shutil.rmtree(tmp)
    assert r.returncode == 0, r.stderr
    verdicts = json.loads(r.stdout)
    for (p, good), js in zip(PATH_CASES, verdicts):
        assert js == good, "normPath %s %r, the case list says %s" % ("accepts" if js else "refuses", p[:40], good)


def test_schema_keywords_are_enforced_or_refused():
    """daybreak2 (31e850a1): enum is enforced (create's mode is one of the
    schema's languages), and a schema with a keyword this server does not
    enforce is refused when loaded, so the server does not start rather than
    skip an assertion."""
    page = FakePage()
    for mode in ("rust", "", "SAGE", 1, True):
        refused(page, "workspace_create", {"path": "/n.ipynb", "mode": mode}, "invalid")
    assert page.requests == []
    for mode in ("python", "sage", "magma", "matlab"):
        ok(page, "workspace_create", {"path": "/n-%s.ipynb" % mode, "mode": mode})
    for bad in [{"type": "string", "format": "uri"}, {"type": "number"}, {"type": "object", "additionalProperties": True},
                {"type": "object", "properties": {"x": {"type": "string", "maxItems": 3}}}, {"oneOf": [{"type": "string", "const": "a"}]},
                {"type": "array", "items": {}}, {"enum": []}]:
        try:
            WS.check_schema(bad)
        except ValueError:
            continue
        raise AssertionError("accepted %r" % bad)
    import tempfile

    schema = json.load(open(os.path.join(HERE, "python", "sagebrush", "workspace_schema.json"), encoding="utf-8"))
    WS.check_schema(schema["verbs"]["workspace.write"]["params"])  # (the real ones are fine)
    schema["verbs"]["workspace.stat"]["params"]["properties"]["path"]["format"] = "uri"
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
        json.dump(schema, f)
    try:
        WS.load_schema(f.name)
    except ValueError as e:
        assert "'format'" in str(e) and "workspace.stat" in str(e), e
    else:
        raise AssertionError("a schema with an unknown keyword loaded")
    finally:
        os.unlink(f.name)


def test_stat_null_is_absence():
    """CORR-3DF-1 (astra): schema.json's stat answers one entry or null.  An
    explicit null is "no entry there", a success; an omitted entry, or one
    that isn't an entry, is a protocol error."""
    page = FakePage()
    page.override = {"entry": None}
    content, s, err = WS.call(page, "workspace_stat", {"path": "/gone.txt"})
    assert not err and s["result"] == {"entry": None} and content[0]["text"] == "no entry at /gone.txt", s
    for bad in [{}, {"entry": "x"}, {"entry": False}, {"entry": {}}, {"entry": []}, {"entry": {"path": "/a"}}]:
        page.override = bad
        refused(page, "workspace_stat", {"path": "/a"}, "protocol")
    # null is stat's only: an entry-carrying verb with a null entry is still malformed
    for name, args in [("workspace_mkdir", {"path": "/d"}), ("workspace_read", {"path": "/a"}), ("workspace_remove", {"path": "/a"})]:
        page.override = {"entry": None, "rev": 1, "content": {"text": ""}}
        refused(page, name, args, "protocol")


def test_through_the_server():
    # (the installed package, whose engine is built: in CI, after
    # pip install engine/py/dist/*.whl; elsewhere it may be absent, and this
    # part is skipped, saying so; in CI that is a failure)
    try:
        from sagebrush import mcp_server
    except Exception as e:
        if os.environ.get("CI"):
            raise
        print("  (the server part skipped: %s: %s)" % (type(e).__name__, e))
        return
    assert mcp_server.WS.VERBS == WS.VERBS, "the installed sagebrush is not this tree's"
    out = io.StringIO()
    srv = mcp_server.Server(out)

    def rpc(rid, method, params):
        out.seek(0)
        out.truncate()
        srv.handle({"jsonrpc": "2.0", "id": rid, "method": method, "params": params})
        for t in srv.threads:
            t.join()
        return json.loads(out.getvalue().strip().splitlines()[-1])

    rpc(1, "initialize", {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "t", "version": "0"}})
    tools = {t["name"]: t for t in rpc(2, "tools/list", {})["result"]["tools"]}
    assert all(("workspace_" + v) in tools for v in WS.VERBS) and "sage" in tools and "workspace_connect" in tools
    assert tools["workspace_read"]["outputSchema"] == WS.OUTPUT_SCHEMA
    # arguments are checked first (nothing invalid reaches a page), then the link
    r = rpc(30, "tools/call", {"name": "workspace_list", "arguments": {}})
    assert r["result"]["isError"] and r["result"]["structuredContent"]["error"]["code"] == "invalid", r
    r = rpc(3, "tools/call", {"name": "workspace_list", "arguments": {"folder": "/"}})
    assert r["result"]["isError"] and r["result"]["structuredContent"]["error"]["code"] == "not_connected", r
    # workspace_connect: a code and a port on 127.0.0.1; until a page pairs, the verbs say so
    r = rpc(31, "tools/call", {"name": "workspace_connect", "arguments": {}})["result"]
    got = r["structuredContent"]["result"]
    assert not r["isError"] and len(got["code"]) == 26 and got["port"] > 0 and got["paired"] is False, r
    assert got["code"] in r["content"][0]["text"] and srv.link.sock.getsockname()[0] == "127.0.0.1"
    r = rpc(32, "tools/call", {"name": "workspace_list", "arguments": {"folder": "/"}})["result"]
    assert r["isError"] and r["structuredContent"]["error"]["code"] == "not_connected"
    srv.link.close()
    srv.link = FakePage()
    rpc(4, "tools/call", {"name": "workspace_create", "arguments": {"path": "/x.txt", "content": {"text": "hi"}}})
    r = rpc(5, "tools/call", {"name": "workspace_read", "arguments": {"path": "/x.txt"}})
    assert not r["result"]["isError"] and r["result"]["content"][0]["text"] == "hi", r
    # an older client gets no title (it is in the protocol from 2025-06-18)
    rpc(6, "initialize", {"protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": {"name": "t", "version": "0"}})
    assert all("title" not in t and "outputSchema" not in t for t in rpc(7, "tools/list", {})["result"]["tools"])


if __name__ == "__main__":
    for name, f in list(globals().items()):
        if name.startswith("test_") and callable(f):
            f()
            print("ok", name)
    print("all workspace tool tests passed")
