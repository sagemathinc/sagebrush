// sagebrush://'s page side (design sagebrush-fsspec r3 with r3.1-r3.3, phase P0): every {sbFs} message a kernel's
// worker sends comes here, from WorkerKernel.  Nothing in the message is trusted: it is checked again as it arrives
// (src/sbfs.ts), and the caller is the channel it came on, the Worker this page made for that kernel and recorded
// with its own workspace (attach), never anything the message says (SEC C1).
//
// Scope first (SEC C2): fs.stat, fs.list and fs.read check the workspace before anything is looked up, with one
// refusal for every other workspace, whether or not the path exists, and without opening its index.  P0 reads only
// the kernel's own workspace; a grant for another one (the kernel's Workspace access menu) comes next.
//
// Resolution on every call (SEC H2): (path, version) to the file's SHA-256 and size, from this page's own index of
// the workspace (Workspace.stat, its history for an earlier version); Python never names an address or a header.
//
// Reads come only from R2, by Range (the P0 ruling): a file whose current bytes are only in this browser, not
// uploaded yet, is refused, with no fallback and no read of the local record.  P0's blobs are unsealed: a chunk is
// plain bytes at i * CHUNK, and the blob's address is its bytes' SHA-256 (under E2E it is the index entry's keyed
// address, never the plaintext SHA: P1).  Each blob request carries the workspace's sync binding (x-sync-account,
// x-sync-generation), as the sync client's do, so another account's session or a reset sync is refused, never
// answered from the wrong account.
//
// Memory (r3 §6.3, r3.1 §A, r3.2 §A.3'): one slab made at the first read and reused (CACHE_SLOTS chunk slots and
// RUNS run areas of RUN_CHUNKS chunks), and RUNS independent RECEIVE-byte receive buffers a BYOB read fills (one
// read owns its buffer until it settles; a buffer lost to an errored or aborted body stays charged for this page's
// life, at most LOSS_ALLOWANCE of them, then network reads are refused).  Every call has one owner record: the
// slots it pins, the pin capacity and run areas it holds or waits for; all of it is released exactly once when the
// call ends, however it ends.  Pins are admitted host-wide (PIN_CAPACITY chunks, half the slots, so a fill always
// finds a victim); runs past RUNS and pins past the capacity wait in order, and a call that is over leaves the
// queues at once.  An abandoned call never cancels a body already being read: the run is read to its end and
// cached.
//
// Listing is bounded too: the folder's rows are read LIST_PAGE_ROWS at a time from the workspace's entries
// (Workspace.entriesPage), never the whole folder, and each page is encoded through a fixed scratch into a fixed
// page buffer, one page at a time host-wide.
//
// Billing in P0 is today's: the blob route charges the whole blob per signed URL, and the URL is reused for its
// lifetime (URL_REUSE_MS), as sync does; nothing here claims the range-bound enforcement of P3.

import { checkRequest, readLength, writePiece, headerBytes, FS_BUFFER_BYTES, FS_PIECE, FS_LIST_ENTRIES, FS_LIST_BYTES, KIND_HEADER, KIND_DATA } from "../../src/sbfs.ts";

export const CHUNK = 1 << 20;
export const RUN_CHUNKS = 16;
export const RUNS = 2;
export const CACHE_SLOTS = 64;
export const PIN_CAPACITY = 2 * RUN_CHUNKS;
export const RECEIVE = 64 << 10;
export const LOSS_ALLOWANCE = 16;
export const RUN_DEADLINE_MS = 60_000;
export const URL_REUSE_MS = 5 * 60_000 - 10_000;
export const URL_SLOTS = 64;
export const LIST_PAGE_ROWS = 256;
export const LIST_SCRATCH = 64 << 10;

const KEY = /^[a-z0-9]{1,16}\.[1-9][0-9]{0,8}$/;
const TRASH = "/Trash";
const plain = (o) => o !== null && typeof o === "object" && !Array.isArray(o) && Object.getPrototypeOf(o) === Object.prototype;
const fail = (code, message) => Object.assign(new Error(message), { fsCode: code });
const OVER = () => fail("interrupted", "sagebrush://: the call is over");
const OTHER_WS = "sagebrush://: this kernel may read only its own workspace; grant access in the kernel's Workspace access menu";
const LOST = "sagebrush://: this page lost 16 network reads; reload it to read sagebrush:// files again";
const randomId = () => [...crypto.getRandomValues(new Uint8Array(24))].map((b) => "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"[b & 63]).join("");

