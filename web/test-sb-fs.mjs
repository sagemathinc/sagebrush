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
const { FsCalls, CHUNK, RUN_CHUNKS, CACHE_SLOTS, LOSS_ALLOWANCE } = M;

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
const workspace = {
  stat: async (p) => {
    if (p === "/d" || p === "/") return { path: p, kind: "folder" };
    const f = FILES[p];
    // (a local file carries `blob`: its bytes are in this browser too; FsCalls must never read them)
    return f && { path: p, kind: "file", size: f.bytes.length, sha256: f.sha, remote: f.remote, ...(f.remote ? {} : { blob: f.sha }) };
  },
  list: async (p) => (p === "/d" ? Object.keys(FILES).map((path) => ({ path, kind: "file", size: FILES[path].bytes.length, sha256: FILES[path].sha })) : []),
  history: async (p) => (p === "/d/small.txt" ? [{ sha256: OLD.sha, size: OLD.bytes.length }] : []),
};

// the blob route and the files Worker: `mode` shapes the next responses
const net = { log: [], mode: null, signedUrl: null };
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
  const m = String(url).match(/\/api\/sync\/v1\/blob\/([0-9a-f]{64})$/) ?? String(url).match(/signed\/([0-9a-f]{64})/);
  const f = m && BYSHA.get(m[1]);
  if (!f || f.notUploaded) return new Response("not found", { status: 404 });
  const [, a, b] = init.headers.range.match(/^bytes=(\d+)-(\d+)$/).map(Number);
  const size = f.bytes.length, body = f.bytes.slice(a, b + 1);
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
  const wsMany = { ...workspace, stat: async (p) => (p === "/m" ? { path: p, kind: "folder" } : workspace.stat(p)), list: async (p) => (p === "/m" ? Object.values(many) : workspace.list(p)) };
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
  ok(p2.header.ok.entries.length === 1000 && p3.header.ok.entries.length === 500 && !("cursor" in p3.header.ok) && p3.header.ok.entries.at(-1).name === "f2499", "fs.list: the pages continue in order to the end");
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

ok(CACHE_SLOTS === 64 && RUN_CHUNKS === 16, "the fixed settings: 64 slots, 16-chunk runs");
