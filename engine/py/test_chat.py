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
    # (each: the message, the reason's code, and whether the conversation and id are echoed)
    bad = [
        (None, "malformed", False, False), ("text", "malformed", False, False), ({}, "conversation", False, False),
        (dict(msg(), conversation="/Algebra/Sylow.board.json"), "conversation", False, True),  # not a chat document
        (dict(msg(), conversation="Sylow.chat"), "conversation", False, True), (dict(msg(), conversation="/a/../b.chat"), "conversation", False, True),
        (dict(msg(), id=""), "id", True, False), (dict(msg(), id="a b"), "id", True, False), (dict(msg(), id=5), "id", True, False),
        (dict(msg(), author="Person"), "author", True, True), (dict(msg(), author="agent"), "author", True, True),
        (dict(msg(), author="collaborator:a b"), "author", True, True), (dict(msg(), author=None), "author", True, True),
        (dict(msg(), text=3), "text", True, True), (dict(msg(), text="x" * (CH.MAX_TEXT + 1)), "too_long", True, True),
        (dict(msg(), context="x"), "context", True, True),
    ]
    for b, code, conv, mid in bad:
        page.sent.clear()
        chat.on_page("chat.message", b)
        # (not delivered, and the page is told why: board's chat.rejected)
        assert client == [], b
        (method, params), = page.sent
        assert method == "chat.rejected" and params["reason"]["code"] == code and params["reason"]["message"], (b if not isinstance(b, dict) else code, params)
        assert ("conversation" in params) == conv and ("id" in params) == mid, (code, params)
        if mid:
            assert params["id"] == "m1"
    page.sent.clear()
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
    assert len(chat.queue) == CH.QUEUE_PER_CONVERSATION == chat.counts["/Algebra/Sylow.chat"]
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


def test_global_arrival_order():
    """CORR-B011-2 (astra): delivery and eviction both take the oldest
    message first, whatever its conversation: A1, B2, A3 come out in that
    order, and the byte bound drops A1 first."""
    chat, client, page = make(push=False)
    for i, conv in [(1, "/A.chat"), (2, "/B.chat"), (3, "/A.chat")]:
        chat.on_page("chat.message", msg(i, text="t%d" % i, conv=conv))
    assert [chat.next(0)["id"] for _ in range(3)] == ["m1", "m2", "m3"]
    assert chat.bytes == 0 and not chat.counts and not chat.queue
    big = "y" * (250 * 1024)  # (five of these are over the 1 MiB bound; four are not)
    for i, conv in [(1, "/A.chat"), (2, "/B.chat"), (3, "/A.chat"), (4, "/C.chat"), (5, "/D.chat")]:
        chat.on_page("chat.message", msg(i, text=big, conv=conv))
    assert not [p for m, p in page.sent if m == "chat.rejected"]
    drops = [(p["conversation"], p["ids"]) for m, p in page.sent if m == "chat.dropped"]
    assert drops == [("/A.chat", ["m1"])], drops  # (the oldest message, not the oldest conversation's newest)
    assert [chat.next(0)["id"] for _ in range(4)] == ["m2", "m3", "m4", "m5"]


