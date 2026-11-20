// ci: web-sync-ops order=23 runner=bun chrome
// The code page's ways out in the desktop app (web/code/page.ts, its host's navigate: index.html leaveTo), in headless
// Chromium: the page itself, a real workspace and a real DiskMirror over a disk in the page whose writes the test holds
// or fails, and the host's way to another page as index.html's is (beforeLeave, then the navigation):
//   1. ✕ with the disk's write held: the page stays, says so, and typing comes back; released, ✕ leaves with the edit
//      on disk;
//   2. ✕ with the disk's write failing: the page stays, saying why;
//   3. File ▸ Save a copy with the disk held: the copy made, the page stays, typing back, and a second copy may be made;
//   4. the control: nothing held, ✕ leaves with the edit on disk.
// Before the host's navigate, the page left at once: the edit in the workspace, its write to disk dropped with the page.
//   CHROME=google-chrome bun web/code/test-code-leave-disk.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort } from "../test-port.mjs";

const here = new URL(".", import.meta.url).pathname;
const site = mkdtempSync(join(tmpdir(), "sb-code-leave-site-"));
const entry = join(site, "entry.ts");
writeFileSync(entry, `
import { mount } from ${JSON.stringify(join(here, "page.ts"))};
import { renderFileMenu } from ${JSON.stringify(join(here, "../workspace/filemenu.ts"))};
import { Workspace } from ${JSON.stringify(join(here, "../workspace/index.ts"))};
import { DiskMirror, beforeLeave } from ${JSON.stringify(join(here, "../workspace/disk-mirror.ts"))};
const g: any = window;
const run = new URLSearchParams(location.search).get("run") ?? "0";
const ws = await Workspace.open({ name: "ws-code-leave-" + run, mainName: "main-code-leave-" + run });
// (the disk: written files by path; a write held until the test releases it, or failing, as the test sets)
g.disk = new Map(); g.hold = false; g.fail = false; g.release = () => {};
const disk = {
  list: async () => [], stat: async () => null, read: async () => new Uint8Array(), mkdir: async () => {}, rename: async () => {}, remove: async () => {},
  write: async (p: string, bytes: Uint8Array) => {
    if (g.hold) await new Promise((r) => (g.release = r));
    if (g.fail) throw new Error("the disk is full (test)");
    g.disk.set(p, new TextDecoder().decode(bytes));
    return { path: p, dir: false, size: bytes.length, mtime: Date.now() };
  },
};
g.m = new DiskMirror(ws, disk as any, new Map()).start();
g.ws = ws;
addEventListener("pagehide", () => sessionStorage.setItem("left-" + run, JSON.stringify({ from: location.search, disk: Object.fromEntries(g.disk), pending: g.m.pending })));
const e = (await ws.stat("/a.py").catch(() => null)) ?? (await ws.create("/a.py", { content: new TextEncoder().encode("base\\n") }));
// (index.html's leaveTo for the code page, with a shorter wait: the page left only once the disk has its changes)
const navigate = async (to: string) => { if (!(await beforeLeave(g.m, undefined, 1500))) return false; location.assign(to); return true; };
const root = document.createElement("div"); document.body.append(root);
await mount(root, { ws, fid: e.fid!, open() {}, openFiles() {}, examples: async () => false, renderFileMenu, navigate });
g.ready = true;
`);
const built = await Bun.build({ entrypoints: [entry], outdir: site, naming: "page.js", target: "browser", format: "esm" });
if (!built.success) { console.error(built.logs.join("\n")); process.exit(1); }
writeFileSync(join(site, "index.html"), `<!doctype html><meta charset="utf-8"><title>code page leave test</title><script type="module" src="/page.js"></script>`);
const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(req) {
  const p = new URL(req.url).pathname === "/page.js" ? "page.js" : "index.html";
  return new Response(Bun.file(join(site, p)), { headers: { "content-type": p.endsWith(".js") ? "text/javascript" : "text/html" } });
} });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), "sb-code-leave-"));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
const results = [];
const check = (ok, what) => { results.push([!!ok, what]); console.log(`${ok ? "ok  " : "FAIL"} ${what}`); };
let code = 1;
try {
  const port = await devtoolsPort(profile);
  let targets;
  for (let i = 0; i < 300; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); if (targets.some((t) => t.type === "page")) break; } catch {} await sleep(100); }
  const cdp = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
  await new Promise((r) => (cdp.onopen = r));
  let n = 0;
  const waiting = new Map();
  cdp.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); } };
  const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); cdp.send(JSON.stringify({ id, method, params })); });
  const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 1500)); return r.result?.value; };
  const until = async (expression, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await ev(expression).catch(() => false)) return true; await sleep(50); } return false; };
  const TA = `document.querySelector(".code-page .code-edit textarea")`;
  // (a fresh workspace per run, its file opened in Edit with `text` typed, saved to the workspace)
  const open = async (run, text) => {
    await send("Page.navigate", { url: `http://127.0.0.1:${server.port}/?run=${run}` });
    await sleep(200);
    if (!(await until("window.ready === true && window.m.pending === 0", 15000))) throw new Error("the page didn't open, run " + run);
    await ev(`sagebrush.code.setMode("edit").then(() => 1)`);
    await ev(`(() => { const t = ${TA}; t.value = ${JSON.stringify(text)}; t.dispatchEvent(new Event("input")); return 1; })()`);
  };
  const left = (run) => ev(`JSON.parse(sessionStorage.getItem("left-${run}") ?? "null")`);
  const state = () => ev(`({ at: location.search, readOnly: ${TA}?.readOnly ?? null, banner: document.getElementById("sb-disk-banner")?.textContent ?? "" })`);
  const wsText = () => ev(`window.ws.read("/a.py").then((r) => new TextDecoder().decode(r.content))`);
  await send("Page.enable");

  // 1. held
  await open(1, "held edit\n");
  await ev("(window.hold = true, 1)");
  await ev(`(document.querySelector(".code-page .code-close").click(), 1)`);
  await sleep(2500);
  let s = await state();
  check(s.at === "?run=1" && !(await left(1)) && /Not saved yet/.test(s.banner), "✕, the disk's write held: the page stays, and says so: " + JSON.stringify(s));
  check(s.readOnly === false && (await wsText()) === "held edit\n", "…the edit kept in the workspace, and typing back");
  await ev("(window.hold = false, window.release(), 1)");
  await until("window.m.pending === 0");
  await ev(`(document.querySelector(".code-page .code-close").click(), 1)`);
  check(await until(`!!sessionStorage.getItem("left-1")`), "released: ✕ leaves");
  let l = await left(1);
  check(l?.disk?.["/a.py"] === "held edit\n" && l.pending === 0, "…with the edit on disk: " + JSON.stringify(l));

  // 2. failing
  await open(2, "failed edit\n");
  await ev("(window.fail = true, 1)");
  await ev(`(document.querySelector(".code-page .code-close").click(), 1)`);
  await sleep(2500);
  s = await state();
  check(s.at === "?run=2" && !(await left(2)) && /Not saved yet/.test(s.banner) && /the disk is full \(test\)/.test(s.banner) && s.readOnly === false, "✕, the disk's write failing: the page stays, saying why: " + JSON.stringify(s));

  // 3. a copy, held
  await open(3, "copied edit\n");
  await until("window.m.pending === 0");
  await ev("(window.hold = true, 1)");
  await ev(`(document.querySelector('.code-page [data-f="c-copy"]').click(), 1)`);
  await sleep(3000);
  s = await state();
  const copied = await ev(`window.ws.read("/a (copy).py").then((r) => new TextDecoder().decode(r.content), () => null)`);
  check(copied === "copied edit\n" && s.at === "?run=3" && !(await left(3)) && /Not saved yet/.test(s.banner) && s.readOnly === false, "File ▸ Save a copy, the disk held: the copy made, the page stays, typing back: " + JSON.stringify({ copied, ...s }));
  await ev(`(document.querySelector('.code-page [data-f="c-copy"]').click(), 1)`);
  check(await until(`window.ws.read("/a (copy) (2).py").then(() => true, () => false)`, 5000), "…and a second copy may be made");
  await ev("(window.hold = false, window.release(), 1)");

  // 4. the control
  await open(4, "plain edit\n");
  await ev(`(document.querySelector(".code-page .code-close").click(), 1)`);
  check(await until(`!!sessionStorage.getItem("left-4")`), "the control, nothing held: ✕ leaves");
  l = await left(4);
  check(l?.disk?.["/a.py"] === "plain edit\n" && l.pending === 0, "…with the edit on disk: " + JSON.stringify(l));

  const fails = results.filter(([ok]) => !ok);
  console.log(fails.length ? `FAIL: ${fails.length} of ${results.length} checks` : `ok: the code page leaves the desktop app's pages only once the disk has its changes, ${results.length} checks`);
  code = fails.length ? 1 : 0;
  cdp.close();
} catch (e) {
  console.error("FAIL", e?.stack ?? e);
} finally {
  chrome.kill();
  server.stop(true);
  await sleep(200);
  rmSync(profile, { recursive: true, force: true });
  rmSync(site, { recursive: true, force: true });
}
process.exit(code);
