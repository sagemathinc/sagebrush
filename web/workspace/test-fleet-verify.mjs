// ci: web-runner order=354 runner=bun chrome
// What the page verifies about an Autonomous fleet (fleet-verify.ts; app pairing r4 §2, F7, F8), in headless Chromium
// with real WebCrypto and IndexedDB: the chain against this browser's pin (the pin moves only after the whole chain
// verified; a fork or a rollback is recorded for good), a host's certificate, the grants and the host's acks of them,
// on the agent's own fixtures. Each case starts from a reset device, since the fixtures share one fleet.
//   CHROME=google-chrome bun web/workspace/test-fleet-verify.mjs
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { browser } from "../agents/a14-cases.mjs";

const here = new URL(".", import.meta.url).pathname;
let failures = 0;
const ok = (c, msg, detail) => { console.log((c ? "ok   " : "FAIL ") + msg + (!c && detail !== undefined ? "  " + JSON.stringify(detail).slice(0, 600) : "")); if (!c) failures++; };

// ---- the module's own text: it verifies, it doesn't sign
const src = readFileSync(join(here, "fleet-verify.ts"), "utf8");
const signing = src.replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, "").match(/\b(?:seal\w*|sign(?!Raw\b)\w*|keyFromSeed|recoveryKey|newRecoveryCode|setupSender|hpkeSeal|makeDeviceKey|asKey)\b/g);
// (signRaw is a verified host certificate's PUBLIC signing key, which hostFingerprintShown reads; it signs nothing)
ok(!signing, "S-2: fleet-verify.ts names no signing or key-making function of the core or fleet-device (comments aside; signRaw, a certificate's public key, allowed)", signing);

