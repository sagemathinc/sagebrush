import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createHash } from "crypto";
import { EditHub } from "../src/board-edit-hub";
import { defaultLimits } from "../src/board-edit-limits";
import { submitCharge, keptCharge } from "../src/board-edit-memory";
import { editRecords, recordsAre } from "../web/board/lossless";

// The hub of `board open --edit` (plan-board-open-edit r7 §4, §5, §6), on a real directory with a fake clock:
// P₀ and what can't be edited; tabs' submissions (accepted, replayed, mismatched, stale, unknown, reactivated
// from a tombstone); saving (quiet, then written; persistedSeq and persistedGen); an outside version merged
// against P with a tab's edit; the file adopted when it is the board; and §4.3's older-copy flag.
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
  const hub = new EditHub(file, { ...defaultLimits(), ...limits }, { now: clock.now });
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
    const other = new EditHub(file, defaultLimits(), { now: () => 0 });
    const r = await other.start(Buffer.from(JSON.stringify(B([{ id: "a" }], { edges: [{ from: "a", to: "a", id: "x", $eid: "y" }] }))));
    assert.ok(!r.ok && /can't be edited/.test(r.why));
    const big = new EditHub(file, { ...defaultLimits(), EDIT_MAX: 10 }, { now: () => 0 });
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
    assert.deepEqual(hub.tabView("t1"), { includes: 1, persistedGen: 0, writtenGen: 0 });
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
    // (known only by its tombstone: told what is included, nothing applied; not made live by a POST, again and
    // again, as long as no stream of its own connects: CORR-153-R2-2)
    const s2 = snap(B([{ id: "n", text: "hello!?" }]));
    for (let i = 0; i < 2; i++) {
      const r = hub.submit("t1", 2, hub.H.seq, s2, sha(s2));
      assert.ok("included" in r && r.included === 1, JSON.stringify(r));
    }
    assert.equal(node(hub, "n").text, "hello!");
    // (its events reconnected: reactivated from its tombstone, its watermark kept; its next gen accepted)
    hub.connect("t1");
    assert.ok("included" in hub.submit("t1", 1, hub.H.seq, s1, sha(s1)), "at or below the watermark: included");
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
  const { hub, file, clock, cleanup } = await setup(B([{ id: "n", text: "hello" }]));
  try {
    // (at FILE: adopting it fsyncs FILE and its directory, which are what it reads first, CORR-153-3)
    fs.writeFileSync(file, text(B([{ id: "n", text: "changed outside" }])));
    await hub.observe(fs.readFileSync(file));
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
    const hub = new EditHub(file, { ...defaultLimits(), MERGE_MS: 100 }, { now: () => now });
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
      assert.deepEqual(hub.tabView("t1"), { includes: 0, persistedGen: 0, writtenGen: 0 }, what);
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

test("board open --edit hub: LIMIT-BOARD-ADD2-1, a submission whose R exactly fills the ledger is accepted, its head retained out of R", async () => {
  const MiB = 1024 * 1024;
  const d = B([{ id: "n", text: "hello" }]);
  const s1 = snap(B([{ id: "n", text: "hello world" }]));
  const R = submitCharge(Buffer.from(s1));
  for (const extra of [0, 1]) {
    const { hub, cleanup } = await setup(d, { MEMORY_MAX: 64 * MiB });
    try {
      hub.connect("t1");
      // (the ledger filled so that R fits exactly, or is one byte short)
      hub.ledger.used = hub.ledger.max - R + extra;
      const before = hub.ledger.used, seq = hub.H.seq;
      const r = hub.submit("t1", 1, seq, s1, sha(s1));
      if (extra === 0) {
        assert.ok("accepted" in r, JSON.stringify(r));
        // (never past the cap, at any point: the new head converted out of R, the rest released)
        assert.ok(hub.ledger.peak <= hub.ledger.max, `${hub.ledger.peak} > ${hub.ledger.max}`);
        assert.ok(hub.ledger.used < before + R);
        assert.equal(node(hub, "n").text, "hello world");
      } else {
        assert.deepEqual(r, { op: "t1:1", busy: "memory" });
        assert.equal(hub.ledger.used, before);
        assert.equal(hub.H.seq, seq);
        assert.deepEqual(hub.tabView("t1"), { includes: 0, persistedGen: 0, writtenGen: 0 });
      }
    } finally { cleanup(); }
  }
});

test("board open --edit hub: R past MEMORY_MAX / 2 is refused for good, before parsing; many tiny fields count", async () => {
  const MiB = 1024 * 1024;
  const { hub, cleanup } = await setup(B([{ id: "n", text: "hello" }]), { MEMORY_MAX: 64 * MiB });
  try {
    hub.connect("t1");
    // (many tiny records, each with many fields: about 2.2 MB, whose bytes alone (18·b ≈ 40 MB) would pass)
    const recs = editRecords(B(Array.from({ length: 2000 }, (_, i) => ({ id: "n" + i, ...Object.fromEntries(Array.from({ length: 60 }, (_, j) => ["f" + j, 0])) }))));
    const body = recs.map((r) => JSON.stringify(r)).join("\n") + "\n{ not JSON";
    const b = Buffer.byteLength(body);
    assert.ok(18 * b <= hub.ledger.max / 2, "the bytes term alone fits");
    assert.ok(submitCharge(Buffer.from(body)) > hub.ledger.max / 2, "the tokens make it not fit");
    const before = hub.ledger.used, seq = hub.H.seq;
    const r = hub.submit("t1", 1, seq, body, sha(body), 4096);
    // (refused for memory, not for the JSON that would fail to parse: nothing was parsed)
    assert.ok("refused" in r && /more memory than MEMORY_MAX/.test(r.refused), JSON.stringify(r));
    // (the body's charge, taken over, released too)
    assert.equal(hub.ledger.used, before - 4096 < 0 ? 0 : before - 4096);
    assert.equal(hub.H.seq, seq);
  } finally { cleanup(); }
});

test("board open --edit hub: R released on every refusal path, the head, watermark and persistedGen unchanged", async () => {
  const KiB = 1024;
  const { hub, cleanup } = await setup(B([{ id: "n", text: "a".repeat(40 * KiB) }]), { FILE_MAX: 128 * KiB, EDIT_MAX: 64 * KiB, BODY_MAX: 64 * KiB, MEMORY_MAX: 64 * 1024 * KiB });
  try {
    hub.connect("t1");
    const seq = hub.H.seq;
    const ok = snap(B([{ id: "n", text: "a".repeat(40 * KiB) }]));
    const tooBig = snap(B([{ id: "n", text: "a".repeat(40 * KiB) }, { id: "m", text: "b".repeat(30 * KiB) }]));
    const dup = ok + "\n" + JSON.stringify({ type: "doc", page: "", id: "", title: "x" });
    const cases: [string, string, string][] = [
      ["hash", ok, sha("other")],
      ["JSON", ok + "\n{", sha(ok + "\n{")],
      ["records", dup, sha(dup)],
      ["EDIT_MAX", tooBig, sha(tooBig)],
    ];
    const before = hub.ledger.used;
    for (const [what, body, h] of cases) {
      const r = hub.submit("t1", 1, seq, body, h);
      assert.ok("refused" in r, `${what}: ${JSON.stringify(r)}`);
      assert.equal(hub.ledger.used, before, what);
      assert.equal(hub.H.seq, seq, what);
      assert.deepEqual(hub.tabView("t1"), { includes: 0, persistedGen: 0, writtenGen: 0 }, what);
    }
  } finally { cleanup(); }
});

test("board open --edit hub: compaction drops the window, then old saves, then the stalest tab's pin; never H, P, a pin, a write or a prev's base", async () => {
  const MiB = 1024 * 1024;
  const { hub, clock, cleanup } = await setup(B([{ id: "n", text: "v0" }]), { MEMORY_MAX: 64 * MiB });
  try {
    hub.connect("t1");
    hub.connect("t2");
    // (heads 1..6, two of them saved)
    for (let g = 1; g <= 6; g++) {
      const s = snap(B([{ id: "n", text: "v" + g }]));
      assert.ok("accepted" in hub.submit("t1", g, hub.H.seq, s, sha(s)));
      if (g === 2 || g === 4) { clock.advance(hub.limits.SAVE_MAX_DELAY_MS); assert.ok((await hub.save()).saved); }
    }
    // (t2 pinned to an old head; a prev's base is an old save)
    const old = hub.H.seq - 4;
    hub.adopted("t2", old);
    const prevBase = hub.prevs[0].base;
    assert.ok(hub.head(old));
    // (pressure: the ledger made to look over half full, as other heads would)
    const pressure = hub.ledger.max / 2;
    hub.ledger.used += pressure;
    const s = snap(B([{ id: "n", text: "v7" }]));
    assert.ok("accepted" in hub.submit("t1", 7, hub.H.seq, s, sha(s)));
    // (everything droppable went, oldest first, then the tabs' pins, the stalest first: t2, then t1, the pressure
    // here never relieved)
    assert.deepEqual([...hub.staleTabs], ["t2", "t1"]);
    assert.equal((hub as any).window.length, 0);
    assert.deepEqual((hub as any).saves, [hub.P]);
    // (H, P and the prev's base still kept and charged; t1's pin is a base it named)
    assert.equal(hub.head(hub.H.seq), hub.H);
    assert.ok(hub.P && (hub as any).charged.has(hub.P));
    assert.ok((hub as any).charged.has(prevBase));
    assert.ok((hub as any).charged.has(hub.H));
    // (what's charged is exactly what's referenced, nothing double-counted)
    const sum = [...(hub as any).charged.values()].reduce((a: number, b: number) => a + b, 0);
    assert.equal(hub.ledger.used - pressure, sum);
  } finally { cleanup(); }
});

test("board open --edit hub: a save dropped from the comparison history stays kept while a tab, a write or a prev still holds it", async () => {
  const MiB = 1024 * 1024;
  const { hub, clock, cleanup } = await setup(B([{ id: "n", text: "v0" }]), { MEMORY_MAX: 64 * MiB });
  try {
    hub.connect("t1");
    hub.connect("t2");
    const saved: any[] = [];
    for (let g = 1; g <= 5; g++) {
      const s = snap(B([{ id: "n", text: "v" + g }]));
      assert.ok("accepted" in hub.submit("t1", g, hub.H.seq, s, sha(s)));
      clock.advance(hub.limits.SAVE_MAX_DELAY_MS);
      assert.ok((await hub.save()).saved);
      saved.push(hub.P);
    }
    // (t2 pinned to the first save; a write in progress of the second; the prevs' bases are older saves)
    hub.adopted("t2", saved[0].seq);
    (hub as any).writing = saved[1];
    const charged = (hub as any).charged as Map<any, number>;
    const kept = new Set<any>([hub.H, hub.P, saved[0], saved[1], ...hub.prevs.map((p) => p.base), (hub as any).observed?.version].filter(Boolean));
    const keptSum = [...kept].reduce((a, v) => a + charged.get(v)!, 0);
    // (pressure that dropping the window and the saves relieves exactly)
    const sumAll = [...charged.values()].reduce((a, b) => a + b, 0);
    const pressure = hub.ledger.max / 2 - keptSum;
    hub.ledger.used = sumAll + pressure;
    (hub as any).account();
    assert.deepEqual([...hub.staleTabs], []);
    // (the saves only the comparison history held are gone; any left are held otherwise too)
    for (const v of (hub as any).saves) assert.ok(kept.has(v), `save ${v.seq} kept only as history`);
    for (const v of kept) assert.ok(charged.has(v), `seq ${v.seq} released`);
    assert.equal(hub.head(saved[0].seq), saved[0]); // (t2 can still name it as its base)
    assert.equal(hub.ledger.used, hub.ledger.max / 2);
  } finally { cleanup(); }
});

test("board open --edit hub: an outside version without memory now waits, and is merged when there is", async () => {
  const MiB = 1024 * 1024;
  const { hub, cleanup } = await setup(B([{ id: "n", text: "hello" }]), { MEMORY_MAX: 64 * MiB });
  try {
    const outside = Buffer.from(text(B([{ id: "n", text: "changed outside" }])));
    // (the boundary: R, and C's own Rv admitted on top of it)
    const Rv = keptCharge(editRecords(JSON.parse(outside.toString())));
    const R = submitCharge(outside), O = hub.O;
    hub.ledger.used = hub.ledger.max - R - Rv + 1;
    const before = hub.ledger.used;
    await hub.observe(outside);
    assert.equal(hub.deferred, true);
    assert.equal(hub.O, O); // (not taken as observed: read again next time)
    assert.equal(hub.ledger.used, before);
    assert.equal(node(hub, "n").text, "hello");
    hub.ledger.used -= 1; // (now it fits exactly)
    await hub.observe(outside);
    assert.equal(hub.deferred, false);
    assert.equal(node(hub, "n").text, "changed outside");
    assert.ok(hub.ledger.peak <= hub.ledger.max);
  } finally { cleanup(); }
});

test("board open --edit hub: astra's r5 interleaving end to end: FILE changed in place to C after W3, then replaced by D; neither lost", async () => {
  const { realFs } = require("../src/board-edit-write");
  let file = "", once = true;
  const fsx = {
    ...realFs,
    link: (a: string, b: string) => {
      realFs.link(a, b);
      // (W3 has just linked prev: another program writes C in place, then replaces FILE with D)
      if (once && a === file && /sagebrush-prev/.test(b)) {
        once = false;
        fs.writeFileSync(file, text(B([{ id: "n", text: "hello", x: 1 }, { id: "m", text: "C" }])));
        const tmp = file + ".other-program";
        fs.writeFileSync(tmp, text(B([{ id: "n", text: "hello", x: 1 }, { id: "m", text: "C" }, { id: "d", text: "D" }])));
        fs.renameSync(tmp, file);
      }
    },
  };
  const dir = fs.mkdtempSync(join(tmpdir(), "sb-edit-hub-"));
  try {
    file = join(dir, "b.board.json");
    fs.writeFileSync(file, text(B([{ id: "n", text: "hello", x: 0 }, { id: "m", text: "m" }])));
    let now = 1_000_000;
    const hub = new EditHub(file, defaultLimits(), { now: () => now, fs: fsx });
    assert.ok((await hub.start(fs.readFileSync(file))).ok);
    hub.connect("t1");
    const s1 = snap(B([{ id: "n", text: "hello tab", x: 0 }, { id: "m", text: "m" }]));
    assert.ok("accepted" in hub.submit("t1", 1, hub.H.seq, s1, sha(s1)));
    now += hub.limits.SAVE_MAX_DELAY_MS;
    const r = await hub.save();
    assert.ok(!r.saved && r.why === "classified", JSON.stringify({ ...r, bytes: undefined }));
    // (C ingested: its changes in H, with the tab's; prev, which holds C, retained)
    assert.equal(node(hub, "m").text, "C");
    assert.equal(node(hub, "n").x, 1);
    assert.equal(node(hub, "n").text, "hello tab");
    assert.ok(hub.prevs.some((p) => fs.existsSync(p.path)));
    // (D, at FILE now, is a separate change, seen by the next read)
    await hub.observe(fs.readFileSync(file));
    assert.equal(node(hub, "d").text, "D");
    assert.equal(node(hub, "m").text, "C");
    assert.equal(node(hub, "n").text, "hello tab");
    now += hub.limits.SAVE_MAX_DELAY_MS;
    const r2 = await hub.save();
    assert.ok(r2.saved, JSON.stringify({ ...r2, bytes: undefined, state: hub.state }));
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.deepEqual(saved.nodes.map((x: any) => x.id).sort(), ["d", "m", "n"]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("board open --edit hub: at a clean exit, prevs unchanged since read and saved are removed; one changed since is kept", async () => {
  const { hub, clock, dir, file, cleanup } = await setup(B([{ id: "n", text: "hello" }]));
  try {
    hub.connect("t1");
    for (const [gen, t] of [[1, "a"], [2, "b"]] as const) {
      const s = snap(B([{ id: "n", text: t }]));
      hub.submit("t1", gen, hub.H.seq, s, sha(s));
      clock.advance(hub.limits.SAVE_MAX_DELAY_MS);
      assert.ok((await hub.save()).saved);
    }
    assert.equal(hub.prevs.length, 2);
    // (a program writes into the older prev after the board's last read of it)
    fs.writeFileSync(hub.prevs[0].path, text(B([{ id: "n", text: "late" }])));
    const keptPath = hub.prevs[0].path;
    assert.deepEqual(hub.closePrevs(), [keptPath]);
    const left = fs.readdirSync(dir).filter((x) => x !== "b.board.json");
    assert.deepEqual(left.map((x) => join(dir, x)), [keptPath]);
    assert.equal(hub.slots.used, 1);
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).nodes[0].text, "b");
  } finally { cleanup(); }
});
