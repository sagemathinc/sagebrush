// The shared reducer of the workspace index (web/workspace/sync-reduce.ts;
// design/sync-client.md C4): its JSON vectors (sync-vectors.json, which the
// server will run too), copies of an index independent of each other, and
// random logs from three devices: never a throw, the same index from the
// same ops, the index's own maps consistent, nothing a write applied lost,
// and the work of the largest workspace bounded.
//   bun web/workspace/test-sync-reduce.mjs
import { readFileSync } from "node:fs";
import { reduce, reduceAll, SyncIndex } from "./sync-reduce.ts";
import { TRASH, normPath, parentOf } from "./paths.ts";

let checks = 0;
const fails = [];
const check = (ok, what) => { checks++; if (!ok) fails.push(what); };
const here = new URL(".", import.meta.url).pathname;
const view = (ix) => ix.entries().map((e) => ({ path: e.path, id: e.id, kind: e.kind, ...(e.sha256 ? { sha256: e.sha256 } : {}), ...(e.trashed ? { trashedFrom: e.trashed.from } : {}) }));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// the vectors: each from an empty index, in seq order
const { vectors } = JSON.parse(readFileSync(here + "sync-vectors.json", "utf8"));
check(vectors.length >= 39, `the vectors: ${vectors.length}`);
for (const v of vectors) {
  const ix = new SyncIndex(), skipped = [];
  for (const op of v.ops) if (reduce(ix, op).skipped !== undefined) skipped.push(op.seq);
  check(same(view(ix), v.expect), `${v.name}: ${JSON.stringify(view(ix))}`);
  check(same(skipped, v.skipped), `${v.name}: skipped ${JSON.stringify(skipped)}, not ${JSON.stringify(v.skipped)}`);
  check(v.ops.every((op, i) => op.seq === i + 1), `${v.name}: its ops in seq order`);
  // a copy made part way, given the rest, ends the same; the index it was copied from doesn't move
  for (let k = 0; k <= v.ops.length; k++) {
    const a = reduceAll(v.ops.slice(0, k)), before = JSON.stringify(view(a)), b = reduceAll(v.ops.slice(k), a.clone());
    if (!same(view(b), v.expect) || JSON.stringify(view(a)) !== before) { check(false, `${v.name}: a copy after ${k} ops`); break; }
  }
}

// random logs: three devices, a few identities, paths that collide, look the same, or are in Trash
let seed = 7;
const rand = () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const pick = (a) => a[Math.floor(rand() * a.length)];
const DEV = ["aaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbb", "cccccccccccccccc"];
const FILES = Array.from({ length: 10 }, (_, i) => "f" + String(i + 1).padStart(15, "0"));
const FOLDERS = Array.from({ length: 5 }, (_, i) => "e" + String(i + 1).padStart(15, "0"));
const DOCS = ["b0a4d0000001", "b0a4d0000002"];
const SHAS = "0123456789abcdef".split("").map((c) => c.repeat(64));
// (names and folders long enough that a (2), a conflict copy or a move passes the workspace's bounds)
const LONG = "l".repeat(250), DEEP = "/" + ["p", "q", "r"].map((c) => c.repeat(240)).join("/");
const DIRS = ["/", "/a", "/b", "/a/c", "/Trash", "/a/b", DEEP, DEEP + "/a"];
const NAMES = ["x.txt", "y.txt", "caf\u00e9.txt", "cafe\u0301.txt", "K.txt", "\u212a.txt", "a", "b", "c", LONG + ".txt", LONG];
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
  // (where it goes, by a folder's identity: one there or not, a file's, or one on an op that can't have it)
  if (rand() < 0.4) base.parent = pick([...FOLDERS, ...FOLDERS, pick(FILES)]);
  return base;
}
/** Why `ix`'s maps disagree with its entries, or "". */
function broken(ix) {
  if (ix.byKey.size !== ix.byId.size) return `${ix.byKey.size} paths for ${ix.byId.size} entries`;
  let kids = 0;
  for (const [id, e] of ix.byId) {
    if (e.id !== id || ix.byKey.get(e.path.normalize("NFC")) !== id) return `${e.path}: its keys`;
    try { if (normPath(e.path) !== e.path) return `${e.path}: not a path as it is`; } catch (err) { return `${e.path.length} characters: ${err.message}`; }
    const up = parentOf(e.path);
    if (up !== "/" && up !== TRASH && ix.at(up)?.kind !== "folder") return `${e.path}: no folder ${up}`;
    if (up === TRASH ? !e.trashed : !!e.trashed) return `${e.path}: in Trash, but trashed ${JSON.stringify(e.trashed)}`;
    if (!ix.children.get(up.normalize("NFC"))?.has(id)) return `${e.path}: not among ${up}'s`;
    if (ix.gone.has(id)) return `${e.path}: also forgotten`;
  }
  for (const s of ix.children.values()) kids += s.size;
  return kids === ix.byId.size ? "" : `${kids} children for ${ix.byId.size} entries`;
}
let threw = 0, bad = "", lost = "", nondet = "", partial = "", applied = 0, skippedN = 0;
const state = (ix) => JSON.stringify([view(ix), [...ix.byKey].sort(), [...ix.children].map(([k, v]) => [k, [...v].sort()]).sort(), [...ix.gone].sort()]);
for (let run = 0; run < 400; run++) {
  const ops = [], dseq = {};
  for (let i = 1; i <= 80; i++) ops.push(randomOp(i, dseq));
  const ix = new SyncIndex();
  for (const op of ops) {
    let out;
    const before = state(ix);
    try { out = reduce(ix, op); } catch (err) { threw++; bad ||= `run ${run}, seq ${op.seq}: threw ${err}`; break; }
    if (out.skipped === undefined) applied++; else skippedN++;
    // (an op skipped changed nothing at all: its folders made, entries moved and identities forgotten all put back)
    if (out.skipped !== undefined && (state(ix) !== before || out.changed.length)) partial ||= `run ${run}, seq ${op.seq}: ${out.skipped}`;
    const why = broken(ix);
    if (why && !bad) bad = `run ${run}, after ${JSON.stringify(op)}: ${why}`;
    // (an applied write's bytes are somewhere: the file itself, or a conflict copy)
    if (op.op === "write" && out.skipped === undefined && ![...ix.byId.values()].some((e) => e.sha256 === op.sha256)) lost ||= `run ${run}, seq ${op.seq}`;
  }
  if (!same(view(reduceAll(ops)), view(ix))) nondet ||= `run ${run}`;
}
check(!threw && !bad, `random logs: the index stays consistent and nothing throws: ${bad}`);
check(!partial, `random logs: an op skipped leaves the index exactly as it was: ${partial}`);
check(!lost, `random logs: an applied write's bytes are never lost: ${lost}`);
check(!nondet, `random logs: the same ops give the same index: ${nondet}`);
check(applied > 10000 && skippedN > 1000, `random logs exercise both: ${applied} applied, ${skippedN} skipped`);