const dir = mkdtempSync(join(tmpdir(), "sb-fleet-verify-"));
const entry = join(dir, "entry.ts");
writeFileSync(entry, [
  `export * as fv from ${JSON.stringify(join(here, "fleet-verify.ts"))};`,
  `export { advancePin, advancePinOnChain, pin, resetDevice } from ${JSON.stringify(join(here, "fleet-device.ts"))};`,
].join("\n"));
const built = await Bun.build({ entrypoints: [entry], target: "browser", format: "esm" });
rmSync(dir, { recursive: true, force: true });
if (!built.success) throw new Error("fleet-verify.ts didn't build: " + built.logs.join("\n"));
const js = await built.outputs[0].text();
const fixtures = readFileSync(join(here, "fleet", "fleet-fixtures.json"));
const F = JSON.parse(fixtures.toString("utf8"));
const html = `<!doctype html><script type="module">import * as m from "/fv.js"; window.m = m; window.F = await (await fetch("/fixtures.json")).json(); window.ready = true;</script>`;
const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (r) => {
  const p = new URL(r.url).pathname;
  if (p === "/fv.js") return new Response(js, { headers: { "content-type": "text/javascript" } });
  if (p === "/fixtures.json") return new Response(fixtures, { headers: { "content-type": "application/json" } });
  return new Response(html, { headers: { "content-type": "text/html" } });
} });
const site = `http://127.0.0.1:${server.port}`;
const B = await browser();
const settle = async (P, before) => { for (const t = Date.now(); P.loads === before && Date.now() - t < 10000; ) await new Promise((r) => setTimeout(r, 50)); await P.until(`window.ready === true`, 10000); };
const page = async () => { const P = await B.tab(); const n = P.loads; await P.send("Page.navigate", { url: site + "/" }); await settle(P, n); await P.ev(`m.resetDevice(F.ids.fleet).then(() => true)`); return P; };
// (each call's refusal as the core's reason code, or null when it resolves)
const code = (P, expr) => P.ev(`(async () => { try { await (${expr}); return null; } catch (e) { return e?.code ?? String(e?.message ?? e); } })()`);
const CTX = `{ aud: F.aud, fleet: F.ids.fleet }`;
const honest = F.chain.cases.find((c) => c.name === "the honest chain replays");
const extend = F.chain.cases.find((c) => c.name === "a native device removes the browser one");
const bad = F.chain.cases.find((c) => c.name === "a browser device adds a native one");
const H = (c) => c.repeat(42) + "A";
try {
  ok(honest && extend?.expect === "ok" && extend.append && bad?.expect === "device_tier", "the fixtures have the honest chain, a valid next entry and a refused one");
  const E = (c, more = []) => JSON.stringify([...c.entries, ...more]);
  {
    const P = await page();
    const r = await P.ev(`m.fv.syncChain(${CTX}, ${E(honest)}).then(async (c) => ({ seq: c.seq, hash: c.hashes[c.seq], pin: await m.pin(F.ids.fleet) }))`);
    ok(r.pin && r.pin.seq === r.seq && r.pin.hash === r.hash && r.pin.forked === false, "V-1: a first sync verifies the chain and pins its head", r);
    const again = await P.ev(`m.fv.syncChain(${CTX}, ${E(honest)}).then(async (c) => (await m.pin(F.ids.fleet)).seq)`);
    ok(again === r.seq, "V-2: the same chain again: the pin stays");
    const next = await P.ev(`m.fv.syncChain(${CTX}, ${E(honest, [extend.append])}).then(async (c) => ({ seq: c.seq, pin: await m.pin(F.ids.fleet) }))`);
    ok(next.seq === r.seq + 1 && next.pin.seq === r.seq + 1 && next.pin.forked === false, "V-2: a chain one entry longer: the pin moves to its head", next);
    // (the service now shows the shorter list: a rollback behind the pin)
    ok((await code(P, `m.fv.syncChain(${CTX}, ${E(honest)})`)) === "chain_fork", "V-3: a chain behind the pin is refused (chain_fork)");
    ok((await P.ev(`m.pin(F.ids.fleet)`)).forked === true, "V-3: and the fleet is marked forked here");
    ok((await code(P, `m.fv.syncChain(${CTX}, ${E(honest, [extend.append])})`)) === "chain_fork", "V-3: a forked fleet stays refused, even with the list it had pinned (only Reset gets out)");
    ok((await code(P, `m.fv.syncChain(${CTX}, ${E(honest, [bad.append])})`)) === "chain_fork", "V-3: a forked device refuses before verifying anything: even a bad list answers chain_fork, not the entry's own reason");
    await P.ev(`m.resetDevice(F.ids.fleet).then(() => true)`);
    ok((await code(P, `m.fv.syncChain(${CTX}, ${E(honest)})`)) === null && (await P.ev(`m.pin(F.ids.fleet)`)).forked === false, "V-6: after Reset this device, a sync starts a fresh pin");
  }
  {
    // (this device had pinned another history at seq 1: the honest chain conflicts with it there)
    const P = await page();
    await P.ev(`m.advancePin(F.ids.fleet, { seq: 1, hash: ${JSON.stringify(H("Q"))} }).then(() => true)`);
    ok((await code(P, `m.fv.syncChain(${CTX}, ${E(honest)})`)) === "chain_fork", "V-4: a chain with another entry at the pinned seq is refused (chain_fork)");
    const p = await P.ev(`m.pin(F.ids.fleet)`);
    ok(p.forked === true && p.seq === 1 && p.hash === H("Q"), "V-4: marked forked; the pin itself is unchanged", p);
  }
  {
    // (a chain with an entry the core refuses: the reason is the core's, and the pin stays where it was)
    const P = await page();
    const head = await P.ev(`m.fv.syncChain(${CTX}, ${E(honest)}).then(() => m.pin(F.ids.fleet))`);
    ok((await code(P, `m.fv.syncChain(${CTX}, ${E(honest, [bad.append])})`)) === "device_tier", "V-5: a chain with a refused entry is refused with the core's reason (device_tier)");
    const after = await P.ev(`m.pin(F.ids.fleet)`);
    ok(after.seq === head.seq && after.hash === head.hash && after.forked === false, "V-5: and the pin hasn't moved (nor is the fleet forked)", { head, after });
  }
  {
    // (the objects' chain, its host certificate and the grants: the module's answers are the fixtures')
    const P = await page();
    const cert = await code(P, `(async () => { const c = await m.fv.syncChain(${CTX}, F.objects.chain); window.CH = c; window.CERT = await m.fv.verifyHostCert(${CTX}, c, F.objects.host_cert); })()`);
    ok(cert === null, "V-7: the host certificate verifies against the synced chain", cert);
    const changed = F.objects.host_cert.replace(/"name":"/, '"name":"x');
    const tampered = await code(P, `m.fv.verifyHostCert(${CTX}, CH, ${JSON.stringify(changed)})`);
    ok(changed !== F.objects.host_cert && tampered !== null, "V-7: a certificate with a changed byte is refused", tampered);
    const g = await P.ev(`(async () => { const bad = []; for (const c of F.objects.grants) { const cur = c.current && { gen: c.current.gen, bytes: new TextEncoder().encode(c.current.bytes), body: JSON.parse(c.current.bytes).body };
      let got; try { await m.fv.verifyGrant(${CTX}, CH, CERT, c.bytes, cur ?? null, F.now_ms); got = "ok"; } catch (e) { got = e?.code ?? String(e); } if (got !== c.expect) bad.push({ name: c.name, got, expect: c.expect }); } return { n: F.objects.grants.length, bad }; })()`);
    ok(g.n === 11 && g.bad.length === 0, `V-8: all ${g.n} of the agent's grant cases get the fixtures' answer through verifyGrant`, g);
    const a = await P.ev(`(async () => { const bad = []; for (const c of F.objects.grant_acks) {
      let got; try { await m.fv.verifyGrantAck(${CTX}, CERT, c.bytes, c.current_gen); got = "ok"; } catch (e) { got = e?.code ?? String(e); } if (got !== c.expect) bad.push({ name: c.name, got, expect: c.expect }); } return { n: F.objects.grant_acks.length, bad, refused: F.objects.grant_acks.filter((c) => c.expect !== "ok").length }; })()`);
    ok(a.n === 7 && a.refused === 5 && a.bad.length === 0, `V-16: all ${a.n} of the agent's grant-ack cases (${a.refused} refused) get the fixtures' answer through verifyGrantAck`, a);
  }
  // ---- when this browser can't store the pin or the fork mark: storage_failed, never a fork it didn't record
  // (IDBObjectStore.put made to throw QuotaExceededError, or to drop the write silently; restored afterwards)
  const PUT_THROWS = `(window.realPut ??= IDBObjectStore.prototype.put, IDBObjectStore.prototype.put = function () { throw new DOMException("full", "QuotaExceededError"); }, true)`;
  const PUT_DROPS = `(window.realPut ??= IDBObjectStore.prototype.put, IDBObjectStore.prototype.put = function () { return {}; }, true)`;
  const PUT_OK = `(IDBObjectStore.prototype.put = window.realPut, true)`;
  {
    const P = await page();
    await P.ev(`m.fv.syncChain(${CTX}, ${E(honest, [extend.append])}).then(() => true)`);
    const before = await P.ev(`m.pin(F.ids.fleet)`);
    await P.ev(PUT_THROWS);
    const r = await code(P, `m.fv.syncChain(${CTX}, ${E(honest)})`);
    await P.ev(PUT_OK);
    const after = await P.ev(`m.pin(F.ids.fleet)`);
    ok(r === "storage_failed" && after.seq === before.seq && after.forked === false, "V-9: a rollback the browser can't record (put throws): storage_failed, not chain_fork; nothing was recorded", { r, before, after });
    ok((await code(P, `m.fv.syncChain(${CTX}, ${E(honest)})`)) === "chain_fork" && (await P.ev(`m.pin(F.ids.fleet)`)).forked === true, "V-9: once storage works, the same rollback is refused and recorded as a fork");
  }
  {
    // (the write silently dropped: advancePin's own refusal comes back, but the read-back finds no fork mark)
    const P = await page();
    await P.ev(`m.advancePin(F.ids.fleet, { seq: 1, hash: ${JSON.stringify(H("Q"))} }).then(() => true)`);
    await P.ev(PUT_DROPS);
    const r = await code(P, `m.fv.syncChain(${CTX}, ${E(honest)})`);
    await P.ev(PUT_OK);
    const p = await P.ev(`m.pin(F.ids.fleet)`);
    ok(r === "storage_failed" && p.forked === false && p.hash === H("Q"), "V-10: a fork whose mark didn't reach storage (write dropped): storage_failed, a fork is claimed only when read back", { r, p });
  }
  {
    const P = await page();
    const head = await P.ev(`m.fv.syncChain(${CTX}, ${E(honest)}).then(() => m.pin(F.ids.fleet))`);
    await P.ev(PUT_THROWS);
    const r = await code(P, `m.fv.syncChain(${CTX}, ${E(honest, [extend.append])})`);
    await P.ev(PUT_OK);
    const after = await P.ev(`m.pin(F.ids.fleet)`);
    ok(r === "storage_failed" && after.seq === head.seq && after.forked === false, "V-11: a longer chain the browser can't pin (put throws): storage_failed, no chain returned, the pin unchanged", { r, head, after });
    await P.ev(PUT_DROPS);
    const r2 = await code(P, `m.fv.syncChain(${CTX}, ${E(honest, [extend.append])})`);
    await P.ev(PUT_OK);
    const after2 = await P.ev(`m.pin(F.ids.fleet)`);
    ok(r2 === "storage_failed" && after2.seq === head.seq, "V-12: a longer chain whose pin write is dropped: storage_failed (the pin is read back before a chain is returned)", { r2, after2 });
    ok((await code(P, `m.fv.syncChain(${CTX}, ${E(honest, [extend.append])})`)) === null && (await P.ev(`m.pin(F.ids.fleet)`)).seq === head.seq + 1, "V-12: once storage works, the same chain is pinned");
  }
  // ---- two tabs: another tab moves the pin while this one verifies (a deterministic interleaving: the first WebCrypto
  // verify of this sync runs the other tab's move first)
  const OTHER_TAB = (move) => `(window.realVerify ??= crypto.subtle.verify, crypto.subtle.verify = async function (...a) { crypto.subtle.verify = window.realVerify; await (${move}); return window.realVerify.apply(this, a); }, true)`;
  {
    // (the other tab pinned another branch at the head this tab started from; this tab's longer chain must not move it)
    const P = await page();
    const h = await P.ev(`m.fv.syncChain(${CTX}, ${E(honest)}).then(() => m.pin(F.ids.fleet))`);
    await P.ev(OTHER_TAB(`m.resetDevice(F.ids.fleet).then(() => m.advancePin(F.ids.fleet, { seq: ${h.seq}, hash: ${JSON.stringify(H("B"))} }))`));
    const r = await code(P, `m.fv.syncChain(${CTX}, ${E(honest, [extend.append])})`);
    const p = await P.ev(`m.pin(F.ids.fleet)`);
    ok(r === "chain_fork" && p.forked === true && p.seq === h.seq && p.hash === H("B"), "V-13: another tab pins another branch while this one verifies a longer chain: the compare-and-set refuses (chain_fork) and records the fork; the other pin isn't overwritten", { r, p });
  }
  {
    // (the other tab pinned a later entry this tab can't relate to its chain: no fork, no shorter chain returned)
    const P = await page();
    const h = await P.ev(`m.fv.syncChain(${CTX}, ${E(honest)}).then(() => m.pin(F.ids.fleet))`);
    await P.ev(OTHER_TAB(`m.advancePin(F.ids.fleet, { seq: ${h.seq + 2}, hash: ${JSON.stringify(H("C"))} })`));
    const r = await code(P, `m.fv.syncChain(${CTX}, ${E(honest, [extend.append])})`);
    const p = await P.ev(`m.pin(F.ids.fleet)`);
    ok(r === "pin_moved" && p.forked === false && p.seq === h.seq + 2 && p.hash === H("C"), "V-14: another tab pins further while this one verifies: pin_moved (sync again), the other pin kept, no chain returned", { r, p });
    ok((await code(P, `m.fv.syncChain(${CTX}, ${E(honest, [extend.append])})`)) === "chain_fork", "V-14: syncing that same shorter chain again is a chain behind the pin: chain_fork");
  }
  {
    // (the compare-and-set itself, with made-up hashes: SEC's case, pin at A6, then a divergent B7)
    const P = await page();
    const A = (n) => JSON.stringify(Array.from({ length: n + 1 }, (_, i) => H(i < 6 ? "S" : "A")));
    const Bh = (n) => JSON.stringify(Array.from({ length: n + 1 }, (_, i) => H(i < 6 ? "S" : "B")));
    await P.ev(`m.advancePinOnChain(F.ids.fleet, ${A(5)}, { seq: 5, hash: ${JSON.stringify(H("S"))} }).then(() => m.advancePinOnChain(F.ids.fleet, ${A(6)}, { seq: 6, hash: ${JSON.stringify(H("A"))} }))`);
    const r = await code(P, `m.advancePinOnChain(F.ids.fleet, ${Bh(7)}, { seq: 7, hash: ${JSON.stringify(H("B"))} })`);
    const p = await P.ev(`m.pin(F.ids.fleet)`);
    ok(r === "chain_fork" && p.forked === true && p.seq === 6 && p.hash === H("A"), "V-15: advancePinOnChain from A6 with a divergent B7: chain_fork, recorded, the pin not moved to B7", { r, p });
    const q = await P.ev(`m.resetDevice(F.ids.fleet).then(() => m.advancePinOnChain(F.ids.fleet, ${A(6)}, { seq: 6, hash: ${JSON.stringify(H("A"))} })).then(() => m.advancePinOnChain(F.ids.fleet, ${A(5)}, { seq: 5, hash: ${JSON.stringify(H("S"))} }))`);
    ok(q === "behind" && (await P.ev(`m.pin(F.ids.fleet)`)).seq === 6, "V-15: advancePinOnChain with a head behind the pin: \"behind\", nothing written", q);
  }
  {
    const P = await page();
    const names = await P.ev(`Object.keys(m.fv).sort().join()`);
    ok(names === "PinMoved,StorageFailed,hostFingerprintShown,readChainPage,syncChain,verifyGrant,verifyGrantAck,verifyHostCert,verifyHostRevocation", "S-1: the module exports verification and reading only: syncChain, readChainPage, verifyHostCert, verifyGrant, verifyGrantAck, verifyHostRevocation, hostFingerprintShown (and its errors StorageFailed, PinMoved)", names);
    // (the fingerprint a person compares: recomputed from the verified certificate's keys, and equal to the first 100
    //  bits of the full fingerprint the certificate carries, which the core has already checked against those keys)
    const fp = await P.ev(`(async () => { const c = await m.fv.syncChain(${CTX}, F.objects.chain); const cert = await m.fv.verifyHostCert(${CTX}, c, F.objects.host_cert); const full = JSON.parse(F.objects.host_cert).body.fingerprint; const b = Uint8Array.from(atob(full.replace(/-/g, "+").replace(/_/g, "/")), (x) => x.charCodeAt(0)); let acc = 0n; for (const x of b.subarray(0, 13)) acc = (acc << 8n) | BigInt(x); acc >>= 4n; let want = ""; for (let i = 19; i >= 0; i--) want += "abcdefghijklmnopqrstuvwxyz234567"[Number((acc >> BigInt(5 * i)) & 31n)]; return { got: await m.fv.hostFingerprintShown(cert), want: want.match(/.{4}/g).join("-") }; })()`);
    ok(/^[a-z2-7]{4}(-[a-z2-7]{4}){4}$/.test(fp.got) && fp.got === fp.want, "V-17: hostFingerprintShown: the first 100 bits of the certificate's full fingerprint, 20 base32 characters in groups of 4", fp);
    // (a revocation: no fixture of one yet; anything else in its place is refused)
    const rv = await code(P, `(async () => { const c = await m.fv.syncChain(${CTX}, F.objects.chain); await m.fv.verifyHostRevocation(${CTX}, c, F.ids.host, F.objects.host_cert); })()`);
    ok(rv !== null, "V-18: verifyHostRevocation refuses an object that isn't a revocation (a host certificate in its place)", rv);
  }
} catch (e) {
  ok(false, "the test ran to its end: " + (e?.stack ?? e));
} finally {
  await B.close();
  server.stop(true);
}
console.log(failures ? `${failures} FAILED` : "all passed");
process.exit(failures ? 1 : 0);
