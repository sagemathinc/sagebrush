import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as http from "http";
import { join } from "path";
import { tmpdir } from "os";
import { createHash } from "crypto";
import type { AddressInfo } from "net";
import { EditHub } from "../src/board-edit-hub";
import { EditServer, EditWatch, startEdit } from "../src/board-edit-serve";
import { defaultLimits } from "../src/board-edit-limits";
import { editRecords } from "../web/board/lossless";

// `board open --edit`'s requests over real HTTP (src/board-edit-serve.ts; plan-board-open-edit r7 §6, §8.4,
// addendum 2): a submission answered from its URL, or admitted, before its body is read (CORR-BOARD-A1-1:
// a second one from the same tab and a rate-refused one, their bodies never sent); bodies counted and cut
// off; a tab's events; a save reaching persistedGen; the ledger back where it was.
const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
const B = (nodes: any[]) => ({ format: "sagebrush-board", version: 1, title: "t", nodes, edges: [] });
const snap = (d: any) => editRecords(d).map((r) => JSON.stringify(r)).join("\n");
const TAB = "tab-aaaaaaaaaaaaaaaa", TAB2 = "tab-bbbbbbbbbbbbbbbb";

async function setup(limits: Record<string, number> = {}) {
  const dir = fs.mkdtempSync(join(tmpdir(), "sb-edit-serve-"));
  const file = join(dir, "b.board.json");
  fs.writeFileSync(file, JSON.stringify(B([{ id: "n", text: "hello" }]), null, 2) + "\n");
  let now = 1_000_000;
  const clock = { now: () => now, advance: (ms: number) => { now += ms; } };
  const L = { ...defaultLimits(), ...limits };
  const started = await startEdit(file, L, { now: clock.now });
  assert.ok("hub" in started, "why" in started ? started.why : "");
  const hub = (started as { hub: EditHub }).hub;
  const es = new EditServer(hub, L, { "Access-Control-Allow-Origin": "*" }, clock.now);
  const watch = new EditWatch(hub, es, file, L.FILE_MAX, 0, (p) => { try { const s = fs.statSync(p); return `${s.size}:${s.mtimeMs}:${s.ino}`; } catch { return null; } });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (!es.handle(req, res, url)) res.writeHead(404).end();
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const port = (server.address() as AddressInfo).port;
  const close = async () => { es.close(); server.closeAllConnections(); await new Promise((ok) => server.close(ok)); fs.rmSync(dir, { recursive: true, force: true }); };
  return { dir, file, hub, es, watch, clock, port, close };
}

/** A request; the body written only if `body` is given (`hold`: headers sent, the body never). */
function request(port: number, method: string, path: string, o: { body?: string; type?: string; length?: number; hold?: boolean; chunked?: boolean } = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; text: string }> {
  return new Promise((ok, fail) => {
    const headers: Record<string, string> = {};
    if (o.type ?? (method === "POST" ? "application/x-ndjson" : undefined)) headers["Content-Type"] = o.type ?? "application/x-ndjson";
    if (o.length !== undefined) headers["Content-Length"] = String(o.length);
    else if (o.body !== undefined && !o.chunked) headers["Content-Length"] = String(Buffer.byteLength(o.body));
    const req = http.request({ host: "127.0.0.1", port, method, path, headers, agent: false }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (text += c));
      res.on("end", () => ok({ status: res.statusCode!, headers: res.headers, text }));
    });
    req.on("error", (e: any) => (e.code === "EPIPE" || e.code === "ECONNRESET" ? undefined : fail(e)));
    if (o.hold) { req.flushHeaders(); return; }
    if (o.body !== undefined) req.write(o.body);
    req.end();
  });
}

/** An event stream: the events as they come. */
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
  const until = async (f: () => boolean) => { for (let i = 0; i < 200 && !f(); i++) await new Promise((r) => setTimeout(r, 10)); assert.ok(f(), JSON.stringify(got)); };
  return { got, until, close: () => req.destroy() };
}

const editPath = (tab: string, gen: number, base: number, hash: string) => `/edit?key=k&tab=${tab}&gen=${gen}&base=${base}&hash=${hash}`;

test("board open --edit serve: a tab registers, submits, and is told what its head includes, then what is saved", async () => {
  const t = await setup();
  try {
    const ev = events(t.port, TAB);
    await ev.until(() => ev.got.length >= 1);
    assert.deepEqual(ev.got[0].data.includes, 0);
    const s = snap(B([{ id: "n", text: "hello world" }]));
    const r = await request(t.port, "POST", editPath(TAB, 1, t.hub.H.seq, sha(s)), { body: s });
    assert.equal(r.status, 200, r.text);
    assert.ok(JSON.parse(r.text).accepted);
    await ev.until(() => ev.got.some((e) => e.data.includes === 1));
    // (the head fetched by its seq; then a save, and persistedGen told)
    const h = await request(t.port, "GET", `/board?key=k&tab=${TAB}&at=${JSON.parse(r.text).seq}`);
    assert.equal(h.status, 200);
    assert.equal(JSON.parse(h.text).nodes[0].text, "hello world");
    t.clock.advance(t.hub.limits.SAVE_MAX_DELAY_MS);
    await t.watch.tick(t.clock.now());
    await ev.until(() => ev.got.some((e) => e.data.persistedGen === 1));
    assert.equal(JSON.parse(fs.readFileSync(t.file, "utf8")).nodes[0].text, "hello world");
    ev.close();
  } finally { await t.close(); }
});

