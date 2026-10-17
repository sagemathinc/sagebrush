// A board's code runs even when its outputs' cache never answers: an
// IndexedDB open of "sagebrush-outputs" queued, for good, behind another
// page's upgrade that waits on a connection never closed.  That is what kept
// examples/live.json's code from ever running in test-export.mjs, from time
// to time: the board waited on the cache's read before running anything
// (web/board/code.ts, web/board/idb-open.ts).  Here the stall is made on
// purpose, so it happens every time: tab A holds the database open (no
// versionchange handler) and asks for version 2 (blocked); in tab B every
// open of version 1 then waits behind it, and the live board must still run
// all its code.  Serve web/dist first (python3 web/serve.py PORT), then
//   SB_URL=http://127.0.0.1:PORT/ node web/board/test-idb-stall.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort } from "../test-port.mjs";

const site = process.env.SB_URL ?? "http://127.0.0.1:8765/";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), "sb-idb-stall-"));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
let failures = 0, count = 0;
const ok = (c, what) => { count++; console.log((c ? "ok   " : "FAIL ") + what); if (!c) failures++; };
// (the whole test bounded: it says where it was rather than holding a CI slot)
let at = "starting Chrome";
setTimeout(() => { console.log(`FAIL the test did not end within 180 s; it was at: ${at}`); chrome.kill("SIGKILL"); process.exit(1); }, 180_000).unref();

async function tab(port, first) {
  const t = first ?? (await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json());
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let n = 0;
  const waiting = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); } };
  const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
  const ev = async (expression, ms = 30000) => {
    const r = await Promise.race([send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }), sleep(ms).then(() => ({ timedOut: true }))]);
    if (r?.timedOut || r?.exceptionDetails) return undefined;
    return r?.result?.value;
  };
  const until = async (expr, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await ev(expr, Math.max(1000, ms - (Date.now() - t0)))) return true; await sleep(100); } return false; };
  return { send, ev, until, close: () => ws.close() };
}

try {
  const port = await devtoolsPort(profile);
  let targets;
  for (let i = 0; i < 300; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); break; } catch { await sleep(100); } }
  // tab A: a page of the site holding the cache's database, and asking for an upgrade it blocks itself
  at = "tab A";
  const a = await tab(port, targets.find((t) => t.type === "page"));
  await a.send("Page.navigate", { url: `${site}board/` });
  await a.until("document.readyState === 'complete'", 30000);
  const held = await a.ev(`new Promise((res) => {
    const o = indexedDB.open("sagebrush-outputs", 1);
    o.onupgradeneeded = () => { const db = o.result; db.createObjectStore("entries", { keyPath: ["doc", "key"] }).createIndex("doc", "doc"); db.createObjectStore("docs", { keyPath: "doc" }); };
    o.onsuccess = () => {
      window.__held = o.result; // (no onversionchange: never closed)
      const up = indexedDB.open("sagebrush-outputs", 2);
      up.onblocked = () => res("blocked");
      up.onsuccess = () => res("upgraded");
      up.onerror = () => res("error");
    };
    o.onerror = () => res("open failed");
  })`, 10000);
  ok(held === "blocked", "(tab A holds the database, and its own upgrade to version 2 waits on it: " + held + ")");
  // tab B: an open of version 1 there gets no answer at all (the stall the board met)
  at = "tab B";
  const b = await tab(port);
  await b.send("Page.navigate", { url: `${site}board/?doc=${encodeURIComponent("examples/live.json")}` });
  const silent = await b.ev(`new Promise((res) => { const o = indexedDB.open("sagebrush-outputs", 1); o.onsuccess = () => { o.result.close(); res("opened"); }; o.onerror = () => res("error"); o.onblocked = () => res("blocked"); setTimeout(() => res("no answer"), 2000); })`, 10000);
  ok(silent === "no answer", "(in tab B an open of the cache's database gets no answer: " + silent + ")");
  // ...and the board's code runs all the same, every item of it
  at = "the board's code";
  const ran = await b.until("window.sagebrush?.board?.outputs?.().then((os) => os.length === 5 && os.every((o) => o.state === '') && /^111 steps/.test(os.find((o) => o.id === 'path')?.output ?? ''))", 60000);
  ok(ran, "with its outputs' cache stalled, the board runs all its code: " + JSON.stringify(await b.ev("window.sagebrush?.board?.outputs?.().then((os) => os.map((o) => [o.id, o.state]))", 5000)));
  a.close(); b.close();
} catch (e) {
  failures++;
  console.log("FAIL " + (e?.stack ?? e));
} finally {
  chrome.kill("SIGKILL");
  await sleep(300);
  rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
console.log(failures ? `${failures} of ${count} failed` : `all ${count} passed`);
process.exit(failures ? 1 : 0);
