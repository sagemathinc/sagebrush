// ci: web-runner order=180 runner=bun chrome
// A paired agent end to end (design/workspace-agent-protocol.md §5): the REAL pairing server
// (engine/py/python/sagebrush/pairing.py, the one sagebrush-mcp runs) and a page in headless Chromium with the real
// workspace (IndexedDB), connected as a person would: a ?pair= link, Connect, the grant dialog, Allow, Revoke.
// The server's side is driven as an agent's tools drive it (Pairing.request).  What it shows:
//   - a wrong code is refused, and a used code can't be used again;
//   - the grant's folders and write are the page's to enforce, and it does: outside them nothing is read or changed;
//   - an unknown verb, and params that break the schema, are refused;
//   - an agent's changes are credited to agent:<name> in the workspace's log;
//   - Revoke cuts the agent off at once, and the grant is forgotten.
//   CHROME=google-chrome bun web/workspace/test-agent-e2e.mjs
import net from "node:net";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { devtoolsPort } from "../test-port.mjs";

const here = new URL(".", import.meta.url).pathname;
let failures = 0;
const ok = (c, msg) => { console.log((c ? "ok   " : "FAIL ") + msg); if (!c) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- the page
const site = mkdtempSync(join(tmpdir(), "sb-agent-e2e-"));
writeFileSync(join(site, "entry.ts"), `
import { Workspace } from ${JSON.stringify(join(here, "api.ts"))};
import { mountAgentPairing } from ${JSON.stringify(join(here, "agent-ui.ts"))};
import { AgentPairing } from ${JSON.stringify(join(here, "agent-pair.ts"))};
import * as gitBranches from ${JSON.stringify(join(here, "git-branch.ts"))};
const ws = await Workspace.open();
// (test only: a fake clock, window.__skew ms ahead of the real one, for expiries inside the retry window)
const realNow = Date.now;
Date.now = () => realNow() + ((window as any).__skew ?? 0);
// (test only: the clock taken back to the moment the test noted before a reload (sessionStorage "__clockAt"), so the
//  reload's own time, however slow the machine, can't pass an expiry the test set just before it)
{ const at = sessionStorage.getItem("__clockAt"); if (at) { sessionStorage.removeItem("__clockAt"); (window as any).__skew = Number(at) - realNow(); } }
// (test only: the remembered grant's store made slow, window.__grantDelay ms, to hold an allow() in its await)
const putAgentGrant = ws.putAgentGrant.bind(ws);
(ws as any).putAgentGrant = async (...a: any[]) => { const d = (window as any).__grantDelay; if (d) await new Promise((r) => setTimeout(r, d)); return (putAgentGrant as any)(...a); };
// (?r=1: the page keeps a reload record (A14), so a reload's silent restore is restoreWith's, not a remembered grant's)
// (it offers git_branch, as the Agents and board pages do: chat plan PR 3)
const ui = mountAgentPairing(ws as any, { branches: gitBranches, ...(new URLSearchParams(location.search).has("r") ? { reload: { scope: { workspace: "e2e", page: "/" } } } : {}) });
// (a second page's attempt, made the same way the dialog makes one)
const tryPair = async (code: string, port: number) => {
  const p = new AgentPairing(port, { code }, { verbsFor: (a) => ws.forAgent(a) as any, store: ws as any, trashEntry: async () => null, page: { origin: location.origin, path: "/" } });
  try { await p.paired(); await p.revoke("test"); return "paired"; } catch (e) { return "refused: " + (e as Error).message; }
};
(window as any).T = { ws, ui, tryPair };
(window as any).ready = true;
`);
const built = await Bun.build({ entrypoints: [join(site, "entry.ts")], outdir: site, naming: "page.js", target: "browser", format: "esm" });
if (!built.success) { console.error(built.logs.join("\n")); process.exit(1); }
writeFileSync(join(site, "index.html"), `<!doctype html><meta charset="utf-8"><title>pairing e2e</title><body><script type="module" src="/page.js"></script></body>`);
const web = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => {
  const p = new URL(req.url).pathname;
  if (p !== "/" && p !== "/page.js") return new Response("not found", { status: 404 });
  return new Response(Bun.file(join(site, p === "/" ? "index.html" : "page.js")), { headers: { "content-type": p === "/" ? "text/html" : "text/javascript" } });
} });
const origin = `http://127.0.0.1:${web.port}`;

