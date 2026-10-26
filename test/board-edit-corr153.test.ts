import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as http from "http";
import { join } from "path";
import { tmpdir } from "os";
import { createHash } from "crypto";
import { spawn } from "child_process";
import { EventEmitter } from "events";
import type { AddressInfo } from "net";
import { EditHub } from "../src/board-edit-hub";
import { EditServer, EditWatch, startEdit } from "../src/board-edit-serve";
import { Gate } from "../src/board-edit-gate";
import { defaultLimits, resolveLimits } from "../src/board-edit-limits";
import * as W from "../src/board-edit-write";
import { editRecords } from "../web/board/lossless";
import { ABSENT } from "../web/board/merge";

// #153's first review (astra's CORR-153-1..8; daybreak3's SLOW-DROP-1 and SSE-LEDGER-2), one test each, every one
// failing on 0eaa9672: a directory fsync that failed is not Saved; FILE back at P ends the hold FILE caused;
// adopting FILE advances persistedGen; reports reach the tabs with their alternatives (and a tab that connects
// later); the prevs a failed save keeps are watched, and a name it couldn't unlink keeps its slot; a stream dropped
// as slow is released like any other; a snapshot nested too deeply is refused, the server alive; an ordinary
// outside change is reported with its restore; the event backlogs are on the ledger, and bounded by MEMORY_MAX.
const { mergeStrings3 } = require("patchflow");
const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
const B = (nodes: any[], edges: any[] = []) => ({ format: "sagebrush-board", version: 1, title: "t", nodes, edges });
const text = (d: any) => JSON.stringify(d, null, 2) + "\n";
const snap = (d: any) => editRecords(d).map((r) => JSON.stringify(r)).join("\n");
const KiB = 1024, MiB = 1024 * KiB;
const TAB = "tab-aaaaaaaaaaaaaaaa", TAB2 = "tab-bbbbbbbbbbbbbbbb";
const EIO = () => Object.assign(new Error("EIO: i/o error, fsync"), { code: "EIO" });