// the largest workspace (100,000 entries; 10,000 in one folder): built, then that folder renamed and put in Trash, each bounded
{
  const ops = [];
  let seq = 0, n = 0;
  const op = (o) => ops.push({ seq: ++seq, device: DEV[0], dseq: seq, t: seq, by: "person", ...o });
  const fid = () => (++n).toString(16).padStart(16, "0");
  for (let d = 0; d < 10; d++) {
    const f = fid();
    op({ op: "mkdir", path: `/d${d}`, kind: "folder", fid: f });
    if (d === 0) var big = f;
    for (let i = 0; i < 9999; i++) op({ op: "create", path: `/d${d}/f${i}.txt`, kind: "file", fid: fid(), sha256: SHAS[i % 16], size: 1 });
  }
  const t0 = performance.now(), ix = reduceAll(ops), t1 = performance.now();
  const ren = reduce(ix, { seq: ++seq, device: DEV[1], dseq: 1, t: seq, by: "person", op: "rename", path: "/d0", to: "/big", kind: "folder", fid: big });
  const t2 = performance.now();
  const rem = reduce(ix, { seq: ++seq, device: DEV[1], dseq: 2, t: seq, by: "person", op: "remove", path: "/big", to: "/Trash/big", kind: "folder", fid: big });
  const t3 = performance.now();
  check(ix.byId.size === 100000 && ren.changed.length === 10000 && rem.changed.length === 10000 && ix.at("/Trash/big/f5.txt") && !broken(ix), `100,000 entries: the folder of 10,000 renamed then put in Trash: ${ix.byId.size}, ${ren.changed.length}, ${rem.changed.length}`);
  check(t1 - t0 < 5000 && t2 - t1 < 500 && t3 - t2 < 500, `…built in ${Math.round(t1 - t0)} ms (under 5 s); rename ${Math.round(t2 - t1)} ms, remove ${Math.round(t3 - t2)} ms (each under 0.5 s)`);
}

// no DOM, IndexedDB or clock: only paths' rules and the synchronous SHA-256, so a Worker and the server bundle it
{
  const src = readFileSync(here + "sync-reduce.ts", "utf8"), imports = [...src.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]);
  check(same(imports, ["./paths", "../../src/runtime/sha256"]), `sync-reduce.ts imports only paths and sha256: ${JSON.stringify(imports)}`);
  check(!/\b(indexedDB|IDB\w+|window|document|localStorage|Date\.now|performance|Math\.random|crypto)\b/.test(src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")), "…and uses no browser state, clock or randomness");
  const paths = readFileSync(here + "paths.ts", "utf8");
  check(!/^import /m.test(paths), "paths.ts imports nothing");
}

console.log(`${checks - fails.length}/${checks} checks passed`);
for (const f of fails) console.log("FAIL", f.slice(0, 400));
process.exit(fails.length ? 1 : 0);
