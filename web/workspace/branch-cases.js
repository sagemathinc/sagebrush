// An agent's branch (chat plan PR 3, packet r4e), in a real browser: git_branch's copy, its records and their
// lifecycle, the ownership rule at use, the limits, and the hash pages as stored.  Run by test-workspace-branch.mjs,
// which also drives the rows that need a tab closed or a second tab (8, 8b, 10, 11) through `steps`.
import * as W from "./ws.js";

const enc = (s) => new TextEncoder().encode(s);
const dec = (b) => new TextDecoder().decode(b);
const T = W.BRANCH_TEXT;
let seq = 0;
const fresh = (tag) => W.Workspace.open({ name: `br-${tag}-${Date.now()}-${++seq}`, mainName: `br-${tag}-main-${Date.now()}-${seq}` });
const host = (w) => w.branchHost("agent:test");
const make = (w, name, owner = "g1", o = {}) => W.gitBranch(host(w), { name, owner, folders: o.folders ?? ["/"], live: o.live ?? (() => true) });
const agent = (w, owner) => w.forAgent("agent:test", { owner: () => owner });
const caught = async (p) => { try { await p; return null; } catch (e) { return e; } };
const recOf = async (w, name) => { for (const [fid, r] of await w.branchRecords()) if (r.name === name) return { fid, ...r }; return null; };
const reconcile = (w) => W.withBranchLock(() => w.reconcileBranches(T.closed));
/** The meta store's branch rows: records and hash pages, by key. */
async function metaRows(w) {
  const st = w.ws.transaction("meta").objectStore("meta");
  const r = (q) => new Promise((ok, no) => { q.onsuccess = () => ok(q.result); q.onerror = () => no(q.error); });
  const range = IDBKeyRange.bound("agent-branch", "agent-branch￿");
  const [keys, values] = await Promise.all([r(st.getAllKeys(range)), r(st.getAll(range))]);
  return keys.map((k, i) => [k, values[i]]);
}
const pagesOf = async (w, fid) => (await metaRows(w)).filter(([k]) => k.startsWith(`${W.BRANCH_HASH_KEY}${fid}:`));
const jsonBytes = (v) => enc(JSON.stringify(v)).length;
const pause = () => { let go; const p = new Promise((r) => (go = r)); return { p, go }; };

export async function run(only, skip = []) {
  const out = [];
  const check = (ok, what) => out.push([!!ok, what]);
  for (const [name, f] of Object.entries(CASES)) {
    if ((only && !only.includes(name)) || skip.includes(name)) continue;
    const t0 = performance.now();
    try { await f(check); } catch (e) { check(false, `${name} threw: ${e?.constructor?.name}: ${e?.message}\n${e?.stack ?? ""}`.slice(0, 1500)); }
    finally { W.GIT_BRANCH_HOOK.step = undefined; W.BRANCH_HOOK.inRoot = undefined; W.BRANCH_HOOK.inPublish = undefined; W.BRANCH_HOOK.atCheck = undefined; W.BRANCH_HOOK.afterRead = undefined; }
    out.push([true, `(${name}: ${Math.round(performance.now() - t0)} ms)`]);
  }
  return out;
}

/** A small main: a data file, a person's notebook and board, a nested folder, an empty folder, and what isn't main. */
async function smallMain(w) {
  await w.putFile("/A/x.txt", enc("hello"));
  await w.createByPerson("/A/nb.ipynb", { content: { cells: [{ code: "1+1", outputs: [{ type: "text", text: "2" }], n: 1 }, { type: "markdown", code: "# t" }] } });
  await w.createByPerson("/A/b.board.json");
  await w.putFile("/A/deep/y.txt", enc("deep"));
  await w.mkdir("/E");
  await w.putFile("/B/z.txt", enc("bee"));
  await w.putFile("/Proposals/p.txt", enc("not main"));
  await w.putFile("/gone.txt", enc("trash me"));
  await w.remove("/gone.txt");
}

