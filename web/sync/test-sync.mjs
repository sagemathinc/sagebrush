// Tests for the sync service (web/sync/, design/sync-server.md), in
// Miniflare with real Durable Objects (SQLite), D1 and R2.
//
//   node web/sync/test-sync.mjs
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, "../site/package.json"));
const { Miniflare, convertV4MiniflareOptions } = require("miniflare");

const SITE = "https://sagebrush.test";
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333"; // signed in, never allowlisted

let failures = 0;
let count = 0;
function ok(cond, what) {
  count++;
  if (!cond) {
    failures++;
    console.log("FAIL", what);
  }
}

const script = execFileSync("bun", ["build", join(here, "test-entry.ts"), "--format", "esm", "--target", "browser", "--external", "cloudflare:workers"], { encoding: "utf8" });
const base = { modules: true, script, compatibilityDate: "2026-10-01", d1Databases: ["SHARE_DB"], r2Buckets: ["SHARE_BUCKET"] };
const shareBindings = { SESSION_KEY: "session-key", SHARE_DEV: "1", DEV_AUTH_TOKEN: "dev-token" };
const mf = new Miniflare(convertV4MiniflareOptions({
  workers: [
    {
      ...base,
      name: "sync",
      bindings: { ...shareBindings, SYNC_ACCOUNTS: `${A}, ${B}` },
      durableObjects: { SYNC_ACCOUNT: { className: "SyncAccount", useSQLite: true }, SYNC_DOC: { className: "SyncDoc", useSQLite: true } },
      routes: ["sagebrush.test/*"],
    },
    // the same code with no sync bindings, as production is today
    { ...base, name: "prod", bindings: shareBindings, routes: ["prod.test/*"] },
  ],
}));
const db = await mf.getD1Database("SHARE_DB", "sync");
const mig = join(here, "../share/migrations");
for (const m of readdirSync(mig).filter((f) => f.endsWith(".sql")).sort())
  for (const s of readFileSync(join(mig, m), "utf8").replace(/--.*$/gm, "").split(";").map((s) => s.trim()).filter(Boolean)) await db.prepare(s).run();

const fetchAt = (origin, path, init = {}) => mf.dispatchFetch(origin + path, { redirect: "manual", ...init });
async function signIn(account_id, origin = SITE) {
  const r = await fetchAt(origin, "/auth/dev", { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ token: "dev-token", account_id }) });
  return r.headers.getSetCookie().map((c) => c.split(";")[0]).find((c) => c.startsWith("__Host-sb_session="));
}
const post = (session, path, body, extra = {}) => fetchAt(SITE, path, { method: "POST", headers: { cookie: session, origin: SITE, "content-type": "application/json", ...extra }, body: JSON.stringify(body ?? {}) });

/** A socket on the account object, with a queue of the messages it gets. */
async function socket(session, origin = SITE) {
  const r = await fetchAt(SITE, "/api/sync/v1/account", { headers: { cookie: session, origin, upgrade: "websocket" } });
  if (r.status !== 101) return { status: r.status };
  const ws = r.webSocket;
  ws.accept();
  const queue = [];
  const waiting = [];
  let closed = null;
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    const w = waiting.findIndex((x) => x.match(m));
    if (w >= 0) waiting.splice(w, 1)[0].resolve(m);
    else queue.push(m);
  });
  ws.addEventListener("close", (e) => (closed = e.code));
  let req = 0;
  const s = {
    status: 101,
    ws,
    queue,
    get closed() { return closed; },
    send: (m) => ws.send(JSON.stringify(m)),
    /** The next message `match` accepts, or null after 3 seconds. */
    next(match = () => true) {
      const i = queue.findIndex(match);
      if (i >= 0) return Promise.resolve(queue.splice(i, 1)[0]);
      return new Promise((resolve) => {
        const w = { match, resolve };
        waiting.push(w);
        setTimeout(() => {
          const j = waiting.indexOf(w);
          if (j >= 0) waiting.splice(j, 1), resolve(null);
        }, 3000);
      });
    },
    /** Send a request and wait for its answer (by req). */
    async ask(m) {
      const r = ++req;
      s.send({ ...m, req: r });
      return s.next((x) => x.req === r);
    },
  };
  return s;
}
async function hello(s, device, index_after = 0) {
  s.send({ t: "hello", v: 1, device, name: "test", index_after });
  const w = await s.next((m) => m.t === "welcome" || m.t === "error");
  const ix = await s.next((m) => m.t === "index");
  return { welcome: w, index: ix };
}

