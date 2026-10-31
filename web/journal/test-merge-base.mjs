// The base of a merge with the history (web/journal/store.js mergeBaseOf; plan-exact-only r1, astra3's BASE-1/BASE-2),
// on real patchflow histories: a root and two concurrent versions (two clients, each on its own store, so neither saw
// the other's), read back by a session of the notebooks' codec (exact merges) or of a codec without merge3 (a board's).
//   bun web/journal/test-merge-base.mjs
// Notebooks: (a) a record whose j predates the synced root has the root as its base; (b) a record whose j covers both
// concurrent versions has their merged value as its base, not the higher one's; a version it needs that isn't here, or
// versions whose ancestry isn't here, refuse (never a partial or one-version value).  Boards: as before this change, the
// one version with the highest j at or below the record's, and no root fallback.
import { Session, MemoryPatchStore, createImmerDbCodec } from "patchflow";
import { mergeBaseOf } from "./store.js";
import { notebookCodec, SCHEMA } from "../notebook/history.js";

const J = JSON.stringify;
let pass = 0, fail = 0;
const check = (ok, what) => { if (ok) pass++; else { fail++; console.log("FAIL " + what); } };
const board = createImmerDbCodec(SCHEMA); // (no merge3: a board's history as far as the base goes)
const cell = (id, input, pos) => ({ type: "cell", id, pos, input, cell_type: "code" });
const inputs = (doc) => J(doc ? doc.get({ type: "cell" }).map((r) => [r.id, r.input]).sort() : null);

// (root: cells a and b; one: a edited; two: b edited, concurrently)
const one = new MemoryPatchStore(), two = new MemoryPatchStore();
const s1 = new Session({ codec: board, patchStore: one, clientId: "baseone" });
await s1.init();
const base = board.fromString("").set(cell("a", "a0", 0)).set(cell("b", "b0", 1));
const root = s1.commit(base);
await two.append(root);
const s2 = new Session({ codec: board, patchStore: two, clientId: "basetwo" });
await s2.init();
const ea = s1.commit(base.set(cell("a", "A1", 0))), eb = s2.commit(base.set(cell("b", "B1", 1)));
s1.close(); s2.close();
check(J(ea.parents) === J([root.time]) && J(eb.parents) === J([root.time]), "the two versions are concurrent (both on the root)");
// (a reader of `patches` with `codec`)
async function reader(codec, patches) {
  const st = new MemoryPatchStore();
  for (const p of patches) await st.append(p);
  const x = new Session({ codec, patchStore: st, clientId: "basereader" });
  await x.init();
  return x;
}
const jOf = new Map([[root.time, 2], [ea.time, 3], [eb.time, 4]]);
const start = { n: 1, from_j: 2 };

// ---- notebooks (exact merges)
{
  const x = await reader(notebookCodec, [root, ea, eb]);
  const pre = mergeBaseOf(jOf, 1, start, x);
  check(!pre.refuse && pre.time === root.time && inputs(pre.value) === J([["a", "a0"], ["b", "b0"]]), "(a) a record whose j predates the synced root: the root is its base: " + J({ time: pre.time === root.time, value: inputs(pre.value) }));
  const one1 = mergeBaseOf(jOf, 3, start, x);
  check(!one1.refuse && one1.time === ea.time && inputs(one1.value) === J([["a", "A1"], ["b", "b0"]]), "one version at or below the record's j: its value: " + inputs(one1.value));
  const both = mergeBaseOf(jOf, 4, start, x);
  check(!both.refuse && both.time === eb.time && inputs(both.value) === J([["a", "A1"], ["b", "B1"]]), "(b) a record whose j covers both concurrent versions: their merged value, not the higher one's: " + inputs(both.value));
  const none = mergeBaseOf(new Map(), 4, null, x);
  check(!none.refuse && none.time === null && none.value === null, "no version at all (never started): no base, as before");
  x.close();
  // (a version it needs isn't here, while another survives: refused)
  const y = await reader(notebookCodec, [root, ea]);
  const miss = mergeBaseOf(jOf, 4, start, y);
  check(!!miss.refuse && miss.value === undefined, "a version it merges from isn't here (another survives): refused, no value: " + J(miss));
  y.close();
  // (both versions here, their common ancestry not: refused)
  const z = await reader(notebookCodec, [ea, eb]);
  const anc = mergeBaseOf(new Map([[ea.time, 3], [eb.time, 4]]), 4, start, z);
  check(!!anc.refuse && anc.value === undefined, "the versions here, their ancestry not: refused, no value: " + J(anc));
  z.close();
}

// ---- boards (no merge3): unchanged, the one version with the highest j, no root fallback
{
  const x = await reader(board, [root, ea, eb]);
  const pre = mergeBaseOf(jOf, 1, start, x);
  check(!pre.refuse && pre.time === null && pre.value === null, "board: a record whose j predates the synced root: no base, as before (no root fallback)");
  const both = mergeBaseOf(jOf, 4, start, x);
  check(!both.refuse && both.time === eb.time && inputs(both.value) === inputs(x.value({ time: eb.time })), "board: a record whose j covers both versions: the higher version's value, as before: " + inputs(both.value));
  x.close();
}

console.log(fail ? `${fail} of ${pass + fail} checks FAILED` : `ok: merge bases, ${pass} checks`);
process.exit(fail ? 1 : 0);
