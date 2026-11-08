// The terminal's one writer (plan-term-xterm r2.7 §2 and §4): every byte the panel puts into xterm goes through it, in
// order, one write of at most 64 KiB in flight, the next only after xterm's callback for the last.  Pure apart from
// the sink it is given, so it is tested directly (web/shell/test-term-writer.mjs).
//
// What it enforces before anything reaches xterm (astra TX2, daybreak3 E1-E4, daybreak4 P3):
// - combining text: a zero-width code point (xterm's own width table, or a combining or format character) passes
//   only directly after a base character in the same logical output, at most 8 after each base; any control,
//   escape sequence or output boundary in between drops it.  xterm replaces a cell's active content when a base is
//   written into it, so a cell's marks all come from the one run after its last base: at most 8 per cell.
// - per terminal generation: at most 1 Mi combining code points, 4,096 OSC 8 links and 1 Mi UTF-16 units of their
//   parameters and URIs, charged as written and never decremented (scrolling, clear() and the alternate buffer
//   release nothing).  A fragment whose charges would pass a budget starts a new generation first (the caller
//   replaces the xterm instance, so the old one's buffers go with it); one that alone passes a budget is cut at it.
// - after every logical output: CAN (which aborts any unterminated escape or control string), the normal buffer and
//   a soft reset, so parser state, modes and colours never carry into the next prompt or output.
// - style runs (S2's cap, kept at parity with the old renderer: @sagebrush's ruling): as S2 counted them, a run is text
//   in one style: the output's first text, and text after each change of style (SGR sequences held until text follows
//   them).  A logical output keeps its colours for 19,999 runs (S2's 20,000 less the room it kept for its marker);
//   past that the rest is plain (one reset, later SGRs left out), the text always kept, as S2 had it.  Held style
//   changes are written before any other sequence (an erase fills with the current background), counted as a run.
// - a full-screen erase (ESC[2J) right after another, with nothing drawn and no style change between (only C0
//   controls and OSC strings, which draw nothing), is left out: erasing an erased screen changes no cell, so the
//   screen is the same, and output that erases thousands of times costs one erase (daybreak4 P1, C2).

export const BUDGET = Object.freeze({ marksPerBase: 8, combining: 1 << 20, links: 4096, linkUnits: 1 << 20, styleRuns: 20000 });
/** the most one write hands to xterm, in UTF-8 bytes (so in UTF-16 units too): every item, merged or made late, with
 * all admission adds to it (r4 invariant 3, 5, 9) */
export const SLICE = 64 * 1024;
/** a write is handed to xterm in pieces of this size, back to back, its callback on the last: xterm parses each piece
 * whole and yields only between pieces, so a dense 64 KiB write never becomes one long task (daybreak4 P1) */
export const PIECE = 8 * 1024;
/** after each logical output: CAN; DECSTR (modes, margins, colours, cursor shown); mouse reports off.  Leaving the
 * alternate buffer (ESC[?1049l) is added only when the screen is in it: in the normal buffer it would restore a saved
 * cursor position, moving the next prompt. */
export const RESET = "\x18\x1b[!p\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l";
export const LEAVE_ALT = "\x1b[?1049l";
export const CUT_NOTE = "(Some combining characters or links in this output were left out to save memory.)";
/** what the lexer holds across fragments at most, in UTF-16 units: an OSC string and a CSI sequence (longer ones are
 * left out whole), and style changes waiting for text (past it they are written, counted as a run) */
export const HOLD = Object.freeze({ osc: 2048, csi: 64, pend: 256 });
/** what admission may add to an item's own text, in UTF-8 bytes: the held sequences (3 bytes a unit at most, 7.3 KiB),
 * a generation's notice and the cut note.  The ledger keeps it reserved for the one write in flight. */
export const HEADROOM = 8 * 1024;
/** an item's own text at most (UTF-8 bytes), so that what is written of it stays within SLICE */
export const ITEM_MAX = SLICE - HEADROOM;
const NOTICE_UNITS = 80;
/** The ledger's two caps (r4 invariant 2, 9), whatever the calls: every item waiting or in flight, and every byte they
 * hold or have reserved, counted once from its reservation to its release.  Past either, a write is dropped whole and
 * counted; a command's output dropped is counted in its end's "[… N more bytes not shown]". */
