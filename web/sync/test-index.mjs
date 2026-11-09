// ci: web-sync.2 order=80
// The agents' index on the server (fs-sync step 1a2; web/sync/entries.ts and account.ts): built from the log by the
// alarm in bounded steps, kept by every op accepted after, failed (never partial) past a bound, rebuilt by the person;
// and list and stat reading it. Behind the SYNC_AGENT switch, DEV only. In Miniflare with real Durable Objects.
//
//   node web/sync/test-index.mjs
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { dispatch } from "../miniflare-dispatch.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const units = execFileSync("bun", ["build", join(here, "test-entries-units.ts"), "--format", "esm", "--target", "node"], { encoding: "utf8" });
const U = await import("data:text/javascript;base64," + Buffer.from(units).toString("base64"));
const require = createRequire(join(here, "../site/package.json"));
const { Miniflare, convertV4MiniflareOptions } = require("miniflare");

let failures = 0, count = 0;
function ok(cond, what) {
  count++;
  if (!cond) {
    failures++;
    console.log("FAIL", what);
  }
}
async function section(name, fn, ms = 90_000) {
  let timer;
  try {
    await Promise.race([fn(), new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(`didn't finish within ${ms / 1000} s`)), ms)))]);
  } catch (e) {
    ok(false, `${name}: ${e?.stack ?? e}`);
  } finally {
    clearTimeout(timer);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const KEY = "test-grant-key";
const SITE = "https://sagebrush.test";
const BF = "b1b1b1b1-0001-4b1b-8b1b-b1b1b1b1b101"; // backfill and live
const BU = "b1b1b1b1-0002-4b1b-8b1b-b1b1b1b1b102"; // the budget: an op that can't fit fails the index; rebuild
const CP = "b1b1b1b1-0003-4b1b-8b1b-b1b1b1b1b103"; // the bounds: entries, tombstones, a folder
const CA = "b1b1b1b1-0004-4b1b-8b1b-b1b1b1b1b104"; // appends while building; a restart while building
const RD = "b1b1b1b1-0005-4b1b-8b1b-b1b1b1b1b105"; // reads: scope, Trash, pages, cursors
const LV = "b1b1b1b1-0006-4b1b-8b1b-b1b1b1b1b106"; // a live op past a bound: accepted, the index failed
const MS = "b1b1b1b1-0007-4b1b-8b1b-b1b1b1b1b107"; // one step at a time (manual)
const LB = "b1b1b1b1-0008-4b1b-8b1b-b1b1b1b1b108"; // ready but behind the log; the counts kept across ops
const RX = "b1b1b1b1-0009-4b1b-8b1b-b1b1b1b1b109"; // reads: a folder's own range, a file, NFD, the page bound
const EM = "b1b1b1b1-000a-4b1b-8b1b-b1b1b1b1b10a"; // an empty log: ready at once
const NE = "b1b1b1b1-000b-4b1b-8b1b-b1b1b1b1b10b"; // sync never turned on: no rebuild
const JR = "b1b1b1b1-000c-4b1b-8b1b-b1b1b1b1b10c"; // a job restarted in each phase
const JB = "b1b1b1b1-000d-4b1b-8b1b-b1b1b1b1b10d"; // a job's bounds and its counts
const listed = [BF, BU, CP, CA, RD, LV, MS, LB, RX, EM, NE, JR, JB].join(",");
const script = execFileSync("bun", ["build", join(here, "test-entry.ts"), "--format", "esm", "--target", "browser", "--external", "cloudflare:workers"], { encoding: "utf8" });
const base = { modules: true, script, compatibilityDate: "2026-10-01", d1Databases: ["SHARE_DB"], r2Buckets: ["SHARE_BUCKET"] };
const shareBindings = { SESSION_KEY: "session-key", SHARE_DEV: "1", DEV_AUTH_TOKEN: "dev-token", COCALC_ORIGIN: "https://cocalc.test", COCALC_CLIENT_SECRET: "client-secret" };
const plan = { storage_bytes: 1 << 30, max_file_bytes: 1 << 20, sync: { enabled: true, version_bytes: 1 << 20, read_bytes_per_day: 1 << 30 } };
const objects = { SYNC_ACCOUNT: { className: "SyncAccount", useSQLite: true }, SYNC_DOC: { className: "SyncDoc", useSQLite: true } };
const mf = new Miniflare(convertV4MiniflareOptions({
  workers: [{ ...base, name: "on", bindings: { ...shareBindings, SYNC_ACCOUNTS: listed, SYNC_AGENT: "1", GRANT_TAG_KEY: KEY, SYNC_TEST_PIN_MS: "1000" }, durableObjects: objects, routes: ["sagebrush.test/*"], outboundService: async () => Response.json(plan), ratelimits: { SYNC_PREAUTH: { namespace_id: "4001", simple: { limit: 1_000_000, period: 60 } }, SYNC_AGENT_FAIL: { namespace_id: "4002", simple: { limit: 1_000_000, period: 60 } } } }],
}));
{
  const db = await mf.getD1Database("SHARE_DB", "on");
  const mig = join(here, "../share/migrations");
  for (const m of readdirSync(mig).filter((f) => f.endsWith(".sql")).sort())
    for (const s of readFileSync(join(mig, m), "utf8").replace(/--.*$/gm, "").split(";").map((s) => s.trim()).filter(Boolean)) await db.prepare(s).run();
}
const at = (path, init = {}) => dispatch(mf, SITE + path, { redirect: "manual", ...init });
const post = (s, path, body) => at(path, { method: "POST", headers: { cookie: s, origin: SITE, "content-type": "application/json" }, body: JSON.stringify(body) });
async function enabled(id) {
  const r = await at("/auth/dev", { method: "POST", headers: { origin: SITE, "content-type": "application/json" }, body: JSON.stringify({ token: "dev-token", account_id: id }) });
  const s = r.headers.getSetCookie().map((c) => c.split(";")[0]).find((c) => c.startsWith("__Host-sb_session="));
  ok((await post(s, "/api/sync/v1/enable", {})).status === 200, `(${id.slice(-2)}: sync on)`);
  return s;
}
const grant = async (s, scopes) => (await (await post(s, "/api/sync/v1/grants", { agent: "fs-sync", scopes })).json()).token;
const agent = async (t, verb, params) => {
  const r = await at("/api/agent/v1/" + verb, { method: "POST", headers: { authorization: "Bearer " + t, "content-type": "application/json" }, body: JSON.stringify(params) });
  return { status: r.status, ...(await r.json().catch(() => ({}))) };
};
const ix = async (id, v = {}) => (await at("/__test/index?account=" + id, { method: "POST", body: JSON.stringify(v) })).json();
async function until(id, state, ms = 20_000) {
  const end = Date.now() + ms;
  let s;
  while (Date.now() < end) {
    s = await ix(id);
    if (s.state === state) return s;
    await sleep(50);
  }
  return s;
}
const restart = async (id) => {
  const ns = await mf.getDurableObjectNamespace("SYNC_ACCOUNT", "on");
  await ns.get(ns.idFromName("acct:" + createHash("sha256").update("sagebrush-account\n" + id).digest("hex"))).crash().catch(() => {});
  // (back when it answers as itself again: a whole index state, not the stopped object's error)
  for (let i = 0; i < 100; i++) {
    const r = await at("/__test/index?account=" + id, { method: "POST", body: "{}" }).catch(() => null);
    const v = r?.status === 200 ? await r.json().catch(() => null) : null;
    if (v && "state" in v) return;
    await sleep(50);
  }
};

/** The account socket: ops sent as one device, each answered by its seq or its refusal. */
async function socket(s, device) {
  const r = await at("/api/sync/v1/account", { headers: { cookie: s, origin: SITE, upgrade: "websocket" } });
  const ws = r.webSocket;
  ws.accept();
  const queue = [], waiting = [];
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    const w = waiting.findIndex((x) => x.match(m));
    if (w >= 0) waiting.splice(w, 1)[0].resolve(m);
    else queue.push(m);
  });
  const next = (match) => {
    const i = queue.findIndex(match);
    if (i >= 0) return Promise.resolve(queue.splice(i, 1)[0]);
    return new Promise((resolve) => {
      const w = { match, resolve };
      waiting.push(w);
      setTimeout(() => {
        const j = waiting.indexOf(w);
        if (j >= 0) waiting.splice(j, 1), resolve(null);
      }, 5000);
    });
  };
  ws.send(JSON.stringify({ t: "hello", v: 2, device, name: "test", index_after: 0 }));
  await next((m) => m.t === "welcome");
  await next((m) => m.t === "index");
  let req = 0, dseq = 0;
  return {
    async ops(list) {
      const r = ++req;
      ws.send(JSON.stringify({ t: "ops", req: r, ops: list.map((o) => ({ dseq: ++dseq, t: dseq, by: "person", ...o })) }));
      return (await next((m) => m.req === r))?.ops;
    },
    /** The server's log, as a device pulls it. */
    async log() {
      const all = [];
      for (let after = 0; ; ) {
        const r = ++req;
        ws.send(JSON.stringify({ t: "pull_index", req: r, after }));
        const m = await next((x) => x.req === r);
        all.push(...m.ops);
        if (!m.more) break;
        after = m.ops.at(-1).seq;
      }
      return all;
    },
    close: () => ws.close(),
  };
}
let fidN = 0;
const fid = () => "e" + String(++fidN).padStart(15, "0");
const mkdir = (path) => ({ op: "mkdir", path, kind: "folder", fid: fid() });
const board = (path) => ({ op: "create", path, kind: "board", ref: (++fidN).toString(16).padStart(12, "0") });
/** Everything list gives under `folder`, recursively, page by page. */
async function listAll(t, folder) {
  const out = [];
  let cursor;
  for (let i = 0; i < 500; i++) {
    const r = await agent(t, "list", { folder, recursive: true, ...(cursor ? { cursor } : {}) });
    if (r.status !== 200) return r;
    out.push(...r.entries);
    if (!r.cursor) return out;
    cursor = r.cursor;
  }
  return out;
}
const view = (e) => ({ path: e.path, kind: e.kind, id: e.fid ?? e.ref });

