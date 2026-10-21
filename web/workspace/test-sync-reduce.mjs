// The shared reducer of the workspace index (web/workspace/sync-reduce.ts;
// design/sync-client.md C4): its JSON vectors (sync-vectors.json, which the
// server will run too), copies of an index independent of each other, and
// random logs from three devices: never a throw, the same index from the
// same ops, the index's own maps consistent, nothing a write applied lost,
// and the work of the largest workspace bounded.
//   bun web/workspace/test-sync-reduce.mjs
import { readFileSync } from "node:fs";
import { heapStats } from "bun:jsc";
import { reduce, reduceAll, SyncIndex } from "./sync-reduce.ts";
import { TRASH, normPath, parentOf } from "./paths.ts";

let checks = 0;
const fails = [];
const check = (ok, what) => { checks++; if (!ok) fails.push(what); };
const here = new URL(".", import.meta.url).pathname;
const view = (ix) => ix.entries().map((e) => ({ path: e.path, id: e.id, kind: e.kind, ...(e.sha256 ? { sha256: e.sha256 } : {}), ...(e.trashed ? { trashedFrom: e.trashed.from } : {}) }));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// (all of an index: every field of every entry, its maps, what it forgot)
const state = (ix) => JSON.stringify([ix.entries(), [...ix.byKey].sort(), [...ix.children].map(([k, v]) => [k, [...v].sort()]).sort(), [...ix.gone].sort()]);

// the vectors: each from an empty index, in seq order
const { vectors } = JSON.parse(readFileSync(here + "sync-vectors.json", "utf8"));
check(vectors.length >= 43, `the vectors: ${vectors.length}`);
for (const v of vectors) {
  const ix = new SyncIndex(), skipped = [];
  for (const op of v.ops) {
    const before = state(ix), out = reduce(ix, op);
    if (out.skipped === undefined) continue;
    skipped.push(op.seq);
    // (skipped whole: every entry as it was, to its dates and the op that last changed it)
    if (state(ix) !== before) check(false, `${v.name}: seq ${op.seq} skipped but changed the index`);
  }
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
  // (and now and then the root or Trash itself, where nothing can be: astra's CORR-7F4-1)
  if ((what === "restore" || what === "rename") && rand() < 0.1) base.to = pick(["/", "/Trash"]);
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
    if (e.path === "/" || e.path === TRASH) return `an entry at ${e.path}`;
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

// the largest workspace, all in one folder (daybreak2's LIMIT-7F4-1): ~100,000 entries under /big, whose
// last (by the order a move takes them) has a long name.  A move that would put only that one past the
// bounds is skipped whole; then /big renamed, put in Trash and forgotten: each under 0.5 s, and its memory
// under a ceiling: the process's resident memory grown during the op (its peak: Bun's heap counters move
// only at a collection), and the heap it keeps after one
{
  const ops = [], gc = () => globalThis.Bun?.gc?.(true);
  let seq = 0, n = 0;
  const op = (o) => ops.push({ seq: ++seq, device: DEV[0], dseq: seq, t: seq, by: "person", ...o });
  const fid = () => (++n).toString(16).padStart(16, "0");
  const big = fid();
  op({ op: "mkdir", path: "/big", kind: "folder", fid: big });
  for (let d = 0; d < 10; d++) {
    op({ op: "mkdir", path: `/big/s${d}`, kind: "folder", fid: fid() });
    for (let i = 0; i < 9998; i++) op({ op: "create", path: `/big/s${d}/` + (d === 9 && i === 9997 ? "w".repeat(200) : `f${i}.txt`), kind: "file", fid: fid(), sha256: SHAS[i % 16], size: 1 });
  }
  const t0 = performance.now(), ix = reduceAll(ops), t1 = performance.now();
  const N = ix.byId.size, longest = "/big/s9/" + "w".repeat(200), longId = ix.at(longest)?.id;
  const fingerprint = () => JSON.stringify([ix.byId.size, ix.byKey.size, ix.children.size, ix.gone.size, view(ix).map((e) => e.path + "\u0000" + e.id).join("\n")]);
  const before = fingerprint();
  const at = (o) => {
    gc();
    const r0 = process.memoryUsage.rss(), h0 = heapStats().heapSize, t = performance.now();
    const r = reduce(ix, { seq: ++seq, device: DEV[1], dseq: seq, t: seq, by: "person", ...o });
    const ms = performance.now() - t, grew = process.memoryUsage.rss() - r0;
    gc();
    return { r, ms, grew: grew / 2 ** 20, kept: (heapStats().heapSize - h0) / 2 ** 20 };
  };
  // (854 characters: every path under /big fits there but the long one, which a move takes last)
  const far = "/" + ["a", "b", "c"].map((c) => c.repeat(200)).join("/") + "/" + "d".repeat(250);
  const bad = at({ op: "rename", path: "/big", to: far, kind: "folder", fid: big });
  check(bad.r.skipped !== undefined && bad.r.changed.length === 0 && fingerprint() === before && !ix.at("/" + "a".repeat(200)), `a move of ${N} entries whose last would be past the bounds: skipped whole, nothing changed, no folder left: ${bad.r.skipped}`);
  const ren = at({ op: "rename", path: "/big", to: "/big2", kind: "folder", fid: big });
  const rem = at({ op: "remove", path: "/big2", to: "/Trash/big2", kind: "folder", fid: big });
  const fg = at({ op: "forget", path: "/Trash/big2", kind: "folder", fid: big });
  check(N > 99990 && ren.r.changed.length === N && ix.byId.size === 0 && rem.r.changed.length === N && fg.r.changed.length === N && ix.gone.get(big) === "/Trash/big2" && ix.gone.get(longId) === "/Trash/big2/s9/" + "w".repeat(200), `${N} entries in one folder: renamed, put in Trash, forgotten`);
  const ms = (x) => Math.round(x.ms), mb = (x) => `${Math.round(x.grew)}/${Math.round(x.kept)} MiB`;
  const report = `built in ${Math.round(t1 - t0)} ms; the move skipped ${ms(bad)} ms ${mb(bad)}; rename ${ms(ren)} ms ${mb(ren)}; Trash ${ms(rem)} ms ${mb(rem)}; forget ${ms(fg)} ms ${mb(fg)} (grown during / kept after)`;
  console.log(report);
  check(t1 - t0 < 5000 && [bad, ren, rem, fg].every((x) => x.ms < 500), `…built in under 5 s, and each op under 0.5 s: ${report}`);
  // Full GC runs on both sides of each operation.  The retained-heap bound is therefore the stable leak guard;
  // RSS also includes Bun/JSC allocator arenas and OS page accounting, which measured 48–49 MiB twice on GitHub
  // and passed on rerun.  64 MiB gives that transient peak 33% headroom, while still failing well before a 2x
  // regression from the measured 48 MiB.  Keep the post-GC heap ceiling tight at 24 MiB.
  check([bad, ren, rem, fg].every((x) => x.grew < 64 && x.kept < 24), `…each op's memory under its ceiling (64 MiB grown, 24 MiB kept): ${report}`);
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
