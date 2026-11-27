// ci: web-sync.1 order=17
// Tests for host pairing's service side (web/cloud/fleet/pairing.ts; the pairing service note d3, read with host d3r2):
// the Worker in Miniflare on a real D1 with every migration, the person's session given as the mounting Worker would
// (test-entry.ts takes it from x-test-account), the host's requests signed with a real Sagebrush-Sig, the approval and
// the certificate signed by the fleet's own native device, and the fleet built through the person's real chain route.
//   node web/cloud/fleet/test-fleet-pairing.mjs
import { execFileSync } from "node:child_process";
import { createHash, createHmac, hkdfSync } from "node:crypto";
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
const tmp = mkdtempSync(join(tmpdir(), "fleet-pairing-"));
for (const m of ["pairing"]) writeFileSync(join(tmp, `${m}.mjs`), execFileSync("bun", ["build", join(here, `${m}.ts`), "--format", "esm", "--target", "node"], { encoding: "utf8" }));
const P = await import(pathToFileURL(join(tmp, "pairing.mjs")).href);
rmSync(tmp, { recursive: true, force: true });

let failures = 0, count = 0;
const ok = (c, what, detail) => { count++; if (!c) { failures++; console.log("FAIL", what, detail === undefined ? "" : JSON.stringify(detail).slice(0, 600)); } };
const AUD = "https://dev.sagebrush.space", SITE = "https://fleet.test";
const NOW = Date.now();
const SEED = new Uint8Array(32).fill(7);
let seedN = 1;
const key = () => core.keyFromSeed(new Uint8Array(32).fill(seedN++ & 255).map((x, i) => (i === 0 ? (seedN >> 8) & 255 : x)));
const text = (b) => new TextDecoder().decode(b);
const enc = (s) => new TextEncoder().encode(s);

const script = execFileSync("bun", ["build", join(here, "test-entry.ts"), "--format", "esm", "--target", "browser"], { encoding: "utf8" });
const mf = new Miniflare(convertV4MiniflareOptions({ workers: [{ name: "fleet", modules: true, script, compatibilityDate: "2026-10-01", d1Databases: ["FLEET_DB"], bindings: { FLEET_AUD: AUD, LEASE_KEY_SEED: core.b64(SEED) } }] }));
const db = await mf.getD1Database("FLEET_DB");
const MIGRATIONS = ["0001_fleet_leases.sql", "0002_fleet_writers_chain_hosts.sql", "0003_fleet_writers_grants_transfers.sql", "0004_fleet_request_nonces.sql", "0005_fleet_accounts_and_bytes.sql", "0006_fleet_pairings.sql"];
for (const m of MIGRATIONS) for (const stmt of readFileSync(join(here, "migrations", m), "utf8").replace(/--[^\n]*/g, "").split(";").map((s) => s.trim()).filter(Boolean)) await db.prepare(stmt).run();
const all = async (sql, ...v) => (await db.prepare(sql).bind(...v).all()).results;
const one = async (sql, ...v) => (await all(sql, ...v))[0] ?? null;

/** A request; `headers` adds test seams and the session. */
async function call(path, { body, headers = {}, method = "POST" } = {}) {
  // (the Worker's clock is the test's NOW unless a row moves it; each call comes from its own source address unless a
  // row names one, so the per-source limits only bind where a row tests them)
  headers = { "x-test-now": String(NOW), "cf-connecting-ip": `198.51.100.${++sourceN % 250}.${sourceN}`, ...headers };
  const r = await dispatch(mf, SITE + path, { method, headers, ...(body !== undefined ? { body } : {}) });
  const bytes = new Uint8Array(await r.arrayBuffer());
  let json = null;
  try { json = bytes.length ? JSON.parse(text(bytes)) : null; } catch { /* (not JSON) */ }
  return { status: r.status, json, cache: r.headers.get("cache-control") };
}
const errorOf = (r) => r.json?.error ?? null;
let sourceN = 0;

// ---- the host: a fresh id and its two keys, and its signed requests
async function hostOf(name = "lab-box") {
  const h = { host: core.newId(), K: await key(), encRaw: core.random(32), name };
  h.fingerprint = core.b64(await core.hostFingerprint(h.host, h.K.raw, h.encRaw));
  h.body = () => ({ host: h.host, sign_key: core.b64(h.K.raw), enc_key: core.b64(h.encRaw), fingerprint: h.fingerprint, name: h.name });
  return h;
}
/** The Sagebrush-Sig over (method, target, body) with this key, as a host's broker writes it. */
async function sig(host, K, target, body, { ts = NOW, nonce = core.b64(core.random(16)), gen = "1", agent = "-", aud = AUD } = {}) {
  const f = { host, agent, cap: "-", gen, ts: String(ts), nonce, idem: "-", op: "-" };
  const bytes = core.requestBytes(aud, "POST", target, await core.sha256b64(enc(body)), f);
  return `v1 host=${f.host}; agent=${f.agent}; cap=${f.cap}; gen=${f.gen}; ts=${f.ts}; nonce=${f.nonce}; idem=${f.idem}; op=${f.op}; sig=${core.b64(await K.sign(bytes))}`;
}
async function ask(h, { body = JSON.stringify(h.body()), K = h.K, sigHost = h.host, now, seam = {}, sigOpts = {} } = {}) {
  const headers = { "sagebrush-sig": await sig(sigHost, K, "/api/fleet/v1/host/pair", body, { ts: now ?? NOW, ...sigOpts }), ...seam };
  if (now !== undefined) headers["x-test-now"] = String(now);
  return call("/api/fleet/v1/host/pair", { body, headers });
}
async function pollOf(h, pairing, { K = h.K, sigHost = h.host, now, sigOpts = {} } = {}) {
  const body = JSON.stringify({ pairing });
  const headers = { "sagebrush-sig": await sig(sigHost, K, "/api/fleet/v1/host/pair/result", body, { ts: now ?? NOW, ...sigOpts }) };
  if (now !== undefined) headers["x-test-now"] = String(now);
  return call("/api/fleet/v1/host/pair/result", { body, headers });
}

