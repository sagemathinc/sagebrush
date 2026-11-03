// ci: none (new with posmap.ts, #554: a wiring candidate for the web-latex follow-up, runner=bun, no browser, about 1 s)
// posmap.ts (plan L1b r4b §5 step 0): positions mapped through change sets, checked against a reference that knows
// nothing of offsets arithmetic: the text as a list of characters, each with an identity; a change set applied to it
// keeps or deletes characters and makes new ones; a gap maps by its neighbours' identities (the rule in posmap.ts's
// header, stated there in the same words). Random edit sequences (insertions at marker boundaries, deletions across
// markers, replacements, several changes at once), undo and redo, and random outside replacements through lineDiff.
//   bun web/latex/test-latex-posmap.mjs
import { mapPos, mapRange, applyChanges, invertChanges, singleEdit, lineDiff, validChanges } from "./posmap.ts";

const results = [];
const check = (name, ok, detail) => { results.push([name, !!ok]); if (!ok) console.log("FAIL", name, JSON.stringify(detail)?.slice(0, 800)); };

// (a seeded generator: the same cases every run; SEED=n for others)
let seed = Number(process.env.SEED ?? 20261103) >>> 0;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
const int = (n) => Math.floor(rnd() * n);
const ALPHA = "ab\nc{}\\ ";
const word = (n) => Array.from({ length: n }, () => ALPHA[int(ALPHA.length)]).join("");

// ---- the reference: characters with identities
let nextId = 1;
const cellsOf = (text) => [...text].map((ch) => ({ ch, id: nextId++ }));
// (a change set applied to the cells: the kept ones keep their ids, the inserted ones are new)
function applyRef(cells, cs, inserted) {
  const out = []; let at = 0;
  cs.forEach((c, i) => { for (; at < c.from; at++) out.push(cells[at]); for (const ch of inserted[i]) out.push({ ch, id: nextId++ }); at = c.to; });
  for (; at < cells.length; at++) out.push(cells[at]);
  return out;
}
// (a gap of the old cells, mapped by its neighbours' identities: left kept, just after it; else right kept, just before
//  it; both kept with new characters between, or both deleted: before (-1) or after (+1) what is new there)
function mapRef(oldCells, newCells, pos, bias) {
  const where = new Map(newCells.map((c, i) => [c.id, i]));
  const L = pos > 0 ? oldCells[pos - 1] : null, R = pos < oldCells.length ? oldCells[pos] : null;
  const li = L === null ? -1 : where.has(L.id) ? where.get(L.id) : undefined;
  const ri = R === null ? newCells.length : where.has(R.id) ? where.get(R.id) : undefined;
  if (li !== undefined && ri !== undefined) return ri - li - 1 === 0 ? ri : bias < 0 ? li + 1 : ri;
  if (li !== undefined) return li + 1;
  if (ri !== undefined) return ri;
  // both deleted: the nearest kept neighbours
  let l = pos - 2; while (l >= 0 && !where.has(oldCells[l].id)) l--;
  let r = pos + 1; while (r < oldCells.length && !where.has(oldCells[r].id)) r++;
  const nl = l < 0 ? -1 : where.get(oldCells[l].id), nr = r >= oldCells.length ? newCells.length : where.get(oldCells[r].id);
  return bias < 0 ? nl + 1 : nr;
}
const textOf = (cells) => cells.map((c) => c.ch).join("");

// ---- a random change set: 1 to 3 changes, at random places or at marker boundaries
function randomChanges(len, markers) {
  const k = 1 + int(3), pts = new Set();
  const pick = () => (markers.length && rnd() < 0.5 ? markers[int(markers.length)] : int(len + 1));
  for (let i = 0; i < k * 2; i++) pts.add(Math.min(len, Math.max(0, pick() + (rnd() < 0.2 ? int(3) - 1 : 0))));
  const p = [...pts].sort((a, b) => a - b);
  const cs = [], inserted = [];
  for (let i = 0; i + 1 < p.length + 1 && cs.length < k; i += 2) {
    const from = p[i], to = rnd() < 0.3 ? from : (p[i + 1] ?? from);
    if (cs.length && from < cs[cs.length - 1].to) continue;
    const ins = rnd() < 0.3 ? "" : word(1 + int(4));
    if (from === to && ins === "") continue;
    cs.push({ from, to, insert: ins.length }); inserted.push(ins);
  }
  // (sometimes a pure insertion touching the end of the change before it: a deletion and an insertion at one gap)
  if (cs.length && cs.length < 3 && rnd() < 0.25) {
    const last = cs[cs.length - 1];
    if (last.to > last.from) { const ins = word(1 + int(3)); cs.push({ from: last.to, to: last.to, insert: ins.length }); inserted.push(ins); }
  }
  return { cs, inserted };
}

