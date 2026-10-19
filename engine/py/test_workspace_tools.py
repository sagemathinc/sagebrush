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
            return {"entry": self.public(self.need(p))}
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
    for name, args in [("workspace_list", {}), ("workspace_read", {"path": "/a.txt"})]:
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
        ("workspace_list", {"recursive": "yes"}),
        ("workspace_version", {"path": "/a", "i": "0"}),
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
    refused(page, "workspace_stat", {"path": "/nope"}, "missing")
    ok(page, "workspace_create", {"path": "/b.txt"})
    refused(page, "workspace_rename", {"from": "/a.txt", "to": "/b.txt"}, "exists")
    e = ok(page, "workspace_remove", {"path": "/a.txt"})["entry"]
    assert e["trashed"]["from"] == "/a.txt"
    refused(page, "workspace_read", {"path": "/a.txt"}, "missing")
    ok(page, "workspace_restore", {"path": "/a.txt"})
    assert ok(page, "workspace_stat", {"path": "/a.txt"})["entry"]["path"] == "/a.txt"
    listing = ok(page, "workspace_list", {})
    assert [x["path"] for x in listing["entries"]] == ["/a.txt", "/b.txt"]
    content, _, _ = WS.call(page, "workspace_list", {})
    assert content[0]["text"] == "/a.txt\n/b.txt"

    class Limited(FakePage):
        def request(self, method, params, timeout):
            raise WS.PageError("limit", "8 requests are in flight", retry_after_ms=250)

    err = refused(Limited(), "workspace_list", {}, "limit")
    assert err["retryAfterMs"] == 250


def test_what_the_page_returns_is_checked():
    page = FakePage()
    ok(page, "workspace_create", {"path": "/a.txt"})
    for bad, code in [
        ("not an object", "protocol"),
        ({"content": {"exe": "x"}}, "protocol"),
        ({"content": {"text": 3}}, "protocol"),
        ({"content": {"base64": "%%%"}}, "protocol"),
        ({"content": {"text": "x" * (WS.MAX_CONTENT + 1)}}, "limit"),
    ]:
        page.override = bad
        refused(page, "workspace_read", {"path": "/a.txt"}, code)


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
    r = rpc(3, "tools/call", {"name": "workspace_list", "arguments": {}})
    assert r["result"]["isError"] and r["result"]["structuredContent"]["error"]["code"] == "not_connected", r
    # workspace_connect: a code and a port on 127.0.0.1; until a page pairs, the verbs say so
    r = rpc(31, "tools/call", {"name": "workspace_connect", "arguments": {}})["result"]
    got = r["structuredContent"]["result"]
    assert not r["isError"] and len(got["code"]) == 26 and got["port"] > 0 and got["paired"] is False, r
    assert got["code"] in r["content"][0]["text"] and srv.link.sock.getsockname()[0] == "127.0.0.1"
    r = rpc(32, "tools/call", {"name": "workspace_list", "arguments": {}})["result"]
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