/** A counted resource handed out in order: acquire(owner, k) waits until k units are free and no earlier waiter is
 * still waiting; a waiter whose owner is over leaves the queue (its promise rejects). */
class Gate {
  constructor(n) {
    this.free = n;
    this.queue = [];
  }
  acquire(owner, k) {
    if (owner.done) return Promise.reject(OVER());
    if (!this.queue.length && this.free >= k) {
      this.free -= k;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const w = { k, resolve, reject, owner };
      this.queue.push(w);
      owner.waits.add({ gate: this, w });
    });
  }
  release(k) {
    this.free += k;
    while (this.queue.length && this.free >= this.queue[0].k) {
      const w = this.queue.shift();
      this.free -= w.k;
      for (const x of w.owner.waits) if (x.w === w) w.owner.waits.delete(x);
      w.resolve();
    }
  }
  cancel(w) {
    const i = this.queue.indexOf(w);
    if (i < 0) return;
    this.queue.splice(i, 1);
    w.reject(OVER());
    this.release(0);
  }
}

export class FsCalls {
  /**
   * @param {object} o
   * @param {{stat(p: string): Promise<any>, entriesPage(after: string | null, limit: number): Promise<any[]>, history(p: string): Promise<any[]>, syncBinding(): Promise<{account: string, generation: number} | null>}} o.workspace
   *   this page's workspace (web/workspace/api.ts)
   * @param {typeof fetch} [o.fetchImpl]
   * @param {() => number} [o.now]
   * @param {number} [o.deadlineMs]
   */
  constructor({ workspace, fetchImpl = (...a) => fetch(...a), now = () => Date.now(), deadlineMs = RUN_DEADLINE_MS }) {
    this.workspace = workspace;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.deadlineMs = deadlineMs;
    // per worker (the channel): {own, tag, high, call, cursor}
    this.sessions = new WeakMap();
    // kernel sessions recorded and not yet ended
    this.live = 0;
    // the device-only admission log: refusals, newest last (a bounded ring; no paths)
    this.log = [];
    // chunk cache: key `${ws}:${sha}:${i}` -> slot; each slot's key, its pins, and the slots in LRU order
    this.cache = new Map();
    this.slotKey = new Array(CACHE_SLOTS).fill(null);
    this.pins = new Uint8Array(CACHE_SLOTS);
    this.lru = [];
    this.slab = null; // one ArrayBuffer: CACHE_SLOTS slots, then RUNS run areas, at the first read
    this.receive = new Array(RUNS).fill(undefined); // undefined: not made yet; null: lost past the allowance
    this.freeRuns = [];
    this.runGate = new Gate(RUNS);
    this.pinGate = new Gate(PIN_CAPACITY);
    this.listGate = new Gate(1);
    this.listPageBuf = null;
    this.listScratch = null;
    this.lost = 0;
    this.urls = new Map(); // `${ws}:${sha}` -> {url, until, bind}
    this.stats = { fetches: 0, cacheHits: 0, indexOpens: 0 };
  }

  /** Record a kernel's worker and its own workspace (an id, or a function giving it: the page's workspace, which may
   * open after the kernel starts) when the page makes it: the one source of a call's scope. */
  attach(worker, own) {
    this.sessions.set(worker, { own, tag: null, high: 0, call: null, cursor: null });
    this.live++;
  }

  /** The worker's session ends (the kernel stops, restarts or is closed): its call and cursor go with it. */
  detach(worker) {
    const s = this.sessions.get(worker);
    if (!s) return;
    if (s.call) this.finish(s.call);
    this.sessions.delete(worker);
    // (the page's last kernel session gone: its cached plaintext goes with it, r3 §6.2)
    if (--this.live === 0) this.dropAll();
  }

