// ci: web-sync.1 order=17
// Tests for the fleet Worker's grant read (GET /api/fleet/v1/host/grant; the grant-read note r0.4), mounted over a real
// D1 (FLEET_DB) in Miniflare with every migration. The grants, transfers and receipts are written by the REAL writers
// (writers.ts applyGrant), and every answer is read by the host's own reader and its pairs verified by the core, as the
// host's intake will. The core handler's own rows are the agent repository's; these are the mount's: the one-statement
// read, retention for the fleet's life, the shared nonce store, and the route end to end.
//   node web/cloud/fleet/test-fleet-grant-read.mjs
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
const tmp = mkdtempSync(join(tmpdir(), "fleet-grant-read-"));
for (const m of ["writers", "store"]) writeFileSync(join(tmp, `${m}.mjs`), execFileSync("bun", ["build", join(here, `${m}.ts`), "--format", "esm", "--target", "node"], { encoding: "utf8" }));
const W = await import(pathToFileURL(join(tmp, "writers.mjs")).href);
const S = await import(pathToFileURL(join(tmp, "store.mjs")).href);
rmSync(tmp, { recursive: true, force: true });

let failures = 0, count = 0;
const ok = (c, what, detail) => { count++; if (!c) { failures++; console.log("FAIL", what, detail === undefined ? "" : JSON.stringify(detail).slice(0, 500)); } };
const AUD = "https://dev.sagebrush.space", SITE = "https://fleet.test";
const NOW = Date.now();
let seedN = 1;
const key = () => core.keyFromSeed(new Uint8Array(32).fill(seedN++ & 255).map((x, i) => (i === 0 ? (seedN >> 8) & 255 : x)));
const rand = (n) => core.b64(core.random(n));
const text = (b) => new TextDecoder().decode(b);

// ---- the Worker in Miniflare, with every migration applied
const script = execFileSync("bun", ["build", join(here, "test-entry.ts"), "--format", "esm", "--target", "browser"], { encoding: "utf8" });
const mf = new Miniflare(convertV4MiniflareOptions({ workers: [{ name: "fleet", modules: true, script, compatibilityDate: "2026-10-01", d1Databases: ["FLEET_DB"], bindings: { FLEET_AUD: AUD } }] }));
const db = await mf.getD1Database("FLEET_DB");
for (const m of ["0001_fleet_leases.sql", "0002_fleet_writers_chain_hosts.sql", "0003_fleet_writers_grants_transfers.sql", "0004_fleet_request_nonces.sql", "0005_fleet_accounts_and_bytes.sql"])
  for (const stmt of readFileSync(join(here, "migrations", m), "utf8").replace(/--[^\n]*/g, "").split(";").map((s) => s.trim()).filter(Boolean)) await db.prepare(stmt).run();
const all = async (sql, ...v) => (await db.prepare(sql).bind(...v).all()).results;
const exec = (sql, ...v) => db.prepare(sql).bind(...v).run();