async function setup(d: any, limits: Record<string, number> = {}, fsx?: W.WriteFs) {
  const dir = fs.mkdtempSync(join(tmpdir(), "sb-edit-153-"));
  const file = join(dir, "b.board.json");
  fs.writeFileSync(file, text(d));
  let now = 1_000_000;
  const clock = { now: () => now, advance: (ms: number) => { now += ms; } };
  const L = { ...defaultLimits(), ...limits };
  const hub = new EditHub(file, L, { mergeStrings3, now: clock.now, fs: fsx });
  const r = await hub.start(fs.readFileSync(file));
  assert.ok(r.ok, !r.ok ? r.why : "");
  return { dir, file, hub, clock, L, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
const submit = (hub: EditHub, tab: string, gen: number, d: any, base = hub.H.seq) => { const s = snap(d); return hub.submit(tab, gen, base, s, sha(s)); };
const node = (hub: EditHub, id: string) => hub.H.json.nodes.find((n: any) => n.id === id);
const sidecars = (dir: string, file: string) => fs.readdirSync(dir).filter((n) => W.isSidecar(file, n));
const reportsOf = (hub: EditHub) => hub.events.flatMap((e) => e.reports);
const altsOf = (hub: EditHub) => hub.events.flatMap((e) => e.alternatives);

test("CORR-153-1: a directory fsync that fails at W7 isn't a save; the sync retried completes it", async () => {
  let failing = true;
  const fsx: W.WriteFs = { ...W.realFs, fsyncDir: (d) => { if (failing) throw EIO(); return W.realFs.fsyncDir(d); } };
  const t = await setup(B([{ id: "n", x: 0 }]), {}, fsx);
  try {
    t.hub.connect(TAB);
    assert.ok("accepted" in submit(t.hub, TAB, 1, B([{ id: "n", x: 1 }])));
    const P = t.hub.P, seq = t.hub.persistedSeq;
    t.clock.advance(t.L.SAVE_MAX_DELAY_MS);
    const r = await t.hub.save();
    assert.ok(!r.saved && r.why === "unsynced", JSON.stringify(r));
    // (FILE holds the bytes, but nothing says Saved)
    assert.equal(JSON.parse(fs.readFileSync(t.file, "utf8")).nodes[0].x, 1);
    assert.equal(t.hub.P, P);
    assert.equal(t.hub.persistedSeq, seq);
    assert.equal(t.hub.tabView(TAB).persistedGen, 0);
    assert.ok(!t.hub.events.some((e) => e.source === "save"));
    // (FILE, read again, is the bytes we wrote: not adopted as saved, the sync still owed)
    await t.hub.observe(fs.readFileSync(t.file));
    assert.equal(t.hub.persistedSeq, seq);
    assert.equal(t.hub.tabView(TAB).persistedGen, 0);
    // (a sidecar per slot: the retained prev only)
    assert.equal(t.hub.slots.used, sidecars(t.dir, t.file).length);
    // (retried as the write queue paces it: the sync alone, then saved)
    failing = false;
    t.clock.advance(t.L.WRITE_MIN_MS);
    assert.ok(t.hub.due());
    const again = await t.hub.save();
    assert.ok(again.saved, JSON.stringify(again));
    assert.equal(t.hub.persistedSeq, t.hub.H.seq);
    assert.equal(t.hub.tabView(TAB).persistedGen, 1);
  } finally { t.cleanup(); }
});

test("CORR-153-1: through the real adapter, an fsync error on the directory reaches the save (none swallowed)", async () => {
  const makeRealFs = (W as any).makeRealFs as ((n: typeof fs, platform?: string) => W.WriteFs) | undefined;
  assert.equal(typeof makeRealFs, "function", "the real adapter takes the fs it calls");
  const dirFds = new Set<number>();
  const n = {
    ...fs,
    openSync: (p: fs.PathLike, ...rest: any[]) => { const fd = (fs.openSync as any)(p, ...rest); if (fs.statSync(p).isDirectory()) dirFds.add(fd); return fd; },
    fsyncSync: (fd: number) => { if (dirFds.has(fd)) throw EIO(); return fs.fsyncSync(fd); },
    closeSync: (fd: number) => { dirFds.delete(fd); return fs.closeSync(fd); },
  } as typeof fs;
  const real = makeRealFs!(n, "linux");
  const dir = fs.mkdtempSync(join(tmpdir(), "sb-edit-153-"));
  try {
    assert.throws(() => real.fsyncDir(dir), /EIO/);
    // (a file's own fsync unaffected)
    fs.writeFileSync(join(dir, "f"), "x");
    real.fsync(join(dir, "f"));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  const t = await setup(B([{ id: "n", x: 0 }]), {}, real);
  try {
    t.hub.connect(TAB);
    submit(t.hub, TAB, 1, B([{ id: "n", x: 1 }]));
    t.clock.advance(t.L.SAVE_MAX_DELAY_MS);
    const r = await t.hub.save();
    assert.ok(!r.saved && r.why === "unsynced");
    assert.equal(t.hub.tabView(TAB).persistedGen, 0);
  } finally { t.cleanup(); }
});

test("CORR-153-2: FILE invalid, then P again; deleted, then P again: saving resumes, through the watcher", async () => {
  for (const how of ["invalid", "deleted"] as const) {
    const t = await setup(B([{ id: "n", x: 0 }]));
    const es = new EditServer(t.hub, t.L, {}, t.clock.now);
    const watch = new EditWatch(t.hub, es, t.file, t.L.FILE_MAX, 0, (p) => { try { const s = fs.statSync(p); return `${s.size}:${s.mtimeMs}:${s.ino}`; } catch { return null; } });
    try {
      const original = fs.readFileSync(t.file);
      t.hub.connect(TAB);
      submit(t.hub, TAB, 1, B([{ id: "n", x: 1 }]));
      if (how === "invalid") fs.writeFileSync(t.file, "{invalid");
      else fs.unlinkSync(t.file);
      await watch.tick(t.clock.now());
      assert.equal(t.hub.state.state, "held", how);
      fs.writeFileSync(t.file, original);
      await watch.tick(t.clock.now());
      assert.equal(t.hub.state.state, "ok", how);
      t.clock.advance(t.L.SAVE_MAX_DELAY_MS);
      assert.ok(t.hub.due(), how);
      await watch.tick(t.clock.now());
      assert.equal(JSON.parse(fs.readFileSync(t.file, "utf8")).nodes[0].x, 1, how);
      assert.equal(t.hub.tabView(TAB).persistedGen, 1, how);
    } finally { t.cleanup(); }
  }
  // (a hold of another cause stays: FILE being P says nothing about the slots)
  const t = await setup(B([{ id: "n", x: 0 }]), { BACKUPS_MAX: 1 });
  try {
    t.hub.connect(TAB);
    submit(t.hub, TAB, 1, B([{ id: "n", x: 1 }]));
    t.clock.advance(t.L.SAVE_MAX_DELAY_MS);
    assert.ok(!(await t.hub.save()).saved);
    assert.ok(t.hub.state.state === "held" && t.hub.state.why === "slots");
    await t.hub.observe(fs.readFileSync(t.file));
    assert.ok(t.hub.state.state === "held" && t.hub.state.why === "slots");
  } finally { t.cleanup(); }
});

test("CORR-153-3: FILE adopted as the head advances persistedGen, kept across a tombstone; unsynced, it doesn't", async () => {
  const t = await setup(B([{ id: "n", x: 0 }]));
  try {
    t.hub.connect(TAB);
    assert.ok("accepted" in submit(t.hub, TAB, 1, B([{ id: "n", x: 1 }])));
    t.hub.events.length = 0;
    // (another program writes exactly the board, the tab's edit included)
    fs.writeFileSync(t.file, text(B([{ id: "n", x: 1 }])));
    await t.hub.observe(fs.readFileSync(t.file));
    assert.equal(t.hub.persistedSeq, t.hub.H.seq);
    assert.equal(t.hub.tabView(TAB).persistedGen, 1);
    assert.ok(t.hub.events.some((e) => e.source === "save"), "the tabs are told");
    assert.equal(t.hub.due(t.clock.now() + t.L.SAVE_MAX_DELAY_MS), false);
    // (released, then reactivated from its tombstone: still saved)
    t.hub.release(TAB);
    assert.equal(t.hub.tabView(TAB).persistedGen, 1);
    const s = snap(B([{ id: "n", x: 2 }]));
    assert.ok("included" in t.hub.submit(TAB, 2, t.hub.H.seq, s, sha(s)));
    assert.equal(t.hub.tabView(TAB).persistedGen, 1);
  } finally { t.cleanup(); }
  // (FILE's fsync failing when it is adopted: nothing advanced, the sync retried as a save)
  let failing = true;
  const u = await setup(B([{ id: "n", x: 0 }]), {}, { ...W.realFs, fsyncDir: (d) => { if (failing) throw EIO(); return W.realFs.fsyncDir(d); } });
  try {
    u.hub.connect(TAB);
    submit(u.hub, TAB, 1, B([{ id: "n", x: 1 }]));
    fs.writeFileSync(u.file, text(B([{ id: "n", x: 1 }])));
    await u.hub.observe(fs.readFileSync(u.file));
    assert.equal(u.hub.tabView(TAB).persistedGen, 0);
    failing = false;
    u.clock.advance(u.L.SAVE_MAX_DELAY_MS);
    assert.ok(u.hub.due());
    assert.ok((await u.hub.save()).saved);
    assert.equal(u.hub.tabView(TAB).persistedGen, 1);
  } finally { u.cleanup(); }
});

// ---- over real HTTP: the server's events, and /changes
async function serve(d: any, limits: Record<string, number> = {}) {
  const dir = fs.mkdtempSync(join(tmpdir(), "sb-edit-153-serve-"));
  const file = join(dir, "b.board.json");
  fs.writeFileSync(file, text(d));
  const L = { ...defaultLimits(), ...limits };
  const started = await startEdit(file, L, { mergeStrings3, now: Date.now });
  assert.ok("hub" in started, "why" in started ? started.why : "");
  const hub = (started as { hub: EditHub }).hub;
  const es = new EditServer(hub, L, {}, Date.now);
  const server = http.createServer((req, res) => { const url = new URL(req.url ?? "/", "http://127.0.0.1"); if (!es.handle(req, res, url)) res.writeHead(404).end(); });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const port = (server.address() as AddressInfo).port;
  const close = async () => { es.close(); server.closeAllConnections(); await new Promise((ok) => server.close(ok)); fs.rmSync(dir, { recursive: true, force: true }); };
  return { dir, file, hub, es, port, close };
}
function request(port: number, method: string, path: string, body?: string): Promise<{ status: number; text: string }> {
  return new Promise((ok, fail) => {
    const headers: Record<string, string> = method === "POST" ? { "Content-Type": "application/x-ndjson", "Content-Length": String(Buffer.byteLength(body ?? "")) } : {};
    const req = http.request({ host: "127.0.0.1", port, method, path, headers, agent: false }, (res) => {
      let t = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (t += c));
      res.on("end", () => ok({ status: res.statusCode!, text: t }));
    });
    req.on("error", fail);
    if (body !== undefined) req.write(body);
    req.end();
  });
}
function events(port: number, tab: string) {
  const got: { event: string; data: any }[] = [];
  let buf = "";
  const req = http.get({ host: "127.0.0.1", port, path: `/events?key=k&tab=${tab}`, agent: false }, (res) => {
    res.setEncoding("utf8");
    res.on("data", (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        const ev = /^event: (.*)$/m.exec(block)?.[1], data = /^data: (.*)$/m.exec(block)?.[1];
        if (ev && data) got.push({ event: ev, data: JSON.parse(data) });
      }
    });
  });
  req.on("error", () => {});
  const until = async (f: () => boolean) => { for (let i = 0; i < 300 && !f(); i++) await new Promise((r) => setTimeout(r, 10)); assert.ok(f(), JSON.stringify(got).slice(0, 2000)); };
  return { got, until, close: () => req.destroy() };
}
const editPath = (tab: string, gen: number, base: number, hash: string) => `/edit?key=k&tab=${tab}&gen=${gen}&base=${base}&hash=${hash}`;
const post = (port: number, tab: string, gen: number, base: number, d: any) => { const s = snap(d); return request(port, "POST", editPath(tab, gen, base, sha(s)), s); };
const sentChanges = (got: { event: string; data: any }[]) => got.filter((e) => e.event === "board").flatMap((e) => e.data.changes ?? []);

test("CORR-153-4: conflicts' alternatives reach the tabs with their reports, bound to the head; a tab connecting later gets them", async () => {
  // (a scalar both ways; null against absent; a record deleted on one side and edited on the other; an edge to a
  // node the other side deleted, removed, its alternative the edge with its end)
  const base = B([{ id: "n", x: 0, y: 0 }, { id: "m", x: 0 }, { id: "k", x: 0 }]);
  const t = await serve(base);
  try {
    const a = events(t.port, TAB), b = events(t.port, TAB2);
    await a.until(() => a.got.length >= 1);
    await b.until(() => b.got.length >= 1);
    const P = t.hub.H.seq;
    const mine = B([{ id: "n", x: 1, y: null }, { id: "m", x: 0 }]);
    const theirs = B([{ id: "n", x: 2 }, { id: "k", x: 5 }], [{ id: "e", from: "n", to: "m" }]);
    assert.ok(JSON.parse((await post(t.port, TAB, 1, P, mine)).text).accepted);
    const r = JSON.parse((await post(t.port, TAB2, 1, P, theirs)).text);
    assert.ok(r.accepted, JSON.stringify(r));
    await a.until(() => sentChanges(a.got).some((c: any) => c.seq === r.seq));
    const c = sentChanges(a.got).find((x: any) => x.seq === r.seq);
    const alt = (f: (x: any) => boolean) => c.alternatives.some(f);
    assert.ok(alt((x) => x.field === "x" && typeof x.value === "number"), "scalar");
    assert.ok(alt((x) => x.field === "y"), "null against absent");
    assert.ok(alt((x) => "record" in x && x.record === null), "deleted against edited");
    assert.ok(alt((x) => Array.isArray(x.records) && x.records.length === 2), "the removed edge with its end");
    assert.ok(c.reports.some((x: any) => x.kind === "edge-removed"));
    // (the other tab told the same)
    await b.until(() => sentChanges(b.got).some((x: any) => x.seq === r.seq && x.alternatives.length === c.alternatives.length));
    // (a tab connecting later: the kept batches in its first event; and /changes)
    const later = events(t.port, "tab-cccccccccccccccc");
    await later.until(() => later.got.length >= 1);
    assert.ok(sentChanges(later.got).some((x: any) => x.seq === r.seq && x.alternatives.length === c.alternatives.length));
    const ch = JSON.parse((await request(t.port, "GET", `/changes?key=k&tab=${TAB}&after=${P}`)).text);
    assert.ok(ch.complete);
    assert.ok(ch.changes.some((x: any) => x.seq === r.seq && x.alternatives.length === c.alternatives.length));
    a.close(); b.close(); later.close();
  } finally { await t.close(); }
});

test("CORR-153-4: a batch past CONFLICTS_MAX says what it cut; one too large to send inline is fetched from /changes", async () => {
  const n = 12;
  const t = await serve(B(Array.from({ length: n }, (_, i) => ({ id: "n" + i, x: 0 }))), { CONFLICTS_MAX: 10, PENDING_MAX: 4 * KiB });
  try {
    const a = events(t.port, TAB);
    await a.until(() => a.got.length >= 1);
    const P = t.hub.H.seq;
    await post(t.port, TAB, 1, P, B(Array.from({ length: n }, (_, i) => ({ id: "n" + i, x: 1, pad: "p".repeat(40) }))));
    // (a second tab, made known to the hub without a stream, conflicts in every node)
    t.hub.connect(TAB2);
    const r = JSON.parse((await post(t.port, TAB2, 1, P, B(Array.from({ length: n }, (_, i) => ({ id: "n" + i, x: 2, pad: "q".repeat(40) }))))).text);
    assert.ok(r.accepted, JSON.stringify(r));
    await a.until(() => a.got.some((e) => e.event === "board" && e.data.seq === r.seq));
    const ev = a.got.find((e) => e.event === "board" && e.data.seq === r.seq)!;
    // (more than a quarter of PENDING_MAX: not inline, and the stream not dropped for it)
    assert.equal(ev.data.more, true);
    const ch = JSON.parse((await request(t.port, "GET", `/changes?key=k&tab=${TAB}&after=${P}`)).text);
    const c = ch.changes.find((x: any) => x.seq === r.seq);
    assert.equal(c.reports.length, 10);
    assert.ok(c.omitted >= 2, JSON.stringify(c.omitted));
    assert.equal(t.es.tabs, 1);
    a.close();
  } finally { await t.close(); }
});

test("CORR-153-5: a prev kept by W5's ENOENT is watched: a write into it through an old handle is merged", async () => {
  let armed = false;
  let file = "";
  const fsx: W.WriteFs = { ...W.realFs, rename: (a, b) => { if (armed && a === file) { armed = false; fs.unlinkSync(a); throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); } W.realFs.rename(a, b); } };
  const t = await setup(B([{ id: "n", x: 0 }, { id: "m", x: 0 }]), {}, fsx);
  file = t.file;
  try {
    t.hub.connect(TAB);
    submit(t.hub, TAB, 1, B([{ id: "n", x: 1 }, { id: "m", x: 0 }]));
    // (a program holding FILE open)
    const fd = fs.openSync(t.file, "r+");
    armed = true;
    t.clock.advance(t.L.SAVE_MAX_DELAY_MS);
    const r = await t.hub.save();
    assert.ok(!r.saved && r.why === "deleted" && r.prev);
    assert.equal(t.hub.prevs.length, 1);
    assert.equal(t.hub.slots.used, sidecars(t.dir, t.file).length);
    // (it writes through its handle: the inode now named prev)
    const late = Buffer.from(text(B([{ id: "n", x: 0 }, { id: "m", x: 77 }])));
    fs.ftruncateSync(fd, 0); fs.writeSync(fd, late, 0, late.length, 0); fs.closeSync(fd);
    await t.hub.tickPrevs(0);
    assert.equal(node(t.hub, "m").x, 77);
    assert.equal(node(t.hub, "n").x, 1);
    // (FILE still missing: still held as deleted)
    assert.ok(t.hub.state.state === "held" && t.hub.state.why === "deleted");
  } finally { t.cleanup(); }
});