  /** A call is over (a newer call from its worker, a Stop the worker reports, the session's end): it leaves every
   * queue, and a write it waits on is let go; what it holds is released where its work ends (serve). */
  finish(call) {
    if (call.done) return;
    call.done = true;
    for (const { gate, w } of [...call.waits]) gate.cancel(w);
    call.waits.clear();
    const go = call.waiting;
    call.waiting = null;
    if (go) go();
  }

  /** A {sbFs} message `m` from worker `w`; `active()` says whether it may still be answered. */
  admit(m, w, gen, active) {
    const d = m.sbFs, buf = m.buffer;
    if (!(typeof SharedArrayBuffer === "function" && buf instanceof SharedArrayBuffer) || buf.byteLength !== FS_BUFFER_BYTES) return;
    if (!Number.isInteger(m.id) || !plain(d) || Object.keys(d).length !== 3 || typeof d.key !== "string" || !KEY.test(d.key)) return;
    const s = this.sessions.get(w);
    if (!s) return;
    const tag = d.key.slice(0, d.key.indexOf(".")), count = Number(d.key.slice(d.key.indexOf(".") + 1));
    // (another tag, or a count not above the highest: never this worker's next call, never answered)
    if (s.tag !== null && (s.tag !== tag || count <= s.high)) return;
    s.tag = tag;
    s.high = count;
    // (a newer call from the same worker: the earlier one is over; a body it was reading still drains into the cache)
    if (s.call) this.finish(s.call);
    const call = { session: s, buffer: buf, n: count, seq: 0, acked: 0, done: false, waiting: null, waits: new Set(), held: new Map(), tokens: 0 };
    s.call = call;
    this.serve(call, d, active);
  }

  /** {sbFsAck} from worker `w`: it took piece `seq` of its current call. */
  ack(m, w) {
    const a = m.sbFsAck, s = this.sessions.get(w);
    if (!s || !plain(a) || typeof a.key !== "string" || !Number.isInteger(a.seq)) return;
    const call = s.call;
    // (the piece the page wrote last, taken: the next may be written, now or when it is ready)
    if (!call || call.done || a.key !== `${s.tag}.${call.n}` || a.seq !== call.seq || a.seq <= call.acked) return;
    call.acked = a.seq;
    const go = call.waiting;
    call.waiting = null;
    if (go) go();
  }

  /** {sbFsCancel} from worker `w`: its current call ended there (a Stop, a timeout). */
  cancel(m, w) {
    const a = m.sbFsCancel, s = this.sessions.get(w);
    if (!s || !plain(a) || typeof a.key !== "string" || !s.call || a.key !== `${s.tag}.${s.call.n}`) return;
    this.finish(s.call);
  }

  refuse(code) {
    this.log.push({ t: this.now(), code });
    if (this.log.length > 256) this.log.shift();
  }

  // ------------------------------------------------------------ one call, start to end

  async serve(call, d, active) {
    try {
      const c = checkRequest(d.op, d.params);
      if ("refused" in c) return await this.answer(call, active, { error: { code: "invalid", message: c.refused } });
      if (!active()) return;
      const req = c.request;
      let ws;
      try {
        ws = this.scope(req.params.ws, call.session);
      } catch (e) {
        return await this.answer(call, active, this.errorOf(e));
      }
      if (req.op === "fs.list") return await this.serveList(call, active, req.params, ws);
      let header, body = null;
      try {
        if (req.op === "fs.stat") header = { ok: await this.stat(req.params) };
        else ({ header, body } = await this.read(call, req.params, ws));
      } catch (e) {
        return await this.answer(call, active, this.errorOf(e));
      }
      if (!(await this.answer(call, active, header)) || !body) return;
      for await (const piece of body) {
        if (call.done || !(await this.send(call, KIND_DATA, piece))) return;
      }
    } catch {
      // (a call already over: nothing more is written)
    } finally {
      // (everything the call holds, released exactly once, however it ended)
      call.done = true;
      this.releaseAll(call);
      if (call.session.call === call) call.session.call = null;
    }
  }

  errorOf(e) {
    return { error: { code: e?.fsCode ?? "unavailable", message: e?.fsCode ? e.message : "sagebrush://: the page couldn't answer" } };
  }

