"""End-to-end checks of the MCP server (sagebrush.mcp_server) over stdio:
the raw protocol, a time limit that interrupts the computation, and, when
the official MCP SDK is installed (pip install mcp), its client.

    python engine/py/test_mcp.py
"""
import json
import os
import subprocess
import sys
import time


def start():
    return subprocess.Popen([sys.executable, "-m", "sagebrush.mcp_server"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1)


def rpc(p, rid, method, params=None):
    p.stdin.write(json.dumps({"jsonrpc": "2.0", "id": rid, "method": method, "params": params or {}}) + "\n")
    p.stdin.flush()
    while True:
        msg = json.loads(p.stdout.readline())
        if msg.get("id") == rid:
            return msg


def text(r):
    return "\n".join(c["text"] for c in r["result"]["content"] if c["type"] == "text")


def raw():
    p = start()
    r = rpc(p, 1, "initialize", {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "test", "version": "0"}})
    assert r["result"]["protocolVersion"] == "2025-06-18" and r["result"]["serverInfo"]["name"] == "sagebrush", r
    p.stdin.write(json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}) + "\n")
    names = [t["name"] for t in rpc(p, 2, "tools/list")["result"]["tools"]]
    assert {"sage", "python", "search_docs", "reset", "guide", "factor", "number_field", "newforms"} <= set(names), names
    call = lambda rid, name, args: rpc(p, rid, "tools/call", {"name": name, "arguments": args})
    assert text(call(3, "sage", {"code": "R.<x> = QQ[]\nf = x^4 - 1\nf.factor()"})) == "(x - 1) * (x + 1) * (x^2 + 1)"
    assert text(call(4, "sage", {"code": "f.degree()"})) == "4"  # the session persists
    r = call(5, "sage", {"code": "1/0"})
    assert r["result"]["isError"] and "rational division by zero" in text(r)
    assert text(call(6, "python", {"code": "print(sum(range(10)))"})) == "45"
    assert text(call(7, "factor", {"n": "2^64 + 1"})) == "274177 * 67280421310721"
    t = text(call(8, "number_field", {"polynomial": "x^3 - 11"}))
    assert "discriminant: -3267" in t and "class number: 2" in t, t
    assert "23.2.a.a" in text(call(9, "newforms", {"level": 23}))
    t0 = time.time()
    r = call(10, "sage", {"code": "while True: pass", "timeout": 2})
    assert r["result"]["isError"] and "time limit" in text(r) and time.time() - t0 < 10
    if os.name == "posix":  # (on Windows the session may be restarted instead)
        assert text(call(11, "sage", {"code": "f.degree()"})) == "4"  # kept after the interrupt
    r = call(12, "sage", {"code": "x = var('x'); plot(sin(x), (x, 0, 3))"})
    assert any(c["type"] == "resource" and c["resource"]["mimeType"] == "image/svg+xml" for c in r["result"]["content"])
    assert "Number fields" in rpc(p, 13, "resources/read", {"uri": "sagebrush://guide"})["result"]["contents"][0]["text"]
    assert rpc(p, 14, "nonexistent/method")["error"]["code"] == -32601
    t = text(rpc(p, 15, "tools/call", {"name": "search_docs", "arguments": {"query": "two descent"}}))
    assert t.startswith("EllipticCurve_rational_field.two_descent("), t
    p.stdin.close()
    p.wait(10)
    print("raw protocol: ok")


def piped():
    # requests piped in, stdin closed at once: every call is still answered
    reqs = [
        {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "t", "version": "0"}}},
        {"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": "sage", "arguments": {"code": "factor(2026)"}}},
    ]
    p = subprocess.run([sys.executable, "-m", "sagebrush.mcp_server"], input="".join(json.dumps(r) + "\n" for r in reqs), capture_output=True, text=True, timeout=120)
    out = [json.loads(l) for l in p.stdout.splitlines() if l.strip()]
    assert any(m.get("id") == 2 and m["result"]["content"][0]["text"] == "2 * 1013" for m in out), out
    print("piped input: ok")


def sdk():
    try:
        import anyio
        from mcp import ClientSession, StdioServerParameters
        from mcp.client.stdio import stdio_client
    except ImportError:
        print("official MCP client: skipped (pip install mcp)")
        return

    async def go():
        params = StdioServerParameters(command=sys.executable, args=["-m", "sagebrush.mcp_server"])
        async with stdio_client(params) as (r, w):
            async with ClientSession(r, w) as s:
                await s.initialize()
                tools = await s.list_tools()
                assert "sage" in [t.name for t in tools.tools]
                res = await s.call_tool("sage", {"code": "K.<a> = NumberField(x^2 + 23); K.class_number()"})
                assert res.content[0].text == "3", res
    anyio.run(go)
    print("official MCP client: ok")


if __name__ == "__main__":
    raw()
    piped()
    sdk()
