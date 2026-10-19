// editState (web/board/edit-state.ts; web/board-host-protocol.md, "Editing"):
// a host's merge and checks of the edits its frame sends.  Run with Bun:
//   bun web/board/test-edit-state.mjs
// - the merge: text as a patch from what the user saw (astra's trace: a
//   queued edit after remote typing keeps both), other fields the later side,
//   deletes and edits to records deleted elsewhere (dbMerge3's rules);
// - the checks: pages, parents, cycles, orphans, edges' ends, ids per page,
//   size, record count, prototype keys, the message's shape, answered ids;
// - the rate and the work budget, with retryAfter;
// - a property test: on random edit sequences, editState accepts exactly what
//   recordProblems (the whole-board rules) accepts;
// - costs against an 8 MiB board: a small edit and a remote change, the
//   adversarial merge (was "A", the field near 8 MiB), and the indexes of
//   the densest board the caps allow.
import { editState, recordProblems, mergeText, mergeValue, EDIT_LIMITS } from "./edit-state.ts";

const fails = [];
let checks = 0;
const check = (ok, what) => { checks++; if (!ok) fails.push(what); };
const uuid = () => crypto.randomUUID();
const board = (d) => JSON.stringify({ format: "sagebrush-board", version: 1, ...d });
const K = (type, page, id) => ({ type, page, id });
const edit = (changes, base = "r") => ({ sagebrush: "edit", version: 1, id: uuid(), base, changes });
const rec = (st, type, page, id) => st.records().find((r) => r.type === type && r.page === page && r.id === id);
let clock = 0;
// (each edit a second after the last: the rate never in the way unless a test wants it)
const apply = (st, m) => st.apply(m, (clock += 1000));

// ---------------------------------------------------------------- mergeText
check(mergeText("A", "AB", "XA") === "XAB", "mergeText: a change elsewhere before, ours after: both");
check(mergeText("hello world", "hello brave world", "hello world!") === "hello brave world!", "mergeText: two places: both");
check(mergeText("ab", "aXb", "aYb") === "aYXb", "mergeText: both insert at one place: both, theirs first");
check(mergeText("abc", "aZc", "aYc") === "aZc", "mergeText: both changed one part: ours");
check(mergeText("abc", "abc", "abcd") === "abcd" && mergeText("abc", "abcd", "abc") === "abcd", "mergeText: one side unchanged");
check(mergeText("a😀b", "a😀Xb", "a😀b") === "a😀Xb" && mergeText("😀", "😃", "😀!") === "😃!", "mergeText: surrogate pairs kept whole");
check(mergeText("abcd", "aXcd", "abYd") === "aXYd", "mergeText: spans that touch (ours ends where theirs starts): both");
check(mergeText("abc", "aZbc", "aYc") === "aZYc", "mergeText: an insertion at the start of theirs: both, ours first");
check(mergeText("abc", "aYc", "aZbc") === "aZYc", "mergeText: the same, sides swapped: theirs first");
check(mergeText("abcde", "AbcdE", "abXcde") === "AbcdE", "mergeText: an edit spanning the whole field wins it, typing inside lost (resolution by span, as the protocol says)");

// ---------------------------------------------------------------- mergeValue (dbMerge3's rules)
check(mergeValue(1, 5, undefined) === 5, "mergeValue: removed here, changed elsewhere: the change");
check(mergeValue(1, undefined, 7) === 7, "mergeValue: changed here, removed elsewhere: the change");
check(mergeValue(1, 5, 7) === 7 && JSON.stringify(mergeValue([1], [2], [3])) === "[3]", "mergeValue: a number or a list changed on both sides: ours, the later side");
check(JSON.stringify(mergeValue(undefined, { r: { w: 1 } }, { l: { w: 2 } })) === '{"r":{"w":1},"l":{"w":2}}', "mergeValue: the first picture on both sides (no map before): both");
check(JSON.stringify(mergeValue({}, { x: { w: 1 } }, { x: { h: 2 } })) === '{"x":{"w":1,"h":2}}', "mergeValue: a nested map made on both sides: merged");
check(JSON.stringify(mergeValue({ a: 1, b: 1 }, { a: 2, b: 1 }, { b: 1 })) === '{"a":2,"b":1}', "mergeValue: a key removed here, changed elsewhere: the change");
check(JSON.stringify(mergeValue({ a: 1, b: 1 }, { b: 1 }, { a: 1, b: 2 })) === '{"b":2}', "mergeValue: a key removed elsewhere, another changed here: both");

