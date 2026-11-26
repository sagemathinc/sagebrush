// sagebrush://'s page side (design sagebrush-fsspec r3 with r3.1-r3.3, phase P0): every {sbFs} message a kernel's
// worker sends comes here, from WorkerKernel.  Nothing in the message is trusted: it is checked again as it arrives
// (src/sbfs.ts), and the caller is the channel it came on, the Worker this page made for that kernel and recorded
// with its own workspace (attach), never anything the message says (SEC C1).
//
// Scope first (SEC C2): fs.stat, fs.list and fs.read check the workspace before anything is looked up, with one
// refusal for every other workspace, whether or not the path exists, and without opening its index.  P0 reads only
// the kernel's own workspace; a grant for another one (the kernel's Workspace access menu) comes with P0b.
//
// Resolution on every call (SEC H2): (path, version) to the file's SHA-256 and size, from this page's own index of
// the workspace (Workspace.stat, its history for an earlier version); Python never names an address or a header.
//
// Reads come only from R2, by Range (the P0 ruling): a file whose current bytes are only in this browser, not
// uploaded yet, is refused, with no fallback and no read of the local record.  P0's blobs are unsealed: a chunk is
// plain bytes at i * CHUNK.
//
// Memory (r3 §6.3, r3.1 §A, r3.2 §A.3'): fixed buffers made at the first read and reused: CACHE_SLOTS chunk slots,
// RUNS run areas of RUN_CHUNKS chunks, and RUNS independent RECEIVE-byte receive buffers a BYOB read fills (one read
// owns its buffer until it settles; a buffer lost to an errored or aborted body stays charged for this page's life,
// at most LOSS_ALLOWANCE of them, then network reads are refused).  An abandoned call (a Stop, a newer call from the
// same worker) never cancels its body: the run is read to its end and cached.  Runs past RUNS wait in order.
//
// Billing in P0 is today's: the blob route charges the whole blob per signed URL, and the URL is reused for its
// lifetime (URL_REUSE_MS), as sync does; nothing here claims the range-bound enforcement of P3.

import { checkRequest, readLength, writePiece, headerBytes, FS_BUFFER_BYTES, FS_PIECE, FS_LIST_ENTRIES, FS_LIST_BYTES, KIND_HEADER, KIND_DATA } from "../../src/sbfs.ts";

export const CHUNK = 1 << 20;
export const RUN_CHUNKS = 16;
export const RUNS = 2;
export const CACHE_SLOTS = 64;
export const RECEIVE = 64 << 10;
export const LOSS_ALLOWANCE = 16;
export const RUN_DEADLINE_MS = 60_000;
export const URL_REUSE_MS = 5 * 60_000 - 10_000;

const KEY = /^[a-z0-9]{1,16}\.[1-9][0-9]{0,8}$/;
const plain = (o) => o !== null && typeof o === "object" && !Array.isArray(o) && Object.getPrototypeOf(o) === Object.prototype;
const fail = (code, message) => Object.assign(new Error(message), { fsCode: code });
const OTHER_WS = "sagebrush://: this kernel may read only its own workspace; grant access in the kernel's Workspace access menu";
// (a call is over: a newer call from its worker, the session's end; a write it waits on is let go, and writes nothing)
function finish(call) {
  call.done = true;
  const go = call.waiting;
  call.waiting = null;
  if (go) go();
}
const randomId = () => [...crypto.getRandomValues(new Uint8Array(24))].map((b) => "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"[b & 63]).join("");

export class FsCalls {
  /**
   * @param {object} o
   * @param {{stat(p: string): Promise<any>, list(p: string): Promise<any[]>, history(p: string): Promise<any[]>}} o.workspace
   *   this page's workspace (web/workspace/api.ts)
   * @param {typeof fetch} [o.fetchImpl]
   * @param {() => number} [o.now]
   * @param {{deadlineMs?: number}} [o.limits]
   */
  constructor({ workspace, fetchImpl = (...a) => fetch(...a), now = () => Date.now(), deadlineMs = RUN_DEADLINE_MS }) {
    this.workspace = workspace;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.deadlineMs = deadlineMs;
    // per worker (the channel): {own, tag, high, call, cursor}
    this.sessions = new WeakMap();
    // the device-only admission log: refusals, newest last (a bounded ring; no paths)
    this.log = [];
    // chunk cache: key `${ws}:${sha}:${i}` -> slot index; slots in LRU order; pins per slot
    this.cache = new Map();
    this.slotKey = new Array(CACHE_SLOTS).fill(null);
    this.pins = new Uint8Array(CACHE_SLOTS);
    this.lru = [];
    this.slots = null; // one ArrayBuffer of CACHE_SLOTS * CHUNK, at the first read
    this.runAreas = null; // RUNS run areas of RUN_CHUNKS * CHUNK
    this.freeRuns = [];
    this.runWaiters = [];
    this.receive = []; // RUNS independent receive buffers
    this.lost = 0;
    this.urls = new Map(); // sha -> {url, until}
    this.stats = { fetches: 0, cacheHits: 0, indexOpens: 0 };
  }

