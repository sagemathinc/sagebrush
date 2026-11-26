// ci: web-browser/notebook order=186
// sagebrush://'s page side (design sagebrush-fsspec r3 with r3.1-r3.3, P0): web/notebook/sb-fs.js's FsCalls against
// fake workers posting {sbFs} messages as a compromised interpreter could, a fake workspace (web/workspace/api.ts's
// stat, list and history) and a fake fetch standing in for the blob route's 303 and the files Worker's ranges.  The
// rows: SEC's C1 (the caller is the channel), C2 (scope first, no existence oracle, no index opened), C3 (cursors
// bound to the session, workspace and folder), the P0 ruling (R2 only: a file only in this browser refused, a synced
// local file read from R2), LIMITS' exact-length rule (status, Content-Range, Content-Length, a trailing byte, a
// short body), the cache, the loss allowance, and an abandoned call releasing what it held.  No browser, no network.
//   node web/test-sb-fs.mjs
import { readFileSync } from "node:fs";

const { stripTypeScriptTypes } = await import("node:module");
const dataUrl = (text) => "data:text/javascript;base64," + Buffer.from(text).toString("base64");
const shared = dataUrl(stripTypeScriptTypes(readFileSync(new URL("../src/sbfs.ts", import.meta.url), "utf8")));
const SB = await import(shared);
const calls = readFileSync(new URL("./notebook/sb-fs.js", import.meta.url), "utf8");
if (!calls.includes('from "../../src/sbfs.ts"')) throw new Error("sb-fs.js's import of src/sbfs.ts not found");
const M = await import(dataUrl(calls.replace('from "../../src/sbfs.ts"', `from "${shared}"`)));
const { FsCalls, CHUNK, RUN_CHUNKS, CACHE_SLOTS, LOSS_ALLOWANCE, PIN_CAPACITY, URL_SLOTS, LIST_PAGE_ROWS } = M;

const ok = (c, msg) => {
  console.log((c ? "ok   " : "FAIL ") + msg);
  if (!c) process.exitCode = 1;
};
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------ the fakes

const OWN = "0123456789abcdef", OTHER = "fedcba9876543210";
const bytesOf = (n, seed) => new Uint8Array(n).map((_, k) => (k * 31 + seed) & 255);
const FILES = {
  "/d/small.txt": { bytes: new TextEncoder().encode("hello, workspace\n"), sha: "1".repeat(64), remote: false },
  "/d/big.bin": { bytes: bytesOf(RUN_CHUNKS * CHUNK + CHUNK + 123, 5), sha: "2".repeat(64), remote: true },
  "/d/local.bin": { bytes: bytesOf(5000, 9), sha: "3".repeat(64), remote: false, notUploaded: true },
};
const OLD = { bytes: new TextEncoder().encode("earlier\n"), sha: "4".repeat(64) };
const BYSHA = new Map([...Object.values(FILES), OLD].map((f) => [f.sha, f]));
// the workspace's entries as IndexedDB keeps them: rows in path order, read a page at a time (entriesPage)
const BIND = { account: "a".repeat(64), generation: 3 };
const entryOf = (p) => {
  const f = FILES[p];
  // (a local file carries `blob`: its bytes are in this browser too; FsCalls must never read them)
  return f && { path: p, kind: "file", size: f.bytes.length, sha256: f.sha, remote: f.remote, ...(f.remote ? {} : { blob: f.sha }) };
};
function workspaceOf(rows) {
  const sorted = [...rows].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const byPath = new Map(sorted.map((r) => [r.path, r]));
  const w = {
    pages: [],
    binding: BIND,
    stat: async (p) => byPath.get(p),
    entriesPage: async (after, limit) => {
      const out = sorted.filter((r) => after === null || r.path > after).slice(0, limit);
      w.pages.push(out.length);
      return out;
    },
    history: async (p) => (p === "/d/small.txt" ? [{ sha256: OLD.sha, size: OLD.bytes.length }] : []),
    syncBinding: async () => w.binding,
  };
  return w;
}
const ROWS = [{ path: "/", kind: "folder" }, { path: "/d", kind: "folder" }, { path: "/d-x", kind: "folder" }, { path: "/d/sub", kind: "folder" }, { path: "/d/sub/deep.txt", kind: "file", size: 1, sha256: "7".repeat(64) }, { path: "/Trash", kind: "folder" }, { path: "/Trash/gone.txt", kind: "file", size: 1, sha256: "8".repeat(64) }, ...Object.keys(FILES).map(entryOf)];
const workspace = workspaceOf(ROWS);

