// Whether two edits of a text overlap, and their merge when they don't: the boards' three-way merge of text
// (boardMerge3; plan-sync-slice2-client r4 §2.1; the ruling of Oct 26: overlapping edits are a clash).  Notebooks merge
// text exactly instead, as CoCalc's Jupyter does (history.js, plan-exact-only r1).
//
// A text is its lines, each with its line break (the last may have none).  Each side's edit is its hunks against
// the base, from a longest common subsequence of lines after the common prefix and suffix: a half-open range
// [from, to) of the base's lines and what replaces it (an insertion has from === to).  A hunk of `a` and one of
// `b` overlap when
//   - both replace lines and their ranges share a line;
//   - one inserts at a line the other's range begins, covers or ends at (inclusive: an insertion beside a
//     replaced line is ambiguous, before or after the new text, so it counts: astra's "ambiguous ranges");
//   - both insert at the same place, differently.
// The same hunk on both sides (the same edit) doesn't overlap.  The decision is symmetric in `a` and `b`.
//
// The work is counted in (base lines × side lines) of each diff's middle, and charged to the caller's ledger
// before the diff's table is made; a diff past TEXT_DIFF_PRODUCT_LIMIT, or past what the ledger has left, isn't made:
// "exhausted", which the caller takes as a clash (or a refused merge), never as a guess.

/** One diff's largest table, in (base lines × side lines): patchflow's MAX_DIFF_PRODUCT. */
export const TEXT_DIFF_PRODUCT_LIMIT = 4_000_000;

export type Ledger = { left: number };
type Hunk = { from: number; to: number; ins: string };

/** Whether `a` and `b` changed the same lines of `base`; "exhausted" past the work bound (nothing charged for a
 * diff not made). */
export function textOverlap(base: string, a: string, b: string, ledger: Ledger): boolean | "exhausted" {
  const c = changes(base, a, b, ledger);
  return c === "exhausted" ? c : c.overlap;
}

/** lineMerge3's answer, tagged: a merged text can be any string, "exhausted" included, so it is never confused
 * with a refusal (astra's HOLD on #197). */
export type LineMerge = { text: string } | { overlap: true } | { exhausted: true };

/** `a` and `b` merged against `base` when their edits don't overlap: {text}, both sides' hunks applied to the
 * base's lines (the same hunk once), so nothing of either is lost; {overlap: true} when they overlap;
 * {exhausted: true} past the work bound. */
export function lineMerge3(base: string, a: string, b: string, ledger: Ledger): LineMerge {
  if (a === b) return { text: a };
  if (a === base) return { text: b };
  if (b === base) return { text: a };
  const c = changes(base, a, b, ledger);
  if (c === "exhausted") return { exhausted: true };
  if (c.overlap) return { overlap: true };
  const L0 = lines(base);
  const all = [...c.ha, ...c.hb.filter((y) => !c.ha.some((x) => sameHunk(x, y)))].sort((x, y) => x.from - y.from || x.to - y.to);
  let out = "", at = 0;
  for (const h of all) {
    out += L0.slice(at, h.from).join("") + h.ins;
    at = h.to;
  }
  return { text: out + L0.slice(at).join("") };
}

function changes(base: string, a: string, b: string, ledger: Ledger): { overlap: boolean; ha: Hunk[]; hb: Hunk[] } | "exhausted" {
  const L0 = lines(base);
  const ha = hunks(L0, lines(a), ledger);
  if (ha === "exhausted") return ha;
  const hb = hunks(L0, lines(b), ledger);
  if (hb === "exhausted") return hb;
  for (const x of ha) for (const y of hb) if (!sameHunk(x, y) && touch(x, y)) return { overlap: true, ha, hb };
  return { overlap: false, ha, hb };
}

const sameHunk = (x: Hunk, y: Hunk) => x.from === y.from && x.to === y.to && x.ins === y.ins;
// (the three overlaps above; symmetric)
function touch(x: Hunk, y: Hunk): boolean {
  const xi = x.from === x.to, yi = y.from === y.to;
  if (xi && yi) return x.from === y.from;
  if (xi) return y.from <= x.from && x.from <= y.to;
  if (yi) return x.from <= y.from && y.from <= x.to;
  return x.from < y.to && y.from < x.to;
}

// (a text's lines, each with its line break: "a\nb" is ["a\n", "b"])
function lines(t: string): string[] {
  return t === "" ? [] : (t.match(/[^\n]*\n|[^\n]+$/g) as string[]);
}

// The changes from `L0` to `L1` as hunks, in order; "exhausted" if the middle's table is past TEXT_DIFF_PRODUCT_LIMIT
// or past what the ledger has left (charged before it is made).
function hunks(L0: string[], L1: string[], ledger: Ledger): Hunk[] | "exhausted" {
  let p = 0;
  while (p < L0.length && p < L1.length && L0[p] === L1[p]) p++;
  let s = 0;
  while (s < L0.length - p && s < L1.length - p && L0[L0.length - 1 - s] === L1[L1.length - 1 - s]) s++;
  const X = L0.slice(p, L0.length - s), Y = L1.slice(p, L1.length - s);
  const n = X.length, m = Y.length;
  if (n === 0 && m === 0) return [];
  // (one side empty: the whole middle replaced, no table)
  if (n === 0 || m === 0) return [{ from: p, to: p + n, ins: Y.join("") }];
  const work = n * m;
  if (work > TEXT_DIFF_PRODUCT_LIMIT || work > ledger.left) return "exhausted";
  ledger.left -= work;
  // (lcs[i][j]: the longest common subsequence of X[i..] and Y[j..])
  const lcs = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i][j] = X[i] === Y[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const out: Hunk[] = [];
  let i = 0, j = 0, open: { from: number; j: number } | null = null;
  const close = () => {
    if (open) out.push({ from: p + open.from, to: p + i, ins: Y.slice(open.j, j).join("") });
    open = null;
  };
  while (i < n || j < m) {
    if (i < n && j < m && X[i] === Y[j]) {
      close();
      i++;
      j++;
      continue;
    }
    if (!open) open = { from: i, j };
    if (j < m && (i === n || lcs[i][j + 1] >= lcs[i + 1][j])) j++;
    else i++;
  }
  close();
  return out;
}
