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
/** the queue's bound (ENGINE E3, SEC T854-3, PERF P1), whatever the calls: at most this many items wait, each with one
 * shared completion (a call returns its item's promise, so nothing is kept per call).  Queued writes of one kind merge
 * up to a 64 KiB fragment; a keyed write (the line's redraw, top's refresh) replaces the one waiting (the last wins).
 * At the bound, output still merges into a waiting output (its bytes bounded by S1, one command at a time), a keyed
 * write still replaces, a barrier joins the last item, and the end of an output (one per command, awaited) is still
 * queued; any other write is dropped and counted.  The panel stops producing before then (its `busy` note). */
export const MAX_ITEMS = 64;
// (plus at most one waiting item per key, two keys, and one end of output per command)
/** and at most this many bytes wait in all: past it, a write is dropped and counted, output included */
export const MAX_QUEUED = 2 << 20;

export interface Sink {
  write(data: string, done: () => void): void;
}
/** what a dropped or empty write returns: one settled promise, shared */
const SETTLED: Promise<void> = Promise.resolve();
type Item = { data: string; kind: "output" | "ui" | "reset" | "lazy"; make?: () => string; key?: string; styled?: boolean; done: Promise<void>; settle: () => void };
const item = (data: string, kind: Item["kind"], make?: () => string, key?: string, styled = false): Item => {
  let settle!: () => void;
  const done = new Promise<void>((r) => (settle = r));
  return { data, kind, make, key, styled, done, settle };
};

