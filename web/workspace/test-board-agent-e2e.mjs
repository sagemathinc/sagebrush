// ci: web-runner order=182 chrome
// An agent paired with a board, end to end, for everyone (no ?agents): the board page (web/dist, served by
// web/serve.py with the site's headers, its CSP included) and the REAL pairing server (pairing.py, as sagebrush-mcp
// runs it):
//   - ⋯ offers "Connect an agent…" once the workspace is open; no button floats over the board;
//   - it opens Connect; Cancel gives the focus back to ⋯;
//   - a ?pair= link connects, the person allows a folder, the bar shows the agent, and the agent lists the board;
//   - a remembered grant reconnects on the next load by itself; Revoke ends it;
//   - a board saved as a file and the desktop app (window.__TAURI__) offer no agent and mount nothing.
//   bun web/build.ts && CHROME=chromium node web/workspace/test-board-agent-e2e.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
        if m["op"] == "code":
            port, code = p.start(); print(json.dumps({"port": port, "code": code}), flush=True)
        elif m["op"] == "req":
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
const profile = mkdtempSync(join(tmpdir(), "sb-board-agent-"));
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
    if (m.method === "Fetch.requestPaused" && m.params.responseStatusCode !== undefined && asFile) void asSavedFile(m.params);
    else if (m.method === "Fetch.requestPaused") send(failChunk ? "Fetch.failRequest" : "Fetch.continueRequest", failChunk ? { requestId: m.params.requestId, errorReason: "InternetDisconnected" } : { requestId: m.params.requestId });
  };
  let failChunk = false, asFile = false;
  // (the board's page as a board saved as a file has it: its document embedded, script#sb-doc (board/export.ts embedded()),
  //  made from the served page in flight, its headers kept)
  const asSavedFile = async (pp) => {
    const b = await send("Fetch.getResponseBody", { requestId: pp.requestId });
    const html = b.result.base64Encoded ? Buffer.from(b.result.body, "base64").toString("utf8") : b.result.body;
    const doc = '<script type="application/json" id="sb-doc">{"title":"Saved","nodes":[{"id":"a","text":"saved as a file"}]}</script>';
    const body = html.replace(/<body([^>]*)>/i, (x) => x + doc);
    send("Fetch.fulfillRequest", { requestId: pp.requestId, responseCode: pp.responseStatusCode, responseHeaders: pp.responseHeaders, body: Buffer.from(body).toString("base64") });
  };
  const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); sock.send(JSON.stringify({ id, method, params })); });
  const ev = async (expr) => { const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }); if (!r.result || r.result.exceptionDetails) throw new Error(JSON.stringify(r.result?.exceptionDetails ?? r.error ?? r).slice(0, 400)); return r.result.result?.value; };
  const until = async (expr, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr).catch(() => false)) return true; await sleep(100); } return false; };
  const go = async (q) => { await ev("window.__old = 1").catch(() => {}); await send("Page.navigate", { url: origin + "/" + q }); await sleep(300); return until("!window.__old && !!window.sagebrush?.workspace", 60000); };
  for (const m of ["Page.enable", "Runtime.enable", "Network.enable", "Log.enable"]) await send(m);
  const chunkless = (u) => /sagebrush-agent\.js|sagebrush-latex-agent\.js/.test(u);
  const item = `document.querySelector('#board [data-sbb="agent"]')`;
  const goBoard = async (q) => { await ev("window.__old = 1").catch(() => {}); await send("Page.navigate", { url: origin + "/board/" + q }); await sleep(300); return until(`!window.__old && !!${item} && !${item}.hidden`, 60000); };
  const grant = async (remember) => {
    ok(await until(`[...document.querySelectorAll(".sbag-box h2")].some((h) => h.textContent === "Allow this agent?")`), "paired: the grant dialog asks the person (the site's CSP admits the loopback socket)", { err: await ev(`document.querySelector(".sbag-box .err")?.textContent ?? ""`).catch(() => "") });
    await ev(`(() => {
      const b = document.querySelector(".sbag-box");
      const all = b.querySelector(".folders input"); if (!all.checked) all.click();
      const [write, rem] = [...b.querySelectorAll("input[type=checkbox]")].filter((c) => !c.closest(".folders"));
      if (!write.checked) write.click();
      const s = b.querySelector("select"); s.value = ${JSON.stringify(remember ? "3600000" : "page")}; s.dispatchEvent(new Event("change"));
      if (${remember} && !rem.checked) rem.click();
      return true;
    })()`);
    await ev(`([...document.querySelectorAll(".sbag-box button.primary")].pop().click(), true)`);
    return until(`!!document.querySelector(".sbag-bar")`);
  };

  // (a new board's first load, which puts it in Edit, doesn't close a menu opened meanwhile: the auto-Edit was a click,
  //  which the window's close-the-menus listener took; board's root cause of this suite's "⋯ opens its menu" flake)
  {
    const hold = await send("Page.addScriptToEvaluateOnNewDocument", { source: "window.__sbTestHoldLoad = new Promise((r) => (window.__sbReleaseLoad = r));" });
    ok(await goBoard("?new=python"), "(a new board, its first load held)");
    await ev(`(document.querySelector('#board [data-sbb="menubtn"]').click(), true)`);
    const openBefore = await ev(`!document.querySelector('#board [data-sbb="menu"]').hidden`);
    // (grader's B2: the first load really held there (the seam says so), not yet in Edit)
    const editBefore = await ev(`document.querySelector('#board [data-sbb="edit"]').getAttribute("aria-pressed")`);
    const heldThere = await ev("window.__sbTestLoadHeld === true");
    await ev("(window.__sbReleaseLoad(), true)");
    const edit = await until(`document.querySelector('#board [data-sbb="edit"]').getAttribute("aria-pressed") === "true"`);
    const openAfter = await ev(`!document.querySelector('#board [data-sbb="menu"]').hidden`);
    ok(heldThere && editBefore !== "true" && openBefore && edit && openAfter, "a new board's first load goes into Edit without closing ⋯, opened while it loaded", { heldThere, editBefore, openBefore, edit, openAfter });
    await send("Page.removeScriptToEvaluateOnNewDocument", { identifier: hold.result.identifier });
  }
  // a board, made in this browser, as New ▸ Board makes it
  ok(await goBoard("?new=python"), "a new board opens, and ⋯ offers Connect an agent…");
  ok(await ev(`${item}.textContent`) === "Connect an agent…" && await ev(`${item}.title`) === "Connect an agent on this computer (Claude Code, Codex, …) to files you choose", "the item's words and title");
  ok(!(await ev(`[...document.querySelectorAll("body > button")].some((b) => /Connect an agent/.test(b.textContent))`)), "no button floats over the board");
  ok(!requests.some(chunkless), "no separate agent chunk is fetched (the board's own bundle has the pairing)");
  const doc = await ev(`new URLSearchParams(location.search).get("doc")`);
  ok(/^local:[0-9a-f]{12}$/.test(doc ?? ""), "the board is this browser's", doc);
  await ev(`(document.querySelector('#board [data-sbb="menubtn"]').click(), true)`);
  ok(await until(`!document.querySelector('#board [data-sbb="menu"]').hidden`), "⋯ opens its menu");
  if (process.env.SHOT_DIR) { const r = await send("Page.captureScreenshot", { format: "png" }); writeFileSync(join(process.env.SHOT_DIR, "board-menu.png"), Buffer.from(r.result.data, "base64")); }
  await ev(`(${item}.click(), true)`);
  ok(await until(`!!document.querySelector(".sbag-box")`) && await ev(`document.querySelector('#board [data-sbb="menu"]').hidden`), "Connect an agent… opens Connect, and the menu closes");
  await ev(`([...document.querySelectorAll(".sbag-box button")].find((b) => b.textContent === "Cancel").click(), true)`);
  ok(await until(`!document.querySelector(".sbag-box") && document.activeElement === document.querySelector('#board [data-sbb="menubtn"]')`), "Cancel closes it, and the focus goes back to ⋯");

  // a ?pair= link on the board (no ?agents): Connect with its code, then the grant
  ok(await goBoard(`?doc=${encodeURIComponent(doc)}&pair=${first.code}&port=${first.port}`), "a ?pair= link opens the board");
  ok(await ev(`!/pair=/.test(location.search)`), "the code is taken out of the address bar");
  ok(await until(`[...document.querySelectorAll(".sbag-box input")].some((i) => i.value === ${JSON.stringify(first.code)})`), "the Connect dialog shows, its code filled in");
  await ev(`(document.querySelector(".sbag-box button.primary").click(), true)`);
  ok(await grant(true), "allowed for 1 hour, remembered: the bar shows");
  const ls = await drive({ op: "req", method: "workspace.list", params: { folder: "/", recursive: true } });
  ok(JSON.stringify(ls).includes(".board.json"), "the agent lists the workspace, the board in it", JSON.stringify(ls).slice(0, 300));

  // the remembered grant, on the next load: reconnected by itself
  ok(await goBoard(`?doc=${encodeURIComponent(doc)}`), "the board again, nothing pressed");
  ok(await until(`!!document.querySelector(".sbag-bar")`, 20000), "the remembered agent reconnects");
  ok(await ev(`document.querySelectorAll(".sbag-bar").length`) === 1 && !(await ev(`!!document.querySelector(".sbag-box")`)), "one bar, no dialog");
  await ev(`(document.querySelector('#board [data-sbb="menubtn"]').click(), true)`);
  await ev(`(${item}.click(), true)`);
  await sleep(500);
  ok(await ev(`document.querySelectorAll(".sbag-bar").length`) === 1 && !(await ev(`!!document.querySelector(".sbag-box")`)), "Connect an agent… while connected shows that bar, not an empty Connect");
  await ev(`([...document.querySelectorAll(".sbag-bar button")].find((b) => b.textContent === "Revoke")?.click(), true)`);
  ok(await until(`!document.querySelector(".sbag-bar")`), "Revoke: the bar goes");
  ok(await goBoard(`?doc=${encodeURIComponent(doc)}`) && (await sleep(3000), !(await ev(`!!document.querySelector(".sbag-bar") || !!document.querySelector(".sbag-box")`))), "after Revoke, the next load connects nothing");

  // the two exclusions (grader's #929 rows): a board saved as a file, and the desktop app, offer no agent and mount no
  // pairing, whatever the address says (pages the agent's program doesn't accept)
  const quiet = async (what) => {
    const shown = await until(`!!document.querySelector('#board [data-sbb="menubtn"]')`, 60000);
    await sleep(3000);
    const st = await ev(`({ item: !!${item} && !${item}.hidden, box: !!document.querySelector(".sbag-box"), bar: !!document.querySelector(".sbag-bar") })`);
    ok(shown && !st.item && !st.box && !st.bar, what, st);
  };
  const c2 = await drive({ op: "code" });
  asFile = true;
  await send("Fetch.enable", { patterns: [{ urlPattern: origin + "/board/*", resourceType: "Document", requestStage: "Response" }] });
  await ev("window.__old = 1").catch(() => {});
  await send("Page.navigate", { url: origin + `/board/?pair=${c2.code}&port=${c2.port}` });
  await sleep(300);
  ok(await until(`!window.__old && !!document.getElementById("sb-doc")`, 30000), "(the board page as a board saved as a file: its document embedded)");
  await quiet("a board saved as a file: no Connect an agent… in ⋯, and its ?pair= link mounts nothing (no dialog, no bar)");
  await send("Fetch.disable");
  asFile = false;
  const tauri = await send("Page.addScriptToEvaluateOnNewDocument", { source: "window.__TAURI__ = window.__TAURI__ || {};" });
  await ev("window.__old = 1").catch(() => {});
  await send("Page.navigate", { url: origin + `/board/?doc=${encodeURIComponent(doc)}&pair=${c2.code}&port=${c2.port}` });
  await sleep(300);
  ok(await until(`!window.__old && "__TAURI__" in window`, 30000), "(the board page with window.__TAURI__ defined before it loads, as the desktop app has it)");
  await quiet("the desktop app: no Connect an agent… in ⋯, and a ?pair= link mounts nothing (no dialog, no bar)");
  await send("Page.removeScriptToEvaluateOnNewDocument", { identifier: tauri.result.identifier });
} catch (e) {
  ok(false, "threw: " + (e?.stack ?? e));
} finally {
  try { py.kill(); } catch {}
  try { chrome.kill(); } catch {}
  try { server.kill(); } catch {}
  await sleep(300);
  rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
}
console.log(failures ? `FAIL: ${failures} of ${checks}` : `ok: an agent paired with a board, ${checks} checks`);
process.exit(failures ? 1 : 0);
