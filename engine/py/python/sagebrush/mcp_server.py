"""Sagebrush as an MCP server: research mathematics for AI agents.

    pip install sagebrush
    sagebrush-mcp            # an MCP server on stdin/stdout

Claude Code: `claude mcp add sagebrush -- sagebrush-mcp`.  Other clients:
{"command": "sagebrush-mcp"} (or "python -m sagebrush.mcp_server").

Tools: `sage` (Sage syntax in a persistent session), `python`, `reset`,
`guide`, and the shortcuts `factor`, `number_field` and `newforms`.  Each
computation has a time limit and is interrupted (Ctrl-C) when it is
exceeded; a session that does not stop is restarted.

The protocol (JSON-RPC 2.0, one message per line) is implemented here
directly, so the server needs nothing beyond this package.
"""

import json
import sys
import threading

PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"]

INSTRUCTIONS = """\
Sagebrush is free (MIT/Apache) computational mathematics: number theory,
algebra and exact linear algebra, with a Sage-compatible interface, run by
fast Rust engines. Use the `sage` tool for anything (Sage syntax: 2^10,
R.<x> = QQ[], 1/3 is exact); variables persist between calls. Call `guide`
for what is implemented. Results are exact; class groups and units assume
GRH where Sage/PARI do."""

GUIDE = """\
# Sagebrush: what the `sage` tool can do

Sage syntax and printing (`from sagebrush.sage import *` is done for you).
Results agree with Sage; everything runs in Rust engines (clean-room, MIT
OR Apache-2.0), with no Sage, PARI or FLINT installed.

**Integers and rationals:** factor(n) (ECM), is_prime, next_prime,
primes(a, b), gcd, xgcd, lcm, inverse_mod, power_mod, crt, euler_phi,
moebius, sigma, divisors, Integer(n).digits(), binomial, factorial, exact
rationals (1/3).

**Polynomials over ZZ and QQ:** R.<x> = ZZ[] or QQ[], arithmetic, f.factor(),
f.roots(), f.roots(RR)/f.roots(CC), gcd/lcm, quo_rem, resultant,
discriminant, derivative, is_irreducible.

**Number fields:** K.<a> = NumberField(x^3 - 11), QuadraticField(-23),
CyclotomicField(7); K.discriminant(), K.signature(), K.integral_basis(),
K.maximal_order(), K.class_group(), K.class_number(), K.unit_group(),
K.regulator(), K.primes_above(p), K.factor(p), element arithmetic, norm,
trace, minpoly. (Class groups and units: GRH-conditional, as in Sage.)

**Exact linear algebra:** matrix(ZZ or QQ, rows); det, rank, echelon_form,
inverse, charpoly, kernel, right_kernel, solve_right, solve_left,
hermite_form, smith_form, elementary_divisors, LLL; vector([...]).

**Modular forms:** ModularSymbols(N, k, sign), CuspForms(N, k),
ModularForms(N, k), Newforms(N, k) (rational coefficients; characters via
DirichletGroup), newform_orbits(N, k) for every Galois orbit with its LMFDB
label, dimension and trace form, Hecke characteristic polynomials (proven),
Gamma0(N).

**Elliptic curves:** EllipticCurve([a1, a2, a3, a4, a6]) or
EllipticCurve('11a1'); E.conductor(), E.discriminant(), E.j_invariant(),
E.rank(), E.torsion_order(), E.cremona_label(), E.ap(p), E.aplist(n),
E.anlist(n), E.sato_tate_moments(...).

**Plots:** x = var('x'); plot(sin(x), (x, 0, 3)), point, line,
parametric_plot, list_plot, show(...): returned as SVG.

**Python:** the `python` tool runs plain Python (no Sage preparsing), with
`sagebrush.nf`, `sagebrush.linalg`, `sagebrush.poly`, `sagebrush.modsym`,
`sagebrush.mf`, `sagebrush.ap` importable.

Not available (yet): multivariate polynomials and Groebner bases,
symbolic calculus beyond the basics, general finite fields, Newforms(N, k)
with irrational coefficients (use newform_orbits). If something is missing
the error says so.
"""


def _text(s):
    return {"type": "text", "text": s}


def _code_tool(name, desc):
    return {
        "name": name,
        "description": desc,
        "inputSchema": {
            "type": "object",
            "properties": {
                "code": {"type": "string", "description": "the code to run"},
                "timeout": {"type": "number", "description": "seconds before the computation is interrupted (default 60, at most 3600)"},
            },
            "required": ["code"],
        },
        "annotations": {"readOnlyHint": False, "destructiveHint": False, "openWorldHint": False},
    }