await section("backfill in bounded steps, then the same index as the reducer's; live ops after", async () => {
  const s = await enabled(BF);
  const ws = await socket(s, "b1b1b1b1b1b1b1b1");
  const dirs = Array.from({ length: 12 }, (_, i) => mkdir(`/d${i}`));
  ok((await ws.ops([...dirs, board("/d0/n.board.json"), mkdir("/d1/sub")])).every((a) => Number.isInteger(a.seq)), "(14 ops accepted)");
  const [d2] = [dirs[2]];
  ok((await ws.ops([{ op: "rename", path: "/d2", to: "/d3/moved", kind: "folder", fid: d2.fid }, { op: "remove", path: "/d4", to: "/Trash/d4", kind: "folder", fid: dirs[4].fid }, { op: "forget", path: "/d5", kind: "folder", fid: dirs[5].fid }])).every((a) => Number.isInteger(a.seq)), "(a rename, a remove and a forget accepted)");
  // (5 ops a step here: the cursor moves 5 at a time)
  await ix(BF, { bounds: { ops: 5 } });
  const t = await grant(s, [{ path: "/", access: "read" }]);
  const b = await ix(BF);
  ok(b.state === "building" && b.max === 17, "a first grant starts the index building: " + JSON.stringify(b));
  const r503 = await agent(t, "stat", { path: "/d0" });
  ok(r503.status === 503 && r503.error === "index_building" && r503.retry_after > 0 || r503.status === 200, "while it builds, a read is 503 index_building (or already done): " + r503.status);
  const seen = new Set();
  let s2;
  // (bounded by time, not by a count of polls: a slow machine takes more polls)
  for (const end = Date.now() + 30_000; Date.now() < end; ) {
    s2 = await ix(BF);
    seen.add(s2.cursor);
    if (s2.state === "ready") break;
    await sleep(5);
  }
  ok(s2.state === "ready" && s2.cursor === 17, "the alarm builds it to the log's last op, then ready: " + JSON.stringify(s2));
  ok([...seen].every((c) => c % 5 === 0 || c === 17), "each step applies at most 5 ops (the bound lowered): " + [...seen]);
  const log = await ws.log();
  const mem = U.SyncIndex ? new U.SyncIndex() : null;
  for (const op of log) U.reduce(mem, op);
  const want = mem.entries().filter((e) => !e.path.startsWith("/Trash")).map((e) => ({ path: e.path, kind: e.kind, id: e.id }));
  const got = await listAll(t, "/");
  ok(Array.isArray(got) && JSON.stringify(got.map(view)) === JSON.stringify(want), `list of / (recursive) is the reducer's index of the same log, Trash left out: ${got.length ?? got.status} of ${want.length}`);
  ok((await agent(t, "stat", { path: "/d3/moved" })).entry?.id === undefined && (await agent(t, "stat", { path: "/d3/moved" })).entry?.fid === d2.fid, "stat finds an entry where the reducer put it");
  ok((await agent(t, "stat", { path: "/d2" })).entry === null && (await agent(t, "stat", { path: "/d5" })).entry === null, "and nothing where it left");
  ok(mem.gone.size >= 1 && (await ix(BF)).gone === mem.gone.size, "its tombstones are the reducer's: " + mem.gone.size);
  // live: an op accepted is in the index at once
  const live = mkdir("/live");
  const a = await ws.ops([live]);
  const st = await agent(t, "stat", { path: "/live" });
  ok(Number.isInteger(a[0].seq) && st.status === 200 && st.entry?.fid === live.fid, "an op accepted when the index is ready is in it at once: " + JSON.stringify(st).slice(0, 120));
  ok((await ix(BF)).cursor === a[0].seq, "the cursor follows it");
  ws.close();
});