// ---- a fleet through the real writers: a native device, the service's key pinned, paired hosts
async function fleetOf() {
  const fleet = core.newId(), N = await key(), nId = core.newId(), R = await key();
  const sN = { kind: "device", id: nId, alg: "ed25519", key: N.key };
  const f = { fleet, N, sN, seq: 0, head: "", keys: [], account: core.newId() };
  f.body = (op, extra) => ({ fleet, aud: AUD, seq: f.seq, prev: f.head, op, at_ms: NOW, auth_time_ms: NOW, ...extra });
  f.append = async (bytes) => {
    const r = await W.appendChainEntry(db, core, { fleet, aud: AUD, bytes, now: NOW, account: f.account });
    if (!r.ok) throw new Error(`append: ${JSON.stringify(r)}`);
    const st = await W.loadChain(db, core, fleet, AUD);
    f.seq = st.head.seq + 1; f.head = st.head.hash; f.state = st.state;
  };
  await f.append(await core.seal("sb.device-chain.v1", sN, f.body("genesis", { device: { id: nId, alg: "ed25519", key: core.b64(N.raw), name: "mac", tier: "native" }, recovery_key: { alg: "ed25519", key: core.b64(R.raw) } }), N));
  const K = await key(), kid = core.newId();
  await f.append(await core.seal("sb.device-chain.v1", sN, f.body("service-key", { service_key: { id: kid, alg: "ed25519", key: core.b64(K.raw) } }), N));
  f.keys.push({ id: kid, raw: K.raw, sign: (b) => K.sign(b) });
  return f;
}
async function hostOf(f) {
  const host = core.newId(), H = await key(), encRaw = core.random(32);
  const fingerprint = core.b64(await core.hostFingerprint(host, H.raw, encRaw));
  const bytes = await core.seal("sb.host-cert.v1", f.sN, { fleet: f.fleet, aud: AUD, chain_seq: f.seq - 1, host, sign_key: core.b64(H.raw), enc_key: core.b64(encRaw), fingerprint, name: "box", at_ms: NOW }, f.N);
  const r = await W.pairHost(db, core, { fleet: f.fleet, aud: AUD, bytes });
  if (!r.ok) throw new Error(`pair: ${JSON.stringify(r)}`);
  return { host, H, fingerprint, cert: (await all("SELECT cert FROM fleet_host_certs WHERE fleet = ?1 AND host = ?2", f.fleet, host))[0].cert };
}
const agentEntry = (agent) => ({ agent, name: "worker", client: "claude", root: false, tags: [], workspace: [{ path: "/Algebra", access: "write" }], broker: ["messages"], spend_cap_cents: 0, config_schema: 1, config: {} });
async function grantOf(f, h, gen, agents) {
  const body = { fleet: f.fleet, aud: AUD, host: h.host, gen, cert: h.cert, chain_seq: f.seq - 1, at_ms: NOW - 1000, not_before_ms: NOW - 1000, not_after_ms: NOW + 3_600_000,
    auth_time_ms: NOW, agents, tags: [], subscriptions: [], offline: { revocation_check_s: 900, horizon_s: 3600 } };
  return { bytes: await core.seal("sb.host-grant.v1", f.sN, body, f.N), hash: await core.sha256b64(core.signedBytes("sb.host-grant.v1", f.sN, body)), body };
}
async function transferOf(f, agent, from, to, g) {
  const body = { fleet: f.fleet, aud: AUD, agent, from_host: from.host, to_host: to.host, to_host_key: to.fingerprint, gen: g.body.gen, grant: g.hash, nonce: rand(16),
    chain_seq: f.seq - 1, at_ms: NOW, not_after_ms: NOW + 600_000, auth_time_ms: NOW };
  return { bytes: await core.seal("sb.agent-transfer.v1", f.sN, body, f.N), body };
}
const apply = async (f, g, transfers = []) => {
  const r = await W.applyGrant(db, core, { fleet: f.fleet, aud: AUD, grant: g.bytes, transfers: transfers.map((t) => t.bytes), now: NOW, serviceKeys: f.keys });
  if (!r.ok) throw new Error(`apply: ${JSON.stringify(r)}`);
  return r;
};

/** A host's signed read of a route, as its intake sends it. */
async function read(h, { target = core.grantTarget(null), gen = 1, ts = Date.now(), nc = core.b64(core.random(16)), method = "GET", body } = {}) {
  const fl = { host: h.host, agent: "-", cap: "-", gen: String(gen), ts: String(ts), nonce: nc, idem: "-", op: "-" };
  const sig = await h.H.sign(core.requestBytes(AUD, method, target, await core.sha256b64(new Uint8Array(0)), fl));
  const header = `v1 ${core.SIG_KEYS.map((k) => `${k}=${k === "sig" ? core.b64(sig) : fl[k]}`).join("; ")}`;
  const r = await dispatch(mf, SITE + target, { method, headers: { "sagebrush-sig": header }, ...(body ? { body } : {}) });
  const bytes = new Uint8Array(await r.arrayBuffer());
  return { status: r.status, bytes, json: bytes.length ? JSON.parse(text(bytes)) : null, cache: r.headers.get("cache-control") };
}

