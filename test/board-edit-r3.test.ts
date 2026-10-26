import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as http from "http";
import { join } from "path";
import { tmpdir } from "os";
import { createHash } from "crypto";
import { spawn } from "child_process";
import type { AddressInfo } from "net";
import { EditHub } from "../src/board-edit-hub";
import { EditServer, startEdit } from "../src/board-edit-serve";
import { defaultLimits } from "../src/board-edit-limits";
import * as W from "../src/board-edit-write";
import { editRecords } from "../web/board/lossless";

// #153's second review (r2, e9b0951b): its must-fixes, one test each, every one failing on e9b0951b:
// - CORR-153-R2-2 (all three reviewers): a tombstoned tab's POST never makes a live record or a rate bucket
//   without an event stream of its own, through HTTP, churned past TAB_TOMBSTONES, with aborted requests, and a
//   later reconnection that works;
// - CORR-153-R2-1 (astra): GET /changes is routed by the production server, src/board-open.ts;
// - daybreak2's CORR-153-R2-2: a tab that connects after batches were dropped is told so in its first event;
// - CORR-153-1 on Windows (astra): a save whose directory can't be synced is written, never Saved.
const { mergeStrings3 } = require("patchflow");
const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
const B = (nodes: any[]) => ({ format: "sagebrush-board", version: 1, title: "t", nodes, edges: [] });
const text = (d: any) => JSON.stringify(d, null, 2) + "\n";
const snap = (d: any) => editRecords(d).map((r) => JSON.stringify(r)).join("\n");
const tabId = (i: number) => `tab-${String(i).padStart(16, "0")}`;

