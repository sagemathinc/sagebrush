// The Terminal command's file channel (PR 3a (b1) design r4 §3.4, §3.5): a worker that runs one command asks the page
// about every workspace file operation and blocks until it answers.  Two SharedArrayBuffers the page makes: `control`
// (Int32 slots below) and `data` (a 1 MiB window used both ways).  A request header is a small posted message; every
// body and reply moves through the window, at most WINDOW bytes at a time, each window bound to (gen, seq, offset).
//
// The STATE machine (design r4 §3.5): every edge a compare-and-exchange from exactly its predecessor, and CLOSED-aware;
// the one exception the page's Stop, which latches CLOSED = 1 (never cleared) then stores the absorbing CANCELLED.
//
//   1 worker IDLE -> WAITING      before posting a header                      6 worker ADMITTED -> BODY  body window 0
//   2 page   WAITING -> READY     an answer: a reply window or a refusal       7 page   BODY -> ACK       a body window taken
//   3 page   WAITING -> ADMITTED  a write admitted, no body moved yet          8 worker ACK -> BODY       the next body window
//   4 worker READY -> WAITING     a reply window taken, more to come           9 page   BODY -> READY     the commit's answer
//   5 worker READY -> IDLE        the last window taken: settled, once        10 page   * -> CANCELLED    Stop (CLOSED first)
//
// A side writes the window's bytes or the metadata slots only while it owns them: the worker in ADMITTED and ACK (and
// in IDLE for a header, which carries no window), the page in WAITING and BODY; ownership is checked, CLOSED included,
// before anything is touched, and the publishing CAS follows.  The worker waits in exactly two places: for STATE to
// leave WAITING, and to leave BODY.

export const ST = { IDLE: 0, WAITING: 1, ADMITTED: 2, BODY: 3, ACK: 4, READY: 5, CANCELLED: 6 } as const;
/** The control slots (Int32). */
export const SL = { STATE: 0, CLOSED: 1, GEN: 2, SEQ: 3, STATUS: 4, OFFSET: 5, WLEN: 6, TOTAL: 7, ERRNO: 8 } as const;
export const CONTROL_BYTES = 64;
export const WINDOW = 1 << 20;
/** The protocol's cap on any one operation's total, read or write (design r4 §3.4): representable in Int32. */
export const CAP = 2 ** 31 - 1;
/** A reply's STATUS: the window holds bytes (a read), JSON (any other answer), or an error's JSON {code, message}. */
export const STATUS = { BYTES: 0, JSON: 1, ERROR: 2 } as const;
/** The largest posted header, in UTF-8 bytes, and the longest path in one. */
export const HEADER_MAX = 8192;
export const PATH_MAX = 4096;

const nat = (n: unknown, max: number) => typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= max;

/** The channel was closed (Stop, revocation, a limit): the request ends as the program's KeyboardInterrupt. */
export class Cancelled extends Error {
  readonly cancelled = true;
  constructor() {
    super("the command was stopped");
  }
}
/** The other side broke the protocol (a stale, skipped, oversized or mismatched window; a state no edge allows). */
export class ProtocolError extends Error {}
/** The page's refusal of one operation: an errno code and its words. */
export class Refused extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

export type Header = { op: string; args: Record<string, unknown>; length?: number };
export type Answer = { bytes: Uint8Array } | { json: unknown };

// ------------------------------------------------------------------ the worker's side (synchronous)

export interface WorkerChannelOptions {
  control: SharedArrayBuffer;
  data: SharedArrayBuffer;
  gen: number;
  post: (msg: unknown) => void;
  /** (tests) a deadline for one wait, in ms; the worker raises ProtocolError past it instead of hanging */
  waitMs?: number;
  /** (tests) called at named points of a request, so a test can Stop between a check and a publication */
  hook?: (point: string) => void;
}