test("board open --edit serve: CORR-BOARD-A1-1, a second submission from one tab, and a rate-refused one, answered with their bodies never read", async () => {
  const t = await setup({ TAB_RATE: 1 });
  try {
    const ev = events(t.port, TAB);
    await ev.until(() => ev.got.length >= 1);
    const s = snap(B([{ id: "n", text: "one" }]));
    // (the first: headers sent, its body held back, so it stays in flight)
    const first = request(t.port, "POST", editPath(TAB, 1, t.hub.H.seq, sha(s)), { length: Buffer.byteLength(s), hold: true });
    await new Promise((r) => setTimeout(r, 50));
    // (the second, from the same tab: answered busy while the first is in flight, its body never sent)
    const second = await request(t.port, "POST", editPath(TAB, 2, t.hub.H.seq, sha(s)), { length: 10_000, hold: true });
    assert.equal(second.status, 503);
    assert.equal(JSON.parse(second.text).busy, "in-flight");
    assert.ok(second.headers["retry-after"]);
    assert.equal(second.headers.connection, "close");
    void first;
    // (another tab, at its rate's limit: the first is taken, the next refused for the rate, its body never sent)
    const ev2 = events(t.port, TAB2);
    await ev2.until(() => ev2.got.length >= 1);
    const ok1 = await request(t.port, "POST", editPath(TAB2, 1, t.hub.H.seq, sha(s)), { body: s });
    assert.equal(ok1.status, 200, ok1.text);
    const rated = await request(t.port, "POST", editPath(TAB2, 2, t.hub.H.seq, sha(s)), { length: 10_000, hold: true });
    assert.equal(rated.status, 503);
    assert.equal(JSON.parse(rated.text).busy, "rate");
    assert.ok(Number(rated.headers["retry-after"]) >= 1);
    ev.close(); ev2.close();
  } finally { await t.close(); }
});

test("board open --edit serve: answered from the URL alone: an unknown tab, bad parameters, the wrong type, a body over BODY_MAX", async () => {
  const KiB = 1024;
  const t = await setup({ BODY_MAX: 64 * KiB });
  try {
    const h = "0".repeat(64);
    const unknown = await request(t.port, "POST", editPath("tab-cccccccccccccccc", 1, 1, h), { length: 10_000, hold: true });
    assert.equal(unknown.status, 200);
    assert.ok(JSON.parse(unknown.text).unknownTab);
    for (const path of [editPath("short", 1, 1, h), editPath(TAB, 0, 1, h), editPath(TAB, 1, 1, "x"), editPath(TAB, 1, 1, h) + "&tab=" + TAB, editPath(TAB, 1, 1, h) + "&extra=1"]) {
      const r = await request(t.port, "POST", path, { length: 5, hold: true });
      assert.equal(r.status, 400, path);
    }
    const ev = events(t.port, TAB);
    await ev.until(() => ev.got.length >= 1);
    const wrongType = await request(t.port, "POST", editPath(TAB, 1, t.hub.H.seq, h), { body: "{}", type: "text/plain" });
    assert.equal(wrongType.status, 415);
    const big = await request(t.port, "POST", editPath(TAB, 1, t.hub.H.seq, h), { length: 64 * KiB + 1, hold: true });
    assert.equal(big.status, 413);
    // (chunked, past BODY_MAX: cut off at its byte BODY_MAX + 1)
    const before = t.hub.ledger.used;
    const chunked = await request(t.port, "POST", editPath(TAB, 1, t.hub.H.seq, h), { body: "x".repeat(64 * KiB + 1), chunked: true });
    assert.equal(chunked.status, 413);
    assert.equal(t.hub.ledger.used, before); // (what its bytes were charged, released)
    ev.close();
  } finally { await t.close(); }
});

test("board open --edit serve: a stale base, a refusal and a replay, the ledger back where it was", async () => {
  const t = await setup();
  try {
    const ev = events(t.port, TAB);
    await ev.until(() => ev.got.length >= 1);
    const before = t.hub.ledger.used;
    const s = snap(B([{ id: "n", text: "x" }]));
    const stale = await request(t.port, "POST", editPath(TAB, 1, 999, sha(s)), { body: s });
    assert.ok(JSON.parse(stale.text).stale);
    const bad = await request(t.port, "POST", editPath(TAB, 1, t.hub.H.seq, sha("other")), { body: s });
    assert.match(JSON.parse(bad.text).refused, /hash/);
    assert.equal(t.hub.ledger.used, before);
    const ok = await request(t.port, "POST", editPath(TAB, 1, t.hub.H.seq, sha(s)), { body: s });
    const seq = JSON.parse(ok.text).seq;
    // (the same op again: answered from its URL, as before)
    const again = await request(t.port, "POST", editPath(TAB, 1, 1, sha(s)), { length: 5, hold: true });
    assert.deepEqual(JSON.parse(again.text), { op: `${TAB}:1`, accepted: true, seq });
    ev.close();
  } finally { await t.close(); }
});
