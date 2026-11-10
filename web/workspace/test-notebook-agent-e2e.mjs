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

  // a grant "until the page closes" ends with the page
  ok(await go(""), "the page again");
  const st = await drive({ op: "status" });
  ok(st.ok?.paired === false || st.ok?.granted === false, "the grant ended with the page", st);

  // a remembered grant: the next load of the notebook page fetches the chunk by itself and reconnects
  const c1 = await drive({ op: "code" });
  ok(await go(`?pair=${c1.code}&port=${c1.port}`) && await until(`!!document.querySelector(".sbag-box button.primary")`), "another ?pair= link: Connect");
  await ev(`(document.querySelector(".sbag-box button.primary").click(), true)`);
  ok(await until(`[...document.querySelectorAll(".sbag-box h2")].some((h) => h.textContent === "Allow this agent?")`), "the grant dialog asks");
  await ev(`(() => {
    const b = document.querySelector(".sbag-box");
    const all = b.querySelector(".folders input"); if (!all.checked) all.click();
    const [write, remember] = [...b.querySelectorAll("input[type=checkbox]")].filter((c) => !c.closest(".folders"));
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
  const beforeC = requests.length;
  ok(typeof pyFid === "string" && await go(`?code=${encodeURIComponent(pyFid)}`) && await until(`!!document.querySelector('.code-filemenu [data-f="c-agent"]')`), "the code page's File menu offers Connect an agent…");
  ok(!requests.slice(beforeC).some(chunk) && await ev(`document.querySelector("#agentbtn").hidden`), "nothing fetched before it's wanted, and the notebook's Agent isn't shown over it");
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
    const [write, remember] = [...b.querySelectorAll("input[type=checkbox]")].filter((c) => !c.closest(".folders"));
    if (!write.checked) write.click();
    const s = b.querySelector("select"); s.value = "3600000"; s.dispatchEvent(new Event("change"));
    if (!remember.checked) remember.click();
    return true;
  })()`);
  await ev(`([...document.querySelectorAll(".sbag-box button.primary")].pop().click(), true)`);
  ok(await until(`!!document.querySelector(".sbag-bar")`), "allowed, remembered: the bar shows on the code page");
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
      const [write, remember] = [...b.querySelectorAll("input[type=checkbox]")].filter((c) => !c.closest(".folders"));
      if (!write.checked) write.click();
      const s = b.querySelector("select"); s.value = "3600000"; s.dispatchEvent(new Event("change"));
      if (!remember.checked) remember.click();
      return true;
    })()`);
    await ev(`([...document.querySelectorAll(".sbag-box button.primary")].pop().click(), true)`);
    ok(await until(`!!document.querySelector(".sbag-bar")`), "allowed, remembered: the bar shows");
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