// ---- the world: X granted on A at gen 1, moved to B (B's gen 1 with the transfer), then B's gen 2 with no transfers
const f = await fleetOf();
const A = await hostOf(f), B = await hostOf(f);
const X = core.newId();
await apply(f, await grantOf(f, A, 1, [agentEntry(X)]));
const gB1 = await grantOf(f, B, 1, [agentEntry(X)]);
const tX = await transferOf(f, X, A, B, gB1);
const applied = await apply(f, gB1, [tX]);
const gB2 = await grantOf(f, B, 2, [agentEntry(X)]);
await apply(f, gB2);

// ---- GR-1: the route end to end: the grant and its stored pairs, read by the host's reader and verified by the core
{
  const r = await read(B, { target: core.grantTarget(1), gen: 2 });
  ok(r.status === 200 && r.cache === "no-store", "GR-1: gen 1 served, no-store", r.status);
  const a = core.parseGrantRead(r.bytes, 1);
  const stored = (await all("SELECT bytes FROM fleet_grants WHERE fleet = ?1 AND host = ?2 AND gen = 1", f.fleet, B.host))[0].bytes;
  ok(text(a.grant) === stored && text(a.grant) === text(gB1.bytes), "GR-1: the grant is the stored text, byte for byte");
  ok(a.pairs.length === 1 && text(a.pairs[0].transfer) === applied.pairs[0].transfer && text(a.pairs[0].receipt) === applied.pairs[0].receipt, "GR-1: the pair is the one the writer stored and answered");
  let verified = null;
  try { verified = await core.verifyTransferReceipt(a.pairs[0], { aud: AUD, fleet: f.fleet, chain: f.state }); } catch (e) { verified = e.code; }
  ok(verified?.transfer?.agent === X && verified.transfer.to_host === B.host, "GR-1: the pair verifies with the core, for X to B", verified);
}

// ---- GR-2 (the note's row 13): a host that missed generations: the newest has no pairs; the generation that moved X has it
{
  const n = await read(B, { gen: 2 });
  ok(n.status === 200 && n.json.gen === 2 && JSON.stringify(n.json.pairs) === "[]", "GR-2: the newest (gen 2, no transfers): pairs []", n.json);
  const one = await read(B, { target: core.grantTarget(1), gen: 2 }), again = await read(B, { target: core.grantTarget(1), gen: 2 });
  ok(Buffer.from(one.bytes).equals(Buffer.from(again.bytes)), "GR-2: the same generation read twice: byte-identical");
  const three = await read(B, { target: core.grantTarget(3), gen: 2 });
  ok(three.status === 404 && three.json.error === "no_grant", "GR-2: a generation never accepted: no_grant", three.json);
}

// ---- GR-3: ONE statement, and retention for the fleet's life
{
  let prepares = 0, alls = 0, batches = 0;
  const spy = { prepare: (sql) => { prepares++; const st = db.prepare(sql); return { bind: (...v) => { const b = st.bind(...v); return { all: () => { alls++; return b.all(); }, first: () => b.first(), run: () => b.run() }; } }; }, batch: (x) => { batches++; return db.batch(x); } };
  const row = await S.grantRead(spy, f.fleet, B.host, 1);
  ok(prepares === 1 && alls === 1 && batches === 0, "GR-3: the read is one statement", { prepares, alls, batches });
  ok(row.gen === 1 && row.n === 1 && JSON.parse(row.result).length === 1, "GR-3: the row: the grant, its result, one result", row);
  const src = readFileSync(join(here, "store.ts"), "utf8") + readFileSync(join(here, "writers.ts"), "utf8") + readFileSync(join(here, "server.ts"), "utf8");
  ok(!/DELETE\s+FROM\s+fleet_grants|DELETE\s+FROM\s+fleet_transfer_results|UPDATE\s+fleet_grants|UPDATE\s+fleet_transfer_results/i.test(src), "GR-3: nothing in the Worker deletes or rewrites a grant or a result");
}

