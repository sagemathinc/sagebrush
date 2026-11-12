// An agent's branch's history and its review by the person, in a real browser: git_commit, git_status and
// git_wait, the person's review (review-actions.ts), and the rows the reviews asked for (TESTS rows 1-8, ENGINE E1-E4,
// SEC 1-6).  Run by test-workspace-git.mjs, which drives the rows that need a second tab through `steps`.
import * as W from "./ws.js";

const enc = (s) => new TextEncoder().encode(s);
const dec = (b) => new TextDecoder().decode(b);
const G = W.GIT_TEXT, R = W.REVIEW_TEXT, RULE = W.RULE_TEXT;
let n = 0;
const fresh = (tag) => W.Workspace.open({ name: `git-${tag}-${Date.now()}-${++n}`, mainName: `git-${tag}-main-${Date.now()}-${n}` });
const gh = (w) => w.branchHost("agent:test");
const caller = (owner = "g1", o = {}) => ({ owner, actor: "agent:test", live: o.live ?? (() => true), ...(o.ended ? { ended: o.ended } : {}) });
const make = (w, name, owner = "g1") => W.gitBranch(gh(w), { name, owner, folders: ["/"], live: () => true, actor: "agent:test" });
const agent = (w, owner = "g1") => w.forAgent("agent:test", { owner: () => owner });
const caught = async (p) => { try { await p; return null; } catch (e) { return e; } };
const commit = (w, name, message, review, owner) => W.gitCommit(gh(w), { name, message, ...(review ? { review: true } : {}) }, caller(owner));
const status = (w, name, owner) => W.gitStatus(gh(w), { name }, caller(owner));
/** The person's host for review-actions.ts: their own workspace's (Workspace.reviewHost). */
const person = (w) => w.reviewHost();
const fidOf = async (w, name) => (await w.branchAtName(name))?.fid;
const stateOf = async (w, name) => (await w.branchReview(await fidOf(w, name), name))?.review ?? null;
const at = async (w, name) => { const s = await stateOf(w, name); return { fid: await fidOf(w, name), name, head: s.head, seq: s.reviewSeq }; };
/** An agent's edit of a branch file: `f` gets the current document and returns the new one. */
async function edit(w, path, f) {
  const r = await w.read(path);
  await agent(w).write(path, f(r.content), { base: r.rev });
}
const nb = (cells, mode) => ({ cells, ...(mode ? { mode } : {}) });

export async function run(only, skip = []) {
  const out = [];
  const check = (ok, what) => out.push([!!ok, what]);
  for (const [name, f] of Object.entries(CASES)) {
    if ((only && !only.includes(name)) || skip.includes(name)) continue;
    const t0 = performance.now();
    try { await f(check); } catch (e) { check(false, `${name} threw: ${e?.constructor?.name}: ${e?.message}\n${e?.stack ?? ""}`.slice(0, 1500)); }
    finally { W.GIT_HOOK.step = undefined; W.REVIEW_HOOK.step = undefined; W.GIT_BRANCH_HOOK.step = undefined; W.GIT_WAIT_CLOCK.after = REAL_AFTER; W.HISTORY_CAP.bytes = REAL_CAP; }
    out.push([true, `(${name}: ${Math.round(performance.now() - t0)} ms)`]);
  }
  return out;
}
const REAL_AFTER = W.GIT_WAIT_CLOCK.after;
const REAL_CAP = W.HISTORY_CAP.bytes;

/** Main: a notebook with an output, a text file, a board. */
async function smallMain(w) {
  await w.createByPerson("/paper.ipynb", { content: nb([{ code: "factor(2^32+1)", outputs: [{ type: "text", text: "641 * 6700417" }], n: 1 }]) });
  await w.putFile("/intro.txt", enc("A long introduction.\n"));
  await w.createByPerson("/plan.board.json");
}
const B = (x) => "/Branches/" + x;

/** A manual clock for git_wait (row 1): `fire()` ends the current wait's bound. */
function manualClock() {
  let fire = () => {};
  W.GIT_WAIT_CLOCK.after = () => new Promise((r) => (fire = r));
  return { fire: () => fire() };
}

