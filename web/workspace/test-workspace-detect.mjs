// A lost workspace detected in the real fault (design/workspace-durability.md
// A.4): a workspace with files, its witnesses written; the browser killed
// (SIGKILL, its whole process group), the tail of IndexedDB's LevelDB log
// torn as a kill can tear it, and the browser started again on the same
// profile.  Chrome then deletes the origin's whole IndexedDB as corrupt (its
// log says so) and reports `dataLoss: "total"`; the workspace must open
// "confirmed" lost, with the witness's numbers, quarantined (every change
// refused, across a reload too), and the notice shown, never as an empty
// workspace; "Start a new workspace here" then ends the quarantine.
//   CHROME=google-chrome bun web/workspace/test-workspace-detect.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, openSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort } from "../test-port.mjs";

const here = new URL(".", import.meta.url).pathname;
const site = mkdtempSync(join(tmpdir(), "sb-ws-detect-site-"));
const built = await Bun.build({ entrypoints: [join(here, "index.ts")], outdir: site, naming: "ws.js", target: "browser", format: "esm" });
if (!built.success) {
  console.error(built.logs.join("\n"));
  process.exit(1);
}
writeFileSync(join(site, "index.html"), `<!doctype html><meta charset="utf-8"><title>detect test</title><script type="module">
import * as W from "./ws.js";
window.W = W;
window.open1 = async () => { window.w = await W.Workspace.open(); return window.w.durability; };
window.ready = true;
</script>`);
const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => {
  const p = new URL(req.url).pathname;
  if (!["/", "/ws.js"].includes(p)) return new Response("not found", { status: 404 });
  return new Response(Bun.file(join(site, p === "/" ? "index.html" : "ws.js")), { headers: { "content-type": p.endsWith(".js") ? "text/javascript" : "text/html" } });
} });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), "sb-ws-detect-"));
let chrome = null, pgid = 0, launches = 0;
const fails = [];
let checks = 0;
const check = (ok, what) => { checks++; if (!ok) fails.push(what); };
const idb = () => join(profile, "Default", "IndexedDB");

/** Chrome on the profile (its own process group, its log kept), the test page open: its evaluate. */
async function start() {
  let port = Number(process.env.CDP_PORT) || 0;
  rmSync(join(profile, "DevToolsActivePort"), { force: true });
  chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--enable-logging=stderr", "--v=0", "about:blank"], { stdio: ["ignore", "ignore", openSync(join(profile, `chrome-${++launches}.log`), "w")], detached: true });
  pgid = chrome.pid;
  if (!port) port = await devtoolsPort(profile);
  let targets;
  for (let i = 0; i < 300; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); if (targets.some((t) => t.type === "page")) break; } catch {} await sleep(100); }
  const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let n = 0;
  const waiting = new Map();
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); } };
  const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
  const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 800)); return r.result?.value; };
  await send("Runtime.enable");
  await send("Page.navigate", { url: `http://127.0.0.1:${server.port}/` });
  for (let i = 0; i < 200 && !(await ev("window.ready === true").catch(() => false)); i++) await sleep(50);
  return { ev, ws };
}
/** The browser killed (its whole process group), returning once nothing of it runs or holds IndexedDB's locks. */
async function kill(t) {
  t.ws.close();
  try { process.kill(-pgid, "SIGKILL"); } catch {}
  await new Promise((r) => (chrome.exitCode !== null || chrome.signalCode !== null ? r() : chrome.once("exit", r)));
  for (let i = 0; i < 300; i++) {
    const alive = readdirSync("/proc").filter((d) => /^\d+$/.test(d)).some((pid) => { try { const s = readFileSync(`/proc/${pid}/stat`, "utf8"); return Number(s.slice(s.lastIndexOf(")") + 2).split(" ")[2]) === pgid; } catch { return false; } });
    if (!alive) return;
    await sleep(100);
  }
  throw new Error("the killed browser's processes still there after 30 s");
}
/** The tail of each IndexedDB LevelDB log torn (bytes flipped), as a kill in the middle of a write can leave it. */
function tear() {
  let torn = 0;
  for (const o of readdirSync(idb())) {
    if (!o.endsWith(".leveldb")) continue;
    for (const f of readdirSync(join(idb(), o))) {
      if (!f.endsWith(".log")) continue;
      const p = join(idb(), o, f), b = readFileSync(p);
      if (b.length <= 64) continue;
      for (let i = b.length - 40; i < b.length - 8; i++) b[i] ^= 0xff;
      writeFileSync(p, b);
      torn++;
    }
  }
  return torn;
}
const chromeLog = () => { try { return readFileSync(join(profile, `chrome-${launches}.log`), "utf8"); } catch { return ""; } };

let code = 1;
try {
  let t = await start();
  // a workspace with files, its witnesses written (the OPFS one flushed)
  check((await t.ev("open1()")).state === "first", "(a first visit)");
  await t.ev(`(async () => { for (let i = 0; i < 5; i++) await w.create("/f" + i + ".txt", { content: "file " + i }); await w.flushOpfs(); return 1; })()`);
  const had = await t.ev(`W.readLocal(W.placeOf("sagebrush-workspace")).witness`);
  check(had?.entries === 5, "(five files, the witness written)");
  // the last writes just before the kill, so the log's tail is a recent record
  await t.ev(`w.create("/last.txt", { content: "last" }).then(() => 1)`);
  await kill(t);
  check(tear() > 0, "(the LevelDB log's tail torn)");
  t = await start();
  const d = await t.ev("open1()");
  const deleted = chromeLog().includes("IndexedDB recovering from a corrupted (and deleted) database");
  check(deleted, "Chrome deleted the origin's IndexedDB as corrupt (its log says so)");
  check(d.state === "confirmed" && d.witness?.workspace === had.workspace && d.witness?.entries >= 5, "the workspace opens confirmed lost, with the witness's numbers, not as an empty workspace: " + JSON.stringify(d));
  check(/deleted its storage as damaged/.test(d.why ?? ""), "…said as the browser's report (dataLoss): " + d.why);
  check(await t.ev(`w.create("/x.txt", { content: "x" }).then(() => false, (e) => e.code === "quarantined")`), "…quarantined: a change refused");
  check(/was lost/.test(await t.ev(`W.showLossNotice(w)?.textContent ?? ""`)), "…and the notice says so, with its choices");
  // a reload keeps the quarantine; Start a new workspace here ends it
  await t.ev(`location.reload()`);
  await sleep(500);
  for (let i = 0; i < 200 && !(await t.ev("window.ready === true").catch(() => false)); i++) await sleep(50);
  check((await t.ev("open1()")).state === "confirmed", "a reload doesn't lift it");
  const id = await t.ev(`w.reset("new")`);
  check(id.generation >= 2 && (await t.ev(`w.create("/y.txt", { content: "y" }).then(() => true)`)), "Start a new workspace here: writable again");
  t.ws.close();
  code = fails.length ? 1 : 0;
} catch (e) {
  fails.push("threw: " + (e?.stack ?? e));
} finally {
  try { process.kill(-pgid, "SIGKILL"); } catch {}
  server.stop(true);
  await sleep(300);
  rmSync(profile, { recursive: true, force: true });
  rmSync(site, { recursive: true, force: true });
}
if (fails.length) {
  console.error(`FAIL: ${fails.length} of ${checks} checks\n  ` + fails.join("\n  "));
  process.exit(1);
}
console.log(`ok: a lost workspace detected in the real fault, ${checks} checks`);
process.exit(code);