export const MAX_ITEMS = 64;
export const MAX_QUEUED = 2 << 20;
/** a command's end: its marker and the reset at most (UTF-8 bytes), reserved with its item when the command starts */
export const END_MAX = 256;
/** the lazy writes' keys, a closed set: one slot each (the line's redraw, top's refresh) */
export const KEYS: readonly string[] = Object.freeze(["redraw", "replace"]);
export type LazyKey = "redraw" | "replace";

export interface Sink {
  write(data: string, done: () => void): void;
}
/** what a dropped or empty write returns: one settled promise, shared */
const SETTLED: Promise<void> = Promise.resolve();
const ENC = new TextEncoder();
/** encodeInto's target: measuring and cutting at ITEM_MAX bytes without a copy */
const BUF = new Uint8Array(ITEM_MAX);
type Kind = "output" | "ui" | "lazy" | "end";
/** a command's end state: its id, its omitted bytes, its end item once asked for, and whether its marker is made */
type Cmd = { id: number; omitted: number; end: Item | null; written?: boolean };
type Item = {
  kind: Kind;
  data: string;
  /** what it holds reserved in the ledger (UTF-8 bytes): its text's, a lazy's SLICE (refunded when made), an end's END_MAX */
  bytes: number;
  make?: () => string;
  key?: LazyKey;
  /** a lazy's text is a command's output (S2's cap, and its cut counted as omitted) */
  styled: boolean;
  /** a lazy's text size (UTF-8 bytes), counted as omitted if it is dropped */
  size: number;
  /** an idle() frontier: nothing merges into it after, so a later write never extends that wait */
  sealed?: boolean;
  /** an end item's command (its marker's count read from it when it is made) */
  cmd?: Cmd;
  done: Promise<void>;
  settle: () => void;
  released: boolean;
};
const item = (kind: Kind, data: string, bytes: number, make?: () => string, key?: LazyKey, styled = false, size = 0): Item => {
  let settle!: () => void;
  const done = new Promise<void>((r) => (settle = r));
  return { kind, data, bytes, make, key, styled, size, done, settle, released: false };
};
/** the bytes of `s` that fit in `max` UTF-8 bytes, never splitting a character: [units read, bytes written] */
const fit = (s: string, max: number): [number, number] => {
  let m = max;
  if (s.length > m && (s.charCodeAt(m) & 0xfc00) === 0xdc00) m--;
  const r = ENC.encodeInto(s.length > m ? s.slice(0, m) : s, max === BUF.length ? BUF : BUF.subarray(0, max));
  return [r.read!, r.written!];
};
/** UTF-8 bytes, counted (a cut's omitted rest) */
const utf8Bytes = (s: string): number => {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if ((c & 0xfc00) === 0xd800 && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) (n += 4), i++;
    else n += 3;
  }
  return n;
};

type Budget = { marksPerBase: number; combining: number; links: number; linkUnits: number; styleRuns?: number };
type Charges = { combining: number; links: number; linkUnits: number };
type Lex = { st: "ground" | "esc" | "escI" | "csi" | "osc" | "oscEsc" | "str" | "strEsc"; osc: string; afterBase: number; drop: boolean; csi?: string; big?: boolean; pend?: string; runs?: number; clean?: boolean };

const MARKISH = /^[\p{Mn}\p{Me}\p{Cf}]$/u;

/** A zero-width test from xterm's own width table (its unicode service), widened by the combining and format
 * categories: never narrower than what xterm appends to a cell. */
export function zeroWidthOf(term: any): (cp: number) => boolean {
  const svc = term?._core?.unicodeService;
  return (cp) => (svc ? svc.wcwidth(cp) === 0 : false) || MARKISH.test(String.fromCodePoint(cp));
}