// ---- the real server, driven over stdin/stdout (one JSON line each way)
const DRIVER = `
import importlib.util, json, os, sys, types
try:
    from sagebrush import pairing as P
except Exception:  # (no built engine here: the two modules by path, as engine/py/test_pairing.py loads them)
    src = os.environ["SB_PAIRING_SRC"]
    pkg = types.ModuleType("sagebrush"); pkg.__path__ = [src]; sys.modules["sagebrush"] = pkg
    for name in ("workspace_tools", "pairing"):
        spec = importlib.util.spec_from_file_location("sagebrush." + name, os.path.join(src, name + ".py"))
        mod = importlib.util.module_from_spec(spec); sys.modules["sagebrush." + name] = mod; spec.loader.exec_module(mod)
    from sagebrush import pairing as P
from sagebrush.workspace_tools import PageError, NotConnected
import threading, time
# (test only: the server's reader made slow at a grant, so the old page's connection is seen closed late, as on a busy
# machine; "slow" sets the seconds, 0 for none)
SLOW = [0.0]
# (test only: "hold" makes the reader wait at each grant.changed until "release" (30 s at most), instead of for a time:
# the old page's connection is then seen closed only when the test says, however slow the machine; "held" counts waits)
HOLD = [None]
HELD = [0]
_dispatch = P.Pairing._dispatch
GRANTS = []  # (test only: [port, ms] of each non-empty grant.changed a server receives)
def _slow_dispatch(self, msg):
    if isinstance(msg, dict) and msg.get("method") == "grant.changed" and msg.get("params"):
        GRANTS.append([self.port, time.monotonic() * 1000])
    if isinstance(msg, dict) and msg.get("method") == "grant.changed":
        gate = HOLD[0]
        if gate is not None:
            HELD[0] += 1
            gate.wait(30)
            HELD[0] -= 1
        elif SLOW[0]:
            time.sleep(SLOW[0])
    return _dispatch(self, msg)
P.Pairing._dispatch = _slow_dispatch
# (test only: when each hello reached the server, in ms, for the retry window's bound; "hellos" returns and clears them)
HELLOS = []
_hello = P.Pairing._hello
# (test only: a hello answered late, HELLO_SLOW s; or refused with REFUSE's words, as another server's refusal would be)
HELLO_SLOW = [0.0]
REFUSE = [None]
# (test only: the hello numbered HELLO_GATE[1] (counted in HELLOS) waits at the server until "hellogo": a retry the page
# asked in time, answered only when the test says; "hellogate" arms it, "hellowaiting" says whether one waits)
HELLO_GATE = [None, 0]
HELLO_WAITING = [False]
def _timed_hello(self, c, msg):
    HELLOS.append([self.port, time.monotonic() * 1000])
    g = HELLO_GATE[0]
    if g is not None and len(HELLOS) == HELLO_GATE[1]:
        HELLO_WAITING[0] = True
        g.wait(30)
        HELLO_WAITING[0] = False
    if REFUSE[0]:
        rid = msg.get("id") if isinstance(msg, dict) else None
        self._reply_error(c, rid, "refused", REFUSE[0]); self._close(c, 1008, REFUSE[0])
        return False
    if HELLO_SLOW[0]:
        time.sleep(HELLO_SLOW[0])
    return _hello(self, c, msg)
P.Pairing._hello = _timed_hello
p = P.Pairing({"name": "Test agent", "client": "test", "version": "0"})
port, code = p.start()
print(json.dumps({"port": port, "code": code}), flush=True)
for line in sys.stdin:
    m = json.loads(line)
    try:
        if m["op"] == "req":
            print(json.dumps({"ok": p.request(m["method"], m["params"], timeout=10)}), flush=True)
        elif m["op"] == "code":
            port, code = p.start(); print(json.dumps({"port": port, "code": code}), flush=True)
        elif m["op"] == "code2":
            if "p2" not in globals():
                p2 = P.Pairing({"name": "Second agent", "client": "test2", "version": "0"})
            port2, code2 = p2.start(); print(json.dumps({"port": port2, "code": code2}), flush=True)
        elif m["op"] == "status2":
            s = p2.status(); print(json.dumps({"ok": {"paired": s.get("paired"), "granted": s.get("granted")}}), flush=True)
        elif m["op"] == "now":
            print(json.dumps({"ok": time.monotonic() * 1000}), flush=True)
        elif m["op"] == "hellon":
            print(json.dumps({"ok": len(HELLOS)}), flush=True)
        elif m["op"] == "grants":
            print(json.dumps({"ok": GRANTS[:]}), flush=True); GRANTS.clear()
        elif m["op"] == "hellogate":
            HELLO_GATE[0] = threading.Event(); HELLO_GATE[1] = int(m["n"]); print(json.dumps({"ok": True}), flush=True)
        elif m["op"] == "hellogo":
            g = HELLO_GATE[0]; HELLO_GATE[0] = None
            if g is not None: g.set()
            print(json.dumps({"ok": True}), flush=True)
        elif m["op"] == "hellowaiting":
            print(json.dumps({"ok": HELLO_WAITING[0]}), flush=True)
        elif m["op"] == "helloslow":
            HELLO_SLOW[0] = float(m["s"]); print(json.dumps({"ok": HELLO_SLOW[0]}), flush=True)
        elif m["op"] == "refuse":
            REFUSE[0] = m.get("text"); print(json.dumps({"ok": REFUSE[0]}), flush=True)
        elif m["op"] == "hellos":
            print(json.dumps({"ok": HELLOS[:]}), flush=True); HELLOS.clear()
        elif m["op"] == "hold":
            HOLD[0] = threading.Event(); print(json.dumps({"ok": True}), flush=True)
        elif m["op"] == "release":
            g = HOLD[0]; HOLD[0] = None
            if g is not None: g.set()
            print(json.dumps({"ok": True}), flush=True)
        elif m["op"] == "held":
            print(json.dumps({"ok": HELD[0]}), flush=True)
        elif m["op"] == "slow":
            SLOW[0] = float(m["s"]); print(json.dumps({"ok": SLOW[0]}), flush=True)
        elif m["op"] == "status":
            s = p.status(); print(json.dumps({"ok": {"paired": s.get("paired"), "granted": s.get("granted")}}), flush=True)
    except NotConnected as e:
        print(json.dumps({"notconnected": str(e)}), flush=True)
    except PageError as e:
        print(json.dumps({"err": {"code": e.code, "message": str(e)}}), flush=True)
    except Exception as e:
        print(json.dumps({"err": {"code": type(e).__name__, "message": str(e)}}), flush=True)
`;
const py = spawn("python3", ["-s", "-c", DRIVER], { env: { ...process.env, PYTHONPATH: join(here, "../../engine/py/python"), SB_PAIRING_SRC: join(here, "../../engine/py/python/sagebrush"), SAGEBRUSH_MCP_DEV_ORIGIN: origin }, stdio: ["pipe", "pipe", "inherit"] });
const lines = createInterface({ input: py.stdout });
const waiters = [];
lines.on("line", (l) => waiters.shift()?.(JSON.parse(l)));
const next = () => new Promise((r) => waiters.push(r));
const drive = (m) => { const r = next(); py.stdin.write(JSON.stringify(m) + "\n"); return r; };
py.on("exit", (c) => { for (const w of waiters.splice(0)) w({ exited: c }); });
const first = await Promise.race([next(), sleep(15000).then(() => ({ exited: "no code in 15 s" }))]);
if (!first.port) { console.log("FAIL the pairing server didn't start: " + JSON.stringify(first)); try { py.kill(); } catch {} web.stop(true); process.exit(1); }
const PORT = first.port;
let CODE = first.code;