await section("one step at a time: 503 while it builds; one budget, the ops and bytes bounds a step; a single-flight rebuild", async () => {
  const s = await enabled(MS);
  const ws = await socket(s, "b7b7b7b7b7b7b7b7");
  await ws.ops(Array.from({ length: 12 }, (_, i) => mkdir(`/m${i}`)));
  // (the alarm leaves it alone: each step is the test's)
  await ix(MS, { manual: true, bounds: { visits: 40 } });
  const t = await grant(s, [{ path: "/", access: "read" }]);
  const r = await agent(t, "stat", { path: "/m0" });
  ok(r.status === 503 && r.error === "index_building" && r.retry_after > 0, "while it builds, a read is 503 index_building, with retry_after: " + JSON.stringify(r));
  // one budget of 40 rows for the whole step: the step that passes it rolls back whole (cursor kept),
  // and the next step takes only the ops that fitted
  const c1 = (await ix(MS, { step: true })).cursor, c2 = (await ix(MS, { step: true })).cursor;
  ok(c1 === 0 && c2 > 0 && c2 < 12, `a step past its budget (40 rows) rolls back: ${c1}; the next applies what fitted: ${c2}`);
  let s3 = await ix(MS);
  for (let i = 0; i < 40 && s3.state !== "ready"; i++) s3 = await ix(MS, { step: true });
  ok(s3.state === "ready" && s3.cursor === 12, "steps reach the end: ready");
  // the bytes bound: 1 byte a step still applies one op (the first always), so one op a step
  await ix(MS, { bounds: { visits: 100_000, bytes: 1 } });
  await post(s, "/api/sync/v1/index/rebuild", {});
  const b1 = (await ix(MS, { step: true })).cursor, b2 = (await ix(MS, { step: true })).cursor;
  ok(b1 === 1 && b2 === 2, `past the bytes bound a step applies its first op only: ${b1}, ${b2}`);
  // single-flight: asked again while it builds, the rebuild already under way is left as it is
  const again = await (await post(s, "/api/sync/v1/index/rebuild", {})).json();
  ok(again.state === "building" && (await ix(MS)).cursor === 2, "a rebuild asked for while one builds adds nothing: its cursor is kept");
  await ix(MS, { manual: false, bounds: { bytes: 1 << 20 } });
  ok((await until(MS, "ready")).state === "ready", "(and the alarm finishes it)");
  ws.close();
});

