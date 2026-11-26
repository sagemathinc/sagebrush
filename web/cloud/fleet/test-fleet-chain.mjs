// ci: web-sync.1 order=15
// Tests for the fleet Worker's chain read (GET /api/fleet/v1/host/chain; the chain-read note r1.2), mounted over a real
// D1 (FLEET_DB) in Miniflare with all four migrations: the host's generation from fleet_grants, the nonce's prune and
// insert as one D1 batch, the page and its head from one statement, and every page read by the host's own reader and
// replayed from genesis. store.ts is bundled with bun (as the Worker is) to test its units with an explicit clock.
//   node web/cloud/fleet/test-fleet-chain.mjs
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dispatch } from "../../miniflare-dispatch.mjs";
import * as core from "../../workspace/fleet/core/index.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, "../../site/package.json"));
const { Miniflare, convertV4MiniflareOptions } = require("miniflare");
core.useCrypto(core.webCrypto());
const SCHEMAS = { "fleet.schema.json": JSON.parse(readFileSync(join(here, "../../workspace/fleet/fleet.schema.json"), "utf8")), "reasons.json": JSON.parse(readFileSync(join(here, "../../workspace/fleet/reasons.json"), "utf8")) };
core.useSchemas((n) => SCHEMAS[n]);
const tmp = mkdtempSync(join(tmpdir(), "fleet-chain-"));
writeFileSync(join(tmp, "store.mjs"), execFileSync("bun", ["build", join(here, "store.ts"), "--format", "esm", "--target", "node"], { encoding: "utf8" }));
const S = await import(pathToFileURL(join(tmp, "store.mjs")).href);
rmSync(tmp, { recursive: true, force: true });

let failures = 0, count = 0;
const ok = (c, what, detail) => { count++; if (!c) { failures++; console.log("FAIL", what, detail === undefined ? "" : JSON.stringify(detail).slice(0, 400)); } };
const AUD = "https://dev.sagebrush.space";
const SITE = "https://fleet.test";
const text = (b) => new TextDecoder().decode(b);
let seedN = 1;
const key = () => core.keyFromSeed(new Uint8Array(32).fill(seedN++ & 255).map((x, i) => (i === 0 ? (seedN >> 8) & 255 : x)));
const nonce = () => core.b64(core.random(16));

// ---- the Worker in Miniflare, with every migration applied
const script = execFileSync("bun", ["build", join(here, "test-entry.ts"), "--format", "esm", "--target", "browser"], { encoding: "utf8" });
const mf = new Miniflare(convertV4MiniflareOptions({
  workers: [{ name: "fleet", modules: true, script, compatibilityDate: "2026-10-01", d1Databases: ["FLEET_DB"], bindings: { FLEET_AUD: AUD } }],
}));
const db = await mf.getD1Database("FLEET_DB");
for (const m of ["0001_fleet_leases.sql", "0002_fleet_writers_chain_hosts.sql", "0003_fleet_writers_grants_transfers.sql", "0004_fleet_request_nonces.sql", "0005_fleet_accounts_and_bytes.sql"])
  for (const stmt of readFileSync(join(here, "migrations", m), "utf8").replace(/--[^\n]*/g, "").split(";").map((s) => s.trim()).filter(Boolean)) await db.prepare(stmt).run();
const exec = (sql, ...v) => db.prepare(sql).bind(...v).run();
const all = async (sql, ...v) => (await db.prepare(sql).bind(...v).all()).results;
const nonces = async () => (await all("SELECT COUNT(*) AS n FROM fleet_request_nonces"))[0].n;

/** A fleet with a real chain of `n` entries stored, and a paired host (rows as the writers leave them). */
async function fleetOf(n = 3) {
  const fleet = core.newId(), N = await key(), nId = core.newId(), R = await key();
  const sN = { kind: "device", id: nId, alg: "ed25519", key: N.key };
  let state = null;
  const entries = [];
  for (let seq = 0; seq < n; seq++) {
    const body = seq === 0
      ? { fleet, aud: AUD, seq, prev: "", op: "genesis", at_ms: 1, auth_time_ms: 1, device: { id: nId, alg: "ed25519", key: core.b64(N.raw), name: "mac", tier: "native" }, recovery_key: { alg: "ed25519", key: core.b64(R.raw) } }
      : { fleet, aud: AUD, seq, prev: state.head, op: "rotate-recovery", at_ms: 1, auth_time_ms: 1, recovery_key: { alg: "ed25519", key: core.b64((await key()).raw) } };
    const bytes = await core.seal("sb.device-chain.v1", sN, body, N);
    state = (await core.applyChainEntry(state, bytes, { aud: AUD, fleet })).state;
    entries.push(text(bytes));
    await exec("INSERT INTO fleet_chain_entries (fleet, seq, bytes) VALUES (?1, ?2, ?3)", fleet, seq, text(bytes));
  }
  return { fleet, entries, state, host: await hostOf(fleet) };
}
async function hostOf(fleet, { revoked = 0 } = {}) {
  const host = core.newId(), H = await key();
  await exec("INSERT INTO fleet_hosts (host, fleet, sign_key, fingerprint, revoked) VALUES (?1, ?2, ?3, ?4, ?5)", host, fleet, core.b64(H.raw), core.b64(core.random(32)), revoked);
  return { host, H };
}
const grantRow = (fleet, host, gen) => exec("INSERT INTO fleet_grants (fleet, host, gen, hash, bytes) VALUES (?1, ?2, ?3, ?4, 'x')", fleet, host, gen, core.b64(core.random(32)));