def test_one_chat_next_at_a_time():
    """LIMIT-B011-1 (daybreak2): one chat_next waits at a time; another is
    refused at once, not parked in a thread; after it returns, the next is
    admitted.  Through the server, tool calls in flight are bounded too."""
    chat, client, page = make(push=False)
    out = {}
    t = threading.Thread(target=lambda: out.update(m=chat.next(5)))
    t.start()
    time.sleep(0.1)
    t0 = time.time()
    try:
        chat.next(5)
    except CH.Busy:
        pass
    else:
        raise AssertionError("a second chat_next waited")
    assert time.time() - t0 < 0.5
    chat.on_page("chat.message", msg())
    t.join(5)
    assert out["m"]["id"] == "m1" and not chat.waiting
    assert chat.next(0) is None  # (admitted again)
    try:
        from sagebrush import mcp_server
    except Exception as e:
        if os.environ.get("CI"):
            raise
        print("  (the server part skipped: %s)" % e)
        return
    srv = mcp_server.Server(io.StringIO())
    srv.handle({"jsonrpc": "2.0", "id": 0, "method": "initialize", "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "codex"}}})
    before = threading.active_count()
    for i in range(40):
        srv.handle({"jsonrpc": "2.0", "id": i + 1, "method": "tools/call", "params": {"name": "chat_next", "arguments": {"timeout": 2}}})
    time.sleep(0.3)
    assert threading.active_count() - before <= mcp_server.MAX_CALLS, threading.active_count() - before
    for t in srv.threads:
        t.join(10)
    replies = [r for r in (json.loads(x) for x in srv.out.getvalue().splitlines()) if isinstance(r.get("id"), int) and r["id"] >= 1]
    refused = [r for r in replies if "error" in r and "too many tool calls" in r["error"]["message"]]
    busy = [r for r in replies if "result" in r and r["result"]["isError"] and r["result"]["structuredContent"]["error"]["code"] == "busy"]
    waited = [r for r in replies if "result" in r and not r["result"]["isError"]]
    # (one waits; every other is refused at once, as busy, or by the cap if they overlap)
    assert len(waited) == 1 and len(busy) + len(refused) == 39, (len(refused), len(busy), len(waited))
    # the cap on tool calls in flight, with calls that hold their thread
    gate = threading.Event()
    srv2 = mcp_server.Server(io.StringIO())
    srv2.call_tool = lambda name, args, rid=None: (gate.wait(10), ([{"type": "text", "text": "x"}], None, False))[1]
    for i in range(mcp_server.MAX_CALLS + 5):
        srv2.handle({"jsonrpc": "2.0", "id": i + 1, "method": "tools/call", "params": {"name": "guide", "arguments": {}}})
    time.sleep(0.2)
    over = [json.loads(x) for x in srv2.out.getvalue().splitlines()]
    assert len(over) == 5 and all("too many tool calls" in r["error"]["message"] for r in over), over
    assert len(srv2.running) == mcp_server.MAX_CALLS and srv2.calls == mcp_server.MAX_CALLS
    gate.set()
    for t in srv2.threads:
        t.join(10)
    assert srv2.calls == 0 and not srv2.running
    # LIMIT-BF6-1 (daybreak2): one id repeated while it is in flight is refused,
    # not a thread more under the same entry; the cap is counted on its own
    gate2 = threading.Event()
    srv3 = mcp_server.Server(io.StringIO())
    srv3.call_tool = lambda name, args, rid=None: (gate2.wait(10), ([{"type": "text", "text": "x"}], None, False))[1]
    before = threading.active_count()
    for i in range(mcp_server.MAX_CALLS + 5):
        srv3.handle({"jsonrpc": "2.0", "id": "same", "method": "tools/call", "params": {"name": "guide", "arguments": {}}})
    for bad in (True, 1.5, None, ["x"]):
        srv3.handle({"jsonrpc": "2.0", "id": bad, "method": "tools/call", "params": {"name": "guide", "arguments": {}}})
    time.sleep(0.2)
    assert threading.active_count() - before == 1, threading.active_count() - before
    over = [json.loads(x) for x in srv3.out.getvalue().splitlines()]
    assert len(over) == mcp_server.MAX_CALLS + 4 + 3 and all(r["error"]["code"] == -32600 for r in over), over
    assert srv3.calls == 1 and list(srv3.running) == ["same"]
    # the others still fill the cap, and no more
    for i in range(mcp_server.MAX_CALLS + 2):
        srv3.handle({"jsonrpc": "2.0", "id": i, "method": "tools/call", "params": {"name": "guide", "arguments": {}}})
    time.sleep(0.2)
    assert srv3.calls == mcp_server.MAX_CALLS and threading.active_count() - before == mcp_server.MAX_CALLS
    gate2.set()
    for t in srv3.threads:
        t.join(10)
    assert srv3.calls == 0 and not srv3.running
    # (an id answered may be used again)
    srv3.handle({"jsonrpc": "2.0", "id": "same", "method": "tools/call", "params": {"name": "guide", "arguments": {}}})
    for t in srv3.threads:
        t.join(10)
    assert "error" not in json.loads(srv3.out.getvalue().splitlines()[-1])


def test_text_cap_in_bytes():
    """daybreak2 (b011ccd4): text is capped in UTF-8 bytes, so a message at
    the cap always fits the queue."""
    chat, client, page = make(push=False)
    at_cap = "\U0001F600" * (CH.MAX_TEXT // 4)  # (256 KiB of 4-byte characters)
    chat.on_page("chat.message", msg(text=at_cap))
    assert not [m for m, p in page.sent if m in ("chat.rejected", "chat.dropped")], page.sent
    assert chat.next(0)["text"] == at_cap
    chat.on_page("chat.message", msg(2, text=at_cap + "x"))
    (m, p), = [x for x in page.sent if x[0] == "chat.rejected"]
    assert p["reason"]["code"] == "too_long" and p["id"] == "m2"
    # replies too (astra's CORR-BF6-1, daybreak2): bytes of UTF-8, not characters
    chat.reply("/A.chat", at_cap)
    assert page.sent[-1] == ("chat.reply", {"conversation": "/A.chat", "id": "r1", "text": at_cap})
    n = len(page.sent)
    for over in (at_cap + "x", "\u00e9" * (CH.MAX_TEXT // 2 + 1), "\U0001F600" * (CH.MAX_TEXT // 2)):
        try:
            chat.reply("/A.chat", over)
        except ValueError:
            pass
        else:
            raise AssertionError("a reply over the cap was sent")
    assert len(page.sent) == n
    try:
        from sagebrush import mcp_server
    except Exception as e:
        if os.environ.get("CI"):
            raise
        print("  (the server part skipped: %s)" % e)
        return
    srv = mcp_server.Server(io.StringIO())
    srv.link = Page()
    for text, ok in ((at_cap, True), ("\u00e9" * (CH.MAX_TEXT // 2), True), (at_cap + "x", False),
                     ("\u00e9" * (CH.MAX_TEXT // 2) + "x", False), ("\U0001F600" * (CH.MAX_TEXT // 2), False)):
        content, structured, is_error = srv.chat_tool("chat_reply", {"conversation": "/A.chat", "text": text})
        assert is_error is not ok, (len(text), structured)
        if not ok:
            assert structured["error"]["code"] == "invalid" and "bytes of UTF-8" in structured["error"]["message"]
    assert [p["text"] for m, p in srv.link.sent if m == "chat.reply"] == [at_cap, "\u00e9" * (CH.MAX_TEXT // 2)]


def test_prompts_belong_to_their_pairing():
    """astra (b011ccd4): a prompt relayed to one pairing can't be answered
    after the page paired again (even the same person's page): the new page
    never saw it."""
    chat, client, page = make(push=True)
    page.pairings = 1
    chat.on_permission_request({"request_id": "abcde", "tool_name": "Bash", "description": "x", "input_preview": "{}"})
    page.pairings = 2  # (paired again)
    chat.on_page("chat.permission", {"request_id": "abcde", "behavior": "allow"})
    assert client == []
    chat.on_permission_request({"request_id": "fghij", "tool_name": "Bash", "description": "x", "input_preview": "{}"})
    chat.on_page("chat.permission", {"request_id": "fghij", "behavior": "allow"})
    assert client == [("notifications/claude/channel/permission", {"request_id": "fghij", "behavior": "allow"})]


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