// ---- the person: a fleet made through the chain route, its native device signing the approval and the cert
async function fleetOf(account = "acct-" + core.newId().slice(0, 10)) {
  const f = { fleet: core.newId(), account, seq: 0, head: "" };
  f.N = await key(); f.nId = core.newId(); f.R = await key();
  f.sN = { kind: "device", id: f.nId, alg: "ed25519", key: f.N.key };
  f.body = (op, extra) => ({ fleet: f.fleet, aud: AUD, seq: f.seq, prev: f.head, op, at_ms: NOW, auth_time_ms: NOW, ...extra });
  const g = await core.seal("sb.device-chain.v1", f.sN, f.body("genesis", { device: { id: f.nId, alg: "ed25519", key: core.b64(f.N.raw), name: "mac", tier: "native" }, recovery_key: { alg: "ed25519", key: core.b64(f.R.raw) } }), f.N);
  const r = await call("/api/fleet/v1/chain", { body: g, headers: { "x-test-account": account } });
  if (r.status !== 200) throw new Error(`genesis: ${JSON.stringify(r.json)}`);
  f.seq = 1;
  return f;
}
const subjectOf = (h) => ({ host: h.host, sign_key: core.b64(h.K.raw), enc_key: core.b64(h.encRaw), fingerprint: h.fingerprint, name: h.name });
const approvalOf = async (f, h, pairing, { approval = core.newId(), at = NOW, auth = NOW, subject = subjectOf(h), requester = { pairing } } = {}) =>
  text(await core.seal("sb.approval.v1", f.sN, { fleet: f.fleet, aud: AUD, chain_seq: f.seq - 1, approval, kind: "host-pair", requester, subject,
    subject_hash: await core.sha256b64(enc(core.canonText(subject))), at_ms: at, not_after_ms: at + 600_000, auth_time_ms: auth }, f.N));
const certOf = async (f, h, extra = {}) => text(await core.seal("sb.host-cert.v1", f.sN, { fleet: f.fleet, aud: AUD, chain_seq: f.seq - 1, host: h.host, sign_key: core.b64(h.K.raw),
  enc_key: core.b64(h.encRaw), fingerprint: h.fingerprint, name: h.name, at_ms: NOW, ...extra }, f.N));
async function approveAs(f, body, { now, seam, advance } = {}) {
  const headers = { "x-test-account": f.account };
  if (now !== undefined) headers["x-test-now"] = String(now);
  if (advance !== undefined) headers["x-test-advance-before-claim"] = String(advance);
  if (seam) headers["x-test-pairing"] = seam;
  return call("/api/fleet/v1/pairings/approve", { body: JSON.stringify(body), headers });
}
const lookupAs = (account, code, headers = {}) => call("/api/fleet/v1/pairings/lookup", { body: JSON.stringify({ code }), headers: { "x-test-account": account, ...headers } });
/** A host that asked, and the pairing it got. */
async function asked(name) { const h = await hostOf(name); const r = await ask(h); if (r.status !== 200) throw new Error(`ask: ${JSON.stringify(r.json)}`); return { h, ...r.json }; }

// ---- K: the constants (TESTS P3: the host's horizon depends on the tombstone's retention)
ok(P.PAIRING_TOMBSTONE_MS === 30 * 24 * 3600_000, "K-1: PAIRING_TOMBSTONE_MS is 30 days");
ok(P.PAIRING_HOST_RESUME_MAX_MS === 7 * 24 * 3600_000 && P.PAIRING_HOST_RESUME_MAX_MS <= P.PAIRING_TOMBSTONE_MS / 2, "K-2: the host's 7-day resume horizon is at most half the tombstone's retention");
ok(P.PAIRING_LIFE_MS === 600_000 && P.PAIRING_CLAIM_MS === 60_000 && P.PAIRING_CLAIM_MS > 30_000, "K-3: a pairing lives 10 minutes; a claim's lease is 60 s (it keeps racers apart; the G rows show what keeps a host in one fleet)");
{
  // (the name rule is the schema's own $defs.name: every reserved name and the pattern's edges agree)
  const def = SCHEMAS["fleet.schema.json"].$defs.name, re = new RegExp(def.pattern);
  const names = ["a", "lab-box", "a".repeat(32), "a".repeat(33), "Lab", "-x", "x y", "é", "", ...def.not.enum, "con1", "own-box"];
  const disagree = names.filter((n) => P.isPairingName(n) !== (typeof n === "string" && re.test(n) && n.length >= def.minLength && n.length <= def.maxLength && !def.not.enum.includes(n)));
  ok(disagree.length === 0, "K-4: a pairing's name is exactly the schema's $defs.name (the approval and the certificate carry it)", disagree);
}