// ---- patches: ids, envelopes, bodies
const enc = new TextEncoder();
const pid = (t, client) => t.toString(36).padStart(11, "0") + "_" + client;
/** A batch for `doc`: each patch [cseq, id, parents, payload text, blobs?]. */
function batch(doc, epoch, patches, extra = {}) {
  const bodies = patches.map((p) => enc.encode(p[3] ?? `{"patch":${JSON.stringify(p[1])}}`));
  const body = Buffer.concat(bodies.map((b) => Buffer.from(b)));
  return { t: "batch", doc, epoch, patches: patches.map((p, i) => ({ cseq: p[0], id: p[1], parents: p[2], size: bodies[i].length, ...(p[4] ? { blobs: p[4] } : {}) })), body: body.toString("base64"), ...extra };
}
const payloads = (item) => {
  const b = Buffer.from(item.body, "base64");
  let at = 0;
  return item.patches.map((e) => b.subarray(at, (at += e.size)).toString());
};

// ---- the flag and the gates (§2, §11)
{
  const sp = await signIn(A, "https://prod.test");
  const r = await fetchAt("https://prod.test", "/api/sync/v1/enable", { method: "POST", headers: { cookie: sp, origin: "https://prod.test", "content-type": "application/json" }, body: "{}" });
  ok(r.status === 404 && (await r.json()).error === "sync is not enabled here", "without the sync bindings, sync is a 404 (the flag)");
  const sa = await signIn(A);
  ok((await post(null, "/api/sync/v1/enable", {})).status === 401, "no session: 401");
  ok((await fetchAt(SITE, "/api/sync/v1/enable", { method: "POST", headers: { cookie: sa, origin: "https://evil.test" } })).status === 403, "a cross-site request is refused");
  const sc = await signIn(C);
  ok((await post(sc, "/api/sync/v1/enable", {})).status === 403, "an account not in SYNC_ACCOUNTS can't turn sync on");
  ok((await socket(sc)).status === 403, "nor open a socket");
  ok((await socket(sa)).status === 403, "a socket before sync is turned on is refused");
  const e = await post(sa, "/api/sync/v1/enable", {});
  ok(e.status === 200 && (await e.json()).state === "active", "turning sync on");
  ok((await post(sa, "/api/sync/v1/enable", {})).status === 200, "again is a no-op");
  ok((await socket(sa, "https://evil.test")).status === 403, "a socket upgrade from another origin is refused (cross-site WebSocket hijacking)");
}

const sa = await signIn(A);
await post(sa, "/api/sync/v1/enable", {});
const sb = await signIn(B);
await post(sb, "/api/sync/v1/enable", {});