// ---------------------------------------------------------------- the merge
{
  // astra's CORR-C3A-1: E1 (A) in flight, E2 (AB) queued; X typed elsewhere; E2 still keeps X
  const st = editState(board({ title: "T", nodes: [{ id: "n", text: "" }] }));
  const e1 = apply(st, edit([{ op: "set", key: K("item", "", "n"), fields: { text: "A" }, was: { text: "" } }]));
  st.remote([{ op: "set", key: K("item", "", "n"), fields: { text: "XA" } }]);
  const e2 = apply(st, edit([{ op: "set", key: K("item", "", "n"), fields: { text: "AB" }, was: { text: "A" } }]));
  check(e1.ok && e2.ok && rec(st, "item", "", "n").text === "XAB", "a queued edit after typing elsewhere keeps that typing: " + rec(st, "item", "", "n").text);
  check(e2.changes.length === 1 && e2.changes[0].fields.text === "XAB", "…the change written is the merged text");
  // a retry (new id, newer base) merges as the first try would have
  st.remote([{ op: "set", key: K("item", "", "n"), fields: { text: "XABY" } }]);
  const retry = apply(st, edit([{ op: "set", key: K("item", "", "n"), fields: { text: "ABZ" }, was: { text: "AB" } }], "newer"));
  const t = rec(st, "item", "", "n").text;
  check(retry.ok && t.length === 5 && ["X", "A", "B", "Y", "Z"].every((c) => t.includes(c)), "a retry against a newer state keeps what came meanwhile (each letter, in span order): " + t);
}
{
  const st = editState(board({ nodes: [{ id: "a", text: "keep", x: 1 }, { id: "b", text: "t" }] }));
  st.remote([{ op: "set", key: K("item", "", "a"), fields: { x: 5 } }]);
  apply(st, edit([{ op: "set", key: K("item", "", "a"), fields: { x: 9 }, was: { x: 1 } }]));
  check(rec(st, "item", "", "a").x === 9, "another field: the edit's value (the later side)");
  // deleted elsewhere: an edit of its text makes it again whole; of another field, no effect
  st.remote([{ op: "delete", key: K("item", "", "b") }]);
  const r1 = apply(st, edit([{ op: "set", key: K("item", "", "b"), fields: { x: 3 }, was: { x: null } }]));
  check(r1.ok && !rec(st, "item", "", "b") && r1.dropped.length === 1, "an edit to a record deleted elsewhere, not its text: no effect, said in dropped");
  const r2 = apply(st, edit([{ op: "set", key: K("item", "", "b"), fields: { text: "t2" }, was: { text: "t" }, record: { parent: "", pos: 1, text: "t2" } }]));
  check(r2.ok && rec(st, "item", "", "b")?.text === "t2", "…its text: made again, whole");
  // a delete whose text was changed elsewhere: kept
  st.remote([{ op: "set", key: K("item", "", "a"), fields: { text: "keep, edited elsewhere" } }]);
  const r3 = apply(st, edit([{ op: "delete", key: K("item", "", "a"), was: { text: "keep" } }]));
  check(r3.ok && rec(st, "item", "", "a") && r3.dropped.length === 1, "a delete of a record whose text changed elsewhere: kept, said");
  const r4 = apply(st, edit([{ op: "delete", key: K("item", "", "a"), was: { text: "keep, edited elsewhere" } }]));
  check(r4.ok && !rec(st, "item", "", "a") && r4.changes[0].op === "delete", "…as the user saw it: deleted");
  const r5 = apply(st, edit([{ op: "set", key: K("item", "", "c"), fields: { parent: "", pos: 2, text: "new" }, create: true }]));
  check(r5.ok && rec(st, "item", "", "c")?.text === "new", "a creation");
}
{
  // maps and removals in records, as dbMerge3: the first picture added on both sides keeps both
  const st = editState(board({ title: "M", nodes: [{ id: "a", x: 1 }] }));
  st.remote([{ op: "set", key: K("doc", "", ""), fields: { images: { remote: { width: 100, height: 100 } } } }]);
  const r = apply(st, edit([{ op: "set", key: K("doc", "", ""), fields: { images: { local: { width: 200, height: 200 } } }, was: { images: null } }]));
  check(r.ok && JSON.stringify(Object.keys(rec(st, "doc", "", "").images).sort()) === '["local","remote"]', "a board's first picture added here and elsewhere: both kept: " + JSON.stringify(rec(st, "doc", "", "").images));
  st.remote([{ op: "set", key: K("item", "", "a"), fields: { x: 5 } }]);
  apply(st, edit([{ op: "set", key: K("item", "", "a"), fields: { x: null }, was: { x: 1 } }]));
  check(rec(st, "item", "", "a").x === 5, "a field removed here and changed elsewhere: the change kept");
}