// ---- H: the happy path
let happy;
{
  const f = await fleetOf();
  const { h, pairing, code, expires_at_ms } = await asked("lab-box");
  ok(core.isId(pairing) && /^[a-z2-7]{8}$/.test(code) && expires_at_ms === NOW + 600_000, "H-1: the request gives a pairing id, an 8-character code and a 10-minute expiry", { pairing, code, expires_at_ms });
  ok(!JSON.stringify(await all("SELECT * FROM fleet_pairings")).includes(code), "H-2: the code itself is stored nowhere (only its hash)");
  {
    // (SEC N2: a plain SHA-256 of 40 bits is undone by trying them all, so the stored hash is keyed by the Worker)
    const stored = (await one("SELECT code_hash FROM fleet_pairings WHERE pairing = ?1", pairing))?.code_hash;
    const k = Buffer.from(hkdfSync("sha256", SEED, new Uint8Array(0), "sagebrush.fleet.pairing-code.v1", 32));
    ok(stored === createHmac("sha256", k).update(code).digest("base64url"), "H-12: the stored hash is HMAC-SHA-256 under the key HKDF'd from the lease seed", stored);
    ok(stored !== createHash("sha256").update(code).digest("base64url"), "H-13: not the code's plain SHA-256");
  }
  ok((await pollOf(h, pairing)).json?.state === "pending", "H-3: the poll answers pending before the approval");
  const look = await lookupAs(f.account, code.toUpperCase().slice(0, 4) + " - " + code.slice(4));
  ok(look.status === 200 && look.json.pairing === pairing && look.json.fingerprint === h.fingerprint && look.json.name === "lab-box" && look.json.host === h.host,
    "H-4: lookup by the code, in mixed case with spaces and a dash, gives the waiting host's public keys and name", look.json);
  const ap = await approveAs(f, { pairing, approval: await approvalOf(f, h, pairing), cert: await certOf(f, h) });
  ok(ap.status === 200 && ap.json.host === h.host && ap.json.fleet === f.fleet, "H-5: the approval certifies the host in the person's fleet", ap.json);
  const p = await pollOf(h, pairing);
  ok(p.json?.state === "approved" && p.json.fleet === f.fleet, "H-6: the poll answers approved, with the fleet", p.json);
  const certText = Buffer.from(p.json.cert, "base64url").toString("utf8");
  let verified = null;
  try {
    const { state } = await (async () => { const rows = await all("SELECT bytes FROM fleet_chain_entries WHERE fleet = ?1 ORDER BY seq", f.fleet); return { state: await core.replayChain(rows.map((r) => enc(r.bytes)), { aud: AUD, fleet: f.fleet }) }; })();
    verified = await core.verifyHostCert(enc(certText), { aud: AUD, fleet: f.fleet, chain: state });
  } catch (e) { verified = String(e); }
  ok(verified?.body?.host === h.host && verified.body.sign_key === core.b64(h.K.raw), "H-7: the polled cert is the stored certificate and verifies against the fleet's chain", verified);
  ok((await one("SELECT host FROM fleet_hosts WHERE host = ?1", h.host))?.host === h.host, "H-8: the host is now in fleet_hosts, so the existing chain read serves it");
  ok((await one("SELECT fleet, claim FROM fleet_pairings WHERE pairing = ?1", pairing))?.fleet === f.fleet, "H-9: the released claim recorded the fleet; no claim remains");
  ok(p.cache === "no-store", "H-10: no-store");
  ok(errorOf(await lookupAs(f.account, code)) === "not_found", "H-11: the code of an approved pairing finds nothing");
  happy = { f, h, pairing };
}

// ---- R: the request
{
  const h = await hostOf();
  const other = await key();
  ok(errorOf(await ask(h, { K: other })) === "bad_signature", "R-1: a header signed by another key: bad_signature");
  const h2 = await hostOf();
  ok(errorOf(await ask(h, { sigHost: h2.host })) === "bad_signature", "R-2: the header's host isn't the body's: bad_signature");
  ok(errorOf(await ask(h, { sigOpts: { aud: "https://sagebrush.space" } })) === "bad_signature", "R-3: signed for another audience: bad_signature (aud is in the signed bytes)");
  ok(errorOf(await ask(h, { sigOpts: { ts: NOW - 300_001 } })) === "clock_skew", "R-4: ts 5 minutes and 1 ms off: clock_skew");
  ok(errorOf(await ask(h, { sigOpts: { gen: "2" } })) === "bad_form", "R-5: gen other than 1: bad_form");
  ok(errorOf(await ask(h, { sigOpts: { agent: core.newId() } })) === "bad_form", "R-6: an agent in the header: bad_form");
  const nonce = core.b64(core.random(16));
  const first = await ask(h, { sigOpts: { nonce } });
  ok(first.status === 200, "R-7: (a first request)");
  ok(errorOf(await ask(h, { sigOpts: { nonce } })) === "replay", "R-8: the same nonce again: replay");
  const bad = await hostOf();
  const zeroFp = core.b64(await core.hostFingerprint(bad.host, bad.K.raw, new Uint8Array(32)));
  for (const [what, mut] of [
    ["a fingerprint that isn't the keys'", (b) => ({ ...b, fingerprint: core.b64(core.random(32)) })],
    ["an all-zero enc_key (its fingerprint recomputed, so only the zero check refuses it)", (b) => ({ ...b, enc_key: core.b64(new Uint8Array(32)), fingerprint: zeroFp })],
    ["a name with a space", (b) => ({ ...b, name: "lab box" })],
    ["a name of 33 characters", (b) => ({ ...b, name: "a".repeat(33) })],
    ["a reserved name", (b) => ({ ...b, name: "con" })],
    ["an extra field", (b) => ({ ...b, extra: 1 })],
    ["a missing field", ({ name, ...b }) => b],
    ["a host that isn't an id", (b) => ({ ...b, host: "X" })],
  ]) {
    const body = JSON.stringify(mut(bad.body()));
    ok(errorOf(await ask(bad, { body })) === "bad_form", `R-9: ${what}: bad_form`);
  }
  ok(errorOf(await ask(bad, { body: JSON.stringify({ ...bad.body(), name: "x".repeat(4096) }) })) === "limit", "R-10: a body over 4 KiB: limit");
  // (a host id already certified through no pairing: never rebound)
  const direct = await hostOf();
  await db.prepare("INSERT INTO fleet_hosts (host, fleet, sign_key, fingerprint, revoked) VALUES (?1, ?2, ?3, ?4, 0)").bind(direct.host, happy.f.fleet, core.b64(direct.K.raw), direct.fingerprint).run();
  ok(errorOf(await ask(direct)) === "bad_form", "R-11: a host id already in fleet_hosts without a pairing: bad_form");
}