  /** Write the header: false if the call is over. */
  async answer(call, active, header) {
    if (call.done || !active()) return false;
    if ("error" in header && (header.error.code === "permission" || header.error.code === "invalid")) this.refuse(header.error.code);
    return this.send(call, KIND_HEADER, headerBytes(header));
  }

  /** Write the call's next piece once the worker has taken the one before: false if the call is over. */
  send(call, kind, bytes) {
    if (call.done) return Promise.resolve(false);
    const seq = call.seq + 1;
    const write = () => {
      if (call.done) return false;
      call.seq = seq;
      return writePiece(call.buffer, call.n, seq, kind, bytes);
    };
    // (piece 1 at once; each later one once the worker has taken the one before it)
    if (call.acked >= seq - 1) return Promise.resolve(write());
    return new Promise((resolve) => {
      call.waiting = () => resolve(write());
    });
  }

  // ------------------------------------------------------------ what a call holds

  pin(call, slot) {
    this.pins[slot]++;
    call.held.set(slot, (call.held.get(slot) ?? 0) + 1);
  }

  unpin(call, slot) {
    const n = call.held.get(slot);
    if (!n) return;
    this.pins[slot]--;
    if (n === 1) call.held.delete(slot);
    else call.held.set(slot, n - 1);
  }

  releaseAll(call) {
    for (const [slot, n] of call.held) this.pins[slot] -= n;
    call.held.clear();
    for (const { gate, w } of [...call.waits]) gate.cancel(w);
    call.waits.clear();
    if (call.tokens) {
      const k = call.tokens;
      call.tokens = 0;
      this.pinGate.release(k);
    }
  }

  async takeTokens(call, k) {
    await this.pinGate.acquire(call, k);
    call.tokens += k;
  }

  giveTokens(call, k) {
    call.tokens -= k;
    this.pinGate.release(k);
  }

  // ------------------------------------------------------------ the operations

  /** The workspace a request may read: the session's own (P0), else the one refusal (SEC C2). */
  scope(ws, s) {
    const own = typeof s.own === "function" ? s.own() : s.own;
    if (!own) throw fail("unavailable", "sagebrush://: this page's workspace isn't open");
    if (ws === null || ws === own) return own;
    throw fail("permission", OTHER_WS);
  }

  async entry(path) {
    this.stats.indexOpens++;
    return this.workspace.stat(path);
  }

  /** (sha, size) of `path` at `version` (the current one if absent), from this page's own index. */
  async resolve(path, version) {
    const e = await this.entry(path);
    if (!e) throw fail("not_found", `sagebrush://${path}: no such file`);
    if (e.kind !== "file") throw fail("invalid", `sagebrush://${path}: not a data file`);
    if (!e.sha256) throw fail("unavailable", `sagebrush://${path}: its contents aren't known yet`);
    if (version === undefined || version === e.sha256) return { e, sha: e.sha256, size: e.size ?? 0 };
    const v = (await this.workspace.history(path)).find((x) => x.sha256 === version);
    if (!v) throw fail("not_found", `sagebrush://${path}: that version isn't in this workspace's history`);
    return { e, sha: v.sha256, size: v.size };
  }

  async stat({ path, version }) {
    const e = await this.entry(path);
    if (!e) throw fail("not_found", `sagebrush://${path}: no such file or folder`);
    const name = path === "/" ? "" : path.slice(path.lastIndexOf("/") + 1);
    if (e.kind === "folder") {
      if (version !== undefined) throw fail("not_found", `sagebrush://${path}: a folder has no versions`);
      return { name, type: "directory", size: 0, kind: "folder", mtime: e.updated ?? null };
    }
    if (e.kind !== "file") return { name, type: "other", size: 0, kind: e.kind, mtime: e.updated ?? null };
    const { sha, size } = await this.resolve(path, version);
    return { name, type: "file", size, version: sha, mtime: e.updated ?? null, kind: "blob", codec: "store.1", plaintext_length: size, compressed_length: size, chunks: Math.ceil(size / CHUNK), parts: 1 };
  }