// the blob route and the files Worker: `mode` shapes the next responses
const net = { log: [], mode: null, signedUrl: null, bindings: [], server: { ...BIND }, delay: null };
function byteStream(parts, error = false) {
  return new ReadableStream({
    type: "bytes",
    start(c) {
      for (const p of parts) c.enqueue(p);
      if (error) c.error(new Error("connection reset"));
      else c.close();
    },
  });
}
async function fetchImpl(url, init) {
  net.log.push(String(url));
  // (the blob route checks the binding the request carries against this session's account and generation)
  if (/\/api\/sync\/v1\/blob\//.test(url)) {
    net.bindings.push([init.headers["x-sync-account"], init.headers["x-sync-generation"]]);
    if (init.headers["x-sync-account"] !== net.server.account) return new Response("another account", { status: 403 });
    if (init.headers["x-sync-generation"] !== String(net.server.generation)) return new Response("stale generation", { status: 409 });
  }
  const m = String(url).match(/\/api\/sync\/v1\/blob\/([0-9a-f]{64})$/) ?? String(url).match(/signed\/([0-9a-f]{64})/);
  const f = m && BYSHA.get(m[1]);
  if (!f || f.notUploaded) return new Response("not found", { status: 404 });
  const [, a, b] = init.headers.range.match(/^bytes=(\d+)-(\d+)$/).map(Number);
  const size = f.bytes.length, body = f.bytes.slice(a, b + 1);
  if (net.delay) await net.delay;
  const mode = typeof net.mode === "function" ? net.mode() : net.mode;
  const headers = { "content-range": `bytes ${a}-${b}/${size}`, "content-length": String(body.length) };
  let res;
  if (mode === "200") res = new Response(f.bytes, { status: 200 });
  else if (mode === "range") res = new Response(body, { status: 206, headers: { ...headers, "content-range": `bytes ${a + 1}-${b + 1}/${size}` } });
  else if (mode === "length") res = new Response(body, { status: 206, headers: { ...headers, "content-length": String(body.length + 1) } });
  else if (mode === "trailing") res = new Response(byteStream([body, new Uint8Array([7])]), { status: 206, headers: { "content-range": headers["content-range"] } });
  else if (mode === "short") res = new Response(byteStream([body.subarray(0, body.length - 1)]), { status: 206, headers: { "content-range": headers["content-range"] } });
  else if (mode === "reset") {
    // (the connection drops while a read is pending: the read owns its buffer and settles without giving it back)
    let n = 0;
    const st = new ReadableStream({ type: "bytes", async pull(c) {
      if (n++ === 0) return c.enqueue(body.subarray(0, 10));
      await tick(1);
      c.error(new Error("connection reset"));
    } });
    res = new Response(st, { status: 206, headers: { "content-range": headers["content-range"] } });
  }
  else res = new Response(body, { status: 206, headers });
  if (net.signedUrl && /\/api\/sync\/v1\/blob\//.test(url)) Object.defineProperty(res, "url", { value: `https://files.example/signed/${f.sha}?exp=1` });
  return res;
}

// a fake worker: posts {sbFs}, then takes each piece and acknowledges it, as web/worker.ts does
let gen = 1;
function worker(fs, own) {
  const w = { tag: Math.random().toString(36).slice(2, 10), n: 0, buffer: new SharedArrayBuffer(SB.FS_BUFFER_BYTES) };
  fs.attach(w, own);
  w.ask = async (op, params, { stopAfter = Infinity, key, active = () => true } = {}) => {
    const call = ++w.n;
    new Int32Array(w.buffer, 0, 5)[0] = 0;
    fs.admit({ id: 1, sbFs: { op, params, key: key ?? `${w.tag}.${call}` }, buffer: w.buffer }, w, gen, active);
    const pieces = [];
    for (let seq = 1, spins = 0; ; spins++) {
      if (spins > 20000) return { timeout: true, pieces };
      const ctl = new Int32Array(w.buffer, 0, 5);
      if (Atomics.load(ctl, 0) !== 1 || Atomics.load(ctl, 4) !== call || Atomics.load(ctl, 2) !== seq) {
        await tick(0);
        continue;
      }
      const bytes = new Uint8Array(w.buffer, SB.FS_HEADER, Atomics.load(ctl, 1)).slice();
      if (seq === 1) {
        const h = SB.readHeader(bytes);
        pieces.push(h);
      } else pieces.push(bytes);
      if (seq > stopAfter) return { stopped: true, pieces };
      SB.releasePiece(w.buffer);
      fs.ack({ sbFsAck: { key: `${w.tag}.${call}`, seq } }, w);
      const h = pieces[0];
      const want = h.ok?.length ?? 0;
      const got = pieces.slice(1).reduce((s, p) => s + p.length, 0);
      if ("error" in h || !("length" in (h.ok ?? {})) || got >= want) return { header: h, data: concat(pieces.slice(1)) };
      seq++;
      spins = 0;
    }
  };
  return w;
}
const concat = (ps) => {
  const out = new Uint8Array(ps.reduce((s, p) => s + p.length, 0));
  let k = 0;
  for (const p of ps) out.set(p, (k += p.length) - p.length);
  return out;
};
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const pinsHeld = (fs) => fs.pins.reduce((s, x) => s + x, 0);

// ------------------------------------------------------------ rows

const fs = new FsCalls({ workspace, fetchImpl });
const K = worker(fs, () => OWN);

{
  const st = await K.ask("fs.stat", { ws: null, path: "/d/small.txt" });
  ok(st.header.ok.type === "file" && st.header.ok.size === 17 && st.header.ok.version === "1".repeat(64), "fs.stat: a file's size and version from the page's own index");
  const r = await K.ask("fs.read", { ws: null, path: "/d/small.txt", version: "1".repeat(64), offset: 7, length: 9 });
  ok(new TextDecoder().decode(r.data) === "workspace", "fs.read: exactly the range asked for");
  const own = await K.ask("fs.read", { ws: OWN, path: "/d/small.txt", version: "1".repeat(64), offset: 0, length: 5 });
  ok(new TextDecoder().decode(own.data) === "hello", "the kernel's own workspace by its id reads the same");
}

{
  // SEC C2: another workspace is refused before any lookup, the same for a file that exists and one that doesn't
  const opens = fs.stats.indexOpens, fetches = net.log.length;
  const a = await K.ask("fs.stat", { ws: OTHER, path: "/d/small.txt" });
  const b = await K.ask("fs.stat", { ws: OTHER, path: "/d/missing" });
  const c = await K.ask("fs.list", { ws: OTHER, path: "/d" });
  const d = await K.ask("fs.read", { ws: OTHER, path: "/d/small.txt", version: "1".repeat(64), offset: 0, length: 1 });
  const msgs = [a, b, c, d].map((x) => JSON.stringify(x.header));
  ok(msgs.every((m) => m === msgs[0]) && a.header.error.code === "permission", "C2: one PermissionError for another workspace, whether or not the path exists");
  ok(fs.stats.indexOpens === opens && net.log.length === fetches, "C2: no index opened and nothing fetched for it");
  ok(fs.log.some((e) => e.code === "permission") && fs.log.every((e) => !("path" in e)), "C2: refusals in the device-only log, without paths");
}

{
  // SEC C1: the scope is the channel's: a second kernel with another own workspace, and a message naming a session
  const fs2 = new FsCalls({ workspace, fetchImpl });
  const KP = worker(fs2, OWN), KS = worker(fs2, OTHER);
  const fromS = await KS.ask("fs.stat", { ws: OWN, path: "/d/small.txt" });
  const fromP = await KP.ask("fs.stat", { ws: OWN, path: "/d/small.txt" });
  ok(fromS.header.error?.code === "permission" && fromP.header.ok?.type === "file", "C1: K_S can't read K_P's workspace; K_P can");
  const tagged = await KS.ask("fs.stat", { ws: OWN, path: "/d/small.txt", session: "K_P" });
  ok(tagged.header.error?.code === "invalid", "C1: a message naming a session is refused by admission");
  const stranger = { buffer: new SharedArrayBuffer(SB.FS_BUFFER_BYTES) };
  fs2.admit({ id: 1, sbFs: { op: "fs.stat", params: { ws: null, path: "/d/small.txt" }, key: "abc.1" }, buffer: stranger.buffer }, stranger, gen, () => true);
  await tick(5);
  ok(new Int32Array(stranger.buffer, 0, 1)[0] === 0, "C1: a worker this page didn't record is never answered");
}

{
  // SEC C3: cursors are the session's, for one workspace and folder
  const many = Object.fromEntries(Array.from({ length: 2500 }, (_, i) => [`/m/f${String(i).padStart(4, "0")}`, { path: `/m/f${String(i).padStart(4, "0")}`, kind: "file", size: i, sha256: "5".repeat(64) }]));
  // (/m holds 2500 files, and each has a subfolder of 3 more: rows a listing of /m must skip, never return)
  const nested = Object.keys(many).flatMap((p, i) => (i % 500 === 0 ? [{ path: p + "x", kind: "folder" }, ...[1, 2, 3].map((k) => ({ path: `${p}x/n${k}`, kind: "file", size: 1, sha256: "6".repeat(64) }))] : []));
  const wsMany = workspaceOf([...ROWS, { path: "/m", kind: "folder" }, ...Object.values(many), ...nested]);
  const fs3 = new FsCalls({ workspace: wsMany, fetchImpl });
  const A = worker(fs3, OWN), B = worker(fs3, OWN);
  const p1 = await A.ask("fs.list", { ws: null, path: "/m" });
  ok(p1.header.ok.entries.length === 1000 && typeof p1.header.ok.cursor === "string", "fs.list: a page of at most 1000 entries and a cursor");
  const replay = await B.ask("fs.list", { ws: null, path: "/m", cursor: p1.header.ok.cursor });
  ok(replay.header.error?.code === "invalid", "C3: another session's cursor is refused");
  const wrong = await A.ask("fs.list", { ws: null, path: "/d", cursor: p1.header.ok.cursor });
  ok(wrong.header.error?.code === "invalid", "C3: a cursor for another folder is refused");
  const p2 = await A.ask("fs.list", { ws: null, path: "/m", cursor: p1.header.ok.cursor });
  const p3 = await A.ask("fs.list", { ws: null, path: "/m", cursor: p2.header.ok.cursor });
  const names = [...p1.header.ok.entries, ...p2.header.ok.entries, ...p3.header.ok.entries].map((e) => e.name);
  ok(names.length === 2505 && !("cursor" in p3.header.ok) && names.at(-1) === "f2499" && names.includes("f0000x") && !names.some((n) => n.includes("/")), "fs.list: the pages continue in order to the end, children only (subfolders' contents skipped)");
  ok(wsMany.pages.every((n) => n <= LIST_PAGE_ROWS), `LIMITS R4: the folder is read ${LIST_PAGE_ROWS} rows at a time, never whole (${Math.max(...wsMany.pages)} at most)`);
  const root = await A.ask("fs.list", { ws: null, path: "/" });
  const rootNames = root.header.ok.entries.map((e) => e.name);
  ok(rootNames.includes("d") && rootNames.includes("d-x") && rootNames.includes("m") && !rootNames.includes("Trash"), "fs.list /: the root's children, Trash left out");
  const d = await A.ask("fs.list", { ws: null, path: "/d" });
  ok(d.header.ok.entries.map((e) => e.name).join() === "big.bin,local.bin,small.txt,sub", "fs.list /d: its own children only, not /d-x's");
}

{
  // the P0 ruling: R2 only
  const before = net.log.length;
  const r = await K.ask("fs.read", { ws: null, path: "/d/local.bin", version: "3".repeat(64), offset: 0, length: 10 });
  ok(r.header.error?.code === "unavailable" && r.header.error.message === "/d/local.bin: its current bytes are only in this browser, not uploaded yet; read it with open('/d/local.bin') or wait for sync", "a file only in this browser is refused with the ruling's text, no fallback");
  ok(net.log.length === before + 1, "...after one ask of the blob route (its 404), nothing else");
  const s = await K.ask("fs.read", { ws: null, path: "/d/small.txt", version: "1".repeat(64), offset: 0, length: 17 });
  ok(same(s.data, FILES["/d/small.txt"].bytes) && net.log.slice(before).length >= 1, "a synced file that is also local is read from R2 (the fake workspace has no read(): its local record is never read)");
}

{
  // versions: the page's own history
  const v = await K.ask("fs.read", { ws: null, path: "/d/small.txt", version: OLD.sha, offset: 0, length: 100 });
  ok(new TextDecoder().decode(v.data) === "earlier\n", "?v=: an earlier version from the page's history");
  const nv = await K.ask("fs.stat", { ws: null, path: "/d/small.txt", version: "6".repeat(64) });
  ok(nv.header.error?.code === "not_found" && nv.header.error.message.endsWith("that version isn't in this workspace's history"), "?v=: a version not in the history is not found");
}

{
  // a read across runs and chunks; then the same range from the cache
  const f = FILES["/d/big.bin"];
  const off = CHUNK - 50, len = RUN_CHUNKS * CHUNK + 100;
  const before = net.log.length;
  const r = await K.ask("fs.read", { ws: null, path: "/d/big.bin", version: f.sha, offset: off, length: len });
  ok(r.header.ok.length === len && same(r.data, f.bytes.subarray(off, off + len)), "a read across 18 chunks and two runs: exactly the bytes");
  const fetched = net.log.length - before;
  ok(fetched === 2, `two runs, two fetches (${fetched})`);
  const again = await K.ask("fs.read", { ws: null, path: "/d/big.bin", version: f.sha, offset: off, length: len });
  ok(same(again.data, r.data) && net.log.length === before + fetched, "the same range again: from the cache, nothing fetched");
  ok(pinsHeld(fs) === 0, "no slot left pinned after the calls");
  const end = await K.ask("fs.read", { ws: null, path: "/d/big.bin", version: f.sha, offset: f.bytes.length, length: 10 });
  const zero = await K.ask("fs.read", { ws: null, path: "/d/big.bin", version: f.sha, offset: 3, length: 0 });
  ok(end.header.ok.length === 0 && zero.header.ok.length === 0 && net.log.length === before + fetched, "end of file and a zero length: no bytes, nothing fetched");
}

{
  // LIMITS H3 / r3.1 §A.2: the exact-length rule; nothing from a bad response is cached
  const f = FILES["/d/small.txt"];
  const fresh = () => new FsCalls({ workspace, fetchImpl });
  for (const [mode, what] of [["200", "a 200 for a range"], ["range", "another Content-Range"], ["length", "a wrong Content-Length"], ["trailing", "a body with a trailing byte (no Content-Length)"], ["short", "a short body"]]) {
    const fsx = fresh(), W = worker(fsx, OWN);
    net.mode = mode;
    const r = await W.ask("fs.read", { ws: null, path: "/d/small.txt", version: f.sha, offset: 0, length: 17 });
    net.mode = null;
    ok(r.header.error?.code === "network" && fsx.cache.size === 0, `${what}: refused, nothing cached`);
    const again = await W.ask("fs.read", { ws: null, path: "/d/small.txt", version: f.sha, offset: 0, length: 17 });
    ok(same(again.data, f.bytes), `${what}: the next read fetches again and is right`);
  }
}

{
  // LIMITS L1 / r3.2 §A.3': a body that errors loses its receive buffer; after the allowance, refused
  const fsx = new FsCalls({ workspace, fetchImpl }), W = worker(fsx, OWN);
  const f = FILES["/d/small.txt"];
  net.mode = "reset";
  let refusedAt = -1;
  for (let i = 0; i < LOSS_ALLOWANCE + 2; i++) {
    const r = await W.ask("fs.read", { ws: null, path: "/d/small.txt", version: f.sha, offset: 0, length: 17 });
    if (r.header.error?.message?.includes("lost 16 network reads") && refusedAt < 0) refusedAt = i;
  }
  net.mode = null;
  ok(fsx.lost === LOSS_ALLOWANCE && refusedAt === LOSS_ALLOWANCE, `the ${LOSS_ALLOWANCE + 1}th read after ${LOSS_ALLOWANCE} lost buffers is refused (${fsx.lost}, ${refusedAt})`);
  ok(fsx.receive.filter((b) => b !== null).length <= 2, "no more than the two receive buffers live at the end");
  const r = await W.ask("fs.read", { ws: null, path: "/d/small.txt", version: f.sha, offset: 0, length: 17 });
  ok(r.header.error?.message === "sagebrush://: this page lost 16 network reads; reload it to read sagebrush:// files again", "...and stays refused until reload");
}

{
  // an abandoned call (a Stop: the worker takes no more pieces) and a newer call from the same worker
  const fsx = new FsCalls({ workspace, fetchImpl }), W = worker(fsx, OWN);
  const f = FILES["/d/big.bin"];
  const first = await W.ask("fs.read", { ws: null, path: "/d/big.bin", version: f.sha, offset: 0, length: 4 * CHUNK }, { stopAfter: 2 });
  ok(first.stopped, "the first call stops after two pieces");
  const next = await W.ask("fs.read", { ws: null, path: "/d/big.bin", version: f.sha, offset: 10, length: 20 });
  await tick(20);
  ok(same(next.data, f.bytes.subarray(10, 30)), "the newer call is answered");
  ok(pinsHeld(fsx) === 0, "the abandoned call's pins are released");
}

{
  // P0 billing: the signed URL is reused for its lifetime
  const fsx = new FsCalls({ workspace, fetchImpl }), W = worker(fsx, OWN);
  const f = FILES["/d/big.bin"];
  net.signedUrl = true;
  const before = net.log.length;
  await W.ask("fs.read", { ws: null, path: "/d/big.bin", version: f.sha, offset: 0, length: 10 });
  await W.ask("fs.read", { ws: null, path: "/d/big.bin", version: f.sha, offset: 5 * CHUNK, length: 10 });
  net.signedUrl = null;
  const urls = net.log.slice(before);
  ok(urls.length === 2 && urls[0].includes("/api/sync/v1/blob/") && urls[1].includes("files.example/signed/"), "the second run uses the signed URL the first one got");
}

{
  // r3 §6.2: the cache goes when the page's last kernel session ends, and when the workspace closes
  const fsx = new FsCalls({ workspace, fetchImpl }), A = worker(fsx, OWN), B = worker(fsx, OWN);
  const f = FILES["/d/small.txt"];
  await A.ask("fs.read", { ws: null, path: "/d/small.txt", version: f.sha, offset: 0, length: 5 });
  fsx.detach(A);
  ok(fsx.cache.size === 1, "one session ended, another still open: the cache stays");
  fsx.detach(B);
  ok(fsx.cache.size === 0 && fsx.urls.size === 0, "the last session ended: nothing cached");
  const C = worker(fsx, OWN);
  await C.ask("fs.read", { ws: null, path: "/d/small.txt", version: f.sha, offset: 0, length: 5 });
  fsx.dropAll();
  ok(fsx.cache.size === 0, "the workspace closed: nothing cached");
  const D = worker(fsx, OWN);
  const r = await D.ask("fs.read", { ws: null, path: "/d/small.txt", version: f.sha, offset: 0, length: 5 });
  ok(new TextDecoder().decode(r.data) === "hello", "...and reads go on from R2");
}

// ------------------------------------------------------------ LIMITS R1-R4, sync-client C1

const tokensHeld = (fs) => PIN_CAPACITY - fs.pinGate.free;
const baseline = (fs) => pinsHeld(fs) === 0 && tokensHeld(fs) === 0 && fs.freeRuns.length === 2 && fs.runGate.queue.length === 0 && fs.pinGate.queue.length === 0;

{
  // R1: a cached chunk is pinned before anything is awaited: a fill can't take its slot.  The cache is full (64
  // chunks of big.bin, chunk 1 in the least recently used slot), then chunks 0 and 1 are read with chunk 0 missing.
  const fsx = new FsCalls({ workspace, fetchImpl }), W = worker(fsx, OWN);
  const f = FILES["/d/big.bin"];
  const many = { bytes: bytesOf(70 * CHUNK, 3), sha: "9".repeat(64), remote: true };
  BYSHA.set(many.sha, many);
  FILES["/d/many.bin"] = many;
  const wsx = workspaceOf([...ROWS, entryOf("/d/many.bin")]);
  const fsy = new FsCalls({ workspace: wsx, fetchImpl }), Y = worker(fsy, OWN);
  await Y.ask("fs.read", { ws: null, path: "/d/many.bin", version: many.sha, offset: CHUNK, length: 1 });
  for (let i = 2; i < 65; i++) await Y.ask("fs.read", { ws: null, path: "/d/many.bin", version: many.sha, offset: i * CHUNK, length: 1 });
  ok(fsy.cache.size === 64 && fsy.lru[0] === fsy.cache.get(`${OWN}:${many.sha}:1`), "R1 set-up: a full cache, chunk 1 the least recently used");
  const r = await Y.ask("fs.read", { ws: null, path: "/d/many.bin", version: many.sha, offset: CHUNK - 3, length: 6 });
  ok(same(r.data, many.bytes.subarray(CHUNK - 3, CHUNK + 3)), "R1: a missing chunk 0 and a cached chunk 1 in a full cache: the right bytes for both");
  ok(baseline(fsy), "R1: nothing held afterwards");
  // concurrent fills of the same chunk: one slot, both answers right
  const fsz = new FsCalls({ workspace: wsx, fetchImpl }), Z1 = worker(fsz, OWN), Z2 = worker(fsz, OWN);
  const [a1, a2] = await Promise.all([Z1.ask("fs.read", { ws: null, path: "/d/many.bin", version: many.sha, offset: 5 * CHUNK, length: 10 }), Z2.ask("fs.read", { ws: null, path: "/d/many.bin", version: many.sha, offset: 5 * CHUNK + 5, length: 10 })]);
  const slots5 = fsz.slotKey.filter((k) => k === `${OWN}:${many.sha}:5`).length;
  ok(same(a1.data, many.bytes.subarray(5 * CHUNK, 5 * CHUNK + 10)) && same(a2.data, many.bytes.subarray(5 * CHUNK + 5, 5 * CHUNK + 15)) && slots5 === 1, `R1: two calls filling the same chunk at once: one slot (${slots5}), both right`);
  ok(baseline(fsz), "R1: nothing held after the concurrent fills");
  void fsx, void W, void f;
}

{
  // R2: a call abandoned before its header (a newer call while its first fetch is still out) holds nothing after
  const fsx = new FsCalls({ workspace, fetchImpl }), W = worker(fsx, OWN);
  const f = FILES["/d/big.bin"];
  let open;
  net.delay = new Promise((r) => (open = r));
  const first = W.ask("fs.read", { ws: null, path: "/d/big.bin", version: f.sha, offset: 0, length: 4 * CHUNK });
  await tick(5);
  net.delay = null;
  const st = await W.ask("fs.stat", { ws: null, path: "/d/small.txt" });
  open();
  await tick(50);
  void first;
  ok(st.header.ok?.type === "file", "R2: the newer call is answered");
  ok(baseline(fsx) && fsx.cache.size === 4, `R2: the abandoned call's fetch drained into the cache and it holds nothing (pins ${pinsHeld(fsx)}, tokens ${tokensHeld(fsx)}, free runs ${fsx.freeRuns.length})`);
  // a cached chunk and a missing one whose response is refused: nothing held after the error
  net.mode = "200";
  const mixed = await W.ask("fs.read", { ws: null, path: "/d/big.bin", version: f.sha, offset: 3 * CHUNK, length: 2 * CHUNK });
  net.mode = null;
  ok(mixed.header.error?.code === "network" && baseline(fsx), "R2: cached + missing with a refused response: an error, nothing held");
  // a Stop the worker reports ({sbFsCancel}) ends the call here too
  const fsy = new FsCalls({ workspace, fetchImpl }), Y = worker(fsy, OWN);
  net.delay = new Promise((r) => (open = r));
  const p = Y.ask("fs.read", { ws: null, path: "/d/big.bin", version: f.sha, offset: 0, length: CHUNK });
  await tick(5);
  fsy.cancel({ sbFsCancel: { key: `${Y.tag}.1` } }, Y);
  net.delay = null;
  open();
  await tick(50);
  void p;
  ok(baseline(fsy), "R2: a call the worker cancels holds nothing once its fetch settles");
}

{
  // R2: many waiting readers: pins admitted host-wide (never more than PIN_CAPACITY), queues drained in order
  const many = FILES["/d/many.bin"];
  const wsx = workspaceOf([...ROWS, entryOf("/d/many.bin")]);
  const fsx = new FsCalls({ workspace: wsx, fetchImpl });
  let peak = 0;
  const watch = setInterval(() => (peak = Math.max(peak, pinsHeld(fsx))), 0);
  const readers = Array.from({ length: 6 }, (_, k) => worker(fsx, OWN));
  const rs = await Promise.all(readers.map((W, k) => W.ask("fs.read", { ws: null, path: "/d/many.bin", version: many.sha, offset: k * 10 * CHUNK, length: 10 * CHUNK })));
  clearInterval(watch);
  ok(rs.every((r, k) => same(r.data, many.bytes.subarray(k * 10 * CHUNK, (k + 1) * 10 * CHUNK))), "six readers of 10 chunks each at once: all right");
  ok(peak <= PIN_CAPACITY && baseline(fsx), `pins never above ${PIN_CAPACITY} (peak ${peak}), nothing held after`);
  // a queued reader that is over leaves the queue
  const fsy = new FsCalls({ workspace: wsx, fetchImpl });
  let open;
  net.delay = new Promise((r) => (open = r));
  const A = worker(fsy, OWN), B = worker(fsy, OWN), C = worker(fsy, OWN);
  const pa = A.ask("fs.read", { ws: null, path: "/d/many.bin", version: many.sha, offset: 0, length: 16 * CHUNK });
  const pb = B.ask("fs.read", { ws: null, path: "/d/many.bin", version: many.sha, offset: 20 * CHUNK, length: 16 * CHUNK });
  const pc = C.ask("fs.read", { ws: null, path: "/d/many.bin", version: many.sha, offset: 40 * CHUNK, length: 16 * CHUNK });
  await tick(10);
  const queued = fsy.pinGate.queue.length;
  fsy.detach(C);
  ok(queued === 1 && fsy.pinGate.queue.length === 0, `a reader waiting for pin capacity leaves the queue when its session ends (${queued} -> ${fsy.pinGate.queue.length})`);
  net.delay = null;
  open();
  await Promise.all([pa, pb]);
  void pc;
  await tick(20);
  ok(baseline(fsy), "...and the others finish with nothing held");
}

{
  // R3: the loss allowance is checked when a queued run starts: queued at 15 losses, it starts at 16 and is refused
  const fsx = new FsCalls({ workspace, fetchImpl }), A = worker(fsx, OWN), B = worker(fsx, OWN), C = worker(fsx, OWN);
  const f = FILES["/d/big.bin"];
  fsx.lost = LOSS_ALLOWANCE - 1;
  let open;
  net.delay = new Promise((r) => (open = r));
  const pa = A.ask("fs.read", { ws: null, path: "/d/big.bin", version: f.sha, offset: 0, length: 10 });
  const pb = B.ask("fs.read", { ws: null, path: "/d/big.bin", version: f.sha, offset: 2 * CHUNK, length: 10 });
  await tick(5);
  const before = net.log.length;
  const pc = C.ask("fs.read", { ws: null, path: "/d/big.bin", version: f.sha, offset: 4 * CHUNK, length: 10 });
  await tick(5);
  fsx.lost = LOSS_ALLOWANCE;
  net.delay = null;
  open();
  const [, , rc] = await Promise.all([pa, pb, pc]);
  ok(rc.header.error?.message === "sagebrush://: this page lost 16 network reads; reload it to read sagebrush:// files again", "R3: a run queued before the 16th loss and started after it is refused");
  ok(net.log.length - before === 0, `R3: ...without a fetch (${net.log.length - before} after it queued; the two runs ahead of it had already asked)`);
}

{
  // R4: signed URLs kept for reuse are bounded and expired ones swept
  let t = 0;
  const fsx = new FsCalls({ workspace, fetchImpl, now: () => t });
  for (let i = 0; i < URL_SLOTS + 10; i++) fsx.rememberUrl(`${OWN}:${String(i).padStart(64, "0")}`, { url: "u" + i, until: 1000, bind: "b" });
  ok(fsx.urls.size === URL_SLOTS && !fsx.urls.has(`${OWN}:${"0".repeat(64)}`), `R4: at most ${URL_SLOTS} signed URLs kept, the oldest dropped first`);
  t = 2000;
  fsx.rememberUrl(`${OWN}:${"f".repeat(64)}`, { url: "new", until: 3000, bind: "b" });
  ok(fsx.urls.size === 1, "R4: expired ones are swept when another is kept");
  // a refused first use leaves what was made for the next try (no second slab)
  const fsy = new FsCalls({ workspace, fetchImpl });
  const real = globalThis.ArrayBuffer;
  let made = 0;
  globalThis.ArrayBuffer = new Proxy(real, { construct(T, a) { if (a[0] === M.RECEIVE && made++ === 0) throw new RangeError("no room"); return new T(...a); } });
  let refused = null;
  try { fsy.firstUse(); } catch (e) { refused = e.fsCode; }
  const slab = fsy.slab;
  try { fsy.firstUse(); } finally { globalThis.ArrayBuffer = real; }
  ok(refused === "memory" && slab && fsy.slab === slab && fsy.receive.every((b) => b instanceof real), "R4: a first use refused part-way keeps its slab, and the retry makes only what's missing");
}

{
  // sync-client C1: the blob request carries the workspace's binding; another account's session or a reset sync is
  // refused with no bytes and nothing cached; sync off is refused before any request
  const wsx = workspaceOf(ROWS);
  const fsx = new FsCalls({ workspace: wsx, fetchImpl }), W = worker(fsx, OWN);
  const f = FILES["/d/small.txt"];
  net.bindings = [];
  const okr = await W.ask("fs.read", { ws: null, path: "/d/small.txt", version: f.sha, offset: 0, length: 5 });
  ok(new TextDecoder().decode(okr.data) === "hello" && net.bindings.length === 1 && net.bindings[0][0] === BIND.account && net.bindings[0][1] === "3", "C1: the blob request carries x-sync-account and x-sync-generation");
  fsx.dropAll();
  net.server = { account: "b".repeat(64), generation: 3 };
  const acct = await W.ask("fs.read", { ws: null, path: "/d/small.txt", version: f.sha, offset: 0, length: 5 });
  ok(acct.header.error?.code === "permission" && fsx.cache.size === 0, "C1: another account's session (the account object's 403): refused, no bytes, nothing cached");
  net.server = { account: BIND.account, generation: 4 };
  const gen = await W.ask("fs.read", { ws: null, path: "/d/small.txt", version: f.sha, offset: 0, length: 5 });
  ok(gen.header.error?.code === "permission" && gen.header.error.message.includes("reload the page") && fsx.cache.size === 0, "C1: a stale generation (409): refused, no bytes, nothing cached");
  net.server = { ...BIND };
  wsx.binding = null;
  const before = net.log.length;
  const off = await W.ask("fs.read", { ws: null, path: "/d/small.txt", version: f.sha, offset: 0, length: 5 });
  ok(off.header.error?.code === "unavailable" && off.header.error.message.includes("sync is off") && net.log.length === before, "C1: sync off: refused before any request");
  ok(baseline(fsx), "C1: nothing held after the refusals");
}

ok(CACHE_SLOTS === 64 && RUN_CHUNKS === 16, "the fixed settings: 64 slots, 16-chunk runs");
