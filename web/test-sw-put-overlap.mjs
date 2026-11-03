// ci: none (a reproducer: it reports what a read of a kept copy does while a put of the same key is in flight; sync-docs' put-under-chain follow-up turns it into a test)
// A read during an in-flight put (the grader's plain-worker investigation, VM1 Nov 3: a stalled read was seen with a
// request's put and a read of the same entry overlapping). web/sw.js puts a copy (fetchAndKeep, offlineKeep) outside
// the per-key chain of checks, so a check of a key can run while that key's put is still taking its body.  The test
// build's hook holds one put on purpose (holdPut: the next put of that URL stores a body that gives its first chunk,
// then nothing until releasePut), runs this build's own fetchAndKeep for the URL (keep), and its read-back alone
// (check: entryVerified).  With the put held, it reports what a check and a page's request of that key do, then
// releases the put and checks again.  The time scale is 0.1 (READ_STALL_MS 1 s), so a stalled read shows as ~1 s.
//
// The harness's own steps are checked (the put really held, the key kept before and after); what the overlapping
// read does is printed as "seen" lines, not judged: the follow-up decides what it must be.
//
//   bun web/build.ts && node web/test-sw-put-overlap.mjs      (CHROME=... for the browser)
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort, freePort } from "./test-port.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0, count = 0;
const ok = (cond, name) => { count++; console.log((cond ? "ok   " : "FAIL ") + name); if (!cond) failures++; return cond; };
const seen = (name, v) => console.log("seen " + name + ": " + JSON.stringify(v));
const here = new URL(".", import.meta.url).pathname;
const tmp = mkdtempSync(join(tmpdir(), "sb-sw-put-"));
// (the test build's service worker, made as web/test-sw-read-stall.mjs makes it)
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
if (!SW.includes("// <offline-test>") || !SW.includes("holdPut")) throw new Error("the test service worker has no holdPut hook");
const A = /^const VERSION = "([0-9a-f]{16})";$/m.exec(SW)[1];
const DIGESTS = JSON.parse(/^const DIGESTS = (.*);$/m.exec(SW)[1]);
// (the largest library chunk served cache-first, so its put takes more than one chunk to store)
const chunk = Object.keys(DIGESTS).filter((p) => /^lib\/[a-z0-9-]+\.(src|pre)\.[0-9a-f]{16}\.json$/.test(p)).sort((a, b) => DIGESTS[b].size - DIGESTS[a].size).find((p) => DIGESTS[p].size > 2 * 1048576 && DIGESTS[p].size < 16 * 1048576);
if (!chunk) throw new Error("no library chunk of 2-16 MiB in DIGESTS");
const want = DIGESTS[chunk], url = "/" + chunk;

