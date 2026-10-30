// The terminal panel's renderer (plan-bash-shell r8c E5.3-E5.5): a command's whole stdout and stderr (just-bash
// returns them when the command finishes) as style runs, from scratch and with no emulator.  Pure: no DOM here, so
// it is tested directly; web/shell/panel.ts turns each slice's runs into one DocumentFragment of text nodes.
//   - line ends: \r\n -> \n; a lone \r returns to the line's start (the line keeps the text after its last \r);
//   - SGR (ESC [ params m), single pass, leading zeros allowed, an empty parameter 0; a well-formed one is always
//     consumed; the recognised parameters set classes from a fixed table, every other one is ignored;
//   - every other escape or control character is shown visibly (ESC as U+241B, C0 as U+2400+c, DEL as U+2421);
//   - the per-command caps of E5.4, markers included, enforced while the runs are made.

export const CAPS = Object.freeze({
  /** S1: UTF-8 bytes consumed per command (stdout then stderr), of which ERR_RESERVE are kept for stderr */
  inBytes: 1 << 20,
  errReserve: 65536,
  /** S2: UTF-16 code units shown, style runs, lines (markers included) per command */
  units: 1 << 20,
  spans: 20000,
  lines: 5000,
});

/** A slice ends at whichever comes first (E5.5): consumed input bytes, runs, or elapsed ms. */
export const SLICE = Object.freeze({ bytes: 64 * 1024, spans: 1000, ms: 8 });
// (how often a scan looks at the clock: every this many scalars, at most 16 KiB of UTF-8)
const CHECK = 4096;

/** A run of one style; `restart`: a lone \r over runs of the open line already returned in an earlier slice:
 * the painter removes what it put in for this line since its start (TP-2: the same text whatever the slicing). */
export type Run = { text: string; cls: string; err: boolean; restart?: true; page?: true };
/** A shown line longer than this many code units is cut into pages of it: from the second page on, each in an
 * inline-block box of its own (the painter's), so no slice lays out more than its own pages whatever the line's length,
 * and a selection still copies the line as one (no break at a join). A page run is charged as a run. */
export const PAGE = 4096;

/** Whether a page may not start at code unit k of s: inside a surrogate pair, or before a continuation of the
 * previous character's cluster (a combining mark, ZWJ, a variation selector, an emoji modifier, a tag), or after ZWJ
 * (board's B-LL-1). */
export function joinsCluster(s: string, k: number): boolean {
  if (k <= 0 || k >= s.length) return false;
  const p = s.charCodeAt(k - 1);
  if (p >= 0xd800 && p < 0xdc00) return true;
  if (p === 0x200d) return true;
  const c = s.codePointAt(k)!;
  return c === 0x200d || (c >= 0xfe00 && c <= 0xfe0f) || (c >= 0xe0100 && c <= 0xe01ef) || (c >= 0x1f3fb && c <= 0x1f3ff) ||
    (c >= 0xe0020 && c <= 0xe007f) || /\p{M}/u.test(String.fromCodePoint(c));
}

type Style = { fg: number; bg: number; b: boolean; i: boolean; u: boolean; rev: boolean };
const PLAIN: Style = Object.freeze({ fg: -1, bg: -1, b: false, i: false, u: false, rev: false });

/** The class names of a style: only from this fixed table, never from the data. */
export function classOf(s: Style): string {
  const c: string[] = [];
  let fg = s.fg, bg = s.bg, fgRev = false, bgRev = false;
  if (s.rev) {
    // (reverse swaps the effective colours, the defaults included: default fg <-> default bg)
    [fg, bg] = [bg, fg];
    fgRev = fg === -1;
    bgRev = bg === -1;
  }
  if (fgRev) c.push("sb-fg-rev");
  else if (fg >= 0) c.push("sb-fg-" + fg);
  else if (bg >= 0) c.push("sb-fga-" + bg); // (only a background: the theme's fg or bg, whichever reads better on it)
  if (bgRev) c.push("sb-bg-rev");
  else if (bg >= 0) c.push("sb-bg-" + bg);
  if (s.b) c.push("sb-b");
  if (s.i) c.push("sb-i");
  if (s.u) c.push("sb-u");
  return c.join(" ");
}