  /** Record a kernel's worker and its own workspace (an id, or a function giving it: the page's workspace, which may
   * open after the kernel starts) when the page makes it: the one source of a call's scope. */
  attach(worker, own) {
    this.sessions.set(worker, { own, tag: null, high: 0, call: null, cursor: null });
  }

  /** The worker's session ends (the kernel stops, restarts or is closed): its cursor and call go with it. */
  detach(worker) {
    const s = this.sessions.get(worker);
    if (s?.call) finish(s.call);
    this.sessions.delete(worker);
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
    // (a newer call from the same worker: the earlier one is over; its run, if any, still drains into the cache)
    if (s.call) finish(s.call);
    const call = { worker: w, session: s, buffer: buf, n: count, seq: 0, done: false, waiting: null };
    s.call = call;
    const c = checkRequest(d.op, d.params);
    if ("refused" in c) return this.answer(call, active, { error: { code: "invalid", message: c.refused } }, null);
    if (!active()) return;
    this.run(c.request, s).then(
      ({ header, body }) => this.answer(call, active, header, body),
      (e) => this.answer(call, active, { error: { code: e?.fsCode ?? "unavailable", message: e?.fsCode ? e.message : "sagebrush://: the page couldn't answer" } }, null),
    );
  }

  /** {sbFsAck} from worker `w`: it took piece `seq` of its current call. */
  ack(m, w) {
    const a = m.sbFsAck, s = this.sessions.get(w);
    if (!s || !plain(a) || typeof a.key !== "string" || !Number.isInteger(a.seq)) return;
    const call = s.call;
    if (!call || call.done || a.key !== `${s.tag}.${call.n}` || a.seq !== call.seq || !call.waiting) return;
    const go = call.waiting;
    call.waiting = null;
    go();
  }

  refuse(code) {
    this.log.push({ t: this.now(), code });
    if (this.log.length > 256) this.log.shift();
  }

  async answer(call, active, header, body) {
    if (call.done || !active()) return;
    if ("error" in header && (header.error.code === "permission" || header.error.code === "invalid")) this.refuse(header.error.code);
    if (!(await this.send(call, KIND_HEADER, headerBytes(header)))) return;
    if (!body) {
      call.done = true;
      return;
    }
    try {
      for await (const piece of body(call)) {
        if (call.done) return;
        if (!(await this.send(call, KIND_DATA, piece))) return;
      }
    } finally {
      call.done = true;
    }
  }

  /** Write the call's next piece once the worker has taken the one before: false if the call is over. */
  send(call, kind, bytes) {
    if (call.done) return Promise.resolve(false);
    const seq = ++call.seq;
    const write = () => (call.done ? false : writePiece(call.buffer, call.n, seq, kind, bytes));
    if (seq === 1) return Promise.resolve(write());
    return new Promise((resolve) => {
      call.waiting = () => resolve(write());
    });
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
    if (version === undefined || version === e.sha256) return { e, sha: e.sha256, size: e.size ?? 0, current: true };
    const v = (await this.workspace.history(path)).find((x) => x.sha256 === version);
    if (!v) throw fail("not_found", `sagebrush://${path}: that version isn't in this workspace's history`);
    return { e, sha: v.sha256, size: v.size, current: false };
  }