  /** fs.read: the header once the first group is cached (so a file not uploaded yet, a refused binding or a spent
   * budget is the answer's error, not a short read), and the pieces, group by group. */
  async read(call, p, ws) {
    const { e, sha, size } = await this.resolve(p.path, p.version);
    const n = readLength(size, p.offset, p.length);
    if (n === 0) return { header: { ok: { length: 0 } }, body: null };
    const all = this.chunksOf(p.offset, n);
    const first = all.slice(0, RUN_CHUNKS);
    await this.takeTokens(call, first.length);
    const pre = await this.ensure(call, ws, sha, size, first, e);
    return { header: { ok: { length: n } }, body: this.pieces(call, ws, sha, size, p.offset, n, e, all, pre) };
  }

  async *pieces(call, ws, sha, size, offset, n, e, all, pre) {
    let held = pre;
    for (let at = 0; at < all.length; at += RUN_CHUNKS) {
      const group = all.slice(at, at + RUN_CHUNKS);
      if (at > 0) {
        await this.takeTokens(call, group.length);
        held = await this.ensure(call, ws, sha, size, group, e);
      }
      for (const i of group) {
        if (call.done) return;
        const slot = held.get(i);
        const lo = Math.max(offset, i * CHUNK), hi = Math.min(offset + n, (i + 1) * CHUNK, size);
        // (a piece is at most one chunk, FS_PIECE bytes, copied into the worker's buffer when it is written)
        const piece = this.slotView(slot, CHUNK).subarray(lo - i * CHUNK, hi - i * CHUNK);
        if (piece.length > FS_PIECE) throw fail("unavailable", "sagebrush://: a piece too large");
        yield piece;
        this.unpin(call, slot);
      }
      this.giveTokens(call, group.length);
    }
  }

  // ------------------------------------------------------------ listing, bounded

  async serveList(call, active, p, ws) {
    await this.listGate.acquire(call, 1);
    try {
      let bytes;
      try {
        bytes = await this.listPage(p, call.session, ws);
      } catch (e) {
        return await this.answer(call, active, this.errorOf(e));
      }
      if (call.done || !active()) return;
      // (the page is written into the worker's buffer at once, piece 1, before the page buffer is used again)
      await this.send(call, KIND_HEADER, bytes);
    } finally {
      this.listGate.release(1);
    }
  }

  /** One page of `path`'s entries, as the header's JSON bytes in the fixed page buffer: the folder's rows read
   * LIST_PAGE_ROWS at a time from where the cursor left off, never the whole folder. */
  async listPage({ path, cursor }, s, ws) {
    let after;
    const prefix = path === "/" ? "/" : path + "/";
    if (cursor !== undefined) {
      const c = s.cursor;
      // (a cursor is this session's, for this workspace and folder, while that scope holds: SEC C3)
      if (!c || c.id !== cursor || c.ws !== ws || c.path !== path) throw fail("invalid", "sagebrush://: that listing cursor isn't this listing's");
      after = c.after;
    } else {
      const e = await this.entry(path);
      if (!e) throw fail("not_found", `sagebrush://${path}: no such folder`);
      if (e.kind !== "folder") throw fail("invalid", `sagebrush://${path}: not a folder`);
      after = prefix;
    }
    this.listPageBuf ??= new Uint8Array(FS_LIST_BYTES);
    this.listScratch ??= new Uint8Array(LIST_SCRATCH);
    const out = this.listPageBuf, scratch = this.listScratch, enc = new TextEncoder();
    const put = (text, at) => {
      const { written } = enc.encodeInto(text, scratch);
      if (at + written > out.length) return -1;
      out.set(scratch.subarray(0, written), at);
      return at + written;
    };
    let at = put('{"ok":{"entries":[', 0), count = 0, last = after, more = false;
    const tail = 160; // room for the closing and a cursor
    const inTrash = path === TRASH || path.startsWith(TRASH + "/");
    scan: for (;;) {
      let rows;
      try {
        rows = await this.workspace.entriesPage(last, LIST_PAGE_ROWS);
      } catch (e) {
        if (e?.code === "busy") throw fail("unavailable", "sagebrush://: a large move is being applied in this workspace; try again in a moment");
        throw e;
      }
      if (!rows.length) break;
      for (const x of rows) {
        if (typeof x?.path !== "string" || !x.path.startsWith(prefix)) break scan;
        const rest = x.path.slice(prefix.length);
        const trash = x.path === TRASH || x.path.startsWith(TRASH + "/");
        if (rest === "" || rest.includes("/") || (trash && !inTrash)) {
          last = x.path;
          continue;
        }
        if (count === FS_LIST_ENTRIES) {
          more = true;
          break scan;
        }
        const item = { name: rest, type: x.kind === "folder" ? "directory" : x.kind === "file" ? "file" : "other", size: x.kind === "file" ? x.size ?? 0 : 0, version: x.kind === "file" ? x.sha256 ?? null : null };
        const next = put((count ? "," : "") + JSON.stringify(item), at);
        if (next < 0 || next > out.length - tail) {
          more = true;
          break scan;
        }
        at = next;
        count++;
        last = x.path;
      }
      if (rows.length < LIST_PAGE_ROWS) break;
    }
    if (more) {
      s.cursor = { id: randomId(), ws, path, after: last };
      at = put(`],"cursor":"${s.cursor.id}"}}`, at);
    } else {
      s.cursor = null;
      at = put("]}}", at);
    }
    return out.subarray(0, at);
  }

