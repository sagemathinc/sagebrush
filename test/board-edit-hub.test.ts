import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createHash } from "crypto";
import { EditHub } from "../src/board-edit-hub";
import { defaultLimits } from "../src/board-edit-limits";
import { editRecords } from "../web/board/lossless";

// The hub of `board open --edit` (plan-board-open-edit r7 §4, §5, §6), on a real directory with a fake clock:
// P₀ and what can't be edited; tabs' submissions (accepted, replayed, mismatched, stale, unknown, reactivated
// from a tombstone); saving (quiet, then written; persistedSeq and persistedGen); an outside version merged
// against P with a tab's edit; the file adopted when it is the board; and §4.3's older-copy flag.
const { mergeStrings3 } = require("patchflow");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const B = (nodes: any[], extra: any = {}) => ({ format: "sagebrush-board", version: 1, title: "t", nodes, edges: [], ...extra });
const text = (d: any) => JSON.stringify(d, null, 2) + "\n";
const snap = (d: any) => editRecords(d).map((r) => JSON.stringify(r)).join("\n");

async function setup(d: any) {
  const dir = fs.mkdtempSync(join(tmpdir(), "sb-edit-hub-"));
  const file = join(dir, "b.board.json");
  fs.writeFileSync(file, text(d));
  let now = 1_000_000;
  const clock = { now: () => now, advance: (ms: number) => { now += ms; } };
  const hub = new EditHub(file, defaultLimits(), { mergeStrings3, now: clock.now });
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