export class TermWriter {
  /** the terminal generation: a new one replaces the xterm instance */
  gen = 0;
  charges: Charges = { combining: 0, links: 0, linkUnits: 0 };
  /** written so far, by kind (the tests'); droppedBytes: output dropped outside any command */
  stats = { writes: 0, maxWrite: 0, generations: 0, cuts: 0, dropped: 0, droppedBytes: 0, failed: 0, inflightMax: 0 };
  /** the current logical output passed the style-run cap (reset with the output) */
  colourCut = false;
  private inflightN = 0;
  private lex: Lex = { st: "ground", osc: "", afterBase: -1, drop: false };
  private queue: Item[] = [];
  /** the ledger: items waiting, in flight or reserved for a command's end, and their bytes (HEADROOM held always) */
  private items = 0;
  private bytes = HEADROOM;
  /** items in the ledger, at most (the tests' high-water mark) */
  queueMax = 0;
  bytesMax = HEADROOM;
  private pumping = false;
  private dead = false;
  private current: Item | null = null;
  private inflight: (() => void) | null = null;
  /** the one admitted command: its end's reservation (then its item), and its output's omitted bytes */
  private cmd: Cmd | null = null;
  private nextId = 1;
  /** whether the last text written ended a line (the omission marker starts on a line of its own) */
  private atLineStart = true;

  constructor(
    private sink: () => Sink,
    private zeroWidth: (cp: number) => boolean,
    /** a new generation's start: the caller replaces the xterm instance; what it returns is written first, through
     * this writer (the panel's notice) */
    private newGeneration: () => string | void | Promise<string | void>,
    private budget: Budget = BUDGET,
    /** whether the screen is in its alternate buffer now (xterm's buffer.active.type) */
    private inAlt: () => boolean = () => false,
  ) {}

  /** true while anything is queued or in flight (the panel ignores nothing on this: onData is never input) */
  get writing(): boolean {
    return this.pumping || this.queue.length > 0;
  }

  /** the ledger now (the tests' and the panel's) */
  get ledger(): { items: number; bytes: number } {
    return { items: this.items, bytes: this.bytes };
  }

  /** items in the ledger now */
  get backlog(): number {
    return this.items;
  }

  /** near either cap: the panel starts no command and queues no new action (its "still drawing" note) */
  get pressed(): boolean {
    return this.items >= MAX_ITEMS - 8 || this.bytes >= MAX_QUEUED / 2;
  }

  private reserve(bytes: number): boolean {
    if (this.items + 1 > MAX_ITEMS || this.bytes + bytes > MAX_QUEUED) return false;
    this.items++;
    this.bytes += bytes;
    this.queueMax = Math.max(this.queueMax, this.items);
    this.bytesMax = Math.max(this.bytesMax, this.bytes);
    return true;
  }

  private release(it: Item): void {
    if (it.released) return;
    it.released = true;
    this.items--;
    this.bytes -= it.bytes;
  }

  /** dropped whole and counted; a command's output, in its end's marker */
  private drop(bytes: number, output: boolean): void {
    this.stats.dropped++;
    if (output) this.omit(bytes);
  }

  /** a command's output not shown: counted for its end's marker (outside a command, in stats) */
  private omit(bytes: number): void {
    if (this.cmd && !this.cmd.written && !this.dead) this.cmd.omitted += bytes;
    else this.stats.droppedBytes += bytes;
  }

  /** Text into xterm, in order: "output" is a command's (filtered and charged), "ui" the panel's own (its prompt,
   * the editor's line, status lines: already made safe by the panel, passed as is).  Split first into items of at
   * most ITEM_MAX bytes; one merges into the waiting item of its kind only while that stays within ITEM_MAX and the
   * ledger's caps. */
  write(text: string, kind: "output" | "ui" = "ui"): Promise<void> {
    if (this.dead || text === "") return SETTLED;
    let last: Promise<void> = SETTLED;
    for (let i = 0; i < text.length; ) {
      let end = Math.min(text.length, i + ITEM_MAX);
      if (end < text.length && (text.charCodeAt(end) & 0xfc00) === 0xdc00) end--;
      const piece = i === 0 && end === text.length ? text : text.slice(i, end);
      const [read, n] = fit(piece, ITEM_MAX);
      const data = read === piece.length ? piece : piece.slice(0, read);
      i += read;
      const tail = this.queue[this.queue.length - 1];
      if (tail && tail.kind === kind && !tail.sealed && tail.bytes + n <= ITEM_MAX && this.bytes + n <= MAX_QUEUED) {
        tail.data += data;
        tail.bytes += n;
        this.bytes += n;
        this.bytesMax = Math.max(this.bytesMax, this.bytes);
        last = tail.done;
      } else if (this.reserve(n)) {
        const it = item(kind, data, n);
        this.queue.push(it);
        last = it.done;
      } else this.drop(n, kind === "output");
    }
    void this.pump();
    return last;
  }

