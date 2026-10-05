// End-to-end checks of the atlas in headless Chromium: server-rendered pages,
// JSON, search, recomputing a stored space in the browser and comparing it,
// computing a space that is not stored, Sato-Tate from a_p computed in the
// page.  Against the local server (node web/atlas/serve.mjs) or production:
//   SB_URL=https://sagebrush.space node web/atlas/test-atlas.mjs
//   SHOTS=/tmp/shots ...      also saves screenshots
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const base = (process.env.SB_URL ?? "http://127.0.0.1:8766").replace(/\/$/, "");
const shots = process.env.SHOTS;
if (shots) mkdirSync(shots, { recursive: true });
const profile = mkdtempSync(join(tmpdir(), "sb-atlas-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--disable-gpu", "--remote-debugging-port=9338", `--user-data-dir=${profile}`, "--window-size=1200,900", "about:blank"], { stdio: "ignore" });
let targets;
for (let i = 0; i < 100; i++) { try { targets = await (await fetch("http://127.0.0.1:9338/json")).json(); break; } catch { await sleep(100); } }
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let n = 0; const waiting = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); } };
const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "eval failed"); return r.result.value; };
const until = async (expr, ms = 30000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr)) return true; await sleep(200); } throw new Error("timeout: " + expr); };
const ok = (c, msg) => { console.log((c ? "ok   " : "FAIL ") + msg); if (!c) process.exitCode = 1; };
const open = async (path) => { await send("Page.navigate", { url: base + path }); await sleep(300); await until("document.readyState === 'complete'"); };
const text = () => ev("document.querySelector('main').innerText");
async function shot(name) {
  if (!shots) return;
  const r = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  writeFileSync(join(shots, name + ".png"), Buffer.from(r.data, "base64"));
}

try {
  await send("Page.enable");
  await open("/atlas/");
  let t = await text();
  ok(/Every Galois orbit of newforms/.test(t) && /5,951 weight-2 orbits agree with the LMFDB/.test(t), "front page: coverage and LMFDB agreement");
  ok(await ev("!!document.querySelector('a[href=\"/atlas/mf/?weight=2&level=1-50\"]')"), "front page: browse table links to searches");
  await shot("home");

  await open("/atlas/mf/389.2.a");
  t = await text();
  ok(/389\.2\.a\.e/.test(t) && /Newforms/.test(t) && /Decomposition of the old subspace/.test(t), "newspace 389.2.a: orbits, old space");
  await shot("space-389");
  await ev("document.querySelector('[data-verify]').click()");
  await until("/Identical|Differs|Could not/.test(document.querySelector('#verify-status').textContent)", 120000);
  const v = await ev("document.querySelector('#verify-status').textContent");
  ok(/✓ Identical to the stored data: 5 orbits/.test(v), "389.2.a recomputed in the browser: " + v);

  await open("/atlas/mf/389.2.a.a");
  t = await text();
  ok(/q − 2q2 − 2q3 \+ 2q4 − 3q5/.test(t.replace(/\s+/g, " ")) && /389a1/.test(t) && /rank 2/.test(t) && /−1/.test(t), "389.2.a.a: q-expansion, curve 389a1 of rank 2");
  ok(/even analytic rank/.test(t), "389.2.a.a: sign +1, even analytic rank");
  await shot("orbit-389a");
  await ev("document.querySelector('[data-st]').click()");
  await until("/primes p < 10⁶|Could not/.test(document.querySelector('#st-status').textContent)", 60000);
  ok(/78,49\d primes p < 10⁶/.test(await ev("document.querySelector('#st-status').textContent")), "Sato-Tate from a_p, p < 10^6, computed in the page: " + (await ev("document.querySelector('#st-status').textContent")));

  await open("/atlas/mf/27.2.a.a");
  ok(/complex multiplication by ℚ\(√−3\)/.test(await text()), "27.2.a.a: CM by Q(sqrt -3)");
  await open("/atlas/mf/23.2.a.a");
  t = await text();
  ok(/x2 \+ x − 1/.test(t.replace(/\s+/g, " ")) && /ℚ\(√5\)/.test(t), "23.2.a.a: coefficient field Q(sqrt 5), x^2 + x - 1");
  await open("/atlas/mf/1.12.a.a");
  ok(/q − 24q2 \+ 252q3 − 1472q4/.test((await text()).replace(/\s+/g, " ")), "1.12.a.a: Ramanujan's Delta");

  await open("/atlas/mf/1.24.a");
  await until("/Newforms/.test(document.querySelector('main').innerText) || /Could not/.test(document.querySelector('main').innerText)", 180000);
  t = await text();
  ok(/1\.24\.a\.a/.test(t) && /computed in your browser/.test(t), "1.24.a computed in the browser: " + (t.match(/Computed in your browser[^:]*in [\d.]+ s/) ?? [""])[0]);
  await shot("space-1-24");
  await open("/atlas/mf/1.24.a.a");
  await until("/Trace form/.test(document.querySelector('main').innerText)", 60000);
  t = (await text()).replace(/\s+/g, " ");
  ok(/2q \+ 1080q2 \+ 339480q3/.test(t), "1.24.a.a from this tab's computation: trace form 2q + 1080q^2 + 339480q^3 + ...");

  await open("/atlas/mf/?weight=2&level=1-100&dim=1&rank=1");
  t = await text();
  ok(/37\.2\.a\.a/.test(t) && /orbits?;/.test(t), "search: rank-1 curves of conductor <= 100: " + (t.match(/\d+ orbits?/) ?? [""])[0]);
  await open("/atlas/mf/?q=11a1");
  ok((await ev("location.pathname")) === "/atlas/mf/11.2.a.a", "the search box jumps from Cremona's 11a1 to 11.2.a.a");
  const j = await (await fetch(base + "/atlas/mf/389.2.a.e.json")).json();
  ok(j.dim === 20 && j.traces.length === 1000 && j.lmfdb === "agrees" && j.status === "proven", "389.2.a.e.json: dim 20, 1000 traces, proven, LMFDB agrees");
  const s = await (await fetch(base + "/atlas/mf/?rank=3&format=json")).json();
  ok(s.total === 0, "no stored curve of rank 3 below conductor 1000");
} catch (e) {
  console.log("ERROR", e.message);
  process.exitCode = 1;
} finally {
  ws.close();
  chrome.kill();
  setTimeout(() => rmSync(profile, { recursive: true, force: true }), 500);
}
