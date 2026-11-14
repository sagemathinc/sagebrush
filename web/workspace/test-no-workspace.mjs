// ci: web-runner order=402 runner=bun chrome
// A page whose workspace can't be opened saves nothing (the reverted-edit fix, its fix 1): on the real page (web/dist,
// served by web/serve.py), another tab of the browser holds the workspace's database at an earlier version, so the
// page's upgrade waits until its open gives up (WS_OPEN_MS) and the page goes on without its workspace, saying so (the
// loss notice).  Its save gate is then shut: a cell typed into is in neither the notebooks' records nor their
// histories, and the page says it isn't saved.  The holder's own record of the upgrade it held (versionchange) is
// checked too, so a run whose upgrade wasn't held can't pass.  Before the fix, the gate stayed open: the typed text
// was saved, its fence never checked, and recorded into the shared history.
//   bun web/build.ts && CHROME=chromium bun web/workspace/test-no-workspace.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort, freePort } from "../test-port.mjs";

const here = new URL(".", import.meta.url).pathname;
const J = JSON.stringify;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let checks = 0;
const fails = [];
const check = (ok, what) => { checks++; if (!ok) fails.push(what); };

const port = await freePort();
const server = spawn("python3", [join(here, "..", "serve.py"), String(port)], { stdio: "ignore" });
const profile = mkdtempSync(join(tmpdir(), "sb-nows-"));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
const cleanup = () => { try { chrome.kill(); } catch {} try { server.kill(); } catch {} try { rmSync(profile, { recursive: true, force: true }); } catch {} };
setTimeout(() => { console.log("FAIL: the run did not finish in 3 min (a hang)"); cleanup(); process.exit(1); }, 180_000).unref();
const cdp = await devtoolsPort(profile);
const origin = `http://127.0.0.1:${port}`;
for (let i = 0; i < 100; i++) { try { await fetch(origin + "/"); break; } catch { await sleep(100); } }

// (a tab: its own CDP socket, evaluate, and navigate)
async function tab(url) {
  const t = await (await fetch(`http://127.0.0.1:${cdp}/json/new?about:blank`, { method: "PUT" })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let n = 0;
  const waiting = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); } };
  const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(J({ id, method, params })); });
  const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r?.exceptionDetails) throw new Error(J(r.exceptionDetails).slice(0, 400)); return r?.result?.value; };
  const until = async (expr, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await ev(expr).catch(() => false)) return true; await sleep(200); } return false; };
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Page.navigate", { url });
  return { ev, until };
}

try {
  // ---- the holder: the workspace's database at version 1, held open, no versionchange handler (an older tab's)
  const H = await tab(origin + "/robots.txt");
  await H.until("document.readyState === 'complete'", 10_000);
  const held = await H.ev(`new Promise((ok) => { const r = indexedDB.open("sagebrush-workspace", 1); r.onsuccess = () => { window.__held = r.result; window.__vc = []; r.result.onversionchange = (e) => window.__vc.push(e.oldVersion + "->" + e.newVersion); ok("v" + r.result.version); }; r.onerror = () => ok("error " + r.error); })`);
  check(held === "v1", `the holder holds the workspace's database at version 1 (${held})`);
  // ---- the page: its workspace's upgrade waits on the holder until it gives up; the page goes on without it.  (It
  // opens no notebook then: it stays "loading…".  If a later change lets it open one, the typing below runs too)
  const O = await tab(origin + "/");
  const gaveUp = await O.until(`/did not open|can't be opened|couldn't be opened/.test(document.body.innerText)`, 45_000);
  const vc = await H.ev("window.__vc");
  check(gaveUp && Array.isArray(vc) && vc.some((x) => x.startsWith("1->")), `the page went on without its workspace, its upgrade held by the holder: ` + J({ gaveUp, vc }));
  const came = await O.until(`document.querySelectorAll("#cells .cell textarea").length > 0`, 5_000);
  const TYPED = "typed with no workspace " + Date.now();
  let said = "";
  if (came) {
    await O.ev(`(() => { const ta = document.querySelector("#cells .cell textarea"); ta.focus(); ta.value = ${J(TYPED)}; ta.dispatchEvent(new Event("input", { bubbles: true })); })()`);
    await sleep(2500);
    said = await O.ev(`document.querySelector("#saved")?.textContent ?? ""`);
  }
  // (what this browser keeps, read by the holder: every notebook's record, and every history row)
  const kept = await H.ev(`(async () => {
    const all = (name, store) => new Promise((ok) => { const r = indexedDB.open(name); r.onsuccess = () => { const db = r.result; if (!db.objectStoreNames.contains(store)) { db.close(); return ok([]); } const g = db.transaction(store).objectStore(store).getAll(); g.onsuccess = () => { db.close(); ok(g.result); }; g.onerror = () => { db.close(); ok([]); }; }; r.onerror = () => ok([]); });
    const recs = (await all("sagebrush", "notebooks")).filter((x) => x.id !== "__sagebrush-workspace__"), hist = await all("sagebrush-history", "history");
    return { records: recs.length, history: hist.length, typed: [...recs, ...hist].filter((x) => JSON.stringify(x).includes(${J(TYPED)})).length };
  })()`);
  check(came ? kept.typed === 0 && /not saved/.test(said) : kept.records === 0 && kept.history === 0, `a page without its workspace writes no notebook and no history (` + (came ? "a cell typed into: not saved, said" : "no notebook opened") + "): " + J({ came, ...kept, said: said.slice(0, 120) }));
} catch (e) {
  fails.push("threw: " + String(e?.stack ?? e).slice(0, 500));
}
cleanup();
console.log(fails.length ? `FAIL: ${fails.length} of ${checks} checks\n  ` + fails.join("\n  ") : `ok: a page without its workspace, ${checks} checks`);
process.exit(fails.length ? 1 : 0);
