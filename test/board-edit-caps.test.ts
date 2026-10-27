import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createHash } from "crypto";
import { EditHub } from "../src/board-edit-hub";
import { Gate, TokenBucket } from "../src/board-edit-gate";
import { EditServer, startEdit } from "../src/board-edit-serve";
import { defaultLimits } from "../src/board-edit-limits";
import { realFs, type WriteFs } from "../src/board-edit-write";
import { editRecords } from "../web/board/lossless";

// `board open --edit`'s caps where they are enforced, each at its exact bound and one past it (plan-board-open-edit
// r7 §8.1, §11 step 2).  MERGE_WORK, MERGE_MS, MEMORY_MAX, BODY_MAX, EDIT_MAX for a merged head and BACKUPS_MAX
// are in board-edit-hub, board-edit-serve and board-edit-write's tests; the rest here.
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const B = (nodes: any[]) => ({ format: "sagebrush-board", version: 1, title: "t", nodes, edges: [] });
const text = (d: any) => JSON.stringify(d, null, 2) + "\n";
const snap = (d: any) => editRecords(d).map((r) => JSON.stringify(r)).join("\n");
const KiB = 1024, MiB = 1024 * KiB;

async function hubOn(d: any, limits: Record<string, number> = {}, fsx?: WriteFs) {
  const dir = fs.mkdtempSync(join(tmpdir(), "sb-edit-caps-"));
  const file = join(dir, "b.board.json");
  fs.writeFileSync(file, text(d));
  let now = 1_000_000;
  const clock = { now: () => now, advance: (ms: number) => { now += ms; } };
  const hub = new EditHub(file, { ...defaultLimits(), ...limits }, { now: clock.now, fs: fsx });
  const r = await hub.start(fs.readFileSync(file));
  return { dir, file, hub, clock, started: r, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test("board open --edit caps: FILE_MAX and EDIT_MAX at start, exactly and one byte over", async () => {
  const sized = (n: number) => { const t = text(B([{ id: "n", text: "" }])); return text(B([{ id: "n", text: "x".repeat(n - t.length) }])); };
  for (const [cap, limits] of [["FILE_MAX", { FILE_MAX: 64 * KiB, EDIT_MAX: 64 * KiB, BODY_MAX: 64 * KiB }], ["EDIT_MAX", { EDIT_MAX: 64 * KiB, BODY_MAX: 64 * KiB }]] as const) {
    for (const extra of [0, 1]) {
      const dir = fs.mkdtempSync(join(tmpdir(), "sb-edit-caps-"));
      try {
        const file = join(dir, "b.board.json");
        fs.writeFileSync(file, sized(64 * KiB + extra));
        assert.equal(fs.statSync(file).size, 64 * KiB + extra);
        const r = await startEdit(file, { ...defaultLimits(), ...limits }, { now: () => 0 });
        if (extra === 0) assert.ok("hub" in r, `${cap}: ${"why" in r ? r.why : ""}`);
        else assert.ok("why" in r && /larger than/.test(r.why), `${cap}+1: ${JSON.stringify("why" in r ? r.why : "ok")}`);
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    }
  }
});

test("board open --edit caps: RECORDS_MAX for a submission, exactly and one over", async () => {
  // (a doc record and n item records)
  const t = await hubOn(B([{ id: "a" }]), { RECORDS_MAX: 100 });
  try {
    t.hub.connect("t1");
    const at = (n: number) => snap(B(Array.from({ length: n }, (_, i) => ({ id: "n" + i }))));
    const ok = at(99), over = at(100);
    assert.ok("accepted" in t.hub.submit("t1", 1, t.hub.H.seq, ok, sha(ok)));
    const r = t.hub.submit("t1", 2, t.hub.H.seq, over, sha(over));
    assert.ok("refused" in r && /RECORDS_MAX/.test(r.refused), JSON.stringify(r));
  } finally { t.cleanup(); }
});

test("board open --edit caps: ACKS_KEPT replays, then an evicted ack answered `included`", async () => {
  const t = await hubOn(B([{ id: "n", text: "0" }]), { ACKS_KEPT: 8 });
  try {
    t.hub.connect("t1");
    const subs: string[] = [];
    for (let g = 1; g <= 9; g++) { const s = snap(B([{ id: "n", text: String(g) }])); subs.push(s); assert.ok("accepted" in t.hub.submit("t1", g, t.hub.H.seq, s, sha(s))); }
    // (the last 8 still recorded: replayed; the 9th back evicted: included up to the watermark)
    assert.ok("accepted" in t.hub.submit("t1", 2, 1, subs[1], sha(subs[1])));
    const r = t.hub.submit("t1", 1, 1, subs[0], sha(subs[0]));
    assert.ok("included" in r && r.included === 9, JSON.stringify(r));
  } finally { t.cleanup(); }
});

test("board open --edit caps: TAB_TOMBSTONES kept, then the oldest dropped (unknownTab)", async () => {
  const t = await hubOn(B([{ id: "n" }]), { TAB_TOMBSTONES: 16 });
  try {
    const s = snap(B([{ id: "n", text: "x" }]));
    for (let i = 0; i <= 16; i++) { t.hub.connect("t" + i); t.hub.release("t" + i); }
    // (17 released, 16 kept: t0 dropped, t1 the oldest kept)
    assert.ok("unknownTab" in t.hub.submit("t0", 1, t.hub.H.seq, s, sha(s)));
    assert.ok("included" in t.hub.submit("t1", 1, t.hub.H.seq, s, sha(s)));
  } finally { t.cleanup(); }
});

test("board open --edit caps: SAVES_KEPT, an older copy flagged from the oldest save kept, not from one before", async () => {
  for (const [back, flagged] of [[2, true], [3, false]] as const) {
    // (SAVES_KEPT = 2: P and the save before it)
    const t = await hubOn(B([{ id: "n", text: "v0" }]), { SAVES_KEPT: 2 });
    try {
      t.hub.connect("t1");
      for (let g = 1; g <= 3; g++) {
        const s = snap(B([{ id: "n", text: "v" + g }]));
        assert.ok("accepted" in t.hub.submit("t1", g, t.hub.H.seq, s, sha(s)));
        t.clock.advance(t.hub.limits.SAVE_MAX_DELAY_MS);
        assert.ok((await t.hub.save()).saved);
      }
      t.hub.events.length = 0;
      // (saves: v0 (P₀), v1, v2, v3 = P; an outside program writes back the value `back` saves before P)
      await t.hub.observe(Buffer.from(text(B([{ id: "n", text: "v" + (3 - back + 1) }]))));
      const flags = t.hub.events.flatMap((e) => e.reports).filter((r) => r.kind === "older-copy");
      assert.equal(flags.length > 0, flagged, `${back} back`);
    } finally { t.cleanup(); }
  }
});

test("board open --edit caps: HISTORY_PATCHES, a base in the window merged, one past it stale", async () => {
  const t = await hubOn(B([{ id: "n", text: "0" }]), { HISTORY_PATCHES: 100 });
  try {
    t.hub.connect("t1");
    const first = t.hub.H.seq;
    // (101 heads after P₀: the window, the latest 100, holds first+2 .. first+101; P₀ is kept as P)
    for (let g = 1; g <= 101; g++) { const s = snap(B([{ id: "n", text: String(g) }])); assert.ok("accepted" in t.hub.submit("t1", g, t.hub.H.seq, s, sha(s))); }
    assert.equal(t.hub.head(first + 1), undefined, "one past the window: not held");
    assert.ok(t.hub.head(first + 2), "the oldest in the window: held");
    const s = snap(B([{ id: "n", text: "late" }]));
    assert.ok("stale" in t.hub.submit("t1", 102, first + 1, s, sha(s)));
    assert.ok("accepted" in t.hub.submit("t1", 102, first + 2, s, sha(s)));
  } finally { t.cleanup(); }
});

test("board open --edit caps: CONFLICTS_MAX reports in one event, exactly", async () => {
  const n = 12;
  // (a scalar changed both ways in each of 12 nodes: 12 conflicts)
  const t = await hubOn(B(Array.from({ length: n }, (_, i) => ({ id: "n" + i, x: 0 }))), { CONFLICTS_MAX: 10 });
  try {
    t.hub.connect("t1");
    t.hub.connect("t2");
    const base = t.hub.H.seq;
    const mine = snap(B(Array.from({ length: n }, (_, i) => ({ id: "n" + i, x: 1 }))));
    const theirs = snap(B(Array.from({ length: n }, (_, i) => ({ id: "n" + i, x: 2 }))));
    assert.ok("accepted" in t.hub.submit("t1", 1, base, mine, sha(mine)));
    t.hub.events.length = 0;
    assert.ok("accepted" in t.hub.submit("t2", 1, base, theirs, sha(theirs)));
    const e = t.hub.events.at(-1)!;
    assert.equal(e.reports.length, 10);
    assert.ok(e.alternatives.length <= 10);
    // (at CONFLICTS_MAX 12, all of them)
    const all = await hubOn(B(Array.from({ length: n }, (_, i) => ({ id: "n" + i, x: 0 }))), { CONFLICTS_MAX: 12 });
    try {
      all.hub.connect("t1"); all.hub.connect("t2");
      const b2 = all.hub.H.seq;
      all.hub.submit("t1", 1, b2, mine, sha(mine));
      all.hub.events.length = 0;
      all.hub.submit("t2", 1, b2, theirs, sha(theirs));
      assert.equal(all.hub.events.at(-1)!.reports.length, 12);
    } finally { all.cleanup(); }
  } finally { t.cleanup(); }
});

test("board open --edit caps: SAVE_QUIET_MS, SAVE_MAX_DELAY_MS and WRITE_MIN_MS, each exactly and one ms short", async () => {
  const t = await hubOn(B([{ id: "n", text: "0" }]), { SAVE_QUIET_MS: 1000, SAVE_MAX_DELAY_MS: 5000, WRITE_MIN_MS: 500 });
  try {
    t.hub.connect("t1");
    const s = snap(B([{ id: "n", text: "1" }]));
    t.hub.submit("t1", 1, t.hub.H.seq, s, sha(s));
    const at = t.clock.now();
    assert.equal(t.hub.due(at + 999), false);
    assert.equal(t.hub.due(at + 1000), true);
    t.clock.advance(1000);
    assert.ok((await t.hub.save()).saved);
    const saved = t.clock.now();
    const s2 = snap(B([{ id: "n", text: "2" }]));
    t.hub.submit("t1", 2, t.hub.H.seq, s2, sha(s2));
    // (Save now: no quiet, but WRITE_MIN_MS since the last write)
    assert.equal(t.hub.due(saved + 499, true), false);
    assert.equal(t.hub.due(saved + 500, true), true);
    // (SAVE_MAX_DELAY_MS: due, whatever the quiet, once the oldest unsaved change is that old)
    assert.equal(t.hub.due(saved + 4999), true); // (quiet passed too: 1000 ms)
  } finally { t.cleanup(); }
});

test("board open --edit caps: WRITE_RETRY_MS, a failing save shown not saved only after it, exactly", async () => {
  let failing = true;
  const fsx: WriteFs = { ...realFs, writeFile: (p, d, m) => { if (failing) throw Object.assign(new Error("EBUSY: open in another program"), { code: "EBUSY" }); realFs.writeFile(p, d, m); } };
  const t = await hubOn(B([{ id: "n", text: "0" }]), { WRITE_RETRY_MS: 10_000, WRITE_MIN_MS: 500 }, fsx);
  try {
    t.hub.connect("t1");
    const s = snap(B([{ id: "n", text: "1" }]));
    t.hub.submit("t1", 1, t.hub.H.seq, s, sha(s));
    t.clock.advance(t.hub.limits.SAVE_MAX_DELAY_MS);
    assert.ok(!(await t.hub.save()).saved);
    assert.equal(t.hub.state.state, "ok"); // (retrying: Saving…)
    t.clock.advance(9_999);
    assert.ok(!(await t.hub.save()).saved);
    assert.equal(t.hub.state.state, "ok");
    t.clock.advance(1);
    assert.ok(!(await t.hub.save()).saved);
    const held = t.hub.state as { state: string; why?: string };
    assert.ok(held.state === "held" && held.why === "error");
    // (still retried; a save that succeeds clears it)
    failing = false;
    t.clock.advance(500);
    assert.equal(t.hub.due(t.clock.now()), true);
    assert.ok((await t.hub.save()).saved);
    assert.equal((t.hub.state as { state: string }).state, "ok");
  } finally { t.cleanup(); }
});

test("board open --edit caps: TAB_RATE and GLOBAL_RATE, exactly the rate in a second, then one more refused", () => {
  let now = 0;
  const b = new TokenBucket(20, () => now);
  for (let i = 0; i < 20; i++) assert.ok(b.take().ok, `take ${i}`);
  const r = b.take();
  assert.ok(!r.ok && r.retryMs === 50);
  now += 50;
  assert.ok(b.take().ok);
  const L = { ...defaultLimits(), TAB_RATE: 3, GLOBAL_RATE: 4, QUEUE_MAX: 1000 };
  const g = new Gate(L, () => now);
  for (let i = 0; i < 3; i++) { const a = g.edit("t1", 10); assert.ok(a.ok); a.ticket.release(); }
  const t1 = g.edit("t1", 10);
  assert.ok(!t1.ok && t1.busy === "rate");
  const t2 = g.edit("t2", 10);
  assert.ok(t2.ok); // (the 4th of GLOBAL_RATE's)
  t2.ticket.release();
  const t3 = g.edit("t3", 10);
  assert.ok(!t3.ok && t3.busy === "rate");
});

test("board open --edit caps: QUEUE_MAX and QUEUE_BYTES, exactly full, then one more refused; one in flight per tab", () => {
  const now = 0;
  const L: Record<string, number> = { ...defaultLimits(), QUEUE_MAX: 3, QUEUE_BYTES: MiB, TAB_RATE: 1000, GLOBAL_RATE: 10_000 };
  const g = new Gate(L, () => now);
  const a = g.edit("a", 100), b = g.edit("b", 100), c = g.edit("c", 100);
  assert.ok(a.ok && b.ok && c.ok);
  const d = g.edit("d", 100);
  assert.ok(!d.ok && d.busy === "queue");
  assert.ok(a.ok); a.ticket.release();
  const same = g.edit("b", 1);
  assert.ok(!same.ok && same.busy === "in-flight");
  b.ok && b.ticket.release(); c.ok && c.ticket.release();
  const full = g.edit("x", MiB);
  assert.ok(full.ok);
  const over = g.edit("y", 1);
  assert.ok(!over.ok && over.busy === "queue");
  full.ok && full.ticket.release();
  // (chunked: counted as BODY_MAX)
  const chunked = new Gate({ ...L, QUEUE_BYTES: L.BODY_MAX }, () => now);
  const ch = chunked.edit("c", null);
  assert.ok(ch.ok && ch.ticket.bytes === L.BODY_MAX);
  assert.ok(!chunked.edit("d", 1).ok);
});

test("board open --edit caps: MAX_CLIENTS tabs registered, one more refused; PENDING_MAX, a tab that stops reading closed", async () => {
  const t = await hubOn(B([{ id: "n" }]), { MAX_CLIENTS: 2, PENDING_MAX: 4096 });
  try {
    const es = new EditServer(t.hub, t.hub.limits, {}, t.clock.now);
    const res = () => {
      const r: any = { status: 0, writableLength: 0, body: "", destroyed: false, ended: false, headersSent: false,
        writeHead(s: number) { r.status = s; r.headersSent = true; return r; }, end(b?: string) { r.body = b ?? ""; r.ended = true; return r; },
        write(s: string) { r.writableLength += Buffer.byteLength(s); return false; }, destroy() { r.destroyed = true; } };
      return r;
    };
    const req = () => ({ on() {}, method: "GET", headers: {} }) as any;
    const tabs = ["tab-aaaaaaaaaaaaaaaa", "tab-bbbbbbbbbbbbbbbb", "tab-cccccccccccccccc"];
    const rs = tabs.map(() => res());
    tabs.forEach((tab, i) => es.handle(req(), rs[i], new URL(`http://x/events?key=k&tab=${tab}`)));
    assert.deepEqual(rs.map((r) => r.status), [200, 200, 503]);
    // (events past PENDING_MAX for a tab that reads nothing: closed, never more waiting than the bound)
    for (let i = 0; i < 1000 && !rs[0].destroyed; i++) { t.hub.events.push({ seq: i, persistedSeq: 0, reports: [], alternatives: [], source: "tab" }); es.flush(); }
    assert.ok(rs[0].destroyed);
    assert.ok(rs[0].writableLength <= 4096);
  } finally { t.cleanup(); }
});

test("board open --edit: a symlinked FILE: its target is what is saved, the link kept", async () => {
  const dir = fs.mkdtempSync(join(tmpdir(), "sb-edit-link-"));
  try {
    const target = join(dir, "real.board.json"), link = join(dir, "link.board.json");
    fs.writeFileSync(target, text(B([{ id: "n", text: "hello" }])));
    fs.symlinkSync(target, link);
    let now = 0;
    const r = await startEdit(link, defaultLimits(), { now: () => now });
    assert.ok("hub" in r);
    const hub = (r as { hub: EditHub }).hub;
    assert.equal(hub.file, fs.realpathSync(target));
    hub.connect("t1");
    const s = snap(B([{ id: "n", text: "edited" }]));
    assert.ok("accepted" in hub.submit("t1", 1, hub.H.seq, s, sha(s)));
    now += hub.limits.SAVE_MAX_DELAY_MS;
    assert.ok((await hub.save()).saved);
    assert.ok(fs.lstatSync(link).isSymbolicLink());
    assert.equal(JSON.parse(fs.readFileSync(link, "utf8")).nodes[0].text, "edited");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