export class WorkerChannel {
  // (the views of the page's buffers: public and readonly, so tsc 7's type-level walk sees the stores TypeScript 5.9's
  // does, test/arraybuffer-sites-parity.test.ts; the page holds the same buffers)
  readonly c: Int32Array;
  readonly d: Uint8Array;
  private seq = 0;
  constructor(private o: WorkerChannelOptions) {
    if (o.control.byteLength !== CONTROL_BYTES || o.data.byteLength !== WINDOW) throw new ProtocolError("the channel's buffers aren't the protocol's sizes");
    if (!nat(o.gen, CAP)) throw new ProtocolError("the channel's generation isn't an Int32 one");
    this.c = new Int32Array(o.control);
    this.d = new Uint8Array(o.data);
  }
  closed() {
    return Atomics.load(this.c, SL.CLOSED) !== 0;
  }
  // (a CAS of the worker's: false only by cancellation; any other failure is the page breaking the protocol)
  private cas(from: number, to: number) {
    if (this.closed()) throw new Cancelled();
    // (tests: a Stop exactly between the check and the publication)
    this.o.hook?.(`cas:${from}->${to}`);
    const was = Atomics.compareExchange(this.c, SL.STATE, from, to);
    // (the latch is authoritative: a Stop that has set CLOSED but not yet stored CANCELLED still wins, so no request
    // returns as settled once CLOSED is set)
    if (was === from) {
      if (this.closed()) throw new Cancelled();
      return;
    }
    if (was === ST.CANCELLED || this.closed()) throw new Cancelled();
    throw new ProtocolError(`the channel was in state ${was}, not ${from}`);
  }
  // (wait for STATE to leave `s`: the predicate is CLOSED == 0 && STATE == s)
  private wait(s: number): number {
    for (;;) {
      if (this.closed()) throw new Cancelled();
      const st = Atomics.load(this.c, SL.STATE);
      if (st !== s) {
        if (st === ST.CANCELLED) throw new Cancelled();
        return st;
      }
      if (Atomics.wait(this.c, SL.STATE, s, this.o.waitMs ?? Infinity) === "timed-out") throw new ProtocolError("the page didn't answer within the test's deadline");
    }
  }
  // (a window the page published: checked against what this request expects before a byte is taken)
  private window(seq: number, offset: number, total: number | null): { status: number; total: number; wlen: number } {
    const gen = Atomics.load(this.c, SL.GEN), s = Atomics.load(this.c, SL.SEQ), off = Atomics.load(this.c, SL.OFFSET);
    const wlen = Atomics.load(this.c, SL.WLEN), tot = Atomics.load(this.c, SL.TOTAL), status = Atomics.load(this.c, SL.STATUS);
    if (gen !== this.o.gen || s !== seq) throw new ProtocolError(`a window for another request (${gen}/${s}, not ${this.o.gen}/${seq})`);
    if (off !== offset) throw new ProtocolError(`a window at ${off}, not ${offset}`);
    if (!nat(wlen, WINDOW) || !nat(tot, CAP) || off + wlen > tot || (total !== null && tot !== total)) throw new ProtocolError("a window's lengths are out of bounds");
    if (status !== STATUS.BYTES && status !== STATUS.JSON && status !== STATUS.ERROR) throw new ProtocolError(`an unknown status ${status}`);
    if (wlen === 0 && off < tot) throw new ProtocolError("an empty window before the end");
    return { status, total: tot, wlen };
  }
  // (the header: checked and bounded before it is posted)
  private header(seq: number, h: Header) {
    const msg = { fsSync: { gen: this.o.gen, seq, op: h.op, args: h.args, ...(h.length === undefined ? {} : { length: h.length }) } };
    for (const k of ["path", "from", "to"]) {
      const path = (h.args as any)?.[k];
      if (typeof path === "string" && new TextEncoder().encode(path).length > PATH_MAX) throw new Refused("ENAMETOOLONG", `${path.slice(0, 80)}…: File name too long`);
    }
    if (new TextEncoder().encode(JSON.stringify(msg)).length > HEADER_MAX) throw new Refused("E2BIG", "the request is too large");
    return msg;
  }