async function serve(d: any, limits: Record<string, number> = {}) {
  const dir = fs.mkdtempSync(join(tmpdir(), "sb-edit-r3-"));
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
function request(port: number, method: string, path: string, body?: string, headers: Record<string, string> = {}): Promise<{ status: number; text: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((ok, fail) => {
    const h: Record<string, string> = { ...(method === "POST" ? { "Content-Type": "application/x-ndjson", "Content-Length": String(Buffer.byteLength(body ?? "")) } : {}), ...headers };
    const req = http.request({ host: "127.0.0.1", port, method, path, headers: h, agent: false }, (res) => {
      let t = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (t += c));
      res.on("end", () => ok({ status: res.statusCode!, text: t, headers: res.headers }));
    });
    req.on("error", fail);
    if (body !== undefined) req.write(body);
    req.end();
  });
}
/** A POST whose headers are sent and whose body never is, then cut off. */
function aborted(port: number, path: string): Promise<void> {
  return new Promise((ok) => {
    const req = http.request({ host: "127.0.0.1", port, method: "POST", path, headers: { "Content-Type": "application/x-ndjson", "Content-Length": "1000" }, agent: false });
    req.on("error", () => ok());
    req.on("response", (res) => { res.resume(); res.on("end", ok); });
    req.flushHeaders();
    setTimeout(() => { req.destroy(); ok(); }, 50);
  });
}
function events(port: number, path: string) {
  const got: { event: string; data: any }[] = [];
  let buf = "";
  const req = http.get({ host: "127.0.0.1", port, path, agent: false }, (res) => {
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
  const until = async (f: () => boolean) => { for (let i = 0; i < 300 && !f(); i++) await new Promise((r) => setTimeout(r, 10)); assert.ok(f(), JSON.stringify(got).slice(0, 1500)); };
  return { got, until, close: () => req.destroy() };
}
const editPath = (tab: string, gen: number, base: number, hash: string) => `/edit?key=k&tab=${tab}&gen=${gen}&base=${base}&hash=${hash}`;
const post = (port: number, tab: string, gen: number, base: number, d: any) => { const s = snap(d); return request(port, "POST", editPath(tab, gen, base, sha(s)), s); };
const settle = async (f: () => boolean) => { for (let i = 0; i < 300 && !f(); i++) await new Promise((r) => setTimeout(r, 10)); return f(); };

test("CORR-153-R2-2: a tombstoned tab's POSTs make no live record nor rate bucket; past TAB_TOMBSTONES; it reconnects", async () => {
  const t = await serve(B([{ id: "n", x: 0 }]), { MAX_CLIENTS: 1, TAB_TOMBSTONES: 16 });
  const tabs = (t.hub as any).tabs as Map<string, unknown>, tombstones = (t.hub as any).tombstones as Map<string, number>;
  const buckets = () => ((t.es.gate as any).tabs as Map<string, unknown>).size;
  try {
    for (let i = 0; i < 40; i++) {
      const tab = tabId(i);
      // (a stream, an accepted edit: watermark 1; the stream closed: a tombstone)
      const ev = events(t.port, `/events?key=k&tab=${tab}`);
      await ev.until(() => ev.got.length >= 1);
      const r = JSON.parse((await post(t.port, tab, 1, t.hub.H.seq, B([{ id: "n", x: i + 1 }]))).text);
      assert.ok(r.accepted, JSON.stringify(r));
      ev.close();
      assert.ok(await settle(() => !tabs.has(tab)), `${tab} released`);
      // (then, with no stream: a POST at the watermark, one above it, and one cut off)
      const at = JSON.parse((await post(t.port, tab, 1, t.hub.H.seq, B([{ id: "n", x: i + 1 }]))).text);
      const above = JSON.parse((await post(t.port, tab, 2, t.hub.H.seq, B([{ id: "n", x: 1000 + i }]))).text);
      await aborted(t.port, editPath(tab, 3, t.hub.H.seq, "0".repeat(64)));
      assert.ok("included" in at && "included" in above, JSON.stringify([at, above]));
      // (never live without its stream, nor a bucket; the tombstones within their cap)
      assert.equal(tabs.size, t.es.tabs, `round ${i}: live records ${tabs.size}, streams ${t.es.tabs}`);
      assert.ok(buckets() <= t.es.tabs, `round ${i}: buckets ${buckets()}`);
      assert.ok(tombstones.size <= 16);
    }
    assert.equal(tabs.size, 0);
    assert.equal(buckets(), 0);
    assert.equal(JSON.parse(t.hub.H.json ? JSON.stringify(t.hub.H.json) : "{}").nodes[0].x, 40, "no POST without a stream applied");
    // (a tab whose tombstone is still kept reconnects: live again, its watermark kept; its next gen accepted)
    const back = tabId(39);
    const ev = events(t.port, `/events?key=k&tab=${back}`);
    await ev.until(() => ev.got.length >= 1);
    assert.ok(tabs.has(back));
    const r = JSON.parse((await post(t.port, back, 2, t.hub.H.seq, B([{ id: "n", x: 99 }]))).text);
    assert.ok(r.accepted, JSON.stringify(r));
    ev.close();
  } finally { await t.close(); }
});

test("daybreak2's CORR-153-R2-2: a tab that connects after older batches were dropped is told, and /changes says so", async () => {
  const t = await serve(B([{ id: "n", x: 0 }]), { CONFLICTS_MAX: 10 });
  try {
    // (12 small outside changes, a batch each (a report and an alternative): the oldest two dropped, the rest
    // small enough to send inline)
    for (let i = 1; i <= 12; i++) await t.hub.observe(Buffer.from(text(B([{ id: "n", x: i }]))));
    t.es.flush();
    assert.ok(t.hub.changes.length === 10, String(t.hub.changes.length));
    const ev = events(t.port, `/events?key=k&tab=${tabId(1)}`);
    await ev.until(() => ev.got.length >= 1);
    const first = ev.got[0].data;
    assert.equal(first.changes.length, 10, "the kept batches, inline");
    assert.equal(first.more, true, "and told some were dropped before it connected");
    const ch = JSON.parse((await request(t.port, "GET", `/changes?key=k&tab=${tabId(1)}&after=0`)).text);
    assert.equal(ch.complete, false);
    ev.close();
    // (a control: nothing dropped, nothing said)
    const u = await serve(B([{ id: "n", x: 0 }]), { CONFLICTS_MAX: 10 });
    try {
      await u.hub.observe(Buffer.from(text(B([{ id: "n", x: 1 }]))));
      u.es.flush();
      const e2 = events(u.port, `/events?key=k&tab=${tabId(2)}`);
      await e2.until(() => e2.got.length >= 1);
      assert.equal(e2.got[0].data.more, false);
      e2.close();
    } finally { await u.close(); }
  } finally { await t.close(); }
});

test("CORR-153-R2-1: GET /changes is routed by board open's production server, by its key", async () => {
  const dir = fs.mkdtempSync(join(tmpdir(), "sb-edit-r3-open-"));
  const file = join(dir, "b.board.json");
  fs.writeFileSync(file, text(B([{ id: "n", x: 0 }])));
  const entry = join(__dirname, "board-open-edit-child" + (__filename.endsWith(".ts") ? ".ts" : ".js"));
  const port0 = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [entry, file, String(port0)], { stdio: ["ignore", "pipe", "pipe"] });
  let err = "";
  child.stderr.on("data", (c) => (err += c));
  try {
    const url = await new Promise<URL>((ok, fail) => {
      let out = "";
      child.stdout.on("data", (c) => { out += c; const m = /(http:\/\/127\.0\.0\.1:\d+\/\?token=[0-9a-f]+)/.exec(out); if (m) ok(new URL(m[1])); });
      child.on("exit", (code) => fail(new Error(`board open exited (${code}): ${err}`)));
    });
    const port = Number(url.port), host = { Host: `127.0.0.1:${port}` };
    // (the page, as a browser gets it: the token, its cookie, then the page with the key in it)
    const r1 = await request(port, "GET", url.pathname + url.search, undefined, host);
    assert.equal(r1.status, 302);
    const cookie = String(r1.headers["set-cookie"]?.[0] ?? "").split(";")[0];
    const pageRes = await request(port, "GET", "/", undefined, { ...host, Cookie: cookie });
    assert.equal(pageRes.status, 200, pageRes.text.slice(0, 200));
    const key = JSON.parse(/id="sb-local">(.*?)<\/script>/.exec(pageRes.text)![1]).key as string;
    const tab = tabId(7);
    const ev = events(port, `/events?key=${key}&tab=${tab}`);
    await ev.until(() => ev.got.length >= 1);
    // (/changes: answered by the edit server, not the 404 every unrouted path gets)
    const ch = await request(port, "GET", `/changes?key=${key}&tab=${tab}&after=0`, undefined, host);
    assert.equal(ch.status, 200, ch.text);
    assert.ok(Array.isArray(JSON.parse(ch.text).changes));
    // (and guarded as the rest: no key, another origin, no tab)
    assert.equal((await request(port, "GET", `/changes?key=wrong&tab=${tab}&after=0`, undefined, host)).status, 403);
    assert.equal((await request(port, "GET", `/changes?key=${key}&tab=${tab}&after=0`, undefined, { ...host, Origin: "https://evil.example" })).status, 403);
    assert.equal((await request(port, "GET", `/changes?key=${key}&after=0`, undefined, host)).status, 400);
    ev.close();
  } finally {
    child.kill("SIGINT");
    await new Promise((r) => { if (child.exitCode !== null) r(null); else child.on("exit", r); setTimeout(r, 5000); });
    if (child.exitCode === null) child.kill("SIGKILL");
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("CORR-153-1 on Windows: a save whose directory can't be synced is written, never Saved, and not retried", async () => {
  // (the real adapter, as on win32, over a filesystem where a directory can't be fsynced, as Node's on Windows)
  const dirFds = new Set<number>();
  const n = {
    ...fs,
    openSync: (p: fs.PathLike, ...rest: any[]) => { const fd = (fs.openSync as any)(p, ...rest); if (fs.statSync(p).isDirectory()) dirFds.add(fd); return fd; },
    fsyncSync: (fd: number) => { if (dirFds.has(fd)) throw Object.assign(new Error("EPERM: operation not permitted, fsync"), { code: "EPERM" }); return fs.fsyncSync(fd); },
    closeSync: (fd: number) => { dirFds.delete(fd); return fs.closeSync(fd); },
  } as typeof fs;
  const win = W.makeRealFs(n, "win32");
  const dir = fs.mkdtempSync(join(tmpdir(), "sb-edit-r3-win-"));
  try {
    assert.equal(win.fsyncDir(dir), false, "can't be done: false, not an error");
    assert.equal(W.makeRealFs(fs, "win32").fsyncDir(dir), true, "where it can be done (a POSIX directory here): true");
    assert.throws(() => W.makeRealFs(n, "linux").fsyncDir(dir), /EPERM/, "elsewhere every error is the caller's");
    const file = join(dir, "b.board.json");
    fs.writeFileSync(file, text(B([{ id: "n", x: 0 }])));
    let now = 1_000_000;
    const hub = new EditHub(file, defaultLimits(), { mergeStrings3, now: () => now, fs: win });
    assert.ok((await hub.start(fs.readFileSync(file))).ok);
    hub.connect("tab-aaaaaaaaaaaaaaaa");
    const s = snap(B([{ id: "n", x: 1 }]));
    assert.ok("accepted" in hub.submit("tab-aaaaaaaaaaaaaaaa", 1, hub.H.seq, s, sha(s)));
    now += hub.limits.SAVE_MAX_DELAY_MS;
    const r = await hub.save();
    assert.ok(r.saved && (r as any).durable === false, JSON.stringify(r));
    // (the file holds it, written; Saved not shown; nothing left to retry)
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).nodes[0].x, 1);
    assert.deepEqual(hub.tabView("tab-aaaaaaaaaaaaaaaa"), { includes: 1, persistedGen: 0, writtenGen: 1 });
    assert.ok(hub.writtenSeq === hub.H.seq && hub.persistedSeq < hub.H.seq);
    now += hub.limits.SAVE_MAX_DELAY_MS;
    assert.equal(hub.due(), false, "not retried: it can't be done here");
    assert.ok(hub.events.some((e) => e.source === "save" && e.writtenSeq === hub.H.seq && e.persistedSeq < hub.H.seq));
    // (FILE adopted as the board, the same: written, not Saved)
    const s2 = snap(B([{ id: "n", x: 2 }]));
    hub.submit("tab-aaaaaaaaaaaaaaaa", 2, hub.H.seq, s2, sha(s2));
    fs.writeFileSync(file, text(B([{ id: "n", x: 2 }])));
    await hub.observe(fs.readFileSync(file));
    assert.deepEqual(hub.tabView("tab-aaaaaaaaaaaaaaaa"), { includes: 2, persistedGen: 0, writtenGen: 2 });
    assert.equal(hub.due(now + hub.limits.SAVE_MAX_DELAY_MS), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
