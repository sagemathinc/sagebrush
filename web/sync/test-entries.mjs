// ci: web-sync.2 order=75
// The server's index (web/sync/entries.ts; fs-sync step 1a2): the shared reducer, unchanged, on SQLite tables, gives
// exactly the index the in-memory reducer gives (its entries, keys, folders' children and tombstones), after every op of
// the shared vectors and of random logs from three devices; a budget stop is never an op refused, and writes nothing.
// Here on node:sqlite through a shim of the Durable Object's `sql.exec`; the account object's own use is test-agent.mjs.
//
//   node web/sync/test-entries.mjs
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

const here = dirname(fileURLToPath(import.meta.url));
const units = execFileSync("bun", ["build", join(here, "test-entries-units.ts"), "--format", "esm", "--target", "node"], { encoding: "utf8" });
const U = await import("data:text/javascript;base64," + Buffer.from(units).toString("base64"));

let failures = 0, count = 0;
function ok(cond, what) {
  count++;
  if (!cond) {
    failures++;
    console.log("FAIL", what);
  }
}

/** A Durable Object `sql` over node:sqlite: exec(query, ...binds) gives rows with toArray() and iteration. */
// (`n` counts, independently of the Budget, what the index charges for: each lookup of a row, each child row a folder
// read gives, each row written; the ord counter of ix_meta aside, which is bookkeeping, not a row of the index)
function storage() {
  const db = new DatabaseSync(":memory:");
  const n = { lookups: 0, childRows: 0, writes: 0 };
  return {
    db,
    n,
    exec(q, ...b) {
      const st = db.prepare(q);
      const read = /^\s*(SELECT|PRAGMA|WITH)/i.test(q);
      const rows = read ? st.all(...b) : (st.run(...b), []);
      if (/ix_(entries|keys|children|gone)/.test(q)) {
        if (read) n.lookups++;
        else if (/^\s*(INSERT|DELETE|UPDATE)/i.test(q)) n.writes++;
        if (read && /FROM ix_children/.test(q)) n.childRows += rows.length;
      }
      return { toArray: () => rows, [Symbol.iterator]: () => rows[Symbol.iterator]() };
    },
  };
}
const counted = (s) => s.n.lookups + s.n.childRows + s.n.writes;
function fresh() {
  const s = storage();
  for (const q of U.SCHEMA) s.exec(q);
  return s;
}
const byPath = (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
const sortPairs = (a) => a.sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
/** All of an index, in one form for both: entries (every field), keys, folders' children, tombstones. */
// (a folder's children in their order: the reducer walks them so)
const memState = (ix) => JSON.stringify([ix.entries(), sortPairs([...ix.byKey]), sortPairs([...ix.children].map(([k, v]) => [k, [...v]])), sortPairs([...ix.gone])]);
function sqlState(s) {
  const entries = s.exec("SELECT data FROM ix_entries").toArray().map((r) => JSON.parse(r.data)).sort(byPath);
  const keys = sortPairs(s.exec("SELECT key, id FROM ix_keys").toArray().map((r) => [r.key, r.id]));
  const ch = new Map();
  for (const r of s.exec("SELECT pk, id FROM ix_children ORDER BY ord").toArray()) ch.set(r.pk, [...(ch.get(r.pk) ?? []), r.id]);
  const children = sortPairs([...ch]);
  const gone = sortPairs(s.exec("SELECT id, path FROM ix_gone").toArray().map((r) => [r.id, r.path]));
  return JSON.stringify([entries, keys, children, gone]);
}
// (an entry as the in-memory index holds it: fields in the reducer's own order, so JSON compares; re-read through JSON)
const norm = (st) => JSON.stringify(JSON.parse(st).map((part, i) => (i === 0 ? part.map((e) => Object.fromEntries(Object.entries(e).sort())) : part)));

// ---- the shared vectors: the same index after every op
{
  const { vectors } = JSON.parse(readFileSync(join(here, "../workspace/sync-vectors.json"), "utf8"));
  let bad = 0, opsRun = 0, firstBad = "";
  for (const v of vectors) {
    const mem = new U.SyncIndex(), s = fresh();
    for (const op of v.ops) {
      opsRun++;
      const a = U.reduce(mem, op);
      const b = U.applyOp(s, op, new U.Budget(U.IX.visits));
      if (norm(memState(mem)) !== norm(sqlState(s)) || JSON.stringify(a) !== JSON.stringify(b.out)) {
        bad++;
        firstBad ||= `${v.name}, op ${op.seq}`;
        if (process.env.DEBUG && bad === 1) {
          const m = JSON.parse(norm(memState(mem))), q = JSON.parse(norm(sqlState(s)));
          const short = (x) => String(JSON.stringify(x)).replace(/([pqr])\1{20,}/g, "$1…").slice(0, 400);
          for (let k = 0; k < 4; k++) {
            const n = Math.max(m[k].length, q[k].length);
            for (let j = 0; j < n; j++) if (JSON.stringify(m[k][j]) !== JSON.stringify(q[k][j])) { console.log("V part", k, "item", j, "\nMEM", short(m[k][j]), "\nSQL", short(q[k][j])); break; }
          }
          console.log("V out", JSON.stringify(a), JSON.stringify(b.out));
        }
        break;
      }
    }
  }
  ok(vectors.length >= 43 && bad === 0, `the shared vectors (${vectors.length}, ${opsRun} ops): the stored index is the in-memory one after every op, outcome and all${firstBad ? ": first at " + firstBad : ""}`);
}

// ---- random logs (test-sync-reduce.mjs's generator): the same index after every op, tombstones included
let randomOps;
{
  let seed = 7;
  const rand = () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const pick = (a) => a[Math.floor(rand() * a.length)];
  const DEV = ["aaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbb", "cccccccccccccccc"];
  const FILES = Array.from({ length: 10 }, (_, i) => "f" + String(i + 1).padStart(15, "0"));
  const FOLDERS = Array.from({ length: 5 }, (_, i) => "e" + String(i + 1).padStart(15, "0"));
  const DOCS = ["b0a4d0000001", "b0a4d0000002"];
  const SHAS = "0123456789abcdef".split("").map((c) => c.repeat(64));
  const LONG = "l".repeat(250), DEEP = "/" + ["p", "q", "r"].map((c) => c.repeat(240)).join("/");
  const DIRS = ["/", "/a", "/b", "/a/c", "/Trash", "/a/b", DEEP, DEEP + "/a"];
  const NAMES = ["x.txt", "y.txt", "café.txt", "café.txt", "K.txt", "K.txt", "a", "b", "c", LONG + ".txt", LONG];
  const path = () => { const d = pick(DIRS), n = pick(NAMES); return (d === "/" ? "" : d) + "/" + n; };
  function randomOp(seq, dseq) {
    const device = pick(DEV), r = rand(), op = { seq, device, dseq: (dseq[device] = (dseq[device] ?? 0) + 1), t: seq, by: "person" };
    const what = pick(["create", "create", "mkdir", "write", "write", "write", "rename", "rename", "remove", "restore", "forget", "doc", "junk"]);
    if (what === "doc") return { ...op, op: pick(["create", "rename", "remove", "restore"]), path: "/n" + pick(["", "2"]) + ".board.json", to: pick(["/m.board.json", "/Trash/m.board.json", "/m.txt"]), kind: "board", ref: pick(DOCS) };
    if (what === "junk") return pick([{ ...op, op: "create", path: "rel.txt", kind: "file", fid: pick(FILES), sha256: pick(SHAS) }, { ...op, op: "write", path: "/x.txt", kind: "file", sha256: pick(SHAS) }, { ...op, op: "nonsense", path: "/x.txt", kind: "file", fid: pick(FILES) }, { ...op, op: "create", path: "/x.txt", kind: "file", fid: pick(FILES) }]);
    const folder = what === "mkdir" || (what !== "create" && what !== "write" && r < 0.3);
    const base = { ...op, op: what, path: path(), kind: folder ? "folder" : "file", fid: folder ? pick(FOLDERS) : pick(FILES) };
    if (what === "create" || what === "write") Object.assign(base, { sha256: pick(SHAS), size: 1 }, what === "write" ? { base: pick(SHAS) } : {});
    if (what === "rename") base.to = path();
    if (what === "remove") base.to = "/Trash/" + pick(NAMES);
    if (what === "restore" && rand() < 0.5) base.to = path();
    if ((what === "restore" || what === "rename") && rand() < 0.1) base.to = pick(["/", "/Trash"]);
    if (rand() < 0.4) base.parent = pick([...FOLDERS, ...FOLDERS, pick(FILES)]);
    return base;
  }
  randomOps = (n, s0) => {
    seed = s0;
    const dseq = {};
    return Array.from({ length: n }, (_, i) => randomOp(i + 1, dseq));
  };
  let bad = 0, applied = 0, skipped = 0, firstBad = "", goneSeen = 0, mischarged = "", charged = 0;
  for (let run = 0; run < 200 && !bad; run++) {
    const dseq = {}, mem = new U.SyncIndex(), s = fresh();
    for (let i = 1; i <= 80; i++) {
      const op = randomOp(i, dseq);
      const at = counted(s), budget = new U.Budget(U.IX.visits);
      const a = U.reduce(mem, op), b = U.applyOp(s, op, budget);
      // (the charge is exactly the rows read and written: none uncharged, none charged twice)
      charged += budget.used;
      if (!mischarged && budget.used !== counted(s) - at) mischarged = `run ${run}, op ${i} (${op.op}): charged ${budget.used}, rows read and written ${counted(s) - at}`;
      if (a.skipped === undefined) applied++;
      else skipped++;
      if (norm(memState(mem)) !== norm(sqlState(s)) || JSON.stringify(a) !== JSON.stringify(b.out)) {
        bad++;
        firstBad = `run ${run}, op ${i} (${op.op})`;
        if (process.env.DEBUG) {
          const m = JSON.parse(norm(memState(mem))), q = JSON.parse(norm(sqlState(s)));
          const short = (x) => String(JSON.stringify(x)).replace(/([pqr])\1{20,}/g, "$1…").slice(0, 400);
          for (let k = 0; k < 4; k++) {
            const n = Math.max(m[k].length, q[k].length);
            for (let j = 0; j < n; j++) if (JSON.stringify(m[k][j]) !== JSON.stringify(q[k][j])) { console.log("part", k, "item", j, "\nMEM", short(m[k][j]), "\nSQL", short(q[k][j])); break; }
          }
          console.log("op", JSON.stringify(op).slice(0, 400), "\nmem out", JSON.stringify(a), "\nsql out", JSON.stringify(b.out));
        }
        break;
      }
    }
    goneSeen += mem.gone.size;
  }
  ok(bad === 0, `random logs (200 x 80 ops): the stored index is the in-memory one after every op${firstBad ? ": first at " + firstBad : ""}`);
  ok(!mischarged && charged > 0, `random logs: every op's charge is the rows it read and wrote (lookups, children rows, writes)${mischarged ? ": first at " + mischarged : ""}`);
  ok(applied > 5000 && skipped > 500 && goneSeen > 0, `random logs exercise applied and refused ops and tombstones: ${applied} applied, ${skipped} refused, ${goneSeen} tombstones at the ends`);
}

// ---- a budget stop: thrown before the visit past the bound, never an op refused, nothing written
{
  const s = fresh();
  const mk = (seq, p) => ({ seq, device: "aaaaaaaaaaaaaaaa", dseq: seq, t: seq, by: "person", op: "mkdir", path: p, kind: "folder", fid: "e" + String(seq).padStart(15, "0") });
  U.applyOp(s, mk(1, "/a"), new U.Budget(U.IX.visits));
  const before = sqlState(s);
  let stopped = null, need = 0, usedAtNeed = -1;
  // (the least budget the next op needs, found from above: every smaller one stops it)
  for (let lim = 0; lim < 200; lim++) {
    const b = new U.Budget(lim);
    try {
      U.applyOp(s, mk(2, "/a/b"), b);
      need = lim;
      usedAtNeed = b.used;
      break;
    } catch (e) {
      stopped = e;
      if (!(e instanceof U.BudgetStop) || sqlState(s) !== before) break;
    }
  }
  ok(need > 0 && stopped instanceof U.BudgetStop, `an op over its budget stops with BudgetStop, below ${need} visits`);
  // (and the least budget it applies under is exactly what it uses: a bound of n allows n, never n + 1)
  ok(usedAtNeed === need, `the least budget an op applies under is the charge it makes: ${usedAtNeed} of ${need}`);
  // (the stop at need - 1: the op's writes never happened; at need, it applies)
  const s2 = fresh();
  U.applyOp(s2, mk(1, "/a"), new U.Budget(U.IX.visits));
  const b2 = new U.Budget(need - 1);
  let threw = false;
  try {
    U.applyOp(s2, mk(2, "/a/b"), b2);
  } catch (e) {
    threw = e instanceof U.BudgetStop;
  }
  ok(threw && sqlState(s2) === before && b2.used <= need - 1, `at one under its budget: a stop, nothing written, no charge past the bound (${b2.used} of ${need - 1})`);
}

// ---- subtree ops in steps (#904 D1): every op through the deferred job, in small pages, its state re-read from storage
// at every step (as after a restart), each step a transaction (a stop rolls it back whole); the index is the reducer's
// after every op: entries, keys, tombstones, and each folder's children (as sets: their order is the outcome's, which
// the server doesn't keep)
const setState = (st) => {
  const v = JSON.parse(st);
  v[2] = v[2].map(([k, ids]) => [k, [...ids].sort()]);
  return JSON.stringify(v);
};
function deferred(s, op, page, limit = U.IX.visits) {
  U.JOB.page = page;
  U.JOB.pages = 1;
  const db = s.db;
  let job = U.jobNew(op.seq), steps = 0, result;
  U.jobPut(s, job);
  for (;;) {
    steps++;
    if (steps > 100000) throw new Error("the job never ends");
    db.exec("BEGIN");
    try {
      job = U.jobGet(s);
      const b = new U.Budget(limit);
      const r = U.jobStep(s, job, op, b, true);
      result = r.result;
      if (result === "more") U.jobPut(s, job);
      else U.jobPut(s, null);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      if (!(e instanceof U.BudgetStop)) throw e;
      throw new Error("a fresh step stopped");
    }
    if (result !== "more") return { result, steps, job };
  }
}
/** As deferred(), at the real step budget, any number of pages a step; the most visits one step took. */
function deferredAt(s, op, page) {
  const db = s.db;
  let job = U.jobNew(op.seq), steps = 0, most = 0, result;
  U.jobPut(s, job);
  for (;;) {
    steps++;
    db.exec("BEGIN");
    job = U.jobGet(s);
    const b = new U.Budget(U.IX.visits);
    result = U.jobStep(s, job, op, b, true, page).result;
    most = Math.max(most, b.used);
    U.jobPut(s, result === "more" ? job : null);
    db.exec("COMMIT");
    if (result !== "more") return { result, steps, most };
  }
}
{
  let bad = 0, firstBad = "", ops = 0, multi = 0, skips = 0, moved = 0;
  for (let run = 0; run < 120 && !bad; run++) {
    const mem = new U.SyncIndex(), s = fresh();
    for (const op of randomOps(80, 1000 + run)) {
      ops++;
      const a = U.reduce(mem, op);
      const r = deferred(s, op, 1 + (run % 3));
      if (r.steps > 3) multi++;
      if (r.result === "skip") skips++;
      if (a.skipped === undefined && a.changed.length > 1) moved++;
      if (setState(norm(memState(mem))) !== setState(norm(sqlState(s))) || (r.result === "skip") !== (a.skipped !== undefined && sqlState(s) === sqlState(s))) {
        if (setState(norm(memState(mem))) !== setState(norm(sqlState(s)))) {
          bad++;
          firstBad = `run ${run}, op ${op.seq} (${op.op} ${op.kind} ${String(op.path).slice(0, 40)} -> ${String(op.to ?? "").slice(0, 40)}), ${r.result} in ${r.steps} steps`;
          if (process.env.DEBUG) {
            const m = JSON.parse(setState(norm(memState(mem)))), q = JSON.parse(setState(norm(sqlState(s))));
            for (let k = 0; k < 4; k++) {
              const n = Math.max(m[k].length, q[k].length);
              for (let j = 0; j < n; j++) if (JSON.stringify(m[k][j]) !== JSON.stringify(q[k][j])) { console.log("D part", k, "item", j, "\nMEM", JSON.stringify(m[k][j]).slice(0, 300), "\nSQL", JSON.stringify(q[k][j]).slice(0, 300)); break; }
            }
            console.log("op", JSON.stringify(op).slice(0, 300), "\nout", JSON.stringify(a).slice(0, 300), "\njob", JSON.stringify(r.job).slice(0, 600));
          }
          break;
        }
      }
    }
  }
  ok(bad === 0, `every op as a job, in pages of 1-3 rows, its state re-read at each step: the reducer's index after every op${firstBad ? ": first at " + firstBad : ""}`);
  ok(multi >= 20 && moved > 300, `(the jobs span steps: ${multi} ops in more than 3 steps, ${moved} ops that moved more than one entry, ${skips} passed as skips, of ${ops})`);
}

// big subtrees, every kind of subtree op, each as a job in pages of 7 rows, one page a step: the reducer's index after
// each, and the job's steps grow with the subtree
{
  const mem = new U.SyncIndex(), s = fresh();
  let seq = 0;
  const mk = (o) => ({ seq: ++seq, device: "aaaaaaaaaaaaaaaa", dseq: seq, t: seq, by: "person", ...o });
  const fidOf = (n) => "e" + String(n).padStart(15, "0"), fileOf = (n) => "f" + String(n).padStart(15, "0");
  const run = (o, what, wantSkip = false) => {
    const op = mk(o);
    const a = U.reduce(mem, op);
    const r = deferred(s, op, 7);
    const same = setState(norm(memState(mem))) === setState(norm(sqlState(s)));
    ok(same && (a.skipped !== undefined) === wantSkip && (r.result === "skip") === wantSkip, `${what}: the reducer's index (${r.result} in ${r.steps} steps${a.skipped ? "; " + a.skipped.slice(0, 60) : ""})`);
    return r;
  };
  // /big: 3 levels, 10 folders of 10 files each, and a sibling /bigger whose name extends it
  run({ op: "mkdir", path: "/big", kind: "folder", fid: fidOf(1) }, "(mkdir /big)");
  run({ op: "mkdir", path: "/bigger", kind: "folder", fid: fidOf(2) }, "(mkdir /bigger)");
  run({ op: "create", path: "/bigger/keep.txt", kind: "file", fid: fileOf(9999), sha256: "c".repeat(64), size: 1 }, "(a file in /bigger)");
  for (let d = 0; d < 10; d++) {
    const md = mk({ op: "mkdir", path: `/big/d${d}`, kind: "folder", fid: fidOf(10 + d) });
    U.reduce(mem, md);
    U.applyOp(s, md, new U.Budget(1e9));
    for (let f = 0; f < 10; f++) {
      const op = mk({ op: "create", path: `/big/d${d}/f${f}.txt`, kind: "file", fid: fileOf(100 * d + f + 1), sha256: "a".repeat(64), size: 1 });
      U.reduce(mem, op);
      U.applyOp(s, op, new U.Budget(1e9));
    }
  }
  ok(setState(norm(memState(mem))) === setState(norm(sqlState(s))), "(111 entries under /big, both)");
  const r1 = run({ op: "rename", path: "/big", to: "/moved", kind: "folder", fid: fidOf(1) }, "a rename of a folder of 110 descendants");
  ok(r1.steps > 30, "its job spans steps (7 rows a page, a page a step): " + r1.steps);
  run({ op: "remove", path: "/moved", to: "/Trash/moved", kind: "folder", fid: fidOf(1) }, "its move to Trash");
  run({ op: "write", path: "/Trash/moved/d3/f3.txt", kind: "file", fid: fileOf(304), sha256: "b".repeat(64), base: "a".repeat(64), size: 2 }, "a write to a file in it: the folder comes back with it, the file written");
  run({ op: "remove", path: "/moved", to: "/Trash/moved", kind: "folder", fid: fidOf(1) }, "to Trash again");
  run({ op: "write", path: "/Trash/moved/d4/f4.txt", kind: "file", fid: fileOf(405), sha256: "d".repeat(64), base: "e".repeat(64), size: 2 }, "a write on another base, to a file in it: back, and a conflict copy beside it");
  run({ op: "rename", path: "/moved/d5", to: "/bigger/d5", kind: "folder", fid: fidOf(15), parent: fidOf(2) }, "a subfolder into the folder whose name extends the old one");
  run({ op: "remove", path: "/moved", to: "/Trash/moved", kind: "folder", fid: fidOf(1) }, "to Trash a third time");
  run({ op: "restore", path: "/Trash/moved", kind: "folder", fid: fidOf(1) }, "a restore");
  run({ op: "create", path: "/moved/d6/new.txt", kind: "file", fid: fileOf(9000), sha256: "f".repeat(64), size: 1, parent: fidOf(16) }, "a create in a subfolder of it (by parent)");
  run({ op: "remove", path: "/moved", to: "/Trash/moved", kind: "folder", fid: fidOf(1) }, "to Trash a fourth time");
  run({ op: "create", path: "/x/new2.txt", kind: "file", fid: fileOf(9001), sha256: "f".repeat(64), size: 1, parent: fidOf(17) }, "a create whose parent is in the trashed folder: the folder comes back");
  // past the bounds: a deep name for the destination, so one descendant would pass 1,024 characters
  const long = "/" + "q".repeat(250) + "/" + "r".repeat(250) + "/" + "s".repeat(250) + "/" + "t".repeat(200) + "/" + "u".repeat(60);
  run({ op: "mkdir", path: long, kind: "folder", fid: fidOf(90) }, "(a deep folder, made with its folders)");
  run({ op: "rename", path: "/moved", to: long + "/m", kind: "folder", fid: fidOf(1) }, "a move that would put a descendant past 1,024 characters: changes nothing", true);
  // nested: a rename whose parent is in the trashed folder brings it back, then moves a subfolder of it (with its own
  // files) into another of its subfolders: two regions, one inside the other
  run({ op: "remove", path: "/moved", to: "/Trash/moved", kind: "folder", fid: fidOf(1) }, "(to Trash a fifth time)");
  run({ op: "rename", path: "/Trash/moved/d7", to: "/moved/d8/d7", kind: "folder", fid: fidOf(17), parent: fidOf(18) }, "a subfolder moved into another, by a parent in the trashed folder: back, then the inner move");
  run({ op: "forget", path: "/moved", kind: "folder", fid: fidOf(1) }, "a forget of the folder and all in it");
  ok(U.jobGet(s) === null && s.exec("SELECT COUNT(*) AS n FROM ix_stage").toArray()[0].n === 0, "and no job or stage is left");
}

// past the old one-op bound, at the real bounds: a 12,100-entry subtree (about 9 visits a descendant: more than one
// op's 100,000) renamed and put in Trash, each as a job at the default page; and slices exactly at and one past a page
{
  const mem = new U.SyncIndex(), s = fresh();
  let seq = 0;
  const mk = (o) => ({ seq: ++seq, device: "aaaaaaaaaaaaaaaa", dseq: seq, t: seq, by: "person", ...o });
  const both = (op) => (U.reduce(mem, op), U.applyOp(s, op, new U.Budget(1e9)));
  both(mk({ op: "mkdir", path: "/repo", kind: "folder", fid: "e000000000000001" }));
  for (let d = 0; d < 100; d++) {
    both(mk({ op: "mkdir", path: `/repo/d${d}`, kind: "folder", fid: "e" + String(d + 2).padStart(15, "0") }));
    for (let f = 0; f < 120; f++) both(mk({ op: "create", path: `/repo/d${d}/f${f}.txt`, kind: "file", fid: "f" + String(d * 120 + f + 1).padStart(15, "0"), sha256: "a".repeat(64), size: 1 }));
  }
  const rename = mk({ op: "rename", path: "/repo", to: "/repo2", kind: "folder", fid: "e000000000000001" });
  let stopped = false;
  s.db.exec("BEGIN");
  try {
    U.applyOp(s, rename, new U.Budget(U.IX.visits));
  } catch (e) {
    stopped = e instanceof U.BudgetStop;
  }
  s.db.exec("ROLLBACK");
  ok(stopped, "(a rename of 12,100 descendants can't fit one op's 100,000 visits)");
  U.reduce(mem, rename);
  U.JOB.pages = Infinity;
  const r1 = deferredAt(s, rename, U.IX.jobPage);
  ok(setState(norm(memState(mem))) === setState(norm(sqlState(s))) && r1.result === "done", `as a job at the real bounds: the reducer's index (${r1.steps} steps, ${r1.most} visits at most in one)`);
  const trash = mk({ op: "remove", path: "/repo2", to: "/Trash/repo2", kind: "folder", fid: "e000000000000001" });
  U.reduce(mem, trash);
  const r2 = deferredAt(s, trash, U.IX.jobPage);
  if (process.env.SHOW) console.log(`12,100 descendants: rename ${r1.steps} steps (${r1.most} visits at most), Trash ${r2.steps} steps (${r2.most} at most)`);
  // (the shipped bounds, as literals: 25,000 visits a step and 500 rows a job's page, interim host bounds (LIMITS and
  // PERF on #913); no step of either job took more)
  ok(U.IX.visits === 25_000 && U.IX.jobPage === 500, `the shipped step bounds: ${U.IX.visits} visits, ${U.IX.jobPage} rows a page`);
  ok(r1.most <= 25_000 && r2.most <= 25_000 && r1.steps >= 4 && r2.steps >= 4, `every step within 25,000 visits: rename ${r1.steps} steps (${r1.most} at most), Trash ${r2.steps} steps (${r2.most} at most)`);
  ok(setState(norm(memState(mem))) === setState(norm(sqlState(s))) && r2.result === "done" && r2.most <= U.IX.visits, `and its move to Trash: the reducer's index (${r2.steps} steps, ${r2.most} visits at most in one)`);
}
{
  // (pages of 5: a folder of exactly 10 descendants, then of 11)
  for (const n of [10, 11]) {
    const mem = new U.SyncIndex(), s = fresh();
    let seq = 0;
    const mk = (o) => ({ seq: ++seq, device: "aaaaaaaaaaaaaaaa", dseq: seq, t: seq, by: "person", ...o });
    const both = (op) => (U.reduce(mem, op), U.applyOp(s, op, new U.Budget(1e9)));
    both(mk({ op: "mkdir", path: "/p", kind: "folder", fid: "e000000000000001" }));
    for (let i = 0; i < n; i++) both(mk({ op: "create", path: `/p/f${i}.txt`, kind: "file", fid: "f" + String(i + 1).padStart(15, "0"), sha256: "a".repeat(64), size: 1 }));
    const op = mk({ op: "rename", path: "/p", to: "/q", kind: "folder", fid: "e000000000000001" });
    U.reduce(mem, op);
    const r = deferred(s, op, 5);
    ok(setState(norm(memState(mem))) === setState(norm(sqlState(s))), `${n} descendants in pages of 5 (${n === 10 ? "exactly two" : "one past two"}): the reducer's index, in ${r.steps} steps`);
  }
}

// ---- the index's host bounds in the limits census (LIMITS on #913): each IX_*_MAX line a registered site, and the IX
// object only their names; negative controls: a bound added or changed fails the census, and a literal in IX fails here
{
  const root = join(here, "..", "..");
  const census = (patch) => {
    const py = `import sys, json; sys.path.insert(0, 'test'); import limit_sites as L
orig = L.read
def read(p, rev=None):
    t = orig(p, rev)
    return (${patch}) if p == 'web/sync/entries.ts' else t
L.read = read
print(json.dumps(L.check()['problems']))`;
    return JSON.parse(execFileSync("python3", ["-c", py], { cwd: root, encoding: "utf8" }));
  };
  const clean = census("t");
  ok(Object.values(clean).every((v) => v.length === 0), "the census: web/sync/entries.ts's sites all registered: " + JSON.stringify(clean).slice(0, 200));
  const added = census(`t + "\\nexport const IX_NEW_MAX = 3;\\n"`);
  ok(added.unregistered.some((k) => k.includes("IX_NEW_MAX = 3")), "a bound added (IX_NEW_MAX) is an unregistered site: " + added.unregistered.length);
  const changed = census(`t.replace("IX_VISITS_MAX = 25_000", "IX_VISITS_MAX = 30_000")`);
  ok(changed.unregistered.some((k) => k.includes("IX_VISITS_MAX = 30_000")) && changed.stale.some((k) => k.includes("IX_VISITS_MAX = 25_000")), "a bound changed (25,000 visits to 30,000) is an unregistered site, its old line stale");
  const src = readFileSync(join(here, "entries.ts"), "utf8");
  const literals = (text) => {
    const body = /export const IX = \{\n([\s\S]*?)\n\};/.exec(text)?.[1] ?? "";
    return body.split("\n").filter((l) => !/^\s+\w+: IX_[A-Z_]+_MAX,$/.test(l));
  };
  ok(literals(src).length === 0 && Object.keys(U.IX).length >= 12, "IX names only IX_*_MAX bounds: " + JSON.stringify(literals(src)));
  ok(literals(src.replace("  visits: IX_VISITS_MAX,", "  visits: IX_VISITS_MAX,\n  newcap: 5,")).length === 1, "(a literal added to IX is found)");
}

console.log(`${count - failures}/${count} passed`);
process.exit(failures ? 1 : 0);