  /**
   * One operation: its header, then (for a write: `body` given) its admission and its body in windows, then its
   * answer in windows.  `max` bounds the reply's total before anything is allocated.  Throws Cancelled, Refused or
   * ProtocolError; settles exactly once.
   */
  request(h: Header, opts: { body?: Uint8Array; max?: number } = {}): Answer {
    const seq = ++this.seq;
    const body = opts.body;
    if (body !== undefined && !nat(body.length, CAP)) throw new Refused("EFBIG", "File too large");
    const msg = this.header(seq, body === undefined ? h : { ...h, length: body.length });
    this.o.hook?.("before-header");
    this.cas(ST.IDLE, ST.WAITING); // edge 1
    this.o.post(msg);
    let st = this.wait(ST.WAITING);
    const sentBody = body !== undefined && st === ST.ADMITTED;
    if (body !== undefined && st === ST.ADMITTED) {
      // edges 6 and 8: the body, a window at a time, each published only while this side owns the window
      let off = 0;
      for (;;) {
        const n = Math.min(WINDOW, body.length - off);
        const from = off === 0 ? ST.ADMITTED : ST.ACK;
        this.o.hook?.("before-body");
        if (this.closed() || Atomics.load(this.c, SL.STATE) !== from) {
          if (this.closed() || Atomics.load(this.c, SL.STATE) === ST.CANCELLED) throw new Cancelled();
          throw new ProtocolError("the body's window isn't this side's");
        }
        this.d.set(body.subarray(off, off + n), 0);
        Atomics.store(this.c, SL.GEN, this.o.gen);
        Atomics.store(this.c, SL.SEQ, seq);
        Atomics.store(this.c, SL.OFFSET, off);
        Atomics.store(this.c, SL.WLEN, n);
        Atomics.store(this.c, SL.TOTAL, body.length);
        this.cas(from, ST.BODY);
        this.o.post({ fsMore: { gen: this.o.gen, seq, offset: off } });
        off += n;
        st = this.wait(ST.BODY);
        if (st === ST.ACK) {
          if (off >= body.length) throw new ProtocolError("an ACK after the last body window");
          continue;
        }
        if (st === ST.READY) break;
        throw new ProtocolError(`the channel went from BODY to ${st}`);
      }
    } else if (st === ST.ADMITTED) throw new ProtocolError("a write's admission for a request without a body");
    if (st !== ST.READY) throw new ProtocolError(`the channel went from WAITING to ${st}`);
    // (a write goes from WAITING to READY only to be refused: success is ADMITTED, then the body, then READY)
    if (body !== undefined && !sentBody && Atomics.load(this.c, SL.STATUS) !== STATUS.ERROR) throw new ProtocolError("a write answered as done without admitting it");
    // the answer: windows of the page's one reply, edges 4 and 5
    const first = this.window(seq, 0, null);
    const max = opts.max ?? CAP;
    if (first.status !== STATUS.ERROR && first.total > max) throw new ProtocolError(`a reply of ${first.total} bytes, past the ${max} asked for`);
    const out = new Uint8Array(first.total);
    let off = 0, w = first;
    for (;;) {
      out.set(this.d.subarray(0, w.wlen), off);
      off += w.wlen;
      if (off >= first.total) {
        this.cas(ST.READY, ST.IDLE); // edge 5: settled
        break;
      }
      this.cas(ST.READY, ST.WAITING); // edge 4
      this.o.post({ fsMore: { gen: this.o.gen, seq, offset: off } });
      if (this.wait(ST.WAITING) !== ST.READY) throw new ProtocolError("a continuation that isn't a reply window");
      w = this.window(seq, off, first.total);
      if (w.status !== first.status) throw new ProtocolError("a reply whose status changed between windows");
    }
    if (first.status === STATUS.BYTES) return { bytes: out };
    let v: any;
    try {
      v = JSON.parse(new TextDecoder().decode(out));
    } catch {
      throw new ProtocolError("a reply that isn't JSON");
    }
    if (first.status === STATUS.ERROR) throw new Refused(String(v?.code ?? "EIO"), String(v?.message ?? "the page refused"));
    return { json: v };
  }
}

// ------------------------------------------------------------------ the page's side (asynchronous)

/** What the page does with one operation: an answer (bytes or JSON), a refusal, or (a write) an admission with a commit. */
export type Handled = { bytes: Uint8Array } | { json: unknown } | { error: { code: string; message: string } } | { admit: (body: Uint8Array) => Promise<{ json: unknown } | { error: { code: string; message: string } }> };
export type Handler = (h: Header) => Promise<Handled>;

