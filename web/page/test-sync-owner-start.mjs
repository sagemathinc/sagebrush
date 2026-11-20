// ci: web-runner order=486 chrome
// The page's sync owner (web/workspace/sync-owner.ts) starts once the page's startup is done, by any path
// (web/index.html's bootDone, resolved in the startup's finally): its first reads of the workspace never run alongside
// the first document's load, and a page whose first load fails, or that has no document, still starts it.
//  1. a notebook's first load that succeeds: the owner starts, and only once the notebook's cells are there;
//  2. a first load that fails (the last notebook's record broken): the owner still starts;
//  3. a page with no document (a code file's page for an id that isn't there): the owner still starts.
// The owner's start is seen as its lifecycle channel being made (sagebrush-sync-life:), noted by a script that runs
// before the page's own.
// Serve web/dist first (python3 web/serve.py 8765), then
//   node web/page/test-sync-owner-start.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort } from "../test-port.mjs";

const base = process.env.SB_URL ?? "http://127.0.0.1:8765/";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = JSON.stringify;
const profile = mkdtempSync(join(tmpdir(), "sb-owner-start-"));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--remote-debugging-port=0", "--window-size=1280,860", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
const port = await devtoolsPort(profile);
const fails = [];
let checks = 0;
const check = (ok, what, detail) => { checks++; console.log((ok ? "ok   " : "FAIL ") + what + (ok || detail === undefined ? "" : " " + J(detail).slice(0, 500))); if (!ok) fails.push(what); return ok; };

// (before the page's own scripts: the owner's lifecycle channel noted when it is made, with how many cells there were)
const noteOwner = `(() => {
  const B = globalThis.BroadcastChannel;
  window.__ownerStart = null;
  globalThis.BroadcastChannel = class extends B {
    constructor(name) {
      super(name);
      if (!window.__ownerStart && String(name).startsWith("sagebrush-sync-life:")) window.__ownerStart = { cells: document.querySelectorAll("#cells .cell").length };
    }
  };
})();`;

/** A tab at `path`, the note installed first. */
async function page(path) {
  const t = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let n = 0;
  const waiting = new Map(), seen = { errors: [] };
  const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(J({ id, method, params })); });
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); }
    if (m.method === "Runtime.exceptionThrown") seen.errors.push((m.params.exceptionDetails?.exception?.description ?? "").slice(0, 200));
  };
  for (const m of ["Page.enable", "Runtime.enable"]) await send(m);
  await send("Page.addScriptToEvaluateOnNewDocument", { source: noteOwner });
  await send("Page.navigate", { url: new URL(path, base).href });
  const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); return r?.result?.value; };
  const until = async (expr, ms) => { const s = Date.now(); while (Date.now() - s < ms) { if (await ev(expr).catch(() => false)) return true; await sleep(100); } return false; };
  return { ev, until, seen, close: async () => { try { ws.close(); } catch {} await fetch(`http://127.0.0.1:${port}/json/close/${t.id}`).catch(() => {}); } };
}

try {
  // 1. a first load that succeeds (the Welcome)
  {
    const p = await page("./");
    const started = await p.until("!!window.__ownerStart", 30000);
    const at = await p.ev("window.__ownerStart");
    check(started, "1. a first load that succeeds: the sync owner starts", { errors: p.seen.errors });
    check(started && at?.cells > 0, "1. …and only once the first notebook's cells are there", { at });
    await p.close();
  }
  // 2. a first load that fails: this browser's last notebook a record that can't be read as one (made here, by the
  // previous page)
  {
    const prep = await page("./");
    await prep.until("!!window.__ownerStart", 30000);
    const made = await prep.ev(`new Promise((ok) => { const r = indexedDB.open("sagebrush"); r.onerror = () => ok(String(r.error)); r.onsuccess = () => { const tx = r.result.transaction("notebooks", "readwrite"); tx.objectStore("notebooks").put({ id: "held-broken", cells: 42 }); tx.oncomplete = () => { r.result.close(); localStorage.setItem("sagebrush-current", "held-broken"); ok(true); }; tx.onerror = () => ok(String(tx.error)); }; })`);
    await prep.close();
    const p = await page("./");
    const started = await p.until("!!window.__ownerStart", 30000);
    const at = await p.ev("window.__ownerStart");
    check(made === true && p.seen.errors.some((e) => /TypeError/.test(e)), "2. the last notebook's record is broken: the first load fails (its error thrown)", { made, at, errors: p.seen.errors });
    check(started, "2. a first load that fails: the sync owner still starts", { errors: p.seen.errors });
    await p.close();
  }
  // 3. a page with no document
  {
    const p = await page("./?code=no-such-file-here");
    const started = await p.until("!!window.__ownerStart", 30000);
    const at = await p.ev("window.__ownerStart");
    check(started, "3. a page with no document (a code page for an id that isn't there): the sync owner still starts", { errors: p.seen.errors });
    check(!started || at?.cells === 0, "3. …with no notebook opened on that page", { at });
    await p.close();
  }
} catch (e) {
  check(false, "the test ran to its end", { error: String(e?.stack ?? e).slice(0, 400) });
} finally {
  chrome.kill();
  await sleep(300);
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
}
console.log(`\n${checks - fails.length}/${checks} checks passed`);
if (fails.length) { console.log("FAILED:\n  " + fails.join("\n  ")); process.exit(1); }
