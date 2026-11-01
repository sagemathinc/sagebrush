// The LaTeX editor's highlighter (plan sbspace r5 §4, P4): the source's lines drawn behind the textarea, colored by
// a line tokenizer whose start state per line is cached. An edit rescans from its first changed line until a line's
// computed start state equals the cached one past the edit (convergence). Bounded per input event: at most
// SLICE.lines lines, SLICE.bytes of source and SLICE.ms, the time checked every SLICE.check tokens (a line's
// tokenizer is a generator, so a long line resumes where it stopped); then it continues in later slices. A line over
// LONG_LINE is plain (its end state "unknown", reset to normal). If an edit hasn't converged within FALLBACK_MS, the
// lines not yet rescanned are drawn plain until done. A file over PLAIN_FILE isn't highlighted at all.
import { mark } from "./marks";

export const SLICE = { lines: 2000, bytes: 64 * 1024, ms: 8, check: 256 };
export const LONG_LINE = 16 * 1024, FALLBACK_MS = 150, PLAIN_FILE = 2 ** 20;
export type State = string;   // "N" normal, "M" inline math, "D" display math, "E:env" a math environment, "V:env" verbatim
type Tok = [cls: string, text: string];
const VERB = new Set(["verbatim", "verbatim*", "Verbatim", "lstlisting", "minted", "comment", "sageblock", "sagesilent", "sagecommandline", "pycode", "pyblock"]);
const MATHENV = new Set(["equation", "equation*", "align", "align*", "gather", "gather*", "multline", "multline*", "eqnarray", "eqnarray*", "displaymath", "math"]);
const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };
const esc = (s: string) => s.replace(/[&<>]/g, (c) => ESC[c]);

/** One line's tokens (yielded) and its end state (returned). */
export function* tokenizeLine(line: string, state: State): Generator<Tok, State, void> {
  let i = 0;
  // (a blank line ends $...$, $$...$$, \(...\) and \[...\] as it does for the renderer: an unclosed formula being typed
  // doesn't color the rest of the file as math)
  if ((state === "M" || state === "D") && /^[ \t]*$/.test(line)) return "N";
  if (state.startsWith("V:")) {
    const env = state.slice(2), end = line.indexOf("\\end{" + env + "}");
    if (end < 0) { yield ["c-verb", line]; return state; }
    if (end > 0) yield ["c-verb", line.slice(0, end)];
    i = end; state = "N";
  }
  const inMath = () => state !== "N";
  while (i < line.length) {
    const c = line[i];
    if (c === "%") { yield ["c-cmt", line.slice(i)]; break; }
    if (c === "\\") {
      const m = /^\\([A-Za-z@]+\*?|.)/.exec(line.slice(i));
      const cs = m ? m[0] : "\\";
      if (cs === "\\[") state = "D"; else if (cs === "\\]" && state === "D") state = "N";
      else if (cs === "\\(") state = "M"; else if (cs === "\\)" && state === "M") state = "N";
      if (cs === "\\begin" || cs === "\\end") {
        const env = /^\{([^}]*)\}/.exec(line.slice(i + cs.length));
        // (a math environment's \begin and \end both in math's color, as $ and \[ \] are: the \begin that opens it
        //  is colored as the math it starts, its \end as the math it closes)
        const opens = !!env && cs === "\\begin" && MATHENV.has(env[1]) && state === "N";
        yield [inMath() || opens ? "c-math c-cmd" : "c-cmd", cs + (env ? env[0] : "")];
        i += cs.length + (env ? env[0].length : 0);
        if (env && cs === "\\begin" && VERB.has(env[1])) { const rest = line.slice(i); const endAt = rest.indexOf("\\end{" + env[1] + "}"); if (endAt < 0) { if (rest) yield ["c-verb", rest]; return "V:" + env[1]; } if (endAt) yield ["c-verb", rest.slice(0, endAt)]; i += endAt; continue; }
        if (env && cs === "\\begin" && MATHENV.has(env[1]) && state === "N") state = "E:" + env[1];
        else if (env && cs === "\\end" && state === "E:" + env[1]) state = "N";
        continue;
      }
      yield [inMath() || cs === "\\]" || cs === "\\)" ? "c-math c-cmd" : "c-cmd", cs];
      i += cs.length; continue;
    }
    if (c === "$") {
      const dbl = line[i + 1] === "$";
      if (dbl) state = state === "D" ? "N" : state === "N" ? "D" : state; else state = state === "M" ? "N" : state === "N" ? "M" : state;
      yield ["c-math", dbl ? "$$" : "$"]; i += dbl ? 2 : 1; continue;
    }
    if (c === "{" || c === "}") { yield [inMath() ? "c-math" : "c-brace", c]; i++; continue; }
    const m = /^[^\\%${}]+/.exec(line.slice(i))!;
    yield [inMath() ? "c-math" : "", m[0]]; i += m[0].length;
  }
  return state;
}

