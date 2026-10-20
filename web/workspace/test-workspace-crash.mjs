// The migration of data files' bytes beside the index (design/capabilities.md
// §2b) survives the browser being killed: a workspace as version 1 made it
// (120 data files of 2 MB kept the old way, 5 in Trash), opened by this
// version, its migrator started, and the browser process killed (SIGKILL,
// not a page closing) at several points while it moves them; each time the
// browser is started again on the same profile, and every file's bytes are
// read back exactly, the index and the bytes agree (a moved file's bytes
// in fileBytes, one not moved still in its old place, nothing in fileBytes
// that no entry names, an old copy left only with its mark), and at the end
// the migration finishes: every file moved, the old stores empty.  The
// kills land where the timing puts them (during a move's transaction, between
// it and the old copy's deletion, between batches); each run checks the
// whole state, wherever they landed.
//
// The harness itself: the workspace is seeded with every write committed
// (not merely requested) before the first kill; each kill takes the
// browser's whole process group, and the browser is started again only
// once every process of it has exited and nothing holds the profile's
// IndexedDB locks; and a round that finds the origin's data gone (once seen
// in a crowded run, never reproduced: the whole origin's IndexedDB fresh,
// the old store with it, which no workspace code deletes) fails loudly with
// what was there: the IndexedDB folder before and after the restart, the
// killed browser's processes still alive, and Chrome's own log.
//   CHROME=google-chrome bun web/workspace/test-workspace-crash.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, openSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort } from "../test-port.mjs";

