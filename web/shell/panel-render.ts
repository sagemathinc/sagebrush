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

export type Run = { text: string; cls: string; err: boolean };

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
  private budgets: [number, number];
  // (the current line's runs since its last \r: a lone \r drops them before they are returned)
  private line: Run[] = [];
  readonly totalBytes: number;

  constructor(private out: string, private err: string, private now: () => number = () => performance.now()) {
    const ob = utf8Bytes(out), eb = utf8Bytes(err);
    this.totalBytes = ob + eb;
    const errKeep = Math.min(eb, CAPS.errReserve);
    const outBudget = Math.min(ob, CAPS.inBytes - errKeep);
    this.budgets = [outBudget, Math.min(eb, CAPS.inBytes - outBudget)];
  }

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
  private flush(out: Run[]) {
    for (const r of this.line) out.push(r);
    this.line = [];
  }

  /** The next slice's runs, or null when the output is done. */
  next(budget: { bytes: number; spans: number; ms: number } = SLICE): Run[] | null {
    if (this.finished) return null;
    const out: Run[] = [];
    const t0 = this.now();
    const b0 = this.consumed, s0 = this.spans;
    while (this.part < 2) {
      if (this.consumed - b0 >= budget.bytes || this.spans - s0 >= budget.spans || this.now() - t0 >= budget.ms) {
        this.flush(out);
        return out;
      }
      const src = this.part === 0 ? this.out : this.err;
      const err = this.part === 1;
      if (this.stopped || this.pos >= src.length) {
        // (this part's end: what wasn't consumed is omitted, counted exactly in original bytes)
        if (this.pos < src.length) this.omitted += utf8Bytes(src.slice(this.pos));
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
      const left = this.budgets[this.part] - (this.part === 0 ? this.consumed : this.consumed - this.budgets[0]);
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
        // (a lone \r: back to the line's start; the runs since the line began are dropped, uncounted)
        for (const r of this.line) this.units -= r.text.length;
        this.spans -= this.line.length;
        this.line = [];
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
      if (this.units > 0 && !this.atLineStart(out)) {
        out.push({ text: "\n", cls: "", err: false });
        this.lines++;
      }
      out.push({ text: Render.marker(this.omitted), cls: "sb-omit", err: false });
      this.spans++;
      this.units += Render.marker(this.omitted).length;
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
    if (this.lines + 1 > CAPS.lines - 1) return false;
    if (this.units + 1 > CAPS.units - Render.MARK_UNITS) return false;
    const last = out[out.length - 1];
    if (last && last.err === err && (last.cls === "" || err)) last.text += "\n";
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
    return { units: this.units, spans: this.spans, lines: this.lines, consumed: this.consumed, omitted: this.omitted };
  }
}