test("CORR-153-5: W5's EEXIST: prev and prev2 both watched, prev2 merged at once; W6's EEXIST: prev watched", async () => {
  // (W5: FILE replaced (D) between W3 and W5, then, after the rename, a new FILE (E) before the restore)
  let file = "", mode: "w5" | "w6" | null = null;
  const fsx: W.WriteFs = {
    ...W.realFs,
    rename: (a, b) => {
      if (mode === "w5" && a === file) {
        mode = null;
        fs.writeFileSync(file + ".d", text(B([{ id: "n", x: 0 }, { id: "m", x: 0 }, { id: "d", x: 4 }])));
        fs.renameSync(file + ".d", file);
        W.realFs.rename(a, b);
        fs.writeFileSync(file, text(B([{ id: "n", x: 0 }, { id: "m", x: 0 }, { id: "e", x: 5 }])));
        return;
      }
      W.realFs.rename(a, b);
    },
    link: (a, b) => {
      if (mode === "w6" && b === file && a.endsWith(".tmp")) { mode = null; fs.writeFileSync(file, text(B([{ id: "n", x: 0 }, { id: "m", x: 0 }, { id: "e", x: 6 }]))); }
      W.realFs.link(a, b);
    },
  };
  for (const which of ["w5", "w6"] as const) {
    const t = await setup(B([{ id: "n", x: 0 }, { id: "m", x: 0 }]), {}, fsx);
    file = t.file;
    try {
      t.hub.connect(TAB);
      submit(t.hub, TAB, 1, B([{ id: "n", x: 1 }, { id: "m", x: 0 }]));
      const fd = fs.openSync(t.file, "r+");
      mode = which;
      t.clock.advance(t.L.SAVE_MAX_DELAY_MS);
      const r = await t.hub.save();
      assert.ok(!r.saved && r.why === "eexist", `${which}: ${JSON.stringify(r)}`);
      assert.equal(t.hub.prevs.length, which === "w5" ? 2 : 1, which);
      assert.equal(t.hub.slots.used, sidecars(t.dir, t.file).length, which);
      // (W5: D, at prev2, merged before the new FILE is read: in the order they were seen)
      if (which === "w5") assert.equal(node(t.hub, "d")?.x, 4);
      // (the program with the old handle writes into prev)
      const late = Buffer.from(text(B([{ id: "n", x: 0 }, { id: "m", x: 77 }])));
      fs.ftruncateSync(fd, 0); fs.writeSync(fd, late, 0, late.length, 0); fs.closeSync(fd);
      await t.hub.tickPrevs(0);
      assert.equal(node(t.hub, "m").x, 77, which);
      // (the new FILE, read by the watcher next, merged too)
      await t.hub.observe(fs.readFileSync(t.file));
      assert.ok(node(t.hub, "e"), which);
      assert.equal(node(t.hub, "n").x, 1, which);
    } finally { t.cleanup(); }
  }
});

