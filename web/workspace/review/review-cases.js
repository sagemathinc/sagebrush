// The review page's cases (review-page.ts, with Workspace.noteBranchRun and branch-store.ts's oidsAt/blobAt), in a real
// browser; run by test-workspace-review.mjs.  Every wait is on an event (the review's idle(), a hook the test holds, a
// wake it counts), never a sleep.
import * as W from "./ws.js";

const enc = (s) => new TextEncoder().encode(s);
const T = W.REVIEW_PAGE_TEXT, R = W.REVIEW_TEXT;
let n = 0;
const fresh = (tag) => W.Workspace.open({ name: `rv-${tag}-${Date.now()}-${++n}`, mainName: `rv-${tag}-main-${Date.now()}-${n}` });
const gh = (w) => w.branchHost("agent:test");
const caller = (owner = "g1") => ({ owner, actor: "agent:test", live: () => true });
const make = (w, name, owner = "g1") => W.gitBranch(gh(w), { name, owner, folders: ["/"], live: () => true, actor: "agent:test" });
const agent = (w, owner = "g1") => w.forAgent("agent:test", { owner: () => owner });
const commit = (w, name, message, review = true) => W.gitCommit(gh(w), { name, message, ...(review ? { review: true } : {}) }, caller());
const caught = async (p) => { try { await p; return null; } catch (e) { return e; } };
const B = (x) => "/Branches/" + x;
async function edit(w, path, f) { const r = await w.read(path); await agent(w).write(path, f(r.content), { base: r.rev }); }
const nb = (cells, mode = "sage") => ({ mode, cells });
/** A finished run's note, as run-verbs.ts makes it: the target as read, its canonical bytes' blob id. */
async function noteRun(w, name, path, at = Date.now(), owner = "g1", live = () => true) {
  const b = await w.branchAtName(name), doc = await w.read(path);
  const kind = doc.entry.kind === "notebook" ? "notebook" : "file";
  const oid = await W.blobOid(W.docCanonBytes(kind, doc.content, b.record.canon ?? 1));
  const r = await w.runHost("agent:test", () => owner).noteBranchRun(b.fid, name, path, { at, oid }, live);
  // (the wake run-verbs.ts sends after a note is written)
  if (r.r === "ok") W.tellBranch({ ns: (await W.openBranchStore(w.dbName)).name, fid: b.fid, seq: r.seq });
  return r;
}
/** The notebook component, counted: every component made, its options and what it was loaded with. */
function nbModule() {
  const made = [];
  const mod = import("./nb.js").then((m) => ({ createNotebook(root, opts) { const c = m.createNotebook(root, opts); const rec = { opts, doc: null }; made.push(rec); return { ...c, load(doc) { rec.doc = JSON.parse(JSON.stringify(doc)); return c.load(doc); }, setReadOnly: (x) => c.setReadOnly(x), destroy: () => c.destroy() }; } }));
  return { made, load: () => mod };
}
function panel() { const el = document.createElement("div"); document.body.append(el); return el; }
const text = (el) => el.textContent;
/** The file row whose path button says `p`. */
const row = (el, p) => [...el.querySelectorAll(".file")].find((f) => f.querySelector(".path")?.textContent.startsWith(p));
const click = (el) => el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
/** The person picks `d` (0 accept, 1 reject, 2 ask) for `p`, with a reason. */
function decide(el, p, d, reason) {
  const r = row(el, p);
  const radios = r.querySelectorAll("input[type=radio]");
  radios[d].checked = true; radios[d].dispatchEvent(new Event("change"));
  if (reason !== undefined) { const t = r.querySelector("input[type=text]"); t.value = reason; t.dispatchEvent(new Event("input")); }
}
const submitBtn = (el) => [...el.querySelectorAll("button")].find((b) => b.textContent === T.submit);
/** Submit, then the review's redraw. */
async function submit(el, view) { click(submitBtn(el)); await settle(view); }
/** The review idle, with nothing waiting (each change it was told of handled). */
async function settle(view) { for (let i = 0; i < 20; i++) { await view.idle(); await new Promise((r) => setTimeout(r, 0)); if (!view.counters().active && !view.counters().pending) return; } }

const PNG = (w, h) => btoa(String.fromCharCode(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, w >> 8, w & 255, 0, 0, h >> 8, h & 255, 8, 6, 0, 0, 0));

