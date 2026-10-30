"""End-to-end checks of the MCP server (sagebrush.mcp_server) over stdio:
the raw protocol, runs (a ticket, a run deadline, a cancel), every
tool's structuredContent checked against its outputSchema (with what each
result rests on), and, when the official MCP SDK is installed (pip install
mcp), its client.

    python engine/py/test_mcp.py
"""
import json
import os
import subprocess
import sys
import tempfile
import time

# (the runs of these servers: a store of their own)
os.environ["SAGEBRUSH_RUNS_DIR"] = tempfile.mkdtemp(prefix="sb-mcp-runs-")


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
    r = call(10, "sage", {"code": "while True: pass", "wait": 30, "run_deadline": 2})
    assert r["result"]["isError"] and "interrupted" in text(r) and time.time() - t0 < 10, r
    if os.name == "posix":  # (on Windows the session may be restarted instead)
        assert text(call(11, "sage", {"code": "f.degree()"})) == "4"  # kept after the interrupt
    r = call(12, "sage", {"code": "x = var('x'); plot(sin(x), (x, 0, 3))"})
    assert any(c["type"] == "resource" and c["resource"]["mimeType"] == "image/svg+xml" for c in r["result"]["content"])
    # a ticket: the call returns, the computation goes on, run_result waits for it
    r = call(30, "sage", {"code": "import time\ntime.sleep(2)\n7", "wait": 0.2})
    t = text(r)
    assert not r["result"]["isError"] and t.startswith("Running as run_") and "[runs: 1 running here" in t, t
    h = t.split()[2]
    assert text(call(31, "run_result", {"handle": h, "wait": 30})) == "7"
    # the old timeout no longer stops anything: a ticket, then a hard cancel
    r = call(32, "sage", {"code": "while True: pass", "timeout": 1})
    h = text(r).split()[2]
    assert text(call(33, "run_status", {"handle": h})).startswith(h + ": running")
    assert text(call(34, "run_cancel", {"handle": h, "mode": "hard"})).startswith(h + ": delivered")
    r = call(35, "run_result", {"handle": h, "wait": 30})
    assert r["result"]["isError"] and "interrupted" in text(r), r
    if os.name == "posix":
        assert text(call(36, "sage", {"code": "f.degree()"})) == "4"  # (kept after the cancel)
    assert "Number fields" in rpc(p, 13, "resources/read", {"uri": "sagebrush://guide"})["result"]["contents"][0]["text"]
    assert rpc(p, 14, "nonexistent/method")["error"]["code"] == -32601
    t = text(rpc(p, 15, "tools/call", {"name": "search_docs", "arguments": {"query": "two descent"}}))
    assert t.startswith("EllipticCurve_rational_field.two_descent("), t
    j = json.loads(text(rpc(p, 16, "tools/call", {"name": "search_docs", "arguments": {"query": "two descent", "json": True}})))
    assert j["entries"][0]["name"] == "EllipticCurve_rational_field.two_descent" and "summary" in j["entries"][0] and j["omitted"] == 0, str(j)[:300]
    # (the hit count is bounded, whatever is asked: HARD-012-1)
    many = text(rpc(p, 17, "tools/call", {"name": "search_docs", "arguments": {"query": "e", "limit": 100000}}))
    assert len(many) <= 61000 and many.count("\n    ") >= 1, len(many)
    p.stdin.close()
    p.wait(10)
    print("raw protocol: ok")


def check(value, schema, where="$"):
    """value against the JSON Schema subset the server's outputSchemas use
    (and jsonschema itself when it is installed)."""
    t = schema.get("type")
    kinds = {"object": dict, "array": list, "string": str, "boolean": bool, "number": (int, float), "integer": int, "null": type(None)}
    if t is not None:
        ts = t if isinstance(t, list) else [t]
        ok = any(isinstance(value, kinds[k]) and not (k in ("integer", "number") and isinstance(value, bool)) for k in ts)
        assert ok, "%s: %r is not %s" % (where, value, t)
    if "enum" in schema:
        assert value in schema["enum"], "%s: %r not in %s" % (where, value, schema["enum"])
    if "anyOf" in schema:
        errs = []
        for sub in schema["anyOf"]:
            try:
                check(value, sub, where)
                break
            except AssertionError as e:
                errs.append(str(e))
        else:
            raise AssertionError("; ".join(errs))
    if "pattern" in schema and isinstance(value, str):
        import re
        assert re.search(schema["pattern"], value), "%s: %r" % (where, value)
    if isinstance(value, dict):
        for k in schema.get("required", []):
            assert k in value, "%s: %s is missing" % (where, k)
        for k, sub in schema.get("properties", {}).items():
            if k in value:
                check(value[k], sub, where + "." + k)
    if isinstance(value, list):
        assert len(value) >= schema.get("minItems", 0) and len(value) <= schema.get("maxItems", len(value)), where
        if isinstance(schema.get("items"), dict):
            for i, x in enumerate(value):
                check(x, schema["items"], "%s[%d]" % (where, i))