  async run(req, s) {
    const ws = this.scope(req.params.ws, s);
    if (req.op === "fs.stat") return { header: { ok: await this.stat(req.params) }, body: null };
    if (req.op === "fs.list") return { header: { ok: await this.listPage(req.params, s, ws) }, body: null };
    const { e, sha, size } = await this.resolve(req.params.path, req.params.version);
    const n = readLength(size, req.params.offset, req.params.length);
    if (n === 0) return { header: { ok: { length: 0 } }, body: null };
    // (the first run is fetched before the header goes, so a file not uploaded yet, or a spent budget, is the
    // answer's error, not a short read)
    const first = this.chunksOf(req.params.offset, n);
    const pre = await this.ensure(ws, sha, size, first.slice(0, RUN_CHUNKS), e);
    return { header: { ok: { length: n } }, body: (call) => this.pieces(ws, sha, size, req.params.offset, n, e, pre, call) };
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

  async listPage({ path, cursor }, s, ws) {
    let position = 0;
    if (cursor !== undefined) {
      const c = s.cursor;
      // (a cursor is this session's, for this workspace and folder, while that scope holds: SEC C3)
      if (!c || c.id !== cursor || c.ws !== ws || c.path !== path) throw fail("invalid", "sagebrush://: that listing cursor isn't this listing's");
      position = c.position;
    }
    const e = await this.entry(path);
    if (!e) throw fail("not_found", `sagebrush://${path}: no such folder`);
    if (e.kind !== "folder") throw fail("invalid", `sagebrush://${path}: not a folder`);
    const all = await this.workspace.list(path);
    const entries = [];
    let bytes = 2;
    while (position < all.length && entries.length < FS_LIST_ENTRIES) {
      const x = all[position];
      const item = { name: x.path.slice(x.path.lastIndexOf("/") + 1), type: x.kind === "folder" ? "directory" : x.kind === "file" ? "file" : "other", size: x.kind === "file" ? x.size ?? 0 : 0, version: x.kind === "file" ? x.sha256 ?? null : null };
      const k = new TextEncoder().encode(JSON.stringify(item)).length + 1;
      if (entries.length && bytes + k > FS_LIST_BYTES - 128) break;
      entries.push(item);
      bytes += k;
      position++;
    }
    if (position < all.length) {
      s.cursor = { id: randomId(), ws, path, position };
      return { entries, cursor: s.cursor.id };
    }
    s.cursor = null;
    return { entries };
  }

  // ------------------------------------------------------------ chunks, runs and the cache

  chunksOf(offset, n) {
    const out = [];
    for (let i = Math.floor(offset / CHUNK); i <= Math.floor((offset + n - 1) / CHUNK); i++) out.push(i);
    return out;
  }

  firstUse() {
    if (this.slots) return;
    try {
      this.slots = new ArrayBuffer(CACHE_SLOTS * CHUNK);
      this.runAreas = [];
      for (let r = 0; r < RUNS; r++) this.runAreas.push(new Uint8Array(RUN_CHUNKS * CHUNK));
      for (let r = 0; r < RUNS; r++) this.receive.push(new ArrayBuffer(RECEIVE));
    } catch {
      this.slots = null;
      this.runAreas = null;
      this.receive = [];
      throw fail("memory", `sagebrush://: this page couldn't set aside its ${(CACHE_SLOTS + RUNS * RUN_CHUNKS) * CHUNK + RUNS * RECEIVE} bytes for reading; use the native app on a computer with more memory`);
    }
    this.freeRuns = [0, 1].slice(0, RUNS);
  }

  slotView(slot, len) {
    return new Uint8Array(this.slots, slot * CHUNK, len);
  }

  /** A free (or least recently used unpinned) slot, reserved before it is filled. */
  takeSlot() {
    for (let i = 0; i < CACHE_SLOTS; i++) if (this.slotKey[i] === null && !this.pins[i]) return i;
    for (let k = 0; k < this.lru.length; k++) {
      const i = this.lru[k];
      if (!this.pins[i]) {
        this.lru.splice(k, 1);
        this.cache.delete(this.slotKey[i]);
        this.slotKey[i] = null;
        return i;
      }
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
  }

  async takeRun() {
    if (this.freeRuns.length) return this.freeRuns.shift();
    return new Promise((resolve) => this.runWaiters.push(resolve));
  }

  giveRun(r) {
    const w = this.runWaiters.shift();
    if (w) w(r);
    else this.freeRuns.push(r);
  }

  /** The chunks in `want` cached (fetched by runs of adjacent missing chunks), each pinned; their slots, in order. */
  async ensure(ws, sha, size, want, e) {
    this.firstUse();
    const slots = new Map();
    let missing = [];
    const flush = async () => {
      if (!missing.length) return;
      const got = await this.fetchRun(ws, sha, size, missing, e);
      for (const [i, slot] of got) slots.set(i, slot);
      missing = [];
    };
    for (const i of want) {
      const key = `${ws}:${sha}:${i}`;
      const slot = this.cache.get(key);
      if (slot !== undefined) {
        await flush();
        this.stats.cacheHits++;
        this.pins[slot]++;
        this.touch(slot);
        slots.set(i, slot);
        continue;
      }
      if (missing.length && (missing[missing.length - 1] !== i - 1 || missing.length === RUN_CHUNKS)) await flush();
      missing.push(i);
    }
    await flush();
    return slots;
  }

  async *pieces(ws, sha, size, offset, n, e, pre, call) {
    const all = this.chunksOf(offset, n);
    let held = pre;
    try {
      for (let at = 0; at < all.length; at += RUN_CHUNKS) {
        const group = all.slice(at, at + RUN_CHUNKS);
        if (at > 0) held = await this.ensure(ws, sha, size, group, e);
        for (const i of group) {
          const slot = held.get(i);
          const lo = Math.max(offset, i * CHUNK), hi = Math.min(offset + n, (i + 1) * CHUNK, size);
          const piece = this.slotView(slot, CHUNK).subarray(lo - i * CHUNK, hi - i * CHUNK);
          // (a piece is at most one chunk, FS_PIECE bytes; copied into the worker's buffer as it is written)
          if (piece.length > FS_PIECE) throw fail("unavailable", "sagebrush://: a piece too large");
          if (!call.done) yield piece;
          this.pins[slot]--;
          held.delete(i);
        }
      }
    } finally {
      for (const slot of held.values()) this.pins[slot]--;
    }
  }

  // ------------------------------------------------------------ R2

  async signedUrl(sha, range, signal, e) {
    const known = this.urls.get(sha);
    if (known && known.until > this.now()) return { url: known.url, first: null };
    let r;
    try {
      r = await this.fetchImpl(`/api/sync/v1/blob/${sha}`, { credentials: "same-origin", redirect: "follow", headers: { range }, signal });
    } catch {
      throw fail("network", "sagebrush://: the server couldn't be reached");
    }
    if (r.status === 404) {
      if (!e.remote) throw fail("unavailable", `${e.path}: its current bytes are only in this browser, not uploaded yet; read it with open('${e.path}') or wait for sync`);
      throw fail("not_found", `sagebrush://${e.path}: the server doesn't have these bytes`);
    }
    if (r.status === 429) throw fail("budget", "sagebrush://: today's download allowance is used up; try again tomorrow");
    if (r.url && r.url !== "" && !r.url.endsWith(`/api/sync/v1/blob/${sha}`)) this.urls.set(sha, { url: r.url, until: this.now() + URL_REUSE_MS });
    return { url: null, first: r };
  }

  /** One run of adjacent chunks fetched into a run area, checked exactly, then copied into reserved slots. */
  async fetchRun(ws, sha, size, idx, e) {
    if (this.lost >= LOSS_ALLOWANCE) throw fail("network", "sagebrush://: this page lost 16 network reads; reload it to read sagebrush:// files again");
    const r = await this.takeRun();
    if (this.receive[r] === null) {
      this.giveRun(r);
      throw fail("network", "sagebrush://: this page lost 16 network reads; reload it to read sagebrush:// files again");
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.deadlineMs);
    try {
      const lo = idx[0] * CHUNK, hi = Math.min((idx[idx.length - 1] + 1) * CHUNK, size);
      const range = `bytes=${lo}-${hi - 1}`;
      let { url, first } = await this.signedUrl(sha, range, ctrl.signal, e);
      let res = first;
      if (!res) {
        try {
          res = await this.fetchImpl(url, { headers: { range }, signal: ctrl.signal });
        } catch {
          throw fail("network", "sagebrush://: the file server couldn't be reached");
        }
      }
      this.stats.fetches++;
      if (res.status === 403 && !first) {
        // (an expired reuse: ask for a new URL once)
        this.urls.delete(sha);
        ({ first: res } = await this.signedUrl(sha, range, ctrl.signal, e));
      }
      const area = this.runAreas[r];
      await this.readExact(res, range, lo, hi, size, area, ctrl, r);
      const out = new Map();
      for (const i of idx) {
        const slot = this.takeSlot();
        this.pins[slot]++;
        const len = Math.min(CHUNK, size - i * CHUNK);
        this.slotView(slot, len).set(area.subarray(i * CHUNK - lo, i * CHUNK - lo + len));
        const key = `${ws}:${sha}:${i}`;
        this.slotKey[slot] = key;
        this.cache.set(key, slot);
        this.touch(slot);
        out.set(i, slot);
      }
      return out;
    } finally {
      clearTimeout(timer);
      this.giveRun(r);
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
      // (a read that settled without giving its buffer back: lost, charged for this page's life, r3.2 §A.3')
      // (the count and the replacement in one synchronous step, so simultaneous failures can't pass the allowance:
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
