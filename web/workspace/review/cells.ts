// A notebook's cells compared, base to head, for the review page: the longest common subsequence of the cells' keys
// (type and code), each cell's key an integer (one Map per cell type, holding the documents' own code strings: no
// copies), the common prefix and suffix first, then one Uint16Array table, checked against its bound before it is
// made.  Cells that differ between two kept ones are paired in order, a deleted with an inserted of the same type:
// one changed cell (its code's line diff is the page's).

export const CELL_LIMITS = Object.freeze({ cells: 2000 });

export type CellKey = { type: string; code: string };
/** unchanged (`=`), changed (`~`, its code differs), deleted (`-`, base's `a`), inserted (`+`, head's `b`) */
export type CellRow = { t: "=" | "~"; a: number; b: number } | { t: "-"; a: number } | { t: "+"; b: number };

/** `rows` with each run of unchanged cells as one fold, its count (the page shows "12 unchanged cells"). */
export function foldRows(rows: CellRow[]): (CellRow | { fold: number; a: number; b: number })[] {
  const out: (CellRow | { fold: number; a: number; b: number })[] = [];
  for (const r of rows) {
    const last = out[out.length - 1];
    if (r.t === "=" && last && "fold" in last) last.fold++;
    else out.push(r.t === "=" ? { fold: 1, a: r.a, b: r.b } : r);
  }
  return out;
}

/** The rows from `base` to `head`, or null past CELL_LIMITS (nothing allocated for the table). */
export function cellDiff(base: CellKey[], head: CellKey[]): CellRow[] | null {
  if (base.length > CELL_LIMITS.cells || head.length > CELL_LIMITS.cells) return null;
  const byType = new Map<string, Map<string, number>>();
  let next = 0;
  const id = (c: CellKey) => {
    let m = byType.get(c.type);
    if (!m) { m = new Map(); byType.set(c.type, m); }
    let v = m.get(c.code);
    if (v === undefined) { v = next++; m.set(c.code, v); }
    return v;
  };
  const A = Int32Array.from(base, id), B = Int32Array.from(head, id);
  byType.clear();
  let pre = 0;
  while (pre < A.length && pre < B.length && A[pre] === B[pre]) pre++;
  let suf = 0;
  while (suf < A.length - pre && suf < B.length - pre && A[A.length - 1 - suf] === B[B.length - 1 - suf]) suf++;
  const n = A.length - pre - suf, m = B.length - pre - suf, w = m + 1;
  // (L[i·w + j]: the LCS of the middle's suffixes from i and j; at most 2000, so 16 bits)
  const L = new Uint16Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      L[i * w + j] = A[pre + i] === B[pre + j] ? L[(i + 1) * w + j + 1] + 1 : Math.max(L[(i + 1) * w + j], L[i * w + j + 1]);
  const rows: CellRow[] = [];
  for (let k = 0; k < pre; k++) rows.push({ t: "=", a: k, b: k });
  // (between two kept cells: the deleted and the inserted, in order, paired by type where they meet)
  let dels: number[] = [], ins: number[] = [];
  const flush = () => {
    const k = Math.max(dels.length, ins.length);
    for (let x = 0; x < k; x++) {
      const a = dels[x], b = ins[x];
      if (a !== undefined && b !== undefined && base[a].type === head[b].type) rows.push({ t: "~", a, b });
      else { if (a !== undefined) rows.push({ t: "-", a }); if (b !== undefined) rows.push({ t: "+", b }); }
    }
    dels = []; ins = [];
  };
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && A[pre + i] === B[pre + j]) { flush(); rows.push({ t: "=", a: pre + i, b: pre + j }); i++; j++; }
    // (ties: the base's cell deleted before the head's is inserted)
    else if (j >= m || (i < n && L[(i + 1) * w + j] >= L[i * w + j + 1])) { dels.push(pre + i); i++; }
    else { ins.push(pre + j); j++; }
  }
  flush();
  for (let k = 0; k < suf; k++) rows.push({ t: "=", a: A.length - suf + k, b: B.length - suf + k });
  return rows;
}
