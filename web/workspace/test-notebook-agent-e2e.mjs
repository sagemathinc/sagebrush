// ci: web-runner order=181 chrome
// ci: web-browser/latex order=46 chrome env=EXPECT_LATEX=1
// An agent paired with the notebook page, end to end: the page (web/dist, served by web/serve.py with the site's
// headers, its CSP included) and the REAL pairing server (engine/py/python/sagebrush/pairing.py, as sagebrush-mcp
// runs it), its requests made as an agent's tools make them:
//   - the page offers Agent once its workspace is open; the agent chunk (/sagebrush-agent.js) isn't fetched before;
//   - Agent opens Connect; a ?pair= link connects, the person allows a folder, the bar shows the agent;
//   - a code file's page (/?code=) has no Agent of the notebook's over it: File ▸ Connect an agent… is the page's one
//     pairing there (nothing fetched before it's wanted); a ?pair= link connects there; a remembered agent reconnects there;
//   - the agent reads the notebook shown and writes it (workspace.write with its base): the page shows the new cell
//     at once, with no reload and no "changed elsewhere" copy;
//   - the person then edits it: their edit and the agent's cell are both kept;
//   - the agent writes Jupyter's nbformat cells (as agents do): the page shows them with their text, not empty;
//   - a grant "until the page closes" ends with the page.
//   - the person's request first, as Claude Code makes it (sagebrush-mcp's own server, not paired yet): the agent's first
//     tool call (workspace_create) answers with the one link (code and port in it); the person opens it, Connect, Allow,
//     while the agent waits in workspace_connect; then the agent makes the notebook and the page shows it.
//   - in a build with the LaTeX editor (CI's web-browser/latex, EXPECT_LATEX=1: there it must run): one pairing per page.
//     An early ?pair= link on /?tex= is the LaTeX editor's only (its chunk, not the notebook page's); a remembered
//     grant reconnects there once, one bar, and the editor's Agent shows that bar, not an empty Connect.
//   bun web/build.ts && CHROME=chromium node web/workspace/test-notebook-agent-e2e.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { devtoolsPort } from "../test-port.mjs";
import { BAR_CLEAR } from "./agent-bar-check.mjs";

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