/** A host's signed read, as its sync sends it. */
async function read(h, { after = null, target = core.chainTarget(after), gen = 1, ts = Date.now(), nc = nonce(), method = "GET", body, headers = {} } = {}) {
  const f = { host: h.host, agent: "-", cap: "-", gen: String(gen), ts: String(ts), nonce: nc, idem: "-", op: "-" };
  const sig = await h.H.sign(core.requestBytes(AUD, method, target, await core.sha256b64(new Uint8Array(0)), f));
  const header = `v1 ${core.SIG_KEYS.map((k) => `${k}=${k === "sig" ? core.b64(sig) : f[k]}`).join("; ")}`;
  const r = await dispatch(mf, SITE + target, { method, headers: { "sagebrush-sig": header, ...headers }, ...(body ? { body } : {}) });
  const bytes = new Uint8Array(await r.arrayBuffer());
  return { status: r.status, bytes, json: bytes.length ? JSON.parse(text(bytes)) : null, headers: r.headers, header };
}

// ---- C-1: a host's sync from genesis through the mounted route: byte-exact pages, replayed to the stored head
{
  const f = await fleetOf(300);
  let after = -1, state = null, pages = 0;
  for (;;) {
    const r = await read(f.host, { after: after < 0 ? null : after });
    ok(r.status === 200 && r.headers.get("cache-control") === "no-store", "C-1: a page is served, no-store", r.status);
    const p = core.parseChainPage(r.bytes, after);
    for (const e of p.entries) state = (await core.applyChainEntry(state, e, { aud: AUD, fleet: f.fleet })).state;
    pages++;
    after = p.next;
    if (after >= p.head) break;
  }
  ok(pages === 2 && state.head === f.state.head && state.seq === 299, "C-1: 300 entries in two pages, replayed to the stored head", { pages, seq: state?.seq });
  const r = await read(f.host, { after: 296 });
  ok(JSON.stringify(r.json.entries) === JSON.stringify(f.entries.slice(297)) && r.json.head === 299, "C-1: from a pin, exactly the stored entries after it");
}

// ---- C-2: the head from one statement: an empty page carries the true head
{
  const f = await fleetOf(3);
  for (const [after, head] of [[2, 2], [9, 2]]) {
    const r = await read(f.host, { after });
    ok(r.status === 200 && JSON.stringify(r.json) === JSON.stringify({ entries: [], head }), `C-2: after ${after}: no entries, head ${head}`, r.json);
  }
  const fleet = core.newId(), h = await hostOf(fleet);
  const r = await read(h);
  ok(r.status === 200 && JSON.stringify(r.json) === JSON.stringify({ entries: [], head: -1 }), "C-2: a fleet with no entries yet: head -1", r.json);
  // (the store's page directly: the head row exists whatever the page holds)
  const p = await S.chainPage(db, f.fleet, 2, 256);
  ok(p.head === 2 && p.entries.length === 0, "C-2: chainPage past the head: the head, no entries", p);
}

// ---- C-3: fleet isolation, by the host's own pairing
{
  const a = await fleetOf(4), b = await fleetOf(2);
  const ra = await read(a.host), rb = await read(b.host);
  ok(JSON.stringify(ra.json.entries) === JSON.stringify(a.entries) && JSON.stringify(rb.json.entries) === JSON.stringify(b.entries), "C-3: each host reads only its own fleet's chain");
}