const CASES = {
  async loop(check) {
    // (the acceptance loop, E3: submit A; changes asked on A; commit B; A's decisions neither reported nor accepted for
    //  B; decide B)
    const w = await fresh("loop");
    await smallMain(w);
    const made = await make(w, "fix-intro");
    check(made.branch === "agent/fix-intro", `git_branch: ${JSON.stringify(made)}`);
    await edit(w, B("fix-intro/intro.txt"), () => enc("Short.\n"));
    await edit(w, B("fix-intro/paper.ipynb"), (d) => ({ ...d, cells: [...d.cells, { code: "2+2", outputs: [{ type: "text", text: "4" }] }] }));
    const a = await commit(w, "fix-intro", "Clearer introduction\n\nand one more cell", true);
    check(!a.unchanged && a.review && a.changes.map((c) => c.path + ":" + c.kind).join(",") === "/intro.txt:changed,/paper.ipynb:changed" && a.next === G.next.review("fix-intro"), `commit A asks for review: ${JSON.stringify(a)}`);
    let s = await status(w, "fix-intro");
    check(s.status === "review" && s.title === "Clearer introduction" && s.head === a.commit && !s.files && !s.mainMoved, `status after A: ${JSON.stringify(s)}`);
    const atA = await at(w, "fix-intro");
    const r1 = await W.review(person(w), atA, { files: { "/paper.ipynb": { decision: "accepted" }, "/intro.txt": { decision: "changes", reason: "one paragraph" } }, note: "shorter" });
    check(r1.status === "partly-accepted", `A: one accepted, one with changes asked: ${r1.status}`);
    const mainNb = (await w.read("/paper.ipynb")).content;
    check(mainNb.cells.length === 2 && mainNb.cells[1].outputs?.[0]?.text === "4", "the accepted notebook is the branch's live one, outputs included");
    check(dec((await w.read("/intro.txt")).content) === "A long introduction.\n", "the file with changes asked is untouched in main");
    s = await status(w, "fix-intro");
    check(s.status === "partly-accepted" && s.note === "shorter" && s.files["/intro.txt"].decision === "changes" && s.files["/intro.txt"].reason === "one paragraph" && s.files["/paper.ipynb"].decision === "accepted" && typeof s.decidedAt === "string" && !("hash" in s.files["/intro.txt"]), `git_status reads each decision, reason and note back: ${JSON.stringify(s)}`);
    // (an unchanged commit: nothing written, no decision moved or cleared)
    const before = await stateOf(w, "fix-intro");
    const u = await commit(w, "fix-intro", "nothing new");
    check(u.unchanged && JSON.stringify(await stateOf(w, "fix-intro")) === JSON.stringify(before), "an unchanged commit changes nothing, decisions included");
    // (commit B: the old head's decisions cleared, a new review)
    await edit(w, B("fix-intro/intro.txt"), () => enc("One paragraph.\n"));
    const b = await commit(w, "fix-intro", "One paragraph", true);
    s = await status(w, "fix-intro");
    check(s.head === b.commit && s.status === "review" && !s.files && !s.note && !s.decidedAt, `B: A's decisions and note cleared: ${JSON.stringify(s)}`);
    check((await caught(W.review(person(w), atA, { files: { "/intro.txt": { decision: "accepted" } } })))?.message === R.moved, "A's review can't be applied to B");
    const r2 = await W.review(person(w), await at(w, "fix-intro"), { files: { "/intro.txt": { decision: "accepted" } } });
    check(r2.status === "partly-accepted" && dec((await w.read("/intro.txt")).content) === "One paragraph.\n", `B accepted: main has it (${r2.status}: one of the two files changed since the base decided)`);
  },

  async canon(check) {
    // (TESTS row 3, grader's canon rows: outputs only and a board's reordered keys are unchanged; a mode change isn't)
    const w = await fresh("canon");
    await smallMain(w);
    await make(w, "c");
    await edit(w, B("c/paper.ipynb"), (d) => ({ ...d, cells: d.cells.map((c) => ({ ...c, outputs: [{ type: "text", text: "changed output" }], n: 7 })) }));
    check((await commit(w, "c", "outputs only")).unchanged, "a notebook's outputs and counts only: unchanged");
    const bd = (await w.read(B("c/plan.board.json"))).content;
    const reordered = Object.fromEntries(Object.keys(bd).reverse().map((k) => [k, bd[k]]));
    await edit(w, B("c/plan.board.json"), () => reordered);
    check((await commit(w, "c", "board keys")).unchanged, "a board saved with its keys in another order: unchanged");
    await edit(w, B("c/plan.board.json"), (d) => d);
    check((await commit(w, "c", "board saved again")).unchanged, "a board saved again as it was (only its store's fields move): unchanged");
    await edit(w, B("c/paper.ipynb"), (d) => ({ ...d, mode: d.mode === "python" ? "sage" : "python" }));
    check(!(await commit(w, "c", "mode")).unchanged, "a notebook's mode alone: a commit");
  },

  async wait(check) {
    // (TESTS row 1, ENGINE E4: already decided returns at once; a decision wakes it, with one state read while it
    //  waits; the bound on the test clock gives {decided: false}; another workspace's same-name branch wakes nothing)
    const w = await fresh("wait"), w2 = await fresh("wait2");
    await smallMain(w); await smallMain(w2);
    await make(w, "x"); await make(w2, "x");
    await edit(w, B("x/intro.txt"), () => enc("1\n")); await edit(w2, B("x/intro.txt"), () => enc("2\n"));
    await commit(w, "x", "one", true); await commit(w2, "x", "two", true);
    let reads = 0;
    const host = gh(w), counted = { ...host, branchReview: (f, x) => { reads++; return host.branchReview(f, x); } };
    const clock = manualClock();
    const waiting = W.gitWait(counted, { name: "x" }, caller());
    await new Promise((r) => setTimeout(r, 300));
    const readsWhileWaiting = reads;
    await W.review(person(w2), await at(w2, "x"), { files: { "/intro.txt": { decision: "rejected" } } });
    await new Promise((r) => setTimeout(r, 300));
    check(reads === readsWhileWaiting, `another workspace's branch of the same name decided: no wake-up here (${reads} reads, ${readsWhileWaiting} before)`);
    await W.review(person(w), await at(w, "x"), { files: { "/intro.txt": { decision: "accepted" } } });
    const got = await waiting;
    check(got.decided === true && got.status === "accepted" && readsWhileWaiting === 1, `woken by the decision, with one read while waiting (${readsWhileWaiting}): ${got.status}`);
    const again = await W.gitWait(gh(w), { name: "x" }, caller());
    check(again.decided === true, "already decided: returns at once");
    // (the bound: on the test clock, {decided: false} and its next)
    await make(w, "x2");
    await edit(w, B("x2/intro.txt"), () => enc("3\n"));
    await commit(w, "x2", "three", true);
    const clock2 = manualClock();
    const w3 = W.gitWait(gh(w), { name: "x2", seconds: 50 }, caller());
    await new Promise((r) => setTimeout(r, 100));
    clock2.fire();
    const t = await w3;
    check(t.decided === false && t.status === "review" && t.next === G.next.waiting("x2"), `the bound: ${JSON.stringify(t)}`);
    check((await caught(W.gitWait(gh(w), { name: "x2", seconds: 51 }, caller())))?.message === G.seconds, "seconds over 50: refused");
    // (a revoke ends a wait at once)
    let end;
    const ended = new Promise((r) => (end = r));
    let live = true;
    manualClock();
    const w4 = W.gitWait(gh(w), { name: "x2" }, caller("g1", { ended, live: () => live }));
    await new Promise((r) => setTimeout(r, 100));
    live = false; end();
    check((await caught(w4))?.message === G.grantChanged, "a revoke ends a pending wait, with its text");
    void clock;
  },

  async forged(check) {
    // (SEC 5, TESTS row 6: a forged wake-up from another tab is read as a wake-up only: nothing decided)
    const w = await fresh("forged");
    await smallMain(w);
    await make(w, "f");
    await edit(w, B("f/intro.txt"), () => enc("f\n"));
    await commit(w, "f", "f", true);
    const fid = await fidOf(w, "f");
    const ns = (await W.openBranchStore(w.dbName)).name;
    const bc = new BroadcastChannel("sagebrush-branches:" + ns);
    bc.postMessage({ fid, seq: 999, status: "accepted", files: { "/intro.txt": { decision: "accepted" } } });
    bc.close();
    await new Promise((r) => setTimeout(r, 200));
    const s = await status(w, "f");
    check(s.status === "review" && !s.files && dec((await w.read("/intro.txt")).content) === "A long introduction.\n", "a forged 'decided' message changes nothing");
    // (no agent surface has the person's actions: the schema's verbs)
    const verbs = Object.keys(W.PAGE_VERBS).concat(Object.keys(W.VERBS ?? {}));
    check(!verbs.some((v) => /review|decide|accept/i.test(v)), `no verb decides or accepts: ${verbs.join(" ")}`);
  },

  async ownership(check) {
    // (TESTS row 5, #957's rule kept: another grant, a renamed root, a new folder given the old name; each verb)
    const w = await fresh("own");
    await smallMain(w);
    await make(w, "o");
    await edit(w, B("o/intro.txt"), () => enc("o\n"));
    const verbs = [["git_commit", (owner) => commit(w, "o", "m", false, owner)], ["git_status", (owner) => status(w, "o", owner)], ["git_wait", (owner) => (manualClock(), W.gitWait(gh(w), { name: "o" }, caller(owner)))]];
    check(verbs.length === W.GIT_METHODS.length, "every git verb in the schema is covered here");
    for (const [v, f] of verbs) check((await caught(f("g2")))?.message === RULE.otherConnection, `${v} on another grant's branch: refused`);
    await w.rename(B("o"), "/Branches/o2");
    for (const [v, f] of verbs) check((await caught(f("g1")))?.message === G.noBranch("o"), `${v} after the root is renamed (same fid, new name): refused`);
    await w.mkdir(B("o"));
    for (const [v, f] of verbs) check((await caught(f("g1")))?.message === G.noBranch("o"), `${v} on a new folder given the old name (new fid): refused`);
    await w.remove(B("o"));
    await w.rename("/Branches/o2", B("o"));
    check(!!(await status(w, "o")), "renamed back (no reconcile between): the branch again (#957's rule)");
    check((await caught(commit(w, "o", "x".repeat(10001))))?.message === G.message, "a message over 10,000 characters: refused");
  },

  async races(check) {
    // (TESTS row 2, ENGINE E2: two commits at once on one branch; a change at the snapshot's boundary: once more, then
    //  refused, nothing written)
    const w = await fresh("race");
    await smallMain(w);
    await make(w, "r");
    await edit(w, B("r/intro.txt"), () => enc("one\n"));
    const [x, y] = await Promise.all([commit(w, "r", "first"), (async () => { await edit(w, B("r/intro.txt"), () => enc("two\n")); return commit(w, "r", "second"); })()]);
    const log = await (await W.openBranchStore(w.dbName)).log(await W.refOf(await fidOf(w, "r")));
    const heads = [x, y].filter((c) => !c.unchanged).map((c) => c.commit);
    check(log.length >= 2 && heads.every((h) => log.some((l) => l.oid === h)) && log[0].commit.parent.length === 1, `two commits at once: one parent chain (${log.length} commits)`);
    let k = 0;
    W.GIT_HOOK.step = async (s) => { if (s === "taken" && k++ < 1) await edit(w, B("r/intro.txt"), () => enc("during " + k + "\n")); };
    const ok = await commit(w, "r", "retried");
    check(!ok.unchanged && dec((await w.read(B("r/intro.txt"))).content) === "during 1\n", "a change at the snapshot: taken once more, committed");
    W.GIT_HOOK.step = async (s) => { if (s === "taken") await edit(w, B("r/intro.txt"), () => enc("again " + ++k + "\n")); };
    const head = (await stateOf(w, "r")).head;
    check((await caught(commit(w, "r", "refused")))?.message === G.changed && (await stateOf(w, "r")).head === head, "a change at both snapshots: refused, nothing written");
  },

  async crash(check) {
    // (TESTS row 7, ENGINE E2: a page closing between the pending state and the ref, and between the ref and the final
    //  state: the next verb reconciles; never a state naming a missing head, never old decisions on a new head)
    const w = await fresh("crash");
    await smallMain(w);
    await make(w, "k");
    await edit(w, B("k/intro.txt"), () => enc("k1\n"));
    await commit(w, "k", "k1", true);
    await W.review(person(w), await at(w, "k"), { files: { "/intro.txt": { decision: "rejected", reason: "no" } } });
    const s0 = await stateOf(w, "k");
    await edit(w, B("k/intro.txt"), () => enc("k2\n"));
    W.GIT_HOOK.step = (s) => { if (s === "pending") throw new Error("closed"); };
    await caught(commit(w, "k", "k2"));
    W.GIT_HOOK.step = undefined;
    const s1 = await status(w, "k");
    check(s1.head === s0.head && s1.files?.["/intro.txt"]?.decision === "rejected", "closed before the ref moved: the pending commit dropped, the old head and its decisions kept");
    W.GIT_HOOK.step = (s) => { if (s === "ref") throw new Error("closed"); };
    await caught(commit(w, "k", "k2 again"));
    W.GIT_HOOK.step = undefined;
    const s2 = await status(w, "k"), ref = await (await W.openBranchStore(w.dbName)).head(await W.refOf(await fidOf(w, "k")));
    check(s2.head === ref && s2.head !== s0.head && !s2.files, "closed after the ref moved: finalized on the next verb, the new head without the old decisions");
  },

  async accept(check) {
    // (SEC 3-4: main changed since the base is refused, and replaced only when named; a branch file changed after its
    //  commit is refused; an accept left under way is finished by the next read)
    const w = await fresh("acc");
    await smallMain(w);
    await make(w, "a");
    await edit(w, B("a/intro.txt"), () => enc("branch\n"));
    await commit(w, "a", "a", true);
    await w.putFile("/intro.txt", enc("the person's edit\n"));
    const where = await at(w, "a");
    check((await caught(W.review(person(w), where, { files: { "/intro.txt": { decision: "accepted" } } })))?.message === R.mainChanged("/intro.txt"), "main changed since the branch began: refused");
    check(dec((await w.read("/intro.txt")).content) === "the person's edit\n" && (await stateOf(w, "a")).status === "review", "nothing changed by the refusal");
    await W.review(person(w), where, { files: { "/intro.txt": { decision: "accepted" } }, overwrite: ["/intro.txt"] });
    check(dec((await w.read("/intro.txt")).content) === "branch\n", "named in overwrite (the second click): replaced");
    // (a branch file changed after its commit: what's accepted is what was committed, never the later edit)
    await make(w, "a1");
    await edit(w, B("a1/intro.txt"), () => enc("v2\n"));
    await commit(w, "a1", "v2", true);
    const w2 = await at(w, "a1");
    await edit(w, B("a1/intro.txt"), () => enc("v3, not committed\n"));
    await W.review(person(w), w2, { files: { "/intro.txt": { decision: "accepted" } }, overwrite: ["/intro.txt"] });
    check(dec((await w.read("/intro.txt")).content) === "v2\n", "a branch file changed after its commit: the committed version is accepted, not the later edit");
    // (an accept left under way: its intent, then the next read finishes it)
    await make(w, "a4");
    await edit(w, B("a4/intro.txt"), () => enc("v4\n"));
    await commit(w, "a4", "v4", true);
    const w4 = await at(w, "a4");
    const p = person(w), broken = { ...p, write: () => Promise.reject(new Error("closed")) };
    // (main has the first accept's text, not the base's: named in overwrite, as the second click would)
    await caught(W.review(broken, w4, { files: { "/intro.txt": { decision: "accepted" } }, overwrite: ["/intro.txt"] }));
    check(!!(await stateOf(w, "a4")).accepting && (await stateOf(w, "a4")).status === "review", "the page closed mid-accept: its intent kept, not yet accepted");
    const done = await W.resumeAccepting(p, { fid: await fidOf(w, "a4"), name: "a4" });
    check(done.status === "accepted" && !done.accepting && dec((await w.read("/intro.txt")).content) === "v4\n", `the next read finishes it, every changed file accepted: ${done.status}`);
    // (a main edit after a page closed mid-accept: the resume refuses, never overwrites it)
    await make(w, "a2");
    await edit(w, B("a2/intro.txt"), () => enc("a2\n"));
    await commit(w, "a2", "a2", true);
    await caught(W.review(broken, await at(w, "a2"), { files: { "/intro.txt": { decision: "accepted" } } }));
    await w.putFile("/intro.txt", enc("the person typed this after the crash\n"));
    const e = await caught(W.resumeAccepting(p, { fid: await fidOf(w, "a2"), name: "a2" }));
    check(e?.message === R.mainChanged("/intro.txt") && dec((await w.read("/intro.txt")).content) === "the person typed this after the crash\n" && !(await stateOf(w, "a2")).accepting, "main edited after the crash: the resume refuses, main kept, the accept dropped");
  },

  async disagreement(check) {
    // (TESTS row 4: a copy that differs from its base hash fails the branch, with its text)
    const w = await fresh("dis");
    await smallMain(w);
    W.GIT_BRANCH_HOOK.step = async (s) => { if (s === "copied-all") await w.putFile(B("d/intro.txt"), enc("not main\n")); };
    const e = await caught(make(w, "d"));
    check(/doesn't match main as it was copied/.test(e?.message ?? ""), `git_branch fails when its copy differs from its hashes: ${e?.message}`);
    let rec = null;
    for (const [, r] of await w.branchRecords()) if (r.name === "d") rec = r;
    check(rec?.status === "failed", "its record: failed");
  },

  async cap(check) {
    // (PERF: the workspace's history bound decided in the transaction that writes: two branches near the cap,
    //  committing at once, can't both pass it)
    const w = await fresh("cap");
    await smallMain(w);
    await make(w, "p"); await make(w, "q");
    const store = await W.openBranchStore(w.dbName);
    W.HISTORY_CAP.bytes = (await store.usage()) + 150;
    await edit(w, B("p/intro.txt"), () => enc("p".repeat(100)));
    await edit(w, B("q/intro.txt"), () => enc("q".repeat(100)));
    // (both past the advisory check before either writes: a barrier at the hook's "fits")
    let arrived = 0, release;
    const gate = new Promise((r) => (release = r));
    W.GIT_HOOK.step = async (s) => { if (s === "fits") { if (++arrived === 2) release(); await gate; } };
    const both = await Promise.all([caught(commit(w, "p", "p")), caught(commit(w, "q", "q"))]);
    check(arrived === 2, "both commits passed the advisory check before either wrote");
    const refused = both.filter((e) => e?.message === G.history).length, ok = both.filter((e) => e === null).length;
    check(ok === 1 && refused === 1, `near the cap, two branches at once: one commits, one is refused with its text (${ok} ok, ${refused} refused)`);
    check((await store.usage()) <= W.HISTORY_CAP.bytes, `the bound holds: ${await store.usage()} of ${W.HISTORY_CAP.bytes}`);
  },

  async specials(check) {
    // (a path named like an object's own properties is only a name: round-trip, nothing else touched)
    const w = await fresh("special");
    await smallMain(w);
    await make(w, "s");
    await w.mkdir(B("s/__proto__"));
    await w.putFile(B("s/__proto__/probe.txt"), enc("p"));
    await w.putFile(B("s/constructor"), enc("c"));
    const c = await commit(w, "s", "special names");
    const files = await (await W.openBranchStore(w.dbName)).filesAt(c.commit);
    check(dec(files.get("__proto__/probe.txt") ?? new Uint8Array()) === "p" && dec(files.get("constructor") ?? new Uint8Array()) === "c", "__proto__/… and constructor are committed as files");
    check(({}).probe === undefined && Object.getPrototypeOf({}) === Object.prototype, "Object.prototype untouched");
    // (a file named exactly __proto__ at the branch's top: its whole document kept and accepted as any other's)
    await w.putFile(B("s/__proto__.txt"), enc("x"));
    await w.rename(B("s/__proto__.txt"), B("s/__proto__x"));
    await w.remove(B("s/__proto__"));
    await w.rename(B("s/__proto__x"), B("s/__proto__"));
    const c2 = await commit(w, "s", "a file named __proto__", true);
    const got = await (await W.openBranchStore(w.dbName)).fullAt(c2.commit, "__proto__");
    check(got?.kind === "file" && dec(got.bytes) === "x", `a file named __proto__: its whole document kept (${got ? dec(got.bytes) : got})`);
    await W.review(person(w), await at(w, "s"), { files: { "/__proto__": { decision: "accepted" } } });
    check(dec((await w.read("/__proto__")).content) === "x", "and accepted into main as it was committed");
  },

  async replaced(check) {
    // (a notebook in main replaced by another made at the same moment, at the same revision: only its ref differs. An
    //  accept checked against the first writes nothing over the second, and a resume refuses it)
    const T = Date.parse("2026-11-12T00:00:00Z");
    const w = await W.Workspace.open({ name: `git-replaced-${Date.now()}-${++n}`, mainName: `git-replaced-main-${Date.now()}-${n}`, now: () => T });
    await smallMain(w);
    const p = person(w);
    const replace = async () => {
      await w.remove("/paper.ipynb");
      await w.createByPerson("/paper.ipynb", { content: nb([{ code: "the replacement" }]) });
    };
    const before = await w.read("/paper.ipynb");
    await make(w, "r1");
    await edit(w, B("r1/paper.ipynb"), (d) => ({ ...d, cells: d.cells.map((x) => ({ ...x, code: "factor(2^64+1)" })) }));
    await commit(w, "r1", "r1", true);
    W.REVIEW_HOOK.step = async (s) => { if (s === "checked") { W.REVIEW_HOOK.step = undefined; await replace(); } };
    const e1 = await caught(W.review(p, await at(w, "r1"), { files: { "/paper.ipynb": { decision: "accepted" } } }));
    const after = await w.read("/paper.ipynb");
    check(after.entry.created === before.entry.created && after.rev === before.rev && after.entry.ref !== before.entry.ref, `the replacement differs only by its ref (created ${after.entry.created === before.entry.created}, rev ${before.rev}/${after.rev})`);
    check(e1?.message === R.mainChanged("/paper.ipynb") && after.content.cells[0].code === "the replacement", `replaced after the check: refused, the replacement kept (${e1?.message})`);
    await make(w, "r2");
    await edit(w, B("r2/paper.ipynb"), (d) => ({ ...d, cells: d.cells.map((x) => ({ ...x, code: "factor(2^128+1)" })) }));
    await commit(w, "r2", "r2", true);
    const brokenWrite = { ...p, write: () => Promise.reject(new Error("closed")) };
    await caught(W.review(brokenWrite, await at(w, "r2"), { files: { "/paper.ipynb": { decision: "accepted" } }, overwrite: ["/paper.ipynb"] }));
    const mid = await w.read("/paper.ipynb");
    await replace();
    const again = await w.read("/paper.ipynb");
    const e2 = await caught(W.resumeAccepting(p, { fid: await fidOf(w, "r2"), name: "r2" }));
    check(again.entry.created === mid.entry.created && again.rev === mid.rev && again.entry.ref !== mid.entry.ref, "again only the ref differs");
    check(e2?.message === R.mainChanged("/paper.ipynb") && (await w.read("/paper.ipynb")).content.cells[0].code === "the replacement", `replaced before a resume: refused, the replacement kept (${e2?.message})`);
  },

  async racing(check) {
    // (main edited after an accept checked it, before it writes: the person's edit kept, the accept refused; a
    //  removal, a write, and a resume's removal)
    const w = await fresh("racing");
    await smallMain(w);
    const p = person(w);
    const editMain = (text) => async (s) => { if (s === "checked") { W.REVIEW_HOOK.step = undefined; await w.putFile("/intro.txt", enc(text)); } };
    await make(w, "d1");
    await agent(w).remove(B("d1/intro.txt"));
    await commit(w, "d1", "remove intro", true);
    W.REVIEW_HOOK.step = editMain("typed while removing\n");
    const e1 = await caught(W.review(p, await at(w, "d1"), { files: { "/intro.txt": { decision: "accepted" } } }));
    check(e1?.message === R.mainChanged("/intro.txt") && dec((await w.read("/intro.txt")).content) === "typed while removing\n", `a removal: main edited after the check is kept (${e1?.message})`);
    await make(w, "d2");
    await edit(w, B("d2/intro.txt"), () => enc("branch\n"));
    await commit(w, "d2", "rewrite intro", true);
    W.REVIEW_HOOK.step = editMain("typed while writing\n");
    const e2 = await caught(W.review(p, await at(w, "d2"), { files: { "/intro.txt": { decision: "accepted" } }, overwrite: ["/intro.txt"] }));
    check(e2?.message === R.mainChanged("/intro.txt") && dec((await w.read("/intro.txt")).content) === "typed while writing\n", `a write: main edited after the check is kept (${e2?.message})`);
    await make(w, "d3");
    await agent(w).remove(B("d3/intro.txt"));
    await commit(w, "d3", "remove intro", true);
    const broken = { ...p, remove: () => Promise.reject(new Error("closed")) };
    await caught(W.review(broken, await at(w, "d3"), { files: { "/intro.txt": { decision: "accepted" } }, overwrite: ["/intro.txt"] }));
    W.REVIEW_HOOK.step = editMain("typed while resuming\n");
    const e3 = await caught(W.resumeAccepting(p, { fid: await fidOf(w, "d3"), name: "d3" }));
    check(e3?.message === R.mainChanged("/intro.txt") && dec((await w.read("/intro.txt")).content) === "typed while resuming\n", `a resume's removal: main edited after the check is kept (${e3?.message})`);
    // (a notebook's outputs alone edited in main after a page closed mid-accept: the same canonical form, but not the
    //  entry and revision checked: the resume refuses, the outputs kept)
    await make(w, "o");
    await edit(w, B("o/paper.ipynb"), (d) => ({ ...d, cells: d.cells.map((x) => ({ ...x, code: "factor(2^64+1)" })) }));
    await commit(w, "o", "a bigger number", true);
    const brokenWrite = { ...p, write: () => Promise.reject(new Error("closed")) };
    await caught(W.review(brokenWrite, await at(w, "o"), { files: { "/paper.ipynb": { decision: "accepted" } } }));
    const nbNow = await w.read("/paper.ipynb");
    await w.write("/paper.ipynb", { ...nbNow.content, cells: nbNow.content.cells.map((x) => ({ ...x, outputs: [{ type: "text", text: "the person's own output" }] })) }, { base: nbNow.rev });
    const e4 = await caught(W.resumeAccepting(p, { fid: await fidOf(w, "o"), name: "o" }));
    const kept = (await w.read("/paper.ipynb")).content.cells[0];
    check(e4?.message === R.mainChanged("/paper.ipynb") && kept.code === "factor(2^32+1)" && JSON.stringify(kept.outputs).includes("the person's own output"), `outputs alone edited after the crash: the resume refuses, the person's notebook kept (${e4?.message})`);
    // (a page closed right after a file was written, before that was recorded: it can't be told apart from the
    //  person's edit, so the resume refuses rather than guess, and main has what was written)
    await make(w, "q");
    await edit(w, B("q/intro.txt"), () => enc("written, then closed\n"));
    await commit(w, "q", "q", true);
    const closesAfter = { ...p, write: async (...args) => { await p.write(...args); throw new Error("closed"); } };
    await caught(W.review(closesAfter, await at(w, "q"), { files: { "/intro.txt": { decision: "accepted" } }, overwrite: ["/intro.txt"] }));
    const e5 = await caught(W.resumeAccepting(p, { fid: await fidOf(w, "q"), name: "q" }));
    check(e5?.message === R.mainChanged("/intro.txt") && dec((await w.read("/intro.txt")).content) === "written, then closed\n" && !(await stateOf(w, "q")).accepting, `closed between a write and its record: the resume refuses, nothing more written (${e5?.message})`);
  },

  async oldBranch(check) {
    // (a branch made before branches kept a history (its record without canon): each git verb refuses it at once)
    const w = await fresh("old");
    await smallMain(w);
    const host = gh(w);
    await W.gitBranch({ ...host, publishBranch: (f, n, pages, live) => host.publishBranch(f, n, pages, live) }, { name: "old", owner: "g1", folders: ["/"], live: () => true, actor: "agent:test" });
    await edit(w, B("old/intro.txt"), () => enc("old\n"));
    manualClock();
    const verbs = [["git_commit", () => commit(w, "old", "m")], ["git_status", () => status(w, "old")], ["git_wait", () => Promise.race([W.gitWait(gh(w), { name: "old" }, caller()), new Promise((r) => setTimeout(() => r("still waiting after 3 s"), 3000))])]];
    for (const [v, f] of verbs) check((await caught(f()))?.message === G.noHistory, `${v} on a branch without a history: refused at once`);
  },

  async celltype(check) {
    // (a cell's type alone, and its source alone, each a commit)
    const w = await fresh("cell");
    await smallMain(w);
    await make(w, "t");
    await edit(w, B("t/paper.ipynb"), (d) => ({ ...d, cells: d.cells.map((x) => ({ ...x, type: "markdown" })) }));
    check(!(await commit(w, "t", "type")).unchanged, "a cell's type alone: a commit");
    await edit(w, B("t/paper.ipynb"), (d) => ({ ...d, cells: d.cells.map((x) => ({ ...x, code: x.code + " " })) }));
    check(!(await commit(w, "t", "source")).unchanged, "a cell's source alone: a commit");
  },

  async revokes(check) {
    // (a revoke when the commit's lock is taken, and an unchanged review: true with the grant gone: nothing
    //  written either way)
    const w = await fresh("rev");
    await smallMain(w);
    await make(w, "v");
    await edit(w, B("v/intro.txt"), () => enc("v\n"));
    await commit(w, "v", "v");
    const before = JSON.stringify(await stateOf(w, "v"));
    let calls = 0;
    const once = { owner: "g1", actor: "agent:test", live: () => calls++ < 1 };
    await edit(w, B("v/intro.txt"), () => enc("v2\n"));
    check((await caught(W.gitCommit(gh(w), { name: "v", message: "late" }, once)))?.message === G.grantChanged && JSON.stringify(await stateOf(w, "v")) === before, "revoked as the lock is taken: refused, nothing written");
    await edit(w, B("v/intro.txt"), () => enc("v\n"));
    calls = 0;
    const gone = { owner: "g1", actor: "agent:test", live: () => calls++ < 2 };
    check((await caught(W.gitCommit(gh(w), { name: "v", message: "ask", review: true }, gone)))?.message === G.grantChanged && JSON.stringify(await stateOf(w, "v")) === before, "an unchanged review: true with the grant gone: refused, nothing written");
  },

  async states(check) {
    // (no commit while an accept is under way or after the branch was accepted whole; a change right
    //  before the ref moves publishes nothing)
    const w = await fresh("states");
    await smallMain(w);
    await make(w, "z");
    await edit(w, B("z/intro.txt"), () => enc("z\n"));
    await commit(w, "z", "z", true);
    const p = person(w), broken = { ...p, write: () => Promise.reject(new Error("closed")) };
    await caught(W.review(broken, await at(w, "z"), { files: { "/intro.txt": { decision: "accepted" } } }));
    await edit(w, B("z/intro.txt"), () => enc("z2\n"));
    check((await caught(commit(w, "z", "during")))?.message === G.accepting, "while an accept is under way: refused");
    await edit(w, B("z/intro.txt"), () => enc("z\n"));
    await W.resumeAccepting(p, { fid: await fidOf(w, "z"), name: "z" });
    check((await stateOf(w, "z")).status === "accepted", "the accept finished: accepted whole");
    await edit(w, B("z/intro.txt"), () => enc("z3\n"));
    check((await caught(commit(w, "z", "after")))?.message === G.acceptedWhole, "after the branch was accepted whole: refused");
    await make(w, "y");
    await edit(w, B("y/intro.txt"), () => enc("y\n"));
    const head = (await commit(w, "y", "y")).commit;
    await edit(w, B("y/intro.txt"), () => enc("y2\n"));
    W.GIT_HOOK.step = async (s) => { if (s === "pending") await edit(w, B("y/intro.txt"), () => enc("y3, written meanwhile\n")); };
    const e = await caught(commit(w, "y", "y2"));
    W.GIT_HOOK.step = undefined;
    const st = await stateOf(w, "y");
    check(e?.message === G.changed && st.head === head && !st.pending, "the branch changed right before the ref moved: refused, nothing published");
  },

  async served(check) {
    // (the pairing's path: the git verbs served as the run verbs are (gitServe, through a run side), as agent-pair.ts's
    //  runVerb hands them: answered, never thrown; the grant checked first; a revoke ends a git_wait at once)
    const w = await fresh("served");
    await smallMain(w);
    await make(w, "s1");
    await edit(w, B("s1/intro.txt"), () => enc("served\n"));
    const serve = W.gitServe({ branchHost: () => gh(w) });
    const call = (method, params, o = {}) => new Promise((resolve) => {
      const g = o.grant === undefined ? { id: "g1", agent: "test", client: "test", folders: ["/"], write: true, run: false, expires: null, created: 0, lastUsed: 0 } : o.grant;
      let live = true;
      const subs = new Set();
      const side = {
        grant: g, agent: "test", actor: "agent:test", now: () => Date.now(),
        current: (x) => live && x === g && g !== null,
        live: { state: () => "granted", grant: () => (live ? g : null), closeReason: () => "" },
        onChange: (cb) => { subs.add(cb); return () => subs.delete(cb); },
        reply: (r) => resolve({ ok: r }), fail: (c, m) => resolve({ code: c, message: m }),
      };
      if (o.revokeAfter) setTimeout(() => { live = false; for (const cb of subs) cb(); }, o.revokeAfter);
      void serve.serve(method, params, side);
    });
    const c = await call("workspace.git_commit", { name: "s1", message: "served", review: true });
    check(c.ok && !c.ok.unchanged && c.ok.review === true, `git_commit through the pairing's path: ${JSON.stringify(c)}`);
    const st = await call("workspace.git_status", { name: "s1" });
    check(st.ok?.status === "review", `git_status through it: ${JSON.stringify(st)}`);
    const bad = await call("workspace.git_status", { name: "Bad Name" });
    check(bad.code === "invalid" && bad.message === G.badName, `a bad name: refused before anything runs (${JSON.stringify(bad)})`);
    const none = await call("workspace.git_status", { name: "s1" }, { grant: null });
    check(none.code === "invalid" && /no grant/.test(none.message), `no grant: refused (${JSON.stringify(none)})`);
    const other = await call("workspace.git_push", { name: "s1" });
    check(other.code === "invalid" && /not a verb/.test(other.message), "a method it doesn't serve: refused");
    manualClock();
    const waited = await call("workspace.git_wait", { name: "s1" }, { revokeAfter: 200 });
    check(waited.code === "invalid" && /^the grant changed or expired while this ran/.test(waited.message ?? ""), `a revoke ends a git_wait at once, said as the pairing says it (${JSON.stringify(waited)})`);
  },

  async refs(check) {
    // (a ref moves only by compare-and-swap, checked on BranchStore.setRef itself, with no commit lock around it:
    //  every caller holds that lock today, so the race rows alone never reach this check)
    const st = await W.openBranchStore((await fresh("refs")).dbName), ref = "agent/" + "f".repeat(40);
    const A = "a".repeat(40), B = "b".repeat(40), X = "c".repeat(40);
    check(await st.setRef(ref, A, null), "no ref yet, expect null: set to A");
    check(!(await st.setRef(ref, B, X)) && (await st.head(ref)) === A, "a stale expect: refused, the ref still A");
    check(!(await st.setRef(ref, B, null)) && (await st.head(ref)) === A, "expect null on an existing ref: refused, the ref still A");
    check((await st.setRef(ref, B, A)) && (await st.head(ref)) === B, "the right expect: moved to B");
  },

  async stores(check) {
    // (SEC 5, TESTS row 5: one store per workspace, named by its database's hash)
    const w1 = await fresh("st1"), w2 = await fresh("st2");
    const a = await W.openBranchStore(w1.dbName), b = await W.openBranchStore(w2.dbName);
    check(a.name !== b.name && /^sagebrush-branches:[0-9a-f]{64}$/.test(a.name), `two workspaces, two stores: ${a.name} ${b.name}`);
    check((await W.openBranchStore("a/b")).name !== (await W.openBranchStore("a_b")).name, "names that sanitize alike stay apart (hashed, never sanitized)");
    // (git's own object ids: `printf 'hello\n' | git hash-object --stdin` is ce013625…)
    check((await W.objectId("blob", enc("hello\n"))) === "ce013625030ba8dba906f756967f9e9ca394464a", "a blob's id is git's");
    check((await W.objectId("tree", new Uint8Array())) === "4b825dc642cb6eb9a060e54bf8d69288fbee4904", "the empty tree's id is git's");
  },
};

/** Steps for the rows that need a second tab (test-workspace-git.mjs). */
let W1 = null, waitResult = null;
export const steps = {
  async open(tag) { W1 = await W.Workspace.open({ name: `git-tab-${tag}`, mainName: `git-tab-${tag}-main` }); return true; },
  async seed() { await smallMain(W1); await make(W1, "t"); await edit(W1, B("t/intro.txt"), () => enc("t\n")); await commit(W1, "t", "t", true); return true; },
  wait() { waitResult = null; W.gitWait(gh(W1), { name: "t" }, caller()).then((r) => (waitResult = r)); return true; },
  waited() { return waitResult; },
  async decide() { await W.review(person(W1), await at(W1, "t"), { files: { "/intro.txt": { decision: "accepted" } } }); return true; },
};