export class Highlighter {
  lines: string[] = [];
  start: State[] = [];          // the cached start state of each line
  els: HTMLElement[] = [];
  job: { at: number; state: State; until: number; gen: Generator<Tok, State, void> | null; html: string; t0: number; busy: number; plainShown: boolean } | null = null;
  timer: any = null;
  stats = { linesRescanned: 0, bytesRescanned: 0, maxSliceMs: 0 };
  /** How many lines are over LONG_LINE now (the page doesn't wrap the source while there is one), kept per edit. */
  longLines = 0;
  constructor(readonly root: HTMLElement, text: string, readonly off: boolean) {
    this.reset(text);
  }
  private lineEl(text: string) { const d = document.createElement("div"); d.className = "hl-line"; d.textContent = text || "​"; return d; }
  private countLong(lines: string[]) { let n = 0; for (const l of lines) if (l.length > LONG_LINE) n++; return n; }
  reset(text: string) {
    this.lines = text.split("\n");
    this.longLines = this.countLong(this.lines);
    this.start = this.lines.map(() => "?");
    this.root.textContent = "";
    this.els = this.lines.map((l) => this.lineEl(l));
    this.root.append(...this.els);
    if (this.off || text.length > PLAIN_FILE) return;
    this.schedule(0, "N", this.lines.length, performance.now());
  }
  /** The textarea's new text: the changed lines replaced (plain), then rescanned from the first of them. The cached
   * start states of the unchanged lines after the edit are kept: convergence compares against them. */
  update(text: string) {
    const tU = performance.now();
    const next = text.split("\n");
    let p = 0; const n = Math.min(this.lines.length, next.length);
    while (p < n && this.lines[p] === next[p]) p++;
    let s = 0;
    while (s < n - p && this.lines[this.lines.length - 1 - s] === next[next.length - 1 - s]) s++;
    const oldMid = this.lines.length - s - p, newMid = next.length - s - p;
    const fresh = next.slice(p, p + newMid);
    this.longLines += this.countLong(fresh) - this.countLong(this.lines.slice(p, p + oldMid));
    const els = fresh.map((l) => this.lineEl(l));
    for (let k = 0; k < oldMid; k++) this.els[p + k].remove();
    const before = this.els[p + oldMid] ?? null;
    for (const e of els) this.root.insertBefore(e, before);
    this.els.splice(p, oldMid, ...els);
    // (the first changed line starts where the unchanged line before it ended: its old start state)
    const from = p > 0 && (p >= this.start.length || this.start[p] === "?") ? p - 1 : p;
    const init = this.start[from] ?? "N";
    this.start.splice(p, oldMid, ...fresh.map(() => "?"));
    this.lines = next;
    if (this.off || text.length > PLAIN_FILE) {
      for (const e of this.els) if (e.childElementCount) e.textContent = e.textContent;
      const ms = performance.now() - tU; mark("tex-highlight-done", { wall: ms, busy: ms, plain: true });
      return;
    }
    this.schedule(from, init, p + newMid, tU);
  }
  // (t0: when the edit reached the highlighter; busy counts its own time, the slices and the line diff before them)
  private schedule(from: number, init: State, editEnd: number, t0: number) {
    clearTimeout(this.timer);
    this.start[from] = init === "?" ? "N" : init;
    this.job = { at: from, state: this.start[from], until: editEnd, gen: null, html: "", t0, busy: performance.now() - t0, plainShown: false };
    this.slice();
  }
  /** One bounded slice of the rescan; schedules the next. */
  slice() {
    const j = this.job; if (!j) return;
    const t0 = performance.now(); let lines = 0, bytes = 0, toks = 0;
    while (j.at < this.lines.length) {
      const line = this.lines[j.at];
      let end: State;
      if (line.length > LONG_LINE) { this.els[j.at].textContent = line || "\u200b"; end = "N"; }
      else {
        if (!j.gen) { j.gen = tokenizeLine(line, j.state); j.html = ""; }
        for (;;) {
          const r = j.gen.next();
          if (r.done) { end = r.value; break; }
          const [cls, t] = r.value;
          j.html += cls ? '<span class="' + cls + '">' + esc(t) + "</span>" : esc(t);
          if (++toks % SLICE.check === 0 && performance.now() - t0 > SLICE.ms) return this.later(t0);
        }
        this.els[j.at].innerHTML = j.html || "\u200b";
        j.gen = null;
      }
      lines++; bytes += line.length + 1; this.stats.linesRescanned++; this.stats.bytesRescanned += line.length + 1;
      const nextAt = j.at + 1;
      // (converged: past the edit, and the next line's cached start state is what this one ends in)
      if (nextAt < this.lines.length && nextAt >= j.until && this.start[nextAt] === end) { this.done(t0); return; }
      if (nextAt < this.lines.length) this.start[nextAt] = end;
      j.at = nextAt; j.state = end;
      if (lines >= SLICE.lines || bytes >= SLICE.bytes || performance.now() - t0 > SLICE.ms) return this.later(t0);
    }
    this.done(t0);
  }
  private later(t0: number) {
    const j = this.job!;
    j.busy += performance.now() - t0;
    this.stats.maxSliceMs = Math.max(this.stats.maxSliceMs, 0);
    // (not converged within FALLBACK_MS of the edit: what isn't rescanned yet is drawn plain until it is)
    if (!j.plainShown && performance.now() - j.t0 > FALLBACK_MS) {
      j.plainShown = true;
      for (let k = j.at + 1; k < this.lines.length; k++) if (this.els[k].childElementCount) this.els[k].textContent = this.lines[k] || "​";
    }
    this.timer = setTimeout(() => this.slice(), 0);
  }
  private done(t0: number) {
    const now = performance.now(), j = this.job!;
    this.stats.maxSliceMs = Math.max(this.stats.maxSliceMs, now - t0);
    // (§6: the rescan converged; wall from the edit, busy its own time)
    mark("tex-highlight-done", { wall: now - j.t0, busy: j.busy + (now - t0) });
    this.job = null;
  }
}