// ---------------------------------------------------------------- the checks
const groups = () => editState(board({ nodes: [{ id: "g", kind: "group", children: [{ id: "c", text: "child" }] }, { id: "h", kind: "group", children: [] }, { id: "x", text: "x" }], edges: [{ from: "x", to: "c" }] }));
const refused = (r, re) => !r.ok && !r.retryAfter && re.test(r.message);
{
  const st = groups();
  check(refused(apply(st, edit([{ op: "delete", key: K("item", "", "g"), was: {} }])), /children/), "a group with children isn't deleted alone");
  const e = st.records().find((r) => r.type === "edge");
  check(apply(st, edit([{ op: "delete", key: K("edge", "", e.id), was: {} }, { op: "delete", key: K("item", "", "c"), was: { text: "child" } }, { op: "delete", key: K("item", "", "g"), was: {} }])).ok, "…with its children and their edges in the same edit: deleted");
}
{
  const st = groups();
  check(refused(apply(st, edit([{ op: "delete", key: K("item", "", "x"), was: { text: "x" } }])), /edges/), "an item an edge names isn't deleted alone");
  check(refused(apply(st, edit([{ op: "set", key: K("item", "", "h"), fields: { parent: "g" }, was: { parent: "" } }, { op: "set", key: K("item", "", "g"), fields: { parent: "h" }, was: { parent: "" } }])), /round/), "parents that go round are refused");
  check(refused(apply(st, edit([{ op: "set", key: K("item", "", "x"), fields: { parent: "c" }, was: { parent: "" } }])), /group/), "a parent that isn't a group is refused");
  check(refused(apply(st, edit([{ op: "set", key: K("item", "", "x"), fields: { parent: "nobody" }, was: { parent: "" } }])), /group/), "a parent that isn't there is refused");
  check(refused(apply(st, edit([{ op: "set", key: K("edge", "", "e2"), fields: { from: "x", to: "ghost", pos: 1 }, create: true }])), /edge/), "an edge to an item that isn't there is refused");
  check(refused(apply(st, edit([{ op: "set", key: K("item", "", "g"), fields: { kind: null }, was: { kind: "group" } }])), /children/), "a group with children stays a group");
  check(refused(apply(st, edit([{ op: "delete", key: K("doc", "", ""), was: {} }])), /doc/), "the doc record isn't deleted");
  for (const bad of ["__proto__", "constructor", "prototype"]) check(refused(apply(st, edit([{ op: "set", key: K("item", "", "x"), fields: JSON.parse(`{"${bad}": 1}`), was: JSON.parse(`{"${bad}": null}`) }])), /name/), `a field named ${bad} is refused`);
  check(!Object.prototype.polluted && !({}).polluted, "…and nothing reaches Object.prototype");
  check(refused(apply(st, edit([{ op: "set", key: K("item", "", "x"), fields: { id: "y" }, was: { id: "x" } }])), /type, page or id/), "fields never hold the key");
  check(refused(apply(st, edit([{ op: "set", key: K("item", "", "x"), fields: { text: "y" } }])), /was has exactly/), "a set without was is refused");
  check(refused(apply(st, edit([{ op: "set", key: K("page", "p", "x"), fields: {}, create: true }])), /id is ""/), "a page record's id is \"\"");
  check(refused(apply(st, edit([{ op: "set", key: K("page", "p", ""), fields: { pos: 1 }, create: true }])), /without pages/), "no page records on a board without pages");
  check(refused(apply(st, { sagebrush: "edit", version: 1, id: "not-a-uuid", base: "r", changes: [] }), /UUID/), "an id that isn't a UUID is refused");
  const m = edit([]);
  check(apply(st, m).ok && apply(st, m).ignore === true, "an id already answered: ignored, nothing answered");
  let deep = [];
  for (let i = 0; i < 20; i++) deep = [deep];
  check(refused(apply(st, edit([{ op: "set", key: K("item", "", "x"), fields: { deep }, was: { deep: null } }])), /nests/), "nested more than 16 deep: refused");
  check(refused(apply(st, edit([{ op: "set", key: K("item", "", "x"), fields: { big: "x".repeat(2 ** 20) }, was: { big: null } }])), /MiB/), "a message over 1 MiB: refused");
  check(refused(apply(st, edit(Array.from({ length: 1001 }, (_, i) => ({ op: "set", key: K("item", "", "n" + i), fields: { parent: "" }, create: true })))), /1000 changes/), "more than 1,000 changes: refused");
}
{
  // pages: an item on a page that isn't there; the same id on two pages is fine
  const st = editState(board({ pages: [{ id: "p1", nodes: [{ id: "a" }] }, { id: "p2", nodes: [{ id: "a" }] }] }));
  check(refused(apply(st, edit([{ op: "set", key: K("item", "p3", "z"), fields: { parent: "", pos: 0 }, create: true }])), /page/), "an item on a page that isn't there is refused");
  check(apply(st, edit([{ op: "set", key: K("item", "p2", "b"), fields: { parent: "", pos: 1 }, create: true }, { op: "set", key: K("item", "p1", "b"), fields: { parent: "", pos: 1 }, create: true }])).ok, "the same id on two pages is fine");
  check(refused(apply(st, edit([{ op: "delete", key: K("page", "p1", ""), was: {} }])), /still has/), "a page with items isn't deleted alone");
}
{
  // a board already broken elsewhere (an agent wrote it so): an edit is refused only for its own records
  const st = editState(board({ nodes: [{ id: "a" }, { id: "b" }] }));
  st.remote([{ op: "set", key: K("item", "", "orphan"), fields: { parent: "gone", pos: 3 } }]);
  check(recordProblems(st.records()).length > 0 && apply(st, edit([{ op: "set", key: K("item", "", "a"), fields: { x: 1 }, was: { x: null } }])).ok, "a board broken elsewhere doesn't fail an edit that doesn't touch it");
}
{
  // size and count
  const st = editState(board({ nodes: [{ id: "a", text: "" }] }));
  const big = "y".repeat(900_000);
  let ok = true, refusedAt = -1;
  for (let i = 0; i < 12 && ok; i++) {
    const r = apply(st, edit([{ op: "set", key: K("item", "", "b" + i), fields: { parent: "", pos: i + 1, text: big }, create: true }]));
    if (!r.ok) { ok = false; refusedAt = i; check(/8 MiB/.test(r.message), "past 8 MiB: refused for its size: " + r.message); }
  }
  check(refusedAt >= 8 && st.bytes <= EDIT_LIMITS.boardBytes, `a board grows to 8 MiB, no further (refused at the ${refusedAt + 1}th, ${st.bytes} bytes)`);
  let threw = false;
  try { editState(board({ nodes: Array.from({ length: EDIT_LIMITS.records + 1 }, (_, i) => ({ id: "" + i })) })); } catch (e) { threw = /records/.test(e.message); }
  check(threw, "a board of more than 100,000 records isn't editable here");
  threw = false;
  try { editState(board({ nodes: [{ id: "a", text: "z".repeat(9 * 2 ** 20) }] })); } catch (e) { threw = /8 MiB/.test(e.message); }
  check(threw, "a board of more than 8 MiB isn't editable here");
  const kept = editState(board({ nodes: [{ id: "a", text: "small" }] }));
  threw = false;
  try { kept.reset(board({ nodes: [{ id: "a", text: "z".repeat(7 * 2 ** 20) }, { id: "b", text: "z".repeat(2 ** 20) }] })); } catch { threw = true; }
  check(threw && rec(kept, "item", "", "a")?.text === "small", "a reset refused for its size leaves the board as it was");
}

