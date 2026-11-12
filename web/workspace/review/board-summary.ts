// A board's items, base to head, as counts (the review page's board row): each object with a string `id` is an item,
// its signature its own JSON with every item inside it written as its id alone, so each value of the document is
// written into exactly one signature (linear in the document, however its items nest), and the walk keeps its own
// stack (no recursion, however deep).  A signature too deep for JSON.stringify gives no summary: null.

export type BoardCounts = { added: number; removed: number; changed: number; bytes: number };

const isItem = (v: unknown): v is { id: string } => !!v && typeof v === "object" && !Array.isArray(v) && typeof (v as { id?: unknown }).id === "string";

/** Each item's signature, by id; `bytes`: their lengths together (UTF-16 units). Null if one can't be written. */
export function itemSignatures(doc: unknown): { sigs: Map<string, string>; bytes: number } | null {
  const sigs = new Map<string, string>();
  let bytes = 0;
  const stack: unknown[] = [doc];
  while (stack.length) {
    const v = stack.pop();
    if (!v || typeof v !== "object") continue;
    if (isItem(v)) {
      let sig: string;
      // (its own JSON, the items inside it as their ids; those are walked as items of their own)
      try { sig = JSON.stringify(v, function (this: unknown, k, x) { return k !== "" && isItem(x) && x !== v ? { "#": x.id } : x; }); }
      catch { return null; }
      sigs.set(v.id, sig);
      bytes += sig.length;
    }
    // (only the nearest items are pushed for their own signatures; everything else is inside this one's)
    const kids = Array.isArray(v) ? v : Object.values(v);
    if (isItem(v)) { const inner: unknown[] = [...kids]; while (inner.length) { const x = inner.pop(); if (isItem(x)) stack.push(x); else if (x && typeof x === "object") inner.push(...(Array.isArray(x) ? x : Object.values(x))); } }
    else for (const x of kids) stack.push(x);
  }
  return { sigs, bytes };
}

/** The counts from `a` to `b` (either may be null: no document), or null if a signature can't be written. */
export function boardCounts(a: unknown, b: unknown): BoardCounts | null {
  const x = itemSignatures(a), y = itemSignatures(b);
  if (!x || !y) return null;
  let added = 0, removed = 0, changed = 0;
  for (const [id, s] of y.sigs) { const t = x.sigs.get(id); if (t === undefined) added++; else if (t !== s) changed++; }
  for (const id of x.sigs.keys()) if (!y.sigs.has(id)) removed++;
  return { added, removed, changed, bytes: x.bytes + y.bytes };
}