TOOLS = [
    _code_tool(
        "sage",
        "Run Sage code in a persistent Sagebrush session (variables persist between calls). "
        "Sage syntax: 2^10 is a power, 1/3 is exact, R.<x> = QQ[] defines a polynomial ring, [1..10] is a range. "
        "Number theory (factoring, number fields, class groups, units), polynomials, exact matrices over ZZ/QQ, "
        "modular forms and newforms, elliptic curves, plots (returned as SVG). Returns the printed output and the "
        "value of the last line. Call `guide` for the list of what is implemented.",
    ),
    _code_tool(
        "python",
        "Run plain Python (no Sage preparsing) in the same persistent session; the Sage names "
        "(from sagebrush.sage import *) and the engine modules (sagebrush.nf, .linalg, .poly, .mf, .modsym, .ap) are available.",
    ),
    {
        "name": "reset",
        "description": "Restart the session: all variables are cleared.",
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "guide",
        "description": "What Sagebrush implements (Sage functions and objects), with examples.",
        "inputSchema": {"type": "object", "properties": {}},
        "annotations": {"readOnlyHint": True},
    },
    {
        "name": "factor",
        "description": "Factor an integer (ECM; any size that ECM can split), e.g. n = \"2^128 + 1\".",
        "inputSchema": {"type": "object", "properties": {"n": {"type": "string", "description": "an integer or an integer expression"}}, "required": ["n"]},
        "annotations": {"readOnlyHint": True},
    },
    {
        "name": "number_field",
        "description": "Invariants of the number field Q[x]/(f): degree, signature, discriminant, integral basis, class group, class number, regulator, unit rank and torsion (class group and units assume GRH).",
        "inputSchema": {"type": "object", "properties": {"polynomial": {"type": "string", "description": "an irreducible polynomial in x, e.g. \"x^3 - 11\""}}, "required": ["polynomial"]},
        "annotations": {"readOnlyHint": True},
    },
    {
        "name": "newforms",
        "description": "The Galois orbits of newforms of level N and weight k (trivial character): LMFDB labels, dimensions, q-expansions and Hecke characteristic polynomials.",
        "inputSchema": {
            "type": "object",
            "properties": {"level": {"type": "integer", "minimum": 1}, "weight": {"type": "integer", "minimum": 2, "default": 2}},
            "required": ["level"],
        },
        "annotations": {"readOnlyHint": True},
    },
]

GUIDE_URI = "sagebrush://guide"