test("CORR-153-5: a sidecar whose name can't be unlinked keeps its slot, and is unlinked later", async () => {
  let failing = true;
  const fsx: W.WriteFs = { ...W.realFs, unlink: (p) => { if (failing && p.endsWith(".tmp")) throw Object.assign(new Error("EPERM"), { code: "EPERM" }); W.realFs.unlink(p); } };
  const t = await setup(B([{ id: "n", x: 0 }]), {}, fsx);
  try {
    t.hub.connect(TAB);
    submit(t.hub, TAB, 1, B([{ id: "n", x: 1 }]));
    t.clock.advance(t.L.SAVE_MAX_DELAY_MS);
    assert.ok((await t.hub.save()).saved);
    // (tmp's name still there: its slot still held; and prev's)
    assert.equal(sidecars(t.dir, t.file).length, 2);
    assert.equal(t.hub.slots.used, 2);
    failing = false;
    await t.hub.tickPrevs(Infinity);
    assert.equal(sidecars(t.dir, t.file).length, 1);
    assert.equal(t.hub.slots.used, 1);
  } finally { t.cleanup(); }
});

// ---- a stream as the server sees it, without a socket
function mockStream(req: EventEmitter, o: { full?: boolean } = {}) {
  const r: any = {
    writableLength: o.full ? 1 << 30 : 0, status: 0, destroyed: false, ended: false, cbs: [] as (() => void)[],
    writeHead(s: number) { r.status = s; return r; },
    write(s: string, cb?: () => void) { r.writableLength += Buffer.byteLength(s); if (cb) r.cbs.push(cb); return false; },
    drain() { for (const cb of r.cbs.splice(0)) cb(); r.writableLength = o.full ? 1 << 30 : 0; },
    destroy() { if (!r.destroyed) { r.destroyed = true; setImmediate(() => req.emit("close")); } },
    end() { r.ended = true; setImmediate(() => req.emit("close")); },
  };
  return r;
}
const connectMock = (es: EditServer, tab: string, o: { full?: boolean } = {}) => {
  const req: any = new EventEmitter();
  req.method = "GET";
  const res = mockStream(req, o);
  es.handle(req, res, new URL(`http://x/events?key=k&tab=${tab}`));
  return { req, res };
};
const tick = () => new Promise((r) => setImmediate(r));