const here = new URL(".", import.meta.url).pathname;
const site = mkdtempSync(join(tmpdir(), "sb-ws-crash-site-"));
const built = await Bun.build({ entrypoints: [join(here, "index.ts")], outdir: site, naming: "ws.js", target: "browser", format: "esm" });
if (!built.success) {
  console.error(built.logs.join("\n"));
  process.exit(1);
}
const FILES = 120, TRASHED = 5, SIZE = 2 * 2 ** 20;
writeFileSync(join(site, "index.html"), `<!doctype html><meta charset="utf-8"><title>crash test</title><script type="module">
import * as W from "./ws.js";
window.W = W;
const NAME = "ws-crash", MAIN = "main-crash";
const bytes = (i) => { const b = new Uint8Array(${SIZE}); for (let j = 0; j < b.length; j++) b[j] = (i * 7 + j * 13) & 255; return b; };
const same = (a, i) => { if (!a || a.byteLength !== ${SIZE}) return false; const b = new Uint8Array(a.buffer ?? a, a.byteOffset ?? 0, a.byteLength); for (let j = 0; j < b.length; j += 997) if (b[j] !== ((i * 7 + j * 13) & 255)) return false; return b[b.length - 1] === ((i * 7 + (b.length - 1) * 13) & 255); };
// (a write resolves once its transaction has committed, not when its request succeeds: a kill a moment
// later can't drop it)
const raw = (db, store, op, ...a) => new Promise((ok, no) => { const write = op === "put" || op === "delete", tx = db.transaction(store, write ? "readwrite" : "readonly"), r = tx.objectStore(store)[op](...a); let v; r.onsuccess = () => { v = r.result; if (!write) ok(v); }; if (write) tx.oncomplete = () => ok(v); r.onerror = () => no(r.error); tx.onabort = () => no(tx.error); });
// a workspace as version 1 made it
window.setup = async () => {
  await new Promise((ok, no) => {
    const r = indexedDB.open(NAME, 1);
    r.onupgradeneeded = () => {
      const db = r.result, e = db.createObjectStore("entries", { keyPath: "path" });
      e.createIndex("byRef", ["kind", "ref"]);
      db.createObjectStore("boards", { keyPath: "id" });
      db.createObjectStore("trash");
      db.createObjectStore("ops", { keyPath: "seq", autoIncrement: true });
      const v = db.createObjectStore("versions", { keyPath: "id", autoIncrement: true });
      v.createIndex("byFile", ["fid", "t"]);
      v.createIndex("byTime", "t");
      db.createObjectStore("versionBytes");
      db.createObjectStore("meta");
    };
    r.onsuccess = () => {
      const db = r.result, tx = db.transaction(["entries", "trash"], "readwrite"), st = tx.objectStore("entries");
      st.put({ path: "/d", kind: "folder", ref: null, created: 1, updated: 1 });
      st.put({ path: "/Trash", kind: "folder", ref: null, created: 1, updated: 1 });
      for (let i = 0; i < ${FILES}; i++) st.put({ path: "/d/f" + i + ".bin", kind: "file", ref: "/d/f" + i + ".bin", size: ${SIZE}, rev: 0, fid: "f" + String(i).padStart(15, "0"), created: 1, updated: 1 });
      for (let i = 0; i < ${TRASHED}; i++) { const p = "/Trash/t" + i + ".bin"; st.put({ path: p, kind: "file", ref: p, size: ${SIZE}, rev: 0, fid: "t" + String(i).padStart(15, "0"), created: 1, updated: 1, trashed: { from: "/t" + i + ".bin", at: 1, id: "x" + i } }); tx.objectStore("trash").put(bytes(1000 + i), p); }
      tx.oncomplete = () => { db.close(); ok(); };
      tx.onerror = () => no(tx.error);
    };
    r.onerror = () => no(r.error);
  });
  const w = await W.Workspace.open({ name: NAME, mainName: MAIN });
  for (let i = 0; i < ${FILES}; i++) await raw(w.main, "files", "put", bytes(i), "/d/f" + i + ".bin");
  w.close();
  return true;
};
// the whole state checked: every file's bytes, and the index and the bytes agreeing
window.check = async () => {
  const w = await W.Workspace.open({ name: NAME, mainName: MAIN });
  const problems = [];
  const all = [...(await w.list("/", { recursive: true })), ...(await w.list("/Trash", { recursive: true }))].filter((e) => e.kind === "file");
  if (all.length !== ${FILES + TRASHED}) problems.push("files listed: " + all.length);
  const fileBytes = new Set(await raw(w.ws, "fileBytes", "getAllKeys"));
  const oldFiles = new Set(await raw(w.main, "files", "getAllKeys")), oldTrash = new Set(await raw(w.ws, "trash", "getAllKeys"));
  const stale = new Set((await w.staleCopies(Infinity)).map(([a, k]) => a + ":" + k));
  let moved = 0;
  for (const e of all) {
    const i = e.path.startsWith("/Trash/") ? 1000 + Number(e.path.slice(8, -4)) : Number(e.path.slice(4, -4));
    const c = (await w.read(e.path).catch((err) => ({ content: null, err }))).content;
    if (!same(c, i)) problems.push("bytes of " + e.path);
    const old = e.path.startsWith("/Trash/") ? oldTrash.has(e.ref) : oldFiles.has(e.ref);
    if (e.migrated) { moved++; if (!fileBytes.has(e.fid)) problems.push(e.path + " moved, its bytes not in fileBytes"); if (old && !stale.has((e.path.startsWith("/Trash/") ? "trash:" : "files:") + e.ref)) problems.push(e.path + " moved, its old copy left unmarked"); }
    else { if (!old) problems.push(e.path + " not moved, its old copy gone"); if (fileBytes.has(e.fid)) problems.push(e.path + " not moved, yet in fileBytes"); }
  }
  const named = new Set(all.filter((e) => e.migrated).map((e) => e.fid));
  for (const k of fileBytes) if (!named.has(k)) problems.push("fileBytes " + k + " named by no entry");
  const st = await W.migrationState(w);
  w.close();
  return { problems, moved, state: st, oldLeft: oldFiles.size + oldTrash.size, stale: stale.size };
};
window.migrate = async () => { const w = await W.Workspace.open({ name: NAME, mainName: MAIN }); window.mig = W.startMigrator(w).then(() => { w.close(); window.migDone = true; }); return true; };
window.ready = true;
</script>`);
const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => {
  const p = new URL(req.url).pathname;
  if (!["/", "/ws.js"].includes(p)) return new Response("not found", { status: 404 });
  return new Response(Bun.file(join(site, p === "/" ? "index.html" : "ws.js")), { headers: { "content-type": p.endsWith(".js") ? "text/javascript" : "text/html" } });
} });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), "sb-ws-crash-"));
let chrome = null;
const fails = [];
let checks = 0;
const check = (ok, what) => { checks++; if (!ok) fails.push(what); };

// What of the browser is on disk and running: its process group's members still alive, the processes
// holding the profile's IndexedDB LevelDB locks, and the IndexedDB folder (files and bytes, per folder)
const procs = () => readdirSync("/proc").filter((d) => /^\d+$/.test(d));
function idbLocks() {
  const out = [], walk = (d) => { let es = []; try { es = readdirSync(d, { withFileTypes: true }); } catch { return; } for (const e of es) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name === "LOCK" && p.includes("IndexedDB")) out.push(p); } };
  walk(join(profile, "Default", "IndexedDB"));
  return out;
}
function processes(pgid) {
  const locks = new Set(idbLocks()), members = [], holders = [];
  for (const pid of procs()) {
    let stat;
    try { stat = readFileSync(`/proc/${pid}/stat`, "utf8"); } catch { continue; }
    if (Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[2]) === pgid) members.push(Number(pid));
    if (!locks.size) continue;
    let fds = [];
    try { fds = readdirSync(`/proc/${pid}/fd`); } catch { continue; }
    for (const fd of fds) { try { if (locks.has(readlinkSync(`/proc/${pid}/fd/${fd}`))) holders.push(Number(pid)); } catch {} }
  }
  return { members, holders };
}
function idbDisk() {
  const out = {}, walk = (d, top) => { let es = []; try { es = readdirSync(d, { withFileTypes: true }); } catch { return; } for (const e of es) { const p = join(d, e.name); if (e.isDirectory()) walk(p, top ?? e.name); else { const k = top ?? "."; out[k] ??= [0, 0]; out[k][0]++; try { out[k][1] += statSync(p).size; } catch {} } } };
  walk(join(profile, "Default", "IndexedDB"), null);
  return out;
}
let pgid = 0, launches = 0, before = null;

