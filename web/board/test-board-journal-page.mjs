// The board page under the board journal (page.ts's wiring) in headless
// Chromium, the built site (web/dist, or SB_DIST) and a helper page served from one origin
// (test-board-journal-lib.mjs): the versions from before the journal kept read-only (test 15), a save's T1/T2 with no
// pending copy (1, 14), refusals said (11), TimeTravel following the store (12), a document replaced in place (6b, 6c),
// the conflict's one copy and its version recorded (13), and the load's bridge for pending copies (10).  The store
// itself is test-board-journal.mjs's.
//   bun web/build.ts && CHROME=google-chrome bun web/board/test-board-journal-page.mjs
import { join } from "node:path";
import { serve, browser, sleep, rowExpr, historyRowsExpr, activateExpr, section, checked, bounded, unlessEnding, held } from "./test-board-journal-lib.mjs";

const here = new URL(".", import.meta.url).pathname;
const J = JSON.stringify;
const results = [];
// (each check said as it is done, so a run that hangs or is killed shows how far it got; FAIL_FAST=1: the first
// failed check ends the run (the fail-first step on the base, which must fail, and quickly))
const check = (ok, what) => { results.push([!!ok, what]); checked(ok, what); if (!ok && process.env.FAIL_FAST) throw new Error("FAIL_FAST: " + what); };
const B = "window.sagebrush.board";
const S0 = "0123456789abcdef";
const PEND = (id) => "sagebrush-workspace-pending:" + id;
// (the test's note on the board's first page: its text)
const nodesOf = "(d) => (d.pages ? d.pages[0].nodes : (d.nodes ??= []))";
const setTj = (text) => `Promise.resolve(${B}.edit((d) => { const ns = (${nodesOf})(d); const x = ns.find((n) => n.id === "tj"); if (x) x.text = ${J(text)}; else ns.push({ id: "tj", x: 40, y: 40, text: ${J(text)} }); }))`;
const tjOf = (d) => (d ? (d.pages ? d.pages[0].nodes : d.nodes ?? []).find((n) => n.id === "tj")?.text : undefined);
const withTj = (d, text) => { const x = JSON.parse(JSON.stringify(d)); const ns = x.pages ? x.pages[0].nodes : (x.nodes ??= []); const n = ns.find((m) => m.id === "tj"); if (n) n.text = text; else ns.push({ id: "tj", x: 40, y: 40, text }); return x; };