// ---- GR-4: the nonce store is the chain read's: one domain per fleet and host
{
  const nc = core.b64(core.random(16));
  const c = await read(B, { target: core.chainTarget(null), gen: 2, nc });
  ok(c.status === 200, "GR-4: the chain read spends the nonce", c.status);
  const g = await read(B, { gen: 2, nc });
  ok(g.status === 409 && g.json.error === "replay", "GR-4: the same nonce on the grant read: replay", g.json);
  const nc2 = core.b64(core.random(16));
  ok((await read(B, { gen: 2, nc: nc2 })).status === 200, "GR-4: the grant read spends one");
  const c2 = await read(B, { target: core.chainTarget(null), gen: 2, nc: nc2 });
  ok(c2.status === 409 && c2.json.error === "replay", "GR-4: and the chain read refuses it", c2.json);
}

// ---- GR-5: another fleet's result under the same grant hash is not this grant's (the join keeps the fleet): still served
{
  const res = (await all("SELECT grant_hash, transfers, result FROM fleet_transfer_results WHERE fleet = ?1", f.fleet))[0];
  await exec("INSERT INTO fleet_transfer_results (fleet, request_key, grant_hash, transfers, result) VALUES (?1, ?2, ?3, ?4, ?5)", core.newId(), rand(32), res.grant_hash, res.transfers, "[]");
  const r = await read(B, { target: core.grantTarget(1), gen: 2 });
  ok(r.status === 200 && r.json.pairs.length === 1, "GR-5: another fleet's row with an equal hash changes nothing", r.status);
}

// ---- GR-5: a store fault: two results naming one grant's hash (written straight into the table): a 500, nothing served
{
  const res = (await all("SELECT grant_hash, transfers, result FROM fleet_transfer_results WHERE fleet = ?1", f.fleet))[0];
  await exec("INSERT INTO fleet_transfer_results (fleet, request_key, grant_hash, transfers, result) VALUES (?1, ?2, ?3, ?4, ?5)", f.fleet, rand(32), res.grant_hash, res.transfers, res.result);
  const r = await read(B, { target: core.grantTarget(1), gen: 2 });
  ok(r.status === 500 && r.bytes.length === 0, "GR-5: two results for one grant: 500, nothing served", r.status);
}

// ---- GR-6: isolation and the header's generation
{
  const a = await read(A);
  ok(a.status === 200 && a.json.gen === 1 && JSON.stringify(a.json.pairs) === "[]", "GR-6: host A reads its own grant", a.json);
  const C = await hostOf(f);
  const c = await read(C);
  ok(c.status === 404 && c.json.error === "no_grant", "GR-6: a paired host with no grant: no_grant", c.json);
  const hi = await read(B, { gen: 3 });
  ok(hi.status === 409 && hi.json.error === "stale_generation", "GR-6: a header generation above the host's current: stale_generation", hi.json);
  const low = await read(B, { target: core.grantTarget(2), gen: 1 });
  ok(low.status === 200 && low.json.gen === 2, "GR-6: a header generation below the one read: served");
}

// ---- GR-7: the route's own refusal of another method (a GET can't carry a body over fetch: the core's own rows refuse one)
{
  const p = await read(B, { gen: 2, method: "POST" });
  ok(p.status === 405, "GR-7: POST: 405", p.status);
}

await mf.dispose();
console.log(`${count - failures}/${count} passed`);
if (failures) process.exit(1);
