// ci: web-sync.2 order=50 chrome
// A kept copy whose read never gives data doesn't hold its request: the service worker gives the read up after
// READ_STALL_MS (half web/stall-fetch.js's bound) and answers from the network (web/sw.js check(); the grader's
// plain-worker investigation: VM1, Nov 3, a cache-hit body read that never settled held a Sage run for good).  The
// test build's hook holds one read on purpose (holdRead: the next cache hit for that URL gets a body that never gives
// data), with the time scale at 0.1 (the bound 1 s).  The control: the same build with the bound taken out, as a
// new deploy, where the same held read leaves the request unanswered.
//
// The test build's service worker is web/dist-test/sw.test.js when there is one (SAGEBRUSH_OFFLINE_TEST=1); else it is
// made here as the build makes it: web/sw.js with the values the build gave web/dist/sw.js (each line of the five
// checked to be there once), so a plain build, as CI's, runs it too.
//
//   bun web/build.ts && node web/test-sw-read-stall.mjs      (CHROME=... for the browser)
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort, freePort } from "./test-port.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0, count = 0;
const ok = (cond, name) => { count++; console.log((cond ? "ok   " : "FAIL ") + name); if (!cond) failures++; return cond; };
const here = new URL(".", import.meta.url).pathname;
const tmp = mkdtempSync(join(tmpdir(), "sb-sw-stall-"));
let testSw = join(here, "dist-test", "sw.test.js");
if (!existsSync(testSw)) {
  const shipped = readFileSync(join(here, "dist", "sw.js"), "utf8");
  let made = readFileSync(join(here, "sw.js"), "utf8");
  for (const [name, hole] of [["VERSION", '"__VERSION__"'], ["SHELL", "__SHELL__"], ["LAZY", "__LAZY__"], ["DIGESTS", "__DIGESTS__"], ["STALL_LIMIT_MS", "__STALL_LIMIT_MS__"]]) {
    const lines = shipped.split("\n").filter((l) => l.startsWith(`const ${name} = `));
    const holes = made.split(`const ${name} = ${hole};`).length - 1;
    if (lines.length !== 1 || holes !== 1) throw new Error(`web/dist/sw.js or web/sw.js: const ${name} not there once (${lines.length}, ${holes})`);
    made = made.replace(`const ${name} = ${hole};`, () => lines[0]);
  }
  testSw = join(tmp, "sw.test.js");
  writeFileSync(testSw, made);
}
const SW = readFileSync(testSw, "utf8");
if (!SW.includes("// <offline-test>")) throw new Error("the test service worker has no hook block");
const A = /^const VERSION = "([0-9a-f]{16})";$/m.exec(SW)[1];
const DIGESTS = JSON.parse(/^const DIGESTS = (.*);$/m.exec(SW)[1]);
const BOUND_LINE = "const READ_STALL_MS = STALL_LIMIT_MS / 2;";
if (!SW.includes(BOUND_LINE)) throw new Error("sw.test.js has no READ_STALL_MS line");
// (a small library chunk, served cache-first)
const chunk = Object.keys(DIGESTS).find((p) => /^lib\/core\.src\.[0-9a-f]{16}\.json$/.test(p));
const want = DIGESTS[chunk], url = "/" + chunk;

const overridesFile = join(tmp, "overrides.json"), logFile = join(tmp, "requests.log");
const overrides = { "/sw.js": { file: testSw } };
const saveOverrides = () => writeFileSync(overridesFile, JSON.stringify(overrides));
saveOverrides();
writeFileSync(logFile, "");
const fromServer = () => readFileSync(logFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).path).filter((p) => p === url).length;
const port = await freePort();
const server = spawn("python3", [join(here, "serve.py"), String(port)], { stdio: "ignore", env: { ...process.env, SB_SERVE_OVERRIDES: overridesFile, SB_SERVE_LOG: logFile } });
await sleep(800);
const profile = mkdtempSync(join(tmpdir(), "sb-sw-stall-p-"));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
const cleanup = () => { chrome.kill(); server.kill(); };
let at = "starting";
setTimeout(() => { console.log(`FAIL the run did not finish in 180 s; it was at: ${at}`); cleanup(); process.exit(1); }, 180_000).unref();

