// ci: web-runner order=182 chrome
// ci: web-browser/latex order=47 chrome env=EXPECT_LATEX=1
// An agent's runs of code on the Agents page (/agents/), end to end: the page (web/dist, served by web/serve.py with
// the site's headers: cross-origin isolated, its CSP) and the REAL pairing server (engine/py/python/sagebrush/
// pairing.py, as sagebrush-mcp runs it), paired as a person pairs it (a ?pair= link, Connect, the grant dialog with
// May run code). The same verbs as the notebook page's (workspace/agent-runs.ts), under the same grant:
//   - run_file: a Python file's output and exit status;
//   - run_notebook: each cell's result;
//   - latex_build (in a build with the LaTeX editor; EXPECT_LATEX=1 must have it): the report and the first page as a
//     PNG, with its SageTeX item run; without the editor, refused as "no LaTeX";
//   - run_stop with nothing running: { stopped: false };
//   - with May run code off: every run is refused, nothing run.
//   bun web/build.ts && CHROME=chromium node web/agents/test-agents-run-verbs.mjs
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { devtoolsPort } from "../test-port.mjs";

const here = new URL(".", import.meta.url).pathname;
const LATEX = existsSync(join(here, "..", "dist", "sagebrush-latex.js"));
if (process.env.EXPECT_LATEX === "1" && !LATEX) throw new Error("EXPECT_LATEX=1 but this web/dist has no sagebrush-latex.js");
let failures = 0, checks = 0;
const ok = (c, msg, detail) => { checks++; console.log((c ? "ok   " : "FAIL ") + msg + (c || detail === undefined ? "" : " " + JSON.stringify(detail).slice(0, 600))); if (!c) failures++; };
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
            print(json.dumps({"ok": p.request(m["method"], m["params"], timeout=m.get("timeout", 10))}), flush=True)
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
const req = (method, params, timeout = 10) => drive({ op: "req", method, params, timeout });
py.on("exit", (c) => { for (const w of waiters.splice(0)) w({ exited: c }); });
const first = await Promise.race([next(), sleep(15000).then(() => ({ exited: "no code in 15 s" }))]);
if (!first.port) { console.log("FAIL the pairing server didn't start: " + JSON.stringify(first)); try { py.kill(); } catch {} server.kill(); process.exit(1); }

