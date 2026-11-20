// ci: web-sync-ops order=21 runner=bun chrome
// The desktop app's workspace on disk (web/workspace/disk-mirror.ts) in headless Chromium, against a disk in
// memory with disk.rs's verbs: the disk's tree imported into an empty workspace; every change written through
// (create, write, mkdir, rename, Trash and back, emptying Trash, a notebook's save); two "launches" (two
// workspaces, as two origins) finding the same files; a file changed by another program never written over; the
// import's time for a large workspace.  The cases are in disk-mirror-cases.js.
//   CHROME=google-chrome bun web/workspace/test-disk-mirror.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, copyFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort } from "../test-port.mjs";
import { buildGuard, guardScript, guardFiles, guardFails } from "../history/guard-harness.mjs";

const here = new URL(".", import.meta.url).pathname;
const site = mkdtempSync(join(tmpdir(), "sb-disk-site-"));
const built = await Bun.build({ entrypoints: [join(here, "disk-mirror-entry.ts")], outdir: site, naming: "ws.js", target: "browser", format: "esm" });
if (!built.success) {
  console.error(built.logs.join("\n"));
  process.exit(1);
}
// (HISTORY_GUARD=1: the suite run under history's census guard, web/history/guard-harness.mjs)
await buildGuard(site);
copyFileSync(join(here, "disk-mirror-cases.js"), join(site, "cases.js"));
writeFileSync(join(site, "index.html"), `<!doctype html><meta charset="utf-8"><title>disk mirror test</title>${guardScript()}<script type="module">import { run, boardQuit } from "./cases.js"; window.run = run; window.boardQuit = boardQuit; window.ready = true;</script>`);
const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => {
  const p = new URL(req.url).pathname;
  if (!["/", "/ws.js", "/cases.js", ...guardFiles].includes(p)) return new Response("not found", { status: 404 });
  return new Response(Bun.file(join(site, p === "/" ? "index.html" : p.slice(1))), { headers: { "content-type": p.endsWith(".js") ? "text/javascript" : "text/html" } });
} });

let port = Number(process.env.CDP_PORT) || 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), "sb-disk-"));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--js-flags=--expose-gc", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
let code = 1;
try {
  if (!port) port = await devtoolsPort(profile);
  let targets;
  for (let i = 0; i < 300; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); if (targets.some((t) => t.type === "page")) break; } catch {} await sleep(100); }
  const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let n = 0;
  const waiting = new Map(), errors = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); }
    if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails?.exception?.description ?? JSON.stringify(m.params.exceptionDetails));
  };
  const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
  const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 2000)); return r.result?.value; };
  await send("Runtime.enable");
  await send("Page.navigate", { url: `http://127.0.0.1:${server.port}/` });
  for (let i = 0; i < 200 && !(await ev("window.ready === true").catch(() => false)); i++) await sleep(50);
  const all = await ev("window.run()");
  // (the board page's quit answered with real input: the mouse on "Quit and lose…", and, a second time, the keyboard)
  {
    const input = (method, params) => Promise.race([send(method, params), new Promise((r) => setTimeout(() => r("timeout"), 3000))]);
    await send("Emulation.setFocusEmulationEnabled", { enabled: true });
    const mouse = async (x, y) => { for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await input("Input.dispatchMouseEvent", { type, x, y, button: type === "mouseMoved" ? "none" : "left", clickCount: 1 }); };
    const key = async (k, code, vk) => { for (const type of ["keyDown", "keyUp"]) await input("Input.dispatchKeyEvent", { type, key: k, code, windowsVirtualKeyCode: vk, ...(type === "keyDown" && k === "Enter" ? { text: "\r", unmodifiedText: "\r" } : {}) }); };
    let q = await ev("window.boardQuit()");
    all.push([!!q.inert && !!q.wait && !!q.quit, `the board's quit (its body inert): the question shows, its buttons placed (${JSON.stringify(q)})`]);
    if (q.quit) await mouse(q.quit.x, q.quit.y);
    await ev("Promise.race([window.__bq.done, new Promise((r) => setTimeout(r, 3000))]).then(() => true)");
    all.push([(await ev("window.__bq.calls")).at(-1) === "app_quit_now", "the board's quit: a real click on \"Quit and lose…\" quits"]);
    q = await ev("window.boardQuit()");
    all.push([q.focused === "Wait", `the board's quit: the keyboard's focus on "Wait" (${q.focused})`]);
    await key("Enter", "Enter", 13);
    await new Promise((r) => setTimeout(r, 400));
    const waited = await ev("window.__bq.calls");
    all.push([!waited.includes("app_quit_now") && (await ev("window.__bq.m.pending")) === 1 && (await ev("document.querySelector('#sb-quitting')?.textContent ?? ''")).length > 0, "the board's quit: Enter on \"Wait\" waits (not quit)"]);
    for (let i = 0; i < 50 && !(await ev("!!document.querySelector('#sb-quitting button')")); i++) await new Promise((r) => setTimeout(r, 50));
    await key("Tab", "Tab", 9);
    all.push([(await ev("document.activeElement?.textContent ?? ''")).startsWith("Quit and lose"), "the board's quit: Tab moves the focus to \"Quit and lose…\""]);
    await key("Enter", "Enter", 13);
    await ev("Promise.race([window.__bq.done, new Promise((r) => setTimeout(r, 3000))]).then(() => true)");
    all.push([(await ev("window.__bq.calls")).at(-1) === "app_quit_now", "the board's quit: Tab to \"Quit and lose…\", Enter quits"]);
  }
  // (OBS lines: observations printed, never failed on, not counted as checks)
  const obs = all.filter(([, what]) => what.startsWith("OBS ")).map(([, what]) => what), results = all.filter(([, what]) => !what.startsWith("OBS "));
  for (const o of obs) console.log(o);
  const fails = results.filter(([ok]) => !ok).map(([, what]) => what);
  for (const e of errors) fails.push("page error: " + e);
  fails.push(...(await guardFails(ev)));
  if (fails.length) console.error(`FAIL: ${fails.length} of ${results.length} checks\n  ` + fails.join("\n  "));
  else {
    console.log(`ok: the workspace on disk, ${results.length} checks`);
    if (process.env.SHOW) for (const [, what] of results) console.log("  " + what);
    code = 0;
  }
  ws.close();
} finally {
  chrome.kill();
  server.stop(true);
  await sleep(200);
  rmSync(profile, { recursive: true, force: true });
  rmSync(site, { recursive: true, force: true });
}
process.exit(code);
