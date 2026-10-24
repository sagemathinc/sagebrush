import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createHash } from "crypto";
import { EditHub } from "../src/board-edit-hub";
import { defaultLimits } from "../src/board-edit-limits";
import { editRecords, recordsAre } from "../web/board/lossless";

// The hub of `board open --edit` (plan-board-open-edit r7 §4, §5, §6), on a real directory with a fake clock:
// P₀ and what can't be edited; tabs' submissions (accepted, replayed, mismatched, stale, unknown, reactivated
// from a tombstone); saving (quiet, then written; persistedSeq and persistedGen); an outside version merged
// against P with a tab's edit; the file adopted when it is the board; and §4.3's older-copy flag.
const { mergeStrings3 } = require("patchflow");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const B = (nodes: any[], extra: any = {}) => ({ format: "sagebrush-board", version: 1, title: "t", nodes, edges: [], ...extra });
const text = (d: any) => JSON.stringify(d, null, 2) + "\n";
const snap = (d: any) => editRecords(d).map((r) => JSON.stringify(r)).join("\n");

async function setup(d: any, limits: Record<string, number> = {}) {
  const dir = fs.mkdtempSync(join(tmpdir(), "sb-edit-hub-"));
  const file = join(dir, "b.board.json");
  fs.writeFileSync(file, text(d));
  let now = 1_000_000;
  const clock = { now: () => now, advance: (ms: number) => { now += ms; } };
  const hub = new EditHub(file, { ...defaultLimits(), ...limits }, { mergeStrings3, now: clock.now });
  const r = await hub.start(fs.readFileSync(file));
  assert.ok(r.ok, !r.ok ? r.why : "");
  return { dir, file, hub, clock, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
const node = (hub: EditHub, id: string) => hub.H.json.nodes.find((n: any) => n.id === id);

test("board open --edit hub: P₀ is the file; a board that can't come back is not editable", async () => {
  const { hub, file, cleanup } = await setup(B([{ id: "n", text: "hello" }]));
  try {
    assert.equal(hub.P.seq, hub.H.seq);
    assert.equal(hub.persistedSeq, hub.P.seq);
    assert.deepEqual(hub.P.json.nodes[0].text, "hello");
    const other = new EditHub(file, defaultLimits(), { mergeStrings3, now: () => 0 });
    const r = await other.start(Buffer.from(JSON.stringify(B([{ id: "a" }], { edges: [{ from: "a", to: "a", id: "x", $eid: "y" }] }))));
    assert.ok(!r.ok && /can't be edited/.test(r.why));
    const big = new EditHub(file, { ...defaultLimits(), EDIT_MAX: 10 }, { mergeStrings3, now: () => 0 });
    assert.ok(!(await big.start(Buffer.from(JSON.stringify(B([]))))).ok);
  } finally { cleanup(); }
});

test("board open --edit hub: a tab's submission accepted, replayed once, a mismatch refused, a stale base said", async () => {
  const { hub, cleanup } = await setup(B([{ id: "n", text: "hello" }]));
  try {
    hub.connect("t1");
    const s1 = snap(B([{ id: "n", text: "hello world" }]));
    const a1 = hub.submit("t1", 1, hub.H.seq, s1, sha(s1));
    assert.ok("accepted" in a1);
    assert.equal(node(hub, "n").text, "hello world");
    // (the same op again: answered as before, not applied twice)
    const again = hub.submit("t1", 1, 1, s1, sha(s1));
    assert.ok("accepted" in again && "accepted" in a1 && again.seq === a1.seq);
    // (the same gen with another snapshot: refused)
    const s2 = snap(B([{ id: "n", text: "other" }]));
    assert.ok("mismatch" in hub.submit("t1", 1, 1, s2, sha(s2)));
    // (a hash that isn't the snapshot's: refused)
    assert.ok("refused" in hub.submit("t1", 2, hub.H.seq, s2, sha("x")));
    // (a base the hub doesn't hold: stale)
    assert.ok("stale" in hub.submit("t1", 2, 9999, s2, sha(s2)));
    assert.deepEqual(hub.tabView("t1"), { includes: 1, persistedGen: 0 });
  } finally { cleanup(); }
});

test("board open --edit hub: an unknown tab; a released tab reactivated from its tombstone", async () => {
  const { hub, cleanup } = await setup(B([{ id: "n", text: "hello" }]));
  try {
    const s = snap(B([{ id: "n", text: "x" }]));
    assert.ok("unknownTab" in hub.submit("nobody", 1, hub.H.seq, s, sha(s)));
    hub.connect("t1");
    const s1 = snap(B([{ id: "n", text: "hello!" }]));
    assert.ok("accepted" in hub.submit("t1", 1, hub.H.seq, s1, sha(s1)));
    hub.release("t1");
    // (known only by its tombstone: told what is included, reactivated, nothing applied)
    const s2 = snap(B([{ id: "n", text: "hello!?" }]));
    const r = hub.submit("t1", 2, hub.H.seq, s2, sha(s2));
    assert.ok("included" in r && r.included === 1);
    assert.equal(node(hub, "n").text, "hello!");
    // (then its next gen is accepted)
    assert.ok("accepted" in hub.submit("t1", 2, hub.H.seq, s2, sha(s2)));
    assert.equal(node(hub, "n").text, "hello!?");
  } finally { cleanup(); }
});

test("board open --edit hub: saved once quiet; persistedSeq and persistedGen advance with the save", async () => {
  const { hub, file, clock, cleanup } = await setup(B([{ id: "n", text: "hello" }]));
  try {
    hub.connect("t1");
    const s1 = snap(B([{ id: "n", text: "saved" }]));
    hub.submit("t1", 1, hub.H.seq, s1, sha(s1));
    assert.equal(hub.due(), false);
    clock.advance(hub.limits.SAVE_QUIET_MS);
    assert.equal(hub.due(), true);
    const r = await hub.save();
    assert.ok(r.saved);
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).nodes[0].text, "saved");
    assert.equal(hub.persistedSeq, hub.H.seq);
    assert.equal(hub.tabView("t1").persistedGen, 1);
    assert.equal(hub.due(), false);
    assert.equal(hub.slots.used, 1); // (prev retained)
  } finally { cleanup(); }
});

test("board open --edit hub: an outside version merged against P, with a tab's edit kept", async () => {
  const { hub, file, clock, cleanup } = await setup(B([{ id: "n", text: "hello", x: 0 }]));
  try {
    hub.connect("t1");
    const s1 = snap(B([{ id: "n", text: "hello", x: 5 }]));
    hub.submit("t1", 1, hub.H.seq, s1, sha(s1));
    // (another program, having read P, changes the text)
    fs.writeFileSync(file, text(B([{ id: "n", text: "hello world", x: 0 }])));
    await hub.observe(fs.readFileSync(file));
    assert.equal(node(hub, "n").text, "hello world");
    assert.equal(node(hub, "n").x, 5);
    assert.equal(hub.state.state, "ok");
    clock.advance(hub.limits.SAVE_MAX_DELAY_MS);
    assert.ok((await hub.save()).saved);
  } finally { cleanup(); }
});

test("board open --edit hub: an outside version that is already the board is adopted, nothing written", async () => {
  const { hub, clock, cleanup } = await setup(B([{ id: "n", text: "hello" }]));
  try {
    await hub.observe(Buffer.from(text(B([{ id: "n", text: "changed outside" }]))));
    assert.equal(hub.P.seq, hub.H.seq);
    assert.equal(hub.persistedSeq, hub.H.seq);
    clock.advance(hub.limits.SAVE_MAX_DELAY_MS);
    assert.equal(hub.due(), false);
  } finally { cleanup(); }
});

test("board open --edit hub: §4.3, a field back to an older save's value: applied exactly, and flagged", async () => {
  const { hub, file, clock, cleanup } = await setup(B([{ id: "n", text: "A" }]));
  try {
    hub.connect("t1");
    // (two saves: A -> B -> C)
    for (const [gen, t] of [[1, "B"], [2, "C"]] as const) {
      const s = snap(B([{ id: "n", text: t }]));
      assert.ok("accepted" in hub.submit("t1", gen, hub.H.seq, s, sha(s)));
      clock.advance(hub.limits.SAVE_MAX_DELAY_MS);
      assert.ok((await hub.save()).saved);
    }
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).nodes[0].text, "C");
    hub.events.length = 0;
    // (a program from an older copy writes "A" back)
    await hub.observe(Buffer.from(text(B([{ id: "n", text: "A" }]))));
    assert.equal(node(hub, "n").text, "A"); // (applied as the file says)
    const flags = hub.events.flatMap((e) => e.reports).filter((r) => r.kind === "older-copy");
    assert.equal(flags.length, 1);
    assert.ok(flags[0].kind === "older-copy" && flags[0].board === "C");
  } finally { cleanup(); }
});