  /** The panel's own text, made when its turn comes (after every earlier write is drawn, so it can read where the
   * cursor is): a redraw of the line, a move back over a block.  It reserves an item and SLICE bytes; what `make`
   * returns is cut to ITEM_MAX bytes (the rest of a command's output counted as omitted) and the rest refunded.
   * `make` reads the panel's own bounded state: it captures no text of its own.
   * `key`: one of KEYS; a keyed write still waiting has its `make` replaced (the last wins), so one slot each.
   * `output`: what `make` returns is a command's output, admitted as output is (S2's cap), and `size` its bytes. */
  writeLazy(make: () => string, key?: LazyKey, output = false, size = 0): Promise<void> {
    if (key !== undefined && !KEYS.includes(key)) throw new Error(`term-writer: unknown lazy key ${JSON.stringify(key)}`);
    if (this.dead) return SETTLED;
    if (key) {
      // (an item sealed as an idle() frontier is never replaced: a later write takes a slot of its own after it)
      const same = this.queue.find((q) => q.key === key && !q.sealed);
      if (same) {
        same.make = make;
        same.size = size;
        return same.done;
      }
    }
    if (!this.reserve(SLICE)) {
      this.drop(size, output);
      return SETTLED;
    }
    const it = item("lazy", "", SLICE, make, key, output, size);
    this.queue.push(it);
    void this.pump();
    return it.done;
  }

  /** A command starts (the panel's one admission): its end's item and END_MAX bytes reserved now, so its end is
   * always written.  null (nothing reserved) while another command is active or the ledger is pressed.  A command
   * whose end has been asked for is over: the next may start while that end still waits to be drawn (its item keeps
   * its own count; #854 r8, the A4 race). */
  tryStartCommand(): number | null {
    if (this.dead || (this.cmd && !this.cmd.end) || this.pressed || !this.reserve(END_MAX)) return null;
    this.cmd = { id: this.nextId++, omitted: 0, end: null };
    return this.cmd.id;
  }

  /** The end of command `id`'s output (`omitted`: its bytes the panel left out, S1's): the reset, the lexer back to
   * ground with no base to attach to, and one "[… N more bytes not shown]" for all its omitted bytes.  A repeat while
   * it waits shares its completion (its count joining the marker's); once the marker is made, a repeat with more
   * omitted bytes is refused (one marker, exact), and any other id is refused. */
  endOutput(id: number, omitted = 0): Promise<void> {
    if (this.dead) return SETTLED;
    const c = this.cmd;
    if (!c || c.id !== id) return Promise.reject(new Error(`term-writer: command ${id} isn't the active one`));
    if (c.written && omitted > 0) return Promise.reject(new Error(`term-writer: command ${id}'s marker is already written`));
    c.omitted += omitted;
    if (c.end) return c.end.done;
    // (its item and bytes were reserved when the command started)
    c.end = item("end", "", END_MAX);
    c.end.cmd = c;
    this.queue.push(c.end);
    void this.pump();
    return c.end.done;
  }

  /** All writes queued before it drawn: no item of its own.  Its frontier is the last item waiting (or the one in
   * flight): callers at one frontier share that item's completion, and the item is sealed, so no later write merges
   * into it and extends the wait. */
  idle(): Promise<void> {
    if (this.dead) return SETTLED;
    const at = this.queue[this.queue.length - 1] ?? this.current;
    if (!at) return SETTLED;
    at.sealed = true;
    return at.done;
  }

  /** ✕: nothing more is written; whatever waits is let go and released, and a late callback does nothing. */
  dispose(): void {
    if (this.dead) return;
    this.dead = true;
    for (const q of this.queue.splice(0)) this.release(q), q.settle();
    if (this.current) this.release(this.current), this.current.settle();
    if (this.cmd && !this.cmd.end) (this.items--, (this.bytes -= END_MAX));
    this.cmd = null;
    this.inflight?.();
    this.inflight = null;
  }