// ---- C-4: the generation (SEC's ruling and the no-row floor): MAX over the host's grants, or 1 with none
{
  const f = await fleetOf(2);
  let r = await read(f.host, { gen: 1 });
  ok(r.status === 200, "C-4: no grant row yet: gen=1 is served", r.json);
  r = await read(f.host, { gen: 2 });
  ok(r.status === 409 && r.json.error === "stale_generation", "C-4: no grant row yet: gen=2 is stale_generation", r.json);
  for (const g of [1, 2, 3, 4, 5]) await grantRow(f.fleet, f.host.host, g);
  for (const g of [1, 3, 5]) { r = await read(f.host, { gen: g }); ok(r.status === 200, `C-4: at gen 5, gen=${g} is served`, r.json); }
  const n0 = await nonces();
  r = await read(f.host, { gen: 6 });
  ok(r.status === 409 && r.json.error === "stale_generation" && (await nonces()) === n0, "C-4: gen=6 above the current 5: stale_generation, nothing spent", r.json);
  ok((await S.hostGen(db, f.fleet, f.host.host)) === 5 && (await S.hostGen(db, f.fleet, core.newId())) === 1, "C-4: hostGen: the max, or 1 with no row");
  // (another fleet's grant rows for the same host id never count)
  const other = core.newId();
  await grantRow(other, f.host.host, 9);
  ok((await S.hostGen(db, f.fleet, f.host.host)) === 5, "C-4: another fleet's rows don't count");
  // gen=0: the header's bad_form, nothing spent (the header is rewritten after signing: no signer makes it)
  const f0 = { host: f.host.host, agent: "-", cap: "-", gen: "0", ts: String(Date.now()), nonce: nonce(), idem: "-", op: "-" };
  const sig0 = await f.host.H.sign(core.requestBytes(AUD, "GET", core.CHAIN_ROUTE, await core.sha256b64(new Uint8Array(0)), f0));
  const h0 = `v1 ${core.SIG_KEYS.map((k) => `${k}=${k === "sig" ? core.b64(sig0) : f0[k]}`).join("; ")}`;
  const n1 = await nonces();
  const z = await dispatch(mf, SITE + core.CHAIN_ROUTE, { headers: { "sagebrush-sig": h0 } });
  ok(z.status === 400 && (await z.json()).error === "bad_form" && (await nonces()) === n1, "C-4: gen=0: bad_form, nothing spent");
  // a revoked host: host_revoked, its generation never read
  const rv = await hostOf(f.fleet, { revoked: 1 });
  r = await read(rv);
  ok(r.status === 403 && r.json.error === "host_revoked", "C-4: a revoked host: host_revoked", r.json);
  const unknown = { host: core.newId(), H: await key() };
  r = await read(unknown);
  ok(r.status === 401 && r.json.error === "unknown_host", "C-4: an unpaired host: unknown_host", r.json);
}

// ---- C-5: the nonce through D1: a replay, a shared nonce across hosts, concurrent identical reads
{
  const f = await fleetOf(2);
  const nc = nonce(), ts = Date.now();
  const first = await read(f.host, { nc, ts });
  const again = await dispatch(mf, SITE + core.CHAIN_ROUTE, { headers: { "sagebrush-sig": first.header } });
  ok(first.status === 200 && again.status === 409 && (await again.json()).error === "replay", "C-5: the same signed read again: replay");
  const h2 = await hostOf(f.fleet);
  ok((await read(h2, { nc })).status === 200, "C-5: the same nonce from another host: served (the key includes the host)");
  const fresh = { host: f.host.host, agent: "-", cap: "-", gen: "1", ts: String(Date.now()), nonce: nonce(), idem: "-", op: "-" };
  const sg = await f.host.H.sign(core.requestBytes(AUD, "GET", core.CHAIN_ROUTE, await core.sha256b64(new Uint8Array(0)), fresh));
  const hdr = `v1 ${core.SIG_KEYS.map((k) => `${k}=${k === "sig" ? core.b64(sg) : fresh[k]}`).join("; ")}`;
  const many = await Promise.all([0, 1, 2, 3].map(() => dispatch(mf, SITE + core.CHAIN_ROUTE, { headers: { "sagebrush-sig": hdr } })));
  ok(many.map((r) => r.status).sort().join() === "200,409,409,409", "C-5: four identical reads at once: exactly one served", many.map((r) => r.status));
}