// (its own bound, 1100 s, under the VM step's 1200 s and the 6c mutant's: a hang ends in one FAIL line naming its
// section, its last check and the DevTools call in flight, Chrome closed; a SIGTERM the same)
// (the server and the browser set up inside the one try, so their failure is this run's one FAIL line
// and whatever was set up is cleaned up)
let stop = () => {}, br = null, code = 1;
bounded("the board page test", 1_100_000, async () => stop());
try {
  const served = await serve({ "": process.env.SB_DIST ?? join(here, "../dist") });
  stop = served.stop;
  const { origin } = served;
  br = await browser();
  const helper = await br.tab("helper");
  await helper.go(`${origin}/__bj/`);
  if (!(await helper.until("window.ready === true"))) throw new Error("the helper page didn't load: " + (await helper.state()));
  // (a run's barrier, under BJ_FAULT=hold only)
  await held(helper, "helper");
  // (shown; and, under the journal, its store opened, when the board has a row: `store`)
  const opened = async (t, store = true) => (await t.until(`!!${B}?.snapshot?.().doc`, 30000)) && (!store || (await t.until(`!window.sagebrush.boardJournal || !!window.sagebrush.boardJournal()`, 15000)));
  async function newBoard(t) {
    await t.go(`${origin}/board/?new=python`);
    if (!(await t.until(`location.search.includes("doc=local:")`)) || !(await opened(t))) throw new Error("no new board: " + (await t.state()));
    return t.ev(`new URLSearchParams(location.search).get("doc").slice(6)`);
  }
  async function openBoard(t, id, store = true) { await t.go(`${origin}/board/?doc=local:${id}`); return opened(t, store); }
  const row = (t, id) => t.ev(rowExpr(id));
  const doc = (t) => t.ev(`JSON.parse(JSON.stringify(${B}.snapshot().doc))`);
  const versions = (t) => t.ev(`${B}.versions().then((v) => v.length)`);
  const versionDocs = (t) => t.ev(`(async () => { const n = (await ${B}.versions()).length, out = []; for (let i = 0; i < n; i++) out.push(JSON.parse(JSON.stringify(await ${B}.version(i)))); return out; })()`);
  const rowTj = (t, id, text, ms) => t.until(`${rowExpr(id)}.then((r) => !!r && (${nodesOf})(r.doc).find((n) => n.id === "tj")?.text === ${J(text)})`, ms);
  const coherent = (r) => !!r && !["rev", "j", "hash", "unjournaled", "baseRev"].some((f) => f in (r.doc ?? {})) && (["j", "hash", "unjournaled"].every((f) => !(f in r)) || (Number.isSafeInteger(r.j) && typeof r.hash === "string"));
  const plant = (t, id, header, d) => t.ev(`localStorage.setItem(${J(PEND(id))}, ${J(header)} + "\\n" + ${J(JSON.stringify(d))})`);
  const pending = (t, id) => t.ev(`localStorage.getItem(${J(PEND(id))})`);
  const notKept = (t) => t.until(`document.body.innerText.includes("Not kept in this browser")`, 5000);
  const boardsNamed = (part) => helper.ev(`(async () => { const w = await window.M.W.Workspace.open(); const l = (await w.list("/", { recursive: true })).filter((e) => e.kind === "board" && e.path.includes(${J(part)})); const out = []; for (const e of l) out.push({ path: e.path, doc: (await w.read(e.path)).content }); w.close(); return out; })()`);
  const writeAsAgent = (id, d) => helper.ev(`(async () => { const w = await window.M.W.Workspace.open(); const p = await w.pathOf("board", ${J(id)}); const out = await w.write(p, ${J(d)}, {}); w.close(); return out.rev; })()`);

  section("boards and pending copies left with the journal off");
  // ---- boards and pending copies left with the journal OFF (made here, before test
  // 15 activates it), brought in at the first journaled load (after test 15)
  const cut = {};
  {
    const t = await br.tab();
    // (a board saved by a journal-off page: its row's tag is that page's session and save number)
    const mk = async () => { const id = await newBoard(t); await t.ev(setTj("A")); await rowTj(t, id, "A"); const r = await row(t, id); const [s, n] = String(r.tag).split(":"); return { id, r, s, n: Number(n), d: await doc(t) }; };
    for (const k of ["earlier", "later", "raw", "intent"]) cut[k] = await mk();
    await t.close();
    // (a board with no tag (made, never saved by a page), and one to retitle (its title its file's name))
    const hmk = (name) => helper.ev(`(async () => { const w = await window.M.W.Workspace.open(); const e = await w.create(${J("/" + name + ".board.json")}, { content: { title: ${J(name)}, nodes: [{ id: "tj", x: 0, y: 0, text: "A" }] } }); const r = await w.read(e.path); w.close(); return { id: e.ref, rev: r.rev, path: e.path, d: r.content }; })()`);
    const tagOf = Math.floor(Math.random() * 1e6);
    cut.notag = await hmk("cut-notag-" + tagOf);
    cut.ret = await hmk("cut-ret-" + tagOf);
    const e = cut.earlier, l = cut.later, w = cut.raw;
    // the cases: a copy made on the record's revision by the same session's next save (S:n+1:R); with no tag (S0:1:R);
    // a copy older than the record's own save (S:n-1:R-1); and the controls: an ordinary write, a retitle after the copy
    await plant(helper, e.id, `${e.s}:${e.n + 1}:${e.r.rev}`, withTj(e.d, "B-earlier"));
    await plant(helper, cut.notag.id, `${S0}:1:${cut.notag.rev}`, withTj(cut.notag.d, "B-notag"));
    await plant(helper, l.id, `${l.s}:${l.n - 1}:${l.r.rev - 1}`, withTj(l.d, "C-later"));
    await plant(helper, w.id, `${w.s}:${w.n + 1}:${w.r.rev}`, withTj(w.d, "B-raw"));
    await writeAsAgent(w.id, withTj(w.d, "agent's"));
    await plant(helper, cut.ret.id, `${S0}:1:${cut.ret.rev}`, withTj(cut.ret.d, "B-ret"));
    await helper.ev(`(async () => { const w = await window.M.W.Workspace.open(); await w.rename(${J(cut.ret.path)}, ${J(cut.ret.path.replace(".board.json", "x.board.json"))}, { retitle: true }); w.close(); return true; })()`);
  }

  section("test 15: versions from before the journal, read-only");
  // ---- test 15: versions from before the journal, kept read-only (the journal still off here)
  {
    const t = await br.tab();
    const id = await newBoard(t);
    await t.ev(setTj("L1"));
    await rowTj(t, id, "L1");
    await t.ev(setTj("L2"));
    await rowTj(t, id, "L2");
    await t.until(`${B}.versions().then((v) => v.length >= 3)`);
    const n0 = await versions(t), r0 = await row(t, id);
    check(!("j" in r0) && !("hash" in r0) && (await pending(t, id)) === null, "journal off: the row as before (no envelope), the pending copy dropped once written (test 9's ground)");
    const pre = "board:local:" + id;
    const legacy0 = J((await t.ev(historyRowsExpr(pre))).filter((r) => r.nb !== pre));
    await t.close();
    check(await helper.ev(activateExpr), "the journal activated (the helper page, as the notebook page's switch does)");
    const t2 = await br.tab();
    await openBoard(t2, id);
    const r1 = await row(t2, id), n1 = await versions(t2);
    check(Number.isSafeInteger(r1.j) && coherent(r1), "the first journaled load stamps the row (test 4, on the page)");
    check(n1 === n0, `test 15 (a, b): the versions from before listed first, the load's stamp (the same document) not listed again: ${J({ before: n0, now: n1 })}`);
    await t2.ev(setTj("J1"));
    await rowTj(t2, id, "J1");
    await t2.until(`${B}.versions().then((v) => v.length === ${n0 + 1})`);
    const vd = await versionDocs(t2);
    check(vd.length === n0 + 1 && tjOf(vd[n0 - 1]) === "L2" && tjOf(vd[n0]) === "J1", "test 15 (a): legacy, then journaled: " + J(vd.map(tjOf)));
    // Revert (TimeTravel's) to the legacy version with L1: a new journaled version
    const i = vd.findIndex((d) => tjOf(d) === "L1");
    await t2.ev(`document.querySelector('[data-sbb="timetravel"]').click()`);
    await t2.until(`!document.querySelector('[data-sbb="tt"]').hidden`);
    await t2.ev(`(() => { const s = document.querySelector('[data-sbb="ttslider"]'); s.value = String(${i}); s.dispatchEvent(new Event("input")); })()`);
    await t2.until(`document.querySelector('[data-sbb="ttwhen"]').textContent.startsWith("Version ${i + 1} of")`);
    await t2.ev(`document.querySelector('[data-sbb="ttrevert"]').click()`);
    const reverted = await rowTj(t2, id, "L1");
    await t2.until(`${B}.versions().then((v) => v.length === ${n0 + 2})`);
    const legacy1 = J((await t2.ev(historyRowsExpr(pre))).filter((r) => r.nb !== pre));
    check(reverted && (await versions(t2)) === n0 + 2 && legacy1 === legacy0, "test 15 (c): Revert to a version from before the journal: a new journaled version, the old rows byte for byte as they were");
    await t2.close();
  }

  section("the first journaled load of those boards");
  // ---- the first journaled load of those boards (the journal active now)
  {
    const u = await br.tab();
    const look = async (id) => { await openBoard(u, id); await u.until(`localStorage.getItem(${J(PEND(id))}) === null`, 15000); return { r: await row(u, id), d: await doc(u), v: await versionDocs(u), pend: await pending(u, id) }; };
    const copiesOf = async (text) => (await boardsNamed("(unsaved changes from a closed page)")).filter((c) => tjOf(c.doc) === text);
    for (const [k, text, header] of [["earlier", "B-earlier", `${cut.earlier.s}:${cut.earlier.n + 1}:${cut.earlier.r.rev}`], ["notag", "B-notag", `${S0}:1:${cut.notag.rev}`]]) {
      const x = await look(cut[k].id);
      const ok = await rowTj(u, cut[k].id, text);
      const r = await row(u, cut[k].id), v = await versionDocs(u);
      check(ok && tjOf(await doc(u)) === text && v.filter((y) => tjOf(y) === text).length === 1 && (await copiesOf(text)).length === 0 && x.pend === null && r.tag === header && !("stampOf" in r) && Number.isSafeInteger(r.j), `journal-off copy (${k === "notag" ? "no tag" : "an earlier save of the same session"}): the copy made with the journal off is brought into the board, once, with its own header as the tag; the stamp's stampOf gone: ` + J({ tag: r.tag, stampOf: r.stampOf }));
      // (and a load again: nothing more)
      await openBoard(u, cut[k].id);
      check(J(await row(u, cut[k].id)) === J(r) && (await versionDocs(u)).length === v.length, `journal-off copy (${k}): loaded again, nothing written, no version added`);
    }
    {
      const x = await look(cut.later.id);
      check(tjOf(x.r.doc) === "A" && tjOf(x.d) === "A" && (await copiesOf("C-later")).length === 0 && x.pend === null && x.r.stampOf === x.r.rev - 1, "journal-off copy (a later save of the session in the record): the older copy dropped, the board as recorded (stamped)");
    }
    {
      const x = await look(cut.raw.id);
      check(tjOf(x.r.doc) === "agent's" && (await copiesOf("B-raw")).length === 1 && x.pend === null, "journal-off copy control (an ordinary write after the copy): the copy a board of its own, the board the writer's");
    }
    {
      const x = await look(cut.ret.id);
      check(x.r.doc.title === cut.ret.d.title + "x" && tjOf(x.r.doc) === "A" && (await copiesOf("B-ret")).length === 1 && x.pend === null, "journal-off copy control (a retitle after the copy): the copy a board of its own, the board retitled");
    }
    {
      // (a committed later intent: the stamped board's T1 alone, then a copy made on the revision before the stamp)
      const c = cut.intent;
      await openBoard(u, c.id);
      const r = await row(u, c.id), d = await doc(u);
      await u.ev(`window.sagebrush.boardJournal().t1({ ...${J(withTj(d, "I-later"))}, baseRev: ${r.rev} }).then(() => true)`);
      await plant(u, c.id, `${S0}:5:${c.r.rev}`, withTj(d, "B-intent"));
      await u.close();
      const v = await br.tab();
      await openBoard(v, c.id);
      await v.until(`localStorage.getItem(${J(PEND(c.id))}) === null`, 15000);
      const r2 = await row(v, c.id);
      check(r.stampOf === c.r.rev && tjOf(r2.doc) === "I-later" && !("stampOf" in r2) && (await copiesOf("B-intent")).length === 1, "journal-off copy control (a committed later intent): replayed (the stamp's stampOf gone), the copy a board of its own");
      await v.close();
    }
  }

  section("tests 1, 14: a save journaled, no pending copy");
  // ---- tests 1, 14 and the refusal's ground: a save journaled, no pending copy; a board with no row yet
  let id1;
  {
    const t = await br.tab();
    id1 = await newBoard(t);
    const r0 = await row(t, id1);
    await t.ev(setTj("one"));
    const saved = await rowTj(t, id1, "one");
    const r1 = await row(t, id1);
    check(saved && Number.isSafeInteger(r0.j) && r1.j > r0.j && r1.rev === r0.rev + 1 && coherent(r1) && (await pending(t, id1)) === null, "test 1 (page): an edit's save is the journal's (T1 then T2: the row's j moves on), with no pending copy in localStorage");
    await t.close();
    // test 14: a board only a pending copy holds; a board not in the workspace at all
    for (const how of ["pending copy", "none"]) {
      const id = (how === "pending copy" ? "aa" : "bb") + "00000000" + String(Math.floor(Math.random() * 90 + 10));
      const u = await br.tab();
      await u.go(`${origin}/__bj/`);
      await u.until("window.ready === true");
      if (how === "pending copy") await plant(u, id, `${S0}:1:0`, { title: "only pending", nodes: [{ id: "tj", x: 0, y: 0, text: "P" }] });
      await openBoard(u, id, how === "pending copy");
      if (how === "none") { await u.ev(setTj("first")); await rowTj(u, id, "first"); }
      else await u.until(`${rowExpr(id)}.then((r) => !!r)`);
      const r = await row(u, id);
      await u.until(`${B}.versions().then((v) => v.length >= 1)`);
      check(!!r && Number.isSafeInteger(r.j) && coherent(r) && (await versions(u)) === 1 && (await pending(u, id)) === null, `test 14 (${how}): its row made first, then stamped by the store's load: one version: ` + J({ j: r?.j, v: await versions(u) }));
      await u.close();
    }
  }

  section("test 11: a refusal said");
  // ---- test 11: a refusal said
  {
    const a = await br.tab(), b = await br.tab();
    await openBoard(a, id1);
    await openBoard(b, id1);
    const r0 = await row(a, id1);
    check((await b.ev(`window.sagebrush.boardJournal().writer`)) === false, "a second tab of the board isn't its writer");
    await b.ev(setTj("from b")).catch(() => {});
    check((await notKept(b)) && J(await row(a, id1)) === J(r0), "test 11: the second tab's first edit says \"Not kept in this browser\", nothing written");
    await b.close();
    // the browser refusing the board's T2: said at the next edit; kept again once it lets it
    await a.ev(`(() => { window.__put = IDBObjectStore.prototype.put; IDBObjectStore.prototype.put = function (...x) { if (this.name === "boards") throw new DOMException("out of room (the test's)", "QuotaExceededError"); return window.__put.apply(this, x); }; })()`);
    await a.ev(setTj("refused 1"));
    await sleep(1500);
    await a.ev(setTj("refused 2")).catch(() => {});
    const said = await notKept(a);
    await a.ev(`IDBObjectStore.prototype.put = window.__put`);
    await a.ev(setTj("kept again")).catch(() => {});
    check(said && (await rowTj(a, id1, "kept again")), "test 11: a T2 the browser refuses: the next edit says \"Not kept\"; once it allows it, kept again");
    await a.close();
  }

  section("test 12, 6b, 6c: TimeTravel and a document replaced");
  // ---- test 12 and 6b, 6c
  {
    const t = await br.tab();
    await openBoard(t, id1);
    await t.ev(`document.querySelector('[data-sbb="timetravel"]').click()`);
    await t.until(`!document.querySelector('[data-sbb="tt"]').hidden`);
    const m0 = Number(await t.ev(`document.querySelector('[data-sbb="ttslider"]').max`));
    const r = await row(t, id1), d = await doc(t);
    await t.ev(`window.sagebrush.boardJournal().save({ ...${J(withTj(d, "by the store"))}, baseRev: ${r.rev} }, {}).then(() => true)`);
    check(await t.until(`Number(document.querySelector('[data-sbb="ttslider"]').max) === ${m0 + 1} && !document.querySelector('[data-sbb="tt"]').hidden`, 5000), "test 12: TimeTravel open, a version the store keeps moves its slider (the facade's on)");
    await t.close();
    // 6b: a document replaced in place (the agent's load: Open…'s path): only its versions; the journal's rows intact
    const u = await br.tab();
    await openBoard(u, id1);
    const before = await row(u, id1);
    await u.ev(`${B}.load({ title: "replaced", nodes: [{ id: "tj", x: 0, y: 0, text: "new doc" }] }).then(() => true)`);
    await u.ev(setTj("edited"));
    await rowTj(u, id1, "edited");
    await u.until(`${B}.versions().then((v) => v.length >= 1)`);
    const vd = await versionDocs(u), after = await row(u, id1);
    check(vd.length >= 1 && vd.every((x) => x.title === "replaced") && tjOf(vd.at(-1)) === "edited" && after.j > before.j && coherent(after), "test 6b: replaced in place: TimeTravel has the new document's versions only, the record's journal goes on: " + J(vd.map((x) => [x.title, tjOf(x)])));
    // 6c: mount's dropHistory (the end of its newHistory chain) held by the page's hook until
    // the new document's versions are kept; then let go: they, and the journal's rows, all survive it
    const pre = "board:local:" + id1;
    await u.ev(`(() => { const h = window.sagebrush.boardJournalHook; window.__dropped = false; window.__dropHeld = false; h.beforeDropHistory = () => new Promise((r) => { window.__dropHeld = true; window.__dropGo = r; }); h.afterDropHistory = () => { window.__dropped = true; }; return true; })()`);
    await u.ev(`${B}.load({ title: "replaced again", nodes: [{ id: "tj", x: 0, y: 0, text: "v1" }] }).then(() => true)`);
    const dropHeld = await u.until("window.__dropHeld === true", 10000);
    await u.ev(setTj("after the replacement"));
    await rowTj(u, id1, "after the replacement");
    // (during the hold, the journal store's own versions, read straight from it (boardJournal().history, what
    // TimeTravel's facade reads): the facade itself can't be read here, since mount.ts opens a document's TimeTravel
    // only after its newHistory chain, which ends with this very dropHistory)
    // (only once its history's session is set, as page.ts's own() reads it; else null, and check 1 fails saying so)
    const storeDocs = () => u.ev(`(async () => { const h = window.sagebrush.boardJournal()?.history; if (!h?.session) return null; const out = []; for (const v of h.versions()) out.push(JSON.parse(JSON.stringify(await h.docAt(v.time)))); return out; })()`);
    await u.until(`(async () => { const h = window.sagebrush.boardJournal()?.history; if (!h?.session) return false; const v = h.versions(); return v.length > 0 && (${nodesOf})(await h.docAt(v[v.length - 1].time)).some((n) => n.id === "tj" && n.text === "after the replacement"); })()`);
    const kept = await storeDocs(), rowKept = await row(u, id1);
    const journalRows = J((await u.ev(historyRowsExpr(pre))).filter((x) => x.nb === pre).map((x) => x.time));
    await u.ev("window.__dropGo()");
    const dropped = await u.until("window.__dropped === true", 10000);
    await sleep(300);
    const keptAfter = await storeDocs(), rowAfter = await row(u, id1);
    const journalRowsAfter = J((await u.ev(historyRowsExpr(pre))).filter((x) => x.nb === pre).map((x) => x.time));
    // (and TimeTravel, open now the drop is done: the new document's versions only)
    const vd2 = await versionDocs(u);
    check(dropHeld && dropped && Array.isArray(kept) && kept.length >= 1 && kept.every((x) => x.title === "replaced again") && tjOf(kept.at(-1)) === "after the replacement", "test 6c: dropHistory held until the new document's versions were kept (read from the store, its session set): they are its only versions, the last the edit: " + (kept === null ? "the store's history has no session" : J(kept.map((x) => [x.title, tjOf(x)]))));
    check(Array.isArray(kept) && Array.isArray(keptAfter) && J(keptAfter) === J(kept) && J(rowAfter) === J(rowKept) && journalRowsAfter === journalRows && vd2.length >= 1 && vd2.every((x) => x.title === "replaced again") && tjOf(vd2.at(-1)) === "after the replacement", "test 6c: …dropHistory let go after them: every version, the row and the journal's rows survive it, exactly; TimeTravel shows the new document's only: " + J({ before: kept?.length ?? "no session", after: keptAfter?.length ?? "no session", shown: vd2?.length }));
    await u.ev(`(() => { const h = window.sagebrush.boardJournalHook; delete h.beforeDropHistory; delete h.afterDropHistory; return true; })()`);
    // a replacement whose clear fails (the browser refusing its mark's write): said, and the
    // versions from before it hidden, so no Revert brings the other document back
    await u.ev(`(() => { window.__put = IDBObjectStore.prototype.put; IDBObjectStore.prototype.put = function (...x) { if (this.name === "boards") throw new DOMException("out of room (the test's)", "QuotaExceededError"); return window.__put.apply(this, x); }; return true; })()`);
    // (versions there to hide, counted before the replacement)
    const hiddenN = (await versionDocs(u)).length;
    await u.ev(`${B}.load({ title: "after a failed clear", nodes: [{ id: "tj", x: 0, y: 0, text: "n1" }] }).then(() => true)`);
    const saidClear = await u.until(`document.body.innerText.includes("TimeTravel couldn't clear the previous document's versions")`, 10000);
    await u.ev(`(() => { IDBObjectStore.prototype.put = window.__put; return true; })()`);
    // (the mark kept in localStorage outlives a reload, the older versions still hidden; the
    // next save tries the clear again, and done, forgets the mark)
    const UNCLEAR = `sagebrush-board-journal-unclear:${id1}`;
    const keyHeld = await u.ev(`localStorage.getItem(${J(UNCLEAR)}) !== null`);
    await openBoard(u, id1);
    const vd3 = await versionDocs(u);
    await u.ev(setTj("after the failed clear")).catch(() => {});
    await rowTj(u, id1, "after the failed clear");
    const cleared = await u.until(`localStorage.getItem(${J(UNCLEAR)}) === null`, 10000);
    await u.until(`${B}.versions().then((v) => v.length >= 1)`);
    const vd4 = await versionDocs(u);
    // (exact: no save of the new document yet (its first was refused with the clear), so after the reload nothing
    // at all is listed, though there were versions before; vd4 below is the positive control that the list works)
    check(saidClear && keyHeld && hiddenN >= 1 && vd3.length === 0, "a failed clear: a replacement's clear refused: said; the mark kept; reloaded, TimeTravel lists none of the " + hiddenN + " versions from before: " + J(vd3.map((x) => [x.title, tjOf(x)])));
    check(cleared && vd4.length === 1 && tjOf(vd4[0]) === "after the failed clear", "a failed clear: the next save clears them and forgets the mark: one version, the save's: " + J(vd4.map((x) => [x.title, tjOf(x)])));
    // (the clear failing across a save of the new document (only the clear's mark is refused: the
    // one boards write here with unjournaled true), then a reload: TimeTravel lists that new version, none of the
    // previous document's (the hide is "before the mark", not "everything"); then the next save, the clear done, leaves
    // exactly that save)
    const hiddenD = (await versionDocs(u)).length;
    await u.ev(`(() => { window.__put = IDBObjectStore.prototype.put; IDBObjectStore.prototype.put = function (...x) { if (this.name === "boards" && x[0] && x[0].unjournaled === true) throw new DOMException("out of room (the test's)", "QuotaExceededError"); return window.__put.apply(this, x); }; return true; })()`);
    await u.ev(`${B}.load({ title: "n1-d doc", nodes: [{ id: "tj", x: 0, y: 0, text: "n1-d" }] }).then(() => true)`);
    const saidD = await u.until(`document.body.innerText.includes("TimeTravel couldn't clear the previous document's versions")`, 10000);
    await u.ev(setTj("n1-d saved")).catch(() => {});
    const savedD = await rowTj(u, id1, "n1-d saved");
    await u.ev(`(() => { IDBObjectStore.prototype.put = window.__put; return true; })()`);
    const keyD = await u.ev(`localStorage.getItem(${J(`sagebrush-board-journal-unclear:${id1}`)}) !== null`);
    await openBoard(u, id1);
    await u.until(`${B}.versions().then((v) => v.length >= 1)`);
    const vd6 = await versionDocs(u);
    check(saidD && savedD && keyD && hiddenD >= 1 && vd6.length >= 1 && vd6.every((x) => x.title === "n1-d doc") && vd6.some((x) => tjOf(x) === "n1-d saved"), "a failed clear across a save: the clear failing across a save of the new document, then a reload: TimeTravel lists the new document's versions (its save among them) and none of the " + hiddenD + " from before: " + J(vd6.map((x) => [x.title, tjOf(x)])));
    await u.ev(setTj("n1-d after")).catch(() => {});
    await rowTj(u, id1, "n1-d after");
    const clearedD = await u.until(`localStorage.getItem(${J(`sagebrush-board-journal-unclear:${id1}`)}) === null`, 10000);
    await u.until(`${B}.versions().then((v) => v.length >= 1)`);
    const vd7 = await versionDocs(u);
    check(clearedD && vd7.length === 1 && tjOf(vd7[0]) === "n1-d after", "a failed clear across a save: the next save, the clear done: every version gone, TimeTravel starting again from that save: " + J(vd7.map((x) => [x.title, tjOf(x)])));
    // the mark's localStorage failing.  (1) setItem throwing: the notice says the hide is this
    // tab's only; reloaded, the previous document's versions show again, as said, and nothing is cleared by a save
    const MARK = `sagebrush-board-journal-unclear:${id1}`;
    const failClear = `(() => { window.__put = IDBObjectStore.prototype.put; IDBObjectStore.prototype.put = function (...x) { if (this.name === "boards" && x[0] && x[0].unjournaled === true) throw new DOMException("out of room (the test's)", "QuotaExceededError"); return window.__put.apply(this, x); }; return true; })()`;
    const okClear = `(() => { IDBObjectStore.prototype.put = window.__put; return true; })()`;
    const failStore = (m) => `(() => { window.__${m} = Storage.prototype.${m}; Storage.prototype.${m} = function (k, ...x) { if (String(k).startsWith("sagebrush-board-journal-unclear:")) throw new DOMException("the test's", "QuotaExceededError"); return window.__${m}.call(this, k, ...x); }; return true; })()`;
    const okStore = (m) => `(() => { Storage.prototype.${m} = window.__${m}; return true; })()`;
    await u.ev(setTj("before s1")).catch(() => {});
    await rowTj(u, id1, "before s1");
    const beforeS1 = (await versionDocs(u)).length;
    await u.ev(failClear); await u.ev(failStore("setItem"));
    await u.ev(`${B}.load({ title: "s1 doc", nodes: [{ id: "tj", x: 0, y: 0, text: "s1" }] }).then(() => true)`);
    const saidS1 = await u.until(`document.body.innerText.includes("hidden in this tab only")`, 10000);
    const noMark = await u.ev(`localStorage.getItem(${J(MARK)}) === null`);
    await u.ev(okClear); await u.ev(okStore("setItem"));
    await openBoard(u, id1);
    await u.until(`${B}.versions().then((v) => v.length >= 1)`);
    const vs1 = await versionDocs(u);
    check(saidS1 && noMark && beforeS1 >= 1 && vs1.some((x) => tjOf(x) === "before s1"), "the mark unwritable (setItem throwing): said \"hidden in this tab only\", no mark kept; reloaded, the previous document's versions show again, as said: " + J({ n: vs1.length }));
    // (2) removeItem throwing as a retried clear succeeds: the spent mark left in localStorage; through further saves, a
    // reload and more saves, it never clears the new document's versions again (and is forgotten once it can be)
    await u.ev(failClear);
    await u.ev(`${B}.load({ title: "s2 doc", nodes: [{ id: "tj", x: 0, y: 0, text: "s2" }] }).then(() => true)`);
    await u.until(`localStorage.getItem(${J(MARK)}) !== null`, 10000);
    await u.ev(okClear); await u.ev(failStore("removeItem"));
    const saves = ["s2 a", "s2 b", "s2 c"];
    for (const t of saves) { await u.ev(setTj(t)).catch(() => {}); await rowTj(u, id1, t); }
    const stale = await u.ev(`localStorage.getItem(${J(MARK)}) !== null`);
    await u.ev(okStore("removeItem"));
    await openBoard(u, id1);
    for (const t of ["s2 d", "s2 e"]) { await u.ev(setTj(t)).catch(() => {}); await rowTj(u, id1, t); }
    await u.until(`${B}.versions().then((v) => v.length >= 5)`, 10000);
    const vs2 = await versionDocs(u), forgot = await u.ev(`localStorage.getItem(${J(MARK)}) === null`);
    check(stale && forgot && J(vs2.map(tjOf)) === J(["s2 a", "s2 b", "s2 c", "s2 d", "s2 e"]) && vs2.every((x) => x.title === "s2 doc"), "the mark unremovable (removeItem throwing): the spent mark left behind never clears the new document's versions, through saves, a reload and more saves; then forgotten: " + J({ stale, forgot, versions: vs2.map(tjOf) }));
    // …and a kill between T1 and T2 right after the replacement still replays
    const r2 = await row(u, id1), d2 = await doc(u);
    await u.ev(`window.sagebrush.boardJournal().t1({ ...${J(withTj(d2, "killed"))}, baseRev: ${r2.rev} }).then(() => true)`);
    await u.close();
    const v = await br.tab();
    await openBoard(v, id1);
    check((await rowTj(v, id1, "killed")) && tjOf(await doc(v)) === "killed", "test 6b: killed between T1 and T2 after the replacement: the next load replays it");
    await v.close();
  }

  section("test 13: the conflict's one copy");
  // ---- test 13: the conflict's one copy; the other version stamped and recorded
  {
    const t = await br.tab();
    const id = await newBoard(t);
    await t.ev(setTj("start"));
    await rowTj(t, id, "start");
    const d = await doc(t);
    await writeAsAgent(id, withTj(d, "theirs"));
    await t.ev(`(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(${B}.edit((x) => { (${nodesOf})(x).find((n) => n.id === "tj").text = "mine " + i; })); return true; })()`);
    await t.until(`window.sagebrush.saveLog().some((e) => e.what === "conflict")`);
    await t.until(`(${nodesOf})(${B}.snapshot().doc).find((n) => n.id === "tj")?.text === "theirs"`);
    await sleep(1500);
    const copies = await boardsNamed("(your changes, made while it changed elsewhere)");
    const r = await row(t, id), log = await t.ev(`window.sagebrush.saveLog().map((e) => e.what)`);
    const vd = await versionDocs(t);
    check(copies.length === 1 && tjOf(copies[0].doc) === "mine 5", "test 13: the edits made while the conflict was handled all in ONE copy (the last of them in it): " + J(copies.map((c) => [c.path, tjOf(c.doc)])));
    check(tjOf(await doc(t)) === "theirs" && tjOf(r.doc) === "theirs" && Number.isSafeInteger(r.j) && coherent(r) && vd.some((x) => tjOf(x) === "theirs"), "test 13: the board shows the other version, which the store's load stamped and kept as a version");
    check(log.includes("passed over") || log.includes("to the copy"), "test 13: the queue's latest-only and its views' routing at work: " + J(log.slice(-12)));
    await t.close();
  }

  section("test 10: the load's bridge");
  // ---- test 10: the load's bridge, each crash point and refusal, and what survives
  {
    const fresh = async () => { const t = await br.tab(); const id = await newBoard(t); const d = await doc(t), r = await row(t, id); return { t, id, d, r }; };
    section("test 10 (a)");
    // (a) cut before T1: the copy brought in, once
    {
      const { t, id, d, r } = await fresh();
      await t.close();
      const u = await br.tab();
      await u.go(`${origin}/__bj/`); await u.until("window.ready === true");
      await plant(u, id, `${S0}:7:${r.rev}`, withTj(d, "P-a"));
      await openBoard(u, id);
      const ok = await rowTj(u, id, "P-a");
      await u.until(`localStorage.getItem(${J(PEND(id))}) === null`);
      const vd = await versionDocs(u);
      check(ok && (await pending(u, id)) === null && vd.filter((x) => tjOf(x) === "P-a").length === 1, "test 10 (a, cut before T1): the board is the copy, brought in once; no pending item left");
      await u.close();
    }
    section("test 10 (b)");
    // (b) cut between T1 and T2: the intent replayed, then the copy dropped, since the record matches it by hash
    {
      const { t, id, d, r } = await fresh();
      await t.ev(`window.sagebrush.boardJournal().t1({ ...${J(withTj(d, "P-b"))}, baseRev: ${r.rev} }).then(() => true)`);
      await plant(t, id, `${S0}:7:${r.rev}`, withTj(d, "P-b"));
      await t.close();
      const u = await br.tab();
      await openBoard(u, id);
      const ok = await rowTj(u, id, "P-b");
      const vd = await versionDocs(u);
      check(ok && (await pending(u, id)) === null && vd.filter((x) => tjOf(x) === "P-b").length === 1, "test 10 (b, cut between T1 and T2): the board is the copy (its intent replayed), dropped, since the record matches it by hash; one version of it");
      await u.close();
    }
    section("test 10 (c)");
    // (c) cut after T2, before the drop: the copy dropped, since the record matches it by hash; one import
    {
      const { t, id, d, r } = await fresh();
      const h = `${S0}:7:${r.rev}`;
      await t.ev(`window.sagebrush.boardJournal().save({ ...${J(withTj(d, "P-c"))}, baseRev: ${r.rev} }, { tag: ${J(h)} }).then(() => true)`);
      await plant(t, id, h, withTj(d, "P-c"));
      await t.close();
      const u = await br.tab();
      await openBoard(u, id);
      await u.until(`localStorage.getItem(${J(PEND(id))}) === null`);
      const r2 = await row(u, id), vd = await versionDocs(u);
      check(tjOf(r2.doc) === "P-c" && r2.rev === r.rev + 1 && vd.filter((x) => tjOf(x) === "P-c").length === 1, "test 10 (c, cut after T2 before the drop): dropped, since the record matches it by hash; a single import (no second save)");
      await u.close();
    }
    section("test 10 (d)");
    // (d) refused (another tab is the writer): the copy shown, the pending item stays, the next edit says so
    {
      const { t: a, id, d, r } = await fresh();
      await plant(a, id, `${S0}:7:${r.rev}`, withTj(d, "P-d"));
      const b = await br.tab();
      await openBoard(b, id);
      check(tjOf(await doc(b)) === "P-d" && (await pending(b, id))?.startsWith(`${S0}:7:`) && J(await row(b, id)) === J(r), "test 10 (d, refused): the copy shown, the pending item kept, the row as it was");
      await b.ev(setTj("P-d edited")).catch(() => {});
      check(await notKept(b), "test 10 (d): …the next edit says \"Not kept\"");
      await b.close();
      await a.close();
    }
    section("test 10 (e)");
    // (e) another header written before the drop: it stays
    {
      const { t, id, d, r } = await fresh();
      await t.close();
      const u = await br.tab();
      await u.send("Page.addScriptToEvaluateOnNewDocument", { source: `(() => { const real = navigator.locks.request.bind(navigator.locks); let open; const gate = new Promise((x) => (open = x)); window.__open = () => open(); navigator.locks.request = function (name, ...rest) { if (name === "sagebrush-workspace" && window.sagebrush?.boardJournal?.()) { window.__held = true; return gate.then(() => real(name, ...rest)); } return real(name, ...rest); }; })()` });
      await u.go(`${origin}/__bj/`); await u.until("window.ready === true");
      await plant(u, id, `${S0}:7:${r.rev}`, withTj(d, "P-e"));
      await openBoard(u, id);
      const held = await u.until("window.__held === true", 10000);
      await plant(u, id, `fedcba9876543210:1:${r.rev}`, withTj(d, "another page's"));
      await u.ev("window.__open()");
      const ok = await rowTj(u, id, "P-e");
      await sleep(500);
      check(held && ok && (await pending(u, id))?.startsWith("fedcba9876543210:1:"), "test 10 (e): another page's pending item written before the drop: it stays (the drop matches the original header)");
      await u.close();
    }
    section("test 10 (f)");
    // (f) a stale base: the copy a board of its own, the board the record
    {
      const { t, id, d, r } = await fresh();
      await t.close();
      await writeAsAgent(id, withTj(d, "agent's"));
      const u = await br.tab();
      await u.go(`${origin}/__bj/`); await u.until("window.ready === true");
      await plant(u, id, `${S0}:7:${r.rev}`, withTj(d, "P-f"));
      await openBoard(u, id);
      await u.until(`localStorage.getItem(${J(PEND(id))}) === null`);
      const copies = (await boardsNamed("(unsaved changes from a closed page)")).filter((c) => tjOf(c.doc) === "P-f");
      check(copies.length === 1 && tjOf(await doc(u)) === "agent's" && tjOf((await row(u, id)).doc) === "agent's", "test 10 (f, a stale base): one \"(unsaved changes from a closed page)\" copy; the board is the record");
      await u.close();
    }
    section("test 10 (g)");
    // (g) an interrupted T1, and an older pending copy: the board the intent's, the copy a board of its own
    {
      const { t, id, d, r } = await fresh();
      await t.ev(`window.sagebrush.boardJournal().t1({ ...${J(withTj(d, "I-g"))}, baseRev: ${r.rev} }).then(() => true)`);
      await plant(t, id, `${S0}:3:${r.rev - 1}`, withTj(d, "P-g"));
      await t.close();
      const u = await br.tab();
      await openBoard(u, id);
      await u.until(`localStorage.getItem(${J(PEND(id))}) === null`);
      const copies = (await boardsNamed("(unsaved changes from a closed page)")).filter((c) => tjOf(c.doc) === "P-g");
      check(tjOf((await row(u, id)).doc) === "I-g" && tjOf(await doc(u)) === "I-g" && copies.length === 1, "test 10 (g): an interrupted T1 and an older pending copy: the board is the intent's value; the copy a board of its own; nothing pending left");
      await u.close();
    }
  }

  await unlessEnding();
  const fails = results.filter(([ok]) => !ok).map(([, what]) => what);
  // (each failure one line, so its summary's count is its list's: a page error's stack joined into one)
  for (const e of br.errors) fails.push("page error: " + String(e).replace(/\s*\n\s*/g, " | "));
  for (let i = 0; i < fails.length; i++) fails[i] = String(fails[i]).replace(/\s*\n\s*/g, " | ");
  if (fails.length) console.error(`FAIL: ${fails.length} of ${results.length} checks\n  ` + fails.join("\n  "));
  else {
    console.log(`ok: the board page under the board journal, ${results.length} checks`);
    if (process.env.SHOW) for (const [, what] of results) console.log("  " + what);
    code = 0;
  }
} catch (e) {
  await unlessEnding();
  console.error("FAIL: " + (e?.stack ?? e));
} finally {
  await unlessEnding();
  await br?.close();
  stop();
}
await unlessEnding();
process.exit(code);