// ---- sagebrush-mcp's own server (mcp_server.py's Server, its tool calls as Claude Code makes them), not paired: one
// JSON line each way, {id, name, args} -> {id, text, structured, isError}; each call in its own thread, so a
// workspace_connect that waits doesn't hold the others
const MCP_DRIVER = `
import io, json, os, sys, threading, types
src = os.environ["SB_SRC"]
pkg = types.ModuleType("sagebrush"); pkg.__path__ = [src]; sys.modules["sagebrush"] = pkg
from sagebrush import mcp_server as M
srv = M.Server(io.StringIO())
srv.client = {"name": "claude-code", "version": "0"}
out = threading.Lock()
def one(m):
    content, structured, is_error = srv.call_tool(m["name"], m["args"])
    with out:
        print(json.dumps({"id": m["id"], "text": content[0]["text"], "structured": structured, "isError": is_error}), flush=True)
for line in sys.stdin:
    threading.Thread(target=one, args=(json.loads(line),), daemon=True).start()
`;
const mcp = spawn("python3", ["-s", "-c", MCP_DRIVER], { env: { ...process.env, SB_SRC: join(here, "../../engine/py/python/sagebrush"), SAGEBRUSH_MCP_DEV_ORIGIN: origin }, stdio: ["pipe", "pipe", "ignore"] });
const mcpWait = new Map();
let mcpId = 0;
createInterface({ input: mcp.stdout }).on("line", (l) => { const m = JSON.parse(l); mcpWait.get(m.id)?.(m); mcpWait.delete(m.id); });
const tool = (name, args = {}) => new Promise((r) => { const id = ++mcpId; mcpWait.set(id, r); mcp.stdin.write(JSON.stringify({ id, name, args }) + "\n"); });

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
    if (m.method === "Fetch.requestPaused") send(failChunk ? "Fetch.failRequest" : "Fetch.continueRequest", failChunk ? { requestId: m.params.requestId, errorReason: "InternetDisconnected" } : { requestId: m.params.requestId });
  };
  let failChunk = false;
  const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); sock.send(JSON.stringify({ id, method, params })); });
  const ev = async (expr) => { const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }); if (!r.result || r.result.exceptionDetails) throw new Error(JSON.stringify(r.result?.exceptionDetails ?? r.error ?? r).slice(0, 400)); return r.result.result?.value; };
  const until = async (expr, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr).catch(() => false)) return true; await sleep(100); } return false; };
  const go = async (q) => { await ev("window.__old = 1").catch(() => {}); await send("Page.navigate", { url: origin + "/" + q }); await sleep(300); return until("!window.__old && !!window.sagebrush?.workspace", 60000); };
  for (const m of ["Page.enable", "Runtime.enable", "Network.enable", "Log.enable"]) await send(m);
  const W = "window.sagebrush.workspace";
  const chunk = (u) => /sagebrush-agent\.js/.test(u);
  // (SHOT_DIR: screenshots for a review, at the moments below)
  const shot = async (name) => { if (!process.env.SHOT_DIR) return; const r = await send("Page.captureScreenshot", { format: "png" }); writeFileSync(join(process.env.SHOT_DIR, name + ".png"), Buffer.from(r.result.data, "base64")); };
  // (the notebook shown: its workspace path, by the id the page keeps for it)
  const shownPath = `(async () => { const id = localStorage.getItem("sagebrush-current"); return (await ${W}.list("/", { recursive: true })).find((e) => e.kind === "notebook" && e.ref === id)?.path ?? null; })()`;
  const sources = `[...document.querySelectorAll(".ed textarea")].map((t) => t.value)`;

  ok(await go(""), "the notebook page opens its workspace");
  ok(await until(`!document.querySelector("#agentbtn").hidden`), "the page offers Agent");
  ok(!requests.some(chunk), "the agent chunk isn't fetched before it's wanted");
  await shot("1-agent-button");
  ok(await ev(`document.querySelector("#agentbtn").title`) === "Connect an agent on this computer (Claude Code, Codex, …) to files you choose", "its title says the person chooses the files");
  // the chunk's fetch failing (the network down, or the site updated since the page loaded): said in one line, and the
  // next press fetches it again
  await send("Fetch.enable", { patterns: [{ urlPattern: "*sagebrush-agent.js*" }] });
  failChunk = true;
  // (the status line is the page's, which other messages replace: every text it shows is kept here)
  await ev(`(() => { const st = document.querySelector("#status"); window.__said = []; new MutationObserver(() => window.__said.push(st.textContent)).observe(st, { childList: true, characterData: true, subtree: true }); return true; })()`);
  await ev(`(document.querySelector("#agentbtn").click(), true)`);
  ok(await until(`window.__said.includes("Couldn't load the agent connection. Try Agent or ⋯ ▸ Connect an agent… again, or reload the page.")`) && !(await ev(`!!document.querySelector(".sbag-box")`)), "the chunk's fetch failing: the page says so in one line", await ev(`window.__said`).catch(() => null));
  failChunk = false;
  await send("Fetch.disable");
  await ev(`(document.querySelector("#agentbtn").click(), true)`);
  ok(await until(`!!document.querySelector(".sbag-box")`) && requests.some(chunk), "the next press fetches the chunk again and opens Connect", requests.filter(chunk));
  await shot("2-connect");
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
    // (Everything is ticked when the dialog opens (chat plan PR 3): a folder is chosen by unticking it first)
    if (${JSON.stringify(folder)} !== "/") { const all = b.querySelector(".folders input"); if (all.checked) all.click(); }
    const pick = ${JSON.stringify(folder)} === "/" ? b.querySelector(".folders input") : b.querySelector('.folders input[value=${JSON.stringify(folder)}]');
    if (!pick.checked) pick.click();
    const write = [...b.querySelectorAll("input[type=checkbox]")].find((c) => !c.closest(".folders"));
    if (!write.checked) write.click();
    const s = b.querySelector("select"); s.value = "page"; s.dispatchEvent(new Event("change"));
    return true;
  })()`);
  await ev(`([...document.querySelectorAll(".sbag-box button.primary")].pop().click(), true)`);
  ok(await until(`!!document.querySelector(".sbag-bar")`), "allowed: the bar shows the agent");
  ok(await until(`${BAR_CLEAR} === true`, 5000), "the notebook page: the agent's bar is in its own row, over nothing the person types in or reads", await ev(BAR_CLEAR).catch((e) => String(e)));
  await until(`window.sagebrush.notebook.snapshot?.().cells?.length > 0`);

  // the agent reads the notebook shown and adds a cell: the page shows it at once
  const rd = await drive({ op: "req", method: "workspace.read", params: { path } });
  const doc = rd.ok?.content?.json;
  ok(Array.isArray(doc?.cells) && doc.cells.some((c) => c.code === "x = 1"), "the agent reads the notebook, the person's cell in it", rd);
  // (and its address, a link the agent can give the person: this site's notebook page, by the notebook's own id, which
  //  the agent's view of the entry doesn't carry)
  const site = await ev("location.origin");
  const ref = await ev(`window.sagebrush.workspace.stat(${JSON.stringify(path)}).then((e) => e?.ref ?? null)`).catch(() => null);
  ok(typeof ref === "string" && rd.ok?.entry?.url === site + "/?nb=" + encodeURIComponent(ref) && !("ref" in (rd.ok?.entry ?? {})), "the read's entry has url, the notebook's page on this site (and still no ref of its own)", { entry: rd.ok?.entry, ref });
  const MARK = "print('from the agent', 6 * 7)";
  const wr = await drive({ op: "req", method: "workspace.write", params: { path, content: { json: { ...doc, cells: [...doc.cells, { id: "agentcell1", code: MARK, outputs: [], n: null }] } }, base: rd.ok?.rev } });
  ok(!!wr.ok, "the agent writes it (its base)", wr);
  ok(await until(`${sources}.includes(${JSON.stringify(MARK)})`, 10000), "the page shows the agent's cell at once, without a reload", await ev(sources).catch(() => null));
  ok(await ev(`${sources}.some((s) => s === "x = 1")`), "the person's cell is still there");
  await ev(`(document.querySelector(".ed textarea:last-of-type"), [...document.querySelectorAll(".ed textarea")].pop().scrollIntoView({ block: "center" }), true)`);
  await shot("3-agent-cell");

  // the person edits after it: both kept, and no "changed elsewhere" copy
  await ev(`(() => { const t = [...document.querySelectorAll(".ed textarea")].find((t) => t.value === "x = 1"); t.value = "x = 2"; t.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
  await ev(`window.sagebrush.notebook.flush()`);
  await sleep(500);
  const rd2 = await drive({ op: "req", method: "workspace.read", params: { path } });
  const srcs = (rd2.ok?.content?.json?.cells ?? []).map((c) => c.code);
  ok(srcs.includes("x = 2") && srcs.includes(MARK), "the person's later edit and the agent's cell are both saved", srcs);
  const copies = await ev(`${W}.list("/", { recursive: true }).then((l) => l.filter((e) => /changed elsewhere/.test(e.path)).map((e) => e.path))`);
  ok(copies.length === 0, "no \"changed elsewhere\" copy was made", copies);

  // the agent writes it as Jupyter's nbformat ({cell_type, source}, as both agents did in the sim, F1): the page shows
  // those cells with their text, a code cell and a Markdown one, not empty cells
  const rd3 = await drive({ op: "req", method: "workspace.read", params: { path } });
  const NBF = "print('nbformat', 6 * 7)";
  const wr3 = await drive({ op: "req", method: "workspace.write", params: { path, content: { json: { cells: [...rd3.ok.content.json.cells, { cell_type: "code", metadata: {}, execution_count: null, outputs: [], source: ["print(", "'nbformat', 6 * 7)"] }, { cell_type: "markdown", metadata: {}, source: "## From Jupyter\n\nSome text." }] } }, base: rd3.ok?.rev } });
  ok(!!wr3.ok, "the agent writes nbformat cells", wr3);
  ok(await until(`${sources}.includes(${JSON.stringify(NBF)}) && window.sagebrush.notebook.snapshot().cells.some((c) => c.type === "markdown" && c.code.startsWith("## From Jupyter"))`, 10000), "the page shows them: the code cell's text, and a Markdown cell with its own", { sources: await ev(sources).catch(() => null), cells: await ev(`window.sagebrush.notebook.snapshot().cells.map((c) => [c.type ?? "code", c.code])`).catch(() => null) });
  const rd4 = await drive({ op: "req", method: "workspace.read", params: { path } });
  ok((rd4.ok?.content?.json?.cells ?? []).every((c) => typeof c.code === "string" && c.cell_type === undefined), "…kept in Sagebrush's shape: read back, every cell has its code", rd4.ok?.content?.json?.cells);

  // the agent creates a notebook: the page opens it at once, in place, and stays paired (decided Nov 18 2026); the bar
  // offers Open for it. The person's edit typed just before, not yet saved, is kept in the notebook they left
  const typeInto = (from, to) => ev(`(() => { const t = [...document.querySelectorAll(".ed textarea")].find((t) => t.value === ${JSON.stringify(from)}); if (!t) return false; t.value = ${JSON.stringify(to)}; t.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
  const barButton = (text) => `[...document.querySelectorAll(".sbag-bar button")].find((b) => b.textContent === ${JSON.stringify(text)})`;
  const make = (name, cells, extra = {}) => drive({ op: "req", method: "workspace.create", params: { path: (folder === "/" ? "" : folder) + "/" + name + ".ipynb", mode: "python", content: { json: { ...extra, cells: cells.map((code) => ({ code })) } } } });
  const shownIs = (name) => `document.title.startsWith(${JSON.stringify(name)})`;
  // (a notebook opened from Files as the person does. The list fills in after Files opens, and redraws as the agent's
  //  files arrive: the entry is waited for, and clicked again if a redraw took the click, until the page shows it)
  const fromFiles = async (file) => {
    await ev(`(document.querySelector("#wssidebar")?.hidden && document.querySelector("#wsfilesbtn")?.click(), true)`);
    await until(`!!document.querySelector("#wssidebar") && !document.querySelector("#wssidebar").hidden`, 5000);
    const entry = `[...document.querySelectorAll("#wssidebar *")].find((e) => e.children.length === 0 && e.textContent.trim() === ${JSON.stringify(file)})`;
    const shown = `document.title.startsWith(${JSON.stringify(file.replace(/\.ipynb$/, ""))})`;
    for (let i = 0; i < 3; i++) {
      if (!(await until(`!!${entry}`, 10000))) return false;
      await ev(`(${entry}.click(), true)`);
      if (await until(shown, 5000)) return true;
    }
    return false;
  };
  const origin0 = await ev("performance.timeOrigin");
  ok(await typeInto("x = 2", "x = 3"), "(the person types in the notebook shown)");
  const MADE = "print('made by the agent')";
  const mk = await make("Made by the agent", [MADE]);
  ok(!!mk.ok, "the agent creates a notebook", mk);
  ok(await until(`${shownIs("Made by the agent")} && ${sources}.includes(${JSON.stringify(MADE)})`, 15000), "the page opens it at once, its cell shown", { title: await ev("document.title").catch(() => null) });
  ok(await ev("performance.timeOrigin") === origin0, "…in place: the same document, never loaded again");
  // (its one run by itself, waited for here, before the person moves on: the first run in a page loads the engine, some
  //  seconds on a slow machine, and a notebook left before its run ends keeps no outputs, as with the person's own Run all)
  ok(await until(`JSON.stringify(window.sagebrush.notebook.snapshot().cells.find((c) => c.code === ${JSON.stringify(MADE)})?.outputs ?? null).includes("made by the agent")`, 60000), "it runs once by itself, its output shown (before the person opens another)", await ev(`JSON.stringify(window.sagebrush.notebook.snapshot().cells.map((c) => c.outputs ?? null))`).catch(() => null));
  const kept = await ev(`${W}.read(${JSON.stringify(path)}).then((r) => (r.content?.cells ?? []).map((c) => c.code))`);
  ok(Array.isArray(kept) && kept.includes("x = 3"), "the edit typed just before, never flushed by the test, is kept in the notebook left", kept);
  const st0 = await drive({ op: "status" });
  ok(st0.ok?.paired === true && st0.ok?.granted === true && await ev(`!!document.querySelector(".sbag-bar")`), "the agent is still connected, its bar shown", st0);
  ok(await until(`!!${barButton("Open Made by the agent.ipynb")}`, 5000), "the bar offers Open for it");
  const ls0 = await drive({ op: "req", method: "workspace.list", params: { folder } });
  ok(JSON.stringify(ls0).includes("Made by the agent.ipynb"), "and the agent goes on working: it lists the folder", JSON.stringify(ls0).slice(0, 300));
  // (the bar's Open, after the person moved away: it opens the agent's notebook again)
  const left = path.slice(path.lastIndexOf("/") + 1);
  ok(await fromFiles(left) && await until(`!${shownIs("Made by the agent")} && ${sources}.includes("x = 3")`, 15000), "(the person opens their own notebook again, from Files)");
  // (pressed as a person does, with a real mouse, and the agent changes a file while the button is held down: the counts
  //  change under it, the button stays the same one, and the press lands (W4))
  const at = await ev(`(() => { const b = window.__w4open = ${barButton("Open Made by the agent.ipynb")}; b.scrollIntoView({ block: "center" }); const r = b.getBoundingClientRect(); window.__w4clicks = 0; b.addEventListener("click", () => window.__w4clicks++);
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, chip: document.querySelector(".sbag-bar button.chip").textContent }; })()`);
  await send("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, x: at.x, y: at.y });
  const fr4 = await drive({ op: "req", method: "workspace.read", params: { path } });
  const wa4 = await drive({ op: "req", method: "workspace.write", params: { path, base: fr4.ok?.rev, content: fr4.ok?.content } });
  const moved = await until(`document.querySelector(".sbag-bar button.chip").textContent !== ${JSON.stringify(at.chip)}`, 10000);
  const same = await ev(`window.__w4open.isConnected && window.__w4open === ${barButton("Open Made by the agent.ipynb")}`);
  const box4 = await ev(`(() => { const r = window.__w4open.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; })()`);
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, x: at.x, y: at.y });
  ok(!!wa4.ok && moved && same && at.y > 0 && box4[1] <= at.y && at.y <= box4[1] + box4[3], "W4: the agent writes while Open is held down: the counts change, the same Open button stays", { wa: !!wa4.ok, moved, same, at, box4 });
  ok(await until(shownIs("Made by the agent"), 15000) && await ev("performance.timeOrigin") === origin0, "the bar's Open, pressed across that change, opens the agent's notebook, in place", { at, box4, clicks: await ev("window.__w4clicks") });
  // (the person's open wins: the agent's notebook, its open held before it attaches, never replaces a notebook the person
  //  opened meanwhile)
  ok(await fromFiles(left) && await until(`!${shownIs("Made by the agent")}`, 15000), "(the person's own notebook again)");
  await ev(`(() => { window.sagebrush.shareTest.beforeLeave = () => { window.sagebrush.shareTest.beforeLeave = undefined; return new Promise((r) => (window.__leaveGo = r)); }; return true; })()`);
  const RACE = "print('created meanwhile')";
  ok(!!(await make("Created meanwhile", [RACE])).ok && await until("typeof window.__leaveGo === 'function'", 10000), "the agent creates another: its open held before it attaches");
  ok(await fromFiles("Made by the agent.ipynb") && await until(shownIs("Made by the agent"), 15000), "(meanwhile the person opens the agent's first notebook)");
  await ev("(window.__leaveGo(), delete window.__leaveGo, true)");
  await sleep(3000);
  ok(await ev(shownIs("Made by the agent")) && !(await ev(`${sources}.includes(${JSON.stringify(RACE)})`)), "the person's open wins: the agent's notebook doesn't replace it after", { title: await ev("document.title") });
  ok(await until(`!!${barButton("Open Created meanwhile.ipynb")}`, 5000), "…it is offered in the bar's Open instead");
  const mf = await drive({ op: "req", method: "workspace.create", params: { path: (folder === "/" ? "" : folder) + "/agent-notes.txt", content: { text: "notes" } } });
  ok(!!mf.ok && await until(`!!${barButton("Open agent-notes.txt")}`, 5000), "a data file it creates: the bar's Open names it", mf);
  ok(await ev(shownIs("Made by the agent")), "…and nothing else opens");

  // what an agent creates runs once by itself, as the person's Run all would, when the grant in force has May run code
  // and Everything, as here (the conditions decided Nov 18 2026)
  ok(folder === "/", "(the grant here is Everything: the notebook shown is at the top)", folder);
  const outOf = (code) => `JSON.stringify(window.sagebrush.notebook.snapshot().cells.find((c) => c.code === ${JSON.stringify(code)})?.outputs ?? null)`;
  const nOf = (code) => `(window.sagebrush.notebook.snapshot().cells.find((c) => c.code === ${JSON.stringify(code)})?.n ?? null)`;
  ok(await until(`${shownIs("Made by the agent")} && ${outOf(MADE)}.includes("made by the agent")`, 30000), "the agent's first notebook keeps the output of its one run, opened again", await ev(outOf(MADE)).catch(() => null));
  // (what such code can't do: change files without the person's OK (its interpreter is the sandboxed runner, and a new
  //  notebook may change none), nor reach a shell or a subprocess)
  const TRY = [
    "import os",
    "r = []",
    "for name, f in [('open', lambda: open('/agent-wrote.txt', 'w').write('x')), ('os.system', lambda: os.system('touch /agent-sys.txt')), ('subprocess', lambda: __import__('subprocess').run(['touch', '/agent-sub.txt'])), ('os.remove', lambda: os.remove('/agent-notes.txt')), ('os.rename', lambda: os.rename('/agent-notes.txt', '/agent-moved.txt'))]:",
    "    try:",
    "        f()",
    "        r.append(name + ': done')",
    "    except BaseException as e:",
    "        r.append(name + ': ' + type(e).__name__)",
    "print('tries:', r)",
  ].join("\n");
  const BANG = "!touch /agent-bang.txt", BASH = "%%bash\ntouch /agent-bash.txt";
  ok(!!(await make("Tries to write", [TRY, BANG, BASH])).ok, "the agent creates a notebook whose code tries to change files");
  ok(await until(`${shownIs("Tries to write")} && ${outOf(TRY)}.includes("tries:")`, 30000), "it opens and runs by itself", await ev(outOf(TRY)).catch(() => null));
  await until(`${outOf(BASH)} !== "null" && ${outOf(BASH)} !== "[]"`, 15000);
  await sleep(3000);
  const tries = await ev(outOf(TRY));
  console.log("     (what its code was told: " + tries.slice(0, 600) + ")");
  const files = await ev(`Promise.all(["/agent-wrote.txt", "/agent-sys.txt", "/agent-sub.txt", "/agent-bang.txt", "/agent-bash.txt", "/agent-moved.txt", "/agent-notes.txt"].map((p) => ${W}.stat(p).then((e) => [p, !!e && !e.trashed], () => [p, false])))`);
  ok(files.filter(([p, there]) => p !== "/agent-notes.txt" && there).length === 0 && files.find(([p]) => p === "/agent-notes.txt")[1], "no file was made, moved or deleted: the workspace is as it was", files);
  ok(/open: PermissionError/.test(tries) && /os\.remove: PermissionError/.test(tries) && /os\.rename: PermissionError/.test(tries), "writing, deleting and moving a file are refused (PermissionError)", tries);
  ok(!/os\.system: done/.test(tries) && !/subprocess: done/.test(tries), "no shell: os.system and subprocess fail", tries);
  ok(/shell commands are not available/.test(await ev(outOf(BANG))) && /shell commands are not available/.test(await ev(outOf(BASH))), "!cmd and %%bash are refused", [await ev(outOf(BANG)), await ev(outOf(BASH))]);
  // (at most once: opened again through the bar's Open after the person moved away, it doesn't run again)
  const ONCE = "import time\nprint('ran at', time.time())";
  ok(!!(await make("Runs once", [ONCE])).ok && await until(`${shownIs("Runs once")} && ${outOf(ONCE)}.includes("ran at")`, 30000), "a notebook that says when it ran: opened, run by itself");
  // (its run's number is drawn a moment after its output: read both once both are there)
  await until(`${nOf(ONCE)} != null`, 10000);
  const ranAt = await ev(outOf(ONCE)), ranN = await ev(nOf(ONCE));
  ok(await fromFiles("Made by the agent.ipynb") && await until(shownIs("Made by the agent"), 15000), "(the person opens another notebook from Files)");
  await ev(`(${barButton("Open Runs once.ipynb")}.click(), true)`);
  ok(await until(shownIs("Runs once"), 15000), "the bar's Open opens it again");
  await sleep(3000);
  ok(await ev(outOf(ONCE)) === ranAt && await ev(nOf(ONCE)) === ranN, "…and it doesn't run again: the same output, the same run", [ranAt, await ev(outOf(ONCE)), ranN, await ev(nOf(ONCE))]);
  // (admitted only as created: held between the open and the run (a test hold, local hosts only), the person's edit
  //  meanwhile means no run)
  await ev(`(window.__agentRunHold = (path) => new Promise((r) => { window.__held = path; window.__heldType = typeof path; window.__release = r; }), true)`);
  const EDITED = "print('edited-first ran')";
  ok(!!(await make("Edited first", [EDITED])).ok && await until(`window.__held === "/Edited first.ipynb" && ${shownIs("Edited first")}`, 15000), "(a new one, held before its run)");
  ok(await typeInto(EDITED, EDITED + "  # the person's"), "(the person edits it meanwhile)");
  await ev("(window.__release(), delete window.__agentRunHold, true)");
  await sleep(3000);
  ok(!(await ev(outOf(EDITED + "  # the person's"))).includes("edited-first ran") && await ev(nOf(EDITED + "  # the person's")) === null, "edited before its run: it doesn't run by itself (Run all is the person's)");
  // (a creation announced twice: spent the first time, never armed again. Held before its admission, the person opens
  //  another notebook, so this first try doesn't run; announced again, nothing happens: not opened, not run)
  await ev(`(window.__agentRunHold = (path) => new Promise((r) => { window.__held = path; window.__heldType = typeof path; window.__release = r; }), true)`);
  const TWICE = "print('announced twice ran')";
  ok(!!(await make("Announced twice", [TWICE])).ok && await until(`window.__held === "/Announced twice.ipynb" && ${shownIs("Announced twice")}`, 15000), "(another, held before its run)");
  ok(await fromFiles("Made by the agent.ipynb") && await until(shownIs("Made by the agent"), 15000), "(the person opens another notebook meanwhile)");
  await ev("(window.__release(), delete window.__agentRunHold, true)");
  await sleep(1000);
  await ev("window.__agentMadeAgain()");
  await sleep(3000);
  ok(await ev(shownIs("Made by the agent")), "the same creation announced again does nothing: not even opened again", { title: await ev("document.title") });
  await ev(`(${barButton("Open Announced twice.ipynb")}.click(), true)`);
  ok(await until(shownIs("Announced twice"), 15000), "(the person opens it from the bar)");
  await sleep(2000);
  ok(!(await ev(outOf(TWICE))).includes("announced twice ran") && await ev(nOf(TWICE)) === null, "…and it doesn't run: a creation's one chance is spent the first time", await ev(outOf(TWICE)));
  // (the tests' handles carry no authority: a hold gets a string, and a forged record and pairing put on the window,
  //  then the replay, run nothing: the replay is of the page's own last announcement, spent)
  ok(await ev("window.__heldType") === "string", "a hold gets the path, a string: never the record or the pairing");
  const editedRef = await ev(`${W}.stat("/Edited first.ipynb").then((e) => e.ref)`);
  await ev(`(window.__agentMadeLast = { c: { op: "forged", path: "/Edited first.ipynb", kind: "notebook", ref: ${JSON.stringify(editedRef)}, grant: "forged" }, p: { mayRunCreated: () => true } }, window.__agentAnnounced = 99, true)`);
  await ev("window.__agentMadeAgain()");
  await sleep(3000);
  ok(await ev(shownIs("Announced twice")) && await ev("window.__agentAnnounced") !== 99, "a forged record and pairing on the window, then the replay: nothing opens, and the count can't be set", { title: await ev("document.title") });
  ok(!(await ev(`${W}.read("/Edited first.ipynb").then((r) => JSON.stringify(r.content.cells.map((c) => c.outputs ?? [])))`)).includes("edited-first ran"), "…nor runs");
  // (what Run all reads includes each cell's metadata: made "Run only by hand" while held before its run, no run)
  await ev(`(window.__agentRunHold = (path) => new Promise((r) => { window.__held = path; window.__heldType = typeof path; window.__release = r; }), true)`);
  const MANUAL = "print('manual ran')";
  ok(!!(await make("Made manual", [MANUAL])).ok && await until(`window.__held === "/Made manual.ipynb" && ${shownIs("Made manual")}`, 15000), "(another, held before its run)");
  await ev(`(() => { const nb = window.sagebrush.notebook; const c = nb.cells().find((c) => c.type !== "markdown" && c.type !== "raw"); nb.setManual(c, true); return true; })()`);
  ok(await until(`!!window.sagebrush.notebook.snapshot().cells[0].metadata?.sagebrush?.manual`, 5000), "(the person makes its cell \"Run only by hand\" meanwhile)");
  await ev("(window.__release(), delete window.__agentRunHold, true)");
  await sleep(3000);
  ok(!(await ev(outOf(MANUAL))).includes("manual ran") && await ev(nOf(MANUAL)) === null, "a cell made manual before its run: it doesn't run by itself");
  // (the package set's pin left out and a null pin differ (no pin: the current set; null: optional packages off): changed
  //  either way while held before its run, no run)
  for (const [name, created, then, what] of [["Pin set null", undefined, null, "no pin, then a null pin"], ["Pin left out", null, undefined, "a null pin, then none"]]) {
    await ev(`(window.__agentRunHold = (path) => new Promise((r) => { window.__held = path; window.__release = r; }), true)`);
    const PIN = `print('${name} ran')`;
    const made = await make(name, [PIN], created === null ? { pkgset: null } : {});
    ok(!!made.ok && await until(`window.__held === "/${name}.ipynb" && ${shownIs(name)}`, 15000), `(another, held before its run: ${what})`, made);
    const has = await ev(`${W}.read("/${name}.ipynb").then((r) => "pkgset" in r.content ? r.content.pkgset : "absent")`);
    if (created === null) ok(has === null, "(created with a null pin)", has); else ok(has === "absent", "(created with no pin)", has);
    await ev(`(window.sagebrush.notebook.setMeta({ pkgset: ${then === null ? "null" : "undefined"} }), true)`);
    ok(await ev(`(() => { const s = window.sagebrush.notebook.snapshot(); return ${then === null ? `s.pkgset === null` : `s.pkgset === undefined`}; })()`), `(the person's page changes the pin meanwhile: ${what})`);
    await ev("(window.__release(), delete window.__agentRunHold, true)");
    await until(`${outOf(PIN)}.includes("${name} ran")`, 8000);
    ok(!(await ev(outOf(PIN))).includes(`${name} ran`) && await ev(nOf(PIN)) === null, `the package set's pin changed before its run (${what}): it doesn't run by itself`);
  }
  // (bound to the creation's own revision, not its time: written again right after it was created, before the page read
  //  it back, it no longer qualifies, though its cells read back are what then runs)
  await ev(`(window.__agentReadHold = () => new Promise((r) => (window.__readGo = r)), true)`);
  const W1 = "print('as created')", W2 = "print('written after')";
  const wmk = await make("Written after", [W1]);
  ok(!!wmk.ok && await until("typeof window.__readGo === 'function'", 10000), "(a new one, held before it is read back)", wmk);
  const wa = await drive({ op: "req", method: "workspace.read", params: { path: (folder === "/" ? "" : folder) + "/Written after.ipynb" } });
  const ww = await drive({ op: "req", method: "workspace.write", params: { path: (folder === "/" ? "" : folder) + "/Written after.ipynb", content: { json: { ...wa.ok.content.json, cells: [{ code: W2 }] } }, base: wa.ok.rev } });
  await ev("(delete window.__agentReadHold, window.__readGo(), true)");
  ok(!!ww.ok && ww.ok.rev === 2, "(the agent writes it again at once: its revision 2)", ww);
  ok(await until(`${shownIs("Written after")} && ${sources}.includes(${JSON.stringify(W2)})`, 15000), "(it opens, as written)");
  await sleep(3000);
  ok(!(await ev(outOf(W2))).includes("written after") && await ev(nOf(W2)) === null, "written after its creation: it doesn't run by itself (its revision isn't the creation's)");
  // (what Run all reads includes the language: changed while held before its run, no run)
  await ev(`(window.__agentRunHold = (path) => new Promise((r) => { window.__held = path; window.__heldType = typeof path; window.__release = r; }), true)`);
  const MODE = "print('mode changed ran')";
  ok(!!(await make("Mode changed", [MODE])).ok && await until(`window.__held === "/Mode changed.ipynb" && ${shownIs("Mode changed")}`, 15000), "(another, held before its run)");
  await ev(`(() => { const was = window.confirm; window.confirm = () => true; const m = document.querySelector("#mode"); m.value = "sage"; m.dispatchEvent(new Event("change", { bubbles: true })); window.confirm = was; return true; })()`);
  ok(await until(`window.sagebrush.notebook.snapshot().mode === "sage"`, 5000), "(the person switches it to Sage meanwhile)");
  await ev("(window.__release(), delete window.__agentRunHold, true)");
  // (long enough for a run to show: the switch to Sage starts its interpreter afresh, which takes some seconds)
  await until(`${outOf(MODE)}.includes("mode changed ran")`, 20000);
  ok(!(await ev(outOf(MODE))).includes("mode changed ran") && await ev(nOf(MODE)) === null, "its language changed before its run: it doesn't run by itself");
  // (running code turned off while held before its run: no run. Last of these: it leaves running code off)
  await ev(`(window.__agentRunHold = (path) => new Promise((r) => { window.__held = path; window.__heldType = typeof path; window.__release = r; }), true)`);
  const OFF = "print('turned-off ran')";
  ok(!!(await make("Run turned off", [OFF])).ok && await until(`window.__held === "/Run turned off.ipynb" && ${shownIs("Run turned off")}`, 15000), "(another, held before its run)");
  await ev(`(${barButton("Turn off running code")}.click(), true)`);
  ok(await until(`!${barButton("Turn off running code")}`, 5000), "(the person turns off running code meanwhile)");
  await ev("(window.__release(), delete window.__agentRunHold, true)");
  await sleep(3000);
  ok(!(await ev(outOf(OFF))).includes("turned-off ran") && await ev(nOf(OFF)) === null, "running code turned off before its run: it doesn't run");
  // (nothing is replayed after a reload: held before its run, the page reloads; the notebook stays as it was. The grant
  //  ends with the page too, so this guards against a replay, not the grant's check)
  await ev(`(window.__agentRunHold = (path) => new Promise(() => { window.__held = path; }), true)`);
  const RELOAD = "print('reloaded ran')";
  ok(!!(await make("Reloaded first", [RELOAD])).ok && await until(`window.__held === "/Reloaded first.ipynb"`, 15000), "(another, held before its run, then the page reloads)");
  const RELOADED = true;

  // a grant "until the page closes" ends with the page
  ok(await go(""), "the page again");
  if (RELOADED) {
    // (directly: after the reload, no creation was announced to this page at all, whatever the grant)
    ok(await ev("window.__agentAnnounced === 0"), "after the reload no creation is announced again: nothing is replayed");
    ok(await fromFiles("Reloaded first.ipynb") && await until(shownIs("Reloaded first"), 15000), "(after the reload, the person opens the one held then)");
    await sleep(3000);
    ok(!(await ev(outOf(RELOAD))).includes("reloaded ran") && await ev(nOf(RELOAD)) === null, "nothing replays after a reload: it never ran");
  }
  const st = await drive({ op: "status" });
  ok(st.ok?.paired === false || st.ok?.granted === false, "the grant ended with the page", st);

  // a reload of the same tab keeps the agent (decided Nov 19 2026): its reload record resumes the pairing, with no new
  // Allow, while the grant lasts, and the agent's next call works; a navigation to the page (above) doesn't
  {
    const cr = await drive({ op: "code" });
    ok(await go(`?pair=${cr.code}&port=${cr.port}`) && await until(`!!document.querySelector(".sbag-box button.primary")`), "(a ?pair= link: Connect)");
    await ev(`(document.querySelector(".sbag-box button.primary").click(), true)`);
    ok(await until(`[...document.querySelectorAll(".sbag-box h2")].some((h) => h.textContent === "Allow this agent?")`), "(paired: Allow this agent?)");
    await ev(`([...document.querySelectorAll(".sbag-box button.primary")].pop().click(), true)`);
    ok(await until(`!!document.querySelector(".sbag-bar")`), "(allowed, with the dialog's defaults: not remembered)");
    await ev("window.__old = 1").catch(() => {});
    await send("Page.reload");
    await sleep(300);
    ok(await until("!window.__old && !!window.sagebrush?.workspace", 60000), "(the tab reloads)");
    ok(await until(`!!document.querySelector(".sbag-bar")`, 20000) && !(await ev(`!!document.querySelector(".sbag-box")`)), "after a reload of the tab, the agent is back by itself: its bar, and no Connect or Allow", await ev(`document.querySelector(".sbag-box")?.textContent ?? ""`).catch(() => ""));
    const lr = await drive({ op: "req", method: "workspace.list", params: { folder: "/" } });
    ok(Array.isArray(lr.ok?.entries), "…and the agent's next call works", JSON.stringify(lr).slice(0, 200));
    // (this tab's record of that live pairing, exactly as the page keeps it)
    const oldRec = await ev(`sessionStorage.getItem("sb-agent-reload-v1")`);
    ok(typeof oldRec === "string" && oldRec.includes('"session"'), "(the tab holds its reload record)");
    // a fresh ?pair= link opened in this tab, a navigation, not a reload: the old record is dropped at load, before
    // anything of the new pairing; then the new Allow cancelled, and the cleaned page reloaded: nothing of the old agent
    // comes back (no restore, no chunk fetched for it, no bar)
    const cn = await drive({ op: "code" });
    ok(await go(`?pair=${cn.code}&port=${cn.port}`) && await until(`!!document.querySelector(".sbag-box button.primary")`), "(another ?pair= link in the same tab: Connect)");
    ok(await ev(`sessionStorage.getItem("sb-agent-reload-v1") === null`), "a ?pair= link opened over a tab's reload record (a navigation): the old record is dropped at load");
    await ev(`([...document.querySelectorAll(".sbag-box button")].find((b) => b.textContent === "Cancel").click(), true)`);
    ok(await until(`!document.querySelector(".sbag-box")`) && !(await ev(`new URLSearchParams(location.search).has("pair")`)), "(Cancel: the dialog closes, and the link is gone from the address)");
    await ev("window.__old = 1").catch(() => {});
    const beforeR = requests.length;
    await send("Page.reload");
    await sleep(300);
    ok(await until("!window.__old && !!window.sagebrush?.workspace", 60000), "(the cleaned page reloads)");
    await sleep(5000);
    const after = { bar: await ev(`!!document.querySelector(".sbag-bar")`), box: await ev(`!!document.querySelector(".sbag-box")`), rec: await ev(`sessionStorage.getItem("sb-agent-reload-v1")`), chunk: requests.slice(beforeR).some(chunk) };
    ok(!after.bar && !after.box && after.rec === null && !after.chunk, "…and a reload after the cancelled Allow: the old agent isn't restored (no bar, no dialog, no chunk fetched, no record)", after);
  }

  // a remembered grant: the next load of the notebook page fetches the chunk by itself and reconnects
  const c1 = await drive({ op: "code" });
  ok(await go(`?pair=${c1.code}&port=${c1.port}`) && await until(`!!document.querySelector(".sbag-box button.primary")`), "another ?pair= link: Connect");
  await ev(`(document.querySelector(".sbag-box button.primary").click(), true)`);
  ok(await until(`[...document.querySelectorAll(".sbag-box h2")].some((h) => h.textContent === "Allow this agent?")`), "the grant dialog asks");
  await ev(`(() => {
    const b = document.querySelector(".sbag-box");
    const all = b.querySelector(".folders input"); if (!all.checked) all.click();
    const byLabel = (re) => [...b.querySelectorAll("label")].find((l) => re.test(l.textContent))?.querySelector("input[type=checkbox]"); const write = byLabel(/may change files/), remember = byLabel(/Remember this agent/);
    if (!write.checked) write.click();
    const s = b.querySelector("select"); s.value = "3600000"; s.dispatchEvent(new Event("change"));
    if (!remember.checked) remember.click();
    return true;
  })()`);
  await ev(`([...document.querySelectorAll(".sbag-box button.primary")].pop().click(), true)`);
  ok(await until(`!!document.querySelector(".sbag-bar")`), "allowed for 1 hour, remembered: the bar shows");
  const beforeR = requests.length;
  ok(await go(""), "the notebook page again, nothing pressed");
  ok(await until(`!!document.querySelector(".sbag-bar")`, 20000) && requests.slice(beforeR).some(chunk), "the remembered agent: the chunk loads by itself and it reconnects", requests.slice(beforeR).filter((u) => /agent/.test(u)));
  ok(await ev(`document.querySelectorAll(".sbag-bar").length`) === 1 && !(await ev(`!!document.querySelector(".sbag-box")`)), "one bar, no dialog");
  // (a page in a frame of this tab while an agent is remembered, as the Agents page's .tex pane can be: it mounts a
  //  pairing of its own (the chunk fetched there), and still leaves the tab's reload record alone, the top page's)
  {
    await ev(`(sessionStorage.setItem("sb-agent-reload-v1", "kept"), true)`);
    const beforeF = requests.length;
    await ev(`(() => { const f = document.createElement("iframe"); f.id = "sbframe2"; f.src = location.pathname; document.body.append(f); return true; })()`);
    const mounted = await until(`document.querySelector("#sbframe2")?.contentDocument?.readyState === "complete"`, 30000);
    const fetched = await (async () => { for (let t = Date.now(); Date.now() - t < 20000; await sleep(200)) if (requests.slice(beforeF).some(chunk)) return true; return false; })();
    await sleep(1500);
    ok(mounted && fetched && await ev(`sessionStorage.getItem("sb-agent-reload-v1") === "kept"`), "a page in a frame of this tab with an agent remembered: it mounts its own pairing, and the tab's reload record is left alone", { mounted, fetched, record: await ev(`sessionStorage.getItem("sb-agent-reload-v1")`) });
    await ev(`(document.querySelector("#sbframe2")?.remove(), sessionStorage.removeItem("sb-agent-reload-v1"), true)`);
    // (the top page paired again, as before the frame: the frame's own pairing may have taken the agent's one socket)
    ok(await go("") && await until(`!!document.querySelector(".sbag-bar")`, 20000), "(the notebook page again, the remembered agent reconnected)");
  }
  await ev(`([...document.querySelectorAll(".sbag-bar button")].find((b) => b.textContent === "Revoke")?.click(), true)`);
  ok(await until(`!document.querySelector(".sbag-bar")`), "Revoke: the bar goes (and the remembered grant with it)");

  // the CLI's own page (window.__SAGEBRUSH_LOCAL__, a page on this computer, which the agent's program doesn't accept):
  // no Agent, and the chunk never fetched
  const localScript = await send("Page.addScriptToEvaluateOnNewDocument", { source: `window.__SAGEBRUSH_LOCAL__ = { path: "local.ipynb", name: "local.ipynb" };` });
  const beforeL = requests.length;
  ok(await go(""), "the page as the CLI serves it (LOCAL)");
  await sleep(3000);
  ok(await ev(`!!window.__SAGEBRUSH_LOCAL__ && document.querySelector("#agentbtn").hidden`) && !requests.slice(beforeL).some(chunk), "LOCAL: Agent isn't offered and the chunk isn't fetched", requests.slice(beforeL).filter((u) => /agent/.test(u)));
  await send("Page.removeScriptToEvaluateOnNewDocument", { identifier: localScript.result.identifier });

  // ⋯ ▸ Connect an agent… (the same pairing; on a phone, where Agent itself is hidden, the way to it)
  ok(await go(""), "the notebook page again");
  ok(await until(`!document.querySelector("#moreagent").hidden`) && await ev(`document.querySelector("#moreagent").textContent`) === "Connect an agent…", "⋯ offers Connect an agent…");
  await ev(`(document.querySelector("#morebtn").click(), document.querySelector("#moreagent").click(), true)`);
  ok(await until(`!!document.querySelector(".sbag-box")`) && await ev(`document.querySelector("#moremenu").hidden`), "it opens Connect, and the menu closes");
  await ev(`([...document.querySelectorAll(".sbag-box button")].find((b) => b.textContent === "Cancel").click(), true)`);
  ok(await until(`!document.querySelector(".sbag-box")`), "Cancel closes it");

  // the code page (/?code=<fid>): no pairing of its own, the page's, from File ▸ Connect an agent…; a remembered agent
  // reconnects there too
  const pyFid = await ev(`${W}.create("/agent-code.py", { content: new TextEncoder().encode("print(1)\\n") }).then((e) => e.fid)`);
  // (and a reload record left in this tab, as a paired page leaves one when it's left: this navigation is no reload, so
  //  the record is dropped where it's read, and the chunk isn't fetched for it)
  await ev(`(sessionStorage.setItem("sb-agent-reload-v1", JSON.stringify({ v: 1, left: Date.now() })), true)`);
  const beforeC = requests.length;
  ok(typeof pyFid === "string" && await go(`?code=${encodeURIComponent(pyFid)}`) && await until(`!!document.querySelector('.code-filemenu [data-f="c-agent"]')`), "the code page's File menu offers Connect an agent…");
  ok(!requests.slice(beforeC).some(chunk) && await ev(`document.querySelector("#agentbtn").hidden`), "nothing fetched before it's wanted, and the notebook's Agent isn't shown over it");
  ok(await ev(`sessionStorage.getItem("sb-agent-reload-v1") === null`), "a reload record met on a navigation that isn't a reload: dropped, and nothing fetched for it");
  // (a page in a frame of this tab, as the Agents page's .tex pane is: it shares the tab's sessionStorage, and the record
  //  is the top page's: left alone)
  await ev(`(sessionStorage.setItem("sb-agent-reload-v1", "kept"), true)`);
  await ev(`(() => { const f = document.createElement("iframe"); f.id = "sbframe"; f.src = "?code=" + ${JSON.stringify(encodeURIComponent(pyFid))}; document.body.append(f); return true; })()`);
  const framed = await until(`document.querySelector("#sbframe")?.contentDocument?.readyState === "complete" && !!document.querySelector("#sbframe").contentWindow.sagebrush?.workspace`, 30000);
  await sleep(1500);
  ok(framed && await ev(`sessionStorage.getItem("sb-agent-reload-v1") === "kept"`), "a page in a frame of this tab (as the Agents page's .tex pane): the tab's reload record is left alone", { framed });
  await ev(`(document.querySelector("#sbframe")?.remove(), sessionStorage.removeItem("sb-agent-reload-v1"), true)`);
  // (a ?pair= link on the code page whose chunk can't load: said in the code page's own status line; board's N1 on #935)
  const cf = await drive({ op: "code" });
  await send("Network.setCacheDisabled", { cacheDisabled: true });
  await send("Fetch.enable", { patterns: [{ urlPattern: "*sagebrush-agent.js*" }] });
  failChunk = true;
  ok(await go(`?code=${encodeURIComponent(pyFid)}&pair=${cf.code}&port=${cf.port}`) && await until(`(document.querySelector(".code-status")?.textContent ?? "") === "Couldn't load the agent connection. Choose Connect an agent… again, or reload the page."`, 20000), "a ?pair= link on the code page whose chunk can't load: the code page's status line says so", await ev(`document.querySelector(".code-status")?.textContent ?? null`).catch(() => null));
  failChunk = false;
  await send("Fetch.disable");
  await send("Network.setCacheDisabled", { cacheDisabled: false });
  ok(await go(`?code=${encodeURIComponent(pyFid)}`) && await until(`!!document.querySelector('.code-filemenu [data-f="c-agent"]')`), "(the code page again)");
  await ev(`(document.querySelector('.code-filemenu [data-f="c-agent"]').click(), true)`);
  ok(await until(`!!document.querySelector(".sbag-box")`) && requests.slice(beforeC).some(chunk), "it fetches the page's chunk and opens Connect");
  const c3 = await drive({ op: "code" });
  ok(await go(`?code=${encodeURIComponent(pyFid)}&pair=${c3.code}&port=${c3.port}`) && await until(`[...document.querySelectorAll(".sbag-box input")].some((i) => i.value === ${JSON.stringify(c3.code)})`), "a ?pair= link on the code page: Connect, its code filled in");
  await ev(`(document.querySelector(".sbag-box button.primary").click(), true)`);
  ok(await until(`[...document.querySelectorAll(".sbag-box h2")].some((h) => h.textContent === "Allow this agent?")`), "the grant dialog asks");
  await ev(`(() => {
    const b = document.querySelector(".sbag-box");
    const all = b.querySelector(".folders input"); if (!all.checked) all.click();
    const byLabel = (re) => [...b.querySelectorAll("label")].find((l) => re.test(l.textContent))?.querySelector("input[type=checkbox]"); const write = byLabel(/may change files/), remember = byLabel(/Remember this agent/);
    if (!write.checked) write.click();
    const s = b.querySelector("select"); s.value = "3600000"; s.dispatchEvent(new Event("change"));
    if (!remember.checked) remember.click();
    return true;
  })()`);
  await ev(`([...document.querySelectorAll(".sbag-box button.primary")].pop().click(), true)`);
  ok(await until(`!!document.querySelector(".sbag-bar")`), "allowed, remembered: the bar shows on the code page");
  ok(await until(`${BAR_CLEAR} === true`, 5000), "the code page: the agent's bar is in its own row, over nothing the person types in or reads", await ev(BAR_CLEAR).catch((e) => String(e)));
  ok(await go(`?code=${encodeURIComponent(pyFid)}`) && await until(`!!document.querySelector(".sbag-bar")`, 20000), "the code page again: the remembered agent reconnects by itself");
  ok(await ev(`document.querySelectorAll(".sbag-bar").length`) === 1 && !(await ev(`!!document.querySelector(".sbag-box")`)), "one bar, no dialog");
  await ev(`([...document.querySelectorAll(".sbag-bar button")].find((b) => b.textContent === "Revoke")?.click(), true)`);
  ok(await until(`!document.querySelector(".sbag-bar")`), "Revoke: the bar goes");

  // (grader's rows on #935 r2) the code page's File ▸ Connect an agent…: the menu closes, Cancel gives the focus back to
  // File; with the chunk's fetch failing, the code page's status line says so
  const fileBtn = `document.querySelector(".code-menu-wrap > button")`;
  ok(await go(`?code=${encodeURIComponent(pyFid)}`) && await until(`!!document.querySelector('.code-filemenu [data-f="c-agent"]')`), "(the code page)");
  await ev(`(${fileBtn}.click(), document.querySelector('.code-filemenu [data-f="c-agent"]').click(), true)`);
  ok(await until(`!!document.querySelector(".sbag-box")`) && await ev(`document.querySelector(".code-filemenu").hidden`), "File ▸ Connect an agent… opens Connect, and the File menu closes");
  await ev(`([...document.querySelectorAll(".sbag-box button")].find((b) => b.textContent === "Cancel").click(), true)`);
  ok(await until(`!document.querySelector(".sbag-box") && document.activeElement === ${fileBtn}`), "Cancel closes it, and the focus goes back to File");
  await send("Network.setCacheDisabled", { cacheDisabled: true });
  ok(await go(`?code=${encodeURIComponent(pyFid)}`) && await until(`!!document.querySelector('.code-filemenu [data-f="c-agent"]')`), "(the code page, afresh)");
  await send("Fetch.enable", { patterns: [{ urlPattern: "*sagebrush-agent.js*" }] });
  failChunk = true;
  await ev(`(${fileBtn}.click(), document.querySelector('.code-filemenu [data-f="c-agent"]').click(), true)`);
  ok(await until(`(document.querySelector(".code-status")?.textContent ?? "") === "Couldn't load the agent connection. Choose Connect an agent… again, or reload the page."`, 20000) && !(await ev(`!!document.querySelector(".sbag-box")`)), "File ▸ Connect an agent… with the chunk's fetch failing: the code page's status line says so", await ev(`document.querySelector(".code-status")?.textContent ?? null`).catch(() => null));
  failChunk = false;
  await send("Fetch.disable");
  await send("Network.setCacheDisabled", { cacheDisabled: false });
  // (the desktop app (window.__TAURI__): the code page offers no Connect an agent…, and a ?pair= link mounts nothing)
  const ct = await drive({ op: "code" });
  // (a stand-in for the app's bridge, enough for the page to start: no startup files, no self-test, no events)
  const tauri = await send("Page.addScriptToEvaluateOnNewDocument", { source: `window.__TAURI__ = { core: { invoke: async (c) => (c === "startup_files" ? [] : null) }, event: { listen: async () => () => {} }, window: { getCurrentWindow: () => ({ setTitle: async () => {} }) }, fs: {}, dialog: {} };` });
  ok(await go(`?code=${encodeURIComponent(pyFid)}&pair=${ct.code}&port=${ct.port}`) && await until(`!!window.sagebrush?.code`, 30000), "(the code page in the desktop app, with a ?pair= link)");
  await sleep(3000);
  ok(!(await ev(`!!document.querySelector('.code-filemenu [data-f="c-agent"]') || !!document.querySelector(".sbag-box") || !!document.querySelector(".sbag-bar")`)), "the desktop app: the code page offers no Connect an agent…, and its ?pair= link mounts nothing");
  await send("Page.removeScriptToEvaluateOnNewDocument", { identifier: tauri.result.identifier });
  // (the notebook page on a phone, where Agent is hidden: ⋯ ▸ Connect an agent…, and Cancel gives the focus back to ⋯)
  ok(await go("?phone=1") && await until(`document.documentElement.classList.contains("phone") && !document.querySelector("#moreagent").hidden && !document.querySelector("#agentbtn").offsetParent`), "(the notebook page on a phone: Agent hidden, ⋯ offers Connect an agent…)");
  await ev(`(document.querySelector("#morebtn").click(), document.querySelector("#moreagent").click(), true)`);
  ok(await until(`!!document.querySelector(".sbag-box")`), "on a phone, ⋯ ▸ Connect an agent… opens Connect");
  await ev(`([...document.querySelectorAll(".sbag-box button")].find((b) => b.textContent === "Cancel").click(), true)`);
  ok(await until(`!document.querySelector(".sbag-box") && document.activeElement === document.querySelector("#morebtn")`), "…and Cancel gives the focus back to ⋯ (Agent isn't shown)");
  ok(await go("?phone=0"), "(the phone layout off again)");

  // ---- one pairing per page, in a build with the LaTeX editor
  // (the editor opens on this host only in a build made with SAGEBRUSH_LATEX_PREVIEW=test, as CI's web-browser/latex)
  const fid = await ev(`${W}.create("/paper.tex", { content: new TextEncoder().encode("Hello.\\n") }).then((e) => e.fid)`);
  const texOn = typeof fid === "string" && await go(`?tex=${encodeURIComponent(fid)}&latex=1`) && await until(`!!document.querySelector(".tex-agent")`, 30000);
  if (process.env.EXPECT_LATEX === "1") ok(texOn, "LaTeX build: the LaTeX editor opens, so the checks below run (none skipped)");
  if (texOn) {
    const c2 = await drive({ op: "code" });
    const before = requests.length;
    ok(await go(`?tex=${encodeURIComponent(fid)}&latex=1&pair=${c2.code}&port=${c2.port}`), "an early ?pair= link on /?tex= opens the LaTeX editor");
    ok(await until(`!!document.querySelector(".tex-agent") && !!document.querySelector(".sbag-box button.primary")`), "its Connect dialog shows");
    ok(await ev(`[...document.querySelectorAll(".sbag-box input")].some((i) => i.value === ${JSON.stringify(c2.code)})`) && await ev(`document.querySelectorAll(".sbag-box").length`) === 1, "one dialog, with the link's code: the link went to the LaTeX editor");
    const since = () => requests.slice(before);
    ok(since().some((u) => /sagebrush-latex-agent\.js/.test(u)) && !since().some(chunk), "only the LaTeX editor's agent chunk is fetched, not the notebook page's", since().filter((u) => /agent/.test(u)));
    ok(await ev(`document.querySelector("#agentbtn")?.hidden !== false`), "the notebook page's Agent isn't offered over the LaTeX editor");
    await ev(`(document.querySelector(".sbag-box button.primary").click(), true)`);
    ok(await until(`[...document.querySelectorAll(".sbag-box h2")].some((h) => h.textContent === "Allow this agent?")`), "paired from the LaTeX editor: the grant dialog asks");
    // (Everything, read and write, for 1 hour, remembered)
    await ev(`(() => {
      const b = document.querySelector(".sbag-box");
      const all = b.querySelector(".folders input"); if (!all.checked) all.click();
      const byLabel = (re) => [...b.querySelectorAll("label")].find((l) => re.test(l.textContent))?.querySelector("input[type=checkbox]"); const write = byLabel(/may change files/), remember = byLabel(/Remember this agent/);
      if (!write.checked) write.click();
      const s = b.querySelector("select"); s.value = "3600000"; s.dispatchEvent(new Event("change"));
      if (!remember.checked) remember.click();
      return true;
    })()`);
    await ev(`([...document.querySelectorAll(".sbag-box button.primary")].pop().click(), true)`);
    ok(await until(`!!document.querySelector(".sbag-bar")`), "allowed, remembered: the bar shows");
    ok(await until(`${BAR_CLEAR} === true`, 5000), "the LaTeX editor: the agent's bar is in its own row, over nothing the person types in or reads", await ev(BAR_CLEAR).catch((e) => String(e)));
    // the remembered grant, on the next load of /?tex=: reconnected once, by the LaTeX editor
    const before2 = requests.length;
    ok(await go(`?tex=${encodeURIComponent(fid)}&latex=1`), "the LaTeX editor again (the agent remembered)");
    ok(await until(`!!document.querySelector(".sbag-bar")`, 20000), "the remembered agent reconnects", await ev(`document.querySelector(".sbag-box")?.textContent ?? ""`).catch(() => ""));
    await sleep(1500);
    const since2 = requests.slice(before2);
    ok(since2.some((u) => /sagebrush-latex-agent\.js/.test(u)) && !since2.some(chunk), "only the LaTeX editor's agent chunk is fetched", since2.filter((u) => /agent/.test(u)));
    ok(await ev(`document.querySelectorAll(".sbag-bar").length`) === 1 && !(await ev(`!!document.querySelector(".sbag-box")`)), "one bar, and no Connect dialog");
    await ev(`(document.querySelector(".tex-agent").click(), true)`);
    await sleep(500);
    ok(await ev(`document.querySelectorAll(".sbag-bar").length`) === 1 && !(await ev(`!!document.querySelector(".sbag-box")`)), "the editor's Agent shows that one bar, not an empty Connect");
    await ev(`([...document.querySelectorAll(".sbag-bar button")].find((b) => b.textContent === "Revoke")?.click(), true)`);
  }

  // the person's request first, as Claude Code makes it ("draw a plot of sin(x^2)" before anything is connected):
  // the agent's first call isn't workspace_connect, and its answer is the one link (code and port in it, nothing to
  // find in a menu, decided Nov 19 2026); the person opens it, presses Connect and Allow while the agent waits in
  // workspace_connect, and the agent's next call makes the notebook, shown on the page
  {
    // (a fresh start: nothing remembered from the cases above)
    await send("Storage.clearDataForOrigin", { origin, storageTypes: "all" });
    const nb = { path: "/sin x squared.ipynb", mode: "sage", content: { json: { cells: [{ code: "plot(sin(x^2), (x, -3, 3))" }] } } };
    const r1 = await tool("workspace_create", nb);
    const links = [...r1.text.matchAll(/https?:\/\/[^\s]+\/board\/\?pair=([A-Z0-9]+)&port=(\d+)/g)];
    ok(r1.isError && r1.structured?.error?.code === "not_connected" && links.length === 1, "the agent's first call, unpaired: not_connected, with one link in it", r1.text);
    ok(!/menu|⋯|Agent button|by hand/.test(r1.text) && /Connect, then Allow/.test(r1.text), "...and no menu directions, no code to type: open the link, Connect, Allow", r1.text);
    const r2 = await tool("workspace_list", { folder: "/" });
    ok(r2.text.includes(links[0][0]), "the next call before the person acts: the same link", r2.text);
    const waited = tool("workspace_connect", { wait: 60 });
    ok(links[0][0].startsWith(origin + "/board/?pair="), "(the link is to this site: SAGEBRUSH_MCP_DEV_ORIGIN)", links[0][0]);
    // (the person opens the link, as the agent gave it)
    await ev("window.__old = 1").catch(() => {});
    await send("Page.navigate", { url: links[0][0] });
    await sleep(300);
    ok(await until(`!window.__old && location.pathname === "/" && [...document.querySelectorAll(".sbag-box input")].some((i) => i.value === ${JSON.stringify(links[0][1])})`, 60000), "the link opens Connect on the notebook page, its code filled in, no port to type", await ev(`document.querySelector(".sbag-box")?.textContent ?? location.href`).catch(() => ""));
    ok(await ev(`document.querySelectorAll(".sbag-box input").length`) === 1, "one field in Connect");
    await ev(`(document.querySelector(".sbag-box button.primary").click(), true)`);
    ok(await until(`[...document.querySelectorAll(".sbag-box h2")].some((h) => h.textContent === "Allow this agent?")`), "paired: the grant dialog asks", await ev(`document.querySelector(".sbag-box .err")?.textContent ?? ""`).catch(() => ""));
    await ev(`([...document.querySelectorAll(".sbag-box button.primary")].pop().click(), true)`);
    ok(await until(`!!document.querySelector(".sbag-bar")`), "allowed (the dialog's defaults): the bar shows the agent");
    const r3 = await waited;
    ok(!r3.isError && r3.structured?.result?.paired && r3.structured?.result?.granted, "workspace_connect with wait returns once the person has allowed", r3.text);
    const r4 = await tool("workspace_create", nb);
    ok(!r4.isError && r4.structured?.result?.entry?.path === nb.path, "the agent's request goes on: the notebook is made", r4.text);
    ok(await until(`${shownPath}.then((p) => p === ${JSON.stringify(nb.path)})`, 20000), "the page shows it", await ev(shownPath).catch(() => ""));
    await shot("9-first-call-link");
  }
} catch (e) {
  ok(false, "threw: " + (e?.stack ?? e));
} finally {
  try { py.kill(); } catch {}
  try { mcp.kill(); } catch {}
  try { chrome.kill(); } catch {}
  try { server.kill(); } catch {}
  await sleep(300);
  rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
}
console.log(failures ? `FAIL: ${failures} of ${checks}` : `ok: an agent paired with the notebook page, ${checks} checks`);
process.exit(failures ? 1 : 0);