// ---- C-6: spendRequestNonce: the prune edge at exactly 10 minutes, fleet scoping, and a rollback at each statement
{
  const KEEP = core.CHAIN_NONCE_KEEP_MS, T = 1_800_000_000_000;
  const fleet = core.newId(), host = core.newId(), n = nonce();
  ok((await S.spendRequestNonce(db, { fleet, host, nonce: n, now: T }, KEEP)) === true, "C-6: a new nonce is spent");
  ok((await S.spendRequestNonce(db, { fleet, host, nonce: n, now: T + KEEP }, KEEP)) === false, "C-6: at exactly 10 minutes it is still kept (strict <): replay");
  ok((await S.spendRequestNonce(db, { fleet, host, nonce: n, now: T + KEEP + 1 }, KEEP)) === true, "C-6: 1 ms later it was pruned (the request's window refuses it before here)");
  ok((await S.spendRequestNonce(db, { fleet: core.newId(), host, nonce: n, now: T }, KEEP)) === true, "C-6: the same host and nonce in another fleet: its own row");
  // (the prune touches only this host's rows)
  const other = core.newId();
  await S.spendRequestNonce(db, { fleet, host: other, nonce: n, now: T }, KEEP);
  await S.spendRequestNonce(db, { fleet, host, nonce: nonce(), now: T + 10 * KEEP }, KEEP);
  ok((await all("SELECT 1 FROM fleet_request_nonces WHERE fleet = ?1 AND host = ?2", fleet, other)).length === 1, "C-6: another host's old nonce isn't pruned by this host's spend");
  const failing = (i) => ({ prepare: (s) => db.prepare(s), batch: (stmts) => { const b = [...stmts]; b[i] = db.prepare("SELECT json_extract('broken', '$')"); return db.batch(b); } });
  for (let i = 0; i < 2; i++) {
    const before = JSON.stringify(await all("SELECT * FROM fleet_request_nonces ORDER BY 1, 2, 3"));
    let threw = false;
    try { await S.spendRequestNonce(failing(i), { fleet, host, nonce: nonce(), now: T + 20 * KEEP }, KEEP); } catch { threw = true; }
    ok(threw && JSON.stringify(await all("SELECT * FROM fleet_request_nonces ORDER BY 1, 2, 3")) === before, `C-6: the spend's statement ${i + 1} failing: nothing pruned, nothing inserted`);
  }
}

// ---- C-7: the stored chain as a fault: a gap or an over-bound entry is 500 with nothing served
{
  const f = await fleetOf(5);
  await exec("DELETE FROM fleet_chain_entries WHERE fleet = ?1 AND seq = 2", f.fleet);
  let r = await read(f.host);
  ok(r.status === 500 && r.bytes.length === 0, "C-7: a gap in the stored entries: 500, nothing served", r.status);
  const g = await fleetOf(1);
  // (an entry one UTF-8 byte over SIGNED_MAX can't even be stored: the migration's byte-exact CHECK refuses it, so the
  // route's own 500 for it is the core's second guard, rowed there)
  let stored = true;
  try { await exec("UPDATE fleet_chain_entries SET bytes = ?2 WHERE fleet = ?1 AND seq = 0", g.fleet, "é".repeat(32768) + "a"); } catch (e) { stored = !/CHECK constraint failed/.test(String(e?.message)); }
  ok(!stored, "C-7: D1 refuses to store an entry one UTF-8 byte over SIGNED_MAX");
  await exec("UPDATE fleet_chain_entries SET bytes = ?2 WHERE fleet = ?1 AND seq = 0", g.fleet, "é".repeat(32768));
  r = await read(g.host);
  ok(r.status === 200 && r.json.entries[0].length === 32768, "C-7: exactly SIGNED_MAX bytes: served");
}

// ---- C-8: transport and form through the mount: method, body, target grammar, rate
{
  const f = await fleetOf(1);
  const n0 = await nonces();
  let r = await read(f.host, { method: "POST", body: "" });
  ok(r.status === 405, "C-8: POST: 405", r.status);
  r = await read(f.host, { method: "PUT", body: "x" });
  ok(r.status === 405, "C-8: PUT: 405", r.status);
  for (const target of [`${core.CHAIN_ROUTE}?after=01`, `${core.CHAIN_ROUTE}?after=1&x=1`, `${core.CHAIN_ROUTE}?x=1`, `${core.CHAIN_ROUTE}?after=%31`]) {
    r = await read(f.host, { target });
    ok(r.status === 400 && r.json.error === "bad_form", `C-8: the target ${target}: bad_form`, r.json);
  }
  ok((await nonces()) === n0, "C-8: none of these spent a nonce");
  // a body on a GET can't be sent through fetch; the mount's cap of 0 is the handler's own row (core's tests)
  let last;
  for (let i = 0; i < core.CHAIN_RATE_HOST.limit; i++) last = await read(f.host);
  ok(last.status === 200, "C-8: 60 reads in a minute: served");
  r = await read(f.host);
  ok(r.status === 429 && JSON.stringify(r.json) === JSON.stringify({ error: "rate", retry_after_s: 60 }), "C-8: the 61st: rate, retry_after_s 60", r.json);
}

await mf.dispose();
console.log(`${count - failures}/${count} passed`);
if (failures) process.exit(1);
