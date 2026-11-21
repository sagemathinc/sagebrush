// The cases of web/history/test-history-tokens.mjs, run in the page (real IndexedDB): history's change tokens (Stage A
// layer 1, design stage-a-l1 r2.1 + r2.2).  T is this build's web/history/tokens.ts; M[name] its mutants, each of
// which must FAIL the rows that guard against it.  W and S are this build's workspace and notebook stores.
import * as T from "./tokens.js";
import * as W from "./ws.js";
import * as S from "./stores.js";

const MUTANTS = ["unsafe", "wrap", "saturate", "rows", "size", "inert", "dedupIdentRev"];
const M = Object.fromEntries(await Promise.all(MUTANTS.map(async (m) => [m, await import(`./tokens-${m}.js`)])));
const results = [];
const check = (ok, what) => results.push([!!ok, what]);
const J = JSON.stringify;
const MAX = 2 ** 53 - 1, MiB16 = 16 * 2 ** 20;
let n = 0;

const openRaw = (name, stores) => new Promise((ok, no) => {
  const r = indexedDB.open(name, 1);
  r.onupgradeneeded = () => { for (const [s, o] of Object.entries(stores)) r.result.createObjectStore(s, o ?? undefined); };
  r.onsuccess = () => ok(r.result);
  r.onerror = () => no(r.error);
  r.onblocked = () => no(new Error("blocked"));
});
const done = (tx) => new Promise((ok) => { tx.oncomplete = () => ok({ ok: true }); tx.onabort = () => ok({ ok: false, error: String(tx.error?.name ?? tx.error ?? "aborted") }); });
const rawGet = (db, store, key) => new Promise((ok, no) => { const r = db.transaction(store).objectStore(store).get(key); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
const rawAll = (db, store) => new Promise((ok, no) => { const r = db.transaction(store).objectStore(store).getAll(); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
const rawPut = (db, store, value, key) => new Promise((ok, no) => { const tx = db.transaction(store, "readwrite"); tx.objectStore(store).put(value, key); tx.oncomplete = () => ok(); tx.onerror = () => no(tx.error); });
const metaOf = async (db) => Object.fromEntries(await Promise.all(["hseq", "hcount", "hbytes", "ovf", "hactive", "exhausted"].map(async (k) => [k, await rawGet(db, "hmeta", k)])));

// (a fresh source database: a stand-in source store "src" beside history's two)
const fresh = async (preset = {}) => {
  const db = await openRaw(`htok-${++n}`, { src: null, htokens: { keyPath: "seq" }, hmeta: null });
  for (const [k, v] of Object.entries(preset)) await rawPut(db, "hmeta", v, k);
  return db;
};
// (one "save": the source row and its token in ONE transaction, as every writer does)
const save = async (Tm, db, input, key = "k" + Math.random()) => {
  const tx = db.transaction(["src", "htokens", "hmeta"], "readwrite");
  tx.objectStore("src").put({ v: key }, key);
  const fin = done(tx);
  await Tm.noteToken(tx, input).catch(() => { try { tx.abort(); } catch {} });
  return { ...(await fin), key };
};
const tok = (i = "f1", over = {}) => ({ ident: i, rev: 1, kind: "file", chain: ["a"], ...over });

// ---- the byte metric (frozen): exact vectors, one of each chain grammar
{
  const vec = [
    [{ seq: 1, ident: "f1", rev: 2, kind: "file", chain: ["r", "s"] }, '{"chain":["r","s"],"ident":"f1","kind":"file","rev":2,"seq":1}'],
    [{ seq: 7, ident: "nb", rev: 3, kind: "notebook", chain: null }, '{"chain":null,"ident":"nb","kind":"notebook","rev":3,"seq":7}'],
    [{ seq: 9, ident: "b", rev: 1, kind: "board", chain: "broken" }, '{"chain":"broken","ident":"b","kind":"board","rev":1,"seq":9}'],
    [{ seq: 2, ident: "é✓", rev: 0, kind: "folder", chain: [] }, '{"chain":[],"ident":"é✓","kind":"folder","rev":0,"seq":2}'],
  ];
  for (const [row, text] of vec) check(T.tokenSize(row) === new TextEncoder().encode(text).length, `tokenSize: ${text} is ${new TextEncoder().encode(text).length} bytes (got ${T.tokenSize(row)})`);
  check(J(T.TOKEN_LIMITS) === J({ rows: 50000, bytes: MiB16, rowBytes: 4096, maxSeq: MAX }) && Object.isFrozen(T.TOKEN_LIMITS), "the production constants: 50,000 rows, 16 MiB, 4 KiB a token, seq at most 2^53 - 1 (frozen)");
}

// ---- each row is a function of a tokens module: true when the module behaves as designed
const ROWS = {
  // inert: no hactive, nothing written, no counter
  async inert(Tm) {
    const db = await fresh();
    const r = await save(Tm, db, tok());
    const ok = r.ok && (await rawAll(db, "htokens")).length === 0 && J(await metaOf(db)) === J({});
    db.close();
    return ok;
  },
  // active: contiguous seqs, counters equal to a recount
  async active(Tm) {
    const db = await fresh({ hactive: true });
    for (const i of ["a", "b", "c"]) await save(Tm, db, tok(i));
    const rows = await rawAll(db, "htokens"), m = await metaOf(db);
    const ok = J(rows.map((r) => r.seq)) === "[1,2,3]" && m.hseq === 3 && m.hcount === 3 && m.hbytes === rows.reduce((s, r) => s + r.sz, 0) && rows.every((r) => r.sz === T.tokenSize(r));
    db.close();
    return ok;
  },
  // the row bound: the 49,999th and 50,000th admitted, the 50,001st the witness only
  async rows(Tm) {
    const db = await fresh({ hactive: true, hseq: 49998, hcount: 49998, hbytes: 0 });
    await save(Tm, db, tok("a")); await save(Tm, db, tok("b"));
    const mid = await metaOf(db);
    await save(Tm, db, tok("c"));
    const m = await metaOf(db), rows = await rawAll(db, "htokens");
    const ok = mid.hcount === 50000 && rows.length === 2 && m.hcount === 50000 && m.hseq === 50001 && J(m.ovf) === J({ seq: 50001 });
    db.close();
    return ok;
  },
  // the byte bound: landing at 16 MiB - 1 and exactly 16 MiB admitted, one byte more the witness
  async bytes(Tm) {
    const sz = T.tokenSize({ seq: 1, ident: "a", rev: 1, kind: "file", chain: ["a"] });
    const out = [];
    for (const [land, admit] of [[MiB16 - 1, true], [MiB16, true], [MiB16 + 1, false]]) {
      const db = await fresh({ hactive: true, hseq: 0, hcount: 0, hbytes: land - sz });
      await save(Tm, db, tok("a"));
      const m = await metaOf(db), rows = await rawAll(db, "htokens");
      out.push(admit ? rows.length === 1 && m.hbytes === land && m.ovf === undefined : rows.length === 0 && m.hbytes === land - sz && J(m.ovf) === J({ seq: 1 }));
      db.close();
    }
    return out.every(Boolean);
  },
  // a token's own size: 4 KiB admitted, 4 KiB + 1 the witness
  async rowBytes(Tm) {
    const base = T.tokenSize({ seq: 1, ident: "", rev: 1, kind: "file", chain: null });
    const out = [];
    for (const [extra, admit] of [[0, true], [1, false]]) {
      const db = await fresh({ hactive: true });
      await save(Tm, db, { ident: "x".repeat(4096 - base + extra), rev: 1, kind: "file", chain: null });
      const rows = await rawAll(db, "htokens"), m = await metaOf(db);
      out.push(admit ? rows.length === 1 && rows[0].sz === 4096 : rows.length === 0 && J(m.ovf) === J({ seq: 1 }));
      db.close();
    }
    return out.every(Boolean);
  },
  // (A1-T12) the same (ident, rev) twice in one transaction: two tokens, two seqs (seq alone tells them apart)
  async sameRev(Tm) {
    const db = await fresh({ hactive: true });
    const tx = db.transaction(["src", "htokens", "hmeta"], "readwrite"), fin = done(tx);
    await Tm.noteToken(tx, tok("same", { rev: 7 }));
    await Tm.noteToken(tx, tok("same", { rev: 7 }));
    await fin;
    const rows = await rawAll(db, "htokens");
    const ok = rows.length === 2 && rows[0].seq === 1 && rows[1].seq === 2 && rows.every((r) => r.ident === "same" && r.rev === 7);
    db.close();
    return ok;
  },
  // exhaustion: the last valid seq a token; then the never-cleared terminal state, saves kept, no token, no repeat
  async exhaust(Tm) {
    const db = await fresh({ hactive: true, hseq: MAX - 1, hcount: 0, hbytes: 0 });
    const last = await save(Tm, db, tok("last"));
    const rows1 = await rawAll(db, "htokens");
    const first = await save(Tm, db, tok("first")), m1 = await metaOf(db);
    const second = await save(Tm, db, tok("second")), third = await save(Tm, db, tok("third")), m3 = await metaOf(db);
    const rows3 = await rawAll(db, "htokens"), src = await rawAll(db, "src");
    const ok = last.ok && rows1.length === 1 && rows1[0].seq === MAX
      && first.ok && m1.exhausted === true && m1.hseq === MAX && m1.ovf === undefined
      && second.ok && third.ok && J(m3) === J(m1) && rows3.length === 1 && src.length === 4;
    db.close();
    return ok;
  },
};

// (the L2 stub's compare-and-clear, as L2 is bound to do it: an ordinary witness at or below the cursor cleared,
// an exhausted state never; `clearExhausted` makes it the clear-on-ack mutant)
const stubClear = async (db, rcur, clearExhausted = false) => {
  const tx = db.transaction("hmeta", "readwrite"), st = tx.objectStore("hmeta"), fin = done(tx);
  const o = await new Promise((ok) => { const r = st.get("ovf"); r.onsuccess = () => ok(r.result); });
  if (o && o.seq <= rcur) st.delete("ovf");
  if (clearExhausted) st.delete("exhausted");
  return fin;
};

for (const [name, row] of Object.entries(ROWS)) check(await row(T), `row ${name}: as designed`);

// ---- exhaustion survives a compare-and-clear race and a restart; the clear-on-ack mutant (of the stub) fails it
{
  const db = await fresh({ hactive: true, hseq: MAX, hcount: 0, hbytes: 0, ovf: { seq: 5 } });
  const [a] = await Promise.all([save(T, db, tok("x")), stubClear(db, 10)]);
  const m = await metaOf(db);
  check(a.ok && m.exhausted === true && m.ovf === undefined && m.hseq === MAX, `exhaustion: a compare-and-clear of an OLDER witness racing an exhausted save clears the old witness only: ${J(m)}`);
  const name = db.name;
  db.close();
  const re = await openRaw(name, {});
  const b = await save(T, re, tok("y")), m2 = await metaOf(re);
  check(b.ok && m2.exhausted === true && (await rawAll(re, "htokens")).length === 0, "exhaustion: after a restart (closed, reopened) still exhausted, and saves still kept with no token");
  await stubClear(re, MAX, true);
  check((await metaOf(re)).exhausted === undefined, "control: the clear-on-ack stub DOES remove it (so the row above can see a clear)");
  re.close();
}

// ---- every mutant fails the row that guards against it
for (const [m, row] of [["unsafe", "exhaust"], ["wrap", "exhaust"], ["saturate", "exhaust"], ["rows", "rows"], ["size", "bytes"], ["inert", "inert"], ["dedupIdentRev", "sameRev"]]) {
  check(!(await ROWS[row](M[m])), `mutant ${m}: FAILS row ${row}`);
}

// ---- failures abort the save: nothing committed, counters unchanged, no token, no witness
{
  // (htokens: a duplicate seq, impossible by construction, injected by a row already at the next seq)
  const db = await fresh({ hactive: true, hseq: 4, hcount: 0, hbytes: 0 });
  await rawPut(db, "htokens", { seq: 5, ident: "planted", rev: 0, kind: "file", chain: null, sz: 0 });
  const r = await save(T, db, tok("dup"), "dupkey");
  const m = await metaOf(db);
  check(!r.ok && (await rawGet(db, "src", "dupkey")) === undefined && m.hseq === 4 && m.ovf === undefined, `failure on htokens (a duplicate seq): the save aborted (${r.error}), its source row not committed, hseq unchanged, no witness`);
  db.close();
}
for (const [what, method] of [["the hmeta put", "put"], ["the hmeta get", "get"]]) {
  const db = await fresh({ hactive: true, hseq: 4, hcount: 0, hbytes: 0 });
  const orig = IDBObjectStore.prototype[method];
  IDBObjectStore.prototype[method] = function (...a) {
    if (this.name === "hmeta" && (method === "put" ? true : a[0] === "hseq")) throw new DOMException("injected", "UnknownError");
    return orig.apply(this, a);
  };
  let r;
  try { r = await save(T, db, tok("inj"), "injkey"); } finally { IDBObjectStore.prototype[method] = orig; }
  const m = await metaOf(db);
  check(!r.ok && (await rawGet(db, "src", "injkey")) === undefined && m.hseq === 4 && (await rawAll(db, "htokens")).length === 0, `failure on ${what}: the save aborted, nothing committed, no token, hseq unchanged`);
  // (and a retry once the fault is gone succeeds with exactly one token)
  const again = await save(T, db, tok("inj"), "injkey");
  check(again.ok && (await rawAll(db, "htokens")).length === 1 && (await metaOf(db)).hseq === 5, `failure on ${what}: the retry, fault cleared, saves with exactly one token`);
  db.close();
}

// ---- chainOf: nested, Trash, gone, broken
{
  const tree = { "/A": { kind: "folder", fid: "fa" }, "/A/B": { kind: "folder", fid: "fb" }, "/X": { kind: "folder" } };
  const get = async (p) => tree[p];
  const parent = (p) => p.slice(0, Math.max(1, p.lastIndexOf("/")));
  check(J(await T.chainOf("/A/B/f.txt", false, get, parent)) === J(["fa", "fb"]), "chainOf: a nested file's ancestry by fid, root first");
  check(J(await T.chainOf("/f.txt", false, get, parent)) === "[]", "chainOf: at the root, an empty chain");
  check((await T.chainOf("/Trash/f.txt", true, get, parent)) === null && (await T.chainOf(null, false, get, parent)) === null, "chainOf: in Trash, and gone: null");
  check((await T.chainOf("/X/f.txt", false, get, parent)) === "broken" && (await T.chainOf("/Q/f.txt", false, get, parent)) === "broken", "chainOf: a folder without an identity, or missing: \"broken\", never null");
}

// ---- through the workspace: index ops, boards and notebooks, each with its token in the same transaction
{
  const name = `htokw-${++n}`, mainName = `htokm-${n}`;
  // (the test-only opener: a notebooks database made WITH history's stores, which layer 1's app opener never makes)
  const pre = await openRaw(mainName, { notebooks: { keyPath: "id" }, files: null, htokens: { keyPath: "seq" }, hmeta: null });
  await rawPut(pre, "hmeta", true, "hactive");
  pre.close();
  const w = await W.Workspace.open({ name, mainName });
  check(w.ws.version >= 10 && ["htokens", "hmeta"].every((s) => w.ws.objectStoreNames.contains(s)), `the workspace's database at version 10 or later, with history's stores (${w.ws.version})`);
  await rawPut(w.ws, "hmeta", true, "hactive");
  const last = async (db = w.ws) => (await rawAll(db, "htokens")).at(-1);
  const A = await w.mkdir("/A"), B = await w.mkdir("/A/B");
  const f = await w.create("/A/B/f.txt", { content: "one" });
  let t = await last();
  check(t?.ident === f.fid && t.kind === "file" && J(t.chain) === J([A.fid, B.fid]), `create: the file's token, its chain [A, B] by fid: ${J(t)}`);
  await w.write("/A/B/f.txt", "two");
  t = await last();
  check(t?.ident === f.fid && J(t.chain) === J([A.fid, B.fid]), "write: the file's token again");
  await w.rename("/A/B", "/A/C");
  t = await last();
  check(t?.ident === B.fid && t.kind === "folder" && J(t.chain) === J([A.fid]), `rename of a folder: the folder's token, fids unchanged: ${J(t)}`);
  await w.rename("/A/C/f.txt", "/f.txt");
  t = await last();
  check(t?.ident === f.fid && J(t.chain) === "[]", `a cross-folder move: the new ancestry (the root): ${J(t)}`);
  const trashed = await w.remove("/f.txt");
  t = await last();
  check(t?.ident === f.fid && t.chain === null, `to Trash: chain null: ${J(t)}`);
  await w.restore(trashed.path);
  t = await last();
  check(t?.ident === f.fid && J(t.chain) === "[]", `restored from Trash: the restored ancestry: ${J(t)}`);
  const bd = await w.create("/A/plan.board.json");
  const bt = (await rawAll(w.ws, "htokens")).filter((x) => x.kind === "board");
  check(bt.length >= 1 && bt.every((x) => x.ident === bd.ref), `a board's row written: its token(s), by the board's id (${bt.length})`);
  const rows = await rawAll(w.ws, "htokens"), m = await metaOf(w.ws);
  check(J(rows.map((r) => r.seq)) === J(rows.map((_, i) => i + 1)) && m.hcount === rows.length && m.hbytes === rows.reduce((s, r) => s + r.sz, 0), "the workspace's tokens: contiguous seqs, counters equal to a recount");
  const nb = await w.create("/A/n.ipynb");
  const nt = await last(w.main);
  check(nt?.ident === nb.ref && nt.kind === "notebook" && nt.chain === null, `a notebook's record saved: its token in the notebooks' database, no chain: ${J(nt)}`);
  const rec = await rawGet(w.main, "notebooks", nb.ref);
  check(nt?.rev === rec?.rev, `a notebook token keeps its record's rev domain (${nt?.rev} = the record's ${rec?.rev})`);
  // (A1-T17: three folders made in ONE transaction: each token at its OWN op's seq)
  const before = (await rawAll(w.ws, "htokens")).length;
  await w.mkdir("/D/E/F");
  const made = (await rawAll(w.ws, "htokens")).slice(before), ops = (await w.ops()).filter((o) => o.op === "mkdir" && ["/D", "/D/E", "/D/E/F"].includes(o.path));
  check(made.length === 3 && ops.length === 3 && made.every((t) => ops.some((o) => o.fid === t.ident && o.seq === t.rev)) && new Set(made.map((t) => t.rev)).size === 3, `A1-T17: mkdir /D/E/F in one transaction: 3 tokens, each at its own op's seq (${J(made.map((t) => t.rev))} vs ${J(ops.map((o) => o.seq))})`);
  // (A1-T18: a board's index event (its file renamed: log) carries the op's seq; its content event (boardRowWrite) the row's rev.
  // One call may write both, in either order (a rename also rewrites the row; a write also logs its op): each is looked
  // for among the call's tokens, by its writer's rev, not as the last token)
  const since = async (k) => (await rawAll(w.ws, "htokens")).slice(k).filter((t) => t.ident === bd.ref && t.kind === "board");
  let k0 = (await rawAll(w.ws, "htokens")).length;
  await w.rename("/A/plan.board.json", "/A/plan3.board.json");
  const idx = await since(k0), rop = (await w.ops()).filter((o) => o.op === "rename").at(-1);
  check(rop !== undefined && idx.some((t) => t.rev === rop.seq), `A1-T18: a board's index event (rename): a token whose rev is the op's seq (${J(idx.map((t) => t.rev))} has ${rop?.seq})`);
  k0 = (await rawAll(w.ws, "htokens")).length;
  await w.write("/A/plan3.board.json", { title: "plan3", nodes: [] });
  const con = await since(k0), row = await rawGet(w.ws, "boards", bd.ref), wop = (await w.ops()).filter((o) => o.op === "write").at(-1);
  check(row !== undefined && con.some((t) => t.rev === row.rev), `A1-T18: its content event (write): a token whose rev is the row's rev (${J(con.map((t) => t.rev))} has ${row?.rev})`);
  check(con.every((t) => t.rev === row?.rev || t.rev === wop?.seq), `A1-T18: and no other rev among the write's tokens (row ${row?.rev}, op ${wop?.seq}: ${J(con.map((t) => t.rev))})`);
  w.close?.();
}

// ---- A1-T8, A1-T11 (iii): a reset. "new" (a new workspace identity: a new lineage) empties history's stores in BOTH
// databases where they exist, and creates none where they don't; "keep" (the same data, a new generation: the lineage
// continues) clears nothing, the exhausted state included
const until = async (f, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await f()) return true; await new Promise((r) => setTimeout(r, 50)); } return false; };
{
  const name = `htokw-${++n}`, mainName = `htokm-${n}`;
  const pre = await openRaw(mainName, { notebooks: { keyPath: "id" }, files: null, htokens: { keyPath: "seq" }, hmeta: null });
  await rawPut(pre, "hmeta", true, "hactive");
  pre.close();
  const w = await W.Workspace.open({ name, mainName });
  await rawPut(w.ws, "hmeta", true, "hactive");
  await w.create("/k.txt", { content: "k" });
  await w.create("/k.ipynb");
  await rawPut(w.ws, "hmeta", true, "exhausted");
  await w.reset("keep");
  check((await rawGet(w.ws, "hmeta", "exhausted")) === true && (await rawAll(w.ws, "htokens")).length > 0, "A1-T11 (iii): reset \"keep\" (a continuing lineage): exhausted NOT cleared, tokens kept");
  await w.reset("new");
  const emptied = await until(async () => (await rawAll(w.ws, "htokens")).length === 0 && (await rawAll(w.ws, "hmeta")).length === 0 && (await rawAll(w.main, "htokens")).length === 0 && (await rawAll(w.main, "hmeta")).length === 0);
  check(emptied, `A1-T8: reset "new" (a new identity, ${J(w.identity)}): history's stores emptied in both databases (exhausted with them: a new lineage)`);
  w.close?.();
}
{
  const name = `htokw-${++n}`, mainName = `htokm-${n}`;
  const w = await W.Workspace.open({ name, mainName });
  await w.create("/z.ipynb");
  const before = [...w.main.objectStoreNames].sort();
  await w.reset("new");
  await until(async () => (await rawAll(w.ws, "htokens")).length === 0);
  check(J([...w.main.objectStoreNames].sort()) === J(before) && !w.main.objectStoreNames.contains("htokens"), `A1-T8: reset "new" with a notebooks database WITHOUT history's stores: none created (${J(before)})`);
  w.close?.();
}

// ---- inert: a notebooks database WITHOUT history's stores (every production one in layer 1) saves as before
{
  const name = `htokw-${++n}`, mainName = `htokm-${n}`;
  const w = await W.Workspace.open({ name, mainName });
  await w.create("/n.ipynb");
  check(!w.main.objectStoreNames.contains("htokens") && !w.main.objectStoreNames.contains("hmeta"), "inert: the app's own opener makes no history stores in the notebooks' database");
  const ws = await rawAll(w.ws, "htokens"), m = await metaOf(w.ws);
  check(ws.length === 0 && J(m) === J({}), "inert: with hactive unset, the workspace's ops write no token and no hmeta key");
  w.close?.();
}

export async function run() {
  return results;
}
