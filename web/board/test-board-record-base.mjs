// ci: web-runner order=403 runner=bun
// A board's version is made from the board it was edited from, exactly (history.ts recordInto), as a notebook's is:
// two tabs' histories on one store, one tab moving the history after the other loaded its board.
//   1. With the page's merge (boardMerge3, page.ts): the other tab's item kept, this tab's edit added; the version
//      made from the head instead (the bug's shape) undoes the other tab's item.
//   2. A host's history with no merge: nothing kept over a head that moved (null, said by the page, mount.ts), the
//      head as it was; and a head that is the base still takes the version.
//   3. No base: refused.
//   bun web/board/test-board-record-base.mjs
import { MemoryPatchStore } from "patchflow";
import { PatchHistory, createImmerDbCodec } from "../notebook/patch-history.js";
import { BoardHistory } from "./history.ts";
import { boardMerge3 } from "./merge.ts";

const J = JSON.stringify;
let checks = 0;
const fails = [];
const check = (ok, what) => { checks++; if (!ok) fails.push(what); };
const tick = () => new Promise((r) => setTimeout(r, 0));
const mod = { PatchHistory, createImmerDbCodec };
const merge = (b, h, l) => boardMerge3(b, h, l, { work: 2_000_000 });
const board = (...texts) => ({ title: "t", nodes: texts.map(([id, text]) => ({ id, text, x: 0, y: 0 })) });
const texts = (h) => { const v = h.versions(); return v.length ? J(h.docAt(v[v.length - 1].time).nodes.map((n) => [n.id, n.text]).sort()) : "[]"; };

{
  const store = new MemoryPatchStore();
  const x = await new BoardHistory(mod, store, merge).init(), y = await new BoardHistory(mod, store, merge).init();
  const b0 = board(["n1", "one"]);
  x.record(b0, { noVersions: true });
  await tick();
  // (tab Y adds an item: tab X still shows b0)
  y.record(board(["n1", "one"], ["n2", "two, from Y"]), b0);
  await tick();
  // (tab X edits its own item, its base the board it shows)
  x.record(board(["n1", "one, edited in X"]), b0);
  await tick();
  check(texts(x) === J([["n1", "one, edited in X"], ["n2", "two, from Y"]]) && texts(y) === texts(x), `1. another tab's item kept, this tab's edit added (${texts(x)})`);
}
{
  const store = new MemoryPatchStore();
  const x = await new BoardHistory(mod, store).init(), y = await new BoardHistory(mod, store).init();
  const b0 = board(["n1", "one"]);
  x.record(b0, { noVersions: true });
  await tick();
  y.record(board(["n1", "one"], ["n2", "two, from Y"]), b0);
  await tick();
  const before = texts(x), out = x.record(board(["n1", "one, edited in X"]), b0);
  await tick();
  check(out?.notKept === true && texts(x) === before, `2. no merge: nothing kept over a head another tab moved, said as such (${J(out)}, ${texts(x)})`);
  // (and nothing changed is not "not kept": null, as a page tells them apart (mount.ts recordOne))
  const same = y.record(board(["n1", "one"], ["n2", "two, from Y"]), board(["n1", "one"], ["n2", "two, from Y"]));
  check(same === null, `2. an unchanged board: null, nothing changed, never "not kept" (${J(same)})`);
  const b1 = board(["n1", "one"], ["n2", "two, from Y"]), kept = y.record(board(["n1", "one"], ["n2", "two, again"]), b1);
  await tick();
  check(!!kept && texts(y) === J([["n1", "one"], ["n2", "two, again"]]), `2. no merge: a head that is the base takes the version (${texts(y)})`);
  // (a history not open yet: pending, never "not kept")
  const opening = new BoardHistory(mod, new MemoryPatchStore(), merge).record(board(["n1", "x"]), { noVersions: true });
  check(opening?.pending === true, `2. a history not yet open: pending, nothing said (${J(opening)})`);
  let threw = false;
  try { y.record(b1); } catch { threw = true; }
  check(threw, "3. no base: refused");
}