test("board open --edit hub: FILE invalid or deleted: saving held", async () => {
  const { hub, clock, cleanup } = await setup(B([{ id: "n", text: "hello" }]));
  try {
    hub.connect("t1");
    const s1 = snap(B([{ id: "n", text: "edit" }]));
    hub.submit("t1", 1, hub.H.seq, s1, sha(s1));
    await hub.observe(Buffer.from('{"format": "sagebrush-board", "nodes": ['));
    assert.ok(hub.state.state === "held" && hub.state.why === "invalid");
    clock.advance(hub.limits.SAVE_MAX_DELAY_MS);
    assert.equal(hub.due(), false);
    await hub.observe(null);
    assert.ok((hub.state as any).state === "held" && (hub.state as any).why === "deleted");
    assert.equal(hub.due(), false);
  } finally { cleanup(); }
});

test("board open --edit hub: a submission's hashing, parsing and checking are on the merge's ledger (exact cap, cap-1)", async () => {
  const d = B([{ id: "n", text: "hello" }, { id: "m", text: "x".repeat(2000) }]);
  const s1 = snap(B([{ id: "n", text: "hello world" }, { id: "m", text: "x".repeat(2000) }]));
  const tryWith = async (work: number) => {
    const { hub, cleanup } = await setup(d, { MERGE_WORK: work });
    try { hub.connect("t1"); return hub.submit("t1", 1, hub.H.seq, s1, sha(s1)); } finally { cleanup(); }
  };
  // (the least ledger that accepts it, by bisection)
  let lo = 100_000, hi = 1_000_000;
  assert.ok("accepted" in (await tryWith(hi)));
  if ("accepted" in (await tryWith(lo))) {
    // (the table's minimum is enough here: the bound below is checked on a ledger made smaller by hand)
    lo = 0;
  }
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if ("accepted" in (await tryWith(mid))) hi = mid; else lo = mid; }
  const least = hi;
  // (every pass over the snapshot is charged: at least four units a byte, before the merge's own)
  assert.ok(least >= 4 * s1.length, `${least} < ${4 * s1.length}`);
  assert.ok("accepted" in (await tryWith(least)));
  const r = await tryWith(least - 1);
  assert.ok("refused" in r && r.refused === "can't merge (work)", JSON.stringify(r));
});

