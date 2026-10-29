// The open reference server (reference-server.ts) against the protocol it
// models: slice 1's account socket, and slice 2's claims and fences
// (plan-sync-slice2-r9.md §5.8's shared vectors), batches with recv and chain
// (§5.1), pull upto (§5.5) and clear's root (plan-sync-slice2-2b-r4 §2.4).
// In memory, no browser, a few seconds.
//   bun web/sync-protocol/test-reference-server.mjs
import { ReferenceServer, SESSION_COOKIE } from "./reference-server.ts";
import { batchHash, chainNext, chainStartAt, hex, verifyChain, verifyChainPage, fromHex, shapeMismatch } from "./doc-protocol.ts";
import { toB64 } from "./protocol.ts";
import { readFileSync } from "node:fs";

let checks = 0;
const fails = [];
let lastCheck = "";
const check = (ok, what) => { checks++; lastCheck = what; if (!ok) fails.push(what); };
const J = JSON.stringify;
const DOC = "0123456789ab";

// ---- a page's side of the server

async function signedIn(server, account) {
  const cookie = `${SESSION_COOKIE}=${server.signIn(account)}`;
  const call = (method, path, body, headers = {}) =>
    server.fetch(new Request("https://ref.test" + path, { method, headers: { cookie, ...(body !== undefined && !(body instanceof Uint8Array) ? { "content-type": "application/json" } : {}), ...headers }, body: body === undefined ? undefined : body instanceof Uint8Array ? body : J(body) }));
  return { cookie, call, account };
}
async function socket(server, who, device) {
  const s = await server.connect(who.cookie);
  if (!s.send) throw new Error("connect refused: " + J(s));
  const got = [], waiters = [];
  s.onmessage = (text) => {
    const m = JSON.parse(text);
    got.push(m);
    for (const w of [...waiters]) if (w.pred(m)) { waiters.splice(waiters.indexOf(w), 1); w.ok(m); }
  };
  let closed = null;
  s.onclose = (code) => { closed = code; };
  let req = 0;
  const next = (pred, ms = 2000, what = "a message") => {
    const had = got.find(pred);
    if (had) { got.splice(got.indexOf(had), 1); return Promise.resolve(had); }
    return new Promise((ok, no) => {
      const w = { pred: (m) => { if (!pred(m)) return false; got.splice(got.indexOf(m), 1); return true; }, ok };
      waiters.push(w);
      setTimeout(() => { if (waiters.includes(w)) { waiters.splice(waiters.indexOf(w), 1); no(new Error("after check \"" + lastCheck.slice(0, 80) + "\": no answer in time to " + what + "; got " + J(got.map((m) => [m.t, m.req, m.code])))); } }, ms);
    });
  };
  const ask = async (m) => {
    const r = ++req;
    s.send(J({ ...m, req: r }));
    return next((x) => x.req === r, 2000, J({ t: m.t, req: r }));
  };
  const tell = (m) => { const r = ++req; s.send(J({ ...m, req: r })); return r; };
  if (device) {
    s.send(J({ t: "hello", v: 1, device, name: device, index_after: 0 }));
    await next((m) => m.t === "welcome");
    await next((m) => m.t === "index");
  }
  return { s, ask, tell, next, got, closed: () => closed };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- patches: patchflow ids (11 base-36 characters of time, "_", the client), payloads JSON

const pid = (n, client) => n.toString(36).padStart(11, "0") + "_" + client;
function patches(list, payload = (p) => ({ patch: [p.id], userId: 0 })) {
  const payloads = list.map((p) => new TextEncoder().encode(J(payload(p))));
  const body = new Uint8Array(payloads.reduce((n, x) => n + x.length, 0));
  let at = 0;
  for (const x of payloads) { body.set(x, at); at += x.length; }
  return { patches: list.map((p, i) => ({ cseq: p.cseq, id: p.id, parents: p.parents ?? [], size: payloads[i].length })), body: toB64(body) };
}
const batch = (doc, epoch, fgen, list, extra = {}) => ({ t: "batch", doc, epoch, fgen, ...patches(list), ...extra });

const server = new ReferenceServer();
const A = await signedIn(server, "acct-a");
// (a throw or a stall anywhere below is a failure of the check after the last one passed, never a crash)
try {

// ---- HTTP: status, enable, the binding

{
  const st = await (await A.call("GET", "/api/sync/v1/status")).json();
  check(st.available === true && st.state === "off" && /^[0-9a-f]{64}$/.test(st.account), "status before enable: available, off, the account's hash: " + J(st));
  const en = await (await A.call("POST", "/api/sync/v1/enable")).json();
  check(en.state === "active" && en.generation === 1, "enable: active, generation 1: " + J(en));
  A.hash = st.account;
  const anon = await server.fetch(new Request("https://ref.test/api/sync/v1/status"));
  check(anon.status === 401, "no session: 401");
  const wrong = await A.call("POST", "/api/sync/v1/blobs/check", { blobs: [] }, { "x-sync-generation": "7" });
  check(wrong.status === 409 && (await wrong.json()).reason === "generation", "a blob request bound to another generation: conflict, reason generation");
}

// ---- slice 1: hello, ops decided once each, the index, index_changed to the other sockets only

{
  const a1 = await socket(server, A, "devA0001"), a2 = await socket(server, A, "devA0002");
  const mk = (dseq, path) => ({ dseq, t: Date.now(), by: "person", op: "mkdir", path, kind: "folder" });
  const r1 = await a1.ask({ t: "ops", ops: [mk(1, "/x"), mk(2, "/y")] });
  check(J(r1.ops) === J([{ dseq: 1, seq: 1 }, { dseq: 2, seq: 2 }]), "ops: two accepted, seqs 1 and 2: " + J(r1.ops));
  const n = await a2.next((m) => m.t === "index_changed");
  check(n.head === 2, "index_changed to the other socket, with the head: " + J(n));
  await sleep(20);
  check(!a1.got.some((m) => m.t === "index_changed"), "index_changed: not to the sender");
  const again = await a1.ask({ t: "ops", ops: [mk(1, "/x"), mk(2, "/y")] });
  check(J(again.ops) === J(r1.ops), "ops resent: the same answers");
  const gap = await a1.ask({ t: "ops", ops: [mk(4, "/z")] });
  check(gap.t === "error" && gap.code === "order" && gap.detail.next_dseq === 3, "ops with a gap: order, next_dseq 3: " + J(gap));
  const bad = await a1.ask({ t: "ops", ops: [{ ...mk(3, "/z"), by: "agent:x", op: "forget" }] });
  check(bad.ops?.[0]?.code === "forbidden", "a person-only op from an agent: refused, forbidden, kept: " + J(bad));
  const bad2 = await a1.ask({ t: "ops", ops: [{ ...mk(3, "/z"), by: "agent:x", op: "forget" }, mk(4, "/w")] });
  check(bad2.ops?.[0]?.code === "forbidden" && bad2.ops?.[1]?.seq === 3, "a refused op stays refused on resend; the next is accepted: " + J(bad2));
  const idx = await a1.ask({ t: "pull_index", after: 1 });
  check(idx.t === "index" && J(idx.ops.map((o) => o.seq)) === J([2, 3]) && idx.more === false, "pull_index after 1: seqs 2 and 3: " + J(idx.ops.map((o) => o.seq)));
  const s3 = await socket(server, A, null);
  s3.s.send(J({ t: "hello", v: 1, device: "devA0003", name: "x", index_after: 0, account: "f".repeat(64) }));
  const ref = await s3.next((m) => m.t === "error");
  check(ref.code === "forbidden" && ref.detail.reason === "account", "hello bound to another account: forbidden, reason account");
  const early = await s3.ask({ t: "pull_index", after: 0 });
  check(early.code === "invalid", "a message before hello: invalid");
  for (const x of [a1, a2, s3]) x.s.close();
}

// ---- slice 2: claims and fences (r9 §5.8's shared vectors)

const a = await socket(server, A, "devA0010"), b = await socket(server, A, "devA0011"), watcher = await socket(server, A, "devA0012");
const C1 = "clientA1", C2 = "clientB1";
{
  // (a first-ever client: no batch before its claim; the claim makes the document)
  const before = await a.ask(batch(DOC, 1, { [C1]: 0 }, [{ cseq: 1, id: pid(1, C1) }]));
  check(before.code === "unknown_client", "a batch before its client's claim: unknown_client: " + J(before));
  check(server.controls.doc(A.account, DOC) === null, "…and it stored nothing (no document)");
  // (a lost claim answer: the claim resent gets the same answer)
  server.controls.fake("doc_claim", { drop: true });
  const lostR = a.tell({ t: "doc_claim", epoch: 1, doc: DOC, client: C1 });
  await sleep(30);
  check(!a.got.some((m) => m.req === lostR), "the claim's answer lost (test control)");
  const claim = await a.ask({ t: "doc_claim", epoch: 1, doc: DOC, client: C1 });
  check(J(claim.claim) === J({ client: C1, fgen: 0, next_cseq: 1 }), "a resent claim: the same answer, fgen 0, next_cseq 1: " + J(claim));
  const foreign = await b.ask({ t: "doc_claim", epoch: 1, doc: DOC, client: C1 });
  check(foreign.code === "forbidden", "another writer's claim of the client: forbidden");
  const r = await a.ask(batch(DOC, 1, { [C1]: 0 }, [{ cseq: 1, id: pid(1, C1) }], { kind: "notebook" }));
  check(r.batch?.seq === 1 && r.batch.new === 1 && r.batch.head.epoch === 1 && r.batch.head.seq === 1 && /^[0-9a-f]{64}$/.test(r.batch.head.chain), "the claimed client's first batch: seq 1, the head with its chain: " + J(r));
  const ch = await watcher.next((m) => m.t === "changed" && m.doc === DOC);
  check(ch.head.seq === 1 && ch.by_device === "devA0010" && ch.owner === A.hash, "changed to the other sockets, with the head and the device: " + J(ch));
  const fb = await b.ask(batch(DOC, 1, { [C1]: 0 }, [{ cseq: 2, id: pid(2, C1), parents: [pid(1, C1)] }]));
  check(fb.code === "forbidden", "another writer's batch for the client: forbidden");
  const ff = await b.ask({ t: "doc_fence", epoch: 1, doc: DOC, clients: [{ client: C1, target: 1 }] });
  check(ff.code === "forbidden", "another writer's fence of the client: forbidden");
  const absent = await a.ask({ t: "doc_fence", epoch: 1, doc: DOC, clients: [{ client: "neverClaimed", target: 1 }] });
  check(J(absent.fence) === J({ clients: [{ client: "neverClaimed", absent: true }] }), "a fence of a client never claimed: absent, terminal: " + J(absent));
}
{
  // (a lost fence answer: resent with the same target, the same terminal answer, nothing raised further)
  server.controls.fake("doc_fence", { drop: true });
  a.tell({ t: "doc_fence", epoch: 1, doc: DOC, clients: [{ client: C1, target: 1 }] });
  await sleep(30);
  const f = await a.ask({ t: "doc_fence", epoch: 1, doc: DOC, clients: [{ client: C1, target: 1 }] });
  check(J(f.fence.clients) === J([{ client: C1, fgen: 1, next_cseq: 2 }]), "a resent fence: fgen 1, next_cseq 2 (terminal): " + J(f));
  check(server.controls.clients(A.account, DOC)[C1].fgen === 1, "…the stored fgen is 1, not 2");
  // (a mixed resend under the old fgen: the accepted patch answered with its seq, the new one refused whole)
  const mixed = await a.ask(batch(DOC, 1, { [C1]: 0 }, [{ cseq: 1, id: pid(1, C1) }, { cseq: 2, id: pid(2, C1), parents: [pid(1, C1)] }]));
  check(mixed.code === "fenced" && mixed.detail.fgen === 1 && mixed.detail.next_cseq === 2, "accepted + new under the old fgen: fenced, whole: " + J(mixed));
  const resend = await a.ask(batch(DOC, 1, { [C1]: 0 }, [{ cseq: 1, id: pid(1, C1) }]));
  check(resend.batch?.new === 0 && resend.batch.resent[pid(1, C1)] === 1, "an accepted patch resent under the old fgen: answered with its original seq: " + J(resend));
  const ok = await a.ask(batch(DOC, 1, { [C1]: 1 }, [{ cseq: 1, id: pid(1, C1) }, { cseq: 2, id: pid(2, C1), parents: [pid(1, C1)] }]));
  check(ok.batch?.seq === 2 && ok.batch.new === 1 && ok.batch.resent[pid(1, C1)] === 1, "the same under the new fgen: the new one stored at seq 2: " + J(ok));
  const ahead = await a.ask(batch(DOC, 1, { [C1]: 5 }, [{ cseq: 3, id: pid(3, C1), parents: [pid(2, C1)] }]));
  check(ahead.code === "invalid", "an fgen the server never gave: invalid");
}
{
  // (a forward paused before its commit, a fence meanwhile: the fence's answer is terminal, the forward refused)
  await a.ask({ t: "doc_claim", epoch: 1, doc: DOC, client: C2 });
  const release = server.controls.holdForward(DOC, C2);
  const req = a.tell(batch(DOC, 1, { [C2]: 0 }, [{ cseq: 1, id: pid(10, C2) }]));
  await sleep(20);
  const f = await a.ask({ t: "doc_fence", epoch: 1, doc: DOC, clients: [{ client: C2, target: 1 }] });
  check(J(f.fence.clients) === J([{ client: C2, fgen: 1, next_cseq: 1 }]), "a fence while the forward is held: next_cseq 1 (nothing committed): " + J(f));
  release();
  const late = await a.next((m) => m.req === req);
  check(late.code === "fenced", "the held forward, released after the fence: fenced, never committed: " + J(late));
  check(server.controls.clients(A.account, DOC)[C2].next_cseq === 1, "…next_cseq still 1");
  // (the same held, the fence after the commit: the fence reports it accepted)
  const rel2 = server.controls.holdForward(DOC, C2);
  const req2 = a.tell(batch(DOC, 1, { [C2]: 1 }, [{ cseq: 1, id: pid(11, C2) }]));
  await sleep(20);
  rel2();
  const done = await a.next((m) => m.req === req2);
  const f2 = await a.ask({ t: "doc_fence", epoch: 1, doc: DOC, clients: [{ client: C2, target: 2 }] });
  check(done.batch?.new === 1 && f2.fence.clients[0].next_cseq === 2, "a forward committed before the fence: the fence says next_cseq 2: " + J({ done, f2 }));
}
{
  // (unused claims: at most 16 per writer per document)
  let last;
  for (let i = 0; i < 17; i++) last = await b.ask({ t: "doc_claim", epoch: 1, doc: DOC, client: "unused" + i });
  check(last.code === "limit" && last.detail.limit === "unused_claims", "the 17th unused claim: limit: " + J(last));
}

// ---- recv and the chain (r9 §5.1), pull upto (§5.5)

{
  server.controls.setNow(Date.now() - 3_600_000);
  const back = await a.ask(batch(DOC, 1, { [C1]: 1 }, [{ cseq: 3, id: pid(3, C1), parents: [pid(2, C1)] }]));
  server.controls.setNow(null);
  const pulled = await a.ask({ t: "pull", doc: DOC, epoch: 1, after: 0 });
  const items = pulled.items;
  check(pulled.t === "batches" && pulled.head.seq === back.batch.seq && items.length === back.batch.seq, "pull from 0: every batch: " + items.length);
  check(items.every((x, i) => i === 0 || x.recv >= items[i - 1].recv), "recv never goes back, even with the clock set back an hour: " + J(items.map((x) => x.recv)));
  const asChained = (x) => ({ seq: x.seq, recv: x.recv, epoch: 1, author: x.author, writer: x.writer, envs: J(x.patches), body: Uint8Array.from(atob(x.body), (c) => c.charCodeAt(0)), chain: x.chain });
  const v = verifyChain({ ownerHash: A.hash, doc: DOC, epoch: 1, upto: items.length, expect: pulled.head.chain }, items.map(asChained));
  check(v.ok, "the chain a client recomputes equals the server's, batch by batch and at the head: " + J(v));
  const upto = await a.ask({ t: "pull", doc: DOC, epoch: 1, after: 0, upto: 1 });
  check(upto.items.length === 1 && upto.items[0].seq === 1, "pull upto 1: batch 1 only");
  const past = await a.ask({ t: "pull", doc: DOC, epoch: 1, after: 0, upto: 99 });
  check(past.code === "invalid", "pull upto past the head: invalid");
  const old = await a.ask({ t: "pull", doc: DOC, epoch: 9, after: 0 });
  check(old.code === "epoch" && old.detail.epoch === 1, "pull in another epoch: epoch, with the current one");
  const cas = await a.ask(batch(DOC, 1, { [C1]: 1 }, [{ cseq: 4, id: pid(4, C1), parents: [pid(3, C1)] }], { expect_head: { epoch: 1, seq: 1 } }));
  check(cas.code === "conflict" && cas.detail.head.seq === back.batch.seq, "expect_head that isn't the head: conflict, with the head");
  const gap = await a.ask(batch(DOC, 1, { [C1]: 1 }, [{ cseq: 9, id: pid(9, C1), parents: [pid(3, C1)] }]));
  check(gap.code === "order" && gap.detail.next_cseq === 4, "a cseq gap: order, next_cseq 4");
  const reuse = await a.ask(batch(DOC, 1, { [C1]: 1 }, [{ cseq: 2, id: pid(7, C1), parents: [pid(1, C1)] }]));
  check(reuse.code === "conflict", "a cseq reused for another patch: conflict");
  const orphan = await a.ask(batch(DOC, 1, { [C1]: 1 }, [{ cseq: 4, id: pid(5, C1), parents: [pid(99, "nobody")] }]));
  check(orphan.code === "order", "a parent never accepted: order");
}

// ---- clear (plan-sync-slice2-2b-r4 §2.4): the root bootstraps its client's row in the new epoch

{
  const before = server.controls.doc(A.account, DOC);
  const head = { epoch: 1, seq: before.head };
  const root = patches([{ cseq: 4, id: pid(20, C1) }]);
  const stale = await a.ask({ t: "clear", doc: DOC, expect_head: { epoch: 1, seq: 1 }, root, fgen: { [C1]: 1 } });
  check(stale.code === "conflict", "clear with a stale expect_head: conflict, nothing changed");
  const cl = await a.ask({ t: "clear", doc: DOC, expect_head: head, root, fgen: { [C1]: 1 } });
  check(cl.batch?.head.epoch === 2 && cl.batch.seq === before.seq + 1 && cl.batch.head.seq === cl.batch.seq, "clear: epoch 2, the root at the next seq (never reused): " + J(cl));
  const cs = server.controls.clients(A.account, DOC);
  check(J(Object.keys(cs)) === J([C1]) && cs[C1].next_cseq === 5 && cs[C1].fgen === 1, "the new epoch has the root's client only, next_cseq 5, fgen carried: " + J(cs));
  const again = await a.ask({ t: "clear", doc: DOC, expect_head: head, root, fgen: { [C1]: 1 } });
  check(again.batch?.seq === cl.batch.seq && again.batch.new === 0, "the same clear resent (a lost answer): the same result: " + J(again));
  const unknown = await a.ask(batch(DOC, 2, { [C2]: 2 }, [{ cseq: 2, id: pid(30, C2) }]));
  check(unknown.code === "unknown_client", "an old epoch's client in the new epoch, unclaimed: unknown_client");
  const oldEpoch = await a.ask(batch(DOC, 1, { [C1]: 1 }, [{ cseq: 5, id: pid(31, C1), parents: [pid(20, C1)] }]));
  check(oldEpoch.code === "epoch" && oldEpoch.detail.epoch === 2, "a batch in the old epoch: epoch");
  const next = await a.ask(batch(DOC, 2, { [C1]: 1 }, [{ cseq: 5, id: pid(32, C1), parents: [pid(20, C1)] }]));
  const pulled = await a.ask({ t: "pull", doc: DOC, epoch: 2, after: 0 });
  const chained = pulled.items.map((x) => ({ seq: x.seq, recv: x.recv, epoch: 2, author: x.author, writer: x.writer, envs: J(x.patches), body: Uint8Array.from(atob(x.body), (c) => c.charCodeAt(0)), chain: x.chain }));
  const v = verifyChainPage({ epoch: 2 }, chainStartAt(A.hash, DOC, 2, cl.batch.seq), chained);
  check(next.batch?.new === 1 && v.ok && hex(v.state.chain) === pulled.head.chain, "the new epoch's chain, from chainStartAt(root.seq), equals the server's: " + J({ ok: v.ok }));
}

// ---- blobs, and ops naming them

{
  const bytes = new TextEncoder().encode("hello, blob");
  const sha = hex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
  const miss = await (await A.call("POST", "/api/sync/v1/blobs/check", { blobs: [{ sha256: sha, size: bytes.length }] })).json();
  check(J(miss.missing) === J([sha]), "blobs/check: missing before the PUT");
  const o1 = await socket(server, A, "devA0020");
  const op = { dseq: 1, t: Date.now(), by: "person", op: "create", path: "/f.txt", kind: "file", fid: "00000000000000f1", sha256: sha, size: bytes.length };
  const early = await o1.ask({ t: "ops", ops: [op] });
  check(early.ops?.[0]?.code === "missing", "an op naming bytes not uploaded: refused, missing");
  const put = await A.call("PUT", "/api/sync/v1/blob/" + sha, bytes, { "content-length": String(bytes.length) });
  check(put.status === 200, "PUT the blob: 200");
  const wrong = await A.call("PUT", "/api/sync/v1/blob/" + "0".repeat(64), bytes, { "content-length": String(bytes.length) });
  check(wrong.status === 400, "PUT bytes under another sha256: 400");
  const get = await A.call("GET", "/api/sync/v1/blob/" + sha);
  const loc = get.headers.get("location");
  const file = await server.fetch(new Request(loc));
  check(get.status === 303 && new TextDecoder().decode(await file.arrayBuffer()) === "hello, blob", "GET the blob: 303 to its bytes");
  const later = await o1.ask({ t: "ops", ops: [{ ...op, dseq: 2 }] });
  check(typeof later.ops?.[0]?.seq === "number", "the same op after the PUT: accepted");
  o1.s.close();
}

// ---- revocation and deletion

{
  const r = await socket(server, A, "devA0030");
  const session = A.cookie.split("=")[1];
  const other = await signedIn(server, "acct-a");
  const keep = await socket(server, other, "devA0031");
  server.controls.revoke(session);
  await r.next((m) => m.t === "revoked");
  await sleep(10);
  check(r.closed() === 4401, "a revoked session: revoked, then close 4401");
  const del = await other.call("POST", "/api/sync/v1/delete", { confirm: "delete", generation: 1 });
  check(del.status === 202 && (await del.json()).state === "deleting", "delete: 202, deleting");
  const e = await keep.next((m) => m.t === "error" && m.code === "deleting");
  await sleep(10);
  check(e && keep.closed() === 4410, "a socket during the deletion: deleting, then close 4410");
  const st = await (await other.call("GET", "/api/sync/v1/status")).json();
  const en = await (await other.call("POST", "/api/sync/v1/enable")).json();
  check(st.state === "off" && en.generation === 2, "after the deletion: off; enabled again, generation 2: " + J({ st, en }));
}

  // ---- #173's review: one regression for each finding (astra's CORR-173-1..5, daybreak3's UTF-8 page bytes)

  {
  // (their own account: the suite's first one was revoked and deleted above)
  const A = await signedIn(server, "acct-r");
  await A.call("POST", "/api/sync/v1/enable");
  const a = await socket(server, A, "devR0001"), b = await socket(server, A, "devR0002");
  {
    // CORR-173-1: a resent clear is the stored root exactly; a changed cseq or another writer is refused, nothing changes
    const D2 = "0123456789cd";
    await a.ask({ t: "doc_claim", epoch: 1, doc: D2, client: "rc1" });
    await a.ask(batch(D2, 1, { rc1: 0 }, [{ cseq: 1, id: pid(1, "rc1") }]));
    const root = patches([{ cseq: 2, id: pid(2, "rc1") }]);
    const cl = await a.ask({ t: "clear", doc: D2, expect_head: { epoch: 1, seq: 1 }, root, fgen: { rc1: 0 } });
    const before = J(server.controls.doc(A.account, D2)), clientsBefore = J(server.controls.clients(A.account, D2));
    const changed = await a.ask({ t: "clear", doc: D2, expect_head: { epoch: 1, seq: 1 }, root: patches([{ cseq: 99, id: pid(2, "rc1") }]), fgen: { rc1: 0 } });
    check(changed.code === "conflict", "CORR-173-1: a resent clear with the root's id and another cseq: conflict: " + J(changed));
    const foreignRetry = await b.ask({ t: "clear", doc: D2, expect_head: { epoch: 1, seq: 1 }, root, fgen: { rc1: 0 } });
    check(foreignRetry.code === "forbidden", "CORR-173-1: the same root resent by another writer: forbidden: " + J(foreignRetry));
    check(J(server.controls.doc(A.account, D2)) === before && J(server.controls.clients(A.account, D2)) === clientsBefore, "CORR-173-1: …head, batches and clients unchanged");
    // (the accepted resend still answers after a later fence: its old fgen isn't asked again)
    await a.ask({ t: "doc_fence", doc: D2, epoch: 2, clients: [{ client: "rc1", target: 1 }] });
    const exact = await a.ask({ t: "clear", doc: D2, expect_head: { epoch: 1, seq: 1 }, root, fgen: { rc1: 0 } });
    check(exact.batch?.seq === cl.batch.seq && exact.batch.new === 0, "CORR-173-1: the exact root resent, after a fence: the same answer: " + J(exact));
  }
  {
    // CORR-173-2: a new patch's blobs must be held; refused whole (missing) with nothing changed, accepted once uploaded
    const D3 = "0123456789ef";
    const bytes = new TextEncoder().encode("a patch's blob"), sha = hex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
    await a.ask({ t: "doc_claim", epoch: 1, doc: D3, client: "bc1" });
    await a.ask(batch(D3, 1, { bc1: 0 }, [{ cseq: 1, id: pid(1, "bc1") }]));
    const withBlob = (list) => {
      const m = batch(D3, 1, { bc1: 0 }, list);
      m.patches = m.patches.map((e, i) => (list[i].blob ? { ...e, blobs: [sha] } : e));
      return m;
    };
    const head0 = J(server.controls.doc(A.account, D3)), cl0 = J(server.controls.clients(A.account, D3));
    const miss = await a.ask(withBlob([{ cseq: 1, id: pid(1, "bc1") }, { cseq: 2, id: pid(2, "bc1"), parents: [pid(1, "bc1")], blob: true }]));
    check(miss.code === "missing" && miss.detail.sha256 === sha, "CORR-173-2: an accepted + new batch whose new patch names a blob not held: missing, whole: " + J(miss));
    check(J(server.controls.doc(A.account, D3)) === head0 && J(server.controls.clients(A.account, D3)) === cl0, "CORR-173-2: …head and clients unchanged");
    const resendOnly = await a.ask(withBlob([{ cseq: 1, id: pid(1, "bc1") }]));
    check(resendOnly.batch?.new === 0 && resendOnly.batch.resent[pid(1, "bc1")] === 1, "CORR-173-2: the accepted patch alone still answered with its seq");
    await A.call("PUT", "/api/sync/v1/blob/" + sha, bytes, { "content-length": String(bytes.length) });
    const ok = await a.ask(withBlob([{ cseq: 1, id: pid(1, "bc1") }, { cseq: 2, id: pid(2, "bc1"), parents: [pid(1, "bc1")], blob: true }]));
    check(ok.batch?.new === 1 && ok.batch.seq === 2, "CORR-173-2: after the upload, the same batch is stored: " + J(ok));
    const rootMiss = await a.ask({ t: "clear", doc: D3, expect_head: { epoch: 1, seq: 2 }, root: (() => { const r = patches([{ cseq: 3, id: pid(3, "bc1") }]); r.patches[0].blobs = ["e".repeat(64)]; return r; })(), fgen: { bc1: 0 } });
    check(rootMiss.code === "missing", "CORR-173-2: a clear root naming a blob not held: missing");
  }
  }
  {
    // CORR-173-3: a PUT bound to generation 1, its body paused across a delete and a re-enable, doesn't land in generation 2
    const P = await signedIn(server, "acct-put");
    await P.call("POST", "/api/sync/v1/enable");
    const bytes = new TextEncoder().encode("late bytes"), sha = hex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
    let push;
    const body = new ReadableStream({ start(c) { push = () => { c.enqueue(bytes); c.close(); }; } });
    const put = server.fetch(new Request("https://ref.test/api/sync/v1/blob/" + sha, { method: "PUT", body, duplex: "half", headers: { cookie: P.cookie, "content-length": String(bytes.length), "x-sync-generation": "1" } }));
    await sleep(20);
    await P.call("POST", "/api/sync/v1/delete", { confirm: "delete", generation: 1 });
    const en = await (await P.call("POST", "/api/sync/v1/enable")).json();
    push();
    const r = await put;
    check(en.generation === 2 && r.status === 409 && (await r.json()).reason === "generation", "CORR-173-3: the paused PUT, completed in generation 2: 409, reason generation");
    const chk = await (await P.call("POST", "/api/sync/v1/blobs/check", { blobs: [{ sha256: sha, size: bytes.length }] })).json();
    check(J(chk.missing) === J([sha]), "CORR-173-3: …and generation 2 doesn't hold the bytes");
    // (the held forward's audit: a batch held across a delete and a re-enable doesn't commit into the new generation)
    const Q = await signedIn(server, "acct-held");
    await Q.call("POST", "/api/sync/v1/enable");
    const q = await socket(server, Q, "devQ0001");
    await q.ask({ t: "doc_claim", epoch: 1, doc: DOC, client: "hq1" });
    const release = server.controls.holdForward(DOC, "hq1");
    const req = q.tell(batch(DOC, 1, { hq1: 0 }, [{ cseq: 1, id: pid(1, "hq1") }]));
    await sleep(20);
    await Q.call("POST", "/api/sync/v1/delete", { confirm: "delete", generation: 1 });
    await Q.call("POST", "/api/sync/v1/enable");
    // (a socket of the new generation, there before the release: it must hear nothing of the old forward (astra's r2 probe))
    const q2 = await socket(server, Q, "devQ0002");
    release();
    await sleep(30);
    check(server.controls.doc("acct-held", DOC) === null, "CORR-173-3: a forward held across a delete and a re-enable leaves nothing in the new generation");
    check(!q2.got.some((m) => m.t === "changed"), "CORR-173-3: …and a socket of the new generation hears no changed from it: " + J(q2.got.map((m) => m.t)));
  }
  {
    // CORR-173-4: concurrent first accesses share one account (a socket made while enable runs sees it active)
    const C = await signedIn(server, "acct-concurrent");
    const [sock] = await Promise.all([server.connect(C.cookie), C.call("POST", "/api/sync/v1/enable")]);
    const got = [];
    sock.onmessage = (t) => got.push(JSON.parse(t));
    sock.send(J({ t: "hello", v: 1, device: "devC0001", name: "c", index_after: 0 }));
    await sleep(30);
    check(got[0]?.t === "welcome" && got[0].state === "active" && got[0].generation === 1, "CORR-173-4: the socket made concurrently with enable says hello to the one, active account: " + J(got[0]));
    const other = await socket(server, C, "devC0002");
    sock.send(J({ t: "ops", req: 1, ops: [{ dseq: 1, t: Date.now(), by: "person", op: "mkdir", path: "/c", kind: "folder" }] }));
    const n = await other.next((m) => m.t === "index_changed");
    check(n.head === 1, "CORR-173-4: …and the other socket of the same account sees its op");
  }
  {
    // CORR-173-5: a socket whose session has expired can't write; told revoked, closed 4401, the log unchanged
    const E = { account: "acct-expiry" };
    E.cookie = `${SESSION_COOKIE}=${server.signIn("acct-expiry")}`;
    E.call = (method, path, body) => server.fetch(new Request("https://ref.test" + path, { method, headers: { cookie: E.cookie, "content-type": "application/json" }, body: body === undefined ? undefined : J(body) }));
    await E.call("POST", "/api/sync/v1/enable");
    const e = await socket(server, E, "devE0001");
    server.controls.setNow(Date.now() + 25 * 3600_000);
    const req = e.tell({ t: "ops", ops: [{ dseq: 1, t: Date.now(), by: "person", op: "mkdir", path: "/late", kind: "folder" }] });
    const rv = await e.next((m) => m.t === "revoked");
    await sleep(10);
    server.controls.setNow(null);
    const fresh = await signedIn(server, "acct-expiry");
    const f = await socket(server, fresh, "devE0002");
    const idx = await f.ask({ t: "pull_index", after: 0 });
    check(rv && e.closed() === 4401 && !e.got.some((m) => m.req === req) && idx.ops.length === 0, "CORR-173-5: an expired session's socket: revoked, 4401, no answer, the log unchanged: " + J(idx.ops));
  }
  {
    // daybreak3: the index page's 1 MiB is UTF-8 bytes; 500 ops of 3-byte paths page there, and pull_index returns the rest
    const U = await signedIn(server, "acct-utf8");
    await U.call("POST", "/api/sync/v1/enable");
    const u = await socket(server, U, "devU0001");
    const seg = "中".repeat(250);
    const ops = Array.from({ length: 500 }, (_, i) => ({ dseq: i + 1, t: Date.now(), by: "person", op: "mkdir", path: `/${seg}/${seg}/${seg}/d${String(i).padStart(4, "0")}`, kind: "folder" }));
    const utf16 = ops.reduce((n, o) => n + J(o).length, 0);
    for (let i = 0; i < 500; i += 250) {
      const r = await u.ask({ t: "ops", ops: ops.slice(i, i + 250) });
      check(r.ops?.length === 250 && r.ops.every((x) => typeof x.seq === "number"), "UTF-8 pages: 250 ops accepted");
    }
    const p1 = await u.ask({ t: "pull_index", after: 0 });
    const bytes1 = p1.ops.reduce((n, o) => n + new TextEncoder().encode(J(o)).length, 0);
    check(utf16 < (1 << 20) && p1.more === true && p1.ops.length < 500 && bytes1 <= (1 << 20), `UTF-8 pages: the first page stops at 1 MiB of UTF-8 (${p1.ops.length} ops, ${bytes1} bytes; the 500 are ${utf16} UTF-16 units)`);
    const p2 = await u.ask({ t: "pull_index", after: p1.ops[p1.ops.length - 1].seq });
    check(p1.ops.length + p2.ops.length === 500 && p2.more === false && p2.ops[0].seq === p1.ops[p1.ops.length - 1].seq + 1, `UTF-8 pages: pull_index returns the rest (${p2.ops.length})`);
  }

  {
    // (stale_epoch: a claim or fence for another epoch than the document's is refused, with the current epoch, and changes
    // nothing; the same for a document not made yet, whose epoch is 1; then the current epoch is accepted)
    const SE = await signedIn(server, "acct-stale");
    await SE.call("POST", "/api/sync/v1/enable");
    const s = await socket(server, SE, "devS0001"), DS = "0123456789aa";
    const early = await s.ask({ t: "doc_claim", doc: DS, epoch: 2, client: "s1" });
    check(early.code === "stale_epoch" && early.detail.epoch === 1 && server.controls.doc("acct-stale", DS) === null, "stale_epoch: a claim for epoch 2 of a document not made yet: refused, nothing made: " + J(early));
    await s.ask({ t: "doc_claim", doc: DS, epoch: 1, client: "s1" });
    await s.ask(batch(DS, 1, { s1: 0 }, [{ cseq: 1, id: pid(1, "s1") }]));
    const cl = await s.ask({ t: "clear", doc: DS, expect_head: { epoch: 1, seq: 1 }, root: patches([{ cseq: 2, id: pid(2, "s1") }]), fgen: { s1: 0 } });
    check(cl.batch?.head.epoch === 2, "stale_epoch: the document cleared to epoch 2");
    const before = J(server.controls.clients("acct-stale", DS));
    const late = await s.ask({ t: "doc_claim", doc: DS, epoch: 1, client: "s2" });
    check(late.code === "stale_epoch" && late.detail.epoch === 2 && late.detail.head.epoch === 2, "stale_epoch: a delayed claim for epoch 1, after the clear: refused, with the current epoch: " + J(late));
    const lateFence = await s.ask({ t: "doc_fence", doc: DS, epoch: 1, clients: [{ client: "s1", target: 5 }] });
    check(lateFence.code === "stale_epoch" && J(server.controls.clients("acct-stale", DS)) === before, "stale_epoch: a fence for epoch 1: refused, and no client's fgen moved");
    const ahead = await s.ask({ t: "doc_claim", doc: DS, epoch: 3, client: "s2" });
    check(ahead.code === "stale_epoch" && J(server.controls.clients("acct-stale", DS)) === before, "stale_epoch: a claim for a future epoch: refused too, nothing changed");
    const now = await s.ask({ t: "doc_claim", doc: DS, epoch: 2, client: "s2" });
    const f2 = await s.ask({ t: "doc_fence", doc: DS, epoch: 2, clients: [{ client: "s1", target: 1 }] });
    check(J(now.claim) === J({ client: "s2", fgen: 0, next_cseq: 1 }) && f2.fence?.clients[0].fgen === 1, "stale_epoch: the current epoch's claim and fence are accepted");
  }

  // ---- the shared claim and fence vectors (doc-claim-vectors.json), each on a fresh account

  const V = JSON.parse(readFileSync(new URL("./doc-claim-vectors.json", import.meta.url), "utf8"));
  const short = (n, client) => n.toString(36).padStart(11, "0") + "_" + client;
  const expand = (list) => patches(list.map((p) => ({ cseq: p.cseq, id: short(p.n, p.client), parents: (p.parents ?? []).map(([n, c]) => short(n, c)), patch: undefined, n: p.n })), (p) => ({ n: p.n }));
  const subset = (want, got) => want === null || typeof want !== "object" || Array.isArray(want) ? J(want) === J(got) : got !== null && typeof got === "object" && Object.entries(want).every(([k, v]) => subset(v, got[k]));
  for (const sc of V.scenarios) {
    const srv = new ReferenceServer();
    const who = await signedIn(srv, "acct-v");
    await who.call("POST", "/api/sync/v1/enable");
    const socks = { a: await socket(srv, who, "devV000a"), b: await socket(srv, who, "devV000b") };
    const kept = {};
    let release = null;
    for (const [i, st] of sc.steps.entries()) {
      const at = `vector "${sc.name}" step ${i + 1}`;
      if (st.control === "drop") { srv.controls.fake(st.t, { drop: true }); continue; }
      if (st.control === "hold") { release = srv.controls.holdForward(V.doc, st.client); continue; }
      if (st.control === "release") {
        release();
        const ans = await kept[st.answer];
        check(subset(st.expect, ans), `${at}: ${J(ans)}`);
        continue;
      }
      const m = { ...st.send, doc: V.doc };
      if (m.t === "batch") Object.assign(m, expand(m.patches));
      if (m.t === "clear") m.root = expand(m.root);
      const s = socks[st.from];
      if (st.expect.none) {
        const r = s.tell(m);
        if (st.keep) kept[st.keep] = s.next((x) => x.req === r, 3000, at);
        else {
          await sleep(200);
          check(!s.got.some((x) => x.req === r), `${at}: no answer`);
        }
        continue;
      }
      const ans = await s.ask(m);
      check(subset(st.expect, ans), `${at}: ${J(ans)}`);
    }
  }

// ---- the answers' shapes (doc-vectors.json's `answers`, agreed with cloud's server): each frame this server sends
// for them, matched exactly
{
  const AV = JSON.parse(readFileSync(new URL("./doc-vectors.json", import.meta.url), "utf8")).answers;
  const by = (f, w) => AV.find((x) => x.for === f && x.when.startsWith(w)).shape;
  // (an account of its own: earlier sections end A's session)
  const A9 = await signedIn(server, "acct-answers");
  const en9 = await (await A9.call("POST", "/api/sync/v1/enable")).json();
  check(en9.state === "active", "answers: an account of their own, sync on: " + J(en9));
  const s9 = await socket(server, A9, "devA0099"), D9 = "0123456789ad", C9 = "clientS9";
  const claim = await s9.ask({ t: "doc_claim", epoch: 1, doc: D9, client: C9 });
  check(claim.t === "ack", "answers: the claim: " + J(claim));
  const one = batch(D9, 1, { [C9]: 0 }, [{ cseq: 1, id: pid(1, C9) }], { kind: "notebook" });
  const fresh = await s9.ask(one), again = await s9.ask(one);
  check(shapeMismatch(fresh, by("batch", "a new patch")) === null, "answers: a new batch's ack, as the vector: " + (shapeMismatch(fresh, by("batch", "a new patch")) ?? J(fresh)));
  check(shapeMismatch(again, by("batch", "every patch a resend")) === null, "answers: the same batch again (all resent, no seq), as the vector: " + (shapeMismatch(again, by("batch", "every patch a resend")) ?? J(again)));
  const page = await s9.ask({ t: "pull", doc: D9, epoch: 1, after: 0 });
  check(page.items?.length === 1 && shapeMismatch(page, by("pull", "a page")) === null, "answers: a page, as the vector: " + (shapeMismatch(page, by("pull", "a page")) ?? J(page).slice(0, 200)));
  const eb = await s9.ask(batch(D9, 2, { [C9]: 0 }, [{ cseq: 2, id: pid(2, C9), parents: [pid(1, C9)] }]));
  const ep = await s9.ask({ t: "pull", doc: D9, epoch: 2, after: 0 });
  const ec = await s9.ask({ t: "doc_claim", epoch: 2, doc: D9, client: C9 });
  check(shapeMismatch(eb, by("batch", "another epoch")) === null, "answers: a batch for another epoch, as the vector: " + (shapeMismatch(eb, by("batch", "another epoch")) ?? J(eb)));
  check(shapeMismatch(ep, by("pull", "another epoch")) === null, "answers: a pull for another epoch, as the vector: " + (shapeMismatch(ep, by("pull", "another epoch")) ?? J(ep)));
  check(shapeMismatch(ec, by("doc_claim", "another epoch")) === null, "answers: a claim for another epoch, as the vector: " + (shapeMismatch(ec, by("doc_claim", "another epoch")) ?? J(ec)));
  s9.s.close();
}

} catch (e) {
  fails.push(`stopped after "${lastCheck.slice(0, 80)}": ${e?.message ?? e}`);
}

console.log(fails.length ? `FAIL: ${fails.length} of ${checks} checks\n  ` + fails.join("\n  ") : `${checks}/${checks} passed`);
process.exit(fails.length ? 1 : 0);
