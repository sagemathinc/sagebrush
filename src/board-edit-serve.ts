// `sagebrush board open --edit`'s requests (plan-board-open-edit r7 §6, §8.4,
// §10; addendum 2), for src/board-open.ts's server, which has already
// checked the host, the key and the origin.  Loaded only with --edit.
//
//   GET  /events?key&tab=T        the tab registers (MAX_CLIENTS); its events:
//                                 `board` {seq, persistedSeq, writtenSeq, includes, persistedGen, writtenGen,
//                                 state, changes, more}: persisted is Saved; written, at FILE but its directory
//                                 not confirmed durable (Windows), a state of its own, never Saved;
//                                 changes: the heads' reports and alternatives since the last event, each
//                                 batch bound to its head's seq (the first event: those the hub keeps);
//                                 more: some weren't sent inline (too large), or (a tab's first event)
//                                 some were dropped before it connected: GET /changes for them;
//                                 `stale` (compaction released its base: resync)
//   GET  /changes?key&tab=T&after=S   the kept batches after head S, and whether none since was dropped
//   GET  /board?key&tab=T[&at=S]  head S (default: the latest), its seq in X-Sagebrush-Seq;
//                                 at most RESP_CONCURRENCY bodies sent at once, the rest waiting (QUEUE_MAX)
//   POST /edit?key&tab&gen&base&hash   body: the snapshot, JSON lines (application/x-ndjson)
//
// A submission is answered from its URL alone where it can be (unknown tab,
// tombstone, replay, stale base) and is admitted (one in flight per tab,
// TAB_RATE, GLOBAL_RATE, the queue) before its body is read; one not
// admitted is answered busy, with Retry-After, the connection closed and the
// body never read.  The body is counted as it arrives, each byte charged to
// the ledger, and cut off at BODY_MAX + 1.
import type * as http from "http";
import { readBounded } from "./board-check";
import { EditHub, type SubmitAnswer, type HeadEvent } from "./board-edit-hub";
import { KEPT_PER_BYTE } from "./board-edit-memory";
import { Gate } from "./board-edit-gate";
import type { Limits } from "./board-edit-limits";

const TAB = /^[A-Za-z0-9_-]{16,64}$/, HEX64 = /^[0-9a-f]{64}$/, INT = /^(0|[1-9][0-9]{0,15})$/;
const EDIT_PARAMS = ["key", "tab", "gen", "base", "hash"];

/** The URL's parameters, each exactly once, all known; or null. */
function params(url: URL, names: string[], optional: string[] = []): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const [k, v] of url.searchParams) {
    if ((!names.includes(k) && !optional.includes(k)) || k in out) return null;
    out[k] = v;
  }
  return names.every((n) => n in out) ? out : null;
}
const int = (s: string | undefined) => (s !== undefined && INT.test(s) && Number(s) <= Number.MAX_SAFE_INTEGER ? Number(s) : null);

interface Stream { writableLength: number; write(s: string, cb?: (e?: unknown) => void): unknown; destroy(): unknown; end(): unknown }

/** A tab's event stream, and what of its backlog is charged on the hub's ledger (§8.2: SSE backlogs). */
interface Open { c: Stream; charged: number; open: boolean }

export class EditServer {
  readonly gate: Gate;
  private streams = new Map<string, Open>();
  private sending = 0;
  private waiting: (() => void)[] = [];
  private sent = 0; // (hub events already sent)

  constructor(readonly hub: EditHub, readonly limits: Limits, private api: Record<string, string>, private now: () => number) {
    this.gate = new Gate(limits, now);
  }

  get tabs() { return this.streams.size; }