await section("never ready behind the log: a live batch past a step's ops, ops accepted with no live update; the counts kept across ops", async () => {
  const s = await enabled(LB);
  const ws = await socket(s, "b8b8b8b8b8b8b8b8");
  await ws.ops([mkdir("/l0"), mkdir("/l1"), mkdir("/l2")]);
  const t = await grant(s, [{ path: "/", access: "read" }]);
  ok((await until(LB, "ready")).state === "ready", "(ready)");
  // (the alarm left alone, and 2 ops a step: a batch of 5 is more than one live update applies)
  await ix(LB, { manual: true, bounds: { ops: 2 } });
  await ws.ops([0, 1, 2, 3, 4].map((i) => mkdir(`/n${i}`)));
  const b = await ix(LB);
  ok(b.state === "building" && b.cursor === 5 && b.max === 8, "a live batch longer than a step's ops: building, never ready behind the log: " + JSON.stringify(b));
  ok((await agent(t, "stat", { path: "/n4" })).error === "index_building", "and a read is 503 index_building");
  await ix(LB, { manual: false, bounds: { ops: 1000 } });
  ok((await until(LB, "ready")).cursor === 8 && (await agent(t, "stat", { path: "/n4" })).entry?.path === "/n4", "the alarm catches up: ready, and the batch's last op is in it");
  // ops accepted with no live update (as while agents are off): ready, but behind the log
  await ix(LB, { manual: true, noLive: true });
  await ws.ops([mkdir("/late")]);
  const c = await ix(LB);
  ok(c.state === "ready" && c.cursor === 8 && c.max === 9, "(an op accepted with no live update: ready, behind) " + JSON.stringify(c));
  const r = await agent(t, "stat", { path: "/late" });
  ok(r.status === 503 && r.error === "index_building", "a read of an index behind the log is 503 index_building, never a stale answer: " + JSON.stringify(r));
  ok((await ix(LB)).state === "building", "and it is building again");
  await ix(LB, { manual: false, noLive: false });
  ok((await until(LB, "ready")).cursor === 9 && (await agent(t, "stat", { path: "/late" })).entry?.path === "/late", "the alarm catches up; the op is in it");
  // the counts are kept from op to op: the bound is the live entries now, plus one
  const n = (await ix(LB)).entries;
  await ix(LB, { bounds: { entries: n + 1 } });
  await ws.ops([mkdir("/c1")]);
  ok((await ix(LB)).state === "ready", "(one more entry: at the bound, ready)");
  await ws.ops([mkdir("/c2")]);
  const f = await ix(LB);
  ok(f.state === "failed" && f.reason === "entries", "a second, in its own op: past the bound counted across ops, failed (entries): " + JSON.stringify(f));
  ws.close();
});

await section("reads: a folder's own range, a file isn't a folder, NFD finds NFC, the page bound", async () => {
  const s = await enabled(RX);
  const ws = await socket(s, "b9b9b9b9b9b9b9b9");
  const nfc = "/café", nfd = "/café";
  await ws.ops([mkdir("/a"), mkdir("/a/x"), mkdir("/a/x/y"), mkdir("/b"), mkdir("/b/z"), mkdir(nfc), mkdir(nfc + "/k"), board("/a/f.board.json")]);
  const t = await grant(s, [{ path: "/", access: "read" }]);
  ok((await until(RX, "ready")).state === "ready", "(ready)");
  const a = await listAll(t, "/a");
  ok(Array.isArray(a) && JSON.stringify(a.map((e) => e.path).sort()) === JSON.stringify(["/a/f.board.json", "/a/x", "/a/x/y"]), "a recursive list of /a is /a's own, nothing of the folders after it: " + JSON.stringify(a.map?.((e) => e.path) ?? a));
  const f = await agent(t, "list", { folder: "/a/f.board.json" });
  ok(f.status === 404 && f.error === "missing", "a list of a document, not a folder: 404 missing: " + f.status);
  ok((await agent(t, "stat", { path: nfd })).entry?.path === nfc, "stat by the NFD spelling finds the NFC entry");
  const d = await listAll(t, nfd);
  ok(Array.isArray(d) && d.length === 1 && d[0].path === nfc + "/k", "a recursive list by the NFD spelling gives the folder's own: " + JSON.stringify(d.map?.((e) => e.path) ?? d));
  await ix(RX, { bounds: { page: 2 } });
  const p = await agent(t, "list", { folder: "/" });
  ok(p.status === 200 && p.entries.length === 2 && typeof p.cursor === "string", `at most 2 entries a page (the bound lowered), then a cursor: ${p.entries?.length}, ${p.cursor}`);
  ws.close();
});

