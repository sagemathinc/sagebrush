// The agent-flow harness: a person asks an agent for something; the thing gets made, opens, runs and shows its
// result, with the agent still there to continue. Each case (cases/<id>.mjs, the format in FORMAT.md) says what the
// agent does and what the person must see; this runs it on each surface it names:
//   - mcp: sagebrush-mcp's own Server (engine/py/python/sagebrush/mcp_server.py), its tool calls as Claude Code makes
//     them, paired with the notebook page through the one link it gives;
//   - chat: the Agents page (/agents/), paired with a scripted stand-in for sagebrush-agent that makes the same page
//     verbs (workspace_create is the page's workspace.create, and so on).
// No model is called: the agent's side is the case's script. The site is web/dist as web/serve.py serves it (the
// site's headers, its CSP), in headless Chrome.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { randomBytes } from "node:crypto";
import { devtoolsPort } from "../test-port.mjs";

const here = new URL(".", import.meta.url).pathname;
const SB_SRC = join(here, "../../engine/py/python/sagebrush");
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** The grant a case gets unless it says otherwise: everything, may change files, may run code. */
export const DEFAULT_GRANT = { folders: ["/"], write: true, run: true };
/** A case's whole budget (each wait inside it is shorter). */
export const CASE_MS = 120_000;

// ---- the site
export async function startSite() {
  const proc = spawn("python3", ["-u", join(here, "..", "serve.py"), "0"], { stdio: ["ignore", "pipe", "inherit"] });
  const port = await new Promise((res, rej) => {
    let acc = "";
    proc.stdout.on("data", (b) => { acc += b; const m = /(\d{2,5})/.exec(acc); if (m) res(+m[1]); });
    proc.on("exit", (c) => rej(new Error("web/serve.py exited: " + c)));
    setTimeout(() => rej(new Error("web/serve.py said no port in 15 s")), 15000);
  });
  return { origin: `http://127.0.0.1:${port}`, close: () => proc.kill() };
}