// ---- Chromium
let cdp = Number(process.env.CDP_PORT) || 0;
const profile = mkdtempSync(join(tmpdir(), "sb-agent-e2e-chrome-"));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", `--remote-debugging-port=${cdp}`, `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
try {
  if (!cdp) cdp = await devtoolsPort(profile);
  let targets;
  for (let i = 0; i < 300; i++) { try { targets = await (await fetch(`http://127.0.0.1:${cdp}/json`)).json(); break; } catch { await sleep(100); } }
  const sock = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
  await new Promise((r) => (sock.onopen = r));
  let n = 0;
  const waiting = new Map();
  sock.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } };
  const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); sock.send(JSON.stringify({ id, method, params })); });
  const ev = async (expr) => { const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400)); return r.result?.result?.value; };
  const until = async (expr, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr).catch(() => false)) return true; await sleep(100); } return false; };
  const open = async (q) => { await send("Page.navigate", { url: origin + "/" + q }); await sleep(300); return until("window.ready === true"); };
  const click = (sel) => ev(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(sel)})].pop(); if (!b) throw new Error("no ${sel}"); b.click(); return true; })()`);

  // (the page shows its bar once it has SENT the grant (agent-pair.ts allow(): grant.changed, then "granted"); the
  // server applies it when its reader gets that message. An agent's request in between is refused as not granted, which is
  // right, so an agent's request is made once the server says the grant is in force)
  const grantedAtServer = async (ms = 10000) => { const t = Date.now(); while (Date.now() - t < ms) { if ((await drive({ op: "status" })).ok?.granted === true) return true; await sleep(50); } return false; };
  // (the server's reader held at a grant until released: "held" waits until n grant messages wait there)
  const heldAt = async (n, ms = 10000) => { const t = Date.now(); while (Date.now() - t < ms) { if ((await drive({ op: "held" })).ok === n) return true; await sleep(25); } return false; };
  // (the first hello after `n` reaches the server)
  const helloAfter = async (n, ms = 10000) => { const t = Date.now(); while (Date.now() - t < ms) { if ((await drive({ op: "hellon" })).ok > n) return true; await sleep(5); } return false; };
  ok(await open(""), "the page opens its workspace");
  // (the person's workspace: an old /A removed and a new /A made; a file in /A removed and a new one made at its name)
  const trashed = await ev(`(async () => {
    await T.ws.mkdir("/A"); const oldA = await T.ws.remove("/A"); await T.ws.mkdir("/A");
    await T.ws.mkdir("/B"); await T.ws.create("/B/secret.txt", { content: "secret" });
    await T.ws.create("/A/c.txt", { content: "one" }); const oldC = await T.ws.remove("/A/c.txt"); await T.ws.create("/A/c.txt", { content: "two" });
    return { oldA: oldA.path, oldC: oldC.path };
  })()`);

  // a wrong code: refused, said in the dialog, nothing paired
  ok(await open(`?pair=${"A".repeat(26)}&port=${PORT}`), "a ?pair= link opens the dialog");
  await click(".sbag-box button.primary");
  ok(await until(`/refused/.test(document.querySelector(".sbag-box .err")?.textContent ?? "")`), "a wrong code: the refusal is shown");
  ok((await drive({ op: "status" })).ok.paired === false, "a wrong code: the server isn't paired");

  // nothing listening on the port: the connection fails, and the dialog says what Chrome asks (its one-time permission
  // for reaching programs on this computer) and how to undo a block
  const closed = await new Promise((r) => { const sv = net.createServer(); sv.listen(0, "127.0.0.1", () => { const p = sv.address().port; sv.close(() => r(p)); }); });
  ok(await open(`?pair=${CODE}&port=${closed}`), "a link to a port nothing listens on");
  await click(".sbag-box button.primary");
  ok(await until(`/connection failed/.test(document.querySelector(".sbag-box .err")?.textContent ?? "")`), "a failed connection is said in the dialog");
  const failText = await ev(`document.querySelector(".sbag-box .err").textContent`);
  // (one short line on what Chrome asks, and Learn more for the rest, such as undoing a block: William, Nov 8, no wall of text)
  const hint = failText.split("\n\n")[1] ?? "";
  const learn = await ev(`(() => { const a = document.querySelector(".sbag-box .err a"); return a ? { text: a.textContent, href: a.getAttribute("href"), target: a.target, rel: a.rel } : null; })()`);
  ok(/^This browser needs your OK for this site to reach apps on this computer: allow it/.test(hint) && hint.length <= 130 && !/[\u201c\u201d"]/.test(hint) && !/Safari/.test(failText) && /^the connection failed/.test(failText) && learn?.text === "Learn more" && learn.href === "/agents/connect/" && learn.target === "_blank" && learn.rel === "noopener", `in Chrome, one line (true whether it asks or has blocked) says to allow it, then Learn more (${hint.length} characters: ${hint.slice(0, 80)}…; ${JSON.stringify(learn)})`);
  ok(/is the agent's sagebrush-mcp running/.test(failText) && !/undefined|sagebrush-agent/.test(failText), "a page without its own program keeps naming the agent's sagebrush-mcp (and never \"undefined\")");
  ok((await drive({ op: "status" })).ok.paired === false, "the code is still unused after the failed connection");
  // in Safari (its user agent, from the page's first load): the Connect dialog is Safari's one line and Learn more, nothing else
  const chromeUA = await ev("navigator.userAgent");
  await send("Emulation.setUserAgentOverride", { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15" });
  ok(await open(`?pair=${CODE}&port=${closed}`), "Safari: a ?pair= link");
  ok(await until(`!!document.querySelector(".sbag-box")`), "Safari: the Connect dialog opens");
  const saf = await ev(`(() => { const b = document.querySelector(".sbag-box"), a = b.querySelector("a"); return { text: b.querySelector("h2 + div")?.textContent, inputs: b.querySelectorAll("input").length, a: a && { text: a.textContent, href: a.getAttribute("href"), target: a.target, rel: a.rel } }; })()`);
  ok(saf.text === "Safari can't reach a program on this computer: use Chrome or Firefox. Learn more" && saf.inputs === 0 && saf.a?.text === "Learn more" && saf.a.href === "/agents/connect/" && saf.a.target === "_blank" && saf.a.rel === "noopener", `Safari: its one line, then Learn more, and no code to enter (${JSON.stringify(saf)})`);
  await send("Emulation.setUserAgentOverride", { userAgent: chromeUA });

  // the right code, through the dialog, then the grant: /A, read and write, until the page closes
  ok(await open(`?pair=${CODE}&port=${PORT}`), "the right code's link");
  await click(".sbag-box button.primary");
  ok(await until(`[...document.querySelectorAll(".sbag-box h2")].some((h) => h.textContent === "Allow this agent?")`), "paired: the grant dialog asks the person");
  // (the default, D (chat plan PR 3): Everything ticked when the dialog opens, the folders disabled until it is unticked)
  const dflt = await ev(`(() => { const ins = [...document.querySelectorAll(".sbag-box .folders input")]; return { all: ins[0].checked, others: ins.slice(1).map((i) => i.disabled), focus: document.activeElement === ins[0] }; })()`);
  ok(dflt.all === true && dflt.others.length >= 2 && dflt.others.every(Boolean), `the grant dialog opens with Everything ticked, the folders disabled (${JSON.stringify(dflt)})`);
  const before = await drive({ op: "req", method: "workspace.list", params: { folder: "/A" } });
  ok(before.err || before.notconnected, `before the grant, the agent gets nothing (${JSON.stringify(before).slice(0, 120)})`);
  await ev(`(() => { { const all = document.querySelector(".sbag-box .folders input"); if (all.checked) all.click(); } document.querySelector('.sbag-box input[value="/A"]').click(); document.querySelector(".sbag-box select").value = "page"; document.querySelector(".sbag-box select").dispatchEvent(new Event("change")); return true; })()`);
  await click(".sbag-box button.primary");
  ok(await until(`!!document.querySelector(".sbag-bar")`), "allowed: the bar shows the agent and its grant");
  ok(await grantedAtServer(), "the agent's server has the grant");
  const made = await drive({ op: "req", method: "workspace.create", params: { path: "/A/n.txt", content: { text: "hi" } } });
  ok(made.ok?.entry?.path === "/A/n.txt", `an agent's create inside /A (${JSON.stringify(made).slice(0, 120)})`);
  ok((await ev(`T.ws.read("/A/n.txt").then((r) => typeof r.content === "string" ? r.content : new TextDecoder().decode(r.content))`)) === "hi", "the file is in the person's workspace");
  ok(await ev(`T.ws.ops().then((o) => o.filter((x) => x.path === "/A/n.txt").every((x) => x.by === "agent:Test-agent") && o.some((x) => x.path === "/A/n.txt"))`), "credited to agent:Test-agent in the workspace's log");
  const out1 = await drive({ op: "req", method: "workspace.write", params: { path: "/B/secret.txt", content: { text: "pwned" }, base: 1 } });
  ok(out1.err?.code === "invalid", `a write outside the grant is refused (${JSON.stringify(out1).slice(0, 140)})`);
  // (git_branch through sagebrush-mcp: a grant of /A alone doesn't include /Branches (Q2), so nothing is made)
  const gb = await drive({ op: "req", method: "workspace.git_branch", params: { name: "fix" } });
  ok(gb.err?.message === "branches go in /Branches, which your grant doesn't include: ask the person to allow it, or work in the folders you have" && (await ev(`T.ws.stat("/Branches").then((e) => !e)`)), `git_branch with /A granted: refused as cleared, nothing made (${JSON.stringify(gb).slice(0, 160)})`);
  const out2 = await drive({ op: "req", method: "workspace.read", params: { path: "/B/secret.txt" } });
  ok(out2.err?.code === "invalid", "a read outside the grant is refused");
  const out3 = await drive({ op: "req", method: "workspace.read", params: { path: "/A/../B/secret.txt" } });
  ok(!!out3.err, `a read through .. is refused (${out3.err?.code})`);
  const out4 = await drive({ op: "req", method: "workspace.rename", params: { from: "/A/n.txt", to: "/B/n.txt" } });
  ok(out4.err?.code === "invalid", "a rename out of the grant is refused");
  const out5 = await drive({ op: "req", method: "workspace.list", params: { folder: "/" } });
  ok(out5.err?.code === "invalid", "listing the top folder (outside the grant) is refused");
  ok((await ev(`T.ws.read("/B/secret.txt").then((r) => typeof r.content === "string" ? r.content : new TextDecoder().decode(r.content))`)) === "secret", "the file outside is untouched");
  const bad1 = await drive({ op: "req", method: "workspace.drop", params: { path: "/A/n.txt" } });
  ok(!!bad1.err, `an unknown verb is refused (${bad1.err?.code}: ${String(bad1.err?.message).slice(0, 80)})`);
  const bad2 = await drive({ op: "req", method: "workspace.read", params: { path: "/A/n.txt", follow: true } });
  ok(bad2.err?.code === "invalid" || bad2.err?.code === "ValueError", `params that break the schema are refused (${bad2.err?.code})`);
  // restore: the actual destination stays in the grant (Workspace.restore renames on a collision, in the same folder)
  const rc = await drive({ op: "req", method: "workspace.restore", params: { path: trashed.oldC } });
  ok(rc.ok?.entry?.path?.startsWith("/A/") && rc.ok.entry.path !== "/A/c.txt", `a restore onto a taken name lands renamed, inside /A (${rc.ok?.entry?.path ?? JSON.stringify(rc)})`);
  const ra = await drive({ op: "req", method: "workspace.restore", params: { path: trashed.oldA } });
  ok(ra.err?.code === "invalid", `restoring an old /A (it would come back as "/A (2)", outside the grant) is refused (${ra.err?.message?.slice(0, 90)})`);
  ok(await ev(`T.ws.list("/").then((l) => !l.some((e) => /^\\/A \\(/.test(e.path)))`), "and nothing outside the grant was made");
  // the same code again, from another page, while paired: refused
  const again = await ev(`T.tryPair(${JSON.stringify(CODE)}, ${PORT})`);
  ok(/^refused/.test(again), `the used code, again: ${again}`);

  // malformed frames from a server, in this real browser: the page closes the socket (a browser may send only
  // 1000 or 3000-4999: the protocol's code as 4000 + code), whatever the reason's length
  for (const [what, send, want] of [
    ["a repeated key (its reason long and not ASCII)", (ws) => ws.send(`{"jsonrpc":"2.0","id":"p1","${"é".repeat(200)}":1,"${"é".repeat(200)}":2}`), 4007],
    ["over 8 KiB before the hello has paired", (ws) => ws.send("x".repeat(9000)), 4009],
    ["a binary frame", (ws) => ws.send(new Uint8Array([1, 2, 3])), 4003],
  ]) {
    let closed = null;
    const fake = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (r, srv) => (srv.upgrade(r) ? undefined : new Response("", { status: 400 })),
      websocket: { message(ws, d) { if (String(d).includes('"hello"')) send(ws); }, close(ws, code) { closed = code; } } });
    const said = await ev(`T.tryPair("ABC", ${fake.port})`);
    for (let i = 0; i < 50 && closed === null; i++) await sleep(100);
    ok(closed === want, `${what}: Chromium closes the socket, ${closed} (${String(said).slice(0, 60)})`);
    fake.stop(true);
  }

  // Revoke: the agent cut off at once, the grant forgotten
  await click(".sbag-bar button");
  ok(await until(`!document.querySelector(".sbag-bar")`), "Revoke: the bar goes");
  const after = await drive({ op: "req", method: "workspace.list", params: { folder: "/A" } });
  ok(!!after.notconnected || !!after.err, `after Revoke the agent gets nothing (${JSON.stringify(after).slice(0, 120)})`);
  ok((await drive({ op: "status" })).ok.granted === false, "after Revoke the server holds no grant");
  ok(await ev(`T.ws.agentGrants().then((g) => Object.keys(g).length === 0)`), "after Revoke no grant is kept in the workspace");
  const reused = await ev(`T.tryPair(${JSON.stringify(CODE)}, ${PORT})`);
  ok(/^refused/.test(reused), `the used code, after Revoke: ${reused}`);

  // a remembered agent, reconnected by two reloads (T1, git-proto at b72938d8a): the real server answers a session's
  // hello without a session, so the grant kept on the first reconnect must keep the session in force, or the second
  // reload can't reconnect
  const fresh = await drive({ op: "code" });
  // (from here the server's reader is slow at each grant: a reload then finds the old page's connection still
  // registered for a moment, and its silent reconnect is answered "another page is paired" until it isn't)
  await drive({ op: "slow", s: 0.6 });
  ok(await open(`?pair=${fresh.code}&port=${fresh.port}`), "a new code's link, to remember the agent");
  await click(".sbag-box button.primary");
  ok(await until(`[...document.querySelectorAll(".sbag-box h2")].some((h) => h.textContent === "Allow this agent?")`), "paired again: the grant dialog");
  await ev(`(() => { { const all = document.querySelector(".sbag-box .folders input"); if (all.checked) all.click(); } document.querySelector('.sbag-box input[value="/A"]').click(); const s = document.querySelector(".sbag-box select"); s.value = "3600000"; s.dispatchEvent(new Event("change")); const r = [...document.querySelectorAll(".sbag-box label")].find((l) => /Remember this agent/.test(l.textContent)).querySelector("input"); if (!r.checked) r.click(); return true; })()`);
  await click(".sbag-box button.primary");
  ok(await until(`!!document.querySelector(".sbag-bar")`), "allowed for an hour, remembered");
  const kept0 = await ev(`T.ws.agentGrants().then((g) => Object.values(g).map((k) => k.session))`);
  ok(kept0.length === 1 && typeof kept0[0] === "string" && kept0[0].length > 0, `the remembered grant keeps the agent's session (${kept0.length} kept)`);
  for (const n of [1, 2]) {
    ok(await open(""), `reload ${n}`);
    ok(await until(`!!document.querySelector(".sbag-bar")`, 15000), `reload ${n}: the remembered agent reconnects by itself, the bar shows it`);
    ok(await grantedAtServer(), `reload ${n}: the agent's server has the grant again`);
    const l = await drive({ op: "req", method: "workspace.list", params: { folder: "/A" } });
    ok(!!l.ok, `reload ${n}: the agent reaches /A again (${JSON.stringify(l).slice(0, 80)})`);
    const kept = await ev(`T.ws.agentGrants().then((g) => Object.values(g).map((k) => k.session))`);
    ok(kept.length === 1 && kept[0] === kept0[0], `reload ${n}: the kept session is still the one in force (${kept[0] === undefined ? "lost" : kept[0] === kept0[0] ? "same" : "changed"})`);
  }
  // (the window is bounded: with the old connection held longer than it, the reconnect gives up, and no attempt
  // begins 2 s or more after the first)
  await drive({ op: "slow", s: 3 });
  ok(await open(""), "reload 3");
  ok(await until(`!!document.querySelector(".sbag-bar")`, 15000), "reload 3: reconnected (its grant now holds the server's reader for 3 s)");
  await drive({ op: "hellos" });
  ok(await open(""), "reload 4, at once");
  await sleep(3500);
  const hellos = ((await drive({ op: "hellos" })).ok ?? []).map((h) => h[1]);
  const span = hellos.length ? hellos.at(-1) - hellos[0] : -1;
  ok(hellos.length >= 2 && span < 2000 && !(await ev(`!!document.querySelector(".sbag-bar")`)),
    `reload 4: while the old connection is held, the reconnect asks again within 2 s only, then gives up (${hellos.length} hellos over ${Math.round(span)} ms)`);

  // (connect() shows the bar instead while an attempt is still connecting: asked again until its dialog is open)
  const openConnect = async (code, port) => {
    for (let i = 0; i < 40; i++) {
      await ev(`(T.ui.connect(${JSON.stringify(code)}, ${JSON.stringify(String(port))}), 1)`);
      if (await ev(`[...document.querySelectorAll(".sbag-box h2")].some((h) => h.textContent === "Connect an agent")`)) return true;
      await sleep(25);
    }
    return false;
  };
  // ---- a retry superseded by the person's own Connect stops there (RECONNECT-OWNER-1): reconnect()'s path, a
  // remembered grant
  await sleep(1500); // (reload 4's hold over)
  ok(await open(""), "reload 5");
  ok(await until(`!!document.querySelector(".sbag-bar")`, 15000), "reload 5: reconnected (its grant holds the server's reader again)");
  const second = await drive({ op: "code2" });
  ok(await open(""), "reload 6, at once: its silent reconnect is refused, and asks again");
  await sleep(600);
  const before6 = (await drive({ op: "now" })).ok;
  ok(await openConnect(second.code, second.port), "the Connect dialog opens");
  await click(".sbag-box button.primary");
  ok(await until(`[...document.querySelectorAll(".sbag-box h2")].some((h) => h.textContent === "Allow this agent?")`), "reload 6: the person connects another agent meanwhile, and is asked to allow it");
  await sleep(2600);
  const h6 = (await drive({ op: "hellos" })).ok ?? [];
  const late6 = h6.filter(([port, t]) => port === PORT && t > before6 + 50), early6 = h6.filter(([port, t]) => port === PORT && t <= before6);
  const s2 = (await drive({ op: "status2" })).ok, s1 = (await drive({ op: "status" })).ok;
  const kept6 = await ev(`T.ws.agentGrants().then((g) => Object.values(g).map((k) => k.session))`);
  ok(early6.length >= 2 && late6.length === 0 && s2.paired === true && s1.paired === false && !(await ev(`!!document.querySelector(".sbag-bar")`)) && kept6.length === 1 && kept6[0] === kept0[0],
    `reload 6: the superseded retry asks no more, the person's agent stays paired, and the remembered grant is untouched (${early6.length} hellos before, ${late6.length} after; second ${JSON.stringify(s2)}, first ${JSON.stringify(s1)})`);

  // ---- superseded while its grant is being given: a Connect dialog opened during the wait, submitted while the retry's
  // allow() is held in its store; the retry's socket goes, so the old server is left neither paired nor granted
  await drive({ op: "slow", s: 0.6 });
  ok(await open(""), "reload 8a");
  ok(await until(`!!document.querySelector(".sbag-bar")`, 15000), "reload 8a: reconnected (its grant holds the server's reader for 0.6 s)");
  const fourth = await drive({ op: "code2" });
  ok(await open(""), "reload 8, at once: refused, asking again");
  ok(await openConnect(fourth.code, fourth.port), "reload 8: the person opens the Connect dialog during the wait");
  await ev("(window.__grantDelay = 2000, 1)");
  // (allow() sets the pairing's grant, sends it, then waits in the store before "granted": that is the moment)
  ok(await until(`!!T.ui.pairing?.grant && T.ui.pairing.state === "paired"`, 5000), "reload 8: the retry pairs, and its allow() waits in the grant's store");
  await click(".sbag-box button.primary");
  ok(await until(`[...document.querySelectorAll(".sbag-box h2")].some((h) => h.textContent === "Allow this agent?")`), "reload 8: the person's Connect is submitted then");
  await sleep(2600);
  await ev("(window.__grantDelay = 0, 1)");
  const u1 = (await drive({ op: "status" })).ok, u2 = (await drive({ op: "status2" })).ok;
  ok(u1.paired === false && u1.granted === false && u2.paired === true && !(await ev(`!!document.querySelector(".sbag-bar")`)),
    `reload 8: superseded while giving its grant, the retry's connection goes: the old server neither paired nor granted, the person's agent paired (first ${JSON.stringify(u1)}, second ${JSON.stringify(u2)})`);

  // ---- superseded BEFORE its pairing completes (A7): a Connect submitted while the retry's hello is still unanswered; the
  // old server is never sent a grant, not even for a moment
  await drive({ op: "slow", s: 0.6 });
  ok(await open(""), "reload 9a");
  ok(await until(`!!document.querySelector(".sbag-bar")`, 15000), "reload 9a: reconnected (its grant holds the server's reader for 0.6 s)");
  const fifth = await drive({ op: "code2" });
  ok(await open(""), "reload 9, at once: refused, asking again");
  ok(await openConnect(fifth.code, fifth.port), "reload 9: the person opens the Connect dialog during the wait");
  await drive({ op: "helloslow", s: 1.0 }); // (from now, a hello is answered 1 s late: the next retry sits in it)
  await drive({ op: "grants" });
  ok(await until(`T.ui.pairing?.state === "connecting"`, 5000), "reload 9: a retry's hello waits for its answer");
  await click(".sbag-box button.primary");
  await sleep(2500);
  await drive({ op: "helloslow", s: 0 });
  const g9 = ((await drive({ op: "grants" })).ok ?? []).filter(([port]) => port === PORT);
  const v1 = (await drive({ op: "status" })).ok;
  ok(g9.length === 0 && v1.paired === false && v1.granted === false,
    `reload 9: superseded before its pairing completed, the retry never gives the old server its grant (${g9.length} grants; first ${JSON.stringify(v1)})`);

  // ---- a refusal other than the agent's "another page is paired with this agent" is final: one hello, no retry (A11,
  // the remote computer's words; A12, any other)
  for (const [n, text] of [["10", "another page is paired with this computer"], ["11", "wrong session"]]) {
    await drive({ op: "slow", s: 0 });
    await sleep(700);
    await drive({ op: "refuse", text });
    await drive({ op: "hellos" });
    ok(await open(""), `reload ${n}`);
    await sleep(2500);
    const hs = ((await drive({ op: "hellos" })).ok ?? []).filter(([port]) => port === PORT);
    await drive({ op: "refuse", text: null });
    ok(hs.length === 1 && !(await ev(`!!document.querySelector(".sbag-bar")`)), `reload ${n}: refused "${text}", the reconnect asks once and stops (${hs.length} hellos)`);
  }

  // ---- an expiry inside the retry window ends it (A9, reconnect()'s remembered grant), on a fake clock
  // (the server's reader is held at the reconnect's grant until released, so the reload's first hello is refused; the
  //  grant's expiry is set just after, and the page's clock taken back to then across the reload. Once that first hello
  //  is refused, the fake clock passes the expiry but not the retry window, and the hold is released: a retry that
  //  ignored the expiry would now succeed and give the grant. No step has to finish within any time)
  await drive({ op: "slow", s: 0 });
  await drive({ op: "hold" });
  ok(await open(""), "reload 12a");
  ok(await until(`!!document.querySelector(".sbag-bar")`, 15000), "reload 12a: reconnected (its grant held at the server until released)");
  ok(await heldAt(1), "reload 12a: its grant's message waits at the server");
  const exp12 = await ev(`(async () => { const exp = Date.now() + 600; const all = await T.ws.agentGrants(); for (const [id, k] of Object.entries(all)) await T.ws.putAgentGrant(id, { ...k, grant: { ...k.grant, expires: exp } }); sessionStorage.setItem("__clockAt", String(Date.now())); return exp; })()`);
  await drive({ op: "hellos" });
  const n12 = (await drive({ op: "hellon" })).ok;
  await drive({ op: "grants" });
  // (the reload's second hello, its retry, asked before the expiry, waits at the server until the expiry has passed and
  //  the old connection is seen closed: then it pairs, and the grant must still not be given (#978's red: a retry asked
  //  in time and answered after the expiry was given the expired grant))
  await drive({ op: "hellogate", n: n12 + 2 });
  ok(await open(""), "reload 12, at once: refused, asking again");
  ok(await helloAfter(n12), "reload 12: its first hello reached the server");
  ok(await (async () => { const t = Date.now(); while (Date.now() - t < 10000) { if ((await drive({ op: "hellowaiting" })).ok) return true; await sleep(25); } return false; })(), "reload 12: its retry's hello waits at the server");
  await ev(`(window.__skew = ${exp12} + 100 - (Date.now() - (window.__skew ?? 0)), 1)`); // (past the expiry, inside the window)
  await drive({ op: "release" });
  ok(await heldAt(0), "reload 12: the hold released");
  ok(await (async () => { const t = Date.now(); while (Date.now() - t < 10000) { if ((await drive({ op: "status" })).ok?.paired === false) return true; await sleep(25); } return false; })(), "reload 12: the old connection seen closed");
  await drive({ op: "hellogo" });
  await sleep(2000);
  const h12 = ((await drive({ op: "hellos" })).ok ?? []).filter(([port]) => port === PORT);
  const g12 = ((await drive({ op: "grants" })).ok ?? []).filter(([port]) => port === PORT);
  const bar12 = await ev(`!!document.querySelector(".sbag-bar")`);
  ok(h12.length === 2 && g12.length === 0 && !bar12, `reload 12: the remembered grant expired while its retry paired: not given, no further attempt (${h12.length} hellos, ${g12.length} grants, bar ${bar12})`);
  // (revoked, not just dropped: the expired grant is forgotten at once, not left for the next load's sweep (grader's A3))
  const left12 = await ev(`T.ws.agentGrants().then((a) => Object.keys(a).length)`);
  ok(left12 === 0, `reload 12: the expired grant is forgotten at once (${left12} kept)`);
  await drive({ op: "slow", s: 0 });

  // ---- the same for restoreWith()'s path: a reload record (a grant until the page closes, ?r=1)
  await drive({ op: "slow", s: 0 });
  ok(await open("?r=1"), "a page that keeps a reload record");
  // (if the remembered agent reconnects there first, it is revoked from its bar, so this page's grant is the reload
  //  record's alone; after reload 12 its grant has expired, and nothing reconnects)
  await sleep(1500);
  if (await ev(`!!document.querySelector(".sbag-bar")`)) { await click(".sbag-bar button"); ok(await until(`!document.querySelector(".sbag-bar")`), "(the remembered agent revoked)"); }
  const third = await drive({ op: "code2" });
  ok(await openConnect(third.code, third.port), "the Connect dialog opens");
  await click(".sbag-box button.primary");
  ok(await until(`[...document.querySelectorAll(".sbag-box h2")].some((h) => h.textContent === "Allow this agent?")`), "the second agent connected");
  // (the second server's reader held at this grant until released: the reload's restore is refused until then)
  await drive({ op: "hold" });
  await ev(`(() => { { const all = document.querySelector(".sbag-box .folders input"); if (all.checked) all.click(); } document.querySelector('.sbag-box input[value="/A"]').click(); const s = document.querySelector(".sbag-box select"); s.value = "page"; s.dispatchEvent(new Event("change")); return true; })()`);
  await click(".sbag-box button.primary");
  ok(await until(`!!document.querySelector(".sbag-bar")`), "allowed until the page closes (its grant held at the second server until released)");
  ok(await heldAt(1), "(its grant's message waits at the second server)");
  const first7 = await drive({ op: "code" });
  await drive({ op: "hellos" });
  await send("Page.reload", {});
  await sleep(300);
  ok(await until("window.ready === true"), "reload 7, at once: the reload record's silent restore is refused, and asks again");
  await sleep(600);
  const before7 = (await drive({ op: "now" })).ok;
  ok(await openConnect(first7.code, first7.port), "the Connect dialog opens");
  await click(".sbag-box button.primary");
  ok(await until(`[...document.querySelectorAll(".sbag-box h2")].some((h) => h.textContent === "Allow this agent?")`), "reload 7: the person connects the first agent meanwhile");
  // (released now: a superseded restore that still asked would now be answered, and pair)
  await drive({ op: "release" });
  ok(await heldAt(0), "reload 7: the hold released");
  await sleep(2600);
  const h7 = (await drive({ op: "hellos" })).ok ?? [];
  const late7 = h7.filter(([port, t]) => port === third.port && t > before7 + 50), early7 = h7.filter(([port, t]) => port === third.port && t <= before7);
  const t1 = (await drive({ op: "status" })).ok, t2 = (await drive({ op: "status2" })).ok;
  ok(early7.length >= 2 && late7.length === 0 && t1.paired === true && t2.paired === false && !(await ev(`!!document.querySelector(".sbag-bar")`)),
    `reload 7: the superseded restore asks no more, and the person's agent stays paired (${early7.length} hellos to the second before, ${late7.length} after; first ${JSON.stringify(t1)}, second ${JSON.stringify(t2)})`);
  // ---- an expiry inside the retry window ends restoreWith() too (A10): a reload record, its grant expiring on a fake clock
  await drive({ op: "slow", s: 0 });
  await ev("(window.__skew = 0, 1)");
  ok(await open("?r=1"), "a page that keeps a reload record, again");
  await sleep(500);
  if (await ev(`!!document.querySelector(".sbag-bar")`)) { await click(".sbag-bar button"); await until(`!document.querySelector(".sbag-bar")`); }
  const sixth = await drive({ op: "code2" });
  ok(await openConnect(sixth.code, sixth.port), "the Connect dialog opens");
  await click(".sbag-box button.primary");
  ok(await until(`[...document.querySelectorAll(".sbag-box h2")].some((h) => h.textContent === "Allow this agent?")`), "the second agent connected again");
  await drive({ op: "hold" });
  await ev(`(() => { { const all = document.querySelector(".sbag-box .folders input"); if (all.checked) all.click(); } document.querySelector('.sbag-box input[value="/A"]').click(); const s = document.querySelector(".sbag-box select"); s.value = "page"; s.dispatchEvent(new Event("change")); return true; })()`);
  await click(".sbag-box button.primary");
  ok(await until(`!!document.querySelector(".sbag-bar")`), "allowed until the page closes");
  ok(await heldAt(1), "(its grant's message waits at the second server until released)");
  // (at the old page's pagehide, after the page marks when it left: the record set to expire 0.6 s later, and the clock
  //  noted, so the new page's clock starts there: the reload's own time can't age the record or pass its expiry)
  ok(await ev(`(addEventListener("pagehide", () => { const r = JSON.parse(sessionStorage.getItem("sb-agent-reload-v1")); r.grant.expires = Date.now() + 600; sessionStorage.setItem("sb-agent-reload-v1", JSON.stringify(r)); sessionStorage.setItem("__exp13", String(r.grant.expires)); sessionStorage.setItem("__clockAt", String(Date.now())); }), true)`), "(its reload record set to expire 0.6 s after the page leaves, on the page's clock)");
  await drive({ op: "hellos" });
  const n13 = (await drive({ op: "hellon" })).ok;
  await drive({ op: "grants" });
  await send("Page.reload", {});
  ok(await helloAfter(n13), "reload 13: its first hello reached the server");
  await ev(`(window.__skew = Number(sessionStorage.getItem("__exp13")) + 100 - (Date.now() - (window.__skew ?? 0)), 1)`); // (past the expiry, inside the window)
  await drive({ op: "release" });
  ok(await heldAt(0), "reload 13: the hold released");
  await sleep(2000);
  const h13 = ((await drive({ op: "hellos" })).ok ?? []).filter(([port]) => port === sixth.port);
  const g13 = ((await drive({ op: "grants" })).ok ?? []).filter(([port]) => port === sixth.port);
  ok(h13.length >= 1 && h13.length <= 2 && g13.length === 0, `reload 13: the reload record's grant expired during the window: no further attempt, and it isn't given again (${h13.length} hellos, ${g13.length} grants)`);
  await drive({ op: "slow", s: 0 });
} finally {
  try { py.kill(); } catch {}
  try { chrome.kill(); } catch {}
  web.stop(true);
  await sleep(300);
  rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
  rmSync(site, { recursive: true, force: true });
}
console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
