// ci: web-runner order=486 chrome
// An agent's whole write of a notebook (Workspace.write: sagebrush-mcp's workspace_write, through the paired page) with
// notebook sync on in this browser (sync's journal: the notebooks' fence and both histories' in phase "journal", as
// Workspace.activateJournal leaves them).  The write goes through the journal, as a person's typing does:
//  W1. no tab has the notebook open: the write is saved, read back, and a notebook tab opened then shows it;
//  W2. the notebook open in another tab, the person's typing there saved: the agent writes from what it read (its
//      cells, the person's included, one of them changed): saved, and that tab shows it within 10 s, the person's text
//      kept;
//  W3. the agent's own page shows the notebook (it is its writer): the write is saved, and the page shows it at once;
//  W4. a write from an old revision: a conflict, nothing changed.
// Serve web/dist first (python3 web/serve.py 8765), then
//   node web/workspace/test-notebook-write-journal.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort } from "../test-port.mjs";

const base = process.env.SB_URL ?? "http://127.0.0.1:8765/";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = JSON.stringify;
const profile = mkdtempSync(join(tmpdir(), "sb-write-journal-"));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--remote-debugging-port=0", "--window-size=1280,860", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
const port = await devtoolsPort(profile);
const fails = [];
let checks = 0;
const check = (ok, what, detail) => { checks++; console.log((ok ? "ok   " : "FAIL ") + what + (ok || detail === undefined ? "" : " " + J(detail).slice(0, 600))); if (!ok) fails.push(what); return ok; };

/** A tab at `url`: its own DevTools socket. */
async function tab(url) {
  const t = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json();
  const s = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => (s.onopen = r));
  let n = 0;
  const w = new Map(), errors = [];
  s.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && w.has(m.id)) { w.get(m.id)(m.result ?? m.error); w.delete(m.id); }
    if (m.method === "Runtime.exceptionThrown") errors.push((m.params.exceptionDetails?.exception?.description ?? "").slice(0, 200));
  };
  const send = (method, params = {}) => new Promise((r) => { const id = ++n; w.set(id, r); s.send(J({ id, method, params })); });
  const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r?.exceptionDetails) throw new Error(J(r.exceptionDetails).slice(0, 300)); return r?.result?.value; };
  const until = async (expr, ms = 20000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await ev(expr).catch(() => false)) return true; await sleep(100); } return false; };
  await send("Page.enable");
  await send("Runtime.enable");
  const go = async (u) => { await send("Page.navigate", { url: u }); await sleep(300); return until(`!!(window.sagebrush?.workspace && ${NB}?.store && document.querySelector("#cells .cell textarea"))`, 30000); };
  await go(url);
  return { ev, until, go, send, errors, close: async () => { try { s.close(); } catch {} await fetch(`http://127.0.0.1:${port}/json/close/${t.id}`).catch(() => {}); } };
}
const NB = "window.sagebrush?.notebook", W = "window.sagebrush.workspace";
const FENCE = "__sagebrush-workspace__";
// (sync's journal switched on as Workspace.activateJournal leaves it: the same fence, in phase "journal", in the
// notebooks' store and in both histories' [FENCE, ""] rows)
const journalOn = (x) => x.ev(`(async () => {
  const open = (n) => new Promise((ok, no) => { const r = indexedDB.open(n); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
  const db = await open("sagebrush");
  const f0 = await new Promise((ok) => { const r = db.transaction("notebooks").objectStore("notebooks").get(${J(FENCE)}); r.onsuccess = () => ok(r.result); });
  if (!f0) return false;
  const f = { ...f0, phase: "journal", journal: 1 };
  await new Promise((ok) => { const t = db.transaction("notebooks", "readwrite"); t.objectStore("notebooks").put(f); t.oncomplete = ok; });
  const { id: _id, ...fence } = f;
  for (const n of ["sagebrush-history", "sagebrush-board-history"]) {
    if (!(await indexedDB.databases()).some((d) => d.name === n)) continue;
    const h = await open(n);
    if (h.objectStoreNames.contains("history")) await new Promise((ok) => { const t = h.transaction("history", "readwrite"), st = t.objectStore("history"), k = [${J(FENCE)}, ""]; const g = st.get(k); g.onsuccess = () => st.put({ ...(g.result ?? {}), nb: ${J(FENCE)}, time: "", fence }); t.oncomplete = ok; });
    h.close();
  }
  return true;
})()`);
const nbJson = (codes) => ({ cells: codes.map((c) => ({ cell_type: "code", source: c, metadata: {}, outputs: [] })) });
const codesOf = (r) => (r?.content?.json?.cells ?? r?.content?.cells ?? []).map((c) => c.code ?? (Array.isArray(c.source) ? c.source.join("") : c.source));
// (the agent's verbs, made in the agent's page as the pairing makes them)
const read = (x, p) => x.ev(`${W}.read(${J(p)}).then((r) => ({ rev: r.rev, content: r.content, ref: r.entry?.ref ?? null }), (e) => ({ err: (e.code ?? "") + " " + e.message }))`);
const write = (x, p, doc, b) => x.ev(`${W}.write(${J(p)}, ${J(doc)}, { base: ${b} }).then((r) => ({ ok: true, rev: r.rev }), (e) => ({ ok: false, code: e.code ?? null, msg: e.message }))`);
const create = (x, p, doc) => x.ev(`${W}.create(${J(p)}, { content: ${J(doc)} }).then((e) => e.path, (e) => "ERR " + e.message)`);
const refOf = (x, p) => x.ev(`${W}.stat(${J(p)}).then((e) => e?.ref ?? null, () => null)`);
const shown = (x) => x.ev(`${NB}?.snapshot?.().cells.map((c) => c.code) ?? null`);