  /** a lazy item's text: made now, cut to ITEM_MAX bytes (a cut command output's rest counted), the rest refunded */
  private made(it: Item): string {
    let s = it.make!();
    it.make = undefined;
    let [read, n] = fit(s, ITEM_MAX);
    if (read < s.length) {
      // (cut: CAN ends any sequence left open at the cut)
      [read, n] = fit(s, ITEM_MAX - 1);
      if (it.styled) this.omit(utf8Bytes(s) - n);
      this.stats.cuts++;
      s = s.slice(0, read) + "\x18";
      n++;
    }
    this.bytes -= it.bytes - n;
    it.bytes = n;
    return s;
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.queue.length && !this.dead) {
        const item = this.queue.shift()!;
        this.current = item;
        try {
          let data: string;
          if (item.kind === "end") {
            this.lex = { st: "ground", osc: "", afterBase: -1, drop: false };
            this.colourCut = false;
            const c = item.cmd ?? null;
            if (c) c.written = true;
            const n = c ? c.omitted : 0;
            data = (this.inAlt() ? "\x18" + LEAVE_ALT + RESET.slice(1) : RESET) + (n ? (this.atLineStart ? "" : "\r\n") + `\x1b[2;3m[\u2026 ${n} more bytes not shown]\x1b[0m\r\n` : "");
          } else if (item.kind === "lazy") data = await this.admit(this.made(item), item.styled);
          else data = await this.admit(item.data, item.kind === "output");
          item.data = "";
          if (!this.dead) {
            await this.put(data);
            if (data) this.atLineStart = /\n(?:\x1b\[[0-9;]*m)*$/.test(data.slice(-64));
          }
        } catch {
          // (a callback, the generation's start or the sink threw: the item is dropped and counted, the rest goes on)
          this.stats.failed++;
        } finally {
          // (every item, written, failed or let go by dispose: released once, settled once; a command's end frees it)
          item.make = undefined;
          item.data = "";
          this.release(item);
          this.current = null;
          if (item.kind === "end" && item.cmd && this.cmd === item.cmd) this.cmd = null;
          item.cmd = undefined;
          item.settle();
        }
      }
    } finally {
      this.pumping = false;
      this.current = null;
    }
  }

  private put(data: string): Promise<void> {
    if (data === "") return Promise.resolve();
    this.stats.writes++;
    this.stats.maxWrite = Math.max(this.stats.maxWrite, data.length);
    const gen = this.gen, t0 = typeof performance === "undefined" ? 0 : performance.now();
    this.stats.inflightMax = Math.max(this.stats.inflightMax, ++this.inflightN);
    return new Promise((res, rej) => {
      let fired = false;
      // (E5.5's slice measure: one write, from its start to xterm's callback for it)
      const fin = () => { if (!fired) (fired = true), this.inflightN--, (this.inflight = null), t0 && performance.measure("sb-term:write", { start: t0, end: performance.now() }), res(); };
      this.inflight = fin;
      // (a callback from a generation since replaced, or after ✕, is a no-op: fin runs once)
      try {
        const sink = this.sink();
        for (let k = 0; k < data.length; ) {
          let e = Math.min(data.length, k + PIECE);
          if (e < data.length && (data.charCodeAt(e) & 0xfc00) === 0xdc00) e--;
          const last = e >= data.length;
          if (last) sink.write(data.slice(k), () => { if (this.gen === gen) fin(); });
          else sink.write(data.slice(k, e), () => {});
          k = e;
        }
      } catch (err) {
        // (a sink that throws: this write ends now, failed; no callback is waited for)
        if (!fired) (fired = true), this.inflightN--, (this.inflight = null), rej(err);
      }
    });
  }

  /** A fragment's charges measured before it is written; a new generation first if they would pass a budget. */
  /** S2's cap applies to the current admission (output's), not to the panel's own text */
  private styled = true;

  private async admit(data: string, styled = true): Promise<string> {
    if (data === "") return "";
    this.styled = styled;
    const left = (c: Charges): Charges => ({ combining: this.budget.combining - c.combining, links: this.budget.links - c.links, linkUnits: this.budget.linkUnits - c.linkUnits });
    let r = this.filter(data, { ...this.lex }, left(this.charges));
    if (r.cut && (this.charges.combining || this.charges.links || this.charges.linkUnits)) {
      // (a fresh generation: the old instance and everything it holds released by the caller)
      this.gen++;
      this.stats.generations++;
      this.charges = { combining: 0, links: 0, linkUnits: 0 };
      // (the notice within its share of HEADROOM)
      const notice = String((await this.newGeneration()) ?? "").slice(0, NOTICE_UNITS);
      // (the new terminal's parser starts at ground: the rest of a sequence open across the change is dropped)
      const lex: Lex = { ...this.lex, drop: this.lex.st !== "ground", osc: "", afterBase: -1 };
      r = this.filter(data, lex, left(this.charges));
      r.out = notice + r.out;
    }
    this.lex = r.lex;
    this.charges.combining += r.charged.combining;
    this.charges.links += r.charged.links;
    this.charges.linkUnits += r.charged.linkUnits;
    if (r.cut) {
      this.stats.cuts++;
      return r.out + `\r\n${CUT_NOTE}\r\n`;
    }
    return r.out;
  }

  /** The lexer over one fragment: what to write, its charges within `room`, and whether anything was cut for room.
   * An OSC is held whole, its introducer included, until its end decides it (an OSC 8 link past a budget is left out
   * entirely, so xterm's parser never sees a half sequence); its held text carries across fragments in `lex`. */
  filter(data: string, lex: Lex, room: Charges): { out: string; lex: Lex; charged: Charges; cut: boolean } {
    lex = { ...lex };
    const charged: Charges = { combining: 0, links: 0, linkUnits: 0 };
    let out = "", cut = false;
    const max = this.budget.marksPerBase;
    const emit = (t: string) => { if (!lex.drop) out += t; };
    const toGround = () => { lex.st = "ground"; lex.drop = false; };
    for (let i = 0; i < data.length; ) {
      if (lex.st === "ground") {
        // (the common case, a run of printable ASCII: bases all, copied as one slice)
        let j = i;
        while (j < data.length) {
          const c = data.charCodeAt(j);
          if (c < 0x20 || c > 0x7e) break;
          j++;
        }
        if (j > i) {
          lex.clean = false;
          out += this.styleGate(lex) + data.slice(i, j);
          lex.afterBase = 0;
          i = j;
          continue;
        }
      }
      const cp = data.codePointAt(i)!;
      const ch = String.fromCodePoint(cp);
      i += ch.length;
      switch (lex.st) {
        case "ground":
          if (cp === 0x1b) {
            // (held until the next character says whether an OSC starts)
            lex.st = "esc";
            lex.afterBase = -1;
          } else if (cp === 0x9d) {
            lex.st = "osc";
            lex.osc = ch;
            lex.afterBase = -1;
          } else if (cp < 0x20 || cp === 0x7f || (cp >= 0x80 && cp < 0xa0)) {
            // (a control: CR, BS, LF, … can move the cursor back over a cell: no mark attaches past it)
            lex.afterBase = -1;
            if (cp === 0x9b) {
              // (an 8-bit CSI: held as the 7-bit one, as the csi case writes it)
              lex.st = "csi";
              lex.csi = "";
              break;
            }
            if (cp === 0x90 || cp === 0x98 || cp === 0x9e || cp === 0x9f) lex.st = "str";
            out += ch;
          } else if (this.zeroWidth(cp)) {
            if (lex.afterBase >= 0 && lex.afterBase < max && charged.combining < room.combining) {
              lex.afterBase++;
              charged.combining++;
              out += ch;
            } else {
              if (lex.afterBase >= 0 && lex.afterBase < max) cut = true;
              this.stats.dropped++;
            }
          } else {
            lex.afterBase = 0;
            lex.clean = false;
            out += this.styleGate(lex) + ch;
          }
          break;
        case "esc":
          if (cp === 0x5d) {
            lex.st = "osc";
            lex.osc = "\x1b]";
            break;
          }
          if (cp === 0x5b) {
            // (held with its sequence: the csi case writes it whole, or leaves an over-cap SGR out)
            lex.st = "csi";
            lex.csi = "";
            break;
          }
          if (!lex.drop) out += this.styleGate(lex, false);
          lex.clean = false;
          emit("\x1b" + ch);
          if (cp === 0x5b) lex.st = "csi";
          else if (cp === 0x50 || cp === 0x58 || cp === 0x5e || cp === 0x5f) lex.st = "str";
          else if (cp >= 0x20 && cp <= 0x2f) lex.st = "escI";
          else toGround();
          break;
        case "escI":
          emit(ch);
          if (!(cp >= 0x20 && cp <= 0x2f)) toGround();
          break;
        case "csi": {
          // (the sequence held to its final byte, scanned as one slice; an SGR past the style-run cap left out)
          let k = i - ch.length;
          let fin = -1;
          while (k < data.length) {
            const c = data.charCodeAt(k++);
            if ((c >= 0x40 && c <= 0x7e) || c === 0x18 || c === 0x1a) { fin = c; break; }
          }
          // (held within HOLD.csi: a longer sequence is left out whole)
          if (!lex.big) lex.csi = (lex.csi ?? "") + data.slice(i - ch.length, k);
          if (lex.csi!.length > HOLD.csi) (lex.big = true), (lex.csi = "");
          i = k;
          if (fin < 0) break;
          const seq = lex.csi!, drop = lex.drop || !!lex.big;
          lex.csi = "";
          lex.big = false;
          toGround();
          if (drop) break;
          if (fin === 0x6d && this.styled && this.budget.styleRuns !== undefined) {
            // (a style change: held until text or another sequence follows it; past the cap, left out; held changes
            // past HOLD.pend are written first, as a run of their own)
            if (this.colourCut) break;
            if ((lex.pend ?? "").length + seq.length + 2 > HOLD.pend) out += this.styleGate(lex);
            if (!this.colourCut) lex.pend = (lex.pend ?? "") + "\x1b[" + seq;
            break;
          }
          const flushed = this.styleGate(lex, false);
          const ed2 = seq === "2J";
          if (ed2 && lex.clean && flushed === "") break; // (an erase of an erased screen)
          out += flushed + "\x1b[" + seq;
          lex.clean = ed2;
          break;
        }
        case "osc":
        case "oscEsc": {
          if (cp === 0x18 || cp === 0x1a) {
            // (an aborted OSC: xterm drops it too; only the CAN goes out)
            emit(ch);
            lex.osc = "";
            toGround();
            break;
          }
          const end = cp === 0x07 || cp === 0x9c || (lex.st === "oscEsc" && cp === 0x5c);
          if (end) {
            const held = lex.osc + ch;
            const intro = held.startsWith("\x1b]") ? 2 : 1;
            const body = held.slice(intro, held.length - (lex.st === "oscEsc" ? 2 : 1));
            const keep = lex.drop ? false : this.chargeOsc(body, charged, room);
            if (keep === "cut") cut = true;
            if (keep === true) out += held;
            lex.osc = "";
            toGround();
            break;
          }
          // (an OSC past any budget can never be admitted: it is dropped whole, ending as usual)
          if (!lex.drop) {
            lex.osc += ch;
            if (lex.osc.length > HOLD.osc) (lex.drop = true), (lex.osc = "");
          }
          lex.st = cp === 0x1b ? "oscEsc" : "osc";
          break;
        }
        case "str":
        case "strEsc":
          emit(ch);
          if (cp === 0x9c || (lex.st === "strEsc" && cp === 0x5c) || cp === 0x18 || cp === 0x1a) toGround();
          else lex.st = cp === 0x1b ? "strEsc" : "str";
          break;
      }
    }
    return { out, lex, charged, cut };
  }

  /** Before text in ground: the held style changes written if the run they start is within the cap, else the text
   * goes on plain (one reset at the cap).  Returns what to write before the text. */
  private styleGate(lex: Lex, text = true): string {
    const cap = this.budget.styleRuns;
    if (cap === undefined || !this.styled) return "";
    const pend = lex.pend ?? "";
    if (lex.runs === undefined || lex.runs === 0) {
      if (!text && pend === "") return "";
      lex.runs = 1;
      lex.pend = "";
      return pend;
    }
    if (pend === "") return "";
    lex.pend = "";
    if (this.colourCut) return "";
    lex.runs++;
    if (lex.runs <= cap - 1) return pend;
    this.colourCut = true;
    return "\x1b[0m";
  }

  /** An OSC's charge: an OSC 8 opening counts one link and its parameter and URI units. */
  private chargeOsc(body: string, charged: Charges, room: Charges): boolean | "cut" {
    if (!body.startsWith("8;")) return true;
    const rest = body.slice(2), semi = rest.indexOf(";");
    const uri = semi < 0 ? "" : rest.slice(semi + 1);
    if (uri === "") return true; // (a link's end)
    const units = rest.length;
    if (charged.links + 1 > room.links || charged.linkUnits + units > room.linkUnits) return "cut";
    charged.links++;
    charged.linkUnits += units;
    return true;
  }
}