const CASES = {
  async copy(check) {
    const w = await fresh("copy");
    await smallMain(w);
    const r = await make(w, "fix-plots");
    check(r.branch === "agent/fix-plots" && r.worktree === "/Branches/fix-plots/" && r.next === T.next("fix-plots"), `the result: ${JSON.stringify(r)}`);
    const got = (await w.list("/Branches/fix-plots", { recursive: true })).map((e) => e.path.slice("/Branches/fix-plots".length)).sort();
    check(JSON.stringify(got) === JSON.stringify(["/A", "/A/b.board.json", "/A/deep", "/A/deep/y.txt", "/A/nb.ipynb", "/A/x.txt", "/B", "/B/z.txt", "/E"]), `main copied, folders included, nothing of /Branches, /Trash or /Proposals: ${got.join(" ")}`);
    check(dec((await w.read("/Branches/fix-plots/A/x.txt")).content) === "hello" && dec((await w.read("/Branches/fix-plots/A/deep/y.txt")).content) === "deep", "data files: their bytes");
    const nb0 = await w.read("/A/nb.ipynb"), nb1 = await w.read("/Branches/fix-plots/A/nb.ipynb");
    check(JSON.stringify(nb1.content.cells) === JSON.stringify(nb0.content.cells) && nb1.content.cells[0].outputs?.length === 1, "a notebook: its cells, outputs included (a real, runnable notebook)");
    const b0 = await w.read("/A/b.board.json"), b1 = await w.read("/Branches/fix-plots/A/b.board.json");
    check(JSON.stringify(b1.content) === JSON.stringify(b0.content), "a board: its document");
    // (row 7: provenance, P3-1)
    check(nb0.entry.made === "person" && nb1.entry.made === "elsewhere" && nb1.entry.ref !== nb0.entry.ref, `a person's notebook's copy: made elsewhere, a fresh ref (${nb1.entry.made})`);
    check(b0.entry.made === "person" && b1.entry.made === "elsewhere" && b1.entry.ref !== b0.entry.ref, "a person's board's copy: made elsewhere, a fresh id");
    const f0 = await w.stat("/A/x.txt"), f1 = await w.stat("/Branches/fix-plots/A/x.txt");
    check(f1.fid !== f0.fid, "a data file's copy: a fid of its own");
    const rec = await recOf(w, "fix-plots");
    check(rec && rec.status === "ready" && rec.owner === "g1" && rec.entries === 9 && rec.canon === 2 && !("base" in rec) && !("manifest" in rec), `the record: ready, the owner, 9 entries, canon 2, no manifest in it (${JSON.stringify(rec)})`);
    // (exact logical bytes: a data file's size; a document's JSON as copied, outputs included)
    const nbDoc = (() => { const { id, rev, updated, ...d } = nb0.content; return d; })();
    const want = 5 + 4 + 3 + jsonBytes(nbDoc) + jsonBytes(b0.content);
    check(rec.bytes === want, `the charge is the manifest's logical bytes exactly (${rec.bytes} = ${want})`);
    const pages = await pagesOf(w, rec.fid);
    const hashes = pages.flatMap(([, p]) => p);
    const sha = async (b) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", b))].map((x) => x.toString(16).padStart(2, "0")).join("");
    // (canon 2, branch-canon.ts: a notebook's mode and each cell's type and code, as sorted-key JSON, written out
    //  literally here; a board's file text, the board's own canonical())
    const nbCanon = enc(JSON.stringify({ cells: nb0.content.cells.map((c) => ({ code: c.code, type: c.type ?? "code" })), mode: nb0.content.mode ?? null }));
    const want2 = { "A/x.txt": await sha(enc("hello")), "A/deep/y.txt": await sha(enc("deep")), "B/z.txt": await sha(enc("bee")), "A/nb.ipynb": await sha(nbCanon), "A/b.board.json": await sha(enc(W.boardCanonical(b0.content))) };
    check(pages.length === 1 && hashes.length === 5 && hashes.every(([p, h]) => want2[p] === h), `each base hash is its canon 2 form's sha256 (a notebook's mode and cells' kinds and sources, no outputs; a board's file text): ${JSON.stringify(hashes)}`);
    // (direct mode: a write to main under the grant, with a branch open)
    const a = agent(w, "g1");
    await a.write("/A/x.txt", enc("main"), { base: (await w.read("/A/x.txt")).rev });
    check(dec((await w.read("/A/x.txt")).content) === "main" && dec((await w.read("/Branches/fix-plots/A/x.txt")).content) === "hello", "direct mode: the agent's write to main is allowed; the branch keeps its copy");
    // (a taken name: by a record, and by anything at the path; nothing made)
    const before = (await w.list("/", { recursive: true })).length;
    check((await caught(make(w, "fix-plots")))?.message === T.taken("fix-plots"), "a branch's name again: taken");
    await w.mkdir("/Branches/mine");
    check((await caught(make(w, "mine")))?.message === T.taken("mine"), "a name with a folder of the person's there: taken");
    check((await w.list("/", { recursive: true })).length === before + 1 && (await w.branchRecords()).size === 1, "nothing made for either");
  },

  async narrowed(check) {
    // (row 2: covering /Branches but not /B: /B is never read or copied)
    const w = await fresh("narrow");
    await smallMain(w);
    await make(w, "n1", "g1", { folders: ["/A", "/Branches"] });
    const got = (await w.list("/Branches/n1", { recursive: true })).map((e) => e.path);
    check(got.length > 0 && got.every((p) => p.startsWith("/Branches/n1/A")), `only the granted folder's entries: ${got.join(" ")}`);
    const rec = await recOf(w, "n1");
    check(rec.entries === 6, `its charge counts what it copied (/A and its five): ${rec.entries} entries`);
  },

  async ownership(check) {
    // (rows 1 and 6: grant identity; other agents' branches; /Branches itself)
    const w = await fresh("own");
    await w.putFile("/A/x.txt", enc("a"));
    await make(w, "fix", "g1");
    const mine = agent(w, "g1"), other = agent(w, "g2"), legacy = w.forAgent("agent:test");
    const base = (await w.read("/Branches/fix/A/x.txt")).rev;
    await mine.write("/Branches/fix/A/x.txt", enc("mine"), { base });
    check(dec((await w.read("/Branches/fix/A/x.txt")).content) === "mine", "its maker writes in it");
    check((await mine.read("/Branches/fix/A/x.txt")) && (await other.read("/Branches/fix/A/x.txt")).entry.path === "/Branches/fix/A/x.txt", "another grant reads it (Q4)");
    const rev = (await w.read("/Branches/fix/A/x.txt")).rev;
    const refused = async (what, p, text) => { const e = await caught(p); check(e?.message === text, `${what}: ${e?.message}`); };
    await refused("another grant's write in it", other.write("/Branches/fix/A/x.txt", enc("no"), { base: rev }), T.otherConnection);
    await refused("another grant's create in it", other.create("/Branches/fix/n.txt"), T.otherConnection);
    await refused("another grant's mkdir in it", other.mkdir("/Branches/fix/d"), T.otherConnection);
    await refused("another grant's rename into it", (async () => { await w.putFile("/A/m.txt", enc("m")); return other.rename("/A/m.txt", "/Branches/fix/m.txt"); })(), T.otherConnection);
    await refused("another grant's rename out of it", other.rename("/Branches/fix/A/x.txt", "/A/out.txt"), T.otherConnection);
    await refused("another grant's duplicate into it", other.duplicate("/A/x.txt", "/Branches/fix/x2.txt"), T.otherConnection);
    await refused("another grant's duplicate without to, beside its source in it (the computed destination)", other.duplicate("/Branches/fix/A/x.txt"), T.otherConnection);
    await refused("another grant's remove in it", other.remove("/Branches/fix/A/x.txt"), T.otherConnection);
    await refused("a grant with no id (legacy): owns nothing", legacy.write("/Branches/fix/A/x.txt", enc("no"), { base: rev }), T.otherConnection);
    check(dec((await w.read("/Branches/fix/A/x.txt")).content) === "mine", "nothing of theirs changed it");
    const dup = await other.duplicate("/Branches/fix/A/x.txt", "/A/copy.txt");
    check(dup.path === "/A/copy.txt", "another grant copies out of it into its own folders (a read of the source)");
    // (restore into another's branch: what the maker removed there, put back by another grant)
    const gone = await mine.remove("/Branches/fix/A/x.txt");
    await refused("another grant's restore into it", other.restore(gone.path, gone), T.otherConnection);
    const back = await mine.restore(gone.path, gone);
    check(back.path === "/Branches/fix/A/x.txt", "its maker restores into it");
    // (the branch's folder, and /Branches)
    await refused("its maker removing its folder", mine.remove("/Branches/fix"), T.persons);
    await refused("its maker moving its folder", mine.rename("/Branches/fix", "/Branches/fix2"), T.persons);
    await refused("its maker moving its folder out", mine.rename("/Branches/fix", "/A/fix"), T.persons);
    await refused("mkdir /Branches/x", mine.mkdir("/Branches/x"), T.onlyGitBranch);
    await refused("a file made in /Branches", mine.create("/Branches/n.txt"), T.onlyGitBranch);
    await refused("a rename to /Branches/x", mine.rename("/A/m.txt", "/Branches/x"), T.onlyGitBranch);
    await refused("a write making /Branches/new/...", mine.create("/Branches/new/n.txt"), T.onlyGitBranch);
    await refused("removing /Branches", mine.remove("/Branches"), T.persons);
    await refused("moving /Branches", mine.rename("/Branches", "/Br"), T.persons);
    // (a folder the person made in /Branches: no record, never adopted)
    await w.putFile("/Branches/hand/x.txt", enc("h"));
    await refused("a write in a folder the person made in /Branches", mine.write("/Branches/hand/x.txt", enc("no"), { base: (await w.read("/Branches/hand/x.txt")).rev }), T.notYours);
    // (notebook.edit's check: the same rule, holding the lock)
    await refused("notebook.edit's check in another grant's branch", other.holdChange("/Branches/fix/A/x.txt"), T.otherConnection);
    const rel = await mine.holdChange("/Branches/fix/A/x.txt");
    check(typeof rel === "function", "notebook.edit's check in its own: allowed, holding the lock until released");
    rel();
    // (the person: none of this applies)
    await w.rename("/Branches/fix/A/x.txt", "/Branches/fix/A/p.txt");
    check(!!(await w.stat("/Branches/fix/A/p.txt")), "the person changes a branch as any folder");
  },

  async revoked(check) {
    // (row 3: the grant revoked after k of n: no further entry written, failed, charged, never ready)
    const w = await fresh("revoke");
    for (let i = 0; i < 6; i++) await w.putFile(`/A/f${i}.txt`, enc("x" + i));
    let on = true;
    W.GIT_BRANCH_HOOK.step = (s, i) => { if (s === "copied" && i === 2) on = false; };
    const e = await caught(make(w, "rv", "g1", { live: () => on }));
    check(e?.message === T.failed(T.grantChanged, "rv") && e?.code === "conflict", `refused as cleared: ${e?.message}`);
    const got = (await w.list("/Branches/rv", { recursive: true })).map((x) => x.path);
    check(got.length === 3, `the copy stopped where the grant changed: ${got.join(" ")}`);
    const rec = await recOf(w, "rv");
    check(rec?.status === "failed" && rec.reason === T.grantChanged && rec.entries === 7 && rec.bytes === 12, `failed, still charged in full: ${JSON.stringify(rec)}`);
    check((await pagesOf(w, rec.fid)).length === 0, "no hash pages");
    const a = agent(w, "g1");
    check((await caught(a.create("/Branches/rv/n.txt")))?.message === T.unfinished, "its maker can't write in it");
    check((await caught(a.remove("/Branches/rv")))?.message === T.unfinished, "nor remove it");
    check((await caught(make(w, "rv")))?.message === T.taken("rv"), "its name stays taken");
    // (revoked between capture and the root: refused, nothing made, nothing charged)
    let on2 = true;
    W.GIT_BRANCH_HOOK.step = (s) => { if (s === "captured") on2 = false; };
    const e2 = await caught(make(w, "early", "g1", { live: () => on2 }));
    W.GIT_BRANCH_HOOK.step = undefined;
    check(e2?.message === T.grantChanged && !(await w.stat("/Branches/early")) && (await recOf(w, "early")) === null, `revoked before the root: nothing made (${e2?.message})`);
  },

  async boundaries(check) {
    // (#957 r2, E1-E3 / P3-SEC-1..3: the grant is checked inside each mutation's own transaction, the last thing
    //  before its write; a revoke at exactly that point (atCheck) stops it there)
    const w = await fresh("bound");
    await w.putFile("/A/a.txt", enc("a"));
    await w.create("/A/n.ipynb", { content: { cells: [{ code: "1" }] } });
    await w.putFile("/A/z.txt", enc("z"));
    let on = true;
    const revokeAt = (where, nth = 1) => { let k = 0; W.BRANCH_HOOK.atCheck = (x) => { if (x === where && ++k === nth) on = false; }; };
    // (the root: refused, nothing made, nothing charged, the name free)
    on = true; revokeAt("root");
    let e = await caught(make(w, "r1", "g1", { live: () => on }));
    check(e?.message === T.grantChanged && !(await w.stat("/Branches/r1")) && (await recOf(w, "r1")) === null && (await metaRows(w)).length === 0, `revoked at the root's own check: nothing made (${e?.message})`);
    // (a copy: that entry not written, the branch failed and still charged; a notebook's record taken back too)
    const nbRefs = async () => (await w.list("/", { recursive: true })).filter((x) => x.kind === "notebook").map((x) => x.ref);
    const before = await nbRefs();
    on = true; revokeAt("copy", 3);
    e = await caught(make(w, "c1", "g1", { live: () => on }));
    const got = (await w.list("/Branches/c1", { recursive: true })).map((x) => x.path).sort();
    const rec = await recOf(w, "c1");
    check(e?.message === T.failed(T.grantChanged, "c1") && JSON.stringify(got) === JSON.stringify(["/Branches/c1/A", "/Branches/c1/A/a.txt"]) && rec?.status === "failed" && rec.entries === 4, `revoked at the third copy's own check (the notebook): it isn't written, the branch failed and charged (${got.join(" ")})`);
    check(JSON.stringify(await nbRefs()) === JSON.stringify(before), "and no notebook was left for it");
    // (a folder's copy: the same check in its own transaction)
    on = true; revokeAt("copy", 1);
    e = await caught(make(w, "c0", "g1", { live: () => on }));
    check(e?.message === T.failed(T.grantChanged, "c0") && (await w.list("/Branches/c0", { recursive: true })).length === 0, "revoked at the first copy's check (a folder): nothing of it written");
    // (publish: no ready, no pages; failed, still charged)
    on = true; revokeAt("publish");
    e = await caught(make(w, "p1", "g1", { live: () => on }));
    const p1 = await recOf(w, "p1");
    check(e?.message === T.failed(T.grantChanged, "p1") && p1?.status === "failed" && p1.reason === T.grantChanged && (await pagesOf(w, p1.fid)).length === 0, `revoked at publish's own check: never ready, no pages, failed and charged (${p1?.status})`);
    // (a revoke after each transaction's writes and waits, just before its last act: the root (nothing made), a file's copy
    //  (failed, that entry not kept): the check is after them, not before)
    on = true; revokeAt("root-late");
    e = await caught(make(w, "rl", "g1", { live: () => on }));
    check(e?.message === T.grantChanged && !(await w.stat("/Branches/rl")) && (await recOf(w, "rl")) === null, `revoked after the root's writes, before its transaction ends: nothing made (${e?.message})`);
    on = true; revokeAt("copy-late", 1);
    e = await caught(make(w, "cl", "g1", { live: () => on }));
    check(e?.message === T.failed(T.grantChanged, "cl") && !(await w.stat("/Branches/cl/A/a.txt")) && (await recOf(w, "cl"))?.status === "failed", `revoked after a copy's writes and log, before its transaction ends: that copy not kept (${e?.message})`);
    // (grader's TESTS957-5: a folder's copy, the revoke after its writes, before its final check: nothing of it kept)
    on = true; revokeAt("folder-late", 1);
    e = await caught(make(w, "fl", "g1", { live: () => on }));
    const fl = await recOf(w, "fl");
    check(e?.message === T.failed(T.grantChanged, "fl") && !(await w.stat("/Branches/fl/A")) && fl?.status === "failed" && fl.entries === 4, `revoked after a folder's copy wrote, before its final check: the folder not kept, failed and charged (${e?.message})`);
    // (grader's TESTS957-4: publish holds the workspace's lock: with another holder, it waits, the branch still making)
    on = true; W.BRANCH_HOOK.atCheck = undefined;
    let freePub;
    W.GIT_BRANCH_HOOK.step = (s) => { if (s === "copied-all") void w.locked(() => new Promise((r) => (freePub = r))); };
    const pub = make(w, "pl", "g1", { live: () => on });
    await new Promise((r) => setTimeout(r, 400));
    const during = await recOf(w, "pl");
    freePub();
    await pub;
    W.GIT_BRANCH_HOOK.step = undefined;
    check(during?.status === "making" && (await recOf(w, "pl"))?.status === "ready", `publish waits for the workspace's lock: making while another holds it, ready after (${during?.status})`);
    // (grader's TESTS957-3: a revoke while makeBranchRoot waits for the workspace's lock (held by another), and one
    //  between the last copy and publish)
    on = true; W.BRANCH_HOOK.atCheck = undefined;
    let releaseHeld;
    W.GIT_BRANCH_HOOK.step = (s) => { if (s === "captured") void w.locked(() => new Promise((r) => (releaseHeld = r))); };
    const waiting = caught(make(w, "lw", "g1", { live: () => on }));
    await new Promise((r) => setTimeout(r, 200));
    on = false; releaseHeld();
    e = await waiting;
    W.GIT_BRANCH_HOOK.step = undefined;
    check(e?.message === T.grantChanged && !(await w.stat("/Branches/lw")) && (await recOf(w, "lw")) === null, `revoked while the root waited for the lock: nothing made (${e?.message})`);
    on = true;
    W.GIT_BRANCH_HOOK.step = (s) => { if (s === "copied-all") on = false; };
    e = await caught(make(w, "ca", "g1", { live: () => on }));
    W.GIT_BRANCH_HOOK.step = undefined;
    const ca = await recOf(w, "ca");
    check(e?.message === T.failed(T.grantChanged, "ca") && ca?.status === "failed" && (await pagesOf(w, ca.fid)).length === 0, `revoked after the last copy, before publish: never ready, failed, charged, no pages (${ca?.status})`);
    // (grader's TESTS957-2: a same-size edit between a copy's read and its locked recheck: "changed", that copy not made)
    on = true;
    W.BRANCH_HOOK.afterRead = async (p) => { if (p === "/A/z.txt") { W.BRANCH_HOOK.afterRead = undefined; await w.write("/A/z.txt", enc("Z"), { base: (await w.read("/A/z.txt")).rev }); } };
    e = await caught(make(w, "rr", "g1", { live: () => on }));
    check(e?.message === T.failed(T.changed("/A/z.txt"), "rr") && !(await w.stat("/Branches/rr/A/z.txt")), `an edit between a copy's read and its recheck: changed, not copied (${e?.message})`);
    // (a notebook, whose revision is its record's: the locked recheck is what sees it)
    W.BRANCH_HOOK.afterRead = async (p) => { if (p === "/A/n.ipynb") { W.BRANCH_HOOK.afterRead = undefined; const r = await w.read("/A/n.ipynb"); await w.write("/A/n.ipynb", { cells: [{ code: "2" }] }, { base: r.rev }); } };
    e = await caught(make(w, "rn", "g1", { live: () => on }));
    check(e?.message === T.failed(T.changed("/A/n.ipynb"), "rn") && !(await w.stat("/Branches/rn/A/n.ipynb")), `a notebook edited between its read and its recheck: changed, not copied (${e?.message})`);
    // (notebook.edit's hold: the branch can't move while it is held; another grant's is refused; let go after its time)
    await make(w, "h", "g1");
    const mine = agent(w, "g1"), other = agent(w, "g2");
    check((await caught(other.holdChange("/Branches/h/A/n.ipynb")))?.message === T.otherConnection, "another grant's hold in the branch: refused");
    const release = await mine.holdChange("/Branches/h/A/n.ipynb");
    let moved = false;
    const moving = w.rename("/Branches/h", "/Moved").then(() => (moved = true));
    await new Promise((r) => setTimeout(r, 300));
    check(!moved, "while the hold is kept, the person's move of the branch waits");
    release();
    await moving;
    check(moved && (await caught(mine.holdChange("/Moved/A/n.ipynb"))) === null, "released: the move goes ahead (and the moved folder is no branch)");
    // (ENGINE/SEC on r2: a hold that waited longer than its time for the lock is still held once had: its time counts
    //  from then; the person's move waits for it)
    await make(w, "q5", "g1");
    let freeLock;
    const blocker = w.locked(() => new Promise((r) => (freeLock = r)));
    await new Promise((r) => setTimeout(r, 50));
    const queued = mine.holdChange("/Branches/q5/A/n.ipynb");
    await new Promise((r) => setTimeout(r, 5600));
    freeLock(); await blocker;
    const rel5 = await queued;
    let moved5 = false;
    const moving5 = w.rename("/Branches/q5", "/Moved5").then(() => (moved5 = true));
    await new Promise((r) => setTimeout(r, 300));
    const heldNow = (await navigator.locks.query()).held.some((l) => l.name === "sagebrush-workspace");
    check(heldNow && !moved5, `a hold queued past its time, once had: still held, the person's move waits (${heldNow}, ${moved5})`);
    rel5(); await moving5;
    // (grader's H7: a hold never released is let go by itself after its time (HOLD_MS, 5 s): the person's move goes ahead)
    await make(w, "nr", "g1");
    await mine.holdChange("/Branches/nr/A/n.ipynb");
    const t0 = performance.now();
    const movedNr = await Promise.race([w.rename("/Branches/nr", "/MovedNr").then(() => performance.now() - t0), new Promise((r) => setTimeout(() => r(-1), 9000))]);
    check(movedNr > 4000 && movedNr < 8000, `a hold never released is let go after its time: the move went ahead after ${Math.round(movedNr)} ms`);
  },

  async race(check) {
    // (row 4 and daybreak2's listing race: changes after capture)
    const w = await fresh("race");
    await w.putFile("/A/same.txt", enc("aaaa"));
    await w.putFile("/A/grow.txt", enc("g"));
    await w.putFile("/A/gone.txt", enc("bye"));
    const nb = await w.create("/A/n.ipynb", { content: { cells: [{ code: "1" }] } });
    const run = async (name, f) => { W.GIT_BRANCH_HOOK.step = async (s) => { if (s === "captured") await f(); }; const e = await caught(make(w, name)); W.GIT_BRANCH_HOOK.step = undefined; return e; };
    let e = await run("added", () => w.putFile("/A/new.txt", enc("late")));
    check(e === null && !(await w.stat("/Branches/added/A/new.txt")) && (await recOf(w, "added")).entries === 5, "an entry added after capture isn't copied");
    e = await run("samesize", () => w.write("/A/same.txt", enc("bbbb"), { base: 0 }).catch(async () => w.write("/A/same.txt", enc("bbbb"), { base: (await w.read("/A/same.txt")).rev })));
    check(e?.message === T.failed(T.changed("/A/same.txt"), "samesize") && !(await w.stat("/Branches/samesize/A/same.txt")), `a same-size edit after capture: failed by the captured revision, that file not copied (${e?.message})`);
    e = await run("samenb", async () => { const r = await w.read("/A/n.ipynb"); await w.write("/A/n.ipynb", { cells: [{ code: "2" }] }, { base: r.rev }); });
    check(e?.message === T.failed(T.changed("/A/n.ipynb"), "samenb"), `a notebook edited after capture (its record's rev): failed (${e?.message})`);
    e = await run("grown", async () => w.write("/A/grow.txt", enc("ggggggg"), { base: (await w.read("/A/grow.txt")).rev }));
    const g = await recOf(w, "grown");
    check(e?.message === T.failed(T.changed("/A/grow.txt"), "grown") && g.status === "failed", "an entry enlarged after capture: failed");
    check(!!(await w.stat("/Branches/grown")) && g.bytes > 0 && g.entries > 0, `its partial kept, charged as captured (${g.entries} entries, ${g.bytes} bytes)`);
    e = await run("removed", () => w.remove("/A/gone.txt"));
    check(e?.message === T.failed(T.changed("/A/gone.txt"), "removed"), "an entry removed after capture: failed");
  },

  async published(check) {
    // (row 12: the root moved, or replaced, before publish: nothing published; released as row 9)
    const w = await fresh("publish");
    await w.putFile("/A/x.txt", enc("x"));
    W.GIT_BRANCH_HOOK.step = async (s) => { if (s === "copied-all") await w.rename("/Branches/mv", "/Moved"); };
    let e = await caught(make(w, "mv"));
    check(e?.message === T.moved, `moved before ready: ${e?.message}`);
    check((await recOf(w, "mv"))?.status !== "ready", "never ready");
    await reconcile(w);
    check((await recOf(w, "mv")) === null && (await metaRows(w)).length === 0, "the reconcile releases it, with no rows left");
    W.GIT_BRANCH_HOOK.step = async (s) => { if (s === "copied-all") { await w.remove("/Branches/rp"); await w.mkdir("/Branches/rp"); } };
    e = await caught(make(w, "rp"));
    check(e?.message === T.moved && (await recOf(w, "rp"))?.status !== "ready", "replaced before ready: nothing published");
    await reconcile(w);
    check((await recOf(w, "rp")) === null, "and released");
    W.GIT_BRANCH_HOOK.step = undefined;
    // (the root moved while the copy is under way: the next entry isn't written, anywhere)
    await w.putFile("/A/y.txt", enc("y"));
    await w.putFile("/A/z.txt", enc("z"));
    W.GIT_BRANCH_HOOK.step = async (s, i) => { if (s === "copied" && i === 1) await w.rename("/Branches/mid", "/Mid"); };
    e = await caught(make(w, "mid"));
    W.GIT_BRANCH_HOOK.step = undefined;
    const midAfter = (await w.list("/Mid", { recursive: true })).map((x) => x.path);
    check(e?.message === T.moved && midAfter.length === 2 && !(await w.stat("/Branches/mid")), `moved mid-copy: stopped as cleared, nothing more written, into the moved folder or at its old path (${midAfter.join(" ")})`);
    await reconcile(w);
    check((await recOf(w, "mid")) === null, "and released");
    // (an interruption inside publish's transaction: making, no pages)
    W.BRANCH_HOOK.inPublish = () => { throw new Error("interrupted"); };
    e = await caught(make(w, "ip"));
    W.BRANCH_HOOK.inPublish = undefined;
    const ip = await recOf(w, "ip");
    check(e?.message === "interrupted" && ip?.status === "making" && (await pagesOf(w, ip.fid)).length === 0, `an interruption inside publish leaves making with no pages (${ip?.status})`);
    await reconcile(w);
    check((await recOf(w, "ip"))?.status === "failed" && (await recOf(w, "ip"))?.reason === T.closed, "the reconcile then fails it, still charged");
    // (an interruption inside makeBranchRoot's transaction: nothing at all)
    W.BRANCH_HOOK.inRoot = () => { throw new Error("closed"); };
    e = await caught(make(w, "ir"));
    W.BRANCH_HOOK.inRoot = undefined;
    check(e?.message === "closed" && !(await w.stat("/Branches/ir")) && (await recOf(w, "ir")) === null, "an interruption before the root's commit: no folder, no record");
    check((await caught(make(w, "ir"))) === null, "and the name is free");
  },

  async lifecycle(check) {
    // (row 9, 8b's release, the restore beside a newer branch, a queued write against a replaced branch)
    const w = await fresh("life");
    await w.putFile("/A/x.txt", enc("x"));
    await make(w, "fix", "g1");
    const a = agent(w, "g1"), b = agent(w, "g2");
    await w.rename("/Branches/fix", "/Kept");
    await reconcile(w);
    check((await recOf(w, "fix")) === null, "row 9: the person moves a branch out: released");
    await a.write("/Kept/A/x.txt", enc("y"), { base: (await w.read("/Kept/A/x.txt")).rev });
    check(dec((await w.read("/Kept/A/x.txt")).content) === "y", "the moved folder follows the grant like any folder");
    check((await caught(make(w, "fix", "g1"))) === null, "the name is free again");
    // (the person's Trash of a root releases its slot; restored, it lands beside the newer branch, unowned)
    const old = await w.remove("/Branches/fix");
    await reconcile(w);
    check((await w.branchRecords()).size === 0, "the person's Trash of a branch releases its slot");
    await make(w, "fix", "g2");
    const back = await w.restore(old.path, old);
    check(back.path === "/Branches/fix (2)", `restored beside the newer branch: ${back.path}`);
    check((await caught(a.create("/Branches/fix (2)/n.txt")))?.message === T.notYours, "unowned: its old maker can't write in it");
    check((await caught(b.create("/Branches/fix/n.txt"))) === null, "the newer branch is its own maker's");
    // (an agent's change queued behind the lock while the branch is replaced: checked against what is there then)
    let release;
    const held = w.locked(() => new Promise((r) => (release = r)));
    await new Promise((r) => setTimeout(r, 20));
    const removing = w.remove("/Branches/fix");
    const queued = caught(b.create("/Branches/fix/q.txt"));
    release();
    await held; await removing;
    check((await queued)?.message === T.onlyGitBranch, `a queued write whose branch went meanwhile: refused (${(await queued)?.message})`);
    await reconcile(w);
    await make(w, "fix", "g1");
    check((await caught(b.create("/Branches/fix/q2.txt")))?.message === T.otherConnection, "and once another grant's branch is there by that name: refused by its record, not its name");
  },

  async concurrent(check) {
    // (daybreak2: two git_branch at 15 branches: exactly one made; repeated failures fill the slots; 20 cycles)
    const w = await fresh("conc");
    await w.putFile("/A/x.txt", enc("x"));
    for (let i = 0; i < 15; i++) await make(w, `b${i}`);
    const [r1, r2] = await Promise.all([caught(make(w, "p")), caught(make(w, "q"))]);
    check([r1, r2].filter((e) => e === null).length === 1 && [r1, r2].some((e) => e?.message === T.branches), `two at 15: exactly one made (${r1?.message ?? "made"}, ${r2?.message ?? "made"})`);
    check((await w.branchRecords()).size === 16 && !(await w.stat("/Branches/q")) !== !(await w.stat("/Branches/p")), "16 records, one root for them");
    // (repeated failure: forced failures fill the slots; then refused; no bytes outside the records' charges)
    const w2 = await fresh("fails");
    await w2.putFile("/A/x.txt", enc("xyz"));
    await w2.putFile("/A/y.txt", enc("y"));
    let on;
    W.GIT_BRANCH_HOOK.step = (s, i) => { if (s === "copied" && i === 1) on = false; };
    for (let i = 0; i < 16; i++) { on = true; await caught(make(w2, `f${i}`, "g1", { live: () => on })); }
    W.GIT_BRANCH_HOOK.step = undefined;
    const recs = [...(await w2.branchRecords()).values()];
    check(recs.length === 16 && recs.every((r) => r.status === "failed"), "16 forced failures: 16 failed records");
    check((await caught(make(w2, "f16")))?.message === T.branches && !(await w2.stat("/Branches/f16")), "the 17th refused, nothing made");
    const inBranches = (await w2.list("/Branches", { recursive: true })).filter((e) => e.kind === "file").reduce((n, e) => n + e.size, 0);
    check(inBranches <= recs.reduce((n, r) => n + r.bytes, 0), `no bytes outside the charges (${inBranches} copied, ${recs.reduce((n, r) => n + r.bytes, 0)} charged)`);
    // (20 make-and-remove cycles: the branch rows exactly the live branches')
    const w3 = await fresh("cycles");
    await w3.putFile("/A/x.txt", enc("x"));
    await make(w3, "keep");
    for (let i = 0; i < 20; i++) { await make(w3, "c"); await w3.remove("/Branches/c"); await reconcile(w3); }
    const rows = await metaRows(w3);
    check(rows.filter(([k]) => k.startsWith(W.BRANCH_KEY)).length === 1 && rows.length === 2, `20 cycles: ${rows.length} rows (one record, its one page)`);
  },

  async limits(check) {
    // (row 5: entries at N-1, N, N+1; the paths' bytes; the pages as stored; the aggregate commits; removal leaves none)
    const L = W.BRANCH_LIMITS;
    const w = await fresh("entries");
    // (1,999 entries: two folders and 1,997 files whose paths' JSON, with the last file's, makes exactly 512 KiB)
    const prefix = "D/" + "L".repeat(130) + "/";
    await w.mkdir("/" + prefix.slice(0, -1));
    const files = 1997, base = jsonBytes("D") + jsonBytes(prefix.slice(0, -1)), want = L.pathBytes - base;
    const per = Math.floor(want / (files + 1)), rem = want - per * (files + 1);
    const name = (i, len) => prefix + String(i).padStart(4, "0") + "-" + "p".repeat(len - 2 - prefix.length - 9) + ".txt";
    for (let i = 0; i < files; i++) await w.putFile("/" + name(i, per + (i < rem ? 1 : 0)), enc("" + i));
    check((await caught(make(w, "n1"))) === null && (await recOf(w, "n1")).entries === 1999, "N-1 entries: made");
    await w.remove("/Branches/n1"); await reconcile(w);
    const last = name(9999, per);
    await w.putFile("/" + last, enc("last"));
    const all = (await w.list("/", { recursive: true })).filter((e) => !e.path.startsWith("/Branches") && !e.path.startsWith("/Trash"));
    const pathSum = all.reduce((n, e) => n + jsonBytes(e.path.slice(1)), 0);
    check(all.length === L.entries && pathSum === L.pathBytes, `N = 2,000 entries, their paths exactly 512 KiB as JSON (${all.length}, ${pathSum})`);
    const t0 = performance.now();
    check((await caught(make(w, "n"))) === null, `N entries at the paths' limit: made (${Math.round(performance.now() - t0)} ms)`);
    const rec = await recOf(w, "n"), pages = await pagesOf(w, rec.fid);
    const total = pages.reduce((n, [, p]) => n + jsonBytes(p), 0);
    check(pages.length >= 8 && pages.every(([, p]) => jsonBytes(p) <= L.pageBytes) && total < L.hashBytes, `${pages.length} pages, each <= 32 KiB, ${total} bytes in all (< 1 MiB), committed`);
    check(pages.flatMap(([, p]) => p).length === 1998, "every hashed entry (the 1,998 files) in a page, whole");
    await w.remove("/Branches/n"); await reconcile(w);
    check((await metaRows(w)).length === 0, `removing a branch of ${pages.length} pages leaves no rows`);
    // (one byte more of path: refused, nothing made)
    await w.rename("/" + last, "/" + last.replace(".txt", "x.txt"));
    check((await caught(make(w, "o")))?.message === T.hashBytes && !(await w.stat("/Branches/o")), "the paths one byte over: refused, nothing made");
    await w.rename("/" + last.replace(".txt", "x.txt"), "/" + last);
    await w.putFile("/D/one-more.txt", enc("1"));
    check((await caught(make(w, "o")))?.message === T.entries && !(await w.stat("/Branches/o")) && (await w.branchRecords()).size === 0, "N+1 entries: refused, nothing made");
  },

  async bytes(check) {
    // (row 5: 256 MiB of small files at N-1, N, N+1; one copy at N)
    const L = W.BRANCH_LIMITS, w = await fresh("bytes");
    const n = 256, size = L.bytes / n;
    const chunk = new Uint8Array(size);
    for (let i = 0; i < n - 1; i++) { chunk[0] = i; await w.putFile(`/A/f${i}.bin`, chunk); }
    await w.putFile(`/A/f${n - 1}.bin`, chunk.subarray(1));
    check((await recOf(w, "x")) === null && (await caught(make(w, "m1"))) === null, "N-1 bytes: made");
    await w.remove("/Branches/m1"); await reconcile(w);
    await w.write(`/A/f${n - 1}.bin`, chunk, { base: (await w.read(`/A/f${n - 1}.bin`)).rev });
    const t0 = performance.now();
    check((await caught(make(w, "m"))) === null && (await recOf(w, "m")).bytes === L.bytes, `N = 256 MiB: made, charged exactly (${Math.round(performance.now() - t0)} ms)`);
    await w.putFile("/A/plus.bin", new Uint8Array(1));
    check((await caught(make(w, "o")))?.message === T.bytes && !(await w.stat("/Branches/o")), "N+1 bytes: refused, nothing made");
  },
};