// 4. (the overlap) base A, the head B (another tab's), the board shown B: nothing to commit (null, the page's base then
// B, mount.ts recordOne); a later edit back to A, from that base, is recorded
{
  const store = new MemoryPatchStore();
  const x = await new BoardHistory(mod, store, merge).init(), y = await new BoardHistory(mod, store, merge).init();
  const A = board(["n1", "A"]), Bd = board(["n1", "B"]);
  x.record(A, { noVersions: true });
  await tick();
  y.record(Bd, A);
  await tick();
  const same = x.record(Bd, A);
  await tick();
  const back = x.record(A, Bd);
  await tick();
  check(same === null && !!back && !back.notKept && texts(x) === J([["n1", "A"]]), `4. converged on the other tab's B, nothing committed; a later edit back to A from B recorded (${J(same)}, ${texts(x)})`);
}

// 5. (the fuzz) two tabs' pages on one board history, each lagging its head until it takes it (the page's merge):
// seeded random typing, taking the head, and recording from the page's base; after every version, it changed only
// items that tab typed since its base.  FUZZ_SEEDS seeds, each printed on a failure
{
  const seeds = Number(process.env.FUZZ_SEEDS ?? 120), first = Number(process.env.FUZZ_FIRST ?? 1);
  const rng = (seed) => () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const ids = ["n1", "n2", "n3"];
  const textOf = (b, id) => b.nodes.find((n) => n.id === id)?.text;
  const head = (h) => { const v = h.versions(); return h.docAt(v[v.length - 1].time); };
  const { toRecords, fromRecords, keptRecord } = await import("./history.ts");
  const merged = (base, hd, page) => { const m = merge(toRecords(base).map(keptRecord), toRecords(hd).map(keptRecord), toRecords(page).map(keptRecord)); return fromRecords({ get: ({ type }) => m.records.filter((r) => !type || r.type === type), getOne: (k) => m.records.find((r) => r.type === k.type && (k.id === undefined || r.id === k.id)) }); };
  let bad = null, steps = 0;
  for (let seed = first; seed < first + seeds && !bad; seed++) {
    const r = rng(seed), pick = (xs) => xs[Math.floor(r() * xs.length)];
    const store = new MemoryPatchStore(), start = board(...ids.map((id) => [id, "start " + id]));
    const tabs = [];
    for (let i = 0; i < 2; i++) tabs.push({ h: await new BoardHistory(mod, store, merge).init(), page: start, base: start, name: "XY"[i] });
    tabs[0].h.record(start, { noVersions: true });
    await tick();
    for (let step = 0; step < 30 && !bad; step++, steps++) {
      const t = pick(tabs), k = r();
      if (k < 0.45) {
        const id = pick(ids);
        t.page = { ...t.page, nodes: t.page.nodes.map((n) => (n.id === id ? { ...n, text: t.name + step } : n)) };
      } else if (k < 0.65) {
        const hd = head(t.h);
        try { t.page = merged(t.base, hd, t.page); t.base = hd; } catch { /* (a merge this model can't read back: the step skipped) */ }
      } else {
        const before = head(t.h), typed = new Set(ids.filter((id) => textOf(t.page, id) !== textOf(t.base, id)));
        t.h.record(t.page, t.base);
        await tick();
        const after = head(t.h), undone = ids.filter((id) => textOf(after, id) !== textOf(before, id) && !typed.has(id));
        if (undone.length) bad = { seed, step, tab: t.name, undone, typed: [...typed] };
        t.page = t.base = after;
      }
    }
  }
  check(!bad, `5. the fuzz: no board version changes an item its tab didn't type (${seeds} seeds from ${first}, ${steps} steps)` + (bad ? ": " + J(bad) : ""));
}

console.log(fails.length ? `FAIL: ${fails.length} of ${checks} checks\n  ` + fails.join("\n  ") : `ok: ${checks} checks`);
process.exit(fails.length ? 1 : 0);