/** Applies one SGR parameter list (already split, empty -> 0) to a style. */
export function applySgr(s: Style, ps: number[]): Style {
  const t = { ...s };
  for (let k = 0; k < ps.length; k++) {
    const p = ps[k];
    if (p === 0) Object.assign(t, PLAIN);
    else if (p === 1) t.b = true;
    else if (p === 22) t.b = false;
    else if (p === 3) t.i = true;
    else if (p === 23) t.i = false;
    else if (p === 4) t.u = true;
    else if (p === 24) t.u = false;
    else if (p === 7) t.rev = true;
    else if (p === 27) t.rev = false;
    else if (p >= 30 && p <= 37) t.fg = p - 30;
    else if (p === 39) t.fg = -1;
    else if (p >= 40 && p <= 47) t.bg = p - 40;
    else if (p === 49) t.bg = -1;
    else if (p >= 90 && p <= 97) t.fg = p - 90 + 8;
    else if (p >= 100 && p <= 107) t.bg = p - 100 + 8;
    else if (p === 38 || p === 48) {
      // (256-colour and true-colour forms: ignored, their sub-parameters consumed)
      if (ps[k + 1] === 5) k += 2;
      else if (ps[k + 1] === 2) k += 4;
    }
    // (every other parameter: ignored, not shown)
  }
  return t;
}

const utf8Len = (cp: number) => (cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4);
/** The UTF-8 length of a string (lone surrogates count 3, as TextEncoder writes U+FFFD). */
export function utf8Bytes(s: string): number {
  let n = 0;
  for (const ch of s) n += utf8Len(ch.codePointAt(0)!);
  return n;
}

/** A visible glyph for a C0 control, DEL, or ESC. */
function visible(cp: number): string {
  if (cp === 0x1b) return "␛";
  if (cp === 0x7f) return "␡";
  return String.fromCharCode(0x2400 + cp);
}