// ---- hello, and ops decided once each in dseq order (§3, §5.2)
const dev1 = "device-one-0001";
const dev2 = "device-two-0002";
{
  const s = await socket(sa);
  ok(s.status === 101, "the account socket opens");
  const { welcome, index } = await hello(s, dev1);
  ok(welcome?.t === "welcome" && welcome.v === 1 && welcome.next_dseq === 1 && welcome.state === "active", "welcome");
  ok(index?.t === "index" && index.ops.length === 0 && index.more === false, "an empty index");
  const nb = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const op = (dseq, o) => ({ dseq, t: 1000 + dseq, by: "person", kind: "folder", ...o });
  let a = await s.ask({ t: "ops", ops: [op(1, { op: "mkdir", path: "/A" }), op(2, { op: "create", path: "/A/n.ipynb", kind: "notebook", ref: nb })] });
  ok(a?.t === "ack" && a.ops.length === 2 && a.ops?.[0].seq === 1 && a.ops?.[1].seq === 2, "two ops accepted, in order");
  a = await s.ask({ t: "ops", ops: [op(1, { op: "mkdir", path: "/A" }), op(2, { op: "create", path: "/A/n.ipynb", kind: "notebook", ref: nb })] });
  ok(a?.ops?.[0].seq === 1 && a.ops?.[1].seq === 2, "resent ops get the same answer, and aren't applied twice");
  a = await s.ask({ t: "ops", ops: [op(4, { op: "mkdir", path: "/B" })] });
  ok(a?.t === "error" && a.code === "order" && a.detail.next_dseq === 3, "a gap in dseq is refused with next_dseq");
  a = await s.ask({ t: "ops", ops: [op(3, { op: "mkdir", path: "/x/../y" }), op(4, { op: "forget", path: "/A/n.ipynb", kind: "notebook", by: "agent:helper" }), op(5, { op: "mkdir", path: "/C" })] });
  ok(a?.ops?.[0].code === "invalid" && a.ops?.[1].code === "forbidden" && a.ops?.[2].seq === 3, "a bad path and an agent's forget are refused; the op after them applies");
  a = await s.ask({ t: "ops", ops: [op(3, { op: "mkdir", path: "/x/../y" }), op(4, { op: "mkdir", path: "/Z" })] });
  ok(a?.ops?.[0].code === "invalid" && a.ops?.[1].code === "forbidden", "a refusal is final: the same dseq gets the same refusal, whatever is sent");
  a = await s.ask({ t: "ops", ops: [op(6, { op: "mkdir", path: "/D", extra: 1 })] });
  ok(a?.ops?.[0]?.code === "invalid", "an unknown field in an op is refused");
  a = await s.ask({ t: "pull_index", after: 1 });
  ok(a?.t === "index" && a.ops.map((o) => o.seq).join() === "2,3", "pull_index from a seq");
  const s2 = await socket(sa);
  const h2 = await hello(s2, dev2, 0);
  ok(h2.welcome.next_dseq === 1 && h2.index.ops.length === 3, "another device gets the whole log, and its own dseq");
  const a2 = await s2.ask({ t: "ops", ops: [op(1, { op: "mkdir", path: "/E" })] });
  ok(a2?.ops?.[0].seq === 4, "the server's seq orders both devices' ops");
  s.ws.close();
  s2.ws.close();
}