  // ------------------------------------------------------------ chunks, runs and the cache

  chunksOf(offset, n) {
    const out = [];
    for (let i = Math.floor(offset / CHUNK); i <= Math.floor((offset + n - 1) / CHUNK); i++) out.push(i);
    return out;
  }

  /** The slab (slots and run areas) and the receive buffers, made at the first read: a refusal leaves whatever was
   * made in place, for the next try to use, never a second copy. */
  firstUse() {
    const bytes = (CACHE_SLOTS + RUNS * RUN_CHUNKS) * CHUNK + RUNS * RECEIVE;
    try {
      if (!this.slab) {
        this.slab = new ArrayBuffer((CACHE_SLOTS + RUNS * RUN_CHUNKS) * CHUNK);
        this.freeRuns = [...Array(RUNS).keys()];
      }
      for (let r = 0; r < RUNS; r++) if (this.receive[r] === undefined) this.receive[r] = new ArrayBuffer(RECEIVE);
    } catch {
      throw fail("memory", `sagebrush://: this page couldn't set aside its ${bytes} bytes for reading; use the native app on a computer with more memory`);
    }
  }

  slotView(slot, len) {
    return new Uint8Array(this.slab, slot * CHUNK, len);
  }

  runArea(r) {
    return new Uint8Array(this.slab, (CACHE_SLOTS + r * RUN_CHUNKS) * CHUNK, RUN_CHUNKS * CHUNK);
  }

  /** A free (or the least recently used unpinned) slot for a fill; its old key dropped only if it still names it. */
  takeSlot() {
    for (let i = 0; i < CACHE_SLOTS; i++) if (this.slotKey[i] === null && !this.pins[i]) return i;
    for (let k = 0; k < this.lru.length; k++) {
      const i = this.lru[k];
      if (this.pins[i]) continue;
      this.lru.splice(k, 1);
      if (this.cache.get(this.slotKey[i]) === i) this.cache.delete(this.slotKey[i]);
      this.slotKey[i] = null;
      return i;
    }
    throw fail("unavailable", "sagebrush://: no free cache slot");
  }

  touch(slot) {
    const k = this.lru.indexOf(slot);
    if (k >= 0) this.lru.splice(k, 1);
    this.lru.push(slot);
  }

  /** Every entry of workspace `ws` dropped (membership lost, sign-out, the last session of it gone: r3 §6.2). */
  dropWorkspace(ws) {
    for (const [key, slot] of [...this.cache]) {
      if (!key.startsWith(ws + ":") || this.pins[slot]) continue;
      this.cache.delete(key);
      this.slotKey[slot] = null;
      const k = this.lru.indexOf(slot);
      if (k >= 0) this.lru.splice(k, 1);
    }
    for (const k of [...this.urls.keys()]) if (k.startsWith(ws + ":")) this.urls.delete(k);
  }

  /** Every cached chunk and signed URL dropped (the workspace closed: sign-out, a reset, another tab's takeover). */
  dropAll() {
    for (let i = 0; i < CACHE_SLOTS; i++) {
      if (this.pins[i] || this.slotKey[i] === null) continue;
      this.cache.delete(this.slotKey[i]);
      this.slotKey[i] = null;
    }
    this.lru = this.lru.filter((i) => this.slotKey[i] !== null);
    this.urls.clear();
  }

