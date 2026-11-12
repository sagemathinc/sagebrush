// The review page's line diff: Myers' O(ND), its own, on lines interned to integers, with every comparison counted
// against a budget.  The editor's lineDiff (web/latex/posmap.ts) is not used and not changed: its trace and string
// comparisons are the editor's bounds, not the review's.
//
// Bounded, before anything is split: each side at most REVIEW_DIFF.sideBytes (UTF-8) and REVIEW_DIFF.sideLines;
// then at most `maxD` edits (the trace is at most (maxD + 1) Int32Arrays of 2·maxD + 3), and at most `budget`
// comparisons of two line ids, counted where they're made: the common prefix and suffix, each frontier step, each
// step of a snake.  Past any of them: { ok: false }, and what the call held is dropped with it.

export const REVIEW_DIFF = Object.freeze({
  /** edits at most */
  maxD: 1000,
  /** comparisons of two line ids, a file at most (a notebook's changed cells share one) */
  budget: 4_000_000,
  /** UTF-8 bytes a side */
  sideBytes: 2 * 2 ** 20,
  /** lines a side */
  sideLines: 50_000,
  /** lines a file's diff shows at most */
  renderLines: 5000,
});

/** A run of lines: unchanged (`=`, at `a` in the old and `b` in the new), deleted (`-`, at `a`) or inserted (`+`, at
 * `b`), `n` of them. */
export type Seg = { t: "=" | "-" | "+"; a: number; b: number; n: number };
export type LineDiff =
  | { ok: true; a: string[]; b: string[]; segs: Seg[]; edits: number; used: number }
  | { ok: false; why: "size" | "edits" | "budget"; used: number };

/** A text's UTF-8 length, without encoding it (an unpaired surrogate as the encoder writes it: 3 bytes). */
export function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c < 0xdc00 && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) { n += 4; i++; }
    else n += 3;
  }
  return n;
}

/** The lines of `t`, each with its newline (the last without one, if `t` doesn't end in one). */
export function splitLines(t: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < t.length) { const j = t.indexOf("\n", i); const k = j < 0 ? t.length : j + 1; out.push(t.slice(i, k)); i = k; }
  return out;
}
/** How many lines splitLines would give, without splitting. */
export function lineCount(t: string): number {
  let n = 0, i = -1;
  while ((i = t.indexOf("\n", i + 1)) >= 0) n++;
  return n + (t.length && !t.endsWith("\n") ? 1 : 0);
}

/** The line diff of `a` into `b`: its runs, in order, and its edit count (lines deleted and inserted, the least
 * there is); `budget`: the comparisons this call may make (what's left of its file's). */
export function reviewLineDiff(a: string, b: string, o: { maxD?: number; budget?: number } = {}): LineDiff {
  const maxD = o.maxD ?? REVIEW_DIFF.maxD, budget = o.budget ?? REVIEW_DIFF.budget;
  if (utf8Length(a) > REVIEW_DIFF.sideBytes || utf8Length(b) > REVIEW_DIFF.sideBytes) return { ok: false, why: "size", used: 0 };
  if (lineCount(a) > REVIEW_DIFF.sideLines || lineCount(b) > REVIEW_DIFF.sideLines) return { ok: false, why: "size", used: 0 };
  const al = splitLines(a), bl = splitLines(b);
  // (each line an integer: equal lines, equal ids; the comparisons below are of ids only)
  const ids = new Map<string, number>();
  const idOf = (s: string) => { let v = ids.get(s); if (v === undefined) { v = ids.size; ids.set(s, v); } return v; };
  const A = Int32Array.from(al, idOf), B = Int32Array.from(bl, idOf);
  ids.clear();
  let used = 0;
  const over = (): LineDiff => ({ ok: false, why: "budget", used });
  // (the common prefix and suffix, each comparison counted)
  let pre = 0;
  while (pre < A.length && pre < B.length) {
    if (++used > budget) return over();
    if (A[pre] !== B[pre]) break;
    pre++;
  }
  let suf = 0;
  while (suf < A.length - pre && suf < B.length - pre) {
    if (++used > budget) return over();
    if (A[A.length - 1 - suf] !== B[B.length - 1 - suf]) break;
    suf++;
  }
  const n = A.length - pre - suf, m = B.length - pre - suf;
  const segs: Seg[] = [];
  const push = (t: Seg["t"], ai: number, bi: number, k = 1) => {
    const l = segs[segs.length - 1];
    if (l && l.t === t && (t === "+" || l.a + l.n === ai) && (t === "-" || l.b + l.n === bi)) l.n += k;
    else segs.push({ t, a: ai, b: bi, n: k });
  };
  if (pre) push("=", 0, 0, pre);
  if (n === 0 || m === 0) {
    if (n) push("-", pre, pre, n);
    if (m) push("+", pre + n, pre, m);
  } else {
    const MAX = Math.min(n + m, maxD), off = MAX + 1;
    const a0 = A.subarray(pre, pre + n), b0 = B.subarray(pre, pre + m);
    const v = new Int32Array(2 * MAX + 3);
    const trace: Int32Array[] = [];
    let D = -1;
    outer: for (let d = 0; d <= MAX; d++) {
      trace.push(v.slice());
      for (let k = -d; k <= d; k += 2) {
        if (++used > budget) return over();
        let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
        let y = x - k;
        while (x < n && y < m) {
          if (++used > budget) return over();
          if (a0[x] !== b0[y]) break;
          x++; y++;
        }
        v[off + k] = x;
        if (x >= n && y >= m) { D = d; break outer; }
      }
    }
    if (D < 0) return { ok: false, why: "edits", used };
    // (the edit script traced back, last edit first, then replayed in order)
    const ops: [Seg["t"], number, number][] = [];
    let x = n, y = m;
    for (let d = D; d > 0; d--) {
      const w = trace[d], k = x - y;
      const down = k === -d || (k !== d && w[off + k - 1] < w[off + k + 1]);
      const pk = down ? k + 1 : k - 1, px = w[off + pk], py = px - pk;
      while (x > px && y > py) { x--; y--; ops.push(["=", x, y]); }
      if (down) ops.push(["+", x, py]); else ops.push(["-", px, y]);
      x = px; y = py;
    }
    while (x > 0 && y > 0) { x--; y--; ops.push(["=", x, y]); }
    trace.length = 0;
    for (let i = ops.length - 1; i >= 0; i--) push(ops[i][0], pre + ops[i][1], pre + ops[i][2]);
  }
  if (suf) push("=", A.length - suf, B.length - suf, suf);
  const edits = segs.reduce((s, g) => s + (g.t === "=" ? 0 : g.n), 0);
  return { ok: true, a: al, b: bl, segs, edits, used };
}