// ---- 1. fixed cases (the rule, by hand)
{
  // "abcdef": insert "XY" at 2
  const cs = [{ from: 2, to: 2, insert: 2 }];
  check("insert-at-gap-bias", mapPos(2, cs, -1) === 2 && mapPos(2, cs, 1) === 4 && mapPos(1, cs) === 1 && mapPos(3, cs) === 5, [mapPos(2, cs, -1), mapPos(2, cs, 1)]);
  // replace [2,4) of "abcdef" with "X": left of it 2, right of it 3; inside by bias
  const r = [{ from: 2, to: 4, insert: 1 }];
  check("replace-edges-and-inside", mapPos(2, r, 1) === 2 && mapPos(4, r, -1) === 3 && mapPos(3, r, -1) === 2 && mapPos(3, r, 1) === 3 && mapPos(6, r) === 5, [mapPos(2, r, 1), mapPos(4, r, -1), mapPos(3, r, -1), mapPos(3, r, 1)]);
  // an item [2,5): typing at its edges stays outside it; a deletion of all of it: empty
  check("range-edges-outside", JSON.stringify(mapRange(2, 5, [{ from: 2, to: 2, insert: 3 }])) === JSON.stringify({ start: 5, end: 8 }) && JSON.stringify(mapRange(2, 5, [{ from: 5, to: 5, insert: 3 }])) === JSON.stringify({ start: 2, end: 5 }), [mapRange(2, 5, [{ from: 2, to: 2, insert: 3 }]), mapRange(2, 5, [{ from: 5, to: 5, insert: 3 }])]);
  check("range-deleted-empty", (() => { const m = mapRange(2, 5, [{ from: 1, to: 6, insert: 2 }]); return m.start === m.end; })(), mapRange(2, 5, [{ from: 1, to: 6, insert: 2 }]));
  check("valid-changes", validChanges([{ from: 0, to: 1, insert: 0 }, { from: 1, to: 1, insert: 2 }], 3) && !validChanges([{ from: 2, to: 3, insert: 0 }, { from: 1, to: 1, insert: 1 }], 3) && !validChanges([{ from: 0, to: 4, insert: 0 }], 3), null);
}

// ---- 2. random edit sequences: every gap of every step, both biases, against the reference
{
  let bad = null, n = 0;
  for (let run = 0; run < 300 && !bad; run++) {
    let cells = cellsOf(word(int(30)));
    for (let step = 0; step < 12 && !bad; step++) {
      const text = textOf(cells), markers = [0, text.length, ...Array.from({ length: 4 }, () => int(text.length + 1))];
      const { cs, inserted } = randomChanges(text.length, markers);
      if (!cs.length || !validChanges(cs, text.length)) continue;
      const next = applyRef(cells, cs, inserted);
      if (applyChanges(text, cs, inserted) !== textOf(next)) { bad = { why: "apply", text, cs, inserted }; break; }
      for (let p = 0; p <= text.length && !bad; p++) for (const b of [-1, 1]) {
        n++;
        const got = mapPos(p, cs, b), want = mapRef(cells, next, p, b);
        if (got !== want) bad = { text, cs, inserted, p, b, got, want };
      }
      cells = next;
    }
  }
  check("random-edits-vs-reference", !bad, bad ?? { n });
  console.log(`  ${n} positions mapped`);
}