def structured():
    p = start()
    rpc(p, 1, "initialize", {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "test", "version": "0"}})
    tools = {t["name"]: t for t in rpc(p, 2, "tools/list")["result"]["tools"]}
    try:
        import jsonschema
    except ImportError:
        jsonschema = None
    rid = [10]

    def call(name, args, error=None):
        rid[0] += 1
        r = rpc(p, rid[0], "tools/call", {"name": name, "arguments": args})["result"]
        sc = r["structuredContent"]
        check(sc, tools[name]["outputSchema"], name)
        if jsonschema is not None:
            jsonschema.validate(sc, tools[name]["outputSchema"])
        assert sc["text"] == r["content"][0]["text"], (sc, r)
        # (a status never says more than its assumptions allow)
        assert (sc["status"] == "proven") <= (not sc["assumes"]) and (sc["status"] == "conditional") <= bool(sc["assumes"]), sc
        if sc["assumes"]:
            assert sc["status"] in ("conditional", "heuristic"), sc
        assert r["isError"] == (sc["error"] is not None), r
        if error is not None:
            assert r["isError"] and sc["error"]["type"] == error and sc["result"] is None, (error, sc)
        else:
            assert not r["isError"], r
        return sc

    for name, t in tools.items():
        if name.startswith(("workspace_", "chat_", "latex_comments_")):
            # (the workspace, chat and LaTeX comments tools' results are {result, error}: test_workspace_tools.py,
            # test_chat.py, test_latex_comments.py)
            assert t["outputSchema"]["type"] == "object" and t["outputSchema"]["required"] == ["result", "error"], name
            continue
        assert t["outputSchema"]["type"] == "object" and "status" in t["outputSchema"]["required"], name

    # sage and python: the value, printed output, plots; status unknown
    sc = call("sage", {"code": "a = 2^10\nprint('hi')\na + 1"})
    assert (sc["result"], sc["stdout"], sc["status"], sc["assumes"], sc["error"]) == ("1025", "hi\n", "unknown", [], None), sc
    assert call("python", {"code": "print(3 ** 2)"})["stdout"] == "9\n"
    sc = call("sage", {"code": "1/0"}, "exception")
    assert sc["error"]["exception"] == "ZeroDivisionError" and "rational division by zero" in sc["error"]["message"] and "Traceback" in sc["error"]["traceback"], sc
    assert call("sage", {"code": "1 +"}, "syntax")["error"]["exception"] == "SyntaxError"
    sc = call("sage", {"code": "is_prime(2^127 - 1, proof=True)"}, "unimplemented")
    assert sc["error"]["exception"] == "NotImplementedError" and "not implemented" in sc["error"]["message"], sc
    sc = call("sage", {"code": "while True: pass", "run_deadline": 2}, "interrupted")
    assert sc["run"]["ended_by"] == "run_deadline" and sc["run"]["attribution"] == "correlated" and sc["runs"]["running"] == 0, sc
    sc = call("sage", {"code": "import time; time.sleep(1); 5", "wait": 0})
    assert sc["run"]["state"] == "running" and sc["result"] is None and sc["runs"]["running"] == 1, sc
    h = sc["run"]["handle"]
    sc = call("run_result", {"handle": h, "wait": 30})
    assert sc["content_of_result"] and sc["result"]["state"] == "finished" and sc["result"]["value"] == {"text": "5"}, sc
    sc = call("run_list", {})
    assert any(e["handle"] == h for e in sc["result"]["runs"]) and "collaborators" in sc["result"]["note"], sc
    assert call("run_status", {"handle": "run_" + "a" * 26}, "not_found")["result"] is None
    # (a cancel's answer carries its request id, made by the server when none is given; a finished run is not_running)
    sc = call("run_cancel", {"handle": h, "mode": "soft"})
    assert sc["result"]["result"] == "not_running" and sc["result"]["request_id"].startswith("cancel_") and sc["result"]["request_id"] in sc["text"], sc
    assert call("run_cancel", {"handle": h, "mode": "soft", "request_id": sc["result"]["request_id"]})["result"] == sc["result"]
    sc = call("sage", {"code": "x = var('x'); plot(sin(x), (x, 0, 3))"})
    assert sc["result"] is None and len(sc["plots"]) == 1 and sc["plots"][0] in sc["text"], sc
    assert call("sage", {}, "invalid_arguments")["error"]["exception"] is None
    for name, args in (("search_docs", {"query": "class group"}), ("guide", {}), ("reset", {})):
        sc = call(name, args)
        assert sc["status"] == "unknown" and isinstance(sc["result"], str) and sc["result"], sc

    # factor: [[p, e]], proven only when every prime is
    sc = call("factor", {"n": "2^64 + 1"})
    assert sc["result"] == {"n": "18446744073709551617", "unit": 1, "factors": [["274177", 1], ["67280421310721", 1]]} and sc["status"] == "proven" and sc["assumes"] == [], sc
    assert call("factor", {"n": "-12"})["result"] == {"n": "-12", "unit": -1, "factors": [["2", 2], ["3", 1]]}
    assert call("factor", {"n": "1"})["result"]["factors"] == []
    sc = call("factor", {"n": "3 * (2^127 - 1)"})
    assert sc["status"] == "heuristic" and sc["assumes"] == ["170141183460469231731687303715884105727 is prime (Baillie-PSW)"], sc
    assert sc["result"]["factors"] == [["3", 1], ["170141183460469231731687303715884105727", 1]], sc
    call("factor", {"n": "0"}, "exception")
    call("factor", {"n": ""}, "invalid_arguments")
    assert call("factor", {"n": 2026})["result"]["factors"] == [["2", 1], ["1013", 1]]
    # the arguments are numbers, never code (daybreak2's INPUT-479-1): a
    # payload is refused before anything runs ...
    for bad in ["__import__('sagebrush.sage').sage.__setattr__('is_prime', lambda *a, **k: True) or 7",
                "setattr(__import__('sagebrush.sage', fromlist=['x']), 'is_prime', lambda *a, **k: True) or 7",
                # (astra's: a forged __sagebrush_data__, "proven", with no re-proof)
                "1)); __sagebrush_data__ = {'result': {'n':'9','unit':1,'factors':[['9',1]]}, 'text':'9','status':'proven','assumes':[]}; #",
                "Integer(7)", "(y := 7)", "[7][0]", "7 if 1 else 8", "2^(10^9)", "1/2", "7\n8"]:
        sc = call("factor", {"n": bad}, "invalid_arguments")
    for bad in ["x^2 + 1 + __import__('os').getpid()*0", "x.__class__", "y^2 + 1", "x^(1/2) + 1", "(x + 1)^1000"]:
        call("number_field", {"polynomial": bad}, "invalid_arguments")
    for bad in ["23; __sagebrush_data__ = {}", "23.5", "1e3", None]:
        call("newforms", {"level": bad}, "invalid_arguments")
    # (rational coefficients parse, and the engine refuses them: integral only)
    assert "integer coefficients" in call("number_field", {"polynomial": "x^2/4 + 23/4"}, "unimplemented")["error"]["message"]
    # ... and user code cannot reach the shortcut tools' session: a patched
    # is_prime in the sage tool's session leaves factor's status honest
    call("sage", {"code": "import sagebrush.sage as S\nS.is_prime = lambda *a, **k: True\nS.is_prime(2^127 - 1, proof=True)"})
    sc = call("factor", {"n": "3 * (2^127 - 1)"})
    assert sc["status"] == "heuristic" and sc["assumes"] == ["170141183460469231731687303715884105727 is prime (Baillie-PSW)"], sc
    call("reset", {})

    # number_field: each invariant with certified and assumes
    sc = call("number_field", {"polynomial": "x^3 - 11"})
    r = sc["result"]
    assert (r["degree"], r["signature"], r["discriminant"]["value"], r["discriminant"]["certified"]) == (3, [1, 1], "-3267", True), r
    assert r["discriminant_factorization"]["value"]["factors"] == [["3", 3], ["11", 2]] and r["unit_rank"] == {"value": 1, "certified": True, "assumes": []}, r
    assert r["class_group"] == {"value": {"order": 2, "invariants": [2]}, "certified": True, "assumes": []} and r["not_certified_because"] is None, r
    assert r["regulator"]["certified"] and r["regulator"]["value"].startswith("5.587206626"), r
    # the certificate's digits, not RR's rounding of them (astra's CORR-479-3)
    r2 = call("number_field", {"polynomial": "x^3 - 13*x - 22"})["result"]
    assert r2["regulator"]["certified"] and r2["regulator"]["value"].startswith("16.12085474122825"), r2
    # a factorization of an assumed discriminant assumes the same (CORR-479-2)
    for proof in (True, False):
        sc2 = call("number_field", {"polynomial": "x^2 - 2*(2^127 - 1)^2", "proof": proof})
        d, f = sc2["result"]["discriminant"], sc2["result"]["discriminant_factorization"]
        assert not d["certified"] and d["assumes"] and set(d["assumes"]) <= set(f["assumes"]) and not f["certified"] and sc2["status"] == "heuristic", sc2
    assert sc["status"] == ("proven" if r["torsion_order"]["certified"] else "heuristic"), sc
    assert "discriminant: -3267" in sc["text"] and "class number: 2" in sc["text"], sc["text"]
    sc = call("number_field", {"polynomial": "x^3 - 11", "proof": False})
    r = sc["result"]
    assert not r["class_group"]["certified"] and "GRH" in r["class_group"]["assumes"] and r["regulator"]["assumes"] == r["class_group"]["assumes"], r
    assert r["discriminant"]["certified"] and sc["status"] in ("conditional", "heuristic") and "GRH" in sc["assumes"], sc
    # proof=false on a quadratic field: the quadratic algorithms without their
    # certificate, labelled by the same data (the estimate in assumes)
    sc = call("number_field", {"polynomial": "x^2 + 67128026883063", "proof": False})
    r = sc["result"]
    assert r["class_group"]["value"] == {"order": 327924 * 16, "invariants": [327924, 2, 2, 2, 2]}, r
    assert not r["class_group"]["certified"] and any("estimate" in a for a in r["class_group"]["assumes"]), r
    assert sc["status"] == "heuristic", sc
    # the unconditional certificate has no default limit since #113 (a user's
    # own computation is unlimited): this field (Minkowski bound 2205315, once
    # refused by default) is now certified, with the class group proof=false gives
    sc = call("number_field", {"polynomial": "x^2 + 3*10^12 + 1"})
    r = sc["result"]
    assert not r.get("not_certified_because") and r["class_group"]["certified"], r
    h = call("number_field", {"polynomial": "x^2 + 3*10^12 + 1", "proof": False})["result"]["class_group"]["value"]
    assert r["class_group"]["value"] == h, (r["class_group"], h)
    assert r["regulator"] == {"value": "1", "certified": True, "assumes": []}, r  # (no units of infinite order)
    call("number_field", {"polynomial": "x^2 - 1"}, "exception")
    call("number_field", {"polynomial": "x^2 + 1", "proof": "yes"}, "invalid_arguments")

    # newforms: the orbits as data
    sc = call("newforms", {"level": 23})
    assert sc["status"] == "proven" and len(sc["result"]) == 1, sc
    o = sc["result"][0]
    assert (o["label"], o["dimension"], o["charpoly"], o["hecke_operator"], o["traces"][:5]) == ("23.2.a.a", 2, "x^2 + x - 1", [[2, 1], [3, 1]], ["2", "-1", "0", "-1", "-2"]), o
    assert [o["dimension"] for o in call("newforms", {"level": 389})["result"]] == [1, 2, 3, 6, 20]
    sc = call("newforms", {"level": 1})
    assert sc["result"] == [] and sc["text"].startswith("There are no newforms"), sc
    call("newforms", {"level": "eleven"}, "invalid_arguments")
    p.stdin.close()
    p.wait(10)

    # an older protocol: neither outputSchema nor structuredContent
    p = start()
    rpc(p, 1, "initialize", {"protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": {"name": "test", "version": "0"}})
    assert all("outputSchema" not in t for t in rpc(p, 2, "tools/list")["result"]["tools"])
    r = rpc(p, 3, "tools/call", {"name": "factor", "arguments": {"n": "2026"}})["result"]
    assert "structuredContent" not in r and r["content"][0]["text"] == "2 * 1013", r
    p.stdin.close()
    p.wait(10)
    print("structured results: ok" + ("" if jsonschema else " (jsonschema not installed: the built-in check only)"))


