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
const ws = await Workspace.open();
const ui = mountAgentPairing(ws as any);
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
  ok(/access apps on this device/.test(failText) && /Click Allow/.test(failText) && /Site settings/.test(failText) && !/Safari/.test(failText) && /^the connection failed/.test(failText), `in Chrome, it says to Allow its prompt and how to undo a block (${failText.slice(0, 60)}…)`);
  ok((await drive({ op: "status" })).ok.paired === false, "the code is still unused after the failed connection");

  // the right code, through the dialog, then the grant: /A, read and write, until the page closes
  ok(await open(`?pair=${CODE}&port=${PORT}`), "the right code's link");
  await click(".sbag-box button.primary");
  ok(await until(`[...document.querySelectorAll(".sbag-box h2")].some((h) => h.textContent === "Allow this agent?")`), "paired: the grant dialog asks the person");
  const before = await drive({ op: "req", method: "workspace.list", params: { folder: "/A" } });
  ok(before.err || before.notconnected, `before the grant, the agent gets nothing (${JSON.stringify(before).slice(0, 120)})`);
  await ev(`(() => { document.querySelector('.sbag-box input[value="/A"]').click(); document.querySelector(".sbag-box select").value = "page"; document.querySelector(".sbag-box select").dispatchEvent(new Event("change")); return true; })()`);
  await click(".sbag-box button.primary");
  ok(await until(`!!document.querySelector(".sbag-bar")`), "allowed: the bar shows the agent and its grant");
  const made = await drive({ op: "req", method: "workspace.create", params: { path: "/A/n.txt", content: { text: "hi" } } });
  ok(made.ok?.entry?.path === "/A/n.txt", `an agent's create inside /A (${JSON.stringify(made).slice(0, 120)})`);
  ok((await ev(`T.ws.read("/A/n.txt").then((r) => typeof r.content === "string" ? r.content : new TextDecoder().decode(r.content))`)) === "hi", "the file is in the person's workspace");
  ok(await ev(`T.ws.ops().then((o) => o.filter((x) => x.path === "/A/n.txt").every((x) => x.by === "agent:Test-agent") && o.some((x) => x.path === "/A/n.txt"))`), "credited to agent:Test-agent in the workspace's log");
  const out1 = await drive({ op: "req", method: "workspace.write", params: { path: "/B/secret.txt", content: { text: "pwned" }, base: 1 } });
  ok(out1.err?.code === "invalid", `a write outside the grant is refused (${JSON.stringify(out1).slice(0, 140)})`);
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
