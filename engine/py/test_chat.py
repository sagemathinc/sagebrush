"""The chat adapter (sagebrush/chat.py, design/workspace-agent-protocol.md
§4): the page's messages into the agent's session, as Claude Code channel
events or through chat_next, never both; replies back to the page with
their ids; Claude Code's tool approvals relayed to the page and answered
only for prompts relayed; what the page sends checked, the queue bounded
with drops reported; and end to end, a page paired over a real socket
talking to the MCP server.

    python engine/py/test_chat.py
"""
import importlib.util
import io
import json
import os
import sys
import threading
import time
import types

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "python", "sagebrush")
try:
    from sagebrush import chat as CH, pairing as P, workspace_tools as WS
except Exception:
    if os.environ.get("CI"):
        raise
    pkg = types.ModuleType("sagebrush")
    pkg.__path__ = [SRC]
    sys.modules["sagebrush"] = pkg
    for name in ("workspace_tools", "pairing", "chat"):
        spec = importlib.util.spec_from_file_location("sagebrush." + name, os.path.join(SRC, name + ".py"))
        mod = importlib.util.module_from_spec(spec)
        sys.modules["sagebrush." + name] = mod
        spec.loader.exec_module(mod)
    from sagebrush import chat as CH, pairing as P, workspace_tools as WS


class Page:
    """The paired page, as the chat sees it: notify() records what the
    server sends it."""

    def __init__(self):
        self.sent = []

    def notify(self, method, params):
        self.sent.append((method, params))


def make(push):
    client, page = [], Page()
    chat = CH.Chat(lambda m, p: client.append((m, p)), lambda: page, push=push)
    return chat, client, page


def msg(i=1, author="person", text="make it bigger", conv="/Algebra/Sylow.chat", **ctx):
    return {"conversation": conv, "id": "m%d" % i, "author": author, "text": text,
            "context": ctx or {"path": "/Algebra/Sylow.board.json", "kind": "board", "rev": 7, "selection": {"items": ["n1", "n2"], "edges": []}}}


def test_channel_push():
    chat, client, page = make(push=True)
    chat.on_page("chat.message", msg())
    (method, params), = client
    assert method == "notifications/claude/channel"
    assert params["content"] == "make it bigger"
    meta = params["meta"]
    assert meta == {"author": "person", "conversation": "/Algebra/Sylow.chat", "msg_id": "m1", "path": "/Algebra/Sylow.board.json",
                    "kind": "board", "rev": "7", "selection": "items:n1,n2"}, meta
    # (Claude Code drops meta keys that aren't identifiers, and the values are strings)
    assert all(k.isidentifier() and isinstance(v, str) for k, v in meta.items())
    assert page.sent == [("chat.delivery", {"conversation": "/Algebra/Sylow.chat", "id": "m1", "via": "channel"})]
    # once chat_next is used, nothing more is pushed: no message by both ways
    assert chat.next(0) is None
    chat.on_page("chat.message", msg(2))
    assert len(client) == 1
    assert chat.next(0)["id"] == "m2"


def test_chat_next_and_reply():
    chat, client, page = make(push=False)
    out = {}
    t = threading.Thread(target=lambda: out.update(m=chat.next(5)))
    t.start()
    time.sleep(0.1)
    chat.on_page("chat.message", msg(author="collaborator:ana", text="and red"))
    t.join(5)
    m = out["m"]
    assert m["author"] == "collaborator:ana" and m["text"] == "and red" and "_size" not in m, m
    assert client == []  # (never pushed to a client that isn't Claude Code)
    assert page.sent[-1] == ("chat.delivery", {"conversation": "/Algebra/Sylow.chat", "id": "m1", "via": "chat_next"})
    t0 = time.time()
    assert chat.next(0.2) is None and time.time() - t0 >= 0.15
    r1 = chat.reply("/Algebra/Sylow.chat", "done", "m1")
    r2 = chat.reply("/Algebra/Sylow.chat", "and done")
    assert r1 != r2
    assert page.sent[-2:] == [("chat.reply", {"conversation": "/Algebra/Sylow.chat", "id": r1, "text": "done", "in_reply_to": "m1"}),
                              ("chat.reply", {"conversation": "/Algebra/Sylow.chat", "id": r2, "text": "and done"})]
    # no page: the reply is an error, never lost silently
    chat.link = lambda: None
    try:
        chat.reply("/a.chat", "x")
    except WS.NotConnected:
        pass
    else:
        raise AssertionError("a reply with no page succeeded")


def test_malformed_messages_are_not_delivered():
    chat, client, page = make(push=True)
    bad = [
        None, "text", {},
        dict(msg(), conversation="/Algebra/Sylow.board.json"),  # not a chat document
        dict(msg(), conversation="Sylow.chat"), dict(msg(), conversation="/a/../b.chat"),
        dict(msg(), id=""), dict(msg(), id="a b"), dict(msg(), id=5),
        dict(msg(), author="Person"), dict(msg(), author="agent"), dict(msg(), author="collaborator:a b"), dict(msg(), author=None),
        dict(msg(), text=3), dict(msg(), text="x" * (CH.MAX_TEXT + 1)), dict(msg(), context="x"),
    ]
    for b in bad:
        chat.on_page("chat.message", b)
    assert client == [] and page.sent == []
    # context fields that don't check out are left out, not passed on
    chat.on_page("chat.message", msg(path="../etc", kind="exe", rev=-1, selection={"items": ["ok", "a b", 3] + ["x%d" % i for i in range(100)]}))
    meta = client[-1][1]["meta"]
    assert "path" not in meta and "kind" not in meta and "rev" not in meta
    assert meta["selection"].startswith("items:ok,x0,") and len(meta["selection"].split(",")) == CH.MAX_SELECTION, meta["selection"]


