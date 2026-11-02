// The cases of web/history/test-history-d11.mjs, run in the page: a confirmed large move's publication tokens (A1,
// A1.1, A1.3; the grader's rows A1-T1..T17 that need a confirmed replay).  B[name] is a build: "head" (this tree) or
// a mutant (the harness's list), each a whole workspace bundle.  Each scenario seeds a large swap (/a <-> /b, two large
// folders) the way web/workspace/sync-d11-cases.js does, and replays it, snapshotting the tokens at every phase.
const BUILDS = ["head", "noA1", "sepTx", "nullChain", "swallow", "dedupIdent", "oldRev", "republish"];
const B = Object.fromEntries(await Promise.all(BUILDS.map(async (b) => [b, await import(`./ws-${b}.js`)])));
const results = [];
const check = (ok, what) => results.push([!!ok, what]);
const J = JSON.stringify;
const hex = (k) => [...crypto.getRandomValues(new Uint8Array(k / 2))].map((b) => b.toString(16).padStart(2, "0")).join("");
const SHA = (c) => c.repeat(64).slice(0, 64);
const MAX = 2 ** 53 - 1;
let n = 0;
const raw = (db, store) => new Promise((ok, no) => { const r = db.transaction(store).objectStore(store).getAll(); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
const rawGet = (db, store, key) => new Promise((ok, no) => { const r = db.transaction(store).objectStore(store).get(key); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
const rawPut = (db, store, value, key) => new Promise((ok, no) => { const tx = db.transaction(store, "readwrite"); tx.objectStore(store).put(value, key); tx.oncomplete = () => ok(); tx.onerror = () => no(tx.error); });

// ---- raw IDB requests per transaction, counted at the browser's API (A1.3: every store and index request, cursors too)
const probe = { by: new Map() };
for (const P of [IDBObjectStore.prototype, IDBIndex.prototype]) for (const k of ["get", "getAll", "getAllKeys", "getKey", "count", "openCursor", "openKeyCursor", "put", "add", "delete", "clear"]) {
  const f = P[k];
  P[k] = function (...a) {
    const tx = this instanceof IDBIndex ? this.objectStore.transaction : this.transaction, c = probe.by.get(tx);
    if (c) { c.req++; if (k === "get" && (this.name === "hmeta" || this.objectStore?.name === "hmeta")) c.hmetaGets++; }
    return f.apply(this, a);
  };
}

/** A large swap: folders A (/a) and B (/b), 15 files each, confirmed at each other's place. */
function swapSpec() {
  const confirmed = [], local = [], tops = [];
  // (the same identities in every scenario: rows compare one build's run with another's (A1-T5, T13), so an identity
  // must name the same folder or file in both; each scenario has its own databases)
  for (const [name, from, to] of [["A", "/a", "/b"], ["B", "/b", "/a"]]) {
    const f = name.toLowerCase() + "0".repeat(15);
    tops.push(f);
    confirmed.push([f, to, "folder"]);
    local.push([f, from, "folder"]);
    for (let i = 0; i < 15; i++) { const id = name.toLowerCase() + (i + 1).toString(16).padStart(15, "0"); confirmed.push([id, `${to}/${name}${i}.txt`, "file"]); local.push([id, `${from}/${name}${i}.txt`, "file"]); }
  }
  return { confirmed, local, tops };
}

/** One replay of the swap on build W: { snaps, tokens, meta, ops, ids, pub (raw requests of the publishing transaction),
 * ledger (the marker's validation), error }.  opts: active, preset (hmeta values), opsFloor, hook(phase, m, w),
 * cut (a REPLAY.cut point to crash at once, then resume), inject(tx) (called on the publishing transaction). */
async function scenario(W, opts = {}) {
  const SMALL = { ...W.D11, chunk: 10, page: 10, planPage: 100, validatePage: 10, backoffMin: 10, backoffMax: 20, fails: 10, deadlineMs: 900_000 };
  W.configureD11(SMALL);
  localStorage.clear();
  const f = swapSpec();
  const w = await W.Workspace.open({ name: `hd11-${++n}-${hex(6)}`, mainName: `hd11m-${n}` });
  const ns = "c".repeat(32) + ":1:" + w.device;
  const lease = await W.switchTo(w, ns), ob = new W.Outbox(w, lease);
  await ob.begin(await w.lastSeq());
  const gp = W.genPrefix(ns, 0), now = 1_800_000_000_000, pk = (p) => p.slice(0, p.lastIndexOf("/")) || "/";
  const put = (store, rows) => new Promise((ok, no) => { const tx = w.ws.transaction(store, "readwrite"); for (const r of rows) tx.objectStore(store).put(r); tx.oncomplete = ok; tx.onerror = () => no(tx.error); });
  await put("syncIndex", f.confirmed.map(([id, path, kind]) => ({ ns: gp, id, path, key: path.normalize("NFC"), parentKey: pk(path).normalize("NFC"), kind, fid: id, ...(kind === "file" ? { sha256: SHA("a"), size: 3 } : {}), created: now, updated: now, by: "person", seq: 1 })));
  await put("entries", f.local.map(([id, path, kind]) => ({ path, kind, ref: kind === "file" ? path : null, created: now, updated: now, fid: id, ident: id, nkey: pk(path) + "\u0000" + path.slice(path.lastIndexOf("/") + 1).normalize("NFC"), ...(kind === "file" ? { size: 3, rev: 0, migrated: true, sha256: SHA("a"), remote: true } : {}) })));
  if (opts.active) await rawPut(w.ws, "hmeta", true, "hactive");
  for (const [k, v] of Object.entries(opts.preset ?? {})) await rawPut(w.ws, "hmeta", v, k);
  if (opts.opsFloor !== undefined) await rawPut(w.ws, "meta", opts.opsFloor, "opsFloor");
  await new Promise((ok, no) => {
    const tx = w.ws.transaction(["meta", "entries"], "readwrite"), t = Date.now();
    tx.objectStore("meta").put({ gen: gp, rid: "c0ffee00", kind: "debts", ranges: ["/a", "/b"], phase: "pass", start: t, deadline: t + 900_000, times: {} }, W.markerKey(ns));
    tx.objectStore("entries").put({ path: W.RW, rid: "c0ffee00", kind: "reserved", published: false, rev: 1, n: 0, fails: 0, at: t });
    tx.oncomplete = ok; tx.onerror = () => no(tx.error);
  });
  const snaps = [], validates = [];
  let ledger = null, crashed = 0, error = null;
  W.REPLAY.reads = (at, phase, tx) => {
    if (phase !== "validate") return;
    if (at === "begin") { const c = { req: 0, hmetaGets: 0, tx }; validates.push(c); probe.by.set(tx, c); if (opts.inject) opts.inject(tx); }
  };
  W.REPLAY.before = async (phase, m) => {
    if (m.validation) ledger = m.validation;
    if (opts.hook) await opts.hook(phase, m, w);
    const rec = await w.rewriteState();
    snaps.push({ phase, published: !!rec?.published, sweep: rec?.sweep ?? null, tokens: await raw(w.ws, "htokens"), exhausted: (await rawGet(w.ws, "hmeta", "exhausted")) === true });
  };
  if (opts.cut) W.REPLAY.cut = (at) => { if (at === opts.cut && !crashed++) throw new Error(`crash at ${at} (test)`); };
  try {
    try { await W.runReplay(w, ns); }
    catch (e) {
      if (!crashed && !opts.inject) throw e;
      W.REPLAY.reload();
      if (opts.cut) W.REPLAY.cut = opts.cut2 ? (at) => { if (at === opts.cut2 && crashed < 2) { crashed++; throw new Error(`crash at ${at} (test)`); } } : null;
      try { await W.runReplay(w, ns); }
      catch (e2) { W.REPLAY.reload(); W.REPLAY.cut = null; await W.runReplay(w, ns); }
    }
  } catch (e) { error = String(e?.message ?? e); }
  finally { W.REPLAY.before = null; W.REPLAY.cut = null; W.REPLAY.reads = null; probe.by = new Map(); }
  const out = {
    snaps, crashed, error, ledger, tops: f.tops,
    tokens: await raw(w.ws, "htokens"),
    meta: Object.fromEntries(await Promise.all(["hseq", "hcount", "hbytes", "ovf", "exhausted"].map(async (k) => [k, await rawGet(w.ws, "hmeta", k)]))),
    ops: (await w.ops()).filter((o) => o.origin === "server"),
    ids: Object.fromEntries((await raw(w.ws, "entries")).filter((e) => e.ident && e.path.startsWith("/")).map((e) => [e.ident, e.path])),
    pub: validates.at(-1) ?? null,
  };
  w.close();
  return out;
}
const idents = (ts) => ts.map((t) => t.ident);
const set = (xs) => J([...new Set(xs)].sort());
const pubSnap = (r) => r.snaps.find((s) => s.published);
const covered = (s, tops) => s.exhausted || tops.every((t) => idents(s.tokens).includes(t));

// ---- T1: a cut between publication and sweep 2 sees exactly the mapping tops' tokens (head), none without A1
for (const b of ["head", "noA1"]) {
  const r = await scenario(B[b], { active: true });
  const s = pubSnap(r), ok = !!s && set(idents(s.tokens)) === set(r.tops) && s.tokens.length === r.tops.length;
  check(b === "head" ? ok : !ok, `A1-T1 ${b}: at the first cut after publication, the tokens are exactly the mapping tops (${s ? set(idents(s.tokens)) : "no published snap"}) ${b === "head" ? "" : "(the mutant FAILS it)"}${r.error ? " error: " + r.error : ""}`);
}
// ---- T2: atomicity: no cut has published:true without its tops' tokens (or the exhausted state)
for (const b of ["head", "noA1", "sepTx"]) {
  const r = await scenario(B[b], { active: true });
  const ok = r.snaps.filter((s) => s.published).every((s) => covered(s, r.tops)) && r.snaps.some((s) => s.published);
  check(b === "head" ? ok : !ok, `A1-T2 ${b}: every cut with the plan published holds its tops' tokens ${b === "head" ? "" : "(the mutant FAILS it)"}`);
}
// ---- T3: inactive: exactly 1 hmeta get in the publishing transaction, no token, and its raw requests = no-A1's + 1
{
  const h = await scenario(B.head, { active: false }), z1 = await scenario(B.noA1, { active: false }), z2 = await scenario(B.noA1, { active: false });
  check(h.pub?.hmetaGets === 1 && h.tokens.length === 0, `A1-T3: inactive, the publication reads hmeta exactly once (${h.pub?.hmetaGets}) and writes no token (${h.tokens.length})`);
  check(z1.pub?.req === z2.pub?.req, `A1-T16 control: the no-A1 baseline's raw count is deterministic (${z1.pub?.req}, ${z2.pub?.req})`);
  check(h.pub && z1.pub && h.pub.req - Math.max(z1.pub.req, z2.pub.req) === 1, `A1-T3/T16: inactive, the publication's raw requests exceed no-A1's by exactly 1 (${h.pub?.req} vs ${z1.pub?.req})`);
}
// ---- T16: active, the raw delta within A1.3's bound for k tops at this depth: 5 + k * (2 + 2 * ancestors + 5 + 4)
{
  const h = await scenario(B.head, { active: true }), z = await scenario(B.noA1, { active: true });
  const k = h.tops.length, depth = 0, bound = 5 + k * (2 + 2 * depth + 5 + 4), delta = h.pub && z.pub ? h.pub.req - z.pub.req : null;
  check(delta !== null && delta <= bound, `A1-T16: active, k = ${k} tops at depth ${depth}: ${delta} raw requests over no-A1, within A1.3's bound ${bound} (reported in D2; at k = 1,100, depth 32: 80,305)`);
}
// ---- T4: a destination whose entry doesn't carry the top's identity gives "broken" (head), null is the mutant
for (const b of ["head", "nullChain"]) {
  let tops = null;
  const r = await scenario(B[b], {
    active: true,
    inject: (tx) => {
      // (after the publication's record put, reads of the tops' physical rows answer nothing: a missing destination)
      let published = false;
      const put0 = IDBObjectStore.prototype.put, get0 = IDBObjectStore.prototype.get;
      const restore = () => { IDBObjectStore.prototype.put = put0; IDBObjectStore.prototype.get = get0; };
      IDBObjectStore.prototype.put = function (v, ...a) { if (this.transaction === tx && v?.published === true) published = true; return put0.call(this, v, ...a); };
      IDBObjectStore.prototype.get = function (k, ...a) { return get0.call(this, this.transaction === tx && published && this.name === "entries" && (k === "/a" || k === "/b") ? "\u0000none" : k, ...a); };
      tx.addEventListener("complete", restore); tx.addEventListener("abort", restore);
    },
  });
  const pubTokens = (pubSnap(r)?.tokens ?? []).filter((t) => r.tops.includes(t.ident));
  const ok = pubTokens.length === r.tops.length && pubTokens.every((t) => t.chain === "broken");
  check(b === "head" ? ok : !ok, `A1-T4 ${b}: a missing destination: the tops' tokens are "broken" (${J(pubTokens.map((t) => t.chain))}) ${b === "head" ? "" : "(the mutant FAILS it)"}`);
}
// ---- T5 + T10: the double token is real (seq, count, bytes), routing identical; T12 (D11 half): sweep 2's rev > publication's
{
  const h = await scenario(B.head, { active: true }), z = await scenario(B.noA1, { active: true }), d = await scenario(B.dedupIdent, { active: true });
  check(set(idents(h.tokens)) === set(idents(z.tokens)), `A1-T5: the idents the tokens name are the same with and without the publication's tokens (routing identical)`);
  const real = (r) => r.tokens.length === z.tokens.length + r.tops.length && r.meta.hseq === r.tokens.length && r.meta.hcount === r.tokens.length && r.meta.hbytes === r.tokens.reduce((s, t) => s + t.sz, 0);
  check(real(h), `A1-T10: the publication's tokens are real: ${h.tokens.length} = no-A1's ${z.tokens.length} + ${h.tops.length} tops; hseq, hcount, hbytes count them all (${J(h.meta)})`);
  check(!real(d), `A1-T10: the dedup-by-ident mutant FAILS it (${d.tokens.length} tokens)`);
  const ok12 = h.tops.every((t) => { const ts = h.tokens.filter((x) => x.ident === t).sort((a, b) => a.seq - b.seq); return ts.length >= 2 && ts.at(-1).rev > ts[0].rev && new Set(ts.map((x) => x.seq)).size === ts.length; });
  check(ok12, `A1-T12 (D11): for every top, the publication's token and sweep 2's both kept, sweep 2's rev above the publication's (its op advanced the generation)`);
}
// ---- T6: the D11 ledger counts are identical, active or inactive
{
  const a = await scenario(B.head, { active: true }), i = await scenario(B.head, { active: false });
  check(a.ledger && J(a.ledger) === J(i.ledger), `A1-T6: the replay's validation ledger is the same active and inactive (${J(a.ledger)})`);
}
// ---- T7: activation between publication and sweep 1: no publication tokens, sweep 2's top tokens, every identity moved
{
  let turned = false;
  const r = await scenario(B.head, { active: false, hook: async (phase, m, w) => { if (!turned && (await w.rewriteState())?.published) { turned = true; await rawPut(w.ws, "hmeta", true, "hactive"); } } });
  const atTurn = pubSnap(r);
  check(turned && atTurn.tokens.length === 0, `A1-T7: activated after publication: no publication tokens (${atTurn?.tokens.length})`);
  check(r.tops.every((t) => idents(r.tokens).includes(t)), `A1-T7: sweep 2's tokens for the tops present (${set(idents(r.tokens))})`);
  check(Object.values(r.ids).every((p) => p.startsWith("/a/") || p.startsWith("/b/") || p === "/a" || p === "/b") && !r.error, `A1-T7: every moved identity at its new logical path in the index (the full capture's half: an L3 obligation)`);
}
// ---- T11 (i): a token write failure at publication aborts it whole: never published without tokens; the swallow mutant fails
for (const b of ["head", "swallow"]) {
  let fired = 0;
  const r = await scenario(B[b], {
    active: true,
    inject: (tx) => {
      if (fired) return;
      const add0 = IDBObjectStore.prototype.add, restore = () => { IDBObjectStore.prototype.add = add0; };
      IDBObjectStore.prototype.add = function (...a) { if (this.transaction === tx && this.name === "htokens" && !fired++) throw new DOMException("injected", "UnknownError"); return add0.apply(this, a); };
      tx.addEventListener("complete", restore); tx.addEventListener("abort", restore);
    },
  });
  const ok = fired === 1 && r.snaps.filter((s) => s.published).every((s) => covered(s, r.tops));
  check(b === "head" ? ok : !ok, `A1-T11 (i) ${b}: an injected token-write failure at publication: never published without its tokens ${b === "head" ? `(retried: ${r.error ?? "ok"})` : "(the mutant FAILS it)"}`);
}
// ---- T11 (ii): exhaustion reached during the publication's tokens: published, the terminal flag, no partial state
{
  const r = await scenario(B.head, { active: true, preset: { hseq: MAX - 1, hcount: 0, hbytes: 0 } });
  const s = pubSnap(r);
  check(s && s.exhausted && r.meta.exhausted === true && r.tokens.filter((t) => t.seq === MAX).length === 1 && r.snaps.filter((x) => x.published).every((x) => covered(x, r.tops)), `A1-T11 (ii): exhaustion during the publication: published, exhausted set, the last seq used once (${J(r.meta)})`);
}
// ---- T12b: a publication's rev is the index generation: opsFloor after compaction; the old rec.rev + 1 is the mutant
for (const b of ["head", "oldRev"]) {
  const r = await scenario(B[b], { active: true, opsFloor: 1_000_000 });
  const pub = (pubSnap(r)?.tokens ?? []).filter((t) => r.tops.includes(t.ident));
  const ok = pub.length === r.tops.length && pub.every((t) => t.rev === 1_000_000);
  check(b === "head" ? ok : !ok, `A1-T12b ${b}: with opsFloor 1,000,000 and no op above it, the publication's tokens carry the generation (${J(pub.map((t) => t.rev))}) ${b === "head" ? "" : "(the mutant FAILS it)"}`);
}
// ---- T13: a crash after publication (before sweep 2), then inside sweep 2: publication tokens once, sweep 2's once
for (const [b, cut, cut2] of [["head", "sweep1", null], ["head", "sweep1", "sweep2"], ["republish", "sweep1", null]]) {
  const r = await scenario(B[b], { active: true, cut, cut2 });
  const z = await scenario(B.noA1, { active: true });
  const per = (ts, t) => ts.filter((x) => x.ident === t).length, want = (t) => per(z.tokens, t) + 1;
  const ok = r.crashed >= 1 && r.tops.every((t) => per(r.tokens, t) === want(t));
  check(b === "head" ? ok : !ok, `A1-T13 ${b}: a crash at ${cut}${cut2 ? ` then at ${cut2}` : ""}, resumed: each top's tokens = sweep's + exactly 1 publication (${J(r.tops.map((t) => per(r.tokens, t)))}) ${b === "head" ? "" : "(the mutant FAILS it)"}`);
}

export async function run() {
  return results;
}