// ---- I: idempotent create (§0, P2)
{
  const { h, pairing, code } = await asked();
  const again = await ask(h);
  ok(again.status === 200 && again.json.pairing === pairing && again.json.code !== code && again.json.expires_at_ms === NOW + 600_000, "I-1: a re-POST: the same pairing and expiry, a new code", again.json);
  const f = await fleetOf();
  ok(errorOf(await lookupAs(f.account, code)) === "not_found", "I-2: the old code is dead at once");
  ok((await lookupAs(f.account, again.json.code)).json?.pairing === pairing, "I-3: the new code finds the pairing");
  ok((await all("SELECT * FROM fleet_pairings WHERE host = ?1", h.host)).length === 1, "I-4: still one row for the host id");
  const other = await key();
  ok(errorOf(await ask(h, { body: JSON.stringify({ ...h.body(), sign_key: core.b64(other.raw), fingerprint: core.b64(await core.hostFingerprint(h.host, other.raw, h.encRaw)) }), K: other })) === "bad_form",
    "I-5: the same host id with other keys: bad_form");
  const re = await ask(happy.h);
  ok(re.json?.state === "approved" && re.json.pairing === happy.pairing, "I-6: a re-POST after approval answers {pairing, state: approved}", re.json);
  // (an approval in flight across a code rotation still succeeds: approve goes by pairing, not by code)
  const g = await asked();
  const ap = await approvalOf(f, g.h, g.pairing), cert = await certOf(f, g.h);
  await ask(g.h);
  ok((await approveAs(f, { pairing: g.pairing, approval: ap, cert })).status === 200, "I-7: an approve in flight across a code rotation succeeds");
  // (two first requests racing for one host id: one row, both answers name it)
  const r = await hostOf();
  const [a, b] = await Promise.all([ask(r), ask(r)]);
  ok(a.status === 200 && b.status === 200 && a.json.pairing === b.json.pairing && (await all("SELECT * FROM fleet_pairings WHERE host = ?1", r.host)).length === 1,
    "I-8: two first requests racing: one row, both name it", { a: a.json, b: b.json });
}

// ---- X: expiry and tombstones (P2)
{
  const { h, pairing, code } = await asked();
  const later = NOW + 600_000;
  ok((await pollOf(h, pairing, { now: later })).json?.state === "expired", "X-1: the poll answers expired at expires_at_ms");
  const re = await ask(h, { now: later + 1 });
  ok(re.json?.state === "expired" && re.json.pairing === pairing && re.json.code === undefined, "X-2: a re-POST after expiry answers expired: no new pairing, no code", re.json);
  // (another request sweeps: the row becomes a tombstone, its code cleared)
  await ask(await hostOf(), { now: later + 2 });
  const row = await one("SELECT code_hash FROM fleet_pairings WHERE pairing = ?1", pairing);
  ok(row && row.code_hash === null, "X-3: the expired row is a tombstone: its code cleared", row);
  const f = await fleetOf();
  ok(errorOf(await lookupAs(f.account, code, { "x-test-now": String(later + 3) })) === "not_found", "X-4: the tombstone's code finds nothing");
  ok((await ask(h, { now: later + 3 })).json?.state === "expired" && (await pollOf(h, pairing, { now: later + 3 })).json?.state === "expired", "X-5: after the sweep, a re-POST and a poll still answer expired");
  const day30 = NOW + 600_000 + P.PAIRING_TOMBSTONE_MS;
  await ask(await hostOf(), { now: day30 + 10 });
  ok((await one("SELECT 1 AS x FROM fleet_pairings WHERE pairing = ?1", pairing)) === null, "X-6: the tombstone is deleted 30 days after the expiry");
  const fresh = await asked();
  ok(fresh.pairing !== pairing, "X-7: a NEW host id makes a new pairing");
  // (an approve after the expiry)
  const g = await asked();
  ok(errorOf(await approveAs(f, { pairing: g.pairing, approval: await approvalOf(f, g.h, g.pairing, { at: NOW + 600_000, auth: NOW + 600_000 }), cert: await certOf(f, g.h) }, { now: NOW + 600_000 })) === "not_found",
    "X-8: an approve at expires_at_ms: not_found");
}