  /** The chunks in `want` cached and pinned for `call` (its pin capacity already taken for them), fetched by runs of
   * adjacent missing chunks; their slots.  A cached chunk is pinned as it is found, before anything is awaited, so
   * no fill can take its slot (LIMITS R1). */
  async ensure(call, ws, sha, size, want, e) {
    this.firstUse();
    const slots = new Map();
    const runs = [];
    for (const i of want) {
      const slot = this.cache.get(`${ws}:${sha}:${i}`);
      if (slot !== undefined) {
        this.stats.cacheHits++;
        this.pin(call, slot);
        this.touch(slot);
        slots.set(i, slot);
        continue;
      }
      const run = runs.at(-1);
      if (run && run.at(-1) === i - 1) run.push(i);
      else runs.push([i]);
    }
    for (const run of runs) {
      if (call.done) throw OVER();
      for (const [i, slot] of await this.fetchRun(call, ws, sha, size, run, e)) slots.set(i, slot);
    }
    return slots;
  }

  // ------------------------------------------------------------ R2

  async binding() {
    const b = await this.workspace.syncBinding();
    if (!b) throw fail("unavailable", "sagebrush://: sync is off for this workspace, and its files are read from the cloud copy; turn sync on");
    return b;
  }

  async signedUrl(ws, sha, range, signal, e) {
    const b = await this.binding();
    const bind = `${b.account}:${b.generation}`, key = `${ws}:${sha}`;
    const known = this.urls.get(key);
    if (known && known.until > this.now() && known.bind === bind) return { url: known.url, first: null };
    let r;
    try {
      // (P0: the blob's address is its bytes' SHA-256, unsealed; under E2E it is the index entry's keyed address)
      r = await this.fetchImpl(`/api/sync/v1/blob/${sha}`, { credentials: "same-origin", redirect: "follow", headers: { range, "x-sync-account": b.account, "x-sync-generation": String(b.generation) }, signal });
    } catch {
      throw fail("network", "sagebrush://: the server couldn't be reached");
    }
    if (r.status === 404) {
      if (!e.remote) throw fail("unavailable", `${e.path}: its current bytes are only in this browser, not uploaded yet; read it with open('${e.path}') or wait for sync`);
      throw fail("not_found", `sagebrush://${e.path}: the server doesn't have these bytes`);
    }
    if (r.status === 403 || r.status === 409) {
      r.body?.cancel().catch(() => {});
      this.urls.clear();
      throw fail("permission", "sagebrush://: sync's account or generation changed (another sign-in, or sync was reset); reload the page");
    }
    if (r.status === 429) throw fail("budget", "sagebrush://: today's download allowance is used up; try again tomorrow");
    if (r.url && !r.url.endsWith(`/api/sync/v1/blob/${sha}`)) this.rememberUrl(key, { url: r.url, until: this.now() + URL_REUSE_MS, bind });
    return { url: null, first: r };
  }

  /** A signed URL kept for reuse: expired ones swept, at most URL_SLOTS kept (the oldest goes first). */
  rememberUrl(key, v) {
    const now = this.now();
    for (const [k, x] of this.urls) if (x.until <= now) this.urls.delete(k);
    this.urls.delete(key);
    while (this.urls.size >= URL_SLOTS) this.urls.delete(this.urls.keys().next().value);
    this.urls.set(key, v);
  }