const SGR = /^\x1b\[([0-9;]*)m/;

/**
 * Renders one command's output as slices of runs.  Resumable: `next(budget)` makes runs until the slice budget is
 * spent (or the output ends) and returns them, or null when done.  The caps (E5.4) hold over everything returned,
 * the omission line included: at most CAPS.lines lines, CAPS.spans runs and CAPS.units code units.
 */
export class Render {
  private part = 0; // 0 stdout, 1 stderr, 2 done
  private pos = 0;
  private style: Style = { ...PLAIN };
  private units = 0;
  private spans = 0;
  private lines = 1; // (the line being written)
  private consumed = 0;
  private omitted = 0; // the original UTF-8 bytes not shown
  private stopped = false;
  private finished = false;
  // (S1's budgets, stdout's and stderr's: set inside the first slice, from at most 64 KiB of stderr; stderr's from
  // what stdout actually consumed, when stdout ends)
  private budgets: [number, number] | null = null;
  private consumedOut = 0;
  // (the stderr reservation's look, resumable: where it is, and the bytes seen)
  private resPos = 0;
  private resBytes = 0;
  // (the bytes scanned without being consumed: the stderr reservation's look, the omitted tail's count; charged
  // to the same slice budget as consumed input, so no slice does more than its budget of scanning: E5.5)
  private work = 0;
  // (the current line's runs since its last \r: a lone \r drops them before they are returned)
  private line: Run[] = [];
  // (the open line's runs already returned at a slice's end: units and runs, for a later lone \r to take back)
  private lineOut = { units: 0, spans: 0 };
  // (the open line's shown units, for its pages: reset at a line end and by a lone \r)
  private lineUnits = 0;
  // (where the line's current page began, in its shown units: each page is at most PAGE from there)
  private pageStart = 0;

  /** Nothing is scanned here: every byte's work is inside a slice (next()). */
  constructor(private out: string, private err: string, private now: () => number = () => performance.now()) {}

  /** The omission line's text (charged against the caps in advance). */
  static marker(n: number): string {
    return `[… ${n} more bytes not shown]`;
  }

  // (the room kept for the omission line: one line, one run, its longest text)
  private static readonly MARK_UNITS = Render.marker(2 ** 53).length + 1;

  private push(out: Run[], text: string, err: boolean) {
    if (!text) return;
    const cls = classOf(this.style);
    const last = this.line[this.line.length - 1];
    if (last && !last.page && last.cls === cls && last.err === err) last.text += text;
    else {
      this.line.push({ text, cls, err });
      this.spans++;
    }
    this.units += text.length;
    this.lineUnits += text.length;
  }

  /** Moves the current line's runs to `out` (at a \n, or at the end). */
  private flush(out: Run[], midLine = false) {
    for (const r of this.line) {
      out.push(r);
      if (midLine) (this.lineOut.units += r.text.length), this.lineOut.spans++;
    }
    this.line = [];
    if (!midLine) this.lineOut = { units: 0, spans: 0 };
  }


  /** The next slice's runs, or null when the output is done. */
  next(budget: { bytes: number; spans: number; ms: number } = SLICE): Run[] | null {
    if (this.finished) return null;
    const out: Run[] = [];
    const t0 = this.now();
    const b0 = this.consumed, s0 = this.spans, w0 = this.work;
    const spent = () => this.consumed - b0 + (this.work - w0);
    // (every scan below checks the slice's clock each CHECK scalars, as well as its byte budget: E5.5's whichever
    // comes first holds inside them too; DB2-TERM-326-1)
    const over = () => spent() >= budget.bytes || this.now() - t0 >= budget.ms;
    if (!this.budgets) {
      // (stderr's reservation needs only its first 64 KiB: scanned no further, charged, and resumable)
      let j = this.resPos, k = 0;
      while (j < this.err.length && this.resBytes < CAPS.errReserve) {
        if (++k % CHECK === 0 && over()) break;
        const c = this.err.codePointAt(j)!;
        const u = utf8Len(c);
        this.resBytes += u;
        this.work += u;
        j += c > 0xffff ? 2 : 1;
      }
      this.resPos = j;
      if (j < this.err.length && this.resBytes < CAPS.errReserve) return out;
      this.budgets = [CAPS.inBytes - Math.min(this.resBytes, CAPS.errReserve), 0];
    }
    while (this.part < 2) {
      if (spent() >= budget.bytes || this.spans - s0 >= budget.spans || this.now() - t0 >= budget.ms) {
        this.flush(out, true);
        return out;
      }
      const src = this.part === 0 ? this.out : this.err;
      const err = this.part === 1;
      if (this.stopped && this.pos < src.length) {
        // (the omitted tail, counted exactly in original bytes, in place and incrementally: as much as this slice's
        // budget has left, then the loop's top decides whether the slice ends)
        let j = this.pos, n = 0, k = 0;
        const lim = budget.bytes - spent();
        while (j < src.length && n < lim) {
          if (++k % CHECK === 0 && this.now() - t0 >= budget.ms) break;
          const c = src.codePointAt(j)!;
          n += utf8Len(c);
          j += c > 0xffff ? 2 : 1;
        }
        this.omitted += n;
        this.work += n;
        this.pos = j;
        continue;
      }
      if (this.stopped || this.pos >= src.length) {
        // (this part's end; stdout's: stderr gets what stdout left of the 1 MiB)
        if (this.part === 0) {
          this.consumedOut = this.consumed;
          this.budgets[1] = CAPS.inBytes - this.consumedOut;
        }
        this.part++;
        this.pos = 0;
        this.stopped = false;
        if (this.part === 1 && this.err && this.line.length) {
          // (stderr starts on its own line)
          this.flush(out);
          if (!this.newline(out, false)) this.stopped = true;
        }
        continue;
      }
      // the next token: an SGR sequence, an escape or control, a line end, or a run of plain text
      const cp = src.codePointAt(this.pos)!;
      let tokLen: number, bytes: number, shown = "", sgr: number[] | null = null, nl = false, cr = false;
      if (cp === 0x1b) {
        const m = SGR.exec(src.slice(this.pos, this.pos + 256));
        if (m) {
          tokLen = m[0].length;
          bytes = tokLen;
          sgr = m[1] === "" ? [0] : m[1].split(";").map((x) => (x === "" ? 0 : parseInt(x, 10)));
        } else {
          tokLen = 1;
          bytes = 1;
          shown = visible(cp);
        }
      } else if (cp === 0x0a) {
        tokLen = bytes = 1;
        nl = true;
      } else if (cp === 0x0d) {
        if (src.charCodeAt(this.pos + 1) === 0x0a) {
          tokLen = bytes = 2;
          nl = true;
        } else {
          tokLen = bytes = 1;
          cr = true;
        }
      } else if ((cp < 0x20 && cp !== 0x09) || cp === 0x7f) {
        tokLen = bytes = 1;
        shown = visible(cp);
      } else {
        // (a run of plain scalars, up to the next special character, kept short so a slice can end inside it)
        let j = this.pos, n = 0;
        while (j < src.length && n < 4096) {
          const c = src.codePointAt(j)!;
          if (c === 0x1b || c === 0x0a || c === 0x0d || (c < 0x20 && c !== 0x09) || c === 0x7f) break;
          const w = c > 0xffff ? 2 : 1;
          j += w;
          n += utf8Len(c);
        }
        tokLen = j - this.pos;
        bytes = n;
        shown = src.slice(this.pos, j);
      }
      // S1: the input budget, cut at a scalar boundary and never inside an escape token
      const left = this.budgets[this.part] - (this.part === 0 ? this.consumed : this.consumed - this.consumedOut);
      if (bytes > left) {
        if (shown && !sgr) {
          // (as much of a plain run as fits, whole scalars only)
          let j = this.pos, n = 0;
          while (j < this.pos + tokLen) {
            const c = src.codePointAt(j)!;
            if (n + utf8Len(c) > left) break;
            n += utf8Len(c);
            j += c > 0xffff ? 2 : 1;
          }
          if (j > this.pos && !this.show(out, src.slice(this.pos, j), err)) {
            this.stopped = true;
            continue;
          }
          this.consumed += n;
          this.pos = j;
        }
        this.stopped = true;
        continue;
      }
      if (sgr) {
        this.style = applySgr(this.style, sgr);
      } else if (nl) {
        this.flush(out);
        if (!this.newline(out, err)) {
          this.stopped = true;
          continue;
        }
      } else if (cr) {
        // (a lone \r: back to the line's start; the runs since the line began are dropped, uncounted, those this
        // slice holds and those an earlier slice returned: the painter takes those back on the restart run)
        for (const r of this.line) this.units -= r.text.length;
        this.spans -= this.line.length;
        this.line = [];
        this.lineUnits = this.pageStart = 0;
        if (this.lineOut.spans) {
          this.units -= this.lineOut.units;
          this.spans -= this.lineOut.spans;
          this.lineOut = { units: 0, spans: 0 };
          out.push({ text: "", cls: "", err, restart: true });
        }
      } else if (!this.show(out, shown, err)) {
        this.stopped = true;
        continue;
      }
      this.consumed += bytes;
      this.pos += tokLen;
    }
    // the end: the omission line, if anything wasn't shown (room for it was kept all along)
    this.flush(out);
    if (this.omitted > 0) {
      // (the omission line, on a line of its own: one run, its line end included, charged to every cap; its room
      // was kept all along: MARK_UNITS, one line, one run)
      // (mid-line: the open line has units, whichever slice its runs went out in; an empty page run is not a line start)
      const nl = this.lineUnits > 0 ? "\n" : "";
      const text = nl + Render.marker(this.omitted);
      out.push({ text, cls: "sb-omit", err: false });
      this.spans++;
      this.units += text.length;
      if (nl) this.lines++;
    }
    this.finished = true;
    return out;
  }


  /** A line end, if a line is left after keeping the omission line's (S2 lines). */
  private newline(out: Run[], err: boolean): boolean {
    // (a line end may lead onto the last line, CAPS.lines, which content never takes: it is kept for the omission
    // line, so a command shows at most CAPS.lines - 1 content lines, then the marker: CAPS.lines in all)
    if (this.lines + 1 > CAPS.lines) return false;
    if (this.units + 1 > CAPS.units - Render.MARK_UNITS) return false;
    const last = out[out.length - 1];
    // (a paged line's end: the painter puts the line end after the last page box, one node more: charged here)
    const paged = this.pageStart > 0 ? 1 : 0;
    const merge = last && !last.restart && !last.page && last.err === err && (last.cls === "" || err);
    if (this.spans + paged + (merge ? 0 : 1) > CAPS.spans - 1) return false;
    if (merge) last.text += "\n";
    else out.push({ text: "\n", cls: "", err });
    this.spans += paged + (merge ? 0 : 1);
    this.lineUnits = this.pageStart = 0;
    this.units++;
    this.lines++;
    return true;
  }

  /** Shown text, if it fits S2's code units and runs (the omission line's room kept). */
  private show(out: Run[], text: string, err: boolean): boolean {
    if (this.lines >= CAPS.lines) return false;
    if (this.units + text.length > CAPS.units - Render.MARK_UNITS) return false;
    const cls = classOf(this.style);
    const last = this.line[this.line.length - 1];
    const newRun = !(last && last.cls === cls && last.err === err);
    if (newRun && this.spans + 1 > CAPS.spans - 1) {
      // (past the run cap: the rest of the consumed text is plain)
      if (this.style !== PLAIN) this.style = { ...PLAIN };
      const plain = this.line[this.line.length - 1];
      if (!(plain && !plain.page && plain.cls === "" && plain.err === err)) return false;
      // (a page costs a run: none is left, so text past this page's edge is not shown)
      if (this.lineUnits + text.length > this.pageStart + PAGE) return false;
      plain.text += text;
      this.units += text.length;
      this.lineUnits += text.length;
      return true;
    }
    // (the line's next page boundary: up to it, then a page run, then the rest, as often as it takes; a line of at most
    // PAGE units gets no page run; a surrogate pair is never split at an edge)
    while (text) {
      const edge = this.pageStart + PAGE;
      if (this.lineUnits + text.length <= edge) break;
      let k = edge - this.lineUnits;
      // (back to a cluster boundary, at most 32 units; a boundary at the very start of this text whose first character
      // continues the previous one's cluster: the cluster's rest stays on the page before, past PAGE by that much)
      for (let b = 0; b < 32 && k > 0 && joinsCluster(text, k); b++) k--;
      if (k === 0 && joinsCluster(" " + text, 1)) {
        // (this text begins with a continuation, and the edge falls just before it: the cluster's start goes after
        // the join too, taken from the end of this line's last run (its classes kept, as its own run))
        const last = this.line[this.line.length - 1];
        let m = last && !last.page ? last.text.length : 0;
        for (let b = 0; b < 32 && m > 0 && joinsCluster(last.text + text, m); b++) m--;
        if (last && m > 0 && m < last.text.length && this.spans + 3 <= CAPS.spans - 1) {
          const tail = last.text.slice(m);
          last.text = last.text.slice(0, m);
          this.lineUnits -= tail.length;
          this.line.push({ text: "", cls: "", err, page: true });
          this.pageStart = this.lineUnits;
          this.line.push({ text: tail, cls: last.cls, err: last.err });
          this.spans += 2;
          this.lineUnits += tail.length;
          continue;
        }
        // (that run already left in an earlier slice: the cluster's rest stays on this page, past PAGE by that much)
        k = 1;
        while (k < text.length && k < 32 && joinsCluster(text, k)) k++;
      }
      if (k > 0) {
        this.push(out, text.slice(0, k), err);
        text = text.slice(k);
      }
      if (!text || this.spans + 1 > CAPS.spans - 1) break;
      this.line.push({ text: "", cls: "", err, page: true });
      this.spans++;
      this.pageStart = this.lineUnits;
    }
    this.push(out, text, err);
    return true;
  }

  /** The totals so far, for the tests and the scrollback's caps. */
  get totals() {
    return { units: this.units, spans: this.spans, lines: this.lines, consumed: this.consumed, omitted: this.omitted, work: this.work };
  }
}

// ---------------------------------------------------------------- the scrollback (E5.4: all commands)
/** E5.4's scrollback caps: UTF-16 code units, lines, runs, over every command shown, the drop marker included. */
export const SCROLLBACK = Object.freeze({ units: 4194304, lines: 6000, spans: 50000 });
export type Totals = { units: number; lines: number; spans: number };
/** The one line that says how many of the oldest commands were dropped. */
export const dropMarker = (n: number) => `[${n} earlier command${n === 1 ? "" : "s"} dropped]`;
/**
 * How many of the oldest commands to drop, whole, before a slice goes into the newest (the last of `cmds`, never
 * dropped), so that every kept command, the slice and the drop marker (charged to every cap: its code units, one
 * line, one run) fit the caps.  `dropped`: how many were dropped before.  A command's own caps are below these
 * (CAPS: 1 MiB, 5 000 lines, 20 000 runs), so the newest command always fits with its prompt, exit and the marker.
 */
export function evictCount(cmds: Totals[], slice: Totals, dropped: number, caps: Totals = SCROLLBACK): number {
  let u = 0, l = 0, s = 0;
  for (const c of cmds) (u += c.units), (l += c.lines), (s += c.spans);
  let k = 0;
  const fits = () => {
    const d = dropped + k;
    const mu = d ? dropMarker(d).length : 0, m1 = d ? 1 : 0;
    return u + slice.units + mu <= caps.units && l + slice.lines + m1 <= caps.lines && s + slice.spans + m1 <= caps.spans;
  };
  while (k < cmds.length - 1 && !fits()) {
    u -= cmds[k].units;
    l -= cmds[k].lines;
    s -= cmds[k].spans;
    k++;
  }
  return k;
}