test("board open --edit hub: a merge past MERGE_MS, in any phase, is refused (time)", async () => {
  const dir = fs.mkdtempSync(join(tmpdir(), "sb-edit-hub-"));
  try {
    const file = join(dir, "b.board.json");
    fs.writeFileSync(file, text(B([{ id: "n", text: "hello" }])));
    let now = 0;
    const hub = new EditHub(file, { ...defaultLimits(), MERGE_MS: 100 }, { mergeStrings3, now: () => now });
    assert.ok((await hub.start(fs.readFileSync(file))).ok);
    hub.connect("t1");
    const s1 = snap(B([{ id: "n", text: "hello world" }]));
    // (the clock moves on while the snapshot is read: past the deadline before the merge)
    (hub as any).deps.now = () => (now += 60);
    const r = hub.submit("t1", 1, hub.H.seq, s1, sha(s1));
    assert.ok("refused" in r && r.refused === "can't merge (time)", JSON.stringify(r));
    assert.equal(node(hub, "n").text, "hello");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("board open --edit hub: a merged head larger than EDIT_MAX is refused, the head unchanged", async () => {
  const KiB = 1024;
  const { hub, cleanup } = await setup(B([{ id: "n", text: "a".repeat(40 * KiB) }]), { FILE_MAX: 128 * KiB, EDIT_MAX: 64 * KiB, BODY_MAX: 64 * KiB, MEMORY_MAX: 64 * 1024 * KiB });
  try {
    hub.connect("t1");
    const seq = hub.H.seq;
    const s1 = snap(B([{ id: "n", text: "a".repeat(40 * KiB) }, { id: "m", text: "b".repeat(30 * KiB) }]));
    const r = hub.submit("t1", 1, seq, s1, sha(s1));
    assert.ok("refused" in r && /larger than EDIT_MAX/.test(r.refused), JSON.stringify(r));
    assert.equal(hub.H.seq, seq);
    assert.equal(hub.tabView("t1").includes, 0);
  } finally { cleanup(); }
});

test("board open --edit hub: §5.3, a write into prev is merged against its base; prev unlinked once quiet, ingested and saved", async () => {
  const { hub, file, clock, cleanup } = await setup(B([{ id: "n", text: "hello", x: 0 }, { id: "m", text: "m" }]));
  try {
    hub.connect("t1");
    const s1 = snap(B([{ id: "n", text: "hello", x: 7 }, { id: "m", text: "m" }]));
    hub.submit("t1", 1, hub.H.seq, s1, sha(s1));
    clock.advance(hub.limits.SAVE_MAX_DELAY_MS);
    assert.ok((await hub.save()).saved);
    assert.equal(hub.prevs.length, 1);
    const prev = hub.prevs[0].path;
    assert.equal(hub.slots.used, 1);
    // (a program holding a handle opened before the save writes the old inode: from P₀, m changed)
    fs.writeFileSync(prev, text(B([{ id: "n", text: "hello", x: 0 }, { id: "m", text: "m from a handle" }])));
    await hub.tickPrevs(150);
    assert.equal(node(hub, "m").text, "m from a handle");
    assert.equal(node(hub, "n").x, 7); // (the tab's edit kept: merged against the prev's base, not over H)
    // (quiet, but not yet saved: kept)
    clock.advance(1000);
    await hub.tickPrevs(150);
    assert.ok(fs.existsSync(prev));
    // (a second write into prev: merged against what prev held before, not P₀)
    fs.writeFileSync(prev, text(B([{ id: "n", text: "hello again", x: 0 }, { id: "m", text: "m from a handle" }])));
    await hub.tickPrevs(150);
    assert.equal(node(hub, "n").text, "hello again");
    assert.equal(node(hub, "m").text, "m from a handle");
    assert.equal(node(hub, "n").x, 7);
    clock.advance(hub.limits.SAVE_MAX_DELAY_MS);
    assert.ok((await hub.save()).saved);
    // (the first save's prev: quiet, ingested, saved: unlinked, its slot released; the new save's prev kept)
    await hub.tickPrevs(150);
    assert.ok(!fs.existsSync(prev));
    assert.equal(hub.prevs.length, 1);
    assert.equal(hub.slots.used, 1);
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(saved.nodes.find((x: any) => x.id === "m").text, "m from a handle");
  } finally { cleanup(); }
});

test("board open --edit hub: §5.3, a prev that isn't a board is kept and reported; one removed by someone else frees its slot", async () => {
  const { hub, clock, cleanup } = await setup(B([{ id: "n", text: "hello" }]));
  try {
    hub.connect("t1");
    const s1 = snap(B([{ id: "n", text: "edited" }]));
    hub.submit("t1", 1, hub.H.seq, s1, sha(s1));
    clock.advance(hub.limits.SAVE_MAX_DELAY_MS);
    assert.ok((await hub.save()).saved);
    const prev = hub.prevs[0].path;
    hub.events.length = 0;
    fs.writeFileSync(prev, "{ half written");
    await hub.tickPrevs(150);
    assert.equal(hub.state.state, "ok"); // (FILE is fine: saving goes on)
    assert.ok(hub.events.some((e) => e.reports.some((r) => r.kind === "prev-kept" && r.path === prev)));
    clock.advance(10_000);
    await hub.tickPrevs(150);
    assert.ok(fs.existsSync(prev)); // (never unlinked)
    fs.unlinkSync(prev);
    await hub.tickPrevs(150);
    assert.equal(hub.prevs.length, 0);
    assert.equal(hub.slots.used, 0);
  } finally { cleanup(); }
});

test("board open --edit hub: CORR-BOARD-A1-2, a snapshot's records must be exactly the board's; a refusal changes nothing", async () => {
  const d = B([{ id: "n", text: "hello", label: null }, { id: "m", text: "m" }], { edges: [{ from: "n", to: "m" }], tools: { a: [1, { b: 2 }] } });
  const { hub, cleanup } = await setup(d);
  try {
    hub.connect("t1");
    const good = editRecords(d);
    assert.ok(recordsAre(good).ok);
    const doc = good.find((r: any) => r.type === "doc")!;
    const item = (id: string) => good.findIndex((r: any) => r.type === "item" && r.id === id);
    const edge = good.findIndex((r: any) => r.type === "edge");
    const variants: [string, any[]][] = [
      // (astra's probe: a second doc record with another title; the decoder takes the first, a Map the last)
      ["a second doc record", [...good, { ...doc, title: "other" }]],
      ["a key twice", [...good, { ...good[item("m")], text: "again" }]],
      ["no doc record", good.filter((r: any) => r.type !== "doc")],
      ["an edge whose key isn't its ends and count", good.map((r: any, i) => (i === edge ? { ...r, id: "[\"n\",\"m\",7]" } : r))],
      ["a page record on a board without pages", [...good, { type: "page", page: "p", id: "", pos: 0 }]],
      ["an unknown record type", [...good, { type: "comment", page: "", id: "c" }]],
      ["a record no page reaches", [...good, { type: "item", page: "elsewhere", id: "z", parent: "", pos: 0 }]],
      ["an item whose parent doesn't exist", [...good, { type: "item", page: "", id: "z", parent: "nobody", pos: 0 }]],
      ["a gap in pos", good.map((r: any, i) => (i === item("m") ? { ...r, pos: 5 } : r))],
      ["pos not a whole number", good.map((r: any, i) => (i === item("m") ? { ...r, pos: 1.5 } : r))],
      ["a line that isn't an object", [...good, [1, 2]]],
    ];
    const seq = hub.H.seq, before = JSON.stringify(hub.H.json);
    for (const [what, rs] of variants) {
      const s = rs.map((r) => JSON.stringify(r)).join("\n");
      const r = hub.submit("t1", 1, seq, s, sha(s));
      assert.ok("refused" in r, `${what}: ${JSON.stringify(r)}`);
      assert.equal(hub.H.seq, seq, what);
      assert.equal(JSON.stringify(hub.H.json), before, what);
      assert.deepEqual(hub.tabView("t1"), { includes: 0, persistedGen: 0 }, what);
    }
    // (the same records, in another order, with keys reordered: the board's)
    const shuffled = [...good].reverse().map((r: any) => Object.fromEntries(Object.entries(r).reverse()));
    const s = shuffled.map((r) => JSON.stringify(r)).join("\n");
    assert.ok("accepted" in hub.submit("t1", 1, seq, s, sha(s)));
    // (absent and null kept apart, unknown nested fields and tools carried, through a submission and its merge)
    const d2 = B([{ id: "n", text: "hello" }, { id: "m", text: "m", label: null, extra: { deep: [null, { x: 1 }] } }], { edges: [{ from: "n", to: "m" }], tools: { a: [1, { b: 2 }], c: null } });
    const s2 = snap(d2);
    assert.ok("accepted" in hub.submit("t1", 2, hub.H.seq, s2, sha(s2)));
    assert.ok(!("label" in node(hub, "n")));
    assert.ok("label" in node(hub, "m") && node(hub, "m").label === null);
    assert.deepEqual(node(hub, "m").extra, { deep: [null, { x: 1 }] });
    assert.deepEqual(hub.H.json.tools, { a: [1, { b: 2 }], c: null });
  } finally { cleanup(); }
});