// ---------------------------------------------------------------- depth, cycles, overlapping walks
{
  // a chain of groups g0 (top) … gN: gN's depth is N
  const chain = (n) => { let node = { id: "g" + n, kind: "group", children: [] }; for (let i = n - 1; i >= 0; i--) node = { id: "g" + i, kind: "group", children: [node] }; return editState(board({ nodes: [node] })); };
  const st = chain(64);
  check(apply(st, edit([{ op: "set", key: K("item", "", "leaf63"), fields: { parent: "g63", pos: 1 }, create: true }])).ok, "an item 64 levels deep: kept");
  check(refused(apply(st, edit([{ op: "set", key: K("item", "", "leaf64"), fields: { parent: "g64", pos: 1 }, create: true }])), /64 levels/), "65 levels: refused");
  // reparenting the chain's top under a new group: the walk finds the deepest, untouched, past 64
  check(refused(apply(st, edit([{ op: "set", key: K("item", "", "H"), fields: { parent: "", pos: 9, kind: "group" }, create: true }, { op: "set", key: K("item", "", "g0"), fields: { parent: "H" }, was: { parent: "" } }])), /64 levels/), "a move that pushes a distant, untouched descendant past 64 levels: refused (astra's G0…G64)");
  const st63 = chain(63);
  check(apply(st63, edit([{ op: "set", key: K("item", "", "H"), fields: { parent: "", pos: 9, kind: "group" }, create: true }, { op: "set", key: K("item", "", "g0"), fields: { parent: "H" }, was: { parent: "" } }])).ok, "…the same move with the deepest landing at 64: kept");
}
{
  // groups the edit makes or moves whose subtrees overlap: each walked once, never taken for a cycle, in either order
  for (const order of [["N1", "N2"], ["N2", "N1"]]) {
    const st = editState(board({ nodes: [{ id: "a" }] }));
    const make = { N1: { op: "set", key: K("item", "", "N1"), fields: { parent: "", pos: 1, kind: "group" }, create: true }, N2: { op: "set", key: K("item", "", "N2"), fields: { parent: "N1", pos: 0, kind: "group" }, create: true } };
    const r = apply(st, edit(order.map((n) => make[n])));
    check(r.ok && st.lastWalk === 2, `two groups made, one inside the other (${order.join(" then ")}): kept, each walked once (${r.message ?? ""}, ${st.lastWalk})`);
  }
  // data that goes round already (an agent's): A's parent B, B's parent A; edits elsewhere fine, one meeting it refused, and both end
  const st = editState(board({ nodes: [{ id: "A", kind: "group", children: [] }, { id: "B", kind: "group", children: [] }, { id: "C", kind: "group", children: [] }, { id: "x" }] }));
  st.remote([{ op: "set", key: K("item", "", "A"), fields: { parent: "B" } }, { op: "set", key: K("item", "", "B"), fields: { parent: "A" } }]);
  check(apply(st, edit([{ op: "set", key: K("item", "", "x"), fields: { y: 1 }, was: { y: null } }])).ok, "cyclic data elsewhere: an edit that doesn't meet it is kept");
  check(refused(apply(st, edit([{ op: "set", key: K("item", "", "C"), fields: { parent: "A" }, was: { parent: "" } }])), /round/), "a group moved under cyclic data: refused, and the check ends");
  check(recordProblems(st.records()).some((p) => /round/.test(p)), "recordProblems ends on cyclic data, and says so");
}