export class PageChannel {
  readonly control: SharedArrayBuffer;
  readonly data: SharedArrayBuffer;
  private c: Int32Array;
  private d: Uint8Array;
  // the request being served: its seq, and what this side expects next
  private cur: null | { seq: number; reply?: { status: number; bytes: Uint8Array; next: number }; body?: { buf: Uint8Array; next: number; commit: (b: Uint8Array) => Promise<any> }; committing?: true } = null;
  private lastSeq = 0;
  constructor(readonly gen: number, private handler: Handler, private hook?: (point: string) => void) {
    this.control = new SharedArrayBuffer(CONTROL_BYTES);
    this.data = new SharedArrayBuffer(WINDOW);
    this.c = new Int32Array(this.control);
    this.d = new Uint8Array(this.data);
  }
  closed() {
    return Atomics.load(this.c, SL.CLOSED) !== 0;
  }
  /** Stop, revocation, a limit (edge 10): CLOSED latched first, then the absorbing CANCELLED, then the notify. */
  cancel() {
    Atomics.store(this.c, SL.CLOSED, 1);
    Atomics.store(this.c, SL.STATE, ST.CANCELLED);
    Atomics.notify(this.c, SL.STATE);
    if (this.cur?.reply) this.cur.reply = undefined;
    this.cur = null;
  }
  // (a page CAS: a failure by cancellation is dropped; any other is the worker breaking the protocol)
  private cas(from: number, to: number) {
    if (this.closed()) return false;
    // (tests: a Stop exactly between the check and the publication)
    this.hook?.(`cas:${from}->${to}`);
    const was = Atomics.compareExchange(this.c, SL.STATE, from, to);
    if (was === from) {
      Atomics.notify(this.c, SL.STATE);
      return true;
    }
    if (was === ST.CANCELLED || this.closed()) return false;
    throw new ProtocolError(`the channel was in state ${was}, not ${from}`);
  }
  private owns(s: number) {
    return !this.closed() && Atomics.load(this.c, SL.STATE) === s;
  }
  // publish the reply's window at `offset` (edge 2 from WAITING), only while this side owns the window
  private publish(seq: number, r: { status: number; bytes: Uint8Array }, offset: number): boolean {
    if (!this.owns(ST.WAITING)) return false;
    const n = Math.min(WINDOW, r.bytes.length - offset);
    this.d.set(r.bytes.subarray(offset, offset + n), 0);
    Atomics.store(this.c, SL.GEN, this.gen);
    Atomics.store(this.c, SL.SEQ, seq);
    Atomics.store(this.c, SL.STATUS, r.status);
    Atomics.store(this.c, SL.OFFSET, offset);
    Atomics.store(this.c, SL.WLEN, n);
    Atomics.store(this.c, SL.TOTAL, r.bytes.length);
    return this.cas(ST.WAITING, ST.READY);
  }
  private replyOf(h: Handled): { status: number; bytes: Uint8Array } {
    const enc = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
    if ("bytes" in h) return { status: STATUS.BYTES, bytes: h.bytes };
    if ("json" in h) return { status: STATUS.JSON, bytes: enc(h.json) };
    if ("error" in h) return { status: STATUS.ERROR, bytes: enc(h.error) };
    throw new ProtocolError("an admission where an answer was expected");
  }
  /** A message from the worker: a header (fsSync) or a continuation (fsMore).  Returns when it has been served. */
  async onMessage(m: any): Promise<void> {
    if (this.closed()) return;
    if (m?.fsSync) {
      const { gen, seq, op, args, length } = m.fsSync;
      if (gen !== this.gen || !Number.isSafeInteger(seq) || seq !== this.lastSeq + 1 || typeof op !== "string" || !args || typeof args !== "object" || (length !== undefined && !nat(length, CAP))) throw new ProtocolError("a malformed request header");
      if (!this.owns(ST.WAITING)) throw new ProtocolError("a request header while the channel isn't waiting");
      this.lastSeq = seq;
      this.cur = { seq };
      const handled = await this.handler({ op, args, ...(length === undefined ? {} : { length }) });
      if (this.closed() || this.cur?.seq !== seq) return;
      if ("admit" in handled) {
        if (length === undefined) throw new ProtocolError("an admission for a request without a body");
        // edge 3: admitted, nothing moved yet
        this.cur.body = { buf: new Uint8Array(length), next: 0, commit: handled.admit };
        if (!this.owns(ST.WAITING)) return;
        Atomics.store(this.c, SL.GEN, this.gen);
        Atomics.store(this.c, SL.SEQ, seq);
        this.cas(ST.WAITING, ST.ADMITTED);
        return;
      }
      this.cur.reply = { ...this.replyOf(handled), next: 0 };
      if (this.publish(seq, this.cur.reply, 0)) this.advance(this.cur, Math.min(WINDOW, this.cur.reply.bytes.length));
      return;
    }
    if (m?.fsMore) {
      const { gen, seq, offset } = m.fsMore;
      const cur = this.cur;
      if (gen !== this.gen || !cur || seq !== cur.seq || !Number.isSafeInteger(offset)) throw new ProtocolError("a continuation for another request");
      // (the body's last window is taken and its commit runs: anything more for this request is refused, so the commit
      // runs exactly once, a zero-length body's too)
      if (cur.committing) throw new ProtocolError("a continuation while the write is committed");
      if (cur.body) {
        // edges 7 and 9: a body window, taken only while this side owns it, at exactly the next offset
        if (!this.owns(ST.BODY)) return;
        const off = Atomics.load(this.c, SL.OFFSET), n = Atomics.load(this.c, SL.WLEN), tot = Atomics.load(this.c, SL.TOTAL);
        if (Atomics.load(this.c, SL.SEQ) !== seq || off !== offset || off !== cur.body.next || tot !== cur.body.buf.length || !nat(n, WINDOW) || off + n > tot || (n === 0 && off < tot)) throw new ProtocolError("a body window out of order or out of bounds");
        cur.body.buf.set(this.d.subarray(0, n), off);
        cur.body.next = off + n;
        if (cur.body.next < tot) {
          this.cas(ST.BODY, ST.ACK);
          return;
        }
        this.hook?.("before-commit");
        // the commit: the page re-checks the live run at its locked commit; CLOSED here means nothing is committed.
        // The body is this request's no longer before the commit is awaited (exactly once)
        if (this.closed()) return;
        const body = cur.body;
        cur.body = undefined;
        cur.committing = true;
        const r = await body.commit(body.buf);
        cur.committing = undefined;
        if (this.closed() || this.cur !== cur) return;
        cur.reply = { ...this.replyOf(r), next: 0 };
        // edge 9: BODY -> READY with the commit's answer (the window is this side's in BODY)
        if (!this.owns(ST.BODY)) return;
        const bytes = cur.reply.bytes;
        const w = Math.min(WINDOW, bytes.length);
        this.d.set(bytes.subarray(0, w), 0);
        Atomics.store(this.c, SL.GEN, this.gen);
        Atomics.store(this.c, SL.SEQ, seq);
        Atomics.store(this.c, SL.STATUS, cur.reply.status);
        Atomics.store(this.c, SL.OFFSET, 0);
        Atomics.store(this.c, SL.WLEN, w);
        Atomics.store(this.c, SL.TOTAL, bytes.length);
        if (this.cas(ST.BODY, ST.READY)) this.advance(cur, w);
        return;
      }
      // a reply's next window (edge 2 again, from the WAITING edge 4 made): exactly the next offset, never re-read
      if (!cur.reply || offset !== cur.reply.next) throw new ProtocolError("a continuation out of order");
      if (this.publish(seq, cur.reply, offset)) this.advance(cur, Math.min(cur.reply.bytes.length, offset + WINDOW));
    }
  }
  // (the next offset expected; the one retained reply released once its last window is published)
  private advance(cur: NonNullable<PageChannel["cur"]>, next: number) {
    if (!cur.reply) return;
    cur.reply.next = next;
    if (next >= cur.reply.bytes.length) cur.reply = undefined;
  }
  /** (tests) whether a reply is still retained, and its size */
  retained(): number {
    return this.cur?.reply?.bytes.length ?? 0;
  }
}