export async function run(only, skip = []) {
  const out = [];
  const check = (ok, what) => out.push([!!ok, what]);
  for (const [name, f] of Object.entries(CASES)) {
    if ((only && !only.includes(name)) || skip.includes(name)) continue;
    const t0 = performance.now();
    try { await f(check); } catch (e) { check(false, `${name} threw: ${e?.constructor?.name}: ${e?.message}\n${e?.stack ?? ""}`.slice(0, 1500)); }
    finally { W.GIT_HOOK.step = undefined; W.REVIEW_HOOK.step = undefined; W.REVIEW_PAGE_HOOK.read = undefined; }
    out.push([true, `(${name}: ${Math.round(performance.now() - t0)} ms)`]);
  }
  return out;
}

const CASES = {
  // ---- the acceptance path, step by step (its steps 1-5): a branch, a notebook edited and run, a .tex edited and not
  // run, a commit for review, the review, decisions, git_wait, a resubmission, accepted, main has both, nothing ran
  async path(check) {
    const workers = { n: 0 }, RealWorker = window.Worker;
    window.Worker = class extends RealWorker { constructor(...a) { workers.n++; super(...a); } };
    try {
      const w = await fresh("s1");
      await w.createByPerson("/paper.ipynb", { content: nb([{ id: "c1", code: "factor(2^32+1)" }]) });
      await w.putFile("/paper.tex", enc("\\documentclass{article}\n\\begin{document}\nHello.\n\\end{document}\n"));
      await make(w, "s1");
      check(true, "step 1: a branch");
      await edit(w, B("s1/paper.ipynb"), (d) => ({ ...d, cells: [{ id: "c1", code: "factor(2^32+1)", outputs: [{ output_type: "stream", name: "stdout", text: "641 * 6700417\n" }] }, { id: "c2", code: "is_prime(641)" }] }));
      const noted = await noteRun(w, "s1", B("s1/paper.ipynb"));
      check(noted.r === "ok", `step 2: the notebook edited and run (its note, before any commit): ${JSON.stringify(noted)}`);
      await edit(w, B("s1/paper.tex"), () => enc("\\documentclass{article}\n\\begin{document}\nHello, world.\n\\end{document}\n"));
      check(true, "step 2: the .tex edited, not run");
      const c1 = await commit(w, "s1", "Factor the Fermat number");
      check(c1.review === true && !c1.unchanged, "step 3: committed for review");
      const mod = nbModule(), el = panel();
      const view = W.openReview(w.reviewHost(), { name: "s1" }, el, { notebook: mod.load });
      await settle(view);
      check(text(el).includes(T.status.review), `step 4: the review says "${T.status.review}"`);
      check(text(row(el, "/paper.ipynb")).includes("Ran in the branch at "), `step 4: the notebook: ${text(row(el, "/paper.ipynb"))}`);
      check(text(row(el, "/paper.tex")).includes(T.noRun), `step 4: the .tex: ${text(row(el, "/paper.tex"))}`);
      click(row(el, "/paper.ipynb").querySelector(".path"));
      await settle(view);
      const nbRow = row(el, "/paper.ipynb");
      check(nbRow.querySelector(".cell.add") && text(nbRow).includes("is_prime(641)") && text(nbRow).includes(T.unchangedCells(1)), `step 4: the notebook's cell diff: ${text(nbRow).slice(0, 300)}`);
      const det = nbRow.querySelector("details");
      det.open = true; det.dispatchEvent(new Event("toggle"));
      await settle(view);
      check(mod.made.length === 1 && view.counters().mounted === 1 && text(row(el, "/paper.ipynb")).includes("641 * 6700417"), `step 4: the notebook as submitted, its output shown: ${mod.made.length} ${view.counters().mounted}`);
      check(mod.made[0]?.opts.kernel === null && mod.made[0].opts.readOnly === true && mod.made[0].opts.reactive === false && mod.made[0].opts.remotePictures === "click", `the path: the component has no interpreter, read only, not reactive: ${JSON.stringify(mod.made[0]?.opts)}`);
      decide(el, "/paper.ipynb", 0);
      decide(el, "/paper.tex", 2, "Say hello to the reader, not the world.");
      await submit(el, view);
      check(text(el).includes(T.status["partly-accepted"]), `step 5: accept the notebook, ask for changes on the .tex: ${text(el).slice(0, 200)}`);
      const waited = await W.gitWait(gh(w), { name: "s1", seconds: 1 }, caller());
      check(waited.decided && waited.files["/paper.ipynb"]?.decision === "accepted" && waited.files["/paper.tex"]?.decision === "changes" && waited.files["/paper.tex"].reason === "Say hello to the reader, not the world.", `the path: git_wait has both decisions and the reason: ${JSON.stringify(waited.files)}`);
      await edit(w, B("s1/paper.tex"), () => enc("\\documentclass{article}\n\\begin{document}\nHello, reader.\n\\end{document}\n"));
      await commit(w, "s1", "Say hello to the reader");
      await settle(view);
      check(text(el).includes(T.status.review) && row(el, "/paper.tex") && !row(el, "/paper.tex").querySelector("input[type=radio]:checked"), "the path: resubmitted: the review redraws (onBranch), the old decisions gone");
      // (the notebook was accepted the first time: only the .tex is decided now)
      decide(el, "/paper.tex", 0);
      await submit(el, view);
      check(text(el).includes(T.status["partly-accepted"]) && !submitBtn(el), `the path: the .tex accepted, the review decided: ${text(el).slice(0, 120)}`);
      const mainNb = await w.read("/paper.ipynb"), mainTex = new TextDecoder().decode((await w.read("/paper.tex")).content);
      check(mainNb.content.cells.length === 2 && mainNb.content.cells[0].outputs?.[0]?.text === "641 * 6700417\n" && mainTex.includes("Hello, reader."), "the path: main has both, the notebook with its outputs");
      check(workers.n === 0, `the path: nothing ran: no worker was made while the review was open (${workers.n})`);
      view.close();
      check(view.counters().mounted === 0 && view.counters().subscribed === 0 && el.childNodes.length === 0, "the path: closed: nothing mounted, no subscription, the panel empty");
      el.remove();
    } finally { window.Worker = RealWorker; }
  },

  // ---- the run line's three states, from notes and commits
  async runline(check) {
    const w = await fresh("rl");
    await w.createByPerson("/a.ipynb", { content: nb([{ id: "c1", code: "1+1" }]) });
    await make(w, "rl");
    await edit(w, B("rl/a.ipynb"), (d) => ({ ...d, cells: [{ id: "c1", code: "2+2" }] }));
    await noteRun(w, "rl", B("rl/a.ipynb"));
    await commit(w, "rl", "two");
    const el = panel(), view = W.openReview(w.reviewHost(), { name: "rl" }, el, { notebook: nbModule().load });
    await settle(view);
    check(text(row(el, "/a.ipynb")).includes("Ran in the branch at"), "run line: run, then committed as run: Ran");
    await edit(w, B("rl/a.ipynb"), (d) => ({ ...d, cells: [{ id: "c1", code: "3+3" }] }));
    await commit(w, "rl", "three");
    await settle(view);
    check(text(row(el, "/a.ipynb")).includes("Changed since its run at"), `run line: the code changed after its run: ${text(row(el, "/a.ipynb"))}`);
    await noteRun(w, "rl", B("rl/a.ipynb"));
    await settle(view);
    check(text(row(el, "/a.ipynb")).includes("Ran in the branch at"), "run line: run again: Ran (the note's wake redraws it)");
    await edit(w, B("rl/a.ipynb"), (d) => ({ ...d, cells: [{ ...d.cells[0], outputs: [{ output_type: "stream", name: "stdout", text: "6\n" }] }] }));
    const c = await commit(w, "rl", "outputs only");
    await settle(view);
    check(c.unchanged === true && text(row(el, "/a.ipynb")).includes("Ran in the branch at"), "run line: an output-only change is still Ran");
    view.close(); el.remove();
  },

  // ---- the second click: main edited after the branch began
  async overwrite(check) {
    const w = await fresh("ow");
    await w.putFile("/x.txt", enc("one\n"));
    await w.putFile("/y.txt", enc("why\n"));
    await make(w, "ow");
    await edit(w, B("ow/x.txt"), () => enc("one, the branch's\n"));
    await edit(w, B("ow/y.txt"), () => enc("why, the branch's\n"));
    await commit(w, "ow", "both");
    const mainX = await w.read("/x.txt");
    await w.write("/x.txt", enc("one, the person's\n"), { base: mainX.rev });
    const el = panel(), view = W.openReview(w.reviewHost(), { name: "ow" }, el, { notebook: nbModule().load });
    await settle(view);
    decide(el, "/x.txt", 0); decide(el, "/y.txt", 1);
    await submit(el, view);
    const r = row(el, "/x.txt");
    const replace = r && [...r.querySelectorAll("button")].find((b) => b.textContent === T.replace);
    check(r && text(r).includes(R.mainChanged("/x.txt")) && replace, `the second click: the refusal's own words, and "${T.replace}": ${r && text(r)}`);
    check(new TextDecoder().decode((await w.read("/x.txt")).content) === "one, the person's\n", "the second click: nothing replaced before it");
    click(replace);
    await settle(view);
    check(new TextDecoder().decode((await w.read("/x.txt")).content) === "one, the branch's\n" && new TextDecoder().decode((await w.read("/y.txt")).content) === "why\n", "the second click: replaces that file only (the rejected one untouched)");
    view.close(); el.remove();
  },

  // ---- another tab commits while the review is open: a redraw; a Submit on what it showed says "moved"
  async moved(check) {
    const w = await fresh("mv");
    await w.putFile("/m.txt", enc("1\n"));
    await make(w, "mv");
    await edit(w, B("mv/m.txt"), () => enc("2\n"));
    await commit(w, "mv", "two");
    const el = panel(), view = W.openReview(w.reviewHost(), { name: "mv" }, el, { notebook: nbModule().load });
    await settle(view);
    // (the redraw held at its first read: the page still shows the old commit when the person submits)
    let release;
    W.REVIEW_PAGE_HOOK.read = (what) => (what === "review" ? new Promise((r) => (release = r)) : undefined);
    decide(el, "/m.txt", 0);
    await edit(w, B("mv/m.txt"), () => enc("3\n"));
    await commit(w, "mv", "three");
    for (let i = 0; i < 100 && !release; i++) await new Promise((r) => setTimeout(r, 0));
    W.REVIEW_PAGE_HOOK.read = undefined;
    click(submitBtn(el));
    for (let i = 0; i < 200 && !text(el).includes(R.moved); i++) await new Promise((r) => setTimeout(r, 5));
    check(text(el).includes(R.moved), `a Submit on the commit it showed, after another commit: "${R.moved}"`);
    release?.();
    await settle(view);
    check(new TextDecoder().decode((await w.read("/m.txt")).content) === "1\n" && !row(el, "/m.txt").querySelector("input[type=radio]:checked"), "moved: nothing accepted; redrawn on the new commit with no decision carried");
    view.close(); el.remove();
  },

  // ---- the refresh slot: a held read under a burst of wakes, its peaks; close during a held read; open and close
  async slot(check) {
    const w = await fresh("sl");
    await w.putFile("/s.txt", enc("a\n"));
    await make(w, "sl");
    await edit(w, B("sl/s.txt"), () => enc("b\n"));
    await commit(w, "sl", "b");
    const el = panel(), view = W.openReview(w.reviewHost(), { name: "sl" }, el, { notebook: nbModule().load });
    await settle(view);
    let release, held = 0;
    W.REVIEW_PAGE_HOOK.read = () => { held++; return held === 1 ? new Promise((r) => (release = r)) : undefined; };
    const fid = (await w.branchAtName("sl")).fid, ns = (await W.openBranchStore(w.dbName)).name;
    const before = view.counters().generations;
    for (let i = 0; i < 100; i++) { W.tellBranch({ ns, fid, seq: 1000 + i }); await new Promise((r) => setTimeout(r, 0)); }
    const c1 = view.counters();
    check(c1.active === 1 && c1.pending === 1 && c1.peakActive === 1 && c1.peakReads <= 1 && c1.reads === 1, `the slot under 100 wakes with a read held: one active, one pending, one read: ${JSON.stringify(c1)}`);
    W.REVIEW_PAGE_HOOK.read = undefined;
    release();
    await settle(view);
    const c2 = view.counters();
    check(c2.generations === before + 2 && c2.peakActive === 1 && c2.peakReads <= 1, `the 100 wakes coalesced: the held generation and exactly one more: ${JSON.stringify({ before, c2 })}`);
    // (close during a held read)
    W.REVIEW_PAGE_HOOK.read = () => new Promise((r) => (release = r));
    W.tellBranch({ ns, fid, seq: 2000 });
    for (let i = 0; i < 100 && view.counters().reads === 0; i++) await new Promise((r) => setTimeout(r, 0));
    view.close();
    W.REVIEW_PAGE_HOOK.read = undefined;
    release();
    await new Promise((r) => setTimeout(r, 20));
    const c3 = view.counters();
    check(c3.subscribed === 0 && c3.mounted === 0 && c3.active === 0 && el.childNodes.length === 0, `closed during a held read: nothing left, nothing drawn after: ${JSON.stringify(c3)}`);
    let leak = 0;
    for (let i = 0; i < 20; i++) { const v = W.openReview(w.reviewHost(), { name: "sl" }, el, { notebook: nbModule().load }); await settle(v); v.close(); const c = v.counters(); leak += c.subscribed + c.mounted + c.active; }
    check(leak === 0, "20 opens and closes leave no subscription, view or work");
    el.remove();
  },

  // ---- what the submitted notebook shows: only text and pictures with sizes; past a bound, nothing made
  async outputs(check) {
    const w = await fresh("op");
    await w.createByPerson("/o.ipynb", { content: nb([{ id: "c1", code: "1" }]) });
    await w.createByPerson("/big.ipynb", { content: nb([{ id: "c1", code: "1" }]) });
    await make(w, "op");
    await edit(w, B("op/o.ipynb"), (d) => ({ ...d, cells: [{ id: "c1", code: "2", outputs: [
      { output_type: "display_data", data: { "text/html": "<img src=x onerror=alert(1)>", "text/plain": "plain" }, metadata: {} },
      { output_type: "display_data", data: { "image/svg+xml": "<svg/>" }, metadata: {} },
      { output_type: "display_data", data: { "image/png": PNG(4, 4) }, metadata: {} },
      { output_type: "display_data", data: { "image/png": "not a picture" }, metadata: {} },
    ] }] }));
    await edit(w, B("op/big.ipynb"), (d) => ({ ...d, cells: Array.from({ length: 2001 }, (_, i) => ({ id: "c" + i, code: String(i) })) }));
    await commit(w, "op", "outputs");
    const mod = nbModule(), el = panel(), view = W.openReview(w.reviewHost(), { name: "op" }, el, { notebook: mod.load });
    await settle(view);
    const open = async (p) => { click(row(el, p).querySelector(".path")); await settle(view); const d = row(el, p).querySelector("details"); d.open = true; d.dispatchEvent(new Event("toggle")); await settle(view); };
    await open("/o.ipynb");
    const outs = mod.made[0]?.doc?.cells?.[0]?.outputs ?? [];
    check(outs.length === 4 && JSON.stringify(outs[0].data) === JSON.stringify({ "text/plain": "plain" }) && outs[1].data["text/plain"] === T.notShown && outs[2].data["image/png"] && outs[3].data["text/plain"] === T.notShown,
      `the component gets only text and a picture with a size; html and svg never: ${JSON.stringify(outs).slice(0, 300)}`);
    await open("/big.ipynb");
    check(mod.made.length === 1 && view.counters().mounted === 0 && text(row(el, "/big.ipynb")).includes(T.tooManyCellsHere(2001)), `2,001 cells: said, and no component made: ${mod.made.length}`);
    check(text(row(el, "/big.ipynb")).includes(T.tooManyCells), "2,001 cells: the diff says too many to compare");
    view.close(); el.remove();
  },

  // ---- bounds: a 3 MiB text file; a notebook of 200 cells folds
  async bounds(check) {
    const w = await fresh("bd");
    await w.putFile("/big.txt", enc("x\n"));
    await w.createByPerson("/many.ipynb", { content: nb(Array.from({ length: 200 }, (_, i) => ({ id: "c" + i, code: "cell " + i }))) });
    await make(w, "bd");
    await edit(w, B("bd/big.txt"), () => enc("y\n".repeat(3 * 2 ** 19)));
    await edit(w, B("bd/many.ipynb"), (d) => ({ ...d, cells: d.cells.map((c, i) => (i === 100 ? { ...c, code: "changed" } : c)) }));
    await commit(w, "bd", "bounds");
    const el = panel(), view = W.openReview(w.reviewHost(), { name: "bd" }, el, { notebook: nbModule().load });
    await settle(view);
    click(row(el, "/big.txt").querySelector(".path")); await settle(view);
    check(text(row(el, "/big.txt")).includes("Too large to compare line by line (2 B → 3.1 MB)."), `3 MiB: too large to compare: ${text(row(el, "/big.txt")).slice(0, 200)}`);
    click(row(el, "/many.ipynb").querySelector(".path")); await settle(view);
    const t = text(row(el, "/many.ipynb"));
    check(t.includes(T.unchangedCells(100)) && t.includes(T.unchangedCells(99)) && !row(el, "/big.txt").querySelector(".detail"), `200 cells, one changed: folds of 100 and 99, one file open at a time: ${t.slice(0, 200)}`);
    view.close(); el.remove();
  },

  // ---- the run notes' transaction (Workspace.noteBranchRun): beside a held commit and a held accept; before the first
  // commit; reversed; its wake; a revoke; a target gone; another owner; a released branch
  async notes(check) {
    const w = await fresh("nt");
    await w.putFile("/n.txt", enc("1\n"));
    await w.putFile("/k.txt", enc("k\n"));
    await make(w, "nt");
    const fid = (await w.branchAtName("nt")).fid, ns = (await W.openBranchStore(w.dbName)).name;
    const runs = async () => Object.fromEntries((await w.branchRuns(fid, "nt")).runs);
    check((await noteRun(w, "nt", B("nt/n.txt"), 100)).r === "ok" && (await runs())["/n.txt"]?.at === 100, "notes: a run before the first commit is noted");
    check((await noteRun(w, "nt", B("nt/n.txt"), 50)).r === "same" && (await runs())["/n.txt"].at === 100, "notes: an older run landing second leaves the later one");
    let wakes = 0;
    const off = W.onBranch(ns, fid, () => wakes++);
    // (beside a commit held between pending and its finish: the commit's seq and outcome unchanged, the note kept)
    await edit(w, B("nt/n.txt"), () => enc("2\n"));
    let goOn;
    W.GIT_HOOK.step = (s) => (s === "pending" ? new Promise((r) => (goOn = r)) : undefined);
    const p = commit(w, "nt", "two");
    for (let i = 0; i < 200 && !goOn; i++) await new Promise((r) => setTimeout(r, 0));
    const seqHeld = (await w.branchReview(fid, "nt")).review.seq;
    const during = await noteRun(w, "nt", B("nt/n.txt"), 200);
    check(during.r === "ok" && (await w.branchReview(fid, "nt")).review.seq === seqHeld, "notes: written while a commit is held: the review state's seq untouched");
    W.GIT_HOOK.step = undefined; goOn();
    const res = await p;
    check(!res.unchanged && (await w.branchReview(fid, "nt")).review.head === res.commit && (await runs())["/n.txt"].at === 200, "notes: the held commit finishes as it would have, the note kept");
    // (beside an accept held after its checks)
    const at = { fid, name: "nt", head: res.commit, seq: (await w.branchReview(fid, "nt")).review.reviewSeq };
    let goA;
    W.REVIEW_HOOK.step = (s) => (s === "checked" ? new Promise((r) => (goA = r)) : undefined);
    const acc = W.review(w.reviewHost(), at, { files: { "/n.txt": { decision: "accepted" } } });
    for (let i = 0; i < 200 && !goA; i++) await new Promise((r) => setTimeout(r, 0));
    const during2 = await noteRun(w, "nt", B("nt/n.txt"), 300);
    W.REVIEW_HOOK.step = undefined; goA();
    const accepted = await caught(acc);
    check(during2.r === "ok" && accepted === null && (await w.branchReview(fid, "nt")).review.status === "accepted", "notes: written while an accept is held: the accept finishes");
    const w0 = wakes;
    await noteRun(w, "nt", B("nt/n.txt"), 400);
    await noteRun(w, "nt", B("nt/n.txt"), 399);
    await new Promise((r) => setTimeout(r, 0));
    // (one wake per note written (the helper sends run-verbs.ts's), none for one not written)
    check(wakes === w0 + 1, `notes: one wake for the note written, none for the one not: ${wakes - w0}`);
    off();
    check((await noteRun(w, "nt", B("nt/k.txt"), 500, "g1", () => false)).r === "grant" && !("/k.txt" in (await runs())), "notes: a revoked gate writes nothing");
    check((await noteRun(w, "nt", B("nt/k.txt"), 500, "someone-else")).r === "grant" && !("/k.txt" in (await runs())), "notes: another owner's note writes nothing");
    const kr = await w.read(B("nt/k.txt")), kid = await W.blobOid(kr.content);
    await agent(w).remove(B("nt/k.txt"));
    check((await w.runHost("agent:test", () => "g1").noteBranchRun(fid, "nt", B("nt/k.txt"), { at: 600, oid: kid }, () => true)).r === "moved" && !("/k.txt" in (await runs())), "notes: a target removed before the note lands: nothing written");
    // (the branch released: its runs' key goes with its record)
    await w.remove(B("nt"));
    await w.reconcileBranches("test");
    const db = await new Promise((ok, no) => { const r = indexedDB.open(w.dbName); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
    const left = await new Promise((ok) => { const g = db.transaction("meta").objectStore("meta").get("agent-branch-runs:" + fid); g.onsuccess = () => ok(g.result); });
    db.close();
    check(left === undefined, "notes: a released branch's runs are deleted with it");
  },
};

export const steps = {};