// ---- batches: exact membership, framing, compare-and-swap (§4.1-4.4)
const docA = "0123456789ab";
{
  const s = await socket(sa);
  await hello(s, dev1);
  const X = "clientXXXX", Y = "clientYYYY";
  let a = await s.ask(batch(docA, 1, [[1, pid(100, X), []]]));
  ok(a?.t === "error" && a.code === "unknown_doc", "a new document's first batch must say its kind");
  a = await s.ask(batch(docA, 1, [[1, pid(100, X), [], "p1"], [2, pid(300, X), [pid(100, X)], "p2"]], { kind: "board" }));
  ok(a?.t === "ack" && a.batch.seq === 1 && a.batch.new === 2 && a.batch.head.seq === 1, "a new board's first batch");
  a = await s.ask(batch(docA, 1, [[1, pid(100, X), [], "p1"], [2, pid(300, X), [pid(100, X)], "p2"]]));
  ok(a?.batch?.new === 0 && a.batch.resent[pid(100, X)] === 1 && a.batch.resent[pid(300, X)] === 1, "a resend is acknowledged with its original seq, and stores nothing");
  // astra's CORR-D81-1 trace: 300_X accepted; a parent 200_X was never sent
  a = await s.ask(batch(docA, 1, [[1, pid(400, Y), [pid(200, X)]]]));
  ok(a?.t === "error" && a.code === "order", "a parent that was never accepted is refused, though its id is below the client's newest");
  a = await s.ask(batch(docA, 1, [[3, pid(200, X), []]]));
  ok(a?.t === "error" && a.code === "order", "a client's next patch can't have a smaller id than its last");
  a = await s.ask(batch(docA, 1, [[2, pid(250, X), []]]));
  ok(a?.t === "error" && a.code === "conflict", "a cseq reused for another patch is refused, never taken as a resend");
  a = await s.ask(batch(docA, 1, [[4, pid(500, X), []]]));
  ok(a?.t === "error" && a.code === "order" && a.detail.next_cseq === 3, "a gap in cseq is refused with next_cseq");
  // a mixed resend: the old patch is dropped, the new one's payload sliced out
  a = await s.ask(batch(docA, 1, [[2, pid(300, X), [pid(100, X)], "p2"], [3, pid(600, X), [pid(300, X)], "p3-new"]]));
  ok(a?.batch?.new === 1 && a.batch.seq === 2 && a.batch.resent[pid(300, X)] === 1, "a mixed resend stores only the new patch");
  let p = await s.ask({ t: "pull", doc: docA, epoch: 1, after: 1 });
  ok(p?.t === "batches" && p.items.length === 1 && p.items[0].patches.length === 1 && payloads(p.items[0])[0] === "p3-new" && p.items[0].author === "person", "its stored batch holds only that patch, with its own payload, and the server's author");
  const bad = batch(docA, 1, [[4, pid(700, X), [], "abc"]]);
  bad.patches[0].size = 2;
  a = await s.ask(bad);
  ok(a?.t === "error" && a.code === "invalid", "envelopes whose sizes don't add up to the body are refused");
  a = await s.ask({ ...batch(docA, 1, [[4, pid(700, X), []]]), author: "agent:x" });
  ok(a?.t === "error" && a.code === "invalid", "a batch can't name its own author");
  // compare-and-swap (CORR-D81-4)
  a = await s.ask(batch(docA, 1, [[1, pid(800, Y), [pid(600, X)], "y1"]], { expect_head: { epoch: 1, seq: 1 } }));
  ok(a?.t === "error" && a.code === "conflict" && a.detail.head.seq === 2, "expect_head behind the head is a conflict");
  a = await s.ask(batch(docA, 1, [[1, pid(800, Y), [pid(600, X)], "y1"]], { expect_head: { epoch: 1, seq: 2 } }));
  ok(a?.batch?.seq === 3, "expect_head at the head commits");
  a = await s.ask(batch(docA, 1, [[1, pid(800, Y), [pid(600, X)], "y1"]], { expect_head: { epoch: 1, seq: 2 } }));
  ok(a?.batch?.new === 0 && a.batch.resent[pid(800, Y)] === 3, "the same write resent after a lost answer gets its seq, not a conflict");
  // a patchflow client belongs to one writer
  const s2 = await socket(sa);
  await hello(s2, dev2);
  a = await s2.ask(batch(docA, 1, [[2, pid(900, Y), [pid(800, Y)]]]));
  ok(a?.t === "error" && a.code === "forbidden", "another device can't write as a client that isn't its own");
  // another device is told of a change
  const changed = s2.next((m) => m.t === "changed");
  a = await s.ask(batch(docA, 1, [[2, pid(900, Y), [pid(800, Y)], "y2"]]));
  const ch = await changed;
  ok(ch?.doc === docA && ch.head.seq === 4 && ch.by_device === dev1, "the account's other sockets hear `changed`");
  // pull's bounds
  p = await s.ask({ t: "pull", doc: docA, epoch: 1, after: 0, limit: 2 });
  ok(p?.items.length === 2 && p.more === true, "pull pages with `more`");
  p = await s.ask({ t: "pull", doc: docA, epoch: 1, after: 0, limit: 10_000 });
  ok(p?.items.length === 4 && p.more === false, "a limit over the maximum is the maximum");
  s.ws.close();
  s2.ws.close();
}

// ---- isolation (§2)
{
  const s = await socket(sb);
  await hello(s, "device-b-000001");
  let a = await s.ask({ t: "pull", doc: docA, epoch: 1, after: 0 });
  ok(a?.t === "error" && a.code === "unknown_doc", "another account can't pull A's document by its id");
  a = await s.ask(batch(docA, 1, [[1, pid(100, "clientBBBB"), [], "b"]], { kind: "board" }));
  ok(a?.t === "ack" && a.batch.seq === 1, "the same id in another account is another document");
  a = await s.ask({ ...batch(docA, 1, [[2, pid(200, "clientBBBB"), [pid(100, "clientBBBB")]]]), owner: "a".repeat(64) });
  ok(a?.t === "error" && a.code === "unknown_doc", "naming another owner reaches nothing");
  s.ws.close();
}