/** Chrome on the profile, the test page open: its evaluate. */
async function start() {
  let port = Number(process.env.CDP_PORT) || 0;
  // (a killed browser leaves its port file behind: not the new one's)
  rmSync(join(profile, "DevToolsActivePort"), { force: true });
  before = { disk: idbDisk(), left: processes(pgid) };
  // (its own process group, so that a kill takes all of it; its log kept, for a round that finds the data gone)
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
/** The browser killed (SIGKILL, its whole process group), and only once every process of it has exited and
 * nothing holds the profile's IndexedDB locks does this return: the next browser opens the profile alone. */
async function kill(t) {
  t.ws.close();
  try { process.kill(-pgid, "SIGKILL"); } catch {}
  await new Promise((r) => (chrome.exitCode !== null || chrome.signalCode !== null ? r() : chrome.once("exit", r)));
  for (let i = 0; ; i++) {
    const { members, holders } = processes(pgid);
    if (!members.length && !holders.length) break;
    if (i >= 300) throw new Error(`the killed browser's processes still there after 30 s: group ${JSON.stringify(members)}, holding IndexedDB's locks ${JSON.stringify(holders)}`);
    for (const pid of members) { try { process.kill(pid, "SIGKILL"); } catch {} }
    await sleep(100);
  }
}
/** What was there, for a round that finds the origin's data gone. */
function forensics() {
  let log = "";
  try { log = readFileSync(join(profile, `chrome-${launches}.log`), "utf8").split("\n").filter((l) => l.trim()).slice(-40).join("\n    "); } catch (e) { log = String(e); }
  return `IndexedDB before the restart ${JSON.stringify(before?.disk)}, after ${JSON.stringify(idbDisk())}; the killed browser's processes left at the restart ${JSON.stringify(before?.left)}; Chrome's log:\n    ${log}`;
}

let code = 1;
try {
  let t = await start();
  check(await t.ev("window.setup()"), "(a version 1 workspace of 125 data files, 2 MB each, kept the old way)");
  let last = -1;
  // killed while it moves them, at several points, each time started again and the whole state checked
  for (const [round, ms] of [[1, 120], [2, 200], [3, 200], [4, 250], [5, 250], [6, 300]]) {
    await t.ev("window.migrate()");
    await sleep(ms);
    await kill(t);
    t = await start();
    const r = await t.ev("window.check()");
    // (the origin's data gone: said loudly, with what was there)
    if (r.problems.some((p) => p.startsWith("files listed: "))) console.error(`round ${round}: THE ORIGIN'S DATA IS GONE (${r.problems[0]}): ${forensics()}`);
    check(r.problems.length === 0, `killed ${ms} ms into a run (round ${round}): every file's bytes intact, the index and bytes agreeing: ${r.problems.slice(0, 5).join("; ")}${r.problems.some((p) => p.startsWith("files listed: ")) ? " (the origin's data gone: see the forensics above)" : ""}`);
    check(r.moved >= last, `…the files moved never fewer than before (${last} → ${r.moved})`);
    last = r.moved;
    console.log(`round ${round}: killed after ${ms} ms, ${r.moved} of 125 moved, ${r.stale} old copies left marked, state ${JSON.stringify(r.state)}`);
  }
  // then left to finish
  await t.ev("window.migrate()");
  for (let i = 0; i < 600 && !(await t.ev("window.migDone === true")); i++) await sleep(100);
  const r = await t.ev("window.check()");
  check(r.problems.length === 0 && r.moved === 125 && r.oldLeft === 0 && r.state.done === true, `finally: done, every file moved, the old stores empty: ${JSON.stringify({ moved: r.moved, oldLeft: r.oldLeft, state: r.state, problems: r.problems.slice(0, 5) })}`);
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
console.log(`ok: the migration survives the browser killed, ${checks} checks`);
process.exit(code);