const overridesFile = join(tmp, "overrides.json"), logFile = join(tmp, "requests.log");
writeFileSync(overridesFile, JSON.stringify({ "/sw.js": { file: testSw } }));
writeFileSync(logFile, "");
const fromServer = () => readFileSync(logFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).path).filter((p) => p === url).length;
const port = await freePort();
const server = spawn("python3", [join(here, "serve.py"), String(port)], { stdio: "ignore", env: { ...process.env, SB_SERVE_OVERRIDES: overridesFile, SB_SERVE_LOG: logFile } });
await sleep(800);
const profile = mkdtempSync(join(tmpdir(), "sb-sw-put-p-"));
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
  // (a message to the test build's hook; its reply, or {timeout} after `ms`)
  const hook = (t = {}, ms = 10000) => ev(`new Promise((resolve) => {
    const c = new MessageChannel(), t0 = performance.now(); setTimeout(() => resolve({ timeout: true, ms: performance.now() - t0 }), ${ms});
    c.port1.onmessage = (e) => resolve(e.data);
    navigator.serviceWorker.controller.postMessage({ offlineTest: ${J(t)} }, [c.port2]);
  })`);
  const quiesce = async () => {
    let calm = 0, last;
    for (let i = 0; i < 150 && calm < 3; i++) {
      last = await hook();
      calm = last && last.budgetUsed === 0 && last.waiting === 0 && last.checking === 0 && last.putting === 0 && last.serialBusy === 0 && last.skipping === 0 ? calm + 1 : 0;
      if (calm < 3) await sleep(100);
    }
    if (calm < 3) throw new Error("the service worker never went idle: " + J(last));
    return last;
  };
  const get = (ms) => ev(`new Promise((resolve) => {
    const t0 = performance.now(), t = setTimeout(() => resolve({ timeout: true, ms: performance.now() - t0 }), ${ms});
    fetch(${J(url)}).then((r) => r.arrayBuffer()).then(async (b) => {
      const h = [...new Uint8Array(await crypto.subtle.digest("SHA-256", b))].map((x) => x.toString(16).padStart(2, "0")).join("");
      clearTimeout(t); resolve({ size: b.byteLength, sha256: h, ms: performance.now() - t0 });
    }, (e) => (clearTimeout(t), resolve({ error: String(e), ms: performance.now() - t0 })));
  })`);
  const kept = () => ev(`caches.open(${J("sagebrush-" + A)}).then((c) => c.match(${J(url)})).then((r) => !!r)`);
  const clearHttp = async () => { await send("Network.enable"); await send("Network.clearBrowserCache"); };
  const short = (r) => r && { ...r, ms: Math.round(r.ms ?? 0), sha256: r.sha256 && (r.sha256 === want.sha256 ? "right" : "WRONG") };

  at = "the page, controlled by the test build's service worker";
  await send("Page.navigate", { url: `http://127.0.0.1:${port}/` });
  let controlled = await until(async () => (await ev("!!navigator.serviceWorker?.controller")) === true, 15000);
  if (!controlled) { await send("Page.reload"); controlled = await until(async () => (await ev("!!navigator.serviceWorker?.controller")) === true, 30000); }
  ok(controlled && (await hook())?.version === A, "the page is controlled by the test build's service worker");
  console.log(`(the chunk: ${chunk}, ${want.size} B)`);

  at = "a kept copy, and its check with no put in flight";
  const first = await get(30000);
  ok(first.size === want.size && first.sha256 === want.sha256, "the chunk fetched once: " + J(short(first)));
  ok(await until(kept, 30000), "…and kept by the service worker");
  await quiesce();
  await hook({ scale: 0.1 });
  const alone = await hook({ check: url });
  ok(alone?.verified === true, "with no put in flight, the kept copy's check verifies it: " + J(alone));

  at = "a put of the same key held in flight";
  await quiesce();
  await hook({ holdPut: url });
  await clearHttp();
  const net0 = fromServer();
  const keep = await hook({ keep: url }, 30000);
  ok(keep?.status === 200, "this build's fetchAndKeep for the chunk answered from the network: " + J(keep));
  ok(await until(async () => (await hook())?.putHeld === true, 15000), "…and its put of the network's copy is held after its first chunk (putHeld)");
  const during0 = await hook();
  seen("the service worker with the put held", { putting: during0?.putting, heldPuts: during0?.heldPuts, checking: during0?.checking, serialBusy: during0?.serialBusy });

  at = "a check of the key during the held put";
  const t0 = Date.now();
  const during = await hook({ check: url }, 8000);
  const after = await hook();
  seen("a check (entryVerified) during the put", { reply: short(during), msToReply: Date.now() - t0, skipping: after?.skipping, checking: after?.checking });
  at = "a page's request of the key during the held put";
  await clearHttp();
  const net1 = fromServer();
  const page = await get(8000);
  const after2 = await hook();
  seen("a page's request during the put", { reply: short(page), fromNetwork: fromServer() - net1, skipping: after2?.skipping, checking: after2?.checking });

  at = "the put released";
  await hook({ releasePut: true });
  ok(await until(async () => { const h = await hook(); return h?.putting === 0 && h?.putHeld === false; }, 30000), "the held put, released, finishes");
  const ended = await quiesce().catch((e) => ({ error: String(e) }));
  seen("the service worker after the put (idle?)", ended?.error ?? { skipping: ended.skipping, checking: ended.checking, serialBusy: ended.serialBusy });
  ok(await kept(), "…and the chunk is kept after it");
  const later = await hook({ check: url });
  ok(later?.verified === true, "…and its check verifies it: " + J(later));
  seen("the network's requests for the chunk in all", fromServer() - net0);

  // (a read left part-way through the kept copy while a put of the same key finishes and replaces it, then resumed:
  // the read across a replace. Started in the page and awaited later: `later` names the pending reply)
  const start = (name, js) => ev(`(window.__p ??= {})[${J(name)}] = ${js}, true`);
  const result = (name, ms) => ev(`Promise.race([window.__p[${J(name)}], new Promise((r) => setTimeout(() => r({ timeout: true }), ${ms}))])`);
  const hookJs = (t, ms) => `new Promise((resolve) => {
    const c = new MessageChannel(), t0 = performance.now(); setTimeout(() => resolve({ timeout: true, ms: performance.now() - t0 }), ${ms});
    c.port1.onmessage = (e) => resolve({ ...e.data, pageMs: performance.now() - t0 });
    navigator.serviceWorker.controller.postMessage({ offlineTest: ${J(t)} }, [c.port2]);
  })`;
  const getJs = `(async () => { const t0 = performance.now(); try { const b = await (await fetch(${J(url)})).arrayBuffer();
    const h = [...new Uint8Array(await crypto.subtle.digest("SHA-256", b))].map((x) => x.toString(16).padStart(2, "0")).join("");
    return { size: b.byteLength, sha256: h, ms: performance.now() - t0 }; } catch (e) { return { error: String(e), ms: performance.now() - t0 }; } })()`;
  async function acrossReplace(name, js) {
    at = `${name}: the read across a replace`;
    await quiesce();
    // (the bound at 30 s, so the test's own hold of the read isn't a stall; a read that doesn't resume shows as a timeout)
    await hook({ scale: 3, holdPut: url });
    await clearHttp();
    const k = await hook({ keep: url }, 30000);
    ok(k?.status === 200 && (await until(async () => (await hook())?.putHeld === true, 15000)), `${name}: a put of the key held in flight`);
    await hook({ gateRead: url });
    await start(name, js);
    ok(await until(async () => (await hook())?.readHeld === true, 15000), `${name}: …and a read of the kept copy left after its first chunk`);
    await hook({ releasePut: true });
    const putDone = await until(async () => (await hook())?.putting === 0, 30000);
    const mid = await hook();
    seen(`${name}: the put, released while the read waits`, { finished: putDone, putting: mid?.putting, checking: mid?.checking, readHeld: mid?.readHeld });
    const t1 = Date.now();
    await hook({ releaseRead: true });
    const r = await result(name, 15000);
    const end = await hook();
    seen(`${name}: the read, resumed after the replace`, { reply: short(r), msAfterResume: Date.now() - t1, skipping: end?.skipping, checking: end?.checking, deletes: (end?.deletes ?? []).filter((d) => d.endsWith(url)).length });
    const idle = await quiesce().catch((e) => ({ error: String(e) }));
    seen(`${name}: the service worker after`, idle?.error ?? "idle");
    ok(await until(kept, 15000), `${name}: …the chunk kept after it`);
  }
  await acrossReplace("a check", hookJs({ check: url }, 15000));
  await clearHttp();
  await acrossReplace("a page's request", getJs);
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
console.log(failures ? `${failures} of ${count} failed` : `ok: a read during an in-flight put reproduced, ${count} checks (the "seen" lines are the findings)`);
process.exit(failures ? 1 : 0);