const tabs = [];
try {
  // the agent's page: the notebook page, with sync's journal on (and loaded again under it, as after the switch)
  const A = await tab(base);
  tabs.push(A);
  check(await journalOn(A), "the journal switched on (all three fences)");
  check(await A.go(base) && (await A.ev(`!!${NB}.store.journaled`)), "the agent's page, loaded again, saves through the journal");

  // W1: no tab has the notebook open
  {
    const p = "/w1.ipynb";
    await create(A, p, nbJson(["x = 1"]));
    const r = await read(A, p);
    const w = await write(A, p, nbJson(["x = 2  # agent"]), r.rev);
    const r2 = await read(A, p);
    check(w.ok && J(codesOf(r2)) === J(["x = 2  # agent"]), "W1: with no tab showing it, the agent's write is saved and read back", { w, read: codesOf(r2) });
    const ref = await refOf(A, p);
    const B = await tab(`${base}?nb=${ref}`);
    tabs.push(B);
    const seen = await B.until(`${NB}.snapshot().cells[0]?.code === "x = 2  # agent"`, 10000);
    check(!!ref && seen, "W1: …and a notebook tab opened then shows it", { ref, shown: await shown(B) });
    await B.close();
  }
  // W2: the notebook open in another tab, the person's typing there saved
  {
    const p = "/w2.ipynb";
    await create(A, p, nbJson(["y = 1", "z = 1"]));
    const ref = await refOf(A, p);
    const B = await tab(`${base}?nb=${ref}`);
    tabs.push(B);
    const writer = await B.until(`!!(${NB}.store.journaled && ${NB}.store.writer && ${NB}.store.ready)`, 15000);
    await B.ev(`(() => { const t = document.querySelectorAll("#cells .cell textarea")[1]; t.focus(); t.value = "z = 1  # person"; t.dispatchEvent(new Event("input", { bubbles: true })); })()`);
    await B.ev(`${NB}.flush?.(), ${NB}.saved?.()`);
    await sleep(1500);
    const r = await read(A, p);
    const mine = codesOf(r);
    const w = await write(A, p, nbJson(["y = 2  # agent", mine[1]]), r.rev);
    const both = await B.until(`(() => { const c = ${NB}.snapshot().cells.map((x) => x.code); return c[0] === "y = 2  # agent" && c[1] === "z = 1  # person"; })()`, 10000);
    check(writer && mine[1] === "z = 1  # person" && w.ok && both, "W2: the notebook open in another tab: the agent's write (from what it read, the person's text in it) is saved, and that tab shows it within 10 s, the person's text kept", { writer, read: mine, w, shown: await shown(B) });
    const r2 = await read(A, p);
    check(J(codesOf(r2)) === J(["y = 2  # agent", "z = 1  # person"]), "W2: …and the workspace's copy has both", codesOf(r2));
    await B.close();
  }
  // W3: the agent's own page shows the notebook (it is its writer)
  {
    const p = "/w3.ipynb";
    await create(A, p, nbJson(["u = 1"]));
    const ref = await refOf(A, p);
    await A.go(`${base}?nb=${ref}`);
    const writer = await A.until(`!!(${NB}.store.journaled && ${NB}.store.writer && ${NB}.store.ready)`, 15000);
    const r = await read(A, p);
    const w = await write(A, p, nbJson(["u = 2  # agent"]), r.rev);
    const seen = await A.until(`${NB}.snapshot().cells[0]?.code === "u = 2  # agent"`, 5000);
    check(writer && w.ok && seen, "W3: the agent's own page shows the notebook: the write is saved and shown there at once", { writer, w, shown: await shown(A) });
    // W4: a write from an old revision
    const w2 = await write(A, p, nbJson(["u = 3  # stale"]), r.rev);
    const r2 = await read(A, p);
    check(!w2.ok && w2.code === "conflict" && J(codesOf(r2)) === J(["u = 2  # agent"]), "W4: a write from an old revision is a conflict, nothing changed", { w2, read: codesOf(r2) });
  }
  const errs = tabs.flatMap((x) => x.errors);
  check(errs.length === 0, "no page errors", errs);
} catch (e) {
  check(false, "the test ran to its end", { error: String(e?.stack ?? e).slice(0, 500) });
} finally {
  for (const x of tabs) await x.close().catch(() => {});
  chrome.kill();
  await sleep(300);
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
}
console.log(`\n${checks - fails.length}/${checks} checks passed`);
if (fails.length) { console.log("FAILED:\n  " + fails.join("\n  ")); process.exit(1); }