type Budget = { marksPerBase: number; combining: number; links: number; linkUnits: number; styleRuns?: number };
type Charges = { combining: number; links: number; linkUnits: number };
type Lex = { st: "ground" | "esc" | "escI" | "csi" | "osc" | "oscEsc" | "str" | "strEsc"; osc: string; afterBase: number; drop: boolean; csi?: string; pend?: string; runs?: number; clean?: boolean };

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
  /** written so far, by kind (the tests') */
  stats = { writes: 0, maxWrite: 0, generations: 0, cuts: 0, dropped: 0, inflightMax: 0 };
  /** the current logical output passed the style-run cap (reset with the output) */
  colourCut = false;
  private inflightN = 0;
  private lex: Lex = { st: "ground", osc: "", afterBase: -1, drop: false };
  private queue: Item[] = [];
  /** items waiting, at most (the tests' high-water mark) */
  queueMax = 0;
  private pumping = false;
  private dead = false;
  private inflight: (() => void) | null = null;

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

  /** Text into xterm, in order: "output" is a command's (filtered and charged), "ui" the panel's own (its prompt,
   * the editor's line, status lines: already made safe by the panel, passed as is). */
  write(text: string, kind: "output" | "ui" = "ui"): Promise<void> {
    if (this.dead || text === "") return SETTLED;
    let last: Promise<void> = SETTLED;
    for (let i = 0; i < text.length; ) {
      let j = Math.min(text.length, i + SLICE);
      // (never between a surrogate pair)
      if (j < text.length && (text.charCodeAt(j) & 0xfc00) === 0xdc00) j--;
      const data = text.slice(i, j);
      i = j;
      const tail = this.queue[this.queue.length - 1];
      const full = this.queue.length >= MAX_ITEMS;
      if (this.queuedBytes() + data.length > MAX_QUEUED) {
        this.stats.dropped++;
        continue;
      }
      // (merged into the waiting write of the same kind while it stays a fragment; at the bound, output merges anyway)
      if (tail && tail.kind === kind && (tail.data.length + data.length <= SLICE || (full && kind === "output"))) {
        tail.data += data;
        last = tail.done;
      } else if (full) {
        this.stats.dropped++;
      } else {
        const it = item(data, kind);
        this.push(it);
        last = it.done;
      }
    }
    void this.pump();
    return last;
  }

  private queuedBytes(): number {
    let n = 0;
    for (const q of this.queue) n += q.data.length;
    return n;
  }

  /** items waiting now (the panel's backpressure reads it) */
  get backlog(): number {
    return this.queue.length;
  }

  private push(it: Item): void {
    this.queue.push(it);
    this.queueMax = Math.max(this.queueMax, this.queue.length);
  }

  /** The panel's own text, made when its turn comes (after every earlier write is drawn, so it can read where the
   * cursor is): a redraw of the line, a move back over a block. */
  /** `output`: what `make` returns is a command's output, admitted as output is (S2's cap); else the panel's own. */
  writeLazy(make: () => string, key?: string, output = false): Promise<void> {
    if (this.dead) return Promise.resolve();
    // (a keyed write still waiting is replaced: a redraw or a refresh superseded before it ran; the last wins)
    const same = key ? this.queue.find((q) => q.kind === "lazy" && q.key === key) : undefined;
    if (same) {
      same.make = make;
      return same.done;
    }
    // (a keyed write takes its one item even at the bound: there are two keys, the line's redraw and a refresh)
    if (!key && this.queue.length >= MAX_ITEMS) {
      this.stats.dropped++;
      return this.queue[this.queue.length - 1].done;
    }
    const it = item("", "lazy", make, key, output);
    this.push(it);
    void this.pump();
    return it.done;
  }

  /** The end of a logical output: the reset, and the lexer back to ground with no base to attach to. */
  endOutput(): Promise<void> {
    if (this.dead) return Promise.resolve();
    // (queued even at the bound: one per command, and the panel awaits it before the next)
    const it = item(RESET, "reset");
    this.push(it);
    void this.pump();
    return it.done;
  }

  /** All writes queued before it drawn: a barrier at the end of the queue (the last callback, then this). */
  idle(): Promise<void> {
    if (this.dead) return Promise.resolve();
    // (at the bound, the last item's own completion is the same barrier)
    if (this.queue.length >= MAX_ITEMS) return this.queue[this.queue.length - 1].done;
    return this.writeLazy(() => "");
  }

  /** ✕: nothing more is written; whatever waits is let go, and a late callback does nothing. */
  dispose(): void {
    this.dead = true;
    for (const q of this.queue.splice(0)) q.settle();
    this.inflight?.();
    this.inflight = null;
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.queue.length && !this.dead) {
        const item = this.queue.shift()!;
        let data = item.data;
        // (every write goes through admission: output with S2's cap, the panel's own text without it)
        if (item.kind === "output") data = await this.admit(data, true);
        else if (item.kind === "ui") data = await this.admit(data, false);
        else if (item.kind === "reset") {
          this.lex = { st: "ground", osc: "", afterBase: -1, drop: false };
          this.colourCut = false;
          data = this.inAlt() ? "\x18" + LEAVE_ALT + RESET.slice(1) : RESET;
        }
        else if (item.kind === "lazy") data = await this.admit(item.make!(), !!item.styled);
        if (this.dead) return item.settle();
        await this.put(data);
        item.settle();
      }
    } finally {
      this.pumping = false;
    }
  }

  private put(data: string): Promise<void> {
    if (data === "") return Promise.resolve();
    this.stats.writes++;
    this.stats.maxWrite = Math.max(this.stats.maxWrite, data.length);
    const gen = this.gen, t0 = typeof performance === "undefined" ? 0 : performance.now();
    this.stats.inflightMax = Math.max(this.stats.inflightMax, ++this.inflightN);
    return new Promise((res) => {
      let fired = false;
      // (E5.5's slice measure: one write, from its start to xterm's callback for it)
      const fin = () => { if (!fired) (fired = true), this.inflightN--, (this.inflight = null), t0 && performance.measure("sb-term:write", { start: t0, end: performance.now() }), res(); };
      this.inflight = fin;
      // (a callback from a generation since replaced, or after ✕, is a no-op: fin runs once)
      const sink = this.sink();
      for (let k = 0; k < data.length; ) {
        let e = Math.min(data.length, k + PIECE);
        if (e < data.length && (data.charCodeAt(e) & 0xfc00) === 0xdc00) e--;
        const last = e >= data.length;
        if (last) sink.write(data.slice(k), () => { if (this.gen === gen) fin(); });
        else sink.write(data.slice(k, e), () => {});
        k = e;
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
      const notice = (await this.newGeneration()) ?? "";
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
          lex.csi = (lex.csi ?? "") + data.slice(i - ch.length, k);
          i = k;
          if (fin < 0) break;
          const seq = lex.csi;
          lex.csi = "";
          toGround();
          if (fin === 0x6d && this.styled && this.budget.styleRuns !== undefined) {
            // (a style change: held until text or another sequence follows it; past the cap, left out)
            if (!lex.drop && !this.colourCut) lex.pend = (lex.pend ?? "") + "\x1b[" + seq;
            break;
          }
          if (lex.drop) break;
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
            if (lex.osc.length > this.budget.linkUnits + 16) (lex.drop = true), (lex.osc = "");
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
