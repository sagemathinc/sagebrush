// ci: none (new with cells.ts: a wiring candidate for the web-latex follow-up, runner=bun, no browser, about 1 s)
// cells.ts (plan L1b r4b §5 step 1): the code items of a .tex found with their exact ranges, and their ids carried
// through edits by the identity rule, checked against a reference that tracks each character's identity (an old item
// corresponds to a new one when one of its characters is in it; an id is kept only through a unique one-to-one
// correspondence of the same kind); reopen matching by (kind, code hash, ordinal); the results file's validation.
//   bun web/latex/test-latex-cells.mjs
import { scanItems, carryIds, reopenIds, idSource, savedIdentities, signatures, ID_MAX } from "./cells.ts";
import { applyChanges } from "./posmap.ts";
import { createHash } from "node:crypto";

const results = [];
const check = (name, ok, detail) => { results.push([name, !!ok]); if (!ok) console.log("FAIL", name, JSON.stringify(detail)?.slice(0, 900)); };
const H = (s) => createHash("sha256").update(s).digest("hex");
let seed = Number(process.env.SEED ?? 20261103) >>> 0;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
const int = (n) => Math.floor(rnd() * n);

// ---- 1. the scanner
{
  const t = "A $x$ \\sage{1+1} and \\sage{f({1}, \\{)} % \\sage{no}\n\\sageplot[width=.5\\textwidth]{plot(x)}\n\\begin{sagesilent}\nx = 2\n\\end{sagesilent}\n\\begin{verbatim}\\sage{no}\\end{verbatim}\n\\pyc{print(1)} \\matlab{x=1} \\begin{pycode}\ny=1\n\\end{pycode}\n";
  const it = scanItems(t);
  check("scan-kinds-and-codes", JSON.stringify(it.map((x) => [x.kind, x.code])) === JSON.stringify([["sage", "1+1"], ["sage", "f({1}, \\{)"], ["sageplot", "plot(x)"], ["sagesilent", "\nx = 2\n"], ["pyc", "print(1)"], ["matlab", "x=1"], ["pycode", "\ny=1\n"]]), it.map((x) => [x.kind, x.code]));
  check("scan-ranges-exact", it.every((x) => /^\\(sage|sageplot|pyc|matlab|begin)/.test(t.slice(x.start, x.end)) && /(\}|\\end\{[a-z]+\})$/.test(t.slice(x.start, x.end))) && t.slice(it[2].start, it[2].end) === "\\sageplot[width=.5\\textwidth]{plot(x)}", it.map((x) => t.slice(x.start, x.end)));
  check("scan-unterminated-stops", scanItems("\\sage{1} \\sage{2").length === 1 && scanItems("\\begin{sageblock}\nx").length === 0, null);
}

// ---- the reference: characters with identities, items by the characters they hold
let nextChar = 1;
const cellsOf = (text) => [...text].map((ch) => ({ ch, id: nextChar++ }));
function applyRef(cells, cs, inserted) {
  const out = []; let at = 0;
  cs.forEach((c, i) => { for (; at < c.from; at++) out.push(cells[at]); for (const ch of inserted[i]) out.push({ ch, id: nextChar++ }); at = c.to; });
  for (; at < cells.length; at++) out.push(cells[at]);
  return out;
}
// (the ids the rule gives: for each new item, the old index it keeps the id of, or -1 for a fresh one)
function refRule(oldCells, oldItems, newCells, newItems) {
  const owner = new Map();
  oldItems.forEach((it, i) => { for (let k = it.start; k < it.end; k++) owner.set(oldCells[k].id, i); });
  const toNew = oldItems.map(() => new Set()), toOld = newItems.map(() => new Set());
  newItems.forEach((it, j) => { for (let k = it.start; k < it.end; k++) { const i = owner.get(newCells[k].id); if (i !== undefined) { toOld[j].add(i); toNew[i].add(j); } } });
  return newItems.map((it, j) => { if (toOld[j].size !== 1) return -1; const [i] = toOld[j]; return toNew[i].size === 1 && oldItems[i].kind === it.kind ? i : -1; });
}