test("SLOW-DROP-1 / CORR-153-6: a stream dropped as slow releases its tab like a close; churn leaves nothing live", async () => {
  const t = await setup(B([{ id: "n", x: 0 }]));
  try {
    const es = new EditServer(t.hub, t.L, {}, t.clock.now);
    const tabs = (t.hub as any).tabs as Map<string, unknown>, buckets = () => ((es.gate as any).tabs as Map<string, unknown>).size;
    const base = t.hub.ledger.used;
    for (let i = 0; i < 50; i++) {
      const tab = `tab-churn-${String(i).padStart(10, "0")}`;
      const { res } = connectMock(es, tab, { full: true });
      // (its first event already past PENDING_MAX: dropped)
      assert.ok(res.destroyed);
      await tick();
      assert.equal(tabs.has(tab), false, `${tab}: released`);
    }
    assert.equal(es.tabs, 0);
    assert.equal(tabs.size, 0);
    assert.equal(buckets(), 0);
    assert.equal(t.hub.ledger.used, base);
    // (a newer stream of the same tab is left alone by the old one's late close)
    const a = connectMock(es, TAB);
    a.res.writableLength = 1 << 30;
    es.beat();
    assert.ok(a.res.destroyed);
    const b = connectMock(es, TAB);
    assert.equal(b.res.status, 200);
    await tick(); // (a's close arrives now)
    assert.equal(es.tabs, 1);
    es.close();
    await tick();
    assert.equal(es.tabs, 0);
  } finally { t.cleanup(); }
  // (a tab gone while its submission is in flight: its bucket forgotten when that is released)
  const g = new Gate(defaultLimits(), () => 0);
  const a = g.edit(TAB, 10);
  assert.ok(a.ok);
  g.forget(TAB);
  a.ticket.release();
  assert.equal(((g as any).tabs as Map<string, unknown>).size, 0);
});

