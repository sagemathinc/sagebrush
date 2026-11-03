// Positions through edits (plan L1b r4b §2 items 1 and 1b, §5 step 0): the LaTeX editor's own marker mapping, as
// CodeMirror's mapPos does for its documents (William, Nov 2: "if we were using Codemirror ... it would track how that
// moves on every edit operation. Since our editor is 'from scratch' we have to own that"). The code items of a .tex
// keep their identity through the person's edits, an undo or redo, and the changes that come from outside (another
// tab, an agent, sync, git), because each edit is a change set and every item's range is mapped through it.
//
// A change set is a list of changes {from, to, insert}, in OLD-text coordinates (UTF-16 offsets), sorted by `from`,
// non-overlapping (a change may touch the next: to === next.from): the text [from, to) is replaced by `insert`
// characters. All the changes of a set are applied at once.
//
// A position is a gap between two characters, and it follows them:
//   - its left character kept: just after it (what follows it was deleted or inserted);
//   - its left character deleted, its right one kept: just before the right one;
//   - both kept with text inserted between them, or both deleted: by its bias, before (-1) or after (+1) the text
//     inserted there.
// (The document's ends count as characters always kept.) An item's range [start, end) maps its start with bias +1 and
// its end with bias -1, so text typed at either edge of an item stays outside it; an item all of whose characters
// were deleted maps to an empty range.
// Pure: test-latex-posmap.mjs checks it against a reference that tracks each character's identity.

export interface Change { from: number; to: number; insert: number }
export type ChangeSet = readonly Change[];
export type Bias = -1 | 1;

/** Whether `cs` is a well-formed change set for a text of `len` characters. */
export function validChanges(cs: ChangeSet, len: number): boolean {
  let last = 0;
  for (const c of cs) {
    if (!Number.isInteger(c.from) || !Number.isInteger(c.to) || !Number.isInteger(c.insert)) return false;
    if (c.from < last || c.to < c.from || c.to > len || c.insert < 0) return false;
    last = c.to;
  }
  return true;
}

/** `pos` (a gap of the old text) in the new text. Changes that touch (one's `to` the next's `from`) are taken as one
 * region: a gap between them has no kept character on one side, so it is inside the region (by its bias), or at its
 * end (its right character kept: after everything inserted). */
export function mapPos(pos: number, cs: ChangeSet, bias: Bias = -1): number {
  let delta = 0, i = 0;
  while (i < cs.length) {
    const from = cs[i].from;
    let to = cs[i].to, ins = cs[i].insert;
    while (i + 1 < cs.length && cs[i + 1].from === to) { i++; to = cs[i].to; ins += cs[i].insert; }
    i++;
    if (from > pos) break;
    if (to < pos) { delta += ins - (to - from); continue; }
    if (from === to) return pos + delta + (bias > 0 ? ins : 0); // a pure insertion at the gap: by the bias
    if (pos === from) return from + delta; // its left character kept: before the inserted text
    if (pos === to) return from + delta + ins; // its right character kept: after it
    return from + delta + (bias > 0 ? ins : 0); // inside the deleted text: by the bias
  }
  return pos + delta;
}

/** A range [start, end) in the new text: start with bias +1, end with bias -1 (an edit at its edges stays outside);
 * empty (start === end) if all of it was deleted or it was empty. */
export function mapRange(start: number, end: number, cs: ChangeSet): { start: number; end: number } {
  const s = mapPos(start, cs, 1), e = mapPos(end, cs, -1);
  return e <= s ? { start: s, end: s } : { start: s, end: e };
}

/** The text after the change set, given the inserted texts (one per change, in order). */
export function applyChanges(text: string, cs: ChangeSet, inserted: readonly string[]): string {
  let out = "", at = 0;
  cs.forEach((c, i) => { out += text.slice(at, c.from) + inserted[i]; at = c.to; });
  return out + text.slice(at);
}

/** The inverse change set (new-text coordinates back to old), for an undo. */
export function invertChanges(cs: ChangeSet): Change[] {
  let delta = 0;
  return cs.map((c) => { const from = c.from + delta; delta += c.insert - (c.to - c.from); return { from, to: from + c.insert, insert: c.to - c.from }; });
}

