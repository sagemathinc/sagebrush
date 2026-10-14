// The frame other sites show a board in (/frame/board/; design/frame.md):
// a page of another origin embeds it, without a sandbox attribute, and posts
// it a board.  The frame's own policy sandboxes it: an opaque origin, no
// storage of this site's, whatever spelling of its path is asked for.  The
// board shows and its code runs; only the parent's messages count; a later
// board starts the frame afresh (nothing the first board's code did reaches
// it); a text that isn't a board is answered with an error; opened on its
// own, it says what it is for.  The site's _headers give /frame/* one rule
// with all its headers (Cloudflare keeps only the last of a path's rules).
// Build web/dist first, then
//   python3 web/serve.py 8765 &   node web/board/test-frame.mjs
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const site = process.env.SB_URL ?? "http://127.0.0.1:8765/";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (ok, what) => { console.log((ok ? "ok   " : "FAIL ") + what); if (!ok) failed++; };

const board = (title, code) => JSON.stringify({ format: "sagebrush-board", version: 1, title, nodes: [{ id: "a", title: "Code", code }, { id: "b", text: "A note" }] });
// the parent: a page on another origin (another port), not cross-origin isolated
const parent = createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end(`<!doctype html><title>parent</title><body style="margin:0">
<iframe id="f" src="${site}frame/board/" style="width:1000px;height:700px;border:0"></iframe>
<script>
window.got = [];
window.post = (m) => document.getElementById("f").contentWindow.postMessage(m, "*");
// (the board to show: posted now, and again whenever the frame says it is ready)
window.current = null;
window.show = (text, name) => { current = { sagebrush: "board", version: 1, text, name }; post(current); };
addEventListener("message", (e) => {
  if (e.source !== document.getElementById("f").contentWindow) return;
  got.push({ origin: e.origin, data: e.data });
  if (e.data?.sagebrush === "ready" && current) post(current);
});
</script></body>`);
}).listen(0, "127.0.0.1");
await new Promise((r) => parent.once("listening", r));
const parentUrl = `http://127.0.0.1:${parent.address().port}/`;

// the frame's headers, as the site serves them
const head = await fetch(site + "frame/board/");
const csp = head.headers.get("content-security-policy") ?? "";
check(/(^|; )sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox allow-downloads(;|$)/.test(csp) && !/allow-same-origin/.test(csp), "the frame's policy sandboxes it, without allow-same-origin");
check(/frame-ancestors \*/.test(csp), "any page may embed it");
// (one rule for /frame/*, with every header: HDR-A75-1)
const headers = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "_headers"), "utf8").split("\n");
const at = headers.flatMap((l, i) => (l === "/frame/*" ? [i] : []));
const block = at.length === 1 ? headers.slice(at[0] + 1, headers.findIndex((l, i) => i > at[0] && !/^\s/.test(l))) : [];
check(at.length === 1 && ["Content-Security-Policy", "Cross-Origin-Resource-Policy: cross-origin", "Cache-Control"].every((h) => block.some((l) => l.trim().startsWith(h))), "_headers gives /frame/* one rule, with its policy, CORP and Cache-Control");
check(head.headers.get("cross-origin-resource-policy") === "cross-origin", "the frame is served with CORP cross-origin");
// (another spelling of its path: its rules all the same, or not served: HARD-A75-4)
for (const spelling of ["%66rame/board/", "frame%2Fboard/", "frame/./board/", "Frame/board/"]) {
  const r = await fetch(site + spelling, { redirect: "manual" });
  check(r.status !== 200 || /sandbox allow-scripts/.test(r.headers.get("content-security-policy") ?? ""), `/${spelling} is sandboxed too, or not served (${r.status})`);
}