// ---- L: limits
{
  const src = { "cf-connecting-ip": "203.0.113.9" };
  const hs = [];
  for (let i = 0; i < 6; i++) hs.push(await hostOf());
  const rs = [];
  for (const h of hs) rs.push(await ask(h, { seam: src }));
  ok(rs.slice(0, 5).every((r) => r.status === 200) && errorOf(rs[5]) === "limit", "L-1: the 6th live pairing from one source: limit", rs.map((r) => r.status));
  const src2 = { "cf-connecting-ip": "203.0.113.10" };
  let last;
  for (let i = 0; i < 11; i++) { const h = await hostOf(); last = await ask(h, { seam: src2, now: NOW + 600_001 + i }); }
  ok(errorOf(last) === "rate", "L-2: the 11th request in an hour from one source: rate", last.json);
  const lowered = await ask(await hostOf(), { seam: { "x-test-pairing-total": "1", "cf-connecting-ip": "203.0.113.11" } });
  ok(errorOf(lowered) === "limit", "L-3: the total cap of live pairings (lowered through a seam): limit");
  const g = await asked();
  let p;
  for (let i = 0; i < 31; i++) p = await pollOf(g.h, g.pairing);
  ok(errorOf(p) === "rate", "L-4: the 31st poll in a minute: rate");
  const f = await fleetOf();
  let l;
  for (let i = 0; i < 11; i++) l = await lookupAs(f.account, "aaaaaaaa");
  ok(errorOf(l) === "rate", "L-5: the 11th lookup in a minute from one account: rate");
}

// ---- Q: the poll's answers to the wrong asker
{
  const g = await asked(), other = await asked();
  ok(errorOf(await pollOf(g.h, g.pairing, { K: await key() })) === "not_found", "Q-1: a poll signed by another key: not_found");
  ok(errorOf(await pollOf(other.h, g.pairing)) === "not_found", "Q-2: the right key for ANOTHER pairing: not_found");
  ok(errorOf(await pollOf(g.h, core.newId())) === "not_found", "Q-3: an unknown pairing: not_found");
}

// ---- A: approve
{
  const f = await fleetOf(), f2 = await fleetOf();
  const g = await asked();
  const cert = await certOf(f, g.h);
  ok(errorOf(await call("/api/fleet/v1/pairings/approve", { body: "{}" })) === "unauthenticated", "A-1: no session: unauthenticated");
  ok(errorOf(await approveAs({ account: "acct-nofleet" }, { pairing: g.pairing, approval: "{}", cert: "{}" })) === "no_fleet", "A-2: an account with no fleet: no_fleet");
  ok(errorOf(await approveAs(f2, { pairing: g.pairing, approval: await approvalOf(f2, g.h, g.pairing), cert })) === "not_granted", "A-3: a cert for another account's fleet: not_granted");
  ok(errorOf(await approveAs(f, { pairing: g.pairing, approval: await approvalOf(f, g.h, core.newId()), cert })) === "approval_mismatch", "A-4: an approval for another pairing: approval_mismatch");
  const swapped = { ...subjectOf(g.h), name: "evil-box" };
  ok(errorOf(await approveAs(f, { pairing: g.pairing, approval: await approvalOf(f, g.h, g.pairing, { subject: swapped }), cert })) === "approval_mismatch", "A-5: an approval naming other than the stored host: approval_mismatch");
  ok(errorOf(await approveAs(f, { pairing: g.pairing, approval: await approvalOf(f, g.h, g.pairing, { auth: NOW - 300_001 }), cert })) === "stale_auth", "A-6: a sign-in older than 5 minutes: stale_auth");
  const otherH = await hostOf();
  ok(errorOf(await approveAs(f, { pairing: g.pairing, approval: await approvalOf(f, g.h, g.pairing), cert: await certOf(f, otherH) })) === "approval_mismatch", "A-7: a cert naming other keys: approval_mismatch");
  // (an approval spent on a claim whose pairHost failed is never accepted again)
  const g2 = await asked();
  const used = await approvalOf(f, g2.h, g2.pairing);
  const fail = await approveAs(f, { pairing: g2.pairing, approval: used, cert: await certOf(f, g2.h, { chain_seq: 99 }) });
  ok(fail.status !== 200, "A-8: (a cert pairHost refuses, after the claim)", fail.json);
  ok(errorOf(await approveAs(f, { pairing: g2.pairing, approval: used, cert: await certOf(f, g2.h) })) === "approval_used", "A-9: that approval again: approval_used");
  ok((await pollOf(g2.h, g2.pairing)).json?.state === "pending", "A-10: the pairing is still pending, its claim released");
  ok((await approveAs(f, { pairing: g2.pairing, approval: await approvalOf(f, g2.h, g2.pairing), cert: await certOf(f, g2.h) })).status === 200, "A-11: a NEW approval then certifies it");
  ok(errorOf(await approveAs(f, { pairing: g2.pairing, approval: await approvalOf(f, g2.h, g2.pairing), cert: await certOf(f, g2.h) })) === "not_found", "A-12: approving an already-approved pairing: not_found");
}