try {
  const cdpPort = await devtoolsPort(profile);
  let targets;
  for (let i = 0; i < 300; i++) { try { targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json(); break; } catch { await sleep(100); } }
  const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let n = 0;
  const waiting = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); } };
  const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
  const ev = async (expression) => (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result?.value;
  const until = async (f, ms) => { for (let i = 0; i < ms / 100; i++) { if (await f()) return true; await sleep(100); } return false; };
  const J = JSON.stringify;
  const hook = (t = {}) => ev(`new Promise((resolve) => {
    const c = new MessageChannel(); setTimeout(() => resolve(null), 10000);
    c.port1.onmessage = (e) => resolve(e.data);
    navigator.serviceWorker.controller.postMessage({ offlineTest: ${J(t)} }, [c.port2]);
  })`);
  // (T565-QUIESCE, grader: the service worker idle: no reservation held or waited for, no check running or queued, no
  // key marked, no put in flight (a request's copy is put, then read back, in the background), three polls in a row;
  // every phase starts from here, so what it snapshots or holds is its own)
  // (settled: the background work done, a key's mark aside; idle: settled and no key marked)
  const counters = (h) => J({ budgetUsed: h?.budgetUsed, waiting: h?.waiting, checking: h?.checking, putting: h?.putting, serialBusy: h?.serialBusy, skipping: h?.skipping });
  const calmUntil = async (marks) => {
    let calm = 0, last;
    for (let i = 0; i < 150 && calm < 3; i++) {
      last = await hook();
      calm = last && last.budgetUsed === 0 && last.waiting === 0 && last.checking === 0 && last.putting === 0 && last.serialBusy === 0 && (marks || last.skipping === 0) ? calm + 1 : 0;
      if (calm < 3) await sleep(100);
    }
    if (calm < 3) throw new Error(`the service worker never went ${marks ? "settled" : "idle"}: ${counters(last)}`);
    return last;
  };
  const quiesce = () => calmUntil(false), settle = () => calmUntil(true);
  // (the chunk fetched by the page, through its service worker, within `ms`: its size and SHA-256, or a timeout)
  const get = (ms) => ev(`new Promise((resolve) => {
    const t0 = performance.now(), t = setTimeout(() => resolve({ timeout: true, ms: performance.now() - t0 }), ${ms});
    fetch(${J(url)}).then((r) => r.arrayBuffer()).then(async (b) => {
      const h = [...new Uint8Array(await crypto.subtle.digest("SHA-256", b))].map((x) => x.toString(16).padStart(2, "0")).join("");
      clearTimeout(t); resolve({ size: b.byteLength, sha256: h, ms: performance.now() - t0 });
    }, (e) => (clearTimeout(t), resolve({ error: String(e), ms: performance.now() - t0 })));
  })`);
  const kept = (v) => ev(`caches.open(${J("sagebrush-" + v)}).then((c) => c.match(${J(url)})).then((r) => !!r)`);
  const clearHttp = async () => { await send("Network.enable"); await send("Network.clearBrowserCache"); };

  at = "the page, controlled by the test build's service worker";
  await send("Page.navigate", { url: `http://127.0.0.1:${port}/` });
  let controlled = await until(async () => (await ev("!!navigator.serviceWorker?.controller")) === true, 15000);
  if (!controlled) { await send("Page.reload"); controlled = await until(async () => (await ev("!!navigator.serviceWorker?.controller")) === true, 30000); }
  ok(controlled && (await hook())?.version === A, "the page is controlled by the test build's service worker");

  // (each build: the chunk fetched once so a copy is kept, then that copy's read held)
  async function heldRead(v, ms) {
    const first = await get(30000);
    ok(first.size === want.size && first.sha256 === want.sha256, `${v}: the chunk fetched once (${first.size ?? first.error ?? "timeout"})`);
    ok(await until(() => kept(v), 15000), `${v}: …and kept by the service worker`);
    await quiesce();
    await hook({ scale: 0.1, holdRead: url });
    await clearHttp();
    const before = fromServer(), h0 = await hook(), budget = h0?.budgetUsed;
    const r = await get(ms);
    const h1 = await hook();
    // (the deletes of the chunk's entry while it was read)
    const deleted = (h1?.deletes ?? []).slice(h0?.deletes?.length ?? 0).filter((k) => k.endsWith(url)).length;
    return { r, network: fromServer() - before, held: h1?.heldReads, budget, deleted };
  }

  at = "a held read, with the bound";
  const fixed = await heldRead(A, 15000);
  ok(fixed.held === 1, "the kept copy's read was held: " + fixed.held);
  ok(fixed.r.size === want.size && fixed.r.sha256 === want.sha256, "…and the request is answered, the right bytes: " + J(fixed.r));
  ok(fixed.network === 1, "…from the network: the server served it once more: " + fixed.network);
  ok(fixed.r.ms >= 900 && fixed.r.ms < 8000, `…after the bound (1 s at scale 0.1), not before and not much after: ${Math.round(fixed.r.ms)} ms`);
  // (the network's copy, once put, ends the key's mark at once, well inside STALL_SKIP_MS: the kept copy is read again)
  const settled = await settle();
  ok(settled.skipping === 0, "…and once the network's copy is put, the key isn't marked any more: " + counters(settled));
  // (T565-RELEASE, grader: the stalled read's reservation released, so stalls can't drain the budget into reserve())
  const after = await until(async () => (await hook())?.budgetUsed === fixed.budget, 3000);
  ok(after, `…its reservation released: the budget back to ${fixed.budget} B (now ${(await hook())?.budgetUsed} B)`);
  // (T565-KEPT, grader: a stalled read isn't a wrong copy: the entry stays)
  ok(fixed.deleted === 0 && (await kept(A)), `…and the kept copy is left as it was: not deleted (${fixed.deleted} deletes), still there`);
  // (T565-SERIAL, grader's advisory: two requests for the held URL at once: the second waits its turn behind the
  // stalled check, then reads the copy; both answered, the chain of checks empty after)
  at = "two requests at once, the first one's read held";
  await quiesce();
  await hook({ holdRead: url });
  await clearHttp();
  const two = await ev(`Promise.all([0, 1].map(() => {
    const t0 = performance.now();
    return fetch(${J(url)}).then((r) => r.arrayBuffer()).then(async (b) => ({ size: b.byteLength, sha256: [...new Uint8Array(await crypto.subtle.digest("SHA-256", b))].map((x) => x.toString(16).padStart(2, "0")).join(""), ms: performance.now() - t0 }));
  }))`);
  ok(two?.length === 2 && two.every((x) => x.size === want.size && x.sha256 === want.sha256), "both answered, the right bytes: " + J(two?.map((x) => [x.size, Math.round(x.ms)])));
  // (one check of a key at a time: the second request's check waits for the first's, the held one, so neither is
  // answered before the bound; and the later is answered within about two bounds)
  ok(two?.length === 2 && Math.min(...two.map((x) => x.ms)) >= 900, "…one check at a time: the other request waited for the held one's (≥ 1 bound): " + J(two?.map((x) => Math.round(x.ms))));
  ok(two?.length === 2 && Math.max(...two.map((x) => x.ms)) < 2 * 1000 + 3000, "…the later within about two bounds: " + J(two?.map((x) => Math.round(x.ms))));
  let left;
  ok(await until(async () => (left = (await hook())?.checking) === 0, 3000), "…and no check left waiting: " + left);
  // (APP-565-1, sync-docs: an entry that stays stuck: every read of it held. Three requests at once must each end
  // under the clients' bound (2 bounds here): the first stalls once, the others skip the stuck copy for the network,
  // never each stalling in turn behind the one before)
  at = "three requests at once, every read held";
  await until(() => kept(A), 15000);
  await quiesce();
  await hook({ holdRead: url, holdKeep: true });
  await clearHttp();
  const h3 = (await hook())?.heldReads;
  const three = await ev(`Promise.all([0, 1, 2].map(() => {
    const t0 = performance.now();
    return fetch(${J(url)}).then((r) => r.arrayBuffer()).then((b) => ({ size: b.byteLength, ms: performance.now() - t0 }));
  }))`);
  const heldNow = (await hook())?.heldReads - h3;
  await hook({ holdRead: null });
  ok(three?.length === 3 && three.every((x) => x.size === want.size), "the stuck entry: all three answered: " + J(three?.map((x) => [x.size, Math.round(x.ms)])));
  ok(three?.length === 3 && Math.max(...three.map((x) => x.ms)) < 1800, "…each under the clients' bound (2 bounds), none stalling again in turn: " + J(three?.map((x) => Math.round(x.ms))) + `, ${heldNow} read(s) held`);
  // (T565-SKIP-EXPIRES, grader and @sagebrush: the skip mark runs out. With the network refusing the chunk (the server
  // answers 503: offline, in effect), a stalled read marks the key; within STALL_SKIP_MS (6 bounds, 6 s here) the kept
  // copy is skipped, so the request gets the network's refusal; after it, the kept copy is served again)
  at = "the mark runs out, the network refusing";
  await until(() => kept(A), 15000);
  // (the phase before leaves its mark until its network copy is put, in the background: it starts from none, so its
  // own stall is the one that marks the key; CI's run 41619463054 started while the mark was still there)
  const idle = await quiesce();
  ok(idle.skipping === 0, "(the service worker idle before the phase, no key marked: " + idle.skipping + ")");
  overrides[url] = { status: 503 };
  saveOverrides();
  const held0 = (await hook())?.heldReads;
  await hook({ holdRead: url });
  await clearHttp();
  const stalledRead = await get(15000);
  const markedAt = Date.now();
  const after1 = await hook(), heldNow2 = after1?.heldReads - held0;
  await clearHttp();
  const within = await get(5000);
  // (the held read is the request's own check, or the keep it set off reading the same entry first: either way one read
  // stalls, the request waits its turn behind it, and the key is marked)
  ok(heldNow2 === 1 && after1?.skipping === 1 && stalledRead.ms >= 900, `one read of the kept copy stalls, by the phase's first request, and marks the key (${heldNow2} held, ${after1?.skipping} marked, ${Math.round(stalledRead.ms)} ms)`);
  ok(stalledRead.size !== want.size && within.size !== want.size && Date.now() - markedAt < 6000, "after a stall, within STALL_SKIP_MS the kept copy is skipped: the network's refusal both times: " + J([stalledRead.size, within.size]));
  await sleep(Math.max(0, markedAt + 6500 - Date.now()));
  await clearHttp();
  const expired = await get(15000);
  delete overrides[url];
  saveOverrides();
  ok(expired.size === want.size && expired.sha256 === want.sha256, "…and after it, the kept copy is served again (the server still refusing): " + J({ size: expired.size, ms: Math.round(expired.ms ?? 0) }));

  // the control: the same build with the bound taken out, as a new deploy; the same held read is never answered
  at = "the control: the bound taken out";
  const B = "c0" + A.slice(2);
  const mutant = join(tmp, "sw-control.js");
  // (2 ** 30 ms: in setTimeout's range, as a larger delay fires at once)
  writeFileSync(mutant, SW.replace(BOUND_LINE, "const READ_STALL_MS = 2 ** 30;").replace(`const VERSION = "${A}";`, `const VERSION = "${B}";`));
  overrides["/sw.js"] = { file: mutant };
  saveOverrides();
  await clearHttp();
  const changed = await ev(`new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), 60000);
    navigator.serviceWorker.addEventListener("controllerchange", () => (clearTimeout(t), resolve(true)), { once: true });
    navigator.serviceWorker.getRegistration().then((r) => r.update()).catch(() => resolve(false));
  })`);
  ok(changed && (await until(async () => (await hook())?.version === B, 30000)), "(control) the build without the bound controls the page");
  const control = await heldRead(B, 8000);
  ok(control.held === 1 && control.r.timeout === true && control.network === 0, "(control) without the bound, the held read leaves the request unanswered (8 s): " + J(control));
  ws.close();
} catch (e) {
  failures++;
  console.log(`FAIL at ${at}: ${e?.stack ?? e}`);
} finally {
  cleanup();
  await sleep(300);
  rmSync(profile, { recursive: true, force: true });
  rmSync(tmp, { recursive: true, force: true });
}
console.log(failures ? `${failures} of ${count} failed` : `ok: a kept copy's stalled read, ${count} checks`);
process.exit(failures ? 1 : 0);