// ---- 3. undo and redo: an edit, then its inverse (the text restored), then the edit again; markers through all
// three, against the reference (the undo's new characters are new identities, as a textarea's undo makes them)
{
  let bad = null;
  for (let run = 0; run < 300 && !bad; run++) {
    const cells = cellsOf(word(1 + int(25))), text = textOf(cells);
    const { cs, inserted } = randomChanges(text.length, [0, text.length]);
    if (!cs.length) continue;
    const after = applyRef(cells, cs, inserted), afterText = textOf(after);
    const inv = invertChanges(cs), invIns = cs.map((c) => text.slice(c.from, c.to));
    if (applyChanges(afterText, inv, invIns) !== text) { bad = { why: "invert does not restore", text, cs }; break; }
    const undone = applyRef(after, inv, invIns);
    for (let p = 0; p <= afterText.length && !bad; p++) for (const b of [-1, 1]) {
      const got = mapPos(p, inv, b), want = mapRef(after, undone, p, b);
      if (got !== want) bad = { why: "undo", afterText, inv, p, b, got, want };
    }
    // (redo: the same change set again, on the restored text)
    const redone = applyRef(undone, cs, inserted);
    for (let p = 0; p <= text.length && !bad; p++) for (const b of [-1, 1]) {
      const got = mapPos(p, cs, b), want = mapRef(undone, redone, p, b);
      if (got !== want) bad = { why: "redo", text, cs, p, b, got, want };
    }
  }
  check("undo-redo-vs-reference", !bad, bad);
}

// ---- 4. the textarea's way: the old and new texts only, through singleEdit: exact for one region
{
  let bad = null;
  for (let run = 0; run < 500 && !bad; run++) {
    const a = word(int(30)), cells = cellsOf(a);
    const { cs, inserted } = randomChanges(a.length, [0, a.length]);
    if (cs.length !== 1) continue;
    const b = applyChanges(a, cs, inserted), se = singleEdit(a, b);
    if (applyChanges(a, se, se.map((c) => b.slice(c.from, c.from + c.insert))) !== b) bad = { why: "singleEdit", a, b, se };
  }
  check("single-edit-exact", !bad, bad);
}

// ---- 5. outside replacements through lineDiff: a valid change set of whole lines turning a into b; a line kept
// unchanged keeps the positions in it
{
  let bad = null, hunks = 0;
  const lines = (n) => Array.from({ length: n }, () => word(int(6)).replace(/\n/g, "") + "\n").join("");
  for (let run = 0; run < 300 && !bad; run++) {
    const L = Array.from({ length: 2 + int(12) }, () => word(int(6)).replace(/\n/g, "") + "\n");
    const M = L.slice();
    for (let k = 0; k < 1 + int(3); k++) {
      const i = int(M.length + 1), op = int(3);
      if (op === 0) M.splice(i, 0, lines(1 + int(2)));
      else if (op === 1 && M.length > 1) M.splice(Math.min(i, M.length - 1), 1);
      else if (M.length) M[Math.min(i, M.length - 1)] = "changed " + int(99) + "\n";
    }
    const a = L.join(""), b = M.join("");
    const { changes, inserted } = lineDiff(a, b);
    hunks += changes.length;
    if (!validChanges(changes, a.length)) { bad = { why: "invalid", a, b, changes }; break; }
    if (applyChanges(a, changes, inserted) !== b) { bad = { why: "does not make b", a, b, changes, inserted }; break; }
    const lineStart = (t, at) => at === 0 || t[at - 1] === "\n";
    if (!changes.every((c) => lineStart(a, c.from) && lineStart(a, c.to))) { bad = { why: "not whole lines", a, changes }; break; }
    // (a position inside a line no hunk touches: the same text around it afterwards)
    for (let p = 1; p < a.length && !bad; p++) {
      if (changes.some((c) => p >= c.from && p <= c.to)) continue;
      const q = mapPos(p, changes, -1);
      if (a.slice(p - 1, p + 1) !== b.slice(q - 1, q + 1)) bad = { why: "kept text moved", a, b, p, q, changes };
    }
  }
  check("line-diff-valid-and-exact", !bad, bad ?? { hunks });
  // (identical texts: no change; a bound on the work: past maxD, one change between the common ends, still exact)
  const big = Array.from({ length: 300 }, (_, i) => "line " + i + "\n").join(""), big2 = Array.from({ length: 300 }, (_, i) => (i % 2 ? "other " : "line ") + i + "\n").join("");
  const capped = lineDiff(big, big2, 10);
  check("line-diff-bounded", lineDiff("x\n", "x\n").changes.length === 0 && capped.changes.length === 1 && applyChanges(big, capped.changes, capped.inserted) === big2, capped.changes);
}

const failed = results.filter(([, ok]) => !ok).map(([n]) => n);
console.log(failed.length ? `FAIL: ${failed.length} of ${results.length}: ${failed.join(", ")}` : `ok: the LaTeX editor's position mapping, ${results.length} checks`);
process.exit(failed.length ? 1 : 0);