// ---- C: the single-winner claim (P1)
{
  // (two accounts racing, both verified: exactly one certificate, in the winner's fleet; the loser's approval unspent)
  const fa = await fleetOf(), fb = await fleetOf();
  const g = await asked();
  const [ra, rb] = await Promise.all([
    approveAs(fa, { pairing: g.pairing, approval: await approvalOf(fa, g.h, g.pairing), cert: await certOf(fa, g.h) }, { seam: "wait-before-claim:50" }),
    approveAs(fb, { pairing: g.pairing, approval: await approvalOf(fb, g.h, g.pairing), cert: await certOf(fb, g.h) }, { seam: "wait-before-claim:50" }),
  ]);
  const wins = [ra, rb].filter((r) => r.status === 200);
  const certs = await all("SELECT fleet FROM fleet_host_certs WHERE host = ?1", g.h.host);
  ok(wins.length === 1 && certs.length === 1 && certs[0].fleet === wins[0].json.fleet, "C-1: two accounts racing: exactly one certificate, in the winner's fleet", { ra: ra.json, rb: rb.json, certs });
  const loser = ra.status === 200 ? rb : ra;
  ok(["in_progress", "not_found"].includes(errorOf(loser)), "C-2: the loser is refused in_progress (or not_found once certified)", loser.json);
  ok((await all("SELECT approval FROM fleet_pairing_approvals WHERE pairing = ?1", g.pairing)).length === 1, "C-3: only the winner's approval was spent");
  ok((await one("SELECT fleet FROM fleet_pairings WHERE pairing = ?1", g.pairing))?.fleet === wins[0].json.fleet, "C-4: the pairing's fleet is the winner's");
  // (ten racers)
  const g10 = await asked();
  const fs = [];
  for (let i = 0; i < 10; i++) fs.push(await fleetOf());
  const bodies = await Promise.all(fs.map(async (f) => ({ f, body: { pairing: g10.pairing, approval: await approvalOf(f, g10.h, g10.pairing), cert: await certOf(f, g10.h) } })));
  const rs = await Promise.all(bodies.map(({ f, body }) => approveAs(f, body)));
  ok(rs.filter((r) => r.status === 200).length === 1 && (await all("SELECT fleet FROM fleet_host_certs WHERE host = ?1", g10.h.host)).length === 1, "C-5: ten racers: one certificate", rs.map((r) => r.status));
  // (a holder that dies holding the claim: in_progress until the lease lapses, then a second approval certifies)
  const f = await fleetOf();
  const gd = await asked();
  const dead = await approveAs(f, { pairing: gd.pairing, approval: await approvalOf(f, gd.h, gd.pairing), cert: await certOf(f, gd.h) }, { seam: "die-after-claim" });
  ok(dead.status === 503, "C-6: (the holder dies after its claim)", dead);
  ok(errorOf(await approveAs(f, { pairing: gd.pairing, approval: await approvalOf(f, gd.h, gd.pairing), cert: await certOf(f, gd.h) })) === "in_progress", "C-7: a second approval within the lease: in_progress");
  const lapsed = NOW + 60_001;
  const second = await approveAs(f, { pairing: gd.pairing, approval: await approvalOf(f, gd.h, gd.pairing, { at: lapsed, auth: lapsed }), cert: await certOf(f, gd.h) }, { now: lapsed });
  ok(second.status === 200, "C-8: after the lease lapses, a second approval claims and certifies", second.json);
  // (a holder that dies AFTER pairHost: the cert stands; a later approval is not_found; the poll answers approved)
  const ga = await asked();
  const late = await approveAs(f, { pairing: ga.pairing, approval: await approvalOf(f, ga.h, ga.pairing), cert: await certOf(f, ga.h) }, { seam: "die-after-pair" });
  ok(late.status === 503, "C-9: (the holder dies after pairing)");
  ok(errorOf(await approveAs(f, { pairing: ga.pairing, approval: await approvalOf(f, ga.h, ga.pairing), cert: await certOf(f, ga.h) })) === "not_found", "C-10: a later approval: not_found (the cert stands)");
  ok((await pollOf(ga.h, ga.pairing)).json?.state === "approved", "C-11: the poll answers approved (derived from the cert)");
}

// ---- W: the state is the pairing's own key's certificate, not any certificate under its host id
{
  const g = await asked();
  const other = await key(), f = await fleetOf();
  await db.prepare("INSERT INTO fleet_hosts (host, fleet, sign_key, fingerprint, revoked) VALUES (?1, ?2, ?3, ?4, 0)").bind(g.h.host, f.fleet, core.b64(other.raw), core.b64(core.random(32))).run();
  await db.prepare("INSERT INTO fleet_host_certs (fleet, host, cert, bytes) VALUES (?1, ?2, ?3, '{}')").bind(f.fleet, g.h.host, core.b64(core.random(32))).run();
  ok((await pollOf(g.h, g.pairing)).json?.state === "pending", "W-1: a certificate for the host id under OTHER keys doesn't approve this pairing");
}

// ---- E: an approve for an expired pairing is not_found before any approval check
{
  const f = await fleetOf();
  const g = await asked();
  const late = NOW + 600_000;
  ok(errorOf(await approveAs(f, { pairing: g.pairing, approval: await approvalOf(f, g.h, core.newId(), { at: late, auth: late }), cert: await certOf(f, g.h) }, { now: late })) === "not_found",
    "E-1: an expired pairing with a mismatched approval: not_found (the pairing is checked first)");
}