// ---- the epoch: clear history keeps the document (§4.6, CORR-D81-6)
{
  const s = await socket(sa);
  await hello(s, dev1);
  const R = "clientROOT";
  let a = await s.ask({ t: "clear", doc: docA, expect_head: { epoch: 1, seq: 3 }, root: { patches: [{ cseq: 1, id: pid(1000, R), parents: [], size: 4 }], body: Buffer.from("root").toString("base64") } });
  ok(a?.t === "error" && a.code === "conflict", "clear with a stale expect_head is refused");
  a = await s.ask({ t: "clear", doc: docA, expect_head: { epoch: 1, seq: 4 }, root: { patches: [{ cseq: 1, id: pid(1000, R), parents: [pid(900, "clientYYYY")], size: 4 }], body: Buffer.from("root").toString("base64") } });
  ok(a?.t === "error" && a.code === "invalid", "the root has no parents");
  a = await s.ask({ t: "clear", doc: docA, expect_head: { epoch: 1, seq: 4 }, root: { patches: [{ cseq: 1, id: pid(1000, R), parents: [], size: 4 }], body: Buffer.from("root").toString("base64") } });
  ok(a?.t === "ack" && a.batch.head.epoch === 2 && a.batch.seq === 5, "clear: a new epoch, whose first batch is the root");
  s.ws.close();
  // a fresh device, at once
  const f = await socket(sa);
  await hello(f, "device-fresh-01");
  let p = await f.ask({ t: "pull", doc: docA, epoch: 1, after: 0 });
  ok(p?.t === "error" && p.code === "epoch" && p.detail.epoch === 2, "the old epoch can't be pulled");
  p = await f.ask({ t: "pull", doc: docA, epoch: 2, after: 0 });
  ok(p?.items.length === 1 && payloads(p.items[0])[0] === "root", "a fresh device opens the document from its root");
  a = await f.ask(batch(docA, 1, [[3, pid(1100, "clientXXXX"), []]]));
  ok(a?.t === "error" && a.code === "epoch", "a batch of the old epoch is refused, so the old history can't come back");
  a = await f.ask(batch(docA, 2, [[1, pid(1200, "clientNEW1"), [pid(1000, R)], "rebased"]]));
  ok(a?.batch?.seq === 6, "the new epoch takes patches on the root");
  f.ws.close();
}

// ---- the access list, behind the owner-qualified name (§2): a document object refuses an account not on it
{
  const ns = await mf.getDurableObjectNamespace("SYNC_DOC", "sync");
  const { createHash } = await import("node:crypto");
  const hashA = createHash("sha256").update("sagebrush-account\n" + A).digest("hex");
  const doc = ns.get(ns.idFromName(`doc:${hashA}:${docA}`));
  const r = await doc.pull({ account: B, epoch: 2, after: 0 });
  ok(r?.error?.code === "unknown_doc", "the document object itself refuses an account not on its access list, as if it didn't exist");
  const w = await doc.batch({ account: B, writer: "session:x", author: "person", device: "x", pin_expires: Date.now() + 60_000, batch: { doc: docA, epoch: 2, patches: [{ cseq: 1, id: pid(5000, "clientEVIL"), parents: [], size: 1 }], body: new Uint8Array([1]) } });
  ok(w?.error?.code === "unknown_doc", "and its writes");
  const own = await doc.pull({ account: A, epoch: 2, after: 0 });
  ok(own?.ok?.items?.length === 2, "while its owner reads it");
  const late = await doc.batch({ account: A, writer: "session:" + dev1, author: "person", device: dev1, pin_expires: Date.now() - 1, batch: { doc: docA, epoch: 2, patches: [{ cseq: 1, id: pid(5000, "clientLATE"), parents: [], size: 1 }], body: new Uint8Array([1]) } });
  ok(late?.error?.code === "busy", "a forward past its pin_expires is refused (§4.3)");
}

await mf.dispose();
console.log(`${count - failures}/${count} passed`);
process.exit(failures ? 1 : 0);
