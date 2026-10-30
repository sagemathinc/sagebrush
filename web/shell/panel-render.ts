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

/** A run of one style; `restart`: a lone \r over runs of the open line already returned in an earlier slice:
 * the painter removes what it put in for this line since its start (TP-2: the same text whatever the slicing). */
export type Run = { text: string; cls: string; err: boolean; restart?: true };

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
  // (the bytes scanned without being consumed: the stderr reservation's look, the omitted tail's count; charged
  // to the same slice budget as consumed input, so no slice does more than its budget of scanning: E5.5)
  private work = 0;
  // (the current line's runs since its last \r: a lone \r drops them before they are returned)
  private line: Run[] = [];
  // (the open line's runs already returned at a slice's end: units and runs, for a later lone \r to take back)
  private lineOut = { units: 0, spans: 0 };

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
    if (last && last.cls === cls && last.err === err) last.text += text;
    else {
      this.line.push({ text, cls, err });
      this.spans++;
    }
    this.units += text.length;
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
    if (!this.budgets) {
      // (stderr's reservation needs only its first 64 KiB: scanned no further, and charged)
      let eb = 0;
      for (let j = 0; j < this.err.length && eb < CAPS.errReserve; ) {
        const c = this.err.codePointAt(j)!;
        eb += utf8Len(c);
        j += c > 0xffff ? 2 : 1;
      }
      this.work += eb;
      this.budgets = [CAPS.inBytes - Math.min(eb, CAPS.errReserve), 0];
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
        let j = this.pos, n = 0;
        const lim = budget.bytes - spent();
        while (j < src.length && n < lim) {
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
      const nl = this.units > 0 && !this.atLineStart(out) ? "\n" : "";
      const text = nl + Render.marker(this.omitted);
      out.push({ text, cls: "sb-omit", err: false });
      this.spans++;
      this.units += text.length;
      if (nl) this.lines++;
    }
    this.finished = true;
    return out;
  }

  private lastText = "";
  private atLineStart(out: Run[]) {
    const t = out.length ? out[out.length - 1].text : this.lastText;
    return t === "" || t.endsWith("\n");
  }

  /** A line end, if a line is left after keeping the omission line's (S2 lines). */
  private newline(out: Run[], err: boolean): boolean {
    // (a line end may lead onto the last line, CAPS.lines, which content never takes: it is kept for the omission
    // line, so a command shows at most CAPS.lines - 1 content lines, then the marker: CAPS.lines in all)
    if (this.lines + 1 > CAPS.lines) return false;
    if (this.units + 1 > CAPS.units - Render.MARK_UNITS) return false;
    const last = out[out.length - 1];
    if (last && !last.restart && last.err === err && (last.cls === "" || err)) last.text += "\n";
    else {
      if (this.spans + 1 > CAPS.spans - 1) return false;
      out.push({ text: "\n", cls: "", err });
      this.spans++;
    }
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
      if (!(plain && plain.cls === "" && plain.err === err)) return false;
      plain.text += text;
      this.units += text.length;
      return true;
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