// ---- U: a spent approval is refused even while another approve holds the claim
{
  const f = await fleetOf();
  const g = await asked();
  const spent = await approvalOf(f, g.h, g.pairing);
  await approveAs(f, { pairing: g.pairing, approval: spent, cert: await certOf(f, g.h, { chain_seq: 99 }) });
  await approveAs(f, { pairing: g.pairing, approval: await approvalOf(f, g.h, g.pairing), cert: await certOf(f, g.h) }, { seam: "die-after-claim" });
  ok(errorOf(await approveAs(f, { pairing: g.pairing, approval: spent, cert: await certOf(f, g.h) })) === "approval_used", "U-1: a spent approval while another claim is live: approval_used, not in_progress");
}

// ---- Z: a slow holder's late release never clears a newer holder's claim
{
  const fa = await fleetOf(), fb = await fleetOf();
  const g = await asked();
  const lapsed = NOW + 60_001;
  // (A claims, waits past its lease, then fails in pairHost and releases; meanwhile B claims after the lapse and waits)
  const a = approveAs(fa, { pairing: g.pairing, approval: await approvalOf(fa, g.h, g.pairing), cert: await certOf(fa, g.h, { chain_seq: 99 }) }, { seam: "wait-after-claim:400" });
  await new Promise((r) => setTimeout(r, 150));
  const bBody = { pairing: g.pairing, approval: await approvalOf(fb, g.h, g.pairing, { at: lapsed, auth: lapsed }), cert: await certOf(fb, g.h) };
  const b = approveAs(fb, bBody, { now: lapsed, seam: "wait-after-claim:900" });
  await a;
  await new Promise((r) => setTimeout(r, 200));
  const mid = await one("SELECT claim_account FROM fleet_pairings WHERE pairing = ?1", g.pairing);
  ok(mid?.claim_account === fb.account, "Z-1: after A's late release, B's claim still stands", mid);
  ok((await b).status === 200, "Z-2: B then certifies");
}

// ---- V: a revoked host
{
  const { h, pairing } = happy;
  await db.prepare("UPDATE fleet_hosts SET revoked = 1 WHERE host = ?1").bind(h.host).run();
  ok((await pollOf(h, pairing)).json?.state === "expired", "V-1: a revoked host's poll answers expired");
  ok((await ask(h)).json?.state === "expired", "V-2: and its re-POST answers expired");
}

// ---- G: a holder whose lease lapsed can still be running (a Worker's 30 s limit is CPU time), so two holders can both
// reach pairHost; the host still lands in exactly one fleet, because fleet_hosts.host is a global key (SEC N1)
for (const order of ["B-first", "A-first"]) {
  const fa = await fleetOf(), fb = await fleetOf();
  const g = await asked();
  const lapsed = NOW + P.PAIRING_CLAIM_MS + 1;
  // (A claims first and holds past its lease; B claims after the lapse. B-first: B's pairHost runs before A's; A-first:
  // A's runs before B's)
  const aWait = order === "B-first" ? 700 : 300, bWait = order === "B-first" ? 0 : 900;
  const a = approveAs(fa, { pairing: g.pairing, approval: await approvalOf(fa, g.h, g.pairing), cert: await certOf(fa, g.h) }, { seam: `wait-after-claim:${aWait}` });
  await new Promise((r) => setTimeout(r, 150));
  const b = approveAs(fb, { pairing: g.pairing, approval: await approvalOf(fb, g.h, g.pairing, { at: lapsed, auth: lapsed }), cert: await certOf(fb, g.h) },
    bWait ? { now: lapsed, seam: `wait-after-claim:${bWait}` } : { now: lapsed });
  const [ra, rb] = await Promise.all([a, b]);
  const winner = order === "B-first" ? fb : fa, [win, lose] = order === "B-first" ? [rb, ra] : [ra, rb];
  const hosts = await all("SELECT fleet FROM fleet_hosts WHERE host = ?1", g.h.host), certs = await all("SELECT fleet FROM fleet_host_certs WHERE host = ?1", g.h.host);
  ok(hosts.length === 1 && certs.length === 1 && hosts[0].fleet === winner.fleet && certs[0].fleet === winner.fleet, `G-${order}-1: the host is in exactly one fleet, the first pairHost's`, { hosts, certs });
  ok(win.status === 200 && lose.status !== 200, `G-${order}-2: the first pairHost succeeds and the late one is refused`, { ra, rb });
  ok((await one("SELECT claim FROM fleet_pairings WHERE pairing = ?1", g.pairing))?.claim === null, `G-${order}-3: no claim is left behind`);
  const st = (await pollOf(g.h, g.pairing, { now: lapsed + 10 })).json;
  ok(st?.state === "approved" && st?.fleet === winner.fleet, `G-${order}-4: the poll names that fleet`, st);
}