// ---- 2. ids through random edits, against the reference
{
  const pieces = ["Text. ", "\\sage{x+1}", "\\sage{x+1}", "\\sage{y}", "\\pyc{z}", "\n\n", "\\begin{sagesilent}\na=1\n\\end{sagesilent}\n", " more ", "}", "{", "\\sage{", "% c\n"];
  let bad = null, kept = 0, fresh = 0, steps = 0;
  for (let run = 0; run < 400 && !bad; run++) {
    let text = Array.from({ length: 3 + int(8) }, () => pieces[int(pieces.length)]).join("");
    let cells = cellsOf(text), items = scanItems(text);
    const next = idSource([]);
    let ids = items.map(() => next());
    for (let step = 0; step < 10 && !bad; step++) {
      // (an edit: 1 or 2 changes, at random places or item edges; inserting text or pieces, deleting, replacing)
      const pts = new Set();
      const edge = () => (items.length && rnd() < 0.6 ? (rnd() < 0.5 ? items[int(items.length)].start : items[int(items.length)].end) + int(3) - 1 : int(text.length + 1));
      for (let k = 0; k < 2 + 2 * int(2); k++) pts.add(Math.max(0, Math.min(text.length, edge())));
      const p = [...pts].sort((a, b) => a - b), cs = [], inserted = [];
      for (let k = 0; k + 1 < p.length; k += 2) {
        const ins = rnd() < 0.3 ? "" : rnd() < 0.5 ? pieces[int(pieces.length)] : "ab".slice(0, 1 + int(2));
        const from = p[k], to = rnd() < 0.4 ? from : p[k + 1];
        if (from === to && !ins) continue;
        cs.push({ from, to, insert: ins.length }); inserted.push(ins);
      }
      if (!cs.length) continue;
      const nt = applyChanges(text, cs, inserted), ncells = applyRef(cells, cs, inserted), nitems = scanItems(nt);
      const got = carryIds(items, ids, cs, nitems, next), want = refRule(cells, items, ncells, nitems);
      steps++;
      for (let j = 0; j < nitems.length && !bad; j++) {
        if (want[j] >= 0) { kept++; if (got[j] !== ids[want[j]]) bad = { why: "should keep", text, nt, cs, inserted, j, got, want, ids }; }
        else { fresh++; if (ids.includes(got[j]) || got.indexOf(got[j]) !== j) bad = { why: "should be fresh", text, nt, cs, inserted, j, got, want, ids }; }
      }
      text = nt; cells = ncells; items = nitems; ids = got;
    }
  }
  check("carry-ids-vs-reference", !bad, bad ?? { steps, kept, fresh });
  console.log(`  ${steps} edits, ${kept} ids kept, ${fresh} fresh`);
}

// ---- 3. the cases by hand: an edit inside keeps; an identical item typed before two duplicates is the fresh one;
// a cut and paste (a move) is fresh; two items merged are both fresh
{
  const t = "A \\sage{x} B \\sage{x} C";
  const items = scanItems(t), next = idSource(["i2"]), ids = ["i1", "i2"];
  const ins = "\\sage{x} ";
  const cs1 = [{ from: 2, to: 2, insert: ins.length }], t1 = applyChanges(t, cs1, [ins]);
  const ids1 = carryIds(items, ids, cs1, scanItems(t1), next);
  check("typed-duplicate-before-two-is-fresh", JSON.stringify(ids1) === JSON.stringify(["i3", "i1", "i2"]), ids1);
  const k = t.indexOf("x}"), cs2 = [{ from: k, to: k + 1, insert: 3 }], t2 = applyChanges(t, cs2, ["x+1"]);
  check("edit-inside-keeps", JSON.stringify(carryIds(items, ids, cs2, scanItems(t2), idSource(ids))) === JSON.stringify(["i1", "i2"]), t2);
  // (cut "\sage{x} " at the first and paste it at the end: one change set of two changes)
  const a = t.indexOf("\\sage{x}"), cut = "\\sage{x} ", cs3 = [{ from: a, to: a + cut.length, insert: 0 }, { from: t.length, to: t.length, insert: cut.length }];
  const t3 = applyChanges(t, cs3, ["", cut]), ids3 = carryIds(items, ids, cs3, scanItems(t3), idSource(ids));
  check("cut-paste-move-is-fresh", ids3[0] === "i2" && ids3[1] === "i3", { t3, ids3 });
  // (delete " B " between the two and the "} \sage{": they become one item: both old ones fresh, one new id)
  const m = t.indexOf("} B \\sage{"), cs4 = [{ from: m, to: m + "} B \\sage{".length, insert: 0 }], t4 = applyChanges(t, cs4, [""]);
  const ids4 = carryIds(items, ids, cs4, scanItems(t4), idSource(ids));
  check("merge-is-fresh", scanItems(t4).length === 1 && ids4[0] === "i3", { t4, ids4 });
}