await section("an empty log: ready at once, in the grant's own transaction", async () => {
  const s = await enabled(EM);
  await ix(EM, { manual: true });
  const t = await grant(s, [{ path: "/", access: "read" }]);
  const e = await ix(EM);
  ok(e.state === "ready" && e.max === 0, "a first grant on an empty log: ready, no step needed: " + JSON.stringify(e));
  const r = await agent(t, "list", { folder: "/" });
  ok(r.status === 200 && r.entries.length === 0, "and a list answers at once, empty: " + r.status);
});

await section("a rebuild is the person's: an account without sync is refused", async () => {
  const r = await at("/auth/dev", { method: "POST", headers: { origin: SITE, "content-type": "application/json" }, body: JSON.stringify({ token: "dev-token", account_id: NE }) });
  const s = r.headers.getSetCookie().map((c) => c.split(";")[0]).find((c) => c.startsWith("__Host-sb_session="));
  const rb = await post(s, "/api/sync/v1/index/rebuild", {});
  ok(rb.status === 403 && (await rb.json()).error === "forbidden", "a rebuild before sync is turned on: 403 forbidden: " + rb.status);
});

await section("the visit budget: an op too big for one step is applied as a job over the steps after; one too big even alone fails the index, sticky; the person rebuilds", async () => {
  const s = await enabled(BU);
  const ws = await socket(s, "b2b2b2b2b2b2b2b2");
  const top = mkdir("/top");
  await ws.ops([top]);
  await ws.ops(Array.from({ length: 30 }, (_, i) => mkdir(`/top/c${i}`)));
  await ws.ops([{ op: "rename", path: "/top", to: "/top2", kind: "folder", fid: top.fid }]);
  // (40 visits: each mkdir fits, the slice is cut at the budget and goes on next step; the rename of a 30-child folder
  // can't fit 40 alone: a job, 4 rows a page)
  await ix(BU, { manual: true, bounds: { visits: 40, jobPage: 4 } });
  const t = await grant(s, [{ path: "/", access: "read" }]);
  const phases = new Set(), reads = [], cursors = new Set();
  let st = await ix(BU);
  for (let i = 0; i < 500 && st.state === "building"; i++) {
    st = await ix(BU, { step: true });
    if (st.job) {
      phases.add(st.job);
      cursors.add(st.cursor);
      if (reads.length < 3) reads.push((await agent(t, "stat", { path: "/top" })).error);
    }
  }
  ok(st.state === "ready" && st.cursor === 32 && st.job === null && st.stage === 0, "the rename is applied as a job, over steps: ready, every op in, no job or stage left: " + JSON.stringify(st));
  ok(["pre", "stage"].every((p) => phases.has(p)), "its phases, each in steps of their own: " + [...phases]);
  ok(cursors.size === 1 && cursors.has(31), "while it runs, the cursor stays before the op (it moves only with the op whole): " + [...cursors]);
  ok(reads.length > 0 && reads.every((e) => e === "index_building"), "while it runs, a read is 503 index_building, never a part of it: " + reads);
  const mem = new U.SyncIndex();
  for (const op of await ws.log()) U.reduce(mem, op);
  const want = mem.entries().map((e) => ({ path: e.path, kind: e.kind, id: e.id }));
  const got = await listAll(t, "/");
  ok(Array.isArray(got) && JSON.stringify(got.map(view)) === JSON.stringify(want), `and the index is the reducer's: ${got.length ?? got.status} of ${want.length}`);
  // one that can't fit even as a job (3 visits: not even the folder's own move): failed, sticky
  await ix(BU, { manual: false, bounds: { visits: 3 } });
  await ws.ops([{ op: "rename", path: "/top2", to: "/top3", kind: "folder", fid: top.fid }]);
  const f = await until(BU, "failed");
  ok(f.state === "failed" && f.reason === "visits" && f.cursor === 32, "an op too big for a whole budget even in a job fails the index (visits), the ops before it applied: " + JSON.stringify(f));
  const r = await agent(t, "list", { folder: "/" });
  ok(r.status === 503 && r.error === "index_failed" && r.reason === "visits", "reads answer 503 index_failed, with the reason");
  await ix(BU, { bounds: { visits: 100_000 } });
  const a = await ws.ops([mkdir("/later")]);
  await sleep(300);
  ok(Number.isInteger(a[0].seq) && (await ix(BU)).state === "failed", "an op accepted later is accepted, and the index stays failed (no automatic rebuild)");
  // the person's rebuild, through the same big op again as a job; a second request adds nothing
  await ix(BU, { bounds: { visits: 40, jobPage: 4 } });
  const rb = await (await post(s, "/api/sync/v1/index/rebuild", {})).json();
  const rb2 = await (await post(s, "/api/sync/v1/index/rebuild", {})).json();
  ok(rb.state === "building" && (rb2.state === "building" || rb2.state === "ready"), "the person's rebuild starts from the first op; asked again, it is the same one");
  const ready = await until(BU, "ready", 60_000);
  ok(ready.state === "ready" && (await agent(t, "stat", { path: "/top3/c29" })).entry?.kind === "folder" && (await agent(t, "stat", { path: "/later" })).entry?.kind === "folder" && (await agent(t, "stat", { path: "/top2" })).entry === null, "rebuilt through both big ops, as jobs: ready, and the whole log in it");
  ws.close();
});