def cancelling():
    """notifications/cancelled interrupts the computation of that request
    only (daybreak2's CANCEL-479-1).  A call for a session that is running
    another run doesn't wait for it: it is refused, busy, naming that run
    (design-hprime-host-r5 §7), so it can never start late."""
    p = start()
    rpc(p, 1, "initialize", {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "test", "version": "0"}})
    rpc(p, 2, "tools/call", {"name": "sage", "arguments": {"code": "1"}})  # (the session started)

    def send(msg):
        p.stdin.write(json.dumps(dict(msg, jsonrpc="2.0")) + "\n")
        p.stdin.flush()

    def replies(ids):
        got = {}
        while set(ids) - set(got):
            m = json.loads(p.stdout.readline())
            if m.get("id") in ids:
                got[m["id"]] = m["result"]
        return got

    # A runs; B, for the same session, is refused (busy, naming A's run), and
    # cancelling B afterwards leaves A alone
    t0 = time.time()
    send({"id": 10, "method": "tools/call", "params": {"name": "sage", "arguments": {"code": "import time\ntime.sleep(3)\n'A done'"}}})
    time.sleep(0.5)
    send({"id": 11, "method": "tools/call", "params": {"name": "sage", "arguments": {"code": "'B ran'"}}})
    b = replies([11])[11]
    send({"method": "notifications/cancelled", "params": {"requestId": 11}})
    a = replies([10])[10]
    assert not a["isError"] and a["structuredContent"]["result"] == "'A done'", a
    assert b["isError"] and b["structuredContent"]["error"]["type"] == "busy" and b["structuredContent"]["run"]["handle"] == a["structuredContent"]["run"]["handle"], b
    assert b["structuredContent"]["run"]["state"] == "running" and time.time() - t0 >= 2.5
    # cancelling the running one interrupts it
    t0 = time.time()
    send({"id": 12, "method": "tools/call", "params": {"name": "sage", "arguments": {"code": "import time\ntime.sleep(30)"}}})
    time.sleep(1)
    send({"method": "notifications/cancelled", "params": {"requestId": 12}})
    c = replies([12])[12]
    assert c["isError"] and c["structuredContent"]["error"]["type"] == "interrupted" and time.time() - t0 < 10, c
    # a cancel for a finished request changes nothing after it
    send({"method": "notifications/cancelled", "params": {"requestId": 10}})
    assert rpc(p, 13, "tools/call", {"name": "sage", "arguments": {"code": "2 + 2"}})["result"]["structuredContent"]["result"] == "4"
    p.stdin.close()
    p.wait(10)
    print("cancellation: ok")


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
                # (the client checks structuredContent against the outputSchema)
                res = await s.call_tool("factor", {"n": "2^64 + 1"})
                sc = getattr(res, "structuredContent", None) or res.structured_content
                assert sc["result"]["factors"] == [["274177", 1], ["67280421310721", 1]], res
    anyio.run(go)
    print("official MCP client: ok")


def version():
    # --version: one line on stdout, both packages' versions, without starting the server
    for flag in ("--version", "-V"):
        p = subprocess.run([sys.executable, "-m", "sagebrush.mcp_server", flag], stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=60)
        assert p.returncode == 0, p
        line = p.stdout
        import re
        assert re.fullmatch(r"sagebrush-mcp( [0-9][0-9a-z.+-]*| dev)? \(sagebrush ([0-9][0-9a-z.+-]*|dev)\)\n", line), repr(line)
    print("--version: ok:", line.strip())


if __name__ == "__main__":
    version()
    raw()
    structured()
    cancelling()
    piped()
    sdk()