def test_queue_bounds_and_drops():
    chat, client, page = make(push=False)
    for i in range(CH.QUEUE_PER_CONVERSATION + 5):
        chat.on_page("chat.message", msg(i, text="x"))
    drops = [p for m, p in page.sent if m == "chat.dropped"]
    assert [d["ids"] for d in drops] == [["m%d" % i] for i in range(5)], drops
    assert sum(len(q) for q in chat.queue.values()) == CH.QUEUE_PER_CONVERSATION
    # the byte bound across conversations: the oldest go first, and the page hears which
    page.sent.clear()
    big = "y" * (200 * 1024)
    for i in range(8):
        chat.on_page("chat.message", msg(1000 + i, text=big, conv="/c%d.chat" % i))
    assert chat.bytes <= CH.QUEUE_BYTES
    dropped = [i for m, p in page.sent if m == "chat.dropped" for i in p["ids"]]
    assert dropped and all(i.startswith("m") for i in dropped)
    assert chat.next(0)["id"] not in dropped


def test_permission_relay():
    chat, client, page = make(push=True)
    req = {"request_id": "abcde", "tool_name": "Bash", "description": "List files", "input_preview": '{"command":"ls"}'}
    chat.on_permission_request(req)
    assert page.sent == [("chat.permission_request", req)]
    # an answer for a prompt never relayed, or a malformed one, is ignored
    for v in [{"request_id": "zzzzz", "behavior": "allow"}, {"request_id": "abcde", "behavior": "maybe"}, "allow", None]:
        chat.on_page("chat.permission", v)
    assert client == []
    chat.on_page("chat.permission", {"request_id": "abcde", "behavior": "deny"})
    assert client == [("notifications/claude/channel/permission", {"request_id": "abcde", "behavior": "deny"})]
    # answered once only
    chat.on_page("chat.permission", {"request_id": "abcde", "behavior": "allow"})
    assert len(client) == 1
    # ids not of Claude Code's form are not relayed; long fields are cut
    page.sent.clear()
    for rid in ("abcdl", "ABCDE", "abcd", "abcdef", 5):
        chat.on_permission_request(dict(req, request_id=rid))
    assert page.sent == []
    chat.on_permission_request(dict(req, request_id="qwert", description="d" * 10000))
    assert len(page.sent[0][1]["description"]) == 4000
    # no page: the prompt is forgotten, so a later answer can't approve it
    chat.link = lambda: None
    chat.on_permission_request(dict(req, request_id="ghijk"))
    chat.link = lambda: page
    chat.on_page("chat.permission", {"request_id": "ghijk", "behavior": "allow"})
    assert len(client) == 1


def test_end_to_end():
    """The MCP server with a page paired over a real socket: the page's
    message reaches a Claude Code client as a channel event, the agent's
    chat_reply reaches the page; a Codex client gets it with chat_next."""
    try:
        from sagebrush import mcp_server
    except Exception as e:
        if os.environ.get("CI"):
            raise
        print("  (end to end skipped: %s: %s)" % (type(e).__name__, e))
        return
    sys.path.insert(0, HERE)
    from test_pairing import Client

    for client_name in ("claude-code", "codex"):
        out = io.StringIO()
        srv = mcp_server.Server(out)

        def rpc(rid, method, params):
            srv.handle({"jsonrpc": "2.0", "id": rid, "method": method, "params": params})
            for t in srv.threads:
                t.join()
            for line in reversed(out.getvalue().strip().splitlines()):
                m = json.loads(line)
                if m.get("id") == rid:
                    return m

        r = rpc(1, "initialize", {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": client_name, "version": "1"}})
        assert r["result"]["capabilities"]["experimental"] == {"claude/channel": {}, "claude/channel/permission": {}}
        assert "author=\"person\"" in r["result"]["instructions"]
        got = rpc(2, "tools/call", {"name": "workspace_connect", "arguments": {}})["result"]["structuredContent"]["result"]
        c = Client(got["port"])
        assert "result" in c.hello(got["code"])
        c.send({"jsonrpc": "2.0", "method": "chat.message", "params": msg(text="hello agent")})
        time.sleep(0.3)
        if client_name == "claude-code":
            events = [json.loads(x) for x in out.getvalue().splitlines() if '"notifications/claude/channel"' in x]
            assert events and events[-1]["params"]["content"] == "hello agent", out.getvalue()[-500:]
        else:
            r = rpc(3, "tools/call", {"name": "chat_next", "arguments": {"timeout": 5}})["result"]
            assert r["structuredContent"]["result"]["message"]["text"] == "hello agent", r
        delivery = c.recv()
        assert delivery["method"] == "chat.delivery", delivery
        r = rpc(4, "tools/call", {"name": "chat_reply", "arguments": {"conversation": "/Algebra/Sylow.chat", "text": "hi", "in_reply_to": "m1"}})["result"]
        assert not r["isError"], r
        rep = c.recv()
        assert rep["method"] == "chat.reply" and rep["params"]["text"] == "hi" and rep["params"]["in_reply_to"] == "m1", rep
        r = rpc(5, "tools/call", {"name": "chat_reply", "arguments": {"conversation": "/x.board.json", "text": "hi"}})["result"]
        assert r["isError"] and r["structuredContent"]["error"]["code"] == "invalid"
        c.close()
        srv.link.close()


if __name__ == "__main__":
    for name, f in list(globals().items()):
        if name.startswith("test_") and callable(f):
            f()
            print("ok", name)
    print("all chat tests passed")