await section("a job's bounds: a folder, tombstones and entries, each past by the job's own op; its counts published", async () => {
  const s = await enabled(JB);
  const ws = await socket(s, "b4b4b4b4b4b4b4b4");
  const big = async (name, n) => {
    const top = mkdir(name);
    await ws.ops([top]);
    const kids = Array.from({ length: n }, (_, i) => mkdir(`${name}/c${i}`));
    await ws.ops(kids);
    return { top, kids };
  };
  const src = await big("/src", 30), dest = await big("/dest", 2);
  const t = await grant(s, [{ path: "/", access: "read" }]);
  ok((await until(JB, "ready")).state === "ready", "(ready)");
  const job = { visits: 40, jobPage: 4 };
  const rebuild = async (bounds) => {
    await ix(JB, { bounds });
    await post(s, "/api/sync/v1/index/rebuild", {});
    return until(JB, "ready", 60_000);
  };
  // the folder bound: /src (30 descendants) into /dest, at 2 children already, its bound 2
  await ix(JB, { bounds: { ...job, perFolder: 2 } });
  await ws.ops([{ op: "rename", path: "/src", to: "/dest/src", kind: "folder", fid: src.top.fid, parent: dest.top.fid }]);
  const f1 = await until(JB, "failed", 60_000);
  ok(f1.state === "failed" && f1.reason === "folder", "a job whose op puts a third child in a folder of bound 2 fails it (folder): " + JSON.stringify(f1));
  ok((await rebuild({ visits: 100_000, perFolder: 10_000 })).state === "ready", "(rebuilt)");
  // a forget as a job, within its bounds: its counts published are the index's own
  await ix(JB, { bounds: job });
  await ws.ops([{ op: "forget", path: "/dest/src", kind: "folder", fid: src.top.fid }]);
  const r1 = await until(JB, "ready", 60_000);
  ok(r1.state === "ready" && r1.n === r1.entries && r1.g === r1.gone && r1.g >= 31, "a forget of 31 as a job: ready, its published counts the index's own (entries " + r1.n + "/" + r1.entries + ", tombstones " + r1.g + "/" + r1.gone + ")");
  // the tombstone bound: another 31 forgotten as a job, the bound 5 past the tombstones now
  const g = await big("/g", 30);
  ok((await until(JB, "ready", 60_000)).state === "ready", "(ready)");
  await ix(JB, { bounds: { ...job, gone: (await ix(JB)).gone + 5 } });
  await ws.ops([{ op: "forget", path: "/g", kind: "folder", fid: g.top.fid }]);
  const f2 = await until(JB, "failed", 60_000);
  ok(f2.state === "failed" && f2.reason === "gone", "a forget as a job past the tombstone bound fails it (gone): " + JSON.stringify(f2));
  ok((await rebuild({ visits: 100_000, gone: 100_000 })).state === "ready", "(rebuilt)");
  // the entries bound: a create whose parent is in a trashed folder of 30 brings it back (a job) and adds one, the
  // bound the entries now
  const e = await big("/e", 30);
  await ws.ops([{ op: "remove", path: "/e", to: "/Trash/e", kind: "folder", fid: e.top.fid }]);
  ok((await until(JB, "ready", 60_000)).state === "ready", "(ready, /e in Trash)");
  await ix(JB, { bounds: { ...job, entries: (await ix(JB)).entries } });
  await ws.ops([{ ...board("/e/c0/new.board.json"), parent: e.kids[0].fid }]);
  const f3 = await until(JB, "failed", 60_000);
  ok(f3.state === "failed" && f3.reason === "entries", "a job whose op adds one past the entries bound fails it (entries): " + JSON.stringify(f3));
  ok((await agent(t, "stat", { path: "/e" })).error === "index_failed", "and reads answer index_failed");
  ws.close();
});