test("CORR-153-7: a snapshot nested too deeply is refused, nothing changed; the hub takes the next edit", async () => {
  const t = await setup(B([{ id: "n", x: 0 }]));
  try {
    t.hub.connect(TAB);
    const [doc, item] = editRecords(B([{ id: "n", x: 0 }]));
    const body = JSON.stringify(doc).slice(0, -1) + ',"deep":' + "[".repeat(20000) + "0" + "]".repeat(20000) + "}\n" + JSON.stringify(item);
    const H = t.hub.H, used = t.hub.ledger.used;
    let r: any, thrown: unknown = null;
    try { r = t.hub.submit(TAB, 1, t.hub.H.seq, body, sha(body)); } catch (e) { thrown = e; }
    assert.equal(thrown, null, "no exception out of submit");
    assert.ok("refused" in r, JSON.stringify(r));
    assert.equal(t.hub.H, H);
    assert.equal(t.hub.ledger.used, used);
    assert.deepEqual(t.hub.tabView(TAB), { includes: 0, persistedGen: 0, writtenGen: 0 });
    assert.ok("accepted" in submit(t.hub, TAB, 1, B([{ id: "n", x: 1 }])));
    // (the same at FILE: held as invalid, never an exception out of the watcher)
    const deep = text(B([{ id: "n", x: 0 }])).replace('"x": 0', '"x": 0, "deep": ' + "[".repeat(20000) + "0" + "]".repeat(20000));
    let thrown2: unknown = null;
    try { await t.hub.observe(Buffer.from(deep)); } catch (e) { thrown2 = e; }
    assert.equal(thrown2, null);
    assert.equal(t.hub.state.state, "held");
  } finally { t.cleanup(); }
});