/** The steps the runner drives across tabs (rows 8, 8b, 10, 11): each returns plain data. */
export const steps = {
  async open(name) { window.__w = await W.Workspace.open({ name, mainName: name + "-main" }); return true; },
  async seed() { const w = window.__w; for (let i = 0; i < 4; i++) await w.putFile(`/A/f${i}.txt`, enc("x" + i)); return true; },
  /** git_branch, paused at `at` (a step name, and for "copied" its index), until resume(); never resolved if the tab closes. */
  startPaused(name, at, index) {
    const p = pause();
    window.__resume = p.go;
    window.__reached = false;
    W.GIT_BRANCH_HOOK.step = async (s, i) => { if (s === at && (index === undefined || i === index)) { window.__reached = true; await p.p; } };
    window.__run = make(window.__w, name).then(() => "made", (e) => "error: " + e.message);
    return true;
  },
  reached: () => window.__reached === true,
  resume() { window.__resume(); return true; },
  result: () => window.__run,
  /** The root's transaction held open forever (a tab closed before its commit). */
  hangInRoot(name) { W.BRANCH_HOOK.inRoot = () => { for (;;) {} }; void make(window.__w, name).catch(() => {}); return true; },
  async rec(name) { return recOf(window.__w, name); },
  async rows() { return (await metaRows(window.__w)).length; },
  async stat(p) { return (await window.__w.stat(p)) ?? null; },
  /** The reconcile, started: whether it has finished, after `ms`. */
  async reconcileWithin(ms) { const r = reconcile(window.__w).then(() => true); return Promise.race([r, new Promise((ok) => setTimeout(() => ok(false), ms))]).then((done) => { window.__rec = r; return done; }); },
  async reconcileDone() { await window.__rec; return true; },
  async reconcile() { await reconcile(window.__w); return true; },
  /** The product's own reconcile (watchBranches), as a page with an agent pairing starts it. */
  watch() { window.__stopWatch = W.watchBranches(window.__w); return true; },
  /** The page's agent pairing (mountAgentPairing with git_branch), the creation lock's requests and the reconciles counted from before it starts. */
  mount() {
    const w = window.__w, spied = (window.__spied = { locks: 0, reconciles: 0 });
    const request = navigator.locks.request.bind(navigator.locks);
    navigator.locks.request = (name, ...rest) => { if (name === W.BRANCH_LOCK) spied.locks++; return request(name, ...rest); };
    const rec = w.reconcileBranches;
    w.reconcileBranches = function (...a) { spied.reconciles++; return rec.apply(this, a); };
    W.mountAgentPairing(w, { branches: W });
    return true;
  },
  spied: () => window.__spied,
  async touch(p) { await window.__w.putFile(p, enc("t")); return true; },
  async rename(a, b) { await window.__w.rename(a, b); return true; },
  async agentWrite(owner, p) { return caught(agent(window.__w, owner).create(p)).then((e) => (e ? e.message : null)); },
  async branch(name) { return caught(make(window.__w, name)).then((e) => (e ? e.message : null)); },
  async personRemove(p) { await window.__w.remove(p); return true; },
};
