// ci: web-runner order=181 chrome
// An agent paired with the notebook page, end to end: the page (web/dist, served by web/serve.py with the site's
// headers, its CSP included) and the REAL pairing server (engine/py/python/sagebrush/pairing.py, as sagebrush-mcp
// runs it), its requests made as an agent's tools make them:
//   - the page offers Agent once its workspace is open; the agent chunk (/sagebrush-agent.js) isn't fetched before;
//   - Agent opens Connect; a ?pair= link connects, the person allows a folder, the bar shows the agent;
//   - the agent reads the notebook shown and writes it (workspace.write with its base): the page shows the new cell
//     at once, with no reload and no "changed elsewhere" copy;
//   - the person then edits it: their edit and the agent's cell are both kept;
//   - a grant "until the page closes" ends with the page.
//   bun web/build.ts && CHROME=chromium node web/workspace/test-notebook-agent-e2e.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { devtoolsPort } from "../test-port.mjs";

const here = new URL(".", import.meta.url).pathname;
let failures = 0, checks = 0;
const ok = (c, msg, detail) => { checks++; console.log((c ? "ok   " : "FAIL ") + msg + (c || detail === undefined ? "" : " " + JSON.stringify(detail).slice(0, 400))); if (!c) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- the site, as web/serve.py serves it (the site's headers: COOP/COEP and the CSP)
const server = spawn("python3", ["-u", join(here, "..", "serve.py"), "0"], { stdio: ["ignore", "pipe", "inherit"] });
const sport = await new Promise((res, rej) => { let acc = ""; server.stdout.on("data", (b) => { acc += b; const m = /(\d{2,5})/.exec(acc); if (m) res(+m[1]); }); setTimeout(() => rej(new Error("no server port")), 15000); });
const origin = `http://127.0.0.1:${sport}`;

// ---- the real pairing server, driven over stdin/stdout (one JSON line each way)
const DRIVER = `
import importlib.util, json, os, sys, types
src = os.environ["SB_SRC"]
pkg = types.ModuleType("sagebrush"); pkg.__path__ = [src]; sys.modules["sagebrush"] = pkg
for name in ("workspace_tools", "pairing"):
    spec = importlib.util.spec_from_file_location("sagebrush." + name, os.path.join(src, name + ".py"))
    mod = importlib.util.module_from_spec(spec); sys.modules["sagebrush." + name] = mod; spec.loader.exec_module(mod); setattr(pkg, name, mod)
from sagebrush import pairing as P
from sagebrush.workspace_tools import PageError, NotConnected
p = P.Pairing({"name": "Claude Code", "client": "claude-code", "version": "0"})
port, code = p.start()
print(json.dumps({"port": port, "code": code}), flush=True)
for line in sys.stdin:
    m = json.loads(line)
    try:
        if m["op"] == "req":
            print(json.dumps({"ok": p.request(m["method"], m["params"], timeout=10)}), flush=True)
        elif m["op"] == "status":
            s = p.status(); print(json.dumps({"ok": {"paired": s.get("paired"), "granted": s.get("granted")}}), flush=True)
    except NotConnected as e:
        print(json.dumps({"notconnected": str(e)}), flush=True)
    except PageError as e:
        print(json.dumps({"err": {"code": e.code, "message": str(e)}}), flush=True)
    except Exception as e:
        print(json.dumps({"err": {"code": type(e).__name__, "message": str(e)}}), flush=True)
`;
const py = spawn("python3", ["-s", "-c", DRIVER], { env: { ...process.env, SB_SRC: join(here, "../../engine/py/python/sagebrush"), SAGEBRUSH_MCP_DEV_ORIGIN: origin }, stdio: ["pipe", "pipe", "inherit"] });
const lines = createInterface({ input: py.stdout });
const waiters = [];
lines.on("line", (l) => waiters.shift()?.(JSON.parse(l)));
const next = () => new Promise((r) => waiters.push(r));
const drive = (m) => { const r = next(); py.stdin.write(JSON.stringify(m) + "\n"); return r; };
py.on("exit", (c) => { for (const w of waiters.splice(0)) w({ exited: c }); });
const first = await Promise.race([next(), sleep(15000).then(() => ({ exited: "no code in 15 s" }))]);
if (!first.port) { console.log("FAIL the pairing server didn't start: " + JSON.stringify(first)); try { py.kill(); } catch {} server.kill(); process.exit(1); }

// ---- Chromium
let cdp = Number(process.env.CDP_PORT) || 0;
const profile = mkdtempSync(join(tmpdir(), "sb-nb-agent-"));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", `--remote-debugging-port=${cdp}`, "--window-size=1400,900", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
try {
  if (!cdp) cdp = await devtoolsPort(profile);
  let targets;
  for (let i = 0; i < 300; i++) { try { targets = await (await fetch(`http://127.0.0.1:${cdp}/json`)).json(); break; } catch { await sleep(100); } }
  const sock = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
  await new Promise((r) => (sock.onopen = r));
  let n = 0;
  const waiting = new Map(), requests = [], console_ = [];
  sock.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
    if (m.method === "Network.requestWillBeSent") requests.push(m.params.request.url);
    if (m.method === "Log.entryAdded" || m.method === "Runtime.consoleAPICalled") console_.push(JSON.stringify(m.params).slice(0, 300));
  };
  const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); sock.send(JSON.stringify({ id, method, params })); });
  const ev = async (expr) => { const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }); if (!r.result || r.result.exceptionDetails) throw new Error(JSON.stringify(r.result?.exceptionDetails ?? r.error ?? r).slice(0, 400)); return r.result.result?.value; };
  const until = async (expr, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr).catch(() => false)) return true; await sleep(100); } return false; };
  const go = async (q) => { await ev("window.__old = 1").catch(() => {}); await send("Page.navigate", { url: origin + "/" + q }); await sleep(300); return until("!window.__old && !!window.sagebrush?.workspace", 60000); };
  for (const m of ["Page.enable", "Runtime.enable", "Network.enable", "Log.enable"]) await send(m);
  const W = "window.sagebrush.workspace";
  const chunk = (u) => /sagebrush-agent\.js/.test(u);
  // (the notebook shown: its workspace path, by the id the page keeps for it)
  const shownPath = `(async () => { const id = localStorage.getItem("sagebrush-current"); return (await ${W}.list("/", { recursive: true })).find((e) => e.kind === "notebook" && e.ref === id)?.path ?? null; })()`;
  const sources = `[...document.querySelectorAll(".ed textarea")].map((t) => t.value)`;

  ok(await go(""), "the notebook page opens its workspace");
  ok(await until(`!document.querySelector("#agentbtn").hidden`), "the page offers Agent");
  ok(!requests.some(chunk), "the agent chunk isn't fetched before it's wanted");
  await ev(`(document.querySelector("#agentbtn").click(), true)`);
  ok(await until(`!!document.querySelector(".sbag-box")`) && requests.some(chunk), "Agent fetches the chunk and opens Connect");
  await ev(`(document.activeElement?.blur(), document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })), [...document.querySelectorAll(".sbag-box button")].find((b) => b.textContent === "Cancel")?.click(), true)`);
  ok(await until(`!document.querySelector(".sbag-box")`), "Cancel closes it");

  // the notebook shown, with a cell of the person's
  await ev(`(() => { const t = document.querySelector(".ed textarea"); t.value = "x = 1"; t.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
  await ev(`window.sagebrush.notebook.flush()`);
  // (the page lists the notebook in the workspace once it's open: a moment after the first load)
  await until(`${shownPath}.then((p) => !!p)`);
  const path = await ev(shownPath);
  ok(await until(`${W}.read(${JSON.stringify(path)}).then((r) => r.content.cells.some((c) => c.code === "x = 1"))`), "the person's cell is saved");
  ok(typeof path === "string" && path.endsWith(".ipynb"), "the notebook shown is in the workspace", path);

  // a ?pair= link: Connect, then the grant (the notebook's folder, may change files, until the page closes)
  ok(await go(`?pair=${first.code}&port=${first.port}`), "the ?pair= link opens the page");
  ok(await ev(`!/pair=/.test(location.search)`), "the code is taken out of the address bar");
  ok(await until(`!!document.querySelector(".sbag-box button.primary")`), "the Connect dialog shows, its code filled in", console_.slice(-5));
  await ev(`(document.querySelector(".sbag-box button.primary").click(), true)`);
  ok(await until(`[...document.querySelectorAll(".sbag-box h2")].some((h) => h.textContent === "Allow this agent?")`), "paired: the grant dialog asks the person (the site's CSP admits the loopback socket)", { err: await ev(`document.querySelector(".sbag-box .err")?.textContent ?? ""`).catch(() => "") });
  const folder = path.slice(0, path.lastIndexOf("/")) || "/";
  await ev(`(() => {
    const b = document.querySelector(".sbag-box");
    const pick = ${JSON.stringify(folder)} === "/" ? b.querySelector(".folders input") : b.querySelector('.folders input[value=${JSON.stringify(folder)}]');
    if (!pick.checked) pick.click();
    const write = [...b.querySelectorAll("input[type=checkbox]")].find((c) => !c.closest(".folders"));
    if (!write.checked) write.click();
    const s = b.querySelector("select"); s.value = "page"; s.dispatchEvent(new Event("change"));
    return true;
  })()`);
  await ev(`([...document.querySelectorAll(".sbag-box button.primary")].pop().click(), true)`);
  ok(await until(`!!document.querySelector(".sbag-bar")`), "allowed: the bar shows the agent");
  await until(`window.sagebrush.notebook.snapshot?.().cells?.length > 0`);

  // the agent reads the notebook shown and adds a cell: the page shows it at once
  const rd = await drive({ op: "req", method: "workspace.read", params: { path } });
  const doc = rd.ok?.content?.json;
  ok(Array.isArray(doc?.cells) && doc.cells.some((c) => c.code === "x = 1"), "the agent reads the notebook, the person's cell in it", rd);
  const MARK = "print('from the agent', 6 * 7)";
  const wr = await drive({ op: "req", method: "workspace.write", params: { path, content: { json: { ...doc, cells: [...doc.cells, { id: "agentcell1", code: MARK, outputs: [], n: null }] } }, base: rd.ok?.rev } });
  ok(!!wr.ok, "the agent writes it (its base)", wr);
  ok(await until(`${sources}.includes(${JSON.stringify(MARK)})`, 10000), "the page shows the agent's cell at once, without a reload", await ev(sources).catch(() => null));
  ok(await ev(`${sources}.some((s) => s === "x = 1")`), "the person's cell is still there");

  // the person edits after it: both kept, and no "changed elsewhere" copy
  await ev(`(() => { const t = [...document.querySelectorAll(".ed textarea")].find((t) => t.value === "x = 1"); t.value = "x = 2"; t.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
  await ev(`window.sagebrush.notebook.flush()`);
  await sleep(500);
  const rd2 = await drive({ op: "req", method: "workspace.read", params: { path } });
  const srcs = (rd2.ok?.content?.json?.cells ?? []).map((c) => c.code);
  ok(srcs.includes("x = 2") && srcs.includes(MARK), "the person's later edit and the agent's cell are both saved", srcs);
  const copies = await ev(`${W}.list("/", { recursive: true }).then((l) => l.filter((e) => /changed elsewhere/.test(e.path)).map((e) => e.path))`);
  ok(copies.length === 0, "no \"changed elsewhere\" copy was made", copies);

  // a grant "until the page closes" ends with the page
  ok(await go(""), "the page again");
  const st = await drive({ op: "status" });
  ok(st.ok?.paired === false || st.ok?.granted === false, "the grant ended with the page", st);
} catch (e) {
  ok(false, "threw: " + (e?.stack ?? e));
} finally {
  try { py.kill(); } catch {}
  try { chrome.kill(); } catch {}
  try { server.kill(); } catch {}
  await sleep(300);
  rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
}
console.log(failures ? `FAIL: ${failures} of ${checks}` : `ok: an agent paired with the notebook page, ${checks} checks`);
process.exit(failures ? 1 : 0);
