// ci: web-browser/latex order=49 chrome
// A shared talk on the share page (share.ts's openShared, the view the share page opens a .tex with), in headless
// Chrome against the built site, with the page's own kernel and runner classes (the real sandbox) and the shared files
// served by the test (each URL fulfilled here, as the share's file origin would):
//   - nothing executes before run(): opening and drawing start no kernel;
//   - run(): the worker is told it may change no file, then given only the shared files of the .tex's folder; the code
//     reads a helper beside the .tex; the slides show the results; the workspace is never written;
//   - a shared file whose bytes aren't the ones shared (SHA-256) is refused: its read ends the session, so nothing runs
//     past it and no value shows;
//   - no sandbox: Run says why, and no kernel is made;
//   - dispose() during a Run: its runner ended, nothing said after, the box emptied;
//   - opened again: the author's results, not the last Run's (they stayed in that page);
//   - Present: Shift+Enter runs, S stops.
//   bun web/build.ts && python3 web/serve.py 8765 &  CHROME=google-chrome node web/latex/test-latex-share.mjs
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort } from "../test-port.mjs";

const site = process.env.SB_URL ?? "http://127.0.0.1:8765/";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), "sb-tex-share-"));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--remote-debugging-port=0", "--window-size=1200,800", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
const fails = [];
let checks = 0;
const check = (ok, what, detail) => { checks++; if (!ok) fails.push(what); console.log((ok ? "ok   " : "FAIL ") + what + (ok || detail === undefined ? "" : " " + JSON.stringify(detail).slice(0, 400))); };

// the shared files: the talk's helper beside it, a file of another folder (never given), and a helper whose bytes
// aren't the ones shared
const FILES = { "talks/helper.py": "def v():\n    return 41 + 1\n", "secret/key.py": "K = 'not yours'\n", "talks/bad.py": "B = 1\n" };
const sha = (s) => createHash("sha256").update(s).digest("hex");
const fileUrl = (p) => new URL(`__sbshare/${encodeURIComponent(p)}`, site).href;
const MOUNT = Object.entries(FILES).map(([p, t]) => [p, { url: fileUrl(p), sha256: p === "talks/bad.py" ? sha("something else") : sha(t), size: Buffer.byteLength(t) }]);
const TALK = (more = "") => `\\documentclass{beamer}
\\usepackage{sagetex}
\\begin{document}
\\begin{frame}[fragile]{One}
\\begin{sagesilent}
from helper import v
\\end{sagesilent}
A: \\sage{v()}
\\end{frame}
\\begin{frame}{Two}
B: \\sage{2+3}${more}
\\end{frame}
\\end{document}
`;
// (the author's results: A was 1, B was 2; a Run gives 42 and 5)
const RESULTS = (items) => ({ format: "sagebrush-latex-results", version: 1, wrapper: "WRAP", items });

