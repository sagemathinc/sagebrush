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

console.log(fails.length ? `FAIL: ${fails.length} of ${checks} checks\n  ` + fails.join("\n  ") : `ok: ${checks} checks`);
process.exit(fails.length ? 1 : 0);