await section("a job survives a restart in each of its phases", async () => {
  const s = await enabled(JR);
  const ws = await socket(s, "b3b3b3b3b3b3b3b3");
  const top = mkdir("/r");
  await ws.ops([top]);
  await ws.ops(Array.from({ length: 6 }, (_, i) => mkdir(`/r/d${i}`)));
  await ws.ops(Array.from({ length: 18 }, (_, i) => board(`/r/d${i % 6}/b${i}.board.json`)));
  const t = await grant(s, [{ path: "/", access: "read" }]);
  ok((await until(JR, "ready")).state === "ready", "(ready)");
  const bounds = { visits: 40, jobPage: 3 };
  await ix(JR, { manual: true, bounds });
  await ws.ops([{ op: "remove", path: "/r", to: "/Trash/r", kind: "folder", fid: top.fid }]);
  let st = await ix(JR), last = null, restarts = 0;
  const trace = [];
  const seen = [];
  for (let i = 0; i < 500 && st.state === "building"; i++) {
    // (the bounds with each step: an object restarted holds the defaults again)
    st = await ix(JR, { step: true, manual: true, bounds }).catch(() => ({}));
    if (!("state" in st)) {
      await restart(JR);
      st = await ix(JR, { step: true, manual: true, bounds });
    }
    trace.push(`${st.state}/${st.job}/${st.stage}/${st.cursor}`);
    if (st.job !== last) {
      if (st.job) seen.push(st.job);
      last = st.job;
      // (a restart now: what the object held in memory is gone; the job is in storage)
      await restart(JR);
      restarts++;
      st = await ix(JR, { manual: true, bounds });
    }
  }
  ok(st.state === "ready" && st.job === null && st.stage === 0 && restarts >= 3, `a restart at each phase (${seen.join(", ")}; ${restarts} restarts): it goes on, and ends ready` + (process.env.DEBUG ? " " + trace.join(" ") : ""));
  // (the restarts closed the socket: a new one for the log)
  const ws2 = await socket(s, "b3b3b3b3b3b3b3b4");
  const mem = new U.SyncIndex();
  for (const op of await ws2.log()) U.reduce(mem, op);
  ws2.close();
  const got = await listAll(t, "/Trash");
  const want = mem.entries().filter((e) => e.path.startsWith("/Trash")).map((e) => ({ path: e.path, kind: e.kind, id: e.id }));
  ok(Array.isArray(got) && JSON.stringify(got.map(view)) === JSON.stringify(want), `and its index is the reducer's: ${got.length ?? got.status} of ${want.length}`);
  await ix(JR, { manual: false });
  ws.close();
});

await section("the bounds: live entries, tombstones and a folder's children, each exact and one past", async () => {
  const s = await enabled(CP);
  const ws = await socket(s, "b3b3b3b3b3b3b3b3");
  const t = await grant(s, [{ path: "/", access: "read" }]);
  ok((await until(CP, "ready")).state === "ready", "(an empty log: ready at once)");
  // a folder of 3 at most: 3 children fit, the 4th fails the index
  await ix(CP, { bounds: { perFolder: 3, entries: 100_000, gone: 100_000 } });
  await ws.ops([mkdir("/f"), mkdir("/f/a"), mkdir("/f/b")]);
  ok((await ix(CP)).state === "ready", "3 in one folder (root has 1, /f 2... at the bound): ready");
  await ws.ops([mkdir("/f/c")]);
  ok((await ix(CP)).state === "ready", "a folder of exactly 3: ready");
  await ws.ops([mkdir("/f/d")]);
  const f1 = await ix(CP);
  ok(f1.state === "failed" && f1.reason === "folder", "a 4th in it: failed (folder): " + JSON.stringify(f1));
  // entries: 4 at most (the log has 5: 4 fit, the 5th is one past)
  await ix(CP, { bounds: { perFolder: 10_000, entries: 4 } });
  await post(s, "/api/sync/v1/index/rebuild", {});
  const f2 = await until(CP, "failed");
  // (the step that passed the bound is rolled back whole: a failed index publishes nothing of it)
  ok(f2.state === "failed" && f2.reason === "entries" && f2.entries <= 4 && f2.cursor <= 4, "rebuilt with 4 entries at most, the 5th fails it (entries), nothing past the bound kept: " + JSON.stringify(f2));
  ok((await agent(t, "stat", { path: "/f" })).error === "index_failed", "and reads answer index_failed");
  // tombstones: a forget makes one; 0 allowed fails at the first
  await ix(CP, { bounds: { entries: 100_000, gone: 0 } });
  await post(s, "/api/sync/v1/index/rebuild", {});
  ok((await until(CP, "ready")).state === "ready", "(rebuilt, no tombstones yet)");
  const g = await ws.ops([{ op: "forget", path: "/f/a", kind: "folder", fid: "e" + String(fidN - 3).padStart(15, "0") }]);
  const f3 = await ix(CP);
  ok(Number.isInteger(g[0].seq) && f3.state === "failed" && f3.reason === "gone", "a tombstone past the bound fails it (gone), the op accepted: " + JSON.stringify(f3));
  ws.close();
});

await section("ops appended while it builds; a restart while it builds", async () => {
  const s = await enabled(CA);
  const ws = await socket(s, "b4b4b4b4b4b4b4b4");
  await ws.ops(Array.from({ length: 10 }, (_, i) => mkdir(`/a${i}`)));
  await ix(CA, { bounds: { ops: 1 } });
  const t = await grant(s, [{ path: "/", access: "read" }]);
  // (appended while it builds: ready only once the cursor reaches the log's end as it is then)
  const late = mkdir("/late");
  await ws.ops([late]);
  await restart(CA);
  await ix(CA, { bounds: { ops: 1 } });
  const r = await until(CA, "ready");
  ok(r.state === "ready" && r.cursor === r.max && r.max === 11, "across a restart, it goes on and is ready only at the log's end, appends included: " + JSON.stringify(r));
  ok((await agent(t, "stat", { path: "/late" })).entry?.fid === late.fid, "the op appended while it built is in it");
  ws.close();
});

