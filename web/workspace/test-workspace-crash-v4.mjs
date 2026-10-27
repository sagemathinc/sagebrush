// The version 4 upgrade and the migrator's filling in of sync's identities (design/sync-client.md §3, §3a)
// survive the browser being killed: a workspace as version 3 left it (120 data files of 2 MB beside the
// index, written since capabilities 1a, so without their SHA-256 or identity key; its migration done), opened
// by this version (upgraded to 4: the migration's state dropped, so it runs again), its migrator started, and
// the browser process killed (SIGKILL, its whole process group) at several points while it hashes them; each
// time the browser is started again on the same profile and the whole state checked: every file's bytes
// exactly as they were, each entry as it was but for its hash and identity key, which are either not there
// yet or right (the hash that of its bytes, the key its fid), no op recorded, nothing in fileBytes that no
// entry names.  At the end the migration finishes with every hash and key there.
//
// The harness is test-workspace-crash.mjs's (the kills, the restarts, Chrome's own deletion of a corrupt
// IndexedDB counted as a warning, not a failure: design/workspace-durability.md).
//   CHROME=google-chrome bun web/workspace/test-workspace-crash-v4.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, openSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort } from "../test-port.mjs";

const here = new URL(".", import.meta.url).pathname;
const site = mkdtempSync(join(tmpdir(), "sb-ws-crash4-site-"));
const built = await Bun.build({ entrypoints: [join(here, "index.ts")], outdir: site, naming: "ws.js", target: "browser", format: "esm" });
if (!built.success) {
  console.error(built.logs.join("\n"));
  process.exit(1);
}
const FILES = 120, SIZE = 2 * 2 ** 20;
writeFileSync(join(site, "index.html"), `<!doctype html><meta charset="utf-8"><title>crash test v4</title><script type="module">
import * as W from "./ws.js";
window.W = W;
const NAME = "ws-crash-v4", MAIN = "main-crash-v4";
const bytes = (i) => { const b = new Uint8Array(${SIZE}); for (let j = 0; j < b.length; j++) b[j] = (i * 7 + j * 13) & 255; return b; };
const same = (a, i) => { if (!a || a.byteLength !== ${SIZE}) return false; const b = new Uint8Array(a.buffer ?? a, a.byteOffset ?? 0, a.byteLength); for (let j = 0; j < b.length; j += 997) if (b[j] !== ((i * 7 + j * 13) & 255)) return false; return b[b.length - 1] === ((i * 7 + (b.length - 1) * 13) & 255); };
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const hashes = new Map();
const H = async (i) => { if (!hashes.has(i)) hashes.set(i, hex(await crypto.subtle.digest("SHA-256", bytes(i)))); return hashes.get(i); };
const fid = (i) => "f" + String(i).padStart(15, "0");
// (each file's entry as version 3 left it)
const entry = (i) => ({ path: "/d/f" + i + ".bin", kind: "file", ref: "/d/f" + i + ".bin", size: ${SIZE}, rev: 1, fid: fid(i), migrated: true, created: 1, updated: 1, nkey: "/d\\u0000f" + i + ".bin" });
const raw = (db, store, op, ...a) => new Promise((ok, no) => { const write = op === "put" || op === "delete", tx = db.transaction(store, write ? "readwrite" : "readonly"), r = tx.objectStore(store)[op](...a); let v; r.onsuccess = () => { v = r.result; if (!write) ok(v); }; if (write) tx.oncomplete = () => ok(v); r.onerror = () => no(r.error); tx.onabort = () => no(tx.error); });
// a workspace as version 3 left it, every write committed before the first kill
window.setup = async () => {
  const db = await new Promise((ok, no) => {
    const r = indexedDB.open(NAME, 3);
    r.onupgradeneeded = () => {
      const db = r.result, e = db.createObjectStore("entries", { keyPath: "path" });
      e.createIndex("byRef", ["kind", "ref"]);
      e.createIndex("byNfc", "nkey");
      db.createObjectStore("boards", { keyPath: "id" });
      db.createObjectStore("trash");
      db.createObjectStore("ops", { keyPath: "seq", autoIncrement: true });
      const v = db.createObjectStore("versions", { keyPath: "id", autoIncrement: true });
      v.createIndex("byFile", ["fid", "t"]);
      v.createIndex("byTime", "t");
      db.createObjectStore("versionBytes");
      db.createObjectStore("meta");
      db.createObjectStore("fileBytes");
      const g = db.createObjectStore("grants", { keyPath: ["doc", "scope"] });
      g.createIndex("byDoc", "doc");
      g.createIndex("lastUsed", "lastUsed");
    };
    r.onsuccess = () => ok(r.result);
    r.onerror = () => no(r.error);
  });
  await raw(db, "entries", "put", { path: "/d", kind: "folder", ref: null, created: 1, updated: 1, fid: "d000000000000001", nkey: "/\\u0000d" });
  await raw(db, "meta", "put", { done: true }, "migration");
  for (let i = 0; i < ${FILES}; i++) { await raw(db, "fileBytes", "put", bytes(i), fid(i)); await raw(db, "entries", "put", entry(i)); }
  db.close();
  return true;
};
// the whole state checked
window.check = async () => {
  const w = await W.Workspace.open({ name: NAME, mainName: MAIN });
  const problems = [];
  const files = (await w.list("/d")).filter((e) => e.kind === "file");
  if (files.length !== ${FILES}) problems.push("files listed: " + files.length);
  let hashed = 0;
  for (const e of files) {
    const i = Number(e.path.slice(4, -4));
    const c = (await w.read(e.path).catch((err) => ({ content: null, err }))).content;
    if (!same(c, i)) problems.push("bytes of " + e.path);
    const { sha256, ident, ...rest } = e;
    if (JSON.stringify(rest) !== JSON.stringify(entry(i))) problems.push(e.path + " changed: " + JSON.stringify(rest).slice(0, 200));
    if (sha256 !== undefined) { if (sha256 !== (await H(i))) problems.push(e.path + " has a wrong hash"); else hashed++; }
    if (ident !== undefined && ident !== fid(i)) problems.push(e.path + " has a wrong identity key " + ident);
  }
  const d = await w.stat("/d");
  if (d?.fid !== "d000000000000001" || (d.ident !== undefined && d.ident !== d.fid)) problems.push("the folder /d: " + JSON.stringify(d));
  const fileBytes = new Set(await raw(w.ws, "fileBytes", "getAllKeys"));
  for (let i = 0; i < ${FILES}; i++) if (!fileBytes.has(fid(i))) problems.push("fileBytes lacks " + fid(i));
  if (fileBytes.size !== ${FILES}) problems.push("fileBytes holds " + fileBytes.size);
  const ops = await raw(w.ws, "ops", "count");
  if (ops !== 0) problems.push(ops + " ops recorded");
  const st = await W.migrationState(w);
  const version = w.ws.version;
  w.close();
  return { problems, moved: hashed, state: st, version, current: W.WS_VERSION };
};
window.reseed = async () => {
  for (const n of [NAME, MAIN]) await new Promise((ok, no) => { const r = indexedDB.deleteDatabase(n); r.onsuccess = ok; r.onerror = () => no(r.error); });
  return window.setup();
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
const profile = mkdtempSync(join(tmpdir(), "sb-ws-crash4-"));
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
/** Whether the browser now running said, in its log, that it deleted this origin's IndexedDB as corrupt: Chrome's
 * own behaviour after a kill tore a LevelDB record (design/workspace-durability.md), not this code's. */
function chromeDeletedCorrupt() {
  let log = "";
  try { log = readFileSync(join(profile, `chrome-${launches}.log`), "utf8"); } catch { return false; }
  return log.includes("IndexedDB recovering from a corrupted (and deleted) database") && log.includes(`Got corruption for { origin: http://127.0.0.1:${server.port}`);
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
  check(await t.ev("window.setup()"), "(a version 3 workspace of 120 data files, 2 MB each, beside the index, without their hashes)");
  let last = -1, wipes = 0;
  // killed while it hashes them, at several points, each time started again and the whole state checked
  for (const [round, ms] of [[1, 30], [2, 60], [3, 90], [4, 120], [5, 160], [6, 220]]) {
    await t.ev("window.migrate()");
    await sleep(ms);
    await kill(t);
    t = await start();
    const r = await t.ev("window.check()");
    const gone = r.problems.some((p) => p.startsWith("files listed: "));
    // the origin's data gone because Chrome deleted it as corrupt: known browser behaviour, said loudly (a CI
    // warning, counted, with what was there), not a failure; the workspace seeded again for the rounds after
    if (gone && chromeDeletedCorrupt()) {
      wipes++;
      console.log(`round ${round}: Chrome deleted the origin's IndexedDB as corrupt after the kill (known browser behaviour, not a failure): ${forensics()}`);
      console.log(`::warning title=workspace-crash: Chrome deleted a corrupt IndexedDB::round ${round} of ${process.pid}: Chrome's log says "IndexedDB recovering from a corrupted (and deleted) database" for this origin after a SIGKILL; counted, not failed (design/workspace-durability.md)`);
      check(await t.ev("window.reseed()"), "(the workspace seeded again after Chrome's deletion)");
      last = -1;
      continue;
    }
    // (the origin's data gone otherwise: a failure, with what was there)
    if (gone) console.error(`round ${round}: THE ORIGIN'S DATA IS GONE (${r.problems[0]}), and Chrome's log doesn't say it deleted it: ${forensics()}`);
    check(r.problems.length === 0, `killed ${ms} ms into a run (round ${round}): every file's bytes intact, each entry as it was but for a right hash and identity key: ${r.problems.slice(0, 5).join("; ")}${r.problems.some((p) => p.startsWith("files listed: ")) ? " (the origin's data gone: see the forensics above)" : ""}`);
    check(r.moved >= last, `…the files hashed never fewer than before (${last} → ${r.moved})`);
    last = r.moved;
    console.log(`round ${round}: killed after ${ms} ms, version ${r.version}, ${r.moved} of 120 hashed, state ${JSON.stringify(r.state)}`);
  }
  // then left to finish
  await t.ev("window.migrate()");
  for (let i = 0; i < 600 && !(await t.ev("window.migDone === true")); i++) await sleep(100);
  const r = await t.ev("window.check()");
  check(r.problems.length === 0 && r.moved === 120 && r.version === r.current && r.state.done === true, `finally: the current version (${r.current}), done, every file hashed: ${JSON.stringify({ hashed: r.moved, version: r.version, state: r.state, problems: r.problems.slice(0, 5) })}`);
  t.ws.close();
  // (how often Chrome deleted the origin as corrupt, to watch the rate)
  console.log(`Chrome's corrupt-database deletions: ${wipes} of 6 rounds`);
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
console.log(`ok: the version 4 upgrade and its migration survive the browser killed, ${checks} checks`);
process.exit(code);