// ---- 4. reopen: (kind, code hash, ordinal); unique items keep their ids in any order; a group whose size changed is
// ambiguous: all fresh; nothing matched: fresh
{
  const t = "\\sage{a} \\sage{b} \\sage{b}";
  const saved = signatures(scanItems(t), H).map((s, i) => ({ id: "i" + (i + 1), ...s }));
  const re = (text) => reopenIds(scanItems(text), saved, H, idSource(saved.map((s) => s.id)));
  check("reopen-same", JSON.stringify(re(t)) === JSON.stringify(["i1", "i2", "i3"]), re(t));
  check("reopen-unique-moved-keeps", JSON.stringify(re("\\sage{b} \\sage{b} \\sage{a}")) === JSON.stringify(["i2", "i3", "i1"]), re("\\sage{b} \\sage{b} \\sage{a}"));
  check("reopen-group-size-changed-fresh", JSON.stringify(re("\\sage{a} \\sage{b} \\sage{b} \\sage{b}")) === JSON.stringify(["i1", "i4", "i5", "i6"]), re("\\sage{a} \\sage{b} \\sage{b} \\sage{b}"));
  check("reopen-unmatched-fresh", JSON.stringify(re("\\sage{c} \\sage{a}")) === JSON.stringify(["i4", "i1"]), re("\\sage{c} \\sage{a}"));
}

// ---- 5. the results file's identities: v2 only, a malformed item dropped alone, a malformed file none
{
  const good = { id: "i1", kind: "sage", codeHash: "a".repeat(64), ordinal: 0 };
  check("saved-v2", savedIdentities({ format: "sagebrush-latex-results", version: 2, items: [good, { ...good, id: "x" }, { ...good, kind: "shell" }, { ...good, ordinal: -1 }, null] }).length === 1, null);
  check("saved-malformed-file", savedIdentities({ format: "sagebrush-latex-results", version: 1, items: [good] }).length === 0 && savedIdentities(null).length === 0 && savedIdentities({ format: "sagebrush-latex-results", version: 2, items: Array(1001).fill(good) }).length === 0, null);
}

// ---- 6. fresh ids at the schema's edge (daybreak3's #555 HOLD): with i999999 used, the next ids are distinct, unused,
// valid in the results file, and read back from it
{
  const next = idSource(["i999999", "i1", "i2"]);
  const fresh = Array.from({ length: 5 }, () => next());
  const file = { format: "sagebrush-latex-results", version: 2, items: fresh.map((id, k) => ({ id, kind: "sage", codeHash: "b".repeat(64), ordinal: k })) };
  const back = savedIdentities(file).map((s) => s.id);
  check("fresh-ids-at-the-edge", ID_MAX === 999999 && new Set(fresh).size === 5 && !fresh.some((id) => ["i999999", "i1", "i2"].includes(id)) && fresh.every((id) => /^i[0-9]{1,6}$/.test(id) && Number(id.slice(1)) <= ID_MAX) && JSON.stringify(back) === JSON.stringify(fresh), { fresh, back });
  const n2 = idSource(["i5"]);
  check("fresh-ids-ordinary", n2() === "i6" && n2() === "i7", null);
}

const failed = results.filter(([, ok]) => !ok).map(([n]) => n);
console.log(failed.length ? `FAIL: ${failed.length} of ${results.length}: ${failed.join(", ")}` : `ok: the LaTeX editor's code items and their ids, ${results.length} checks`);
process.exit(failed.length ? 1 : 0);