class Server:
    def __init__(self, out):
        self.out = out
        self.lock = threading.Lock()
        self.session = None
        self.running = {}  # request id -> True while a tool runs
        self.work = threading.Lock()  # one computation at a time
        self.plots = 0
        self.threads = []

    # ---- transport
    def send(self, msg):
        data = json.dumps(msg, separators=(",", ":"))
        with self.lock:
            self.out.write(data + "\n")
            self.out.flush()

    def reply(self, rid, result):
        self.send({"jsonrpc": "2.0", "id": rid, "result": result})

    def error(self, rid, code, message):
        self.send({"jsonrpc": "2.0", "id": rid, "error": {"code": code, "message": message}})

    # ---- the session
    def sess(self):
        if self.session is None:
            from sagebrush.session import Session

            self.session = Session()
        return self.session

    def run(self, code, mode="sage", timeout=60, isolated=False):
        timeout = max(1.0, min(float(timeout or 60), 3600.0))
        with self.work:
            r = self.sess().run(code, mode=mode, timeout=timeout, isolated=isolated)
        content = []
        text = []
        if r.get("restarted") and not r.get("error"):
            text.append("(The session had stopped and was restarted; earlier variables are gone.)")
        if r.get("stdout"):
            text.append(r["stdout"].rstrip("\n"))
        if r.get("result") is not None:
            text.append(r["result"])
        if r.get("error"):
            text.append(r["error"])
        for mime, data in r.get("displays", []):
            self.plots += 1
            uri = "sagebrush://plot/%d.svg" % self.plots
            text.append("[plot: %s (SVG, %d bytes)]" % (uri, len(data)))
            content.append({"type": "resource", "resource": {"uri": uri, "mimeType": mime, "text": data}})
        if not text:
            text.append("(no output)")
        return [_text("\n".join(text))] + content, bool(r.get("error"))

    # ---- tools
    def call_tool(self, name, args):
        if name in ("sage", "python"):
            if not isinstance(args.get("code"), str):
                raise ValueError("`code` (a string) is required")
            return self.run(args["code"], mode=name, timeout=args.get("timeout", 60))
        if name == "reset":
            if self.session is not None:
                with self.work:
                    self.session.restart()
            return [_text("The session was restarted.")], False
        if name == "guide":
            return [_text(GUIDE)], False
        if name == "factor":
            n = str(args.get("n", "")).strip()
            if not n:
                raise ValueError("`n` is required")
            return self.run("__n = Integer(%s)\nprint(factor(__n))" % n, isolated=True, timeout=args.get("timeout", 120))
        if name == "number_field":
            f = str(args.get("polynomial", "")).strip()
            if not f:
                raise ValueError("`polynomial` is required")
            code = (
                "R.<x> = QQ[]\nK.<a> = NumberField(R(%s))\n" % json.dumps(f)
                + "print('field:', K)\nprint('degree:', K.degree())\nprint('signature:', K.signature())\n"
                "print('discriminant:', K.discriminant(), '=', factor(K.discriminant()))\n"
                "print('integral basis:', K.integral_basis())\n"
                "G = K.class_group()\nprint('class group:', G, '(GRH)')\nprint('class number:', K.class_number())\n"
                "U = K.unit_group()\nprint('unit group:', U)\nprint('regulator:', K.regulator())\n"
            )
            return self.run(code, isolated=True, timeout=args.get("timeout", 300))
        if name == "newforms":
            n = int(args.get("level"))
            k = int(args.get("weight", 2) or 2)
            code = "for o in newform_orbits(%d, %d):\n    print(o)\n    print()" % (n, k)
            return self.run(code, isolated=True, timeout=args.get("timeout", 300))
        raise KeyError(name)

    def handle_tool_call(self, rid, params):
        name = params.get("name")
        args = params.get("arguments") or {}
        try:
            content, is_error = self.call_tool(name, args)
            self.reply(rid, {"content": content, "isError": is_error})
        except KeyError:
            self.error(rid, -32602, "unknown tool: %s" % name)
        except Exception as e:
            self.reply(rid, {"content": [_text("%s: %s" % (type(e).__name__, e))], "isError": True})
        finally:
            self.running.pop(rid, None)

    # ---- dispatch
    def handle(self, msg):
        method = msg.get("method")
        rid = msg.get("id")
        params = msg.get("params") or {}
        if method is None:
            return  # a response to us: nothing is ever requested
        if rid is None:
            # notifications
            if method == "notifications/cancelled":
                if params.get("requestId") in self.running and self.session is not None:
                    self.session.interrupt()
            return
        if method == "initialize":
            v = params.get("protocolVersion")
            self.reply(rid, {
                "protocolVersion": v if v in PROTOCOL_VERSIONS else PROTOCOL_VERSIONS[0],
                "capabilities": {"tools": {"listChanged": False}, "resources": {"listChanged": False}},
                "serverInfo": {"name": "sagebrush", "title": "Sagebrush", "version": _version()},
                "instructions": INSTRUCTIONS,
            })
        elif method == "ping":
            self.reply(rid, {})
        elif method == "tools/list":
            self.reply(rid, {"tools": TOOLS})
        elif method == "tools/call":
            self.running[rid] = True
            t = threading.Thread(target=self.handle_tool_call, args=(rid, params), daemon=True)
            self.threads = [x for x in self.threads if x.is_alive()] + [t]
            t.start()
        elif method == "resources/list":
            self.reply(rid, {"resources": [{"uri": GUIDE_URI, "name": "guide", "title": "What Sagebrush implements", "mimeType": "text/markdown"}]})
        elif method == "resources/read":
            if params.get("uri") != GUIDE_URI:
                self.error(rid, -32002, "resource not found: %s" % params.get("uri"))
            else:
                self.reply(rid, {"contents": [{"uri": GUIDE_URI, "mimeType": "text/markdown", "text": GUIDE}]})
        elif method in ("resources/templates/list",):
            self.reply(rid, {"resourceTemplates": []})
        elif method == "prompts/list":
            self.reply(rid, {"prompts": []})
        else:
            self.error(rid, -32601, "method not found: %s" % method)

    def serve(self, inp):
        for line in inp:
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except ValueError:
                self.send({"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "parse error"}})
                continue
            for m in msg if isinstance(msg, list) else [msg]:
                try:
                    self.handle(m)
                except Exception as e:  # never die on one bad message
                    if isinstance(m, dict) and m.get("id") is not None:
                        self.error(m["id"], -32603, "%s: %s" % (type(e).__name__, e))
        # end of input: answer the calls still running, then stop
        for t in self.threads:
            t.join()
        if self.session is not None:
            self.session.close()


def _version():
    try:
        from importlib.metadata import version

        return version("sagebrush")
    except Exception:
        return "dev"


def main():
    import io

    # the protocol owns stdout; anything else printed goes to stderr
    out = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", line_buffering=False, newline="\n")
    sys.stdout = sys.stderr
    inp = io.TextIOWrapper(sys.stdin.buffer, encoding="utf-8")
    if len(sys.argv) > 1 and sys.argv[1] in ("-h", "--help"):
        print(__doc__, file=sys.stderr)
        return
    Server(out).serve(inp)


if __name__ == "__main__":
    main()