const port = Number(process.env.CDP_PORT ?? 9876);
const profile = mkdtempSync(join(tmpdir(), "sb-frame-"));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", `--remote-debugging-port=${port}`, "--window-size=1100,800", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
let targets;
for (let i = 0; i < 300; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); break; } catch { await sleep(100); } }
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let n = 0; const waiting = new Map(); const frames = []; const errors = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); }
  // (a frame in a process of its own: a target of its own, by its session)
  if (m.method === "Target.attachedToTarget" && m.params.targetInfo.type === "iframe") {
    frames.push(m.params.sessionId);
    send("Runtime.runIfWaitingForDebugger", {}, m.params.sessionId);
  }
  if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails?.exception?.description ?? JSON.stringify(m.params.exceptionDetails));
};
const send = (method, params = {}, sessionId) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); });
const evalIn = async (expression, sessionId, contextId) => {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, ...(contextId ? { contextId } : {}) }, sessionId);
  if (r?.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300));
  return r?.result?.value;
};
const top = (e) => evalIn(e);
// the frame: its own target's page, or else its context in the page's process
let frame = null;
async function findFrame() {
  for (let i = 0; i < 100 && !frame; i++) {
    for (const s of frames) if (await evalIn("location.pathname", s).catch(() => null) === "/frame/board/") frame = (e) => evalIn(e, s);
    if (!frame) {
      const tree = await send("Page.getFrameTree");
      const child = tree.frameTree.childFrames?.[0]?.frame;
      if (child) {
        const w = await send("Page.createIsolatedWorld", { frameId: child.id, worldName: "probe" });
        // (the main world is the page's own: an isolated world can't see its globals, so ask the DOM only there)
        frame = (e) => evalIn(e, undefined, w.executionContextId);
      }
    }
    if (!frame) await sleep(100);
  }
  return frame;
}
const until = async (f, ms = 60000) => { const t = Date.now(); for (;;) { const v = await f().catch(() => null); if (v) return v; if (Date.now() - t > ms) return null; await sleep(200); } };

try {
  await send("Runtime.enable");
  await send("Page.enable");
  await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  await send("Page.navigate", { url: parentUrl });
  check(!!(await until(() => top("got.some((m) => m.data?.sagebrush === 'ready' && m.data.version === 1)"))), "the frame says it is ready");
  check(await top("got.find((m) => m.data?.sagebrush === 'ready')?.origin") === "null", "its messages come from an opaque origin (the policy's sandbox, with no sandbox attribute on the iframe)");
  await findFrame();
  check(!!frame, "the frame found");
  check(await frame("self.origin") === "null", "the frame's origin is opaque");
  check(await frame("(() => { try { localStorage.length; return false; } catch { return true; } })()"), "the frame has no storage of the site's");

  // a board, posted by the parent: it shows, and its code runs
  // (its code leaves a mark in the interpreter, which no later board may see: ISO-A75-2)
  await top(`show(${JSON.stringify(board("First board", "import builtins\nbuiltins._sb_frame_probe = 8675309\nprint(6 * 7)"))}, "first.board.json")`);
  check(!!(await until(() => frame("document.title.startsWith('First board')"))), "the parent's board shows");
  check(!!(await until(() => frame("document.body.innerText.includes('42')"), 90000)), "its code runs in the frame (6 * 7 printed)");

  // a message from anyone but the parent doesn't count: the frame's own window posting to itself
  await frame(`(window.postMessage({ sagebrush: "board", version: 1, text: ${JSON.stringify(board("Not the parent's", "1"))} }, "*"), 1)`);
  await sleep(1500);
  check(await frame("document.title.startsWith('First board')"), "a board posted by another window is ignored");

  // a later board from the parent: the frame starts afresh, says ready again, and shows it
  await top(`show(${JSON.stringify(board("Second board", "import builtins\nprint(2 ** 10, getattr(builtins, '_sb_frame_probe', 'clean'))"))})`);
  check(!!(await until(() => top("got.filter((m) => m.data?.sagebrush === 'ready').length === 2"))), "a later board starts the frame afresh: it says ready again");
  frame = null;
  await findFrame();
  check(!!(await until(() => frame("document.title.startsWith('Second board')"))), "and shows the later board");
  check(!!(await until(() => frame("document.body.innerText.includes('1024 clean')"), 90000)), "whose code runs in a new interpreter: the first board's mark is gone");

  // a text that isn't a board: an error to the parent, and the board stays
  await top(`post({ sagebrush: "board", version: 1, text: "just some words" })`);
  check(!!(await until(() => top("got.some((m) => m.data?.sagebrush === 'error' && typeof m.data.message === 'string')"))), "a text that isn't a board gets an error");
  check(await frame("document.title.startsWith('Second board')"), "and the board shown stays");
  // (messages not for it: no answer, no change)
  await top(`post({ sagebrush: "board", version: 2, text: ${JSON.stringify(board("Version 2", "1"))} }); post("hello"); post({ text: 1 })`);
  await sleep(1000);
  check(await frame("document.title.startsWith('Second board')"), "other messages are ignored");

  // opened on its own: an empty board saying what the page is for, still sandboxed
  frame = null;
  await send("Page.navigate", { url: site + "frame/board/" });
  check(!!(await until(() => top("document.body.innerText.includes(\"another site's page gives it\")"))), "opened on its own, it says what it is for");
  check(await top("self.origin") === "null", "opened on its own, its origin is opaque too");
  check(errors.length === 0, "no exceptions" + (errors.length ? ": " + errors.slice(0, 3).join(" | ") : ""));
} finally {
  ws.close(); chrome.kill(); parent.close();
}
console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