// ---- Chromium
let cdp = Number(process.env.CDP_PORT) || 0;
const profile = mkdtempSync(join(tmpdir(), "sb-agents-runs-"));
// (no back/forward cache: a page navigated away from is gone, its workspace and its socket closed, not kept for Back)
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--disable-features=BackForwardCache", `--remote-debugging-port=${cdp}`, "--window-size=1400,900", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
try {
  if (!cdp) cdp = await devtoolsPort(profile);
  let targets;
  for (let i = 0; i < 300; i++) { try { targets = await (await fetch(`http://127.0.0.1:${cdp}/json`)).json(); break; } catch { await sleep(100); } }
  const sock = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
  await new Promise((r) => (sock.onopen = r));
  let n = 0;
  const waiting = new Map(), console_ = [];
  sock.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
    if (m.method === "Log.entryAdded" || m.method === "Runtime.consoleAPICalled") console_.push(JSON.stringify(m.params).slice(0, 300));
  };
  const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); sock.send(JSON.stringify({ id, method, params })); });
  const ev = async (expr) => { const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }); if (!r.result || r.result.exceptionDetails) throw new Error(JSON.stringify(r.result?.exceptionDetails ?? r.error ?? r).slice(0, 400)); return r.result.result?.value; };
  const until = async (expr, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr).catch(() => false)) return true; await sleep(100); } return false; };
  for (const m of ["Page.enable", "Runtime.enable", "Log.enable"]) await send(m);

  /** Pair the Agents page from a ?pair= link: Connect, then the grant (Everything, may change files, May run code as
   * asked, until the page closes). */
  const pair = async (c, run) => {
    await send("Page.navigate", { url: `${origin}/agents/?pair=${c.code}&port=${c.port}` });
    ok(await until(`!!document.querySelector(".sbag-box button.primary")`, 90000), "the Agents page opens the Connect dialog from the ?pair= link", { console: console_.slice(-5), page: await ev(`document.body?.innerText?.slice(0, 300) ?? ""`).catch(() => null) });
    await ev(`(document.querySelector(".sbag-box button.primary").click(), true)`);
    ok(await until(`[...document.querySelectorAll(".sbag-box h2")].some((h) => h.textContent === "Allow this agent?")`), "paired: the grant dialog asks the person", { err: await ev(`document.querySelector(".sbag-box .err")?.textContent ?? ""`).catch(() => "") });
    await ev(`(() => {
      const b = document.querySelector(".sbag-box");
      const all = b.querySelector(".folders input"); if (!all.checked) all.click();
      const box = (t) => [...b.querySelectorAll("label")].find((l) => l.textContent.includes(t))?.querySelector("input");
      const write = box("may change files"); if (!write.checked) write.click();
      const runs = box("May run code"); if (runs.checked !== ${!!run}) runs.click();
      const s = b.querySelector("select"); s.value = "page"; s.dispatchEvent(new Event("change"));
      return true;
    })()`);
    await ev(`([...document.querySelectorAll(".sbag-box button.primary")].pop().click(), true)`);
    ok(await until(`!!document.querySelector(".sbag-bar")`), "allowed: the bar shows the agent" + (run ? ", may run code" : ", not running code"));
    ok(await ev(`document.querySelector(".sbag-bar").textContent.includes("may run code")`) === !!run, "the bar says what the grant allows", await ev(`document.querySelector(".sbag-bar").textContent`));
    // (W4: a compact chip; its menu holds the controls: opened by click or keyboard on its first control, ↓ ↑ move,
    //  Escape closes it back on the chip; Revoke in it, one click away)
    const chip = await ev(`(() => { const c = document.querySelector(".sbag-bar button.chip"), m = document.querySelector(".sbag-bar .menu");
      return c && m ? { popup: c.getAttribute("aria-haspopup"), exp: c.getAttribute("aria-expanded"), text: c.textContent, menuShown: getComputedStyle(m).display !== "none",
        items: [...m.querySelectorAll("[role=menuitem]")].map((b) => b.textContent) } : null; })()`);
    ok(chip?.popup === "menu" && chip.exp === "false" && !chip.menuShown && chip.text.includes(run ? "can edit · can run code" : "can edit") && (run || !chip.text.includes("run code")) && JSON.stringify(chip.items) === JSON.stringify(run ? ["Turn off running code", "Revoke"] : ["Revoke"]),
      "W4: the bar is a compact chip, its menu closed, holding the controls (Revoke last)", chip);
    const fullLine = await ev(`document.querySelector(".sbag-bar .menu .full")?.textContent ?? ""`);
    ok(/^\S.* on your computer: can read and write everywhere · /.test(fullLine) && fullLine.includes("may run code") === !!run && !fullLine.includes("as it says"), "W4: the menu's first line says what the agent is and what it may do", fullLine);
    const opened = await ev(`(() => { const c = document.querySelector(".sbag-bar button.chip"); c.focus(); c.click();
      const m = document.querySelector(".sbag-bar .menu");
      return { exp: c.getAttribute("aria-expanded"), shown: getComputedStyle(m).display !== "none", focus: document.activeElement?.textContent }; })()`);
    ok(opened.exp === "true" && opened.shown && opened.focus === (run ? "Turn off running code" : "Revoke"), "W4: opening the chip shows its menu, focus on its first control", opened);
    const moved = await ev(`(() => { const k = (key) => document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
      k("ArrowDown"); const a = document.activeElement?.textContent; k("ArrowUp"); const b = document.activeElement?.textContent; k("Escape");
      const c = document.querySelector(".sbag-bar button.chip");
      return { a, b, closed: c.getAttribute("aria-expanded") === "false" && getComputedStyle(document.querySelector(".sbag-bar .menu")).display === "none", back: document.activeElement === c }; })()`);
    ok(moved.a === "Revoke" && moved.b === (run ? "Turn off running code" : "Revoke") && moved.closed && moved.back, "W4: ↓ and ↑ move in the menu; Escape closes it, focus back on the chip", moved);
    const keyOpen = await ev(`(() => { const c = document.querySelector(".sbag-bar button.chip"); c.focus(); c.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
      const r = { exp: c.getAttribute("aria-expanded"), focus: document.activeElement?.textContent };
      document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); return r; })()`);
    ok(keyOpen.exp === "true" && keyOpen.focus === (run ? "Turn off running code" : "Revoke"), "W4: ↓ on the chip opens its menu too", keyOpen);
    // (the menu open, focus in it, and the agent changes a file: the counts change in place, the menu stays open, the
    //  focus where it was; a held Enter never repeats onto a control; Home, End; the menu within the window; the live
    //  region says the summary only)
    await ev(`(() => { const c = document.querySelector(".sbag-bar button.chip"); c.focus(); c.click(); const k = (key) => document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })); k("End"); window.__w4item = document.activeElement; return true; })()`);
    const before = await ev(`document.querySelector(".sbag-bar button.chip").textContent`);
    ok(!!(await req("workspace.create", { path: `/w4-count-${run ? "run" : "norun"}.txt`, content: { text: "x" } })).ok, "(the agent writes a file while the menu is open)");
    ok(await until(`document.querySelector(".sbag-bar button.chip").textContent !== ${JSON.stringify(before)}`), "W4: the chip's count moves");
    const kept = await ev(`(() => { const same = document.activeElement === window.__w4item && window.__w4item.isConnected;
      const c = document.querySelector(".sbag-bar button.chip"), m = document.querySelector(".sbag-bar .menu"), r = m.getBoundingClientRect();
      const rep = new KeyboardEvent("keydown", { key: "Enter", repeat: true, bubbles: true, cancelable: true }); document.activeElement.dispatchEvent(rep);
      const home = (document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true })), document.activeElement?.textContent);
      return { same, open: c.getAttribute("aria-expanded") === "true", focus: document.activeElement?.getAttribute("role"), repeatStopped: rep.defaultPrevented, home,
        inWindow: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight,
        live: [...document.querySelectorAll(".sbag-bar [role=status]")].map((e) => e.textContent), statusWrapsMenu: !!document.querySelector(".sbag-bar[role=status], [role=status] [role=menu]") }; })()`);
    ok(kept.same && kept.open && kept.focus === "menuitem" && kept.repeatStopped && kept.home === (run ? "Turn off running code" : "Revoke") && kept.inWindow && kept.live.length === 1 && kept.live[0].includes("change") && !kept.statusWrapsMenu,
      "W4: counts change in place (the same focused control, the menu open); a repeated Enter is stopped; Home; the menu within the window; the live region is the summary only", kept);
    await ev(`(document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })), true)`);
  };

  // ---- a grant with May run code: every run verb works here
  await pair(first, true);
  const isolated = await ev(`globalThis.crossOriginIsolated === true`);
  ok(isolated, "the Agents page is cross-origin isolated (the site's headers), so the sandboxed runner can be had");

  ok(!!(await req("workspace.create", { path: "/agent-run.py", content: { text: "print('hi', 6 * 7)\n" } })).ok, "the agent creates a Python file");
  let r = (await req("workspace.run_file", { path: "/agent-run.py", timeout_s: 120 }, 180)).ok;
  ok(r?.ok === true && r.ended === "done" && r.exit === 0 && r.stdout === "hi 42\n", "run_file on the Agents page: its output and exit 0", r);

  const nb = { nbformat: 4, nbformat_minor: 5, metadata: { kernelspec: { name: "python3", display_name: "Python 3", language: "python" } },
    cells: [{ id: "c1", cell_type: "code", source: "x = 20 + 1\nprint(x * 2)", metadata: {}, outputs: [], execution_count: null }] };
  ok(!!(await req("workspace.create", { path: "/agent-run.ipynb", content: { json: nb } })).ok, "the agent creates a notebook");
  r = (await req("workspace.run_notebook", { path: "/agent-run.ipynb", timeout_s: 120 }, 180)).ok;
  ok(r?.cells?.[0]?.status === "ok" && r.cells[0].out === "42\n", "run_notebook on the Agents page: each cell's result", r);

  ok(!!(await req("workspace.create", { path: "/agent-run.tex", content: { text: "\\documentclass{article}\n\\usepackage{sagetex}\n\\begin{document}\nTwo and two: $\\sage{2 + 2}$.\n\\end{document}\n" } })).ok, "the agent creates a SageTeX .tex");
  const b = await req("workspace.latex_build", { path: "/agent-run.tex", timeout_s: 120 }, 180);
  if (LATEX) {
    r = b.ok;
    ok(r?.ok === true && r.ended === "done" && r.report?.ok === true && r.sagetex?.ran === 1 && r.sagetex.failed === 0, "latex_build on the Agents page: built, its SageTeX item run", b);
    ok(r?.pages?.length >= 1 && typeof r.pages[0].png === "string" && Buffer.from(r.pages[0].png, "base64").subarray(0, 4).toString("latin1") === "\x89PNG", "latex_build: its first page as a PNG", r?.pages?.map((p) => [p.n, p.w]));
  } else ok(b.err?.code && /no LaTeX/.test(b.err.message ?? ""), "latex_build in a build without the LaTeX editor: refused (no LaTeX)", b);

  r = (await req("workspace.run_stop", {})).ok;
  ok(r?.stopped === false, "run_stop with nothing running: not stopped", r);

  // ---- a grant without May run code: the runs are refused, nothing run
  // (the first pairing ended by the person, Revoke on its bar, and the agent told so, before the next one: one page is
  //  paired with an agent at a time. A navigation away isn't relied on: when the browser closes the old page's socket
  //  is its own business, as a page kept for Back may keep it open)
  // (W4: Turn off running code from the open menu, by keyboard: the chip is drawn again without it, the menu stays open,
  //  the focus on the control that is left)
  const off = await ev(`(async () => { const c = document.querySelector(".sbag-bar button.chip"); c.focus(); c.click();
    document.activeElement.click(); // (its first control, Turn off running code)
    for (let i = 0; i < 50 && [...document.querySelectorAll(".sbag-bar [role=menuitem]")].some((b) => b.textContent === "Turn off running code"); i++) await new Promise((r) => setTimeout(r, 100));
    const items = [...document.querySelectorAll(".sbag-bar [role=menuitem]")].map((b) => b.textContent);
    const r = { items, open: document.querySelector(".sbag-bar button.chip").getAttribute("aria-expanded"), focus: document.activeElement?.textContent };
    document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); return r; })()`);
  ok(JSON.stringify(off.items) === JSON.stringify(["Revoke"]) && off.open === "true" && off.focus === "Revoke", "W4: after Turn off running code the menu stays open, the focus on the control left", off);
  await ev(`([...document.querySelectorAll(".sbag-bar button")].find((b) => b.textContent === "Revoke").click(), true)`);
  let left = null;
  for (let i = 0; i < 200; i++) { left = await drive({ op: "status" }); if (left.ok?.paired === false) break; await sleep(100); }
  ok(left?.ok?.paired === false, "(Revoke on the bar: the agent is no longer paired)", left);
  const c2 = await drive({ op: "code" });
  await pair(c2, false);
  ok(!!(await req("workspace.create", { path: "/agent-run2.py", content: { text: "open('/ran.txt', 'w').write('ran')\n" } })).ok, "(the agent creates another Python file)");
  const refused = await req("workspace.run_file", { path: "/agent-run2.py" });
  ok(!!refused.err && !refused.ok, "without May run code: run_file is refused", refused);
  const nbRefused = await req("workspace.run_notebook", { path: "/agent-run.ipynb" });
  ok(!!nbRefused.err && !nbRefused.ok, "without May run code: run_notebook is refused", nbRefused);
  const st = await req("workspace.stat", { path: "/ran.txt" });
  ok(st.ok?.entry === null, "nothing was run: the file it would write isn't there", st);
} catch (e) {
  ok(false, "the test ran to its end: " + (e?.stack ?? e));
} finally {
  try { py.kill(); } catch {}
  server.kill();
  // (Chromium gone before its profile is removed: a profile it still writes to can't be)
  const exited = new Promise((r) => chrome.once("exit", r));
  chrome.kill();
  await Promise.race([exited, sleep(5000)]);
  try { rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
}
console.log(failures ? `FAIL: ${failures} of ${checks}` : `ok: the Agents page's run verbs, ${checks} checks`);
process.exit(failures ? 1 : 0);