let code = 1, ws;
try {
  const port = await devtoolsPort(profile);
  let targets;
  for (let i = 0; i < 300; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); break; } catch { await sleep(100); } }
  ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let n = 0; const waiting = new Map(), errors = [], served = [];
  const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); }
    if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text);
    // (the share's file origin: each mounted URL answered with its file's bytes)
    if (m.method === "Fetch.requestPaused") {
      const p = decodeURIComponent(new URL(m.params.request.url).pathname.split("/__sbshare/")[1] ?? "");
      served.push(p);
      const body = FILES[p];
      void send("Fetch.fulfillRequest", body === undefined ? { requestId: m.params.requestId, responseCode: 404, body: "" } : { requestId: m.params.requestId, responseCode: 200, responseHeaders: [{ name: "Content-Type", value: "text/plain" }, { name: "Access-Control-Allow-Origin", value: "*" }], body: Buffer.from(body).toString("base64") });
    }
  };
  const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400)); return r.result?.value; };
  const until = async (expr, ms = 30000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr).catch(() => false)) return true; await sleep(50); } return false; };
  const key = async (k, code, vk, mods = 0) => { for (const type of ["keyDown", "keyUp"]) await send("Input.dispatchKeyEvent", { type, key: k, code, windowsVirtualKeyCode: vk, modifiers: mods, text: mods ? undefined : k.length === 1 ? k : undefined }); };

  await send("Page.enable");
  await send("Fetch.enable", { patterns: [{ urlPattern: "*__sbshare*" }] });
  await send("Page.navigate", { url: site });
  check(await until(`!!window.sagebrush?.workspace`, 60000), "(the workspace)");
  // the harness: the page's own kernel and runner classes (as the share page passes its own), a spy on every kernel
  // made, every execute and every message to a worker, and on the workspace's writes; a box for the talk
  check(await ev(`(async () => {
    const nb = await import(new URL("sagebrush-notebook.js", location.href).href);
    const T = window.__share = { kernels: 0, executes: 0, posts: [], says: [], running: [], writes: 0, workers: [] };
    class K extends nb.WorkerKernel { constructor(o) { T.kernels++; super(o); } execute(...a) { T.executes++; return super.execute(...a); } }
    class R extends nb.RunnerWorker { constructor(...a) { super(...a); T.workers.push(this); const p = this.postMessage.bind(this); this.postMessage = (m, ...r) => { T.posts.push(m); return p(m, ...r); }; } }
    T.sandbox = { WorkerKernel: K, RunnerWorker: R, runnerUrl: "runner/" };
    const w = window.sagebrush.workspace;
    for (const f of ["write", "createByPerson", "create", "remove", "rename", "writeFile"]) if (typeof w[f] === "function") { const g = w[f].bind(w); w[f] = (...a) => { T.writes++; return g(...a); }; }
    T.mod = await import(new URL("sagebrush-latex-share.js", location.href).href);
    T.open = async (o) => { const box = document.createElement("div"); box.className = "share-box"; box.style.cssText = "width:900px;height:600px"; document.querySelector(".share-box")?.remove(); document.body.appendChild(box);
      return T.mod.openShared(box, { say: (t) => T.says.push(t), onRunning: (on) => T.running.push(on), ...o }); };
    return true;
  })()`), "(the harness: the page's classes, spies, the share chunk)");
  const said = () => ev(`window.__share.says.at(-1) ?? ""`);
  const slideText = (t) => ev(`(() => { const s = Array.from(document.querySelectorAll(".share-box .slide")).find((s) => s.querySelector(".slide-title")?.textContent.trim() === ${JSON.stringify(t)}); return s ? s.textContent.replace(/\\s+/g, " ").trim() : null; })()`);
  const ranOk = (ms = 120000) => until(`/^Ran /.test(window.__share.says.at(-1) ?? "") && window.__share.running.at(-1) === false`, ms);

  // ---- opened: the author's results, and nothing runs
  const items0 = await ev(`(async () => { const v = await window.__share.open({ path: "talks/st.tex", text: ${JSON.stringify(TALK())}, results: null, sandbox: window.__share.sandbox, mount: ${JSON.stringify(MOUNT)} }); window.__v = v; return true; })()`);
  check(items0 === true && await until(`document.querySelectorAll(".share-box .slide").length === 2`), "opened: the talk's two slides drawn");
  await sleep(800);
  check(await ev(`window.__share.kernels === 0 && window.__share.executes === 0`), "opened: no kernel made, nothing executed before run()", await ev(`({ k: window.__share.kernels, e: window.__share.executes })`));

  // ---- run(): the folder's files only, after no-writes; the helper read; the slides show the results; no writes
  await ev(`window.__v.run(), true`);
  check(await ranOk(), "run(): it runs, and says so", await said());
  const posts = await ev(`window.__share.posts.filter((m) => m && (m.fsWritable !== undefined || m.mount !== undefined))`);
  check(posts.length >= 2 && posts[0].fsWritable === false && JSON.stringify(posts[1].mount?.map((e) => e[0])) === JSON.stringify(["talks/helper.py", "talks/bad.py"]), "run(): no right to change files first, then only the .tex's folder's shared files", posts);
  check(/A: 42/.test(await slideText("One") ?? "") && /B: 5/.test(await slideText("Two") ?? ""), "run(): the helper beside the .tex is read, and the slides show the results", [await slideText("One"), await slideText("Two")]);
  check(!served.includes("secret/key.py"), "run(): a file of another folder is never fetched", served);
  check(await ev(`window.__share.writes`) === 0, "run(): the workspace is never written", await ev(`window.__share.writes`));
  check(await ev(`JSON.stringify(window.__share.running)`) === "[true,false]", "run(): onRunning on, then off", await ev(`window.__share.running`));

  // ---- a shared file that isn't the one shared: refused, the item fails saying so
  await ev(`window.__v.dispose(), true`);
  await ev(`(async () => { window.__share.says.length = 0; window.__share.running.length = 0; window.__v = await window.__share.open({ path: "talks/st.tex", text: ${JSON.stringify(TALK().replace("from helper import v", "from bad import B"))}, results: null, sandbox: window.__share.sandbox, mount: ${JSON.stringify(MOUNT)} }); return true; })()`);
  await until(`document.querySelectorAll(".share-box .slide").length === 2`);
  await ev(`window.__v.run(), true`);
  check(await ranOk(), "hash: the Run ends", await said());
  // (refused closed: the read fails in the runner and ends the session, so nothing after it runs and no value shows)
  const pv = await ev(`document.querySelector(".share-box .tex-preview")?.textContent ?? ""`);
  check(/^Ran 0 of 3 /.test(await said()) && /not run: the session stopped with an error/.test(pv) && !/A: \d/.test(pv) && !/B: 5/.test(pv), "hash: a file whose bytes aren't the shared ones is refused: nothing runs past it, no value shown", { said: await said(), pv: pv.slice(0, 300) });

  // ---- no sandbox: Run says why, nothing is made
  await ev(`window.__v.dispose(), true`);
  const k0 = await ev(`window.__share.kernels`);
  await ev(`(async () => { window.__share.says.length = 0; window.__v = await window.__share.open({ path: "talks/st.tex", text: ${JSON.stringify(TALK())}, results: null, sandbox: null, mount: ${JSON.stringify(MOUNT)} }); return true; })()`);
  await until(`document.querySelectorAll(".share-box .slide").length === 2`);
  await ev(`window.__v.run(), true`);
  check(await until(`/sandbox/.test(window.__share.says.at(-1) ?? "")`, 10000) && await ev(`window.__share.kernels`) === k0, "no sandbox: Run says why, and no kernel is made", await said());

  // ---- dispose() during a Run: its runner ended, nothing said after, the box emptied
  await ev(`window.__v.dispose(), true`);
  await ev(`(async () => { window.__share.says.length = 0; window.__v = await window.__share.open({ path: "talks/st.tex", text: ${JSON.stringify(TALK().replace("from helper import v", "from helper import v\nimport time\ntime.sleep(20)"))}, results: null, sandbox: window.__share.sandbox, mount: ${JSON.stringify(MOUNT)} }); return true; })()`);
  await until(`document.querySelectorAll(".share-box .slide").length === 2`);
  await ev(`window.__v.run(), true`);
  await until(`window.__share.says.at(-1) === "Running…"`, 120000);
  const nSaid = await ev(`window.__share.says.length`), w = await ev(`window.__share.workers.length`);
  await ev(`window.__v.dispose(), true`);
  await sleep(1500);
  check(await ev(`window.__share.says.length`) === nSaid, "dispose(): nothing said after it", await ev(`window.__share.says.slice(${nSaid})`));
  check(await ev(`document.querySelector(".share-box")?.children.length === 0`), "dispose(): the box emptied");
  check(await ev(`(() => { const r = window.__share.workers[${w - 1}]; return !!r && (r.terminated === true || !r.frame?.isConnected); })()`), "dispose(): the Run's runner ended", await ev(`Object.keys(window.__share.workers[${w - 1}] ?? {})`));

  // ---- opened again: the author's results, not a Run's (they stayed in that page)
  await ev(`(async () => { window.__share.says.length = 0; window.__v = await window.__share.open({ path: "talks/st.tex", text: ${JSON.stringify(TALK())}, results: ${JSON.stringify(RESULTS([]))}, sandbox: window.__share.sandbox, mount: ${JSON.stringify(MOUNT)} }); return true; })()`);
  await until(`document.querySelectorAll(".share-box .slide").length === 2`);
  await sleep(500);
  check(!/42/.test(await slideText("One") ?? "") && !/B: 5/.test(await slideText("Two") ?? ""), "opened again: a Run's results aren't there (they stayed in its page)", [await slideText("One"), await slideText("Two")]);

  // ---- Present: Shift+Enter runs, S stops
  await ev(`window.__v.dispose(), true`);
  await ev(`(async () => { window.__share.says.length = 0; window.__share.running.length = 0; window.__v = await window.__share.open({ path: "talks/st.tex", text: ${JSON.stringify(TALK().replace("from helper import v", "from helper import v\nimport time\ntime.sleep(15)"))}, results: null, sandbox: window.__share.sandbox, mount: ${JSON.stringify(MOUNT)} }); return true; })()`);
  await until(`document.querySelectorAll(".share-box .slide").length === 2`);
  await ev(`window.__v.present(), true`);
  check(await until(`!!document.querySelector(".tex-present")`, 10000), "Present: the slides full screen");
  await key("Enter", "Enter", 13, 8);
  check(await until(`window.__share.running.at(-1) === true`, 10000), "Present: Shift+Enter runs", await ev(`window.__share.running`));
  await until(`window.__share.says.at(-1) === "Running…"`, 120000);
  await key("s", "KeyS", 83);
  check(await until(`window.__share.running.at(-1) === false`, 30000) && /^Ran |Stopped/.test(await said()), "Present: S stops the Run", await said());
  await ev(`window.__v.dispose(), true`);

  check(errors.length === 0, "no uncaught errors", errors);
  code = fails.length ? 1 : 0;
} catch (e) {
  console.log("FAIL threw", e?.stack ?? e);
  fails.push("threw");
} finally {
  try { ws?.close(); } catch {}
  chrome.kill();
  await sleep(200);
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
}
console.log(fails.length ? `FAIL: ${fails.length} of ${checks}` : `ok: a shared talk, ${checks} checks`);
process.exit(fails.length ? 1 : code);