// ---- T: the claim reads the clock afresh: an approve's checks await reads, so time passes before its claim. The claim
// re-checks the pairing's expiry inside its own SQL at that sample, and the approval's window and sign-in age; the lease
// and the loser's answer run from it too. Each row has a twin one millisecond short of the edge, which certifies.
{
  const certs = async (h) => (await all("SELECT host FROM fleet_host_certs WHERE host = ?1", h.host)).length;
  const go = async (o, advance, seam) => {
    const f = await fleetOf(), g = await asked();
    const r = await approveAs(f, { pairing: g.pairing, approval: await approvalOf(f, g.h, g.pairing, o), cert: await certOf(f, g.h) }, { now: NOW, advance, ...(seam ? { seam } : {}) });
    return { r, g, f };
  };
  // (an approval at NOW + 5 min, fresh enough at NOW and still at NOW + 10 min: only the pairing's expiry decides)
  const late = { at: NOW + 300_000, auth: NOW + 300_000 };
  const x = await go(late, 600_000);
  ok(x.r.status === 404 && x.r.json?.error === "not_found" && (await certs(x.g.h)) === 0, "T-1: the pairing expires between the checks and the claim: not_found, no certificate", x.r.json);
  const xt = await go(late, 599_999);
  ok(xt.r.status === 200 && (await certs(xt.g.h)) === 1, "T-1: its twin, 1 ms before the expiry: certified", xt.r.json);
  const spent = (await all("SELECT at_ms FROM fleet_pairing_approvals WHERE pairing = ?1", xt.g.pairing))[0];
  ok(spent?.at_ms === NOW + 599_999, "T-2: the approval is spent at the claim's own sample", spent);
  const w = await go({ at: NOW - 300_000, auth: NOW }, 300_000);
  ok(w.r.status === 403 && w.r.json?.error === "approval_stale" && (await certs(w.g.h)) === 0, "T-3: the approval's window ends before the claim: approval_stale", w.r.json);
  const wt = await go({ at: NOW - 300_000, auth: NOW }, 299_999);
  ok(wt.r.status === 200, "T-3: its twin: certified", wt.r.json);
  const a = await go({ at: NOW, auth: NOW - 299_999 }, 2);
  ok(a.r.status === 401 && a.r.json?.error === "stale_auth" && (await certs(a.g.h)) === 0, "T-4: the sign-in passes 5 minutes old before the claim: stale_auth", a.r.json);
  const at = await go({ at: NOW, auth: NOW - 299_999 }, 1);
  ok(at.r.status === 200, "T-4: its twin: certified", at.r.json);
  // (the checks' own sample still decides first: a sign-in time more than 5 minutes ahead at the checks is refused there,
  // though it would be within 5 minutes of the later claim)
  const ahead = await go({ at: NOW, auth: NOW + 300_001 }, 2);
  ok(ahead.r.status === 401 && ahead.r.json?.error === "stale_auth" && (await certs(ahead.g.h)) === 0, "T-4: a sign-in time 5 min + 1 ms ahead at the checks: stale_auth, before the claim", ahead.r.json);
  const d = await go({}, 1000, "die-after-claim");
  const held = (await all("SELECT claim_until_ms FROM fleet_pairings WHERE pairing = ?1", d.g.pairing))[0];
  ok(held?.claim_until_ms === NOW + 1000 + P.PAIRING_CLAIM_MS, "T-5: the lease runs from the claim's sample", held);
  // (a second approve whose checks ran inside the first's lease, and whose claim comes after it: it claims)
  const f2 = await fleetOf();
  const next = await approveAs(f2, { pairing: d.g.pairing, approval: await approvalOf(f2, d.g.h, d.g.pairing), cert: await certOf(f2, d.g.h) }, { now: NOW + 59_000, advance: 1_001 + 60_000 - 59_000 });
  ok(next.status === 200 && (await certs(d.g.h)) === 1, "T-6: checks inside another's lease, the claim after it: claims and certifies", next.json);
  const g3 = await go({}, 1000, "die-after-claim"), f3 = await fleetOf();
  const busy = await approveAs(f3, { pairing: g3.g.pairing, approval: await approvalOf(f3, g3.g.h, g3.g.pairing), cert: await certOf(f3, g3.g.h) }, { now: NOW + 59_000, advance: 1_999 });
  ok(busy.status === 409 && busy.json?.error === "in_progress", "T-6: its twin, claiming 1 ms before the lease ends: in_progress", busy.json);
}

// ---- S: the session and the method
{
  ok((await call("/api/fleet/v1/pairings/lookup", { body: "{}", headers: { "x-test-account": "a", "x-test-session": "unavailable" } })).status === 503, "S-1: a session that can't be checked: 503");
  ok((await call("/api/fleet/v1/host/pair", { method: "GET" })).status === 405, "S-2: GET: 405");
  ok(errorOf(await lookupAs("acct-x", "abc")) === "bad_form", "S-3: a code that isn't 8 characters of a-z2-7: bad_form");
}

// ---- N: without the lease seed there is no code key, so the routes are unavailable
{
  const bare = new Miniflare(convertV4MiniflareOptions({ workers: [{ name: "fleet", modules: true, script, compatibilityDate: "2026-10-01", d1Databases: ["FLEET_DB"], bindings: { FLEET_AUD: AUD } }] }));
  // (its database migrated as the main one, so the 503 can only be the missing seed)
  const bareDb = await bare.getD1Database("FLEET_DB");
  for (const m of MIGRATIONS) for (const stmt of readFileSync(join(here, "migrations", m), "utf8").replace(/--[^\n]*/g, "").split(";").map((s) => s.trim()).filter(Boolean)) await bareDb.prepare(stmt).run();
  const h = await hostOf();
  const body = JSON.stringify(h.body()), headers = { "x-test-now": String(NOW), "sagebrush-sig": await sig(h.host, h.K, "/api/fleet/v1/host/pair", body) };
  const r = await dispatch(bare, SITE + "/api/fleet/v1/host/pair", { method: "POST", headers, body });
  ok(r.status === 503, "N-1: a well-signed request to a Worker without LEASE_KEY_SEED: 503", r.status);
  await bare.dispose();
}

console.log(`${count - failures}/${count} passed`);
await mf.dispose();
process.exit(failures ? 1 : 0);