// ---------------------------------------------------------------- identity: ids as files give them (astra's CORR-64C-1/2)
{
  // NUL inside ids: (page "a", item "b\0c") and (page "a\0b", item "c") are two items, never one
  const st = editState(board({ pages: [{ id: "a", nodes: [{ id: "b\u0000c", text: "first" }] }, { id: "a\u0000b", nodes: [{ id: "c", text: "second" }] }] }));
  check(st.records().filter((r) => r.type === "item").length === 2, "ids with NUL: both items kept on load");
  check(apply(st, edit([{ op: "set", key: K("item", "a", "b\u0000c"), fields: { text: "first!" }, was: { text: "first" } }])).ok && rec(st, "item", "a", "b\u0000c").text === "first!" && rec(st, "item", "a\u0000b", "c").text === "second", "…an edit to one changes it, never the other");
  // the empty id: the top's, never an item's
  check(refused(apply(st, edit([{ op: "set", key: K("item", "a", ""), fields: { parent: "", pos: 0, kind: "group" }, create: true }])), /id isn't/), "an item with the empty id: refused");
  let threw = false;
  try { editState(board({ nodes: [{ id: "", kind: "group", children: [] }] })); } catch (e) { threw = /id isn't/.test(e.message); }
  check(threw, "a board with an item whose id is empty: not editable here");
  const r = st.remote([{ op: "set", key: K("item", "a", ""), fields: { parent: "" } }]);
  check(!r.ok && st.records().every((x) => x.id !== "" || x.type === "doc" || x.type === "page"), "…nor made by a remote change");
  check(recordProblems([{ type: "doc", page: "", id: "" }, { type: "item", page: "", id: "", parent: "", kind: "group" }]).some((p) => /id isn't/.test(p)), "recordProblems names an empty item id");
  // ends whose ids escape at length in JSON (NUL, quotes, backslashes): an edge between them loads, and an edge made between them reads back (astra's CORR-40A-1)
  for (const [x, y] of [["\u0000".repeat(200), "b".repeat(200)], ['"'.repeat(200), "\\".repeat(200)], ["\u0001".repeat(200), "\u0000".repeat(200)]]) {
    let loaded = null;
    try { loaded = editState(board({ nodes: [{ id: x }, { id: y }], edges: [{ from: x, to: y }] })); } catch (e) { loaded = e; }
    check(loaded && !(loaded instanceof Error), "an edge between ids that escape at length in JSON: loads: " + (loaded instanceof Error ? loaded.message : ""));
    const two = editState(board({ nodes: [{ id: x }, { id: y }] }));
    const made = apply(two, edit([{ op: "set", key: K("edge", "", "e"), fields: { from: x, to: y, pos: 0 }, create: true }]));
    let back = null;
    try { back = editState(JSON.stringify(two.board())); } catch (e) { back = e; }
    check(made.ok && back && !(back instanceof Error) && back.records().some((r) => r.type === "edge"), "…an edge made between them reads back: " + (back instanceof Error ? back.message : made.message ?? ""));
  }
  // (made and deleted within one edit: nothing, and no error)
  const md = apply(st, edit([{ op: "set", key: K("item", "a", "tmp"), fields: { parent: "", pos: 3 }, create: true }, { op: "delete", key: K("item", "a", "tmp"), was: { text: null } }]));
  check(md.ok && !rec(st, "item", "a", "tmp") && md.changes.length === 0, "an item made and deleted in one edit: nothing changes, no error");
  check(typeof JSON.stringify(st.board()) === "string", "…and what is kept serializes");
}

// ---------------------------------------------------------------- the rate and the work
{
  const st = editState(board({ nodes: [{ id: "a", x: 0 }] }));
  let r, n = 0;
  for (let i = 0; i < 25; i++) { r = st.apply(edit([{ op: "set", key: K("item", "", "a"), fields: { x: i + 1 }, was: { x: i } }]), 5000); if (r.ok) n++; else break; }
  check(n === 20 && r.retryAfter >= 400 && r.retryAfter <= 600, `a burst of 20 edits, then retryAfter (${n}, ${r.retryAfter} ms)`);
  check(st.apply(edit([{ op: "set", key: K("item", "", "a"), fields: { x: 99 }, was: { x: 20 } }]), 5600).ok, "…and after it, accepted again");
  // the work: a record near 3 MiB touched again and again
  const w = editState(board({ nodes: [{ id: "a", text: "q".repeat(3 * 2 ** 20) }] }));
  let k = 0, last;
  for (let i = 0; i < 20; i++) { last = w.apply(edit([{ op: "set", key: K("item", "", "a"), fields: { x: i }, was: { x: i ? i - 1 : null } }]), 9000); if (last.ok) k++; else break; }
  check(k >= 9 && k <= 11 && last.retryAfter > 0, `work: ~10 edits of a 3 MiB record within 32 MiB, then retryAfter (${k}, ${last?.retryAfter} ms)`);
  // each change is a pass over its record, charged so: five changes to a 3 MiB record cost 15 MiB (daybreak2's LIMIT-C075-1)
  const per = editState(board({ nodes: [{ id: "a", text: "q".repeat(3 * 2 ** 20) }] }));
  const five = (n) => Array.from({ length: 5 }, (_, i) => ({ op: "set", key: K("item", "", "a"), fields: { ["f" + i]: n }, was: { ["f" + i]: n > 1 ? n - 1 : null } }));
  const p1 = per.apply(edit(five(1)), 20_000), p2 = per.apply(edit(five(2)), 20_000), p3 = per.apply(edit(five(3)), 20_000);
  check(p1.ok && p2.ok && !p3.ok && p3.retryAfter > 0, `a record named five times is charged five times: two such edits of a 3 MiB record fit in 32 MiB, a third waits (${p3.message})`);
  // the adversarial edit: hundreds of tiny text changes to one field near 8 MiB; refused before any merge
  const adv = editState(board({ nodes: [{ id: "a", text: "A" }] }));
  adv.remote([{ op: "set", key: K("item", "", "a"), fields: { text: "x".repeat(7_500_000) + "A" } }]);
  const many = Array.from({ length: 500 }, () => ({ op: "set", key: K("item", "", "a"), fields: { text: "AB" }, was: { text: "A" } }));
  const ta = performance.now(), ra = adv.apply(edit(many), 30_000), ms = performance.now() - ta;
  check(!ra.ok && !ra.retryAfter && /MiB of merging/.test(ra.message) && ms < 200, `500 changes to a 7.5 MB field: more than the whole budget, refused before any merge (${ms.toFixed(0)} ms: ${ra.message})`);
  check(rec(adv, "item", "", "a").text.length === 7_500_001, "…nothing merged");
  // a record grown within the edit: tiny before, its first change ~900 KiB, then 300 tiny changes passing over it (daybreak2)
  const grow = editState(board({ nodes: [{ id: "a", text: "A" }] }));
  const grown = [{ op: "set", key: K("item", "", "a"), fields: { text: "A" + "w".repeat(900 * 1024) }, was: { text: "A" } }, ...Array.from({ length: 300 }, () => ({ op: "set", key: K("item", "", "a"), fields: { text: "AB" }, was: { text: "A" } }))];
  const tg = performance.now(), rg = grow.apply(edit(grown), 40_000), msg = performance.now() - tg;
  check(!rg.ok && !rg.retryAfter && /MiB of merging/.test(rg.message) && msg < 200 && rec(grow, "item", "", "a").text === "A", `a record grown by the edit itself, then passed over 300 times: refused before any merge (${msg.toFixed(0)} ms: ${rg.message})`);
  // (and a few changes to one small record in an edit, as a frame's batched transactions make: fine)
  check(grow.apply(edit([1, 2, 3].map((n) => ({ op: "set", key: K("item", "", "a"), fields: { x: n }, was: { x: n > 1 ? n - 1 : null } }))), 50_000).ok, "…a few changes to one small record in an edit: kept");
}

// ---------------------------------------------------------------- remote changes: within the bounds, all or none (LIMIT-C075-2)
{
  const st = editState(board({ nodes: [{ id: "a", text: "a" }, { id: "b" }] }));
  const before = JSON.stringify(st.records());
  const big = st.remote([{ op: "set", key: K("item", "", "b"), fields: { text: "y" } }, { op: "set", key: K("item", "", "a"), fields: { text: "z".repeat(8.5 * 2 ** 20) } }]);
  check(!big.ok && /MiB/.test(big.message) && JSON.stringify(st.records()) === before, "a remote change past 8 MiB: refused, and none of its changes kept: " + big.message);
  // (a change within a board's bytes that takes the board past them: the board's own check)
  const five = editState(board({ nodes: [{ id: "a", text: "f".repeat(5 * 2 ** 20) }, { id: "b" }] }));
  const grow = five.remote([{ op: "set", key: K("item", "", "b"), fields: { text: "g".repeat(4 * 2 ** 20) } }]);
  check(!grow.ok && /board is now more than/.test(grow.message) && !rec(five, "item", "", "b").text, "a remote change that takes the board past 8 MiB: refused, nothing kept: " + grow.message);
  const count = st.remote(Array.from({ length: EDIT_LIMITS.records }, (_, i) => ({ op: "set", key: K("item", "", "n" + i), fields: { parent: "" } })));
  check(!count.ok && /records/.test(count.message) && JSON.stringify(st.records()) === before, "past 100,000 records: refused, nothing kept: " + count.message);
  const cyc = { a: 1 }; cyc.self = cyc;
  const c1 = st.remote([{ op: "set", key: K("item", "", "a"), fields: { style: cyc } }]);
  check(!c1.ok && JSON.stringify(st.records()) === before, "a value that refers to itself: refused: " + c1.message);
  let deep = 1; for (let i = 0; i < 40; i++) deep = { d: deep };
  const c2 = st.remote([{ op: "set", key: K("item", "", "a"), fields: { style: deep } }]);
  check(!c2.ok && /deep/.test(c2.message) && JSON.stringify(st.records()) === before, "a value nested 40 deep: refused: " + c2.message);
  const c3 = st.remote([{ op: "set", key: K("item", "", "a"), fields: JSON.parse('{"__proto__": {"polluted": 1}}') }]);
  check(!c3.ok && !({}).polluted && JSON.stringify(st.records()) === before, "a prototype name: refused, nothing reaches Object.prototype");
  check(st.remote([{ op: "set", key: K("item", "", "a"), fields: { text: "ok" } }]).ok && rec(st, "item", "", "a").text === "ok", "…and a remote change within the bounds: kept");
  check(recordProblems(Array.from({ length: EDIT_LIMITS.records + 1 }, (_, i) => ({ type: i ? "item" : "doc", page: "", id: i ? "x" + i : "", parent: "" }))).some((p) => /records/.test(p)), "recordProblems counts records too");
}

// ---------------------------------------------------------------- the property test
{
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  let accepted = 0, refusedN = 0, disagreements = 0;
  for (let round = 0; round < 60; round++) {
    const paged = round % 2 === 1;
    const nodes = () => [{ id: "g1", kind: "group", children: [{ id: "a" }, { id: "g2", kind: "group", children: [{ id: "b" }] }] }, { id: "c" }];
    const st = editState(board(paged ? { pages: [{ id: "p", nodes: nodes(), edges: [{ from: "a", to: "c" }] }, { id: "q", nodes: [{ id: "a" }] }] } : { nodes: nodes(), edges: [{ from: "a", to: "c" }] }));
    for (let step = 0; step < 40; step++) {
      const recs = st.records(), items = recs.filter((r) => r.type === "item"), pages = recs.filter((r) => r.type === "page").map((r) => r.page);
      const pg = paged ? pick([...pages, "nowhere"]) : pick(["", "", "", "elsewhere"]);
      // (hostile ids, among them the longest that escape the most in JSON: NUL, control characters, quotes, backslashes)
      const HOSTILE = ["", "\u0000", "a\u0000b", "__proto__", "constructor", "\"q\"", "L".repeat(200), "\u0000".repeat(200), "\u0001".repeat(200), '"'.repeat(200), "\\".repeat(200)];
      const ids = items.map((r) => r.id), anyId = () => pick([...ids, "ghost", ...HOSTILE]);
      const newId = (p) => pick([p + Math.floor(rnd() * 1e6), ...HOSTILE]);
      // (a running view, as a frame has it: each change's was what the user saw then, after the edit's earlier changes)
      const view = new Map(recs.map((r) => [JSON.stringify([r.type, r.page, r.id]), { ...r }]));
      const kOf = (key) => JSON.stringify([key.type, key.page, key.id]);
      const seeIn = (key, f) => { const r = view.get(kOf(key)); return r && f in r ? r[f] : null; };
      const changes = [];
      const push = (c) => {
        const k = kOf(c.key);
        if (c.op === "set" && !c.create) c.was = Object.fromEntries(Object.keys(c.fields).map((f) => [f, seeIn(c.key, f)]));
        if (c.op === "delete") c.was = { text: seeIn(c.key, "text") };
        changes.push(c);
        if (c.op === "delete") view.delete(k);
        else if (view.has(k)) { const r = { ...view.get(k) }; for (const [f, v] of Object.entries(c.fields)) { if (v === null) delete r[f]; else r[f] = v; } view.set(k, r); }
        else if (c.create) view.set(k, { ...c.key, ...c.fields });
      };
      for (let n = 1 + Math.floor(rnd() * 3); n > 0; n--) {
        const kind = Math.floor(rnd() * 6);
        const live = [...view.values()].filter((r) => r.type === "item");
        if (kind === 0) push({ op: "set", key: K("item", pg, newId("n")), fields: { parent: pick(["", ...ids]), pos: 0, ...(rnd() < 0.3 ? { kind: "group" } : {}) }, create: true });
        if (kind === 1 && live.length) { const r = pick(live); push({ op: "delete", key: K("item", r.page, r.id) }); }
        if (kind === 2 && live.length) { const r = pick(live); push({ op: "set", key: K("item", r.page, r.id), fields: { parent: anyId() } }); }
        if (kind === 3) push({ op: "set", key: K("edge", pg, "e" + Math.floor(rnd() * 1e6)), fields: { from: anyId(), to: anyId(), pos: 0 }, create: true });
        if (kind === 4) { const e = [...view.values()].filter((r) => r.type === "edge"); if (e.length) { const r = pick(e); push({ op: "delete", key: K("edge", r.page, r.id) }); } }
        if (kind === 5 && paged && pages.length) push({ op: "delete", key: K("page", pick(pages), "") });
      }
      // the result the whole-board rules see: no one else writes here, so the merge is the edit as made
      const naive = view;
      const whole = recordProblems(naive.values());
      // (a board already broken stays the whole-board rules' business only where an edit touches it: start valid, and keep it so)
      const r = apply(st, edit(changes));
      if (r.ok) accepted++; else refusedN++;
      // (a change keyed by an empty item or edge id is a malformed message, refused whatever it nets to)
      const malformed = changes.some((c) => (c.key.type === "item" || c.key.type === "edge") && c.key.id === "");
      if (r.ok !== (!malformed && whole.length === 0)) { disagreements++; if (disagreements <= 3) fails.push(`property: editState ${r.ok ? "accepted" : "refused (" + r.message + ")"}, the whole-board rules say ${JSON.stringify(whole)}: ${JSON.stringify(changes)}`); }
      if (r.ok) {
        check(recordProblems(st.records()).length === 0, "property: an accepted edit leaves a board the whole-board rules accept");
        // (independent of keyOf: no two records share (type, page, id), compared as tuples)
        const seen = new Set(st.records().map((x) => [x.type, x.page, x.id].map((v) => v.length + ":" + v).join("|")));
        check(seen.size === st.records().length, "property: every record's (type, page, id) its own");
        // (what is kept serializes, and reads back as the same records)
        let back = null;
        try { back = editState(JSON.stringify(st.board())); } catch (e) { back = e; }
        check(back && !(back instanceof Error) && back.records().length === st.records().length, "property: an accepted state serializes and reads back: " + (back instanceof Error ? back.message : ""));
      }
    }
  }
  check(disagreements === 0 && accepted > 100 && refusedN > 100, `property: on 2,400 random edits editState and the whole-board rules agree (${accepted} accepted, ${refusedN} refused, ${disagreements} disagreements)`);
}

// ---------------------------------------------------------------- costs against an 8 MiB board
const gc = () => Bun.gc(true);
const heap = () => process.memoryUsage().heapUsed;
function timeOf(f, n) { const t = performance.now(); for (let i = 0; i < n; i++) f(i); return (performance.now() - t) / n; }
function bigBoard(items, textBytes) { return board({ nodes: Array.from({ length: items }, (_, i) => ({ id: "n" + i, text: "t".repeat(textBytes), x: i, y: 0 })) }); }
{
  const small = editState(bigBoard(200, 400)), large = editState(bigBoard(16_500, 400));
  check(large.bytes > 7.5 * 2 ** 20 && large.bytes <= EDIT_LIMITS.boardBytes, `the large board is near 8 MiB (${(large.bytes / 2 ** 20).toFixed(2)} MiB)`);
  const move = (st) => (i) => st.apply(edit([{ op: "set", key: K("item", "", "n" + (i % 150)), fields: { x: 1000 + i }, was: { x: i ? 999 + i : i % 150 } }]), (clock += 1000));
  // (warm both first)
  timeOf(move(small), 200); timeOf(move(large), 200);
  const ts = timeOf(move(small), 400), tl = timeOf(move(large), 400);
  console.log(`a small edit: ${tl.toFixed(3)} ms on ${(large.bytes / 2 ** 20).toFixed(2)} MiB, ${ts.toFixed(3)} ms on ${(small.bytes / 1024).toFixed(0)} KiB`);
  check(tl < Math.max(5 * ts, 0.5), `a small edit costs the same on an 8 MiB board as on a small one (${tl.toFixed(3)} ms vs ${ts.toFixed(3)} ms)`);
  gc(); const h0 = heap(); move(large)(9999); const h1 = heap();
  check(h1 - h0 < 512 * 1024, `…and allocates what the edit touches, not the board (${((h1 - h0) / 1024).toFixed(0)} KiB)`);
  const rem = (st) => (i) => st.remote([{ op: "set", key: K("item", "", "n" + (i % 150)), fields: { y: i } }]);
  const rs = timeOf(rem(small), 400), rl = timeOf(rem(large), 400);
  console.log(`a remote change: ${rl.toFixed(3)} ms on the large board, ${rs.toFixed(3)} ms on the small`);
  check(rl < Math.max(5 * rs, 0.5), `a remote change costs the same on an 8 MiB board (${rl.toFixed(3)} ms vs ${rs.toFixed(3)} ms)`);
  gc(); const g0 = heap(); rem(large)(12345); const g1 = heap();
  check(g1 - g0 < 512 * 1024, `…and allocates what it touches (${((g1 - g0) / 1024).toFixed(0)} KiB)`);
}
{
  // the adversarial merge: the user saw "A"; the field is now near 8 MiB; an edit A to AB
  const field = (n) => { const st = editState(board({ nodes: [{ id: "a", text: "A" }] })); st.remote([{ op: "set", key: K("item", "", "a"), fields: { text: "x".repeat(n) + "A" } }]); return st; };
  const once = (n) => { const st = field(n); gc(); const h = heap(), t = performance.now(); const r = st.apply(edit([{ op: "set", key: K("item", "", "a"), fields: { text: "AB" }, was: { text: "A" } }]), (clock += 60_000)); return { ms: performance.now() - t, kb: (heap() - h) / 1024, ok: r.ok, text: rec(st, "item", "", "a").text }; };
  once(2 ** 20);
  const s = once(750_000), l = once(7_500_000);
  console.log(`the adversarial merge: ${l.ms.toFixed(1)} ms and ${(l.kb / 1024).toFixed(1)} MiB at 7.5 MB, ${s.ms.toFixed(1)} ms at 0.75 MB`);
  check(l.ok && l.text.endsWith("AB") && l.text.length === 7_500_002, "the adversarial merge: the edit placed in the 8 MiB field");
  check(l.ms < 25 * Math.max(s.ms, 1), `…linear in the field (quadratic would be ~100 times): ${l.ms.toFixed(1)} ms at 7.5 MB, ${s.ms.toFixed(1)} ms at 0.75 MB`);
  check(l.kb < 4 * 7_500_000 / 1024 + 1024, `…its heap a few times the field (${(l.kb / 1024).toFixed(1)} MiB)`);
}
{
  // the densest board the caps allow: 100,000 small records in pages, items and edges
  gc();
  const h0 = heap();
  const pages = Array.from({ length: 500 }, (_, p) => ({ id: "p" + p, nodes: Array.from({ length: 120 }, (_, i) => ({ id: "" + i })), edges: Array.from({ length: 78 }, (_, i) => ({ from: "" + i, to: "" + (i + 1) })) }));
  const text = board({ pages });
  const st = editState(text);
  gc();
  const mb = (heap() - h0) / 2 ** 20;
  check(st.records().length > 99_000, `the densest board: ${st.records().length} records, ${(st.bytes / 2 ** 20).toFixed(2)} MiB`);
  check(mb < 256, `…its state's heap is bounded (${mb.toFixed(0)} MiB)`);
  console.log(`densest board: ${st.records().length} records, ${(text.length / 2 ** 20).toFixed(2)} MiB of text, ${mb.toFixed(0)} MiB of heap with its text`);
}

{
  // a walk over ~100,000 items: a group of 99,000 moved under a new one; then 400 groups of 240, all moved at once (overlapping only through their new parent): each item visited once
  const many = editState(board({ nodes: [{ id: "G", kind: "group", children: Array.from({ length: 99_000 }, (_, i) => ({ id: "c" + i })) }] }));
  gc();
  const h0 = heap(), t0 = performance.now();
  const r = many.apply(edit([{ op: "set", key: K("item", "", "H"), fields: { parent: "", pos: 1, kind: "group" }, create: true }, { op: "set", key: K("item", "", "G"), fields: { parent: "H" }, was: { parent: "" } }]), (clock += 60_000));
  const ms = performance.now() - t0, kb = (heap() - h0) / 1024;
  console.log(`a walk over ${many.lastWalk} items: ${ms.toFixed(0)} ms, ${(kb / 1024).toFixed(1)} MiB`);
  check(r.ok && many.lastWalk === 99_002, `a walk over 99,002 items: kept, each visited once (${many.lastWalk}, ${ms.toFixed(0)} ms, ${(kb / 1024).toFixed(1)} MiB)`);
  check(kb < 64 * 1024, `…its temporary heap bounded (${(kb / 1024).toFixed(1)} MiB)`);
  const groupsOf = editState(board({ nodes: [{ id: "top", kind: "group", children: Array.from({ length: 400 }, (_, g) => ({ id: "g" + g, kind: "group", children: Array.from({ length: 240 }, (_, i) => ({ id: `g${g}c${i}` })) })) }] }));
  const moves = Array.from({ length: 400 }, (_, g) => ({ op: "set", key: K("item", "", "g" + g), fields: { parent: "" }, was: { parent: "top" } }));
  const r2 = groupsOf.apply(edit(moves), (clock += 60_000));
  check(r2.ok && groupsOf.lastWalk === 400 * 241, `400 groups moved at once: ${groupsOf.lastWalk} visits, each item once (${r2.message ?? "kept"})`);
  // the work budget: walks of ~99,000 items, again and again at one moment: refused once the budget is spent, nothing merged
  const again = editState(board({ nodes: [{ id: "G", kind: "group", children: Array.from({ length: 99_000 }, (_, i) => ({ id: "c" + i })) }, { id: "H", kind: "group", children: [] }, { id: "J", kind: "group", children: [] }] }));
  let okN = 0, last;
  for (let i = 0; i < 12; i++) {
    last = again.apply(edit([{ op: "set", key: K("item", "", "G"), fields: { parent: i % 2 ? "J" : "H" }, was: { parent: i ? (i % 2 ? "H" : "J") : "" } }]), 777_000_000);
    if (last.ok) okN++; else break;
  }
  check(okN >= 3 && okN <= 6 && last.retryAfter > 0 && /check/.test(last.message), `walks charged as they go: ${okN} kept within 32 MiB, then retryAfter (${last.message})`);
  check(rec(again, "item", "", "G").parent === (okN % 2 ? "H" : "J"), "…the refused one merged nothing");
}

if (fails.length) {
  console.error(`FAIL: ${fails.length} of ${checks} checks\n  ` + fails.join("\n  "));
  process.exit(1);
}
console.log(`ok: editState, ${checks} checks`);