// ---- Chrome, one tab, driven over the DevTools protocol
export async function startChrome() {
  const profile = mkdtempSync(join(tmpdir(), "sb-agent-flows-"));
  const proc = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--remote-debugging-port=0", "--window-size=1400,900", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
  const cdp = await devtoolsPort(profile);
  let targets;
  for (let i = 0; i < 300; i++) { try { targets = await (await fetch(`http://127.0.0.1:${cdp}/json`)).json(); break; } catch { await sleep(100); } }
  const sock = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
  await new Promise((r) => (sock.onopen = r));
  let n = 0;
  const waiting = new Map(), errors = [];
  sock.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
    // (the page's own errors, which fail a case: an uncaught exception or an unhandled rejection)
    if (m.method === "Runtime.exceptionThrown") errors.push(String(m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text).slice(0, 300));
  };
  const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); sock.send(JSON.stringify({ id, method, params })); });
  for (const m of ["Page.enable", "Runtime.enable"]) await send(m);
  const ev = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    if (!r.result || r.result.exceptionDetails) throw new Error(JSON.stringify(r.result?.exceptionDetails ?? r.error ?? r).slice(0, 400));
    return r.result.result?.value;
  };
  const until = async (expr, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr).catch(() => false)) return true; await sleep(100); } return false; };
  const navigate = async (url) => { await ev("window.__old = 1").catch(() => {}); await send("Page.navigate", { url }); await sleep(300); return until("!window.__old && document.readyState !== 'loading'", 60000); };
  const shot = async (file) => { const r = await send("Page.captureScreenshot", { format: "png" }); writeFileSync(file, Buffer.from(r.result.data, "base64")); };
  const fresh = async (origin) => { await send("Storage.clearDataForOrigin", { origin, storageTypes: "all" }); errors.length = 0; };
  const close = async () => { try { proc.kill(); } catch {} await sleep(300); rmSync(profile, { recursive: true, force: true, maxRetries: 5 }); };
  // (a real click, as the person's: the mouse pressed and released at the element's centre. A scripted el.click() isn't
  //  a user gesture, so the browser blocks a tab it would open; this one isn't)
  const click = async (selector) => {
    const at = await ev(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; e.scrollIntoView({ block: "center" }); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    if (!at) throw new Error("nothing to click: " + selector);
    for (const type of ["mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, x: at.x, y: at.y, button: "left", clickCount: 1 });
    return true;
  };
  // (another tab of this Chrome, one the person opened (a link, an Open that opens a tab of its own): the page whose
  //  address matches, over a DevTools socket of its own; closed with the case, tabs.splice(0))
  const tabs = [];
  const tab = async (match, ms = 20000) => {
    let found = null;
    for (const t = Date.now(); !found && Date.now() - t < ms; await sleep(100)) {
      const list = await (await fetch(`http://127.0.0.1:${cdp}/json`)).json().catch(() => []);
      found = list.find((x) => x.type === "page" && match.test(x.url) && !tabs.some((o) => o.id === x.id)) ?? null;
    }
    if (!found) throw new Error("no tab at " + match);
    const ws = new WebSocket(found.webSocketDebuggerUrl);
    await new Promise((ok, fail) => { ws.onopen = ok; ws.onerror = () => fail(new Error("no socket to the tab at " + found.url)); });
    let k = 0;
    const wait = new Map();
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && wait.has(m.id)) { wait.get(m.id)(m); wait.delete(m.id); }
      if (m.method === "Runtime.exceptionThrown") errors.push("(tab) " + String(m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text).slice(0, 300));
    };
    const tsend = (method, params = {}) => new Promise((r) => { const id = ++k; wait.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
    await tsend("Runtime.enable");
    const tev = async (expr) => {
      const r = await tsend("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
      if (!r.result || r.result.exceptionDetails) throw new Error(JSON.stringify(r.result?.exceptionDetails ?? r.error ?? r).slice(0, 400));
      return r.result.result?.value;
    };
    const t = {
      id: found.id,
      url: found.url,
      ev: tev,
      until: async (expr, wms = 20000) => { const s = Date.now(); while (Date.now() - s < wms) { if (await tev(expr).catch(() => false)) return true; await sleep(100); } return false; },
      shot: async (file) => { const r = await tsend("Page.captureScreenshot", { format: "png" }); writeFileSync(file, Buffer.from(r.result.data, "base64")); },
      close: async () => { try { ws.close(); } catch {} await send("Target.closeTarget", { targetId: found.id }).catch(() => {}); },
    };
    tabs.push(t);
    return t;
  };
  const closeTabs = async () => { for (const t of tabs.splice(0)) await t.close(); };
  return { send, ev, until, navigate, shot, fresh, errors, close, click, tab, closeTabs };
}

// ---- the grant dialog ("Allow this agent?"), set as the case's grant, then Allow
export async function allow(page, grant) {
  if (!(await page.until(`[...document.querySelectorAll(".sbag-box h2")].some((h) => h.textContent === "Allow this agent?")`, 30000))) {
    throw new Error("no Allow dialog: " + (await page.ev(`document.querySelector(".sbag-box .err")?.textContent ?? document.querySelector(".sbag-box")?.textContent ?? "(no dialog)"`).catch(() => "")));
  }
  const ok = await page.ev(`(() => {
    const b = [...document.querySelectorAll(".sbag-box")].at(-1), g = ${JSON.stringify(grant)};
    const byLabel = (re) => [...b.querySelectorAll("label")].find((l) => re.test(l.textContent))?.querySelector("input[type=checkbox]");
    const all = b.querySelector(".folders input"), everything = g.folders.length === 1 && g.folders[0] === "/";
    if (all.checked !== everything) all.click();
    if (!everything) for (const f of g.folders) { const i = b.querySelector('.folders input[value=' + JSON.stringify(f) + ']'); if (!i) return "no folder " + f; if (!i.checked) i.click(); }
    const write = byLabel(/may change files/), run = byLabel(/^May run code/);
    if (!write || !run) return "no write or run box";
    if (write.checked !== !!g.write) write.click();
    if (run.checked !== !!g.run) run.click();
    [...b.querySelectorAll("button.primary")].pop().click();
    return true;
  })()`);
  if (ok !== true) throw new Error("the Allow dialog: " + ok);
}

// ---- surface mcp: sagebrush-mcp's Server, one JSON line each way, each call in its own thread
const MCP_DRIVER = `
import io, json, os, sys, threading, types
src = os.environ["SB_SRC"]
pkg = types.ModuleType("sagebrush"); pkg.__path__ = [src]; sys.modules["sagebrush"] = pkg
from sagebrush import mcp_server as M
srv = M.Server(io.StringIO())
srv.client = {"name": "claude-code", "version": "0"}
out = threading.Lock()
def one(m):
    try:
        content, structured, is_error = srv.call_tool(m["name"], m["args"])
        r = {"id": m["id"], "text": content[0]["text"] if content else "", "structured": structured, "isError": is_error}
    except KeyError as e:
        # (as the server answers a tool it doesn't have: -32602 "unknown tool")
        r = {"id": m["id"], "text": "unknown tool: %s" % m["name"], "structured": None, "isError": True, "unknown": True}
    except Exception as e:
        r = {"id": m["id"], "text": "the server raised %s: %s" % (type(e).__name__, e), "structured": None, "isError": True, "raised": True}
    with out:
        print(json.dumps(r), flush=True)
for line in sys.stdin:
    threading.Thread(target=one, args=(json.loads(line),), daemon=True).start()
`;

async function mcpSurface(site, page) {
  const proc = spawn("python3", ["-s", "-c", MCP_DRIVER], { env: { ...process.env, SB_SRC, SAGEBRUSH_MCP_DEV_ORIGIN: site.origin }, stdio: ["pipe", "pipe", "ignore"] });
  const wait = new Map();
  let id = 0;
  createInterface({ input: proc.stdout }).on("line", (l) => { const m = JSON.parse(l); wait.get(m.id)?.(m); wait.delete(m.id); });
  proc.on("exit", () => { for (const w of wait.values()) w({ text: "the MCP server exited", isError: true, raised: true }); wait.clear(); });
  const tool = (name, args = {}) => new Promise((r) => { const i = ++id; wait.set(i, r); proc.stdin.write(JSON.stringify({ id: i, name, args }) + "\n"); });
  return {
    name: "mcp",
    tool,
    /** The person: opens the link the agent gives, Connect, then the grant, Allow; the agent waits for it. */
    async connect(grant) {
      const r = await tool("workspace_connect", {});
      const link = r.structured?.result?.link;
      if (!link) throw new Error("workspace_connect gave no link: " + r.text);
      const waited = tool("workspace_connect", { wait: 60 });
      await page.navigate(link);
      if (!(await page.until(`location.pathname === "/" && !!document.querySelector(".sbag-box button.primary")`, 90000))) {
        throw new Error("the link didn't open Connect on the notebook page: " + (await page.ev(`location.href + " | " + (document.querySelector(".sbag-box")?.textContent ?? "(no dialog)") + " | " + (document.querySelector("#status")?.textContent ?? "")`).catch((e) => String(e))).slice(0, 300));
      }
      await page.ev(`(document.querySelector(".sbag-box button.primary").click(), true)`);
      await allow(page, grant);
      const w = await waited;
      if (!w.structured?.result?.granted) throw new Error("workspace_connect(wait) didn't return granted: " + w.text);
    },
    /** The notebook the person sees: the notebook page's own. */
    shownPath: `(async () => { const id = localStorage.getItem("sagebrush-current"); return (await window.sagebrush.workspace.list("/", { recursive: true })).find((e) => e.ref === id)?.path ?? null; })()`,
    /** Its cells' outputs as the page has them now (null if it isn't shown). */
    liveCells: `(() => { try { return window.sagebrush.notebook.snapshot().cells.map((c) => c.outputs ?? []); } catch { return null; } })()`,
    close: () => proc.kill(),
  };
}

/** The Agents page's pane as the person sees it (the chat and computer surfaces): each cell's rendered outputs (a
 * picture, an error, text), read from the page, so an empty or broken pane fails even when the saved copy has them. */
export const PANE_CELLS = `(() => {
      const body = document.querySelector(".pane-body"), cells = body ? [...body.querySelectorAll(".cell")] : [];
      if (!cells.length) return null;
      return cells.map((c) => {
        const out = [];
        for (const e of c.querySelectorAll("*")) if (e.sbBundle && Object.keys(e.sbBundle).some((k) => k.startsWith("image/"))) out.push({ output_type: "display_data", data: Object.fromEntries(Object.keys(e.sbBundle).map((k) => [k, "1"])) });
        // (a plot drawn in the page (matplotlib and the like): the pane's own figure, an SVG; counted here only when no
        //  bundle in it was counted above)
        for (const f of c.querySelectorAll(".out figure.plot")) if (f.querySelector("svg") && !f.sbBundle && ![...f.querySelectorAll("*")].some((e) => e.sbBundle)) out.push({ output_type: "display_data", data: { "image/svg+xml": "1" } });
        for (const p of c.querySelectorAll("pre.txt")) {
          for (const e of p.querySelectorAll("span.e")) out.push({ output_type: "error", ename: "", evalue: e.textContent.slice(0, 200) });
          const t = [...p.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join("");
          if (t) out.push({ output_type: "stream", text: t });
        }
        return out;
      });
    })()`;

// ---- surface chat: the Agents page and a stand-in for sagebrush-agent (as web/agents/a14-cases.mjs's fakeAgent: the
// runner protocol on a loopback socket; the agent's tool calls become the page verbs sagebrush-agent makes)
async function chatSurface(site, page) {
  const A = { live: null, pending: new Map(), n: 0, secret: randomBytes(32).toString("base64url"), grants: [], turn: null, asked: [] };
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req, srv) {
      if (new URL(req.url).pathname !== "/sagebrush") return new Response("not here", { status: 404 });
      if (A.live) return new Response("already paired", { status: 409 });
      return srv.upgrade(req) ? undefined : new Response("no", { status: 400 });
    },
    websocket: {
      message(ws, data) {
        const m = JSON.parse(String(data));
        if (m.method === "hello") {
          const p = m.params ?? {};
          if (!(p.code === "123456" || p.session === A.secret)) {
            ws.send(JSON.stringify({ jsonrpc: "2.0", id: m.id, error: { code: -32001, message: "refused", data: { code: "refused", message: "unknown session" } } }));
            return void ws.close(1008, "refused");
          }
          A.live = ws;
          ws.send(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { protocol: 1, agent: { name: "Claude", client: "claude-agent-sdk", version: "0.7.1" }, wants: { folders: ["/"], write: true, run: true }, ...(typeof p.code === "string" ? { session: A.secret } : {}) } }));
        } else if (m.id && A.pending.has(m.id)) {
          A.pending.get(m.id)(m);
          A.pending.delete(m.id);
        } else if (m.method === "grant.changed") A.grants.push(m.params);
        // (the person's message: a turn starts, and the case's tool calls are played in it, as sagebrush-agent's turns)
        else if (m.method === "chat.message") A.asked.push(m.params);
      },
      close(ws) { if (A.live === ws) A.live = null; },
    },
  });
  const call = (method, params, ms = 130000) => new Promise((resolve) => {
    if (!A.live) return resolve({ error: { code: "not_connected", message: "no page is paired" } });
    const id = "s" + ++A.n;
    A.pending.set(id, resolve);
    A.live.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    setTimeout(() => { if (A.pending.has(id)) { A.pending.delete(id); resolve({ error: { code: "timeout", message: "no answer in " + ms + " ms" } }); } }, ms);
  });
  const event = (ev) => A.live?.send(JSON.stringify({ jsonrpc: "2.0", method: "turn.event", params: { conversation: A.turn.conversation, turn_id: A.turn.id, in_reply_to: A.turn.inReplyTo, event: ev } }));
  // (sagebrush-mcp's tool names, the page's verbs: workspace_create is workspace.create; in a turn, each call is shown
  //  as sagebrush-agent shows it (lib/turns.mjs): started, finished, and a file it wrote as an artifact beside the chat)
  const tool = async (name, args = {}) => {
    if (name === "workspace_connect") return { text: A.live ? "paired" : "not paired", structured: { result: { paired: !!A.live, granted: A.grants.length > 0 }, error: null }, isError: false };
    if (!name.startsWith("workspace_")) return { text: "no such tool here: " + name, structured: null, isError: true };
    const callId = "c" + ++A.n, t0 = Date.now();
    if (A.turn) event({ type: "tool_call_started", call: callId, tool: "tool", name, summary: args.path ?? "" });
    const r = await call("workspace." + name.slice("workspace_".length), args);
    const error = r.error ? { code: r.error.data?.code ?? r.error.code, message: r.error.data?.message ?? r.error.message } : null;
    const text = JSON.stringify(error ?? r.result).slice(0, 4000);
    if (A.turn) {
      event({ type: "tool_call_finished", call: callId, status: error ? "error" : "ok", duration_ms: Date.now() - t0, body: text.slice(0, 2000) });
      const p = args.path;
      if (!error && typeof p === "string" && (name === "workspace_create" || name === "workspace_write")) {
        const json = args.content?.json;
        if (json || p.endsWith(".ipynb")) event({ type: "artifact", id: p, kind: "notebook", title: p.split("/").pop(), path: p, body: `${json?.cells?.length ?? 0} cells (${args.mode ?? json?.mode ?? "python"})` });
        // (sagebrush-agent's artifactKind: Markdown as markdown, anything else as code in its extension's language)
        else event({ type: "artifact", id: p, ...(/\.(md|markdown)$/i.test(p) ? { kind: "markdown" } : { kind: "code", lang: /\.([A-Za-z0-9]+)$/.exec(p)?.[1].toLowerCase() }), title: p.split("/").pop(), path: p, body: args.content?.text ?? args.text ?? "" });
      }
    }
    return { text, structured: { result: r.result ?? null, error }, isError: !!error };
  };
  return {
    name: "chat",
    tool,
    async connect(grant) {
      await page.navigate(`${site.origin}/agents/?pair=123456&port=${server.port}`);
      if (!(await page.until(`!!document.querySelector(".sbag-box button.primary")`, 60000))) throw new Error("the Agents page didn't open Connect");
      await page.ev(`(document.querySelector(".sbag-box button.primary").click(), true)`);
      await allow(page, grant);
      for (let t = Date.now(); !A.grants.length && Date.now() - t < 10000; ) await sleep(50);
      if (!A.grants.length) throw new Error("the page didn't send its grant");
    },
    /** The person sends the prompt from the composer; the stand-in's turn starts. */
    async beginTurn(prompt) {
      const before = A.asked.length;
      // (the composer is board's block editor in #editor: its textarea is there only while a block is being written, and
      //  only a real click on a block starts that. So: the mouse at the block's middle, its textarea focused, the prompt
      //  typed and seen in it, then Send)
      if (!(await page.until(`!!document.querySelector("#editor .mb-block, #editor textarea")`, 30000))) throw new Error("the composer didn't show: " + (await page.ev(`(document.querySelector("#editor")?.outerHTML ?? "no #editor").slice(0, 300) + " | " + location.href`).catch((e) => String(e))));
      // (already being written in, as the page leaves it when it opens: its textarea is there; else a block to click)
      if (await page.ev(`!!document.querySelector("#editor textarea")`)) await page.ev(`(document.querySelector("#editor textarea").focus(), true)`);
      else {
        const at = await page.ev(`(() => { const r = document.querySelector("#editor .mb-block").getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
        for (const type of ["mousePressed", "mouseReleased"]) await page.send("Input.dispatchMouseEvent", { type, x: at.x, y: at.y, button: "left", clickCount: 1 });
      }
      if (!(await page.until(`document.activeElement?.tagName === "TEXTAREA" && !!document.activeElement.closest("#editor")`, 10000))) throw new Error("the composer's click didn't start writing");
      await page.send("Input.insertText", { text: prompt });
      if (!(await page.until(`document.activeElement?.value === ${JSON.stringify(prompt)}`, 5000))) throw new Error("the prompt didn't go into the composer");
      await page.ev(`(document.querySelector("#send").click(), true)`);
      for (let t = Date.now(); A.asked.length === before && Date.now() - t < 10000; ) await sleep(50);
      const m = A.asked.at(-1);
      if (A.asked.length === before) throw new Error("the person's message didn't reach the agent");
      A.turn = { conversation: m.conversation, id: "t-" + randomBytes(4).toString("hex"), inReplyTo: m.id };
      event({ type: "turn_started" });
    },
    endTurn(text = "Done.") { if (!A.turn) return; event({ type: "text", text }); event({ type: "turn_finished", outcome: "completed" }); A.turn = null; },
    /** The notebook the person sees: the Agents page's pane, its tab shown. */
    shownPath: `document.querySelector(".pane-head .tab.on")?.dataset.tab ?? null`,
    liveCells: PANE_CELLS,
    close: () => server.stop(true),
  };
}

export const SURFACES = { mcp: mcpSurface, chat: chatSurface };

// ---- the helpers a case's expect(h) gets
export function helpers(page, surface, failures, shotDir, caseId, gap) {
  const h = {
    surface: surface.name,
    tool: (name, args) => surface.tool(name, args),
    ev: (js) => page.ev(js),
    /** A real click (the mouse, at the element's centre): what opens a tab of its own opens. */
    click: (selector) => page.click(selector),
    /** The tab the person opened whose address matches `match` (a RegExp): { ev, until, shot, close }; closed with the case. */
    async tab(match, ms) {
      const t = await page.tab(match, ms);
      return { ev: t.ev, until: t.until, close: t.close, shot: async (name) => { if (shotDir) await t.shot(join(shotDir, `${caseId}-${surface.name}-${name}.png`)); } };
    },
    until: (js, ms) => page.until(js, ms),
    ok(cond, msg, detail) {
      console.log((cond ? "ok   " : "FAIL ") + `[${caseId} ${surface.name}] ` + msg + (cond || detail === undefined ? "" : " " + JSON.stringify(detail).slice(0, 400)));
      if (!cond) failures.push(msg);
      return !!cond;
    },
    async shot(name) { if (shotDir) await page.shot(join(shotDir, `${caseId}-${surface.name}-${name}.png`)); },
    /** The workspace's copy, as the agent reads it: { mode, cells: [{ code, outputs }], text } (null if unreadable). */
    async read(path) {
      const r = await surface.tool("workspace_read", { path });
      if (r.isError) return null;
      const c = r.structured?.result?.content ?? {};
      const json = c.json ?? null;
      return { mode: json?.mode ?? json?.metadata?.kernelspec?.name ?? null, cells: json?.cells ?? [], text: c.text ?? null, raw: r.structured?.result };
    },
    /** Waits until `path` is what the person sees. */
    async shown(path, ms = 30000) {
      // (the full path, exactly: a notebook of the same name in another folder isn't it)
      const seen = await page.until(`Promise.resolve(${surface.shownPath}).then((p) => p === ${JSON.stringify(path)})`, ms);
      return h.ok(seen, `${path} is shown`, await page.ev(surface.shownPath).catch((e) => String(e)));
    },
    /** Waits until `path` has run: at least `images` images, exactly `errors` errors, and `text` in some output, both as
     * the person sees it (the notebook page's notebook, or the Agents page's pane, showing exactly `path`) and in the
     * saved copy the agent reads. */
    async ran(path, { images = 0, errors = 0, text = null } = {}, ms = 60000) {
      const judge = (cells) => {
        const outs = (cells ?? []).flat();
        const imgs = outs.filter((o) => o.data && Object.keys(o.data).some((k) => k.startsWith("image/"))).length;
        const errs = outs.filter((o) => o.output_type === "error" || o.type === "error" || o.ename || o.traceback).length;
        const all = outs.map((o) => o.text ?? o.data?.["text/plain"] ?? (o.output_type === "error" ? `${o.ename}: ${o.evalue}` : "")).join("\n");
        return { imgs, errs, all, good: imgs >= images && errs === errors && (!text || text.test(all)) && outs.length > 0 };
      };
      let live = null, saved = null, shownNow = null;
      const t = Date.now();
      while (Date.now() - t < ms) {
        shownNow = await page.ev(surface.shownPath).catch(() => null);
        const lc = shownNow === path ? await page.ev(surface.liveCells).catch(() => null) : null;
        live = lc ? judge(lc) : null;
        const r = await h.read(path);
        saved = r ? judge(r.cells.map((c) => c.outputs ?? [])) : null;
        if (live?.good && saved?.good) break;
        await sleep(500);
      }
      const brief = (j) => j && { images: j.imgs, errors: j.errs, text: j.all.slice(0, 200) };
      h.ok(!!live?.good, `${path} ran, as the person sees it: ${images} image(s), ${errors} error(s)${text ? ", " + text : ""}`, live ? brief(live) : { shown: shownNow, outputs: "none shown" });
      return h.ok(!!saved?.good, `${path} ran, its outputs saved: ${images} image(s), ${errors} error(s)${text ? ", " + text : ""}`, brief(saved));
    },
    /** The paths in the workspace (what Files lists). */
    async files() { const r = await surface.tool("workspace_list", { folder: "/", recursive: true }); return (r.structured?.result?.entries ?? []).map((e) => e.path); },
    async open(url) { return page.navigate(url.startsWith("/") ? new URL(url, page.origin).href : url); },
    async agentStillThere() { const r = await surface.tool("workspace_list", { folder: "/" }); return h.ok(!r.isError, "the agent is still there (workspace_list works)", r.text); },
  };
  return h;
}

/** One case on one surface: a fresh profile's storage, the pairing and the grant, the case's given files, the agent's
 * calls, then its expect(h). Returns the failures (empty when it passed). */
export async function runCase(kase, surfaceName, { site, page, shotDir = process.env.SHOT_DIR } = {}) {
  const failures = [];
  page.origin = site.origin;
  await page.fresh(site.origin);
  const surface = await SURFACES[surfaceName](site, page);
  const h = helpers(page, surface, failures, shotDir, kase.id, kase.gaps?.[surfaceName]);
  const body = async () => {
    if (kase.unpaired) await kase.unpaired(h); // (what the agent does before anything is connected: one-link's case)
    else await surface.connect(kase.grant ?? DEFAULT_GRANT);
    for (const [path, content] of Object.entries(kase.given ?? {})) {
      const r = await surface.tool("workspace_create", { path, content });
      h.ok(!r.isError, `(given) ${path}`, r.text);
    }
    if (surface.beginTurn && kase.agent?.length) await surface.beginTurn(kase.prompt);
    for (const step of kase.agent ?? []) {
      const r = await surface.tool(step.tool, step.args ?? {});
      h.ok(!r.isError || step.expectError, `the agent: ${step.tool} ${step.args?.path ?? ""}`.trim(), r.text);
    }
    surface.endTurn?.();
    await kase.expect(h);
  };
  try {
    await Promise.race([body(), sleep(kase.ms ?? CASE_MS).then(() => { throw new Error(`over ${(kase.ms ?? CASE_MS) / 1000} s`); })]);
  } catch (e) {
    h.ok(false, "threw: " + String(e?.stack ?? e).slice(0, 400));
  } finally {
    // (a surface's close may check its own end, as the computer surface's Disconnect: what it finds wrong fails the case)
    const found = await Promise.resolve(surface.close()).catch((e) => ["close threw: " + String(e).slice(0, 200)]);
    for (const f of Array.isArray(found) ? found : []) h.ok(false, f);
    await page.closeTabs();
  }
  h.ok(page.errors.length === 0, "no errors on the page", page.errors.slice(0, 3));
  return failures;
}