  /** One run of adjacent chunks fetched into a run area, checked exactly, then copied into slots `call` pins.  The
   * loss allowance is checked when the run starts, after any wait (LIMITS R3). */
  async fetchRun(call, ws, sha, size, idx, e) {
    if (this.lost >= LOSS_ALLOWANCE) throw fail("network", LOST);
    await this.runGate.acquire(call, 1);
    const r = this.freeRuns.shift();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.deadlineMs);
    try {
      if (this.lost >= LOSS_ALLOWANCE || this.receive[r] === null) throw fail("network", LOST);
      const lo = idx[0] * CHUNK, hi = Math.min((idx[idx.length - 1] + 1) * CHUNK, size);
      const range = `bytes=${lo}-${hi - 1}`;
      let { url, first } = await this.signedUrl(ws, sha, range, ctrl.signal, e);
      let res = first;
      if (!res) {
        try {
          res = await this.fetchImpl(url, { headers: { range }, signal: ctrl.signal });
        } catch {
          throw fail("network", "sagebrush://: the file server couldn't be reached");
        }
        if (res.status === 403) {
          // (an expired reuse: ask for a new URL once)
          res.body?.cancel().catch(() => {});
          this.urls.delete(`${ws}:${sha}`);
          ({ first: res } = await this.signedUrl(ws, sha, range, ctrl.signal, e));
        }
      }
      this.stats.fetches++;
      const area = this.runArea(r);
      await this.readExact(res, range, lo, hi, size, area, ctrl, r);
      const out = new Map();
      for (const i of idx) {
        const key = `${ws}:${sha}:${i}`;
        // (another call filled it meanwhile: that slot, pinned for this call too, never a second copy)
        let slot = this.cache.get(key);
        if (slot === undefined) {
          slot = this.takeSlot();
          const len = Math.min(CHUNK, size - i * CHUNK);
          this.slotView(slot, len).set(area.subarray(i * CHUNK - lo, i * CHUNK - lo + len));
          this.slotKey[slot] = key;
          this.cache.set(key, slot);
        }
        this.pin(call, slot);
        this.touch(slot);
        out.set(i, slot);
      }
      return out;
    } finally {
      clearTimeout(timer);
      this.freeRuns.push(r);
      this.runGate.release(1);
    }
  }

  /** The body of `res` read into `area`: exactly hi - lo bytes, a 206 with exactly that range, then a 1-byte probe
   * that must find the end (r3 §5.5, r3.1 §A.2). */
  async readExact(res, range, lo, hi, size, area, ctrl, r) {
    const E = hi - lo;
    const cancel = () => res.body?.cancel().catch(() => {});
    if (res.status !== 206 || res.headers.get("content-range") !== `bytes ${lo}-${hi - 1}/${size}`) {
      cancel();
      throw fail("network", `sagebrush://: the file server answered ${res.status} for ${range}`);
    }
    const cl = res.headers.get("content-length");
    if (cl !== null && cl !== String(E)) {
      cancel();
      throw fail("network", "sagebrush://: the file server's length doesn't match the range");
    }
    let reader;
    try {
      reader = res.body.getReader({ mode: "byob" });
    } catch {
      cancel();
      throw fail("unavailable", "sagebrush://: this browser can't read a download into a fixed buffer (no BYOB reader)");
    }
    let got = 0;
    let buf = this.receive[r];
    try {
      while (got < E) {
        const { value, done } = await reader.read(new Uint8Array(buf, 0, Math.min(RECEIVE, E - got)));
        if (!value) throw fail("network", "sagebrush://: the download ended early");
        buf = value.buffer;
        if (done) throw fail("network", "sagebrush://: the download ended early");
        area.set(value, got);
        got += value.byteLength;
      }
      const probe = await reader.read(new Uint8Array(buf, 0, 1));
      if (probe.value) buf = probe.value.buffer;
      if (!probe.done) throw fail("network", "sagebrush://: the download was longer than the range");
      this.receive[r] = buf;
    } catch (err) {
      // (a read that settled without giving its buffer back: lost, charged for this page's life, r3.2 §A.3'; the
      // count and the replacement in one synchronous step, so simultaneous failures can't pass the allowance:
      // live + lost receive buffers never exceed (RUNS + LOSS_ALLOWANCE) * RECEIVE bytes, LIMITS L1)
      if (buf.byteLength === 0) {
        this.lost++;
        this.receive[r] = this.lost < LOSS_ALLOWANCE ? new ArrayBuffer(RECEIVE) : null;
      } else this.receive[r] = buf;
      try {
        reader.releaseLock();
      } catch {}
      cancel();
      if (ctrl.signal.aborted) throw fail("timeout", "sagebrush://: the download took longer than 60 s");
      throw err?.fsCode ? err : fail("network", "sagebrush://: the download failed");
    }
  }
}