await section("a live op too big for one update: accepted, the index builds it as a job", async () => {
  const s = await enabled(LV);
  const ws = await socket(s, "b6b6b6b6b6b6b6b6");
  const t = await grant(s, [{ path: "/", access: "read" }]);
  ok((await until(LV, "ready")).state === "ready", "(ready)");
  await ix(LV, { bounds: { visits: 30, jobPage: 4 } });
  const top = mkdir("/t");
  await ws.ops([top]);
  await ws.ops(Array.from({ length: 20 }, (_, i) => mkdir(`/t/k${i}`)));
  ok((await ix(LV)).state === "ready", "(small ops fit a fresh budget each)");
  const before = await ix(LV);
  const a = await ws.ops([{ op: "rename", path: "/t", to: "/u", kind: "folder", fid: top.fid }]);
  const after = await ix(LV);
  ok(Number.isInteger(a[0].seq), "the op is accepted, whatever the index does");
  ok(after.state === "building" && after.cursor === before.cursor && after.entries === before.entries, "too big for one live update: building again, its cursor and entries as before the op: " + JSON.stringify(after));
  ok((await agent(t, "stat", { path: "/t" })).error === "index_building", "a read meanwhile is 503 index_building");
  const done = await until(LV, "ready");
  ok(done.cursor === before.cursor + 1 && (await agent(t, "stat", { path: "/u/k19" })).entry?.kind === "folder" && (await agent(t, "stat", { path: "/t/k0" })).entry === null, "the alarm applies it as a job: ready, the whole rename in it: " + JSON.stringify(done));
  ok((await ws.log()).some((o) => o.op === "rename" && o.to === "/u"), "and the op is in the log every device pulls");
  ws.close();
});

await section("reads: scope, Trash by where it came from, pages, the examined bound, cursors", async () => {
  const s = await enabled(RD);
  const ws = await socket(s, "b5b5b5b5b5b5b5b5");
  const z = mkdir("/A/z"), w = mkdir("/B/w");
  await ws.ops([mkdir("/A"), mkdir("/B"), mkdir("/A/x"), z, w, mkdir("/B/y")]);
  await ws.ops([{ op: "remove", path: "/A/z", to: "/Trash/z", kind: "folder", fid: z.fid }, { op: "remove", path: "/B/w", to: "/Trash/w", kind: "folder", fid: w.fid }]);
  for (let i = 0; i < 6; i++) await ws.ops([mkdir(`/B/q${i}`)]);
  const t = await grant(s, [{ path: "/A", access: "read" }]);
  ok((await until(RD, "ready")).state === "ready", "(ready)");
  const tr = await agent(t, "list", { folder: "/Trash" });
  ok(tr.status === 200 && JSON.stringify(tr.entries.map((e) => e.path)) === '["/Trash/z"]', "Trash lists only what came from the grant's scope: " + JSON.stringify(tr.entries?.map((e) => e.path)));
  ok((await agent(t, "stat", { path: "/Trash/z" })).entry?.trashed?.from === "/A/z" && (await agent(t, "stat", { path: "/Trash/w" })).entry === null, "stat in Trash: its own, and nothing for another's");
  ok((await agent(t, "list", { folder: "/" })).error === "scope" && (await agent(t, "list", { folder: "/B" })).error === "scope", "outside the scope: 403");
  const la = await agent(t, "list", { folder: "/A" });
  ok(la.status === 200 && JSON.stringify(la.entries.map((e) => e.path)) === '["/A/x"]' && la.cursor === null, "a folder in scope: its children, by path, no cursor at the end");
  ok((await agent(t, "list", { folder: "/A", cursor: "/B/y" })).status === 400, "a cursor from outside the folder is refused, never followed");
  // the examined bound: 2 rows a call, and a whole-workspace grant sees /B's 7 children (y, q0-q5) 2 by 2
  const t2 = await grant(s, [{ path: "/", access: "read" }]);
  await ix(RD, { bounds: { examined: 2, page: 1000 } });
  const p1 = await agent(t2, "list", { folder: "/B" });
  ok(p1.status === 200 && p1.entries.length === 2 && typeof p1.cursor === "string", "at most 2 rows looked at a call, then a cursor: " + JSON.stringify(p1).slice(0, 160));
  const all = await (async () => {
    const out = [];
    let c;
    for (let i = 0; i < 20; i++) {
      const r = await agent(t2, "list", { folder: "/B", ...(c ? { cursor: c } : {}) });
      out.push(...r.entries);
      if (!r.cursor) break;
      c = r.cursor;
    }
    return out;
  })();
  ok(all.length === 7 && new Set(all.map((e) => e.path)).size === 7, "and its cursors reach the whole folder, each child once: " + all.length);
  // filtered rows count: Trash with an out-of-scope entry first, examined 1: an empty page, and a cursor past it
  await ix(RD, { bounds: { examined: 1 } });
  const e1 = await agent(t, "list", { folder: "/Trash" });
  ok(e1.status === 200 && e1.entries.length === 0 && e1.cursor === "/Trash/w", "a row filtered out still counts: an empty page, with a cursor past it");
  const e2 = await agent(t, "list", { folder: "/Trash", cursor: e1.cursor });
  ok(e2.entries.length === 1 && e2.entries[0].path === "/Trash/z", "and the next page goes on from there");
  await ix(RD, { bounds: { examined: 20_000 } });
  ws.close();
});

console.log(`${count - failures}/${count} passed`);
await mf.dispose();
process.exit(failures ? 1 : 0);
