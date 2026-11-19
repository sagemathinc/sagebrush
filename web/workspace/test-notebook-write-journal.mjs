// ci: web-runner order=486 chrome
// An agent's whole write of a notebook (Workspace.write: sagebrush-mcp's workspace_write, through the paired page) with
// notebook sync on in this browser (sync's journal: the notebooks' fence and both histories' in phase "journal", as
// Workspace.activateJournal leaves them).  The write goes through the journal, as a person's typing does:
//  W1. no tab has the notebook open: the write is saved, read back, and a notebook tab opened then shows it;
//  W2. the notebook open in another tab, the person's typing there saved: the agent writes from what it read (its
//      cells, the person's included, one of them changed): saved, and that tab shows it within 10 s, the person's text
//      kept;
//  W3. the agent's own page shows the notebook (it is its writer): the write is saved, and the page shows it at once;
//  W4. a write from an old revision: a conflict, nothing changed;
//  W5-W10, the holder's protocol: a hand-over while the holder prepares (nothing applied there); messages of the wrong
//      shape (no answer), the grant withdrawn while it prepares (no commit); its answer late (one revision, ok from
//      the record); two writes from one revision (one wins); a forged answer (no ok); the workspace not held meanwhile.
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
  // ---- the holder's protocol (design r3): S1 writer lifetime, S2 validation and the grant, S3 one outcome per request,
  // the ok always read from the record, and the workspace's lock never held across the exchange
  // (a tab's holder held at a stage: "prepare" (after its save of what was typed), "commit", "wrote" (saved, before
  // its answer); every stage counted)
  const pauseAt = (x, stage) => x.ev(`(() => { window.__wp = { hits: {}, stop: ${J(stage)}, at: null, go: null, req: null }; window.__sbTestWritePause = (s, req) => { const w = window.__wp; w.hits[s] = (w.hits[s] ?? 0) + 1; w.req = req; if (w.stop === s) return new Promise((r) => { w.at = s; w.go = r; }); return null; }; return true; })()`);
  const resume = (x) => x.ev(`(() => { const w = window.__wp; w.stop = null; w.go?.(); return true; })()`);
  const typeIn = async (x, text) => {
    await x.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    await x.send("Page.bringToFront");
    const at = await x.ev(`(() => { const t = document.querySelector("#cells .cell textarea"); t.scrollIntoView({ block: "center" }); const b = t.getBoundingClientRect(); return { x: b.left + b.width - 6, y: b.top + b.height / 2 }; })()`);
    for (const type of ["mousePressed", "mouseReleased"]) await x.send("Input.dispatchMouseEvent", { type, x: at.x, y: at.y, button: "left", clickCount: 1 });
    for (const c of text) {
      await x.send("Input.dispatchKeyEvent", { type: "keyDown", key: c, code: /\d/.test(c) ? "Digit" + c : "", text: c });
      await x.send("Input.dispatchKeyEvent", { type: "keyUp", key: c, code: /\d/.test(c) ? "Digit" + c : "" });
    }
  };
  const writerOf = (x) => x.until(`!!(${NB}.store.journaled && ${NB}.store.writer && ${NB}.store.ready)`, 15000);
  const rec = (x, ref) => x.ev(`new Promise((ok) => { const r = indexedDB.open("sagebrush"); r.onsuccess = () => { const g = r.result.transaction("notebooks").objectStore("notebooks").get(${J(ref)}); g.onsuccess = () => { ok(g.result ? { rev: g.result.rev, codes: g.result.cells.map((c) => c.code) } : null); r.result.close(); }; }; })`);
  // (the agent's write started, not awaited: its outcome kept in the page)
  const startWrite = (x, p, doc, b, k) => x.ev(`(() => { window.__w ??= {}; window.__w[${J(k)}] = null; ${W}.write(${J(p)}, ${J(doc)}, { base: ${b} }).then((r) => { window.__w[${J(k)}] = { ok: true, rev: r.rev }; }, (e) => { window.__w[${J(k)}] = { ok: false, code: e.code ?? null, msg: e.message }; }); return true; })()`);
  const outcome = async (x, k, ms = 30000) => { await x.until(`window.__w?.[${J(k)}] != null`, ms); return x.ev(`window.__w?.[${J(k)}] ?? null`); };
  // (a holder of a new notebook: tab x shows it as its writer)
  const held = async (p, codes) => {
    await create(A, p, nbJson(codes));
    const ref = await refOf(A, p);
    const B = await tab(`${base}?nb=${ref}`);
    tabs.push(B);
    return { ref, B, writer: await writerOf(B) };
  };

  // W5 (S1): the holder held after its save (prepare) while the person takes the notebook over in another tab: the
  // holder answers nothing it applied (it never reaches commit), the person's text is kept, and the request ends as a
  // conflict (what it was made from is no longer there)
  {
    const p = "/w5.ipynb";
    const { ref, B, writer } = await held(p, ["v = 1"]);
    const C = await tab(`${base}?nb=${ref}`);
    tabs.push(C);
    const follows = await C.until(`!!(${NB}.store.journaled && ${NB}.store.readOnly === "other")`, 15000);
    await pauseAt(B, "prepare");
    const r = await read(A, p);
    await startWrite(A, p, nbJson(["v = 2  # agent"]), r.rev, "w5");
    const paused = await B.until(`window.__wp.at === "prepare"`, 10000);
    await typeIn(C, "7");
    const took = await C.until(`!!(${NB}.store.writer && ${NB}.store.ready && ${NB}.snapshot().cells[0]?.code.includes("7"))`, 15000);
    await resume(B);
    const o = await outcome(A, "w5");
    await sleep(800);
    const rc = await rec(A, ref), commits = await B.ev(`window.__wp.hits.commit ?? 0`), shownC = await shown(C);
    check(writer && follows && paused && took && o && !o.ok && o.code === "conflict" && commits === 0 && rc?.codes?.[0]?.includes("7") && !/agent/.test(J([rc, shownC])), "W5: the holder held after its save while the person takes the notebook over in another tab: nothing applied there (no commit reached), the person's text kept, and the write ends as a conflict", { writer, follows, paused, took, o, commits, rc, shownC });
    await B.ev(`window.__sbTestWritePause = null`);
    await C.close(); await B.close();
  }
  // W5b (S1): the holder held at the commit (after "ready") while the person takes the notebook over: it applies
  // nothing (its page never shows the agent's text), and the write then ends as a conflict
  {
    const p = "/w5b.ipynb";
    const { ref, B, writer } = await held(p, ["h = 1"]);
    const C = await tab(`${base}?nb=${ref}`);
    tabs.push(C);
    const follows = await C.until(`!!(${NB}.store.journaled && ${NB}.store.readOnly === "other")`, 15000);
    await pauseAt(B, "commit");
    // (whether B's page ever shows the agent's text, looked at every 20 ms from now on)
    await B.ev(`(() => { window.__sawAgent = false; window.__look = setInterval(() => { if (J2(${NB}.snapshot()).includes("# agent")) window.__sawAgent = true; }, 20); function J2(x) { return JSON.stringify(x); } return true; })()`);
    const r = await read(A, p);
    await startWrite(A, p, nbJson(["h = 2  # agent"]), r.rev, "w5b");
    const paused = await B.until(`window.__wp.at === "commit"`, 10000);
    await typeIn(C, "4");
    const took = await C.until(`!!(${NB}.store.writer && ${NB}.store.ready && ${NB}.snapshot().cells[0]?.code.includes("4"))`, 15000);
    await resume(B);
    const o = await outcome(A, "w5b");
    await sleep(1000);
    const saw = await B.ev(`(() => { clearInterval(window.__look); return window.__sawAgent; })()`);
    const rc = await rec(A, ref);
    check(writer && follows && paused && took && saw === false && o && !o.ok && o.code === "conflict" && rc?.codes?.[0]?.includes("4") && !/agent/.test(J(rc)), "W5b: the holder held at the commit while the person takes the notebook over: nothing applied there (its page never shows the agent's text), the person's text kept, and the write ends as a conflict", { writer, follows, paused, took, saw, o, rc });
    await B.ev(`window.__sbTestWritePause = null`);
    await C.close(); await B.close();
  }
  // W6 (S2): messages on the notebook's channel that aren't a whole write's exact shape get no answer and change
  // nothing; and a grant withdrawn while the holder prepares: no commit, nothing written
  {
    const p = "/w6.ipynb";
    const { ref, B, writer } = await held(p, ["s = 1"]);
    const r = await read(A, p);
    const lock = "sagebrush-nb-writer:" + ref;
    const big = { cells: Array.from({ length: 10001 }, () => ({ type: "code", code: "" })) };
    const bad = [
      { t: "write", req: "a1", ref, doc: { cells: [] } },
      { t: "write", req: "a2", ref, doc: { cells: [] }, base: r.rev, extra: 1 },
      { t: "write", req: "a3", ref, doc: big, base: r.rev },
      { t: "write", req: "a4", ref: "another", doc: { cells: [] }, base: r.rev },
      { t: "write", req: "a5", ref, doc: { cells: [] }, base: -1 },
      { t: "write", req: "x".repeat(65), ref, doc: { cells: [] }, base: r.rev },
      { t: "write", req: "a7", ref, doc: { cells: [{ type: "code", code: 5 }] }, base: r.rev },
      { t: "commit", req: "never-asked", ref },
      { t: "commit", req: "a8", ref, extra: true },
    ];
    const heard = await A.ev(`new Promise((ok) => { const ch = new BroadcastChannel(${J(lock)}), got = []; ch.onmessage = (e) => got.push(e.data); for (const m of ${J(bad)}) ch.postMessage(m); setTimeout(() => { ch.close(); ok(got); }, 1500); })`);
    const rc = await rec(A, ref);
    check(writer && heard.length === 0 && rc?.rev === r.rev && J(rc.codes) === J(["s = 1"]), "W6: messages that aren't a whole write's exact shape (missing or extra keys, too many cells, another notebook, a bad base or request id, a cell's text not a string, a commit never asked) get no answer and change nothing", { heard, rc });
    // (the grant withdrawn while the holder prepares: the write's own check before the commit refuses it)
    await pauseAt(B, "prepare");
    await A.ev(`(() => { window.__revoked = false; window.__w ??= {}; window.__w.w6 = null; window.__sbTestWs.write(${J(p)}, ${J(nbJson(["s = 2  # agent"]))}, { base: ${r.rev}, admit: () => { if (window.__revoked) throw new Error("not allowed any more (test)"); } }).then((x) => { window.__w.w6 = { ok: true, rev: x.rev }; }, (e) => { window.__w.w6 = { ok: false, msg: e.message }; }); return true; })()`);
    const paused = await B.until(`window.__wp.at === "prepare"`, 10000);
    await A.ev(`window.__revoked = true`);
    await resume(B);
    const o = await outcome(A, "w6");
    await sleep(6000); // (past the holder's wait for a commit)
    const rc2 = await rec(A, ref), commits = await B.ev(`window.__wp.hits.commit ?? 0`);
    check(paused && o && !o.ok && /not allowed any more/.test(o.msg ?? "") && commits === 0 && rc2?.rev === r.rev && J(rc2.codes) === J(["s = 1"]), "W6: the grant withdrawn while the holder prepares: no commit sent, nothing written, the write refused", { paused, o, commits, rc2 });
    await B.ev(`window.__sbTestWritePause = null`);
    await B.close();
  }
  // W7 (S3): the holder commits and saves, its answer held past the wait (5 s): the write is answered ok from the
  // record, with that one revision; the late answer changes nothing
  {
    const p = "/w7.ipynb";
    const { ref, B, writer } = await held(p, ["t = 1"]);
    const r = await read(A, p);
    await pauseAt(B, "wrote");
    await startWrite(A, p, nbJson(["t = 2  # agent"]), r.rev, "w7");
    const paused = await B.until(`window.__wp.at === "wrote"`, 10000);
    const o = await outcome(A, "w7", 20000);
    const rc = await rec(A, ref);
    await resume(B);
    await sleep(1000);
    const rc2 = await rec(A, ref);
    check(writer && paused && o?.ok && o.rev === r.rev + 1 && rc?.rev === r.rev + 1 && J(rc.codes) === J(["t = 2  # agent"]) && J(rc2) === J(rc), "W7: the holder's answer held past the wait: the write is answered ok from the record, exactly one new revision, and the late answer changes nothing", { paused, o, base: r.rev, rc, rc2 });
    await B.ev(`window.__sbTestWritePause = null`);
    await B.close();
  }
  // W8 (S3): two writes from the same revision at once: one is saved, the other is a conflict
  {
    const p = "/w8.ipynb";
    const { ref, B, writer } = await held(p, ["k = 1"]);
    const r = await read(A, p);
    await startWrite(A, p, nbJson(["k = 2  # first"]), r.rev, "w8a");
    await startWrite(A, p, nbJson(["k = 3  # second"]), r.rev, "w8b");
    const a = await outcome(A, "w8a"), b = await outcome(A, "w8b");
    const rc = await rec(A, ref);
    const won = a?.ok ? "k = 2  # first" : "k = 3  # second";
    check(writer && [a, b].filter((x) => x?.ok).length === 1 && [a, b].filter((x) => x && !x.ok && x.code === "conflict").length === 1 && rc?.rev === r.rev + 1 && rc.codes[0] === won, "W8: two writes from the same revision at once: exactly one saved, the other a conflict", { a, b, rc });
    await B.close();
  }
  // W9: a forged "wrote" for a write under way is no ok: the write ends only once the record holds it
  {
    const p = "/w9.ipynb";
    const { ref, B, writer } = await held(p, ["f = 1"]);
    const r = await read(A, p);
    await pauseAt(B, "prepare");
    await startWrite(A, p, nbJson(["f = 2  # agent"]), r.rev, "w9");
    const paused = await B.until(`window.__wp.at === "prepare"`, 10000);
    const req = await B.ev(`window.__wp.req`);
    await A.ev(`(() => { const ch = new BroadcastChannel(${J("sagebrush-nb-writer:" + ref)}); ch.postMessage({ t: "wrote", req: ${J(req)}, rev: ${r.rev + 1} }); ch.close(); return true; })()`);
    await sleep(1500);
    const early = await A.ev(`window.__w.w9`);
    await resume(B);
    const o = await outcome(A, "w9", 40000);
    const rc = await rec(A, ref);
    check(writer && paused && early === null && o?.ok && rc?.rev === r.rev + 1 && J(rc.codes) === J(["f = 2  # agent"]), "W9: a forged \"wrote\" for a write under way is no ok: it is answered only once the record holds the write", { paused, early, o, rc });
    await B.ev(`window.__sbTestWritePause = null`);
    await B.close();
  }
  // W10: while a holder is held in the middle of a write, another change of the workspace goes through at once
  {
    const p = "/w10.ipynb";
    const { ref, B, writer } = await held(p, ["g = 1"]);
    const r = await read(A, p);
    await pauseAt(B, "prepare");
    await startWrite(A, p, nbJson(["g = 2  # agent"]), r.rev, "w10");
    const paused = await B.until(`window.__wp.at === "prepare"`, 10000);
    const t0 = Date.now();
    const made = await A.ev(`Promise.race([${W}.mkdir("/w10-other").then(() => "made", (e) => "ERR " + e.message), new Promise((r) => setTimeout(() => r("blocked"), 3000))])`);
    const ms = Date.now() - t0;
    await resume(B);
    const o = await outcome(A, "w10");
    check(writer && paused && made === "made" && o?.ok, `W10: with a holder held in the middle of a write, another workspace change goes through (${ms} ms), and the write then completes`, { paused, made, ms, o });
    await B.ev(`window.__sbTestWritePause = null`);
    await B.close();
    void ref;
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