  /** One of --edit's requests, or false if this isn't one. */
  handle(req: http.IncomingMessage, res: http.ServerResponse, url: URL): boolean {
    const json = (status: number, v: unknown, extra: Record<string, string> = {}) =>
      res.writeHead(status, { ...this.api, "Content-Type": "application/json", ...extra }).end(JSON.stringify(v));
    if (url.pathname === "/edit") {
      if (req.method === "OPTIONS") {
        // (the preflight a sandboxed page's POST with this content type needs)
        res.writeHead(204, { ...this.api, "Access-Control-Allow-Methods": "POST", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Max-Age": "600" }).end();
        return true;
      }
      if (req.method !== "POST") { res.writeHead(405, { ...this.api, Allow: "POST, OPTIONS" }).end(); return true; }
      this.edit(req, res, url, json);
      return true;
    }
    if (url.pathname === "/events" && url.searchParams.has("tab")) {
      const p = params(url, ["key", "tab"]);
      if (!p || !TAB.test(p.tab)) { json(400, { error: "bad parameters" }); return true; }
      if (this.streams.has(p.tab) || this.streams.size >= this.limits.MAX_CLIENTS) {
        json(503, { error: `at most ${this.limits.MAX_CLIENTS} tabs edit a board at once, each with its own id` });
        return true;
      }
      this.hub.connect(p.tab);
      this.streams.set(p.tab, { c: res, charged: 0, open: true });
      // (registered before anything is sent: a stream dropped by its first event is released by the one path)
      req.on("close", () => this.drop(p.tab, res));
      res.writeHead(200, { ...this.api, "Content-Type": "text/event-stream" });
      // (the first event: the reports and alternatives the hub keeps, CORR-153-4; and, if any batch was dropped
      // before this tab connected, `more`, so that it fetches /changes and is told it is incomplete, daybreak2's
      // CORR-153-R2-2)
      const kept = this.hub.changesAfter(0);
      this.send(p.tab, `retry: 2000\n\n` + this.boardEvent(p.tab, kept.changes, kept.complete));
      return true;
    }
    if (url.pathname === "/changes" && url.searchParams.has("tab")) {
      const p = params(url, ["key", "tab", "after"]);
      const after = int(p?.after);
      if (!p || !TAB.test(p.tab) || after === null) { json(400, { error: "bad parameters" }); return true; }
      const g = this.gate.read();
      if (!g.ok) { json(503, { busy: "rate" }, { "Retry-After": String(Math.ceil(g.retryMs / 1000)), Connection: "close" }); return true; }
      const c = this.hub.changesAfter(after);
      // (its body charged before it is made: the batches' own charge, KEPT_PER_BYTE per byte of their JSON,
      // bounds its bytes; released when it is sent)
      const n = Math.ceil(c.charge / KEPT_PER_BYTE) + 256;
      if (!this.hub.ledger.admit(n)) { json(503, { busy: "memory" }, { "Retry-After": "1", Connection: "close" }); return true; }
      let done = false;
      const free = () => { if (!done) { done = true; this.hub.ledger.release(n); } };
      res.on("close", free);
      let body: string;
      try { body = JSON.stringify({ seq: this.hub.H.seq, complete: c.complete, changes: c.changes }); } catch { body = JSON.stringify({ seq: this.hub.H.seq, complete: false, changes: [] }); }
      res.writeHead(200, { ...this.api, "Content-Type": "application/json" });
      res.end(body, free);
      return true;
    }
    if (url.pathname === "/board" && url.searchParams.has("tab")) {
      const p = params(url, ["key", "tab"], ["at"]);
      const at = p?.at === undefined ? this.hub.H.seq : int(p.at);
      if (!p || !TAB.test(p.tab) || at === null) { json(400, { error: "bad parameters" }); return true; }
      const g = this.gate.read();
      if (!g.ok) { json(503, { busy: "rate" }, { "Retry-After": String(Math.ceil(g.retryMs / 1000)), Connection: "close" }); return true; }
      const v = this.hub.head(at);
      if (!v) { json(410, { stale: true, seq: this.hub.H.seq }); return true; }
      if (this.sending >= this.limits.RESP_CONCURRENCY && this.waiting.length >= this.limits.QUEUE_MAX) {
        json(503, { busy: "queue" }, { "Retry-After": "1", Connection: "close" });
        return true;
      }
      const go = () => {
        this.sending++;
        this.hub.adopted(p.tab, v.seq);
        let done = false;
        const finish = () => { if (done) return; done = true; this.sending--; this.waiting.shift()?.(); };
        res.on("close", finish);
        res.writeHead(200, { ...this.api, "Content-Type": "application/json; charset=utf-8", "Content-Length": String(v.bytes.length), "X-Sagebrush-Seq": String(v.seq) });
        res.end(req.method === "HEAD" ? undefined : v.bytes, finish);
      };
      if (this.sending < this.limits.RESP_CONCURRENCY) go();
      else this.waiting.push(go);
      return true;
    }
    return false;
  }

  private edit(req: http.IncomingMessage, res: http.ServerResponse, url: URL, json: (s: number, v: unknown, e?: Record<string, string>) => unknown) {
    // (answered without reading the body: the connection closed after, so nothing of it is read)
    const early = (status: number, v: unknown, extra: Record<string, string> = {}) => json(status, v, { Connection: "close", ...extra });
    const p = params(url, EDIT_PARAMS);
    const gen = int(p?.gen), base = int(p?.base);
    if (!p || !TAB.test(p.tab) || gen === null || gen < 1 || base === null || !HEX64.test(p.hash)) return early(400, { error: "bad parameters" });
    if ((req.headers["content-type"] ?? "").split(";")[0].trim() !== "application/x-ndjson") return early(415, { error: "the body is JSON lines: application/x-ndjson" });
    const declared = req.headers["content-length"] === undefined ? null : int(String(req.headers["content-length"]));
    if (req.headers["content-length"] !== undefined && declared === null) return early(400, { error: "bad Content-Length" });
    if (declared !== null && declared > this.limits.BODY_MAX) return early(413, { error: `the body is larger than BODY_MAX (${this.limits.BODY_MAX} bytes)` });
    // (the URL alone, where it answers: unknown, tombstone, replay, stale)
    const answer = this.hub.before(p.tab, gen, base, p.hash);
    if (answer) return early(200, answer);
    const a = this.gate.edit(p.tab, declared);
    if (!a.ok) return early(503, { op: `${p.tab}:${gen}`, busy: a.busy }, { "Retry-After": String(Math.max(1, Math.ceil(a.retryMs / 1000))) });
    const ticket = a.ticket;
    const chunks: Buffer[] = [];
    let got = 0, charged = 0, over: string | null = null;
    const fail = (status: number, v: unknown) => {
      this.hub.ledger.release(charged);
      charged = 0;
      ticket.release();
      if (!res.headersSent) json(status, v, { Connection: "close" });
      req.destroy();
    };
    req.on("data", (c: Buffer) => {
      if (over) return;
      got += c.length;
      if (got > this.limits.BODY_MAX) { over = "body"; return fail(413, { error: `the body is larger than BODY_MAX (${this.limits.BODY_MAX} bytes)` }); }
      // (every byte charged as it is read)
      if (!this.hub.ledger.admit(c.length)) { over = "memory"; return fail(503, { op: `${p.tab}:${gen}`, busy: "memory" }); }
      charged += c.length;
      chunks.push(c);
    });
    req.on("error", () => { if (!over) { over = "error"; fail(400, { error: "the request failed" }); } });
    req.on("close", () => { if (!over && !req.complete) { over = "closed"; fail(400, { error: "the request was cut off" }); } });
    req.on("end", () => {
      if (over) return;
      over = "done";
      const body = Buffer.concat(chunks, got);
      chunks.length = 0;
      let r: SubmitAnswer;
      // (the hub answers every snapshot; whatever it might throw is a refusal here, never an exception out of
      // this callback, CORR-153-7)
      try { r = this.hub.submit(p.tab, gen, base, body, p.hash, charged); }
      catch { r = { op: `${p.tab}:${gen}`, refused: "the snapshot can't be taken" }; }
      finally { charged = 0; ticket.release(); }
      json(200, r);
      this.flush();
    });
  }

  /** A tab's board event: the head, what of its own it includes, and its persistedGen (§6.3, §6.5); the reports
   * and alternatives of `changes`, inline if they fit in a quarter of PENDING_MAX, else `more` (GET /changes);
   * `more` too when `complete` is false (batches before these were dropped: /changes says so). */
  private boardEvent(tab: string, changes: HeadEvent[] = [], complete = true): string {
    const v = this.hub.tabView(tab), s = this.hub.state;
    const head = { seq: this.hub.H.seq, persistedSeq: this.hub.persistedSeq, writtenSeq: this.hub.writtenSeq, includes: v.includes, persistedGen: v.persistedGen, writtenGen: v.writtenGen, state: s };
    const sent = changes.filter((c) => c.reports.length || c.alternatives.length || c.omitted);
    if (sent.length) {
      try {
        const text = `event: board\ndata: ${JSON.stringify({ ...head, changes: sent, more: !complete })}\n\n`;
        if (Buffer.byteLength(text) <= this.limits.PENDING_MAX / 4) return text;
      } catch {}
      return `event: board\ndata: ${JSON.stringify({ ...head, changes: [], more: true })}\n\n`;
    }
    return `event: board\ndata: ${JSON.stringify({ ...head, changes: [], more: !complete })}\n\n`;
  }

  /**
   * Text to a tab's stream, its bytes admitted to the ledger first and released as they leave (§8.2); a page that
   * doesn't take its events, past PENDING_MAX, or the ledger full: closed, and it resyncs when it reconnects.
   */
  private send(tab: string, text: string) {
    const s = this.streams.get(tab);
    if (!s) return;
    const n = Buffer.byteLength(text);
    if (Math.max(s.c.writableLength, s.charged) + n > this.limits.PENDING_MAX || !this.hub.ledger.admit(n)) { this.drop(tab, s.c, "destroy"); return; }
    s.charged += n;
    s.c.write(text, () => { if (s.open) { s.charged -= n; this.hub.ledger.release(n); } });
  }

  /**
   * A stream gone, however (closed by the page, dropped as slow, the server closing): the one place its tab is
   * released, its backlog's charge returned and its rate forgotten (CORR-153-6).  Once per stream: a newer
   * stream of the same tab is left alone.
   */
  private drop(tab: string, c: Stream, how?: "destroy" | "end") {
    const s = this.streams.get(tab);
    if (!s || s.c !== c) return;
    this.streams.delete(tab);
    s.open = false;
    this.hub.ledger.release(s.charged);
    s.charged = 0;
    this.hub.release(tab);
    this.gate.forget(tab);
    if (how === "destroy") c.destroy();
    else if (how === "end") c.end();
  }

  /** What the streams' backlogs hold charged on the ledger (for the tests). */
  get backlog() { let n = 0; for (const s of this.streams.values()) n += s.charged; return n; }

  /** The hub's new events and stale tabs, to every tab. */
  flush() {
    const events = this.hub.events.splice(0);
    if (events.length) for (const tab of [...this.streams.keys()]) this.send(tab, this.boardEvent(tab, events));
    for (const tab of this.hub.staleTabs) this.send(tab, `event: stale\ndata: ${JSON.stringify({ seq: this.hub.H.seq })}\n\n`);
    this.hub.staleTabs.clear();
  }

  /** A comment to every stream, through any idle timeout. */
  beat() { for (const tab of [...this.streams.keys()]) this.send(tab, ": .\n\n"); }

  close() { for (const [tab, s] of [...this.streams]) this.drop(tab, s.c, "end"); }
}

/**
 * FILE followed while editing: read when its stat changed and it has been quiet (or an outside version is
 * waiting for memory), merged into the hub; prevs read again; a save made when one is due.  One tick at a
 * time.
 */
export class EditWatch {
  private running = false;
  // (undefined: not stat'ed yet, so a FILE already gone at the first tick is seen as gone)
  private last: string | null | undefined = undefined;
  constructor(private hub: EditHub, private server: EditServer, private file: string, private fileMax: number, private quietMs: number, private stat: (p: string) => string | null) {}
  async tick(now: number) {
    if (this.running) return;
    this.running = true;
    try {
      const st = this.stat(this.file);
      if (st !== this.last || this.hub.deferred) {
        this.last = st;
        let bytes: Buffer | null = null;
        try { bytes = st === null ? null : readBounded(this.file, this.fileMax); } catch { bytes = null; }
        if (st !== null && bytes === null) this.hub.holdFile("invalid", `FILE is larger than FILE_MAX (${this.fileMax} bytes)`);
        else await this.hub.observe(bytes);
      }
      await this.hub.tickPrevs(this.quietMs);
      if (this.hub.due(now)) await this.hub.save();
      this.server.flush();
    } finally { this.running = false; }
  }
}

/**
 * --edit's start (r7 §5.4, §9): FILE writable, hard links in its directory (a probe: one linked and unlinked),
 * what an interrupted save left recovered, FILE read and checked as an editable board: the hub, or why the
 * board is shown read only instead.
 */
export async function startEdit(path: string, limits: Limits, deps: { now: () => number }): Promise<{ hub: EditHub } | { why: string }> {
  const fs = await import("fs");
  const { dirname, join } = await import("path");
  const { randomBytes } = await import("crypto");
  const { recoverAtStart } = await import("./board-edit-write");
  // (a symlink's target is what is written, §5.4)
  try { path = fs.realpathSync(path); } catch { return { why: "no such file" }; }
  try { fs.accessSync(path, fs.constants.W_OK); fs.accessSync(dirname(path), fs.constants.W_OK); } catch { return { why: "FILE (or its directory) isn't writable" }; }
  const probe = join(dirname(path), `.sagebrush-probe-${randomBytes(6).toString("hex")}`);
  try {
    fs.writeFileSync(probe, "", { flag: "wx" });
    try { fs.linkSync(probe, probe + "-link"); fs.unlinkSync(probe + "-link"); } catch { return { why: "hard links aren't supported in FILE's directory, which saving needs" }; }
  } catch { return { why: "can't write beside FILE" }; } finally { try { fs.unlinkSync(probe); } catch {} }
  const hub = new EditHub(path, limits, deps);
  const rec = recoverAtStart(path, hub.slots, true);
  if (rec.over) return { why: `more than BACKUPS_MAX (${limits.BACKUPS_MAX}) files a save left beside FILE: ${rec.leftovers.join(", ")}` };
  let bytes: Buffer | null;
  try { bytes = readBounded(path, limits.FILE_MAX); } catch (e: any) { return { why: String(e?.message ?? e) }; }
  if (bytes === null) return { why: `FILE is larger than FILE_MAX (${limits.FILE_MAX} bytes)` };
  const r = await hub.start(bytes);
  if (!r.ok) return { why: /not JSON|format/.test(r.why) ? `${r.why}; download it as .board.json and open that with --edit` : r.why };
  return { hub };
}