/** The single change turning `a` into `b` (their common prefix and suffix: exact for one edited region), or none. */
export function singleEdit(a: string, b: string): Change[] {
  if (a === b) return [];
  let p = 0;
  const n = Math.min(a.length, b.length);
  while (p < n && a.charCodeAt(p) === b.charCodeAt(p)) p++;
  let s = 0;
  while (s < n - p && a.charCodeAt(a.length - 1 - s) === b.charCodeAt(b.length - 1 - s)) s++;
  return [{ from: p, to: a.length - s, insert: b.length - s - p }];
}

/** A line diff of `a` into `b` (Myers' O(ND) over lines; for a change that touches several regions: a git accept, a
 * replacement from sync): one change per hunk, in `a`'s coordinates, whole lines, sorted, non-overlapping, and the
 * texts each inserts. Bounded: a diff whose edit distance exceeds `maxD` lines falls back to one change of everything
 * between the common prefix and suffix. */
export function lineDiff(a: string, b: string, maxD = 4000): { changes: Change[]; inserted: string[] } {
  if (a === b) return { changes: [], inserted: [] };
  const split = (t: string) => { const out: string[] = []; let i = 0; while (i < t.length) { const j = t.indexOf("\n", i); const k = j < 0 ? t.length : j + 1; out.push(t.slice(i, k)); i = k; } return out; };
  const A = split(a), B = split(b);
  const offA: number[] = [0]; for (const l of A) offA.push(offA[offA.length - 1] + l.length);
  // (common prefix and suffix of lines first)
  let pre = 0; while (pre < A.length && pre < B.length && A[pre] === B[pre]) pre++;
  let suf = 0; while (suf < A.length - pre && suf < B.length - pre && A[A.length - 1 - suf] === B[B.length - 1 - suf]) suf++;
  const a0 = A.slice(pre, A.length - suf), b0 = B.slice(pre, B.length - suf);
  // (Myers: the furthest-reaching paths, then the edit script traced back)
  const N = a0.length, M = b0.length, MAX = Math.min(N + M, maxD);
  const trace: Int32Array[] = [];
  const v = new Int32Array(2 * MAX + 3);
  let found = -1;
  outer: for (let d = 0; d <= MAX; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[MAX + 1 + k - 1] < v[MAX + 1 + k + 1]) ? v[MAX + 1 + k + 1] : v[MAX + 1 + k - 1] + 1;
      let y = x - k;
      while (x < N && y < M && a0[x] === b0[y]) { x++; y++; }
      v[MAX + 1 + k] = x;
      if (x >= N && y >= M) { found = d; break outer; }
    }
  }
  const lineHunks: { a0: number; a1: number; b0: number; b1: number }[] = [];
  if (found < 0) lineHunks.push({ a0: 0, a1: N, b0: 0, b1: M });
  else {
    // (the path back: each step a deletion or an insertion, then the diagonal; collected as hunks)
    const steps: ["d" | "i", number, number][] = [];
    let x = N, y = M;
    for (let d = found; d > 0; d--) {
      const w = trace[d], k = x - y;
      const down = k === -d || (k !== d && w[MAX + 1 + k - 1] < w[MAX + 1 + k + 1]);
      const pk = down ? k + 1 : k - 1, px = w[MAX + 1 + pk], py = px - pk;
      while (x > px + (down ? 0 : 1) && y > py + (down ? 1 : 0)) { x--; y--; }
      if (down) { steps.push(["i", px, py]); y = py; x = px; } else { steps.push(["d", px, py]); x = px; y = py; }
    }
    steps.reverse();
    for (const [kind, sx, sy] of steps) {
      const last = lineHunks[lineHunks.length - 1];
      const ax0 = kind === "d" ? sx : sx, ax1 = kind === "d" ? sx + 1 : sx, by0 = sy, by1 = kind === "i" ? sy + 1 : sy;
      if (last && last.a1 === ax0 && last.b1 === by0) { last.a1 = ax1; last.b1 = by1; }
      else lineHunks.push({ a0: ax0, a1: ax1, b0: by0, b1: by1 });
    }
  }
  const changes: Change[] = [], inserted: string[] = [];
  for (const h of lineHunks) {
    const from = offA[pre + h.a0], to = offA[pre + h.a1], ins = b0.slice(h.b0, h.b1).join("");
    changes.push({ from, to, insert: ins.length }); inserted.push(ins);
  }
  return { changes, inserted };
}