test("CORR-153-7: over HTTP to a server in its own process: refused, the server alive, the next edit accepted", async () => {
  const dir = fs.mkdtempSync(join(tmpdir(), "sb-edit-153-child-"));
  const file = join(dir, "b.board.json");
  fs.writeFileSync(file, text(B([{ id: "n", x: 0 }])));
  const entry = join(__dirname, "board-edit-child-server" + (__filename.endsWith(".ts") ? ".ts" : ".js"));
  const child = spawn(process.execPath, [entry, file], { stdio: ["ignore", "pipe", "pipe"] });
  let err = "";
  child.stderr.on("data", (c) => (err += c));
  try {
    const port = await new Promise<number>((ok, fail) => {
      let out = "";
      child.stdout.on("data", (c) => { out += c; const m = /port (\d+)/.exec(out); if (m) ok(Number(m[1])); });
      child.on("exit", (code) => fail(new Error(`the server exited (${code}): ${err}`)));
    });
    const ev = events(port, TAB);
    await ev.until(() => ev.got.length >= 1);
    const seq = ev.got[0].data.seq;
    const [doc, item] = editRecords(B([{ id: "n", x: 0 }]));
    const body = JSON.stringify(doc).slice(0, -1) + ',"deep":' + "[".repeat(20000) + "0" + "]".repeat(20000) + "}\n" + JSON.stringify(item);
    const r = await request(port, "POST", editPath(TAB, 1, seq, sha(body)), body);
    assert.equal(r.status, 200);
    assert.ok(JSON.parse(r.text).refused, r.text);
    await new Promise((ok) => setTimeout(ok, 50));
    assert.equal(child.exitCode, null, `the server is alive: ${err}`);
    const ok = JSON.parse((await post(port, TAB, 1, seq, B([{ id: "n", x: 1 }]))).text);
    assert.ok(ok.accepted, JSON.stringify(ok));
    ev.close();
  } finally { child.kill(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("CORR-153-8: an ordinary outside change is reported field by field, its restore the board's value; records too", async () => {
  const t = await setup(B([{ id: "n", x: 0 }, { id: "m", x: 0 }]));
  try {
    t.hub.events.length = 0;
    // (x changed, a field added, a record removed, one added: no tab's edit to conflict with)
    await t.hub.observe(Buffer.from(text(B([{ id: "n", x: 9, y: "new" }, { id: "k", x: 1 }]))));
    const rs = reportsOf(t.hub).filter((r) => r.kind === "outside") as any[], alts = altsOf(t.hub) as any[];
    const nKey = rs.find((r) => r.field === "x")?.key;
    assert.ok(rs.some((r) => r.field === "x" && r.was === 0 && r.now === 9));
    assert.ok(alts.some((a) => a.key === nKey && a.field === "x" && a.value === 0));
    assert.ok(rs.some((r) => r.field === "y" && r.was === ABSENT && r.now === "new"));
    assert.ok(alts.some((a) => a.key === nKey && a.field === "y" && a.value === ABSENT));
    const removed = rs.find((r) => r.field === undefined && r.now === ABSENT);
    assert.ok(removed && removed.was.id === "m");
    assert.ok(alts.some((a) => a.key === removed.key && a.record?.id === "m"));
    const added = rs.find((r) => r.field === undefined && r.was === ABSENT);
    assert.ok(added && added.now.id === "k");
    assert.ok(alts.some((a) => a.key === added.key && a.record === null));
  } finally { t.cleanup(); }
  // (a deliberate reversion of a record from an older copy: removed, and an older save didn't have it, flagged)
  const u = await setup(B([{ id: "n", x: 0 }]));
  try {
    u.hub.connect(TAB);
    submit(u.hub, TAB, 1, B([{ id: "n", x: 0 }, { id: "m", x: 0 }]));
    u.clock.advance(u.L.SAVE_MAX_DELAY_MS);
    assert.ok((await u.hub.save()).saved);
    u.hub.events.length = 0;
    await u.hub.observe(Buffer.from(text(B([{ id: "n", x: 0 }]))));
    const flags = reportsOf(u.hub).filter((r) => r.kind === "older-copy") as any[];
    assert.ok(flags.some((f) => f.field === undefined && f.value === ABSENT && f.board?.id === "m"), JSON.stringify(flags));
    assert.ok(reportsOf(u.hub).some((r: any) => r.kind === "outside" && r.now === ABSENT));
  } finally { u.cleanup(); }
});

test("SSE-LEDGER-2: MAX_CLIENTS x PENDING_MAX at most MEMORY_MAX / 4, exactly", () => {
  assert.ok("limits" in resolveLimits(["MEMORY_MAX=67108864", "MAX_CLIENTS=256", "PENDING_MAX=65536", "EDIT_MAX=8388608", "BODY_MAX=1048576", "QUEUE_BYTES=33554432"], {}));
  const r = resolveLimits(["MEMORY_MAX=67108864", "MAX_CLIENTS=256", "PENDING_MAX=65537", "EDIT_MAX=8388608", "BODY_MAX=1048576", "QUEUE_BYTES=33554432"], {});
  assert.ok("error" in r && /MAX_CLIENTS x PENDING_MAX/.test(r.error), JSON.stringify(r));
  // (both extremes still reachable, each with the other's default)
  assert.ok("limits" in resolveLimits(["MAX_CLIENTS=256"], {}));
  assert.ok("limits" in resolveLimits(["PENDING_MAX=16777216"], {}));
});

test("SSE-LEDGER-2: 256 slow streams under the smallest memory cap: every backlog byte on the ledger, never past it", async () => {
  const limits = { MEMORY_MAX: 64 * MiB, MAX_CLIENTS: 256, PENDING_MAX: 64 * KiB, EDIT_MAX: 8 * MiB, BODY_MAX: MiB, QUEUE_BYTES: 32 * MiB };
  const t = await setup(B([{ id: "n", x: 0 }]), limits);
  try {
    const es = new EditServer(t.hub, t.L, {}, t.clock.now);
    const base = t.hub.ledger.used;
    const ss = Array.from({ length: 256 }, (_, i) => connectMock(es, `tab-slow-${String(i).padStart(10, "0")}`));
    assert.equal(es.tabs, 256);
    const backlog = () => (es as any).backlog as number;
    let peak = 0;
    // (heads with reports, to every stream, none of which reads)
    for (let g = 1; g <= 400 && es.tabs > 0; g++) {
      t.hub.events.push({ seq: t.hub.H.seq, persistedSeq: 0, reports: [{ kind: "prev-kept", path: "p".repeat(200), why: "w" }], alternatives: [], source: "outside" });
      es.flush();
      const pending = ss.reduce((s, x) => s + (x.res.destroyed ? 0 : x.res.writableLength), 0);
      assert.equal(backlog(), pending, "every byte pending is charged");
      assert.equal(t.hub.ledger.used, base + pending);
      assert.ok(backlog() <= 256 * 64 * KiB);
      assert.ok(t.hub.ledger.used <= t.hub.ledger.max);
      peak = Math.max(peak, backlog());
    }
    assert.ok(peak > 0);
    // (the streams that drain give their charges back; the dropped ones already have)
    for (const x of ss) if (!x.res.destroyed) x.res.drain();
    assert.equal(t.hub.ledger.used, base);
    // (the ledger full: a send isn't admitted, so the stream is dropped, nothing past the cap)
    const s = connectMock(es, "tab-full-0000000000");
    const first = backlog();
    t.hub.ledger.used = t.hub.ledger.max;
    t.hub.events.push({ seq: t.hub.H.seq, persistedSeq: 0, reports: [], alternatives: [], source: "save" });
    es.flush();
    assert.ok(s.res.destroyed);
    // (and its first event's charge given back)
    assert.equal(t.hub.ledger.used, t.hub.ledger.max - first);
    es.close();
  } finally { t.cleanup(); }
});
