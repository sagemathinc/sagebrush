// ci: web-runner order=353 runner=bun chrome
// The fleet core's page mirror (fleet/: sagebrush-agent's lib/fleet/core/, its two schemas and its fixtures, byte for
// byte, loaded through fleet/install.ts). First the mirror itself: every file pinned by sha256 to the upstream commit,
// nothing added, the core still pure. Then the agent's own fixture cases (fleet-fixture-cases.mjs) in headless Chromium
// with its real WebCrypto, through fleetCore() as the page will call it, its HPKE vector and cases included.
//   CHROME=google-chrome bun web/workspace/test-fleet-core.mjs
//   (SAGEBRUSH_AGENT_DIR=<a sagebrush-agent clone> also compares every file with the upstream commit's own bytes)
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { browser } from "../agents/a14-cases.mjs";

const here = new URL(".", import.meta.url).pathname;
const fleet = join(here, "fleet");
let failures = 0;
const ok = (c, msg, detail) => { console.log((c ? "ok   " : "FAIL ") + msg + (!c && detail !== undefined ? "  " + JSON.stringify(detail).slice(0, 600) : "")); if (!c) failures++; };

// ---- the mirror: the upstream commit and each file's sha256 there (a new upstream version means new pins, reviewed)
const UPSTREAM = "80a1a4e64fe09b6f82af44e60fceef53328231a4";
const PINS = {
  "core/bytes.mjs": ["lib/fleet/core/bytes.mjs", "be5c199fcadf375336c49dae692fce6af96644af6f98b11161a4fb0d65eaaf6b"],
  "core/canon.mjs": ["lib/fleet/core/canon.mjs", "d9b7831f6772f6010689ecb74a8727280470e8e1437a2166fc0fd6b1728f08e8"],
  "core/canonical.mjs": ["lib/fleet/core/canonical.mjs", "7943e0fe146f6ad12a802e9cab7f9284a7879f0181ee9adcf2ae024ad9e819e3"],
  "core/chain.mjs": ["lib/fleet/core/chain.mjs", "a41abf0844266372b84f80c045d8db6af8eb7539e9f72b58ea2e3fd779c9e643"],
  "core/crypto.mjs": ["lib/fleet/core/crypto.mjs", "34d85de82f75c4bbae276d7fb24fddce0b8fd576825298fbe452535db12557b4"],
  "core/ed25519.mjs": ["lib/fleet/core/ed25519.mjs", "63420ae7dd5f17d159e56bc3a0ad91a3e96269a7eedf56196da2599a3a05c4ad"],
  "core/envelope.mjs": ["lib/fleet/core/envelope.mjs", "415d31991e6e5c11d61ebdf94d4c61ca1d813f2479746ad2099d17489c315842"],
  "core/hpke.mjs": ["lib/fleet/core/hpke.mjs", "f078320d9cdbc30373356101fdd05a0470e2c53a7500a59f9dafd35e2ed3630a"],
  "core/index.mjs": ["lib/fleet/core/index.mjs", "6e81197033e8aa327e312e7130c1df5ce4f469c78259dbe217b042318fca6259"],
  "core/recovery.mjs": ["lib/fleet/core/recovery.mjs", "a636cdaab732d71eeb24c241cd6f0c61b5d1634bafd5992675976083e36a90ff"],
  "core/schema.mjs": ["lib/fleet/core/schema.mjs", "f7e0c255623d3bfad7212c147dbe2ee6bc3a36b6c06c8879f000c1efdb52e495"],
  "core/schemas.mjs": ["lib/fleet/core/schemas.mjs", "bfa451095b2aaab83f12e9bc0a8a3326dcb635caceb088429057c22122aae7f9"],
  "core/sealed.mjs": ["lib/fleet/core/sealed.mjs", "ac143fd0f9742d879a802dd85ef061f10a672980cfe66137aa44297d53de3290"],
  "core/verify.mjs": ["lib/fleet/core/verify.mjs", "456973de9ecdb8a72382600d7c0ad8086236555d8ca698a1e31dda2ec4448d88"],
  "core/webcrypto.mjs": ["lib/fleet/core/webcrypto.mjs", "82f5b25fcd77710fa75f18c65df00dbea5be223315ff4f32308f3164acb0e61b"],
  "fleet.schema.json": ["schema/fleet/fleet.schema.json", "50b7a3b8e3bed9afe63a40cae8b52854c839d1482fa55caaef7bdccf59e82063"],
  "reasons.json": ["schema/fleet/reasons.json", "0dff469bdd8157ac4515d18f7fab299e233e5454966a13236f43dfae90875dd1"],
  "fleet-fixtures.json": ["test/fixtures/fleet-fixtures.json", "560fe3fdbfe463bca22e60fe773928a716bb24f45cf0bfc91003c61442702d80"],
  "fleet-hpke-fixtures.json": ["test/fixtures/fleet-hpke-fixtures.json", "66df51ecceb7c5365bf69d9ab4a7c6c3571a5b17c938acdccd322fccba789df4"],
  "hpke-x25519-sha256-aes256gcm.json": ["test/fixtures/hpke-x25519-sha256-aes256gcm.json", "054c8e53704afdc91aae501f96ee964828c78fd4581e5894d21593b93a066d8e"],
  "fleet-fixture-cases.mjs": ["test/fleet-fixture-cases.mjs", "4680b39dc785c84cd020865ce666ca4434338a6eefea029d8c3284fde5666017"],
};
const OWN = ["install.ts"]; // (the page's own file in fleet/; everything else there is upstream's)
const sha = (b) => createHash("sha256").update(b).digest("hex");
const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [relative(fleet, join(d, e.name))]));

const wrong = Object.entries(PINS).filter(([f, [, h]]) => { try { return sha(readFileSync(join(fleet, f))) !== h; } catch { return true; } }).map(([f]) => f);
ok(wrong.length === 0, `M-1: every mirrored file is byte for byte the pinned upstream file (${Object.keys(PINS).length} files at ${UPSTREAM.slice(0, 8)})`, wrong);
const present = walk(fleet).sort(), expected = [...Object.keys(PINS), ...OWN].sort();
ok(JSON.stringify(present) === JSON.stringify(expected), "M-2: fleet/ holds exactly the pinned files and install.ts: nothing added, nothing missing", { extra: present.filter((f) => !expected.includes(f)), missing: expected.filter((f) => !present.includes(f)) });
if (process.env.SAGEBRUSH_AGENT_DIR) {
  const differ = Object.entries(PINS).filter(([f, [up]]) => { const b = execFileSync("git", ["-C", process.env.SAGEBRUSH_AGENT_DIR, "show", `${UPSTREAM}:${up}`], { maxBuffer: 1 << 24 }); return !b.equals(readFileSync(join(fleet, f))); }).map(([f]) => f);
  ok(differ.length === 0, "M-3: every mirrored file equals the upstream commit's own bytes (SAGEBRUSH_AGENT_DIR)", differ);
} else console.log("skip M-3: no SAGEBRUSH_AGENT_DIR (the sha256 pins above stand for it)");
// (the core stays pure here as upstream: no Node built-ins, no Buffer or process, no import.meta, no import leaving core/)
const impure = Object.keys(PINS).filter((f) => f.startsWith("core/")).flatMap((f) => {
  const s = readFileSync(join(fleet, f), "utf8"), hits = [];
  for (const m of s.matchAll(/\b(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) if (!/^\.\/[a-z0-9-]+\.mjs$/.test(m[1])) hits.push(`${f}: import ${m[1]}`);
  for (const w of ["node:", "Buffer", "process.", "import.meta", "require("]) if (s.includes(w)) hits.push(`${f}: ${w}`);
  return hits;
});
ok(impure.length === 0, "M-4: the mirrored core is pure (only ./*.mjs imports; no node:, Buffer, process, import.meta, require)", impure);

// ---- no page code reaches the core yet: until the first verifier that uses it is reviewed, it is only mirrored
// (any web/ module other than fleet/ itself and the tests that imports fleet/install or fleet/core fails this row)
const web = join(here, "..");
const users = [];
const scan = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) {
  const p = join(d, e.name);
  if (e.isDirectory()) { if (!["node_modules", "dist", ".cache"].includes(e.name) && p !== fleet) scan(p); continue; }
  if (!/\.(?:ts|mts|js|mjs)$/.test(e.name) || /^test-/.test(e.name)) continue;
  if (/fleet\/(?:install|core)/.test(readFileSync(p, "utf8"))) users.push(relative(web, p));
} };
scan(web);
ok(users.length === 0, "N-1: no page module imports the fleet core yet (mirrored only; no signing or verifying path is live)", users);

// ---- the agent's fixture cases, in Chromium, through fleetCore()
const dir = mkdtempSync(join(tmpdir(), "sb-fleet-core-"));
const entry = join(dir, "entry.ts");
writeFileSync(entry, [
  `export { fleetCore } from ${JSON.stringify(join(fleet, "install.ts"))};`,
  `export * as raw from ${JSON.stringify(join(fleet, "core/index.mjs"))};`,
  `export { checkFixtures, checkHpkeVector, checkHpkeFixtures } from ${JSON.stringify(join(fleet, "fleet-fixture-cases.mjs"))};`,
].join("\n"));
const built = await Bun.build({ entrypoints: [entry], target: "browser", format: "esm" });
rmSync(dir, { recursive: true, force: true });
if (!built.success) throw new Error("the fleet core didn't build: " + built.logs.join("\n"));
const js = await built.outputs[0].text();
const fixtures = readFileSync(join(fleet, "fleet-fixtures.json"));
const hpkeVector = readFileSync(join(fleet, "hpke-x25519-sha256-aes256gcm.json")), hpkeFixtures = readFileSync(join(fleet, "fleet-hpke-fixtures.json"));
const schemaText = readFileSync(join(fleet, "fleet.schema.json"), "utf8"), reasonsText = readFileSync(join(fleet, "reasons.json"), "utf8");
const html = `<!doctype html><script type="module">import * as m from "/fc.js"; window.fc = m; window.F = await (await fetch("/fixtures.json")).json(); window.HV = await (await fetch("/hpke-vector.json")).json(); window.HF = await (await fetch("/hpke-fixtures.json")).json(); window.ready = true;</script>`;
const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (r) => {
  const p = new URL(r.url).pathname;
  if (p === "/fc.js") return new Response(js, { headers: { "content-type": "text/javascript" } });
  if (p === "/fixtures.json") return new Response(fixtures, { headers: { "content-type": "application/json" } });
  if (p === "/hpke-vector.json") return new Response(hpkeVector, { headers: { "content-type": "application/json" } });
  if (p === "/hpke-fixtures.json") return new Response(hpkeFixtures, { headers: { "content-type": "application/json" } });
  return new Response(html, { headers: { "content-type": "text/html" } });
} });
const site = `http://127.0.0.1:${server.port}`;
const B = await browser();
const settle = async (P, before) => { for (const t = Date.now(); P.loads === before && Date.now() - t < 10000; ) await new Promise((r) => setTimeout(r, 50)); await P.until(`window.ready === true`, 10000); };
const page = async () => { const P = await B.tab(); const n = P.loads; await P.send("Page.navigate", { url: site + "/" }); await settle(P, n); return P; };
const err = (P, expr) => P.ev(`(async () => { try { await (${expr}); return null; } catch (e) { return String(e?.message ?? e); } })()`);
// (the count is pinned so a group of cases that stopped running shows up, not only a case that fails)
const CASES = 84, HPKE_VECTOR = 257, HPKE_CASES = 34;
try {
  {
    const P = await page();
    const r = await P.ev(`fc.checkFixtures(fc.fleetCore(), F).then((r) => ({ n: r.n, bad: r.bad }))`);
    ok(r.n === CASES && r.bad.length === 0, `C-1: all ${CASES} of the agent's fixture cases agree in Chromium (canonical, base64url, ids, ed25519, chain, service keys, envelopes, grants, host ops, approvals)`, r);
    // (the small-order forgery: R = identity and S = 0 under a small-order key. Chromium's own verify may accept it;
    //  the core refuses it before WebCrypto is asked. The platform's answer is printed, not asserted: it may change)
    const so = await P.ev(`(async () => { const c = F.ed25519.find((c) => /small-order/.test(c.name)); const core = fc.fleetCore(); const k = core.unb64(c.public, 32), m = core.unb64(c.msg_b64), s = core.unb64(c.sig, 64);
      let platform; try { const key = await crypto.subtle.importKey("raw", k, { name: "Ed25519" }, false, ["verify"]); platform = await crypto.subtle.verify({ name: "Ed25519" }, key, s, m); } catch (e) { platform = e.name; }
      return { name: c.name, expect: c.expect, core: await core.verifyStrict(k, m, s), platform }; })()`);
    ok(so.expect === false && so.core === false, `C-2: the small-order forgery is refused by the core (this Chromium's own verify says ${JSON.stringify(so.platform)})`, so);
    // (HPKE, r2.3 §7: X25519, HKDF-SHA256 and AES-256-GCM from this Chromium's WebCrypto under the core's own HPKE)
    const v = await P.ev(`fc.checkHpkeVector(fc.fleetCore(), HV.vector).then((r) => ({ n: r.n, bad: r.bad }))`);
    ok(v.n === HPKE_VECTOR && v.bad.length === 0, `C-7: the RFC 9180 known-answer vector in Chromium: both key pairs, the encapsulated key, all ${HPKE_VECTOR} encryptions sealed and opened, and overlapping calls refused`, v);
    const h = await P.ev(`fc.checkHpkeFixtures(fc.fleetCore(), HF).then((r) => ({ n: r.n, bad: r.bad }))`);
    ok(h.n === HPKE_CASES && h.bad.length === 0, `C-8: all ${HPKE_CASES} of the agent's HPKE fixture cases agree in Chromium (key ids, sealed packages, capability mints)`, h);
  }
  {
    const P = await page();
    ok((await P.ev(`fc.fleetCore() === fc.fleetCore()`)) === true, "C-3: fleetCore() installs once and gives the same core again");
    ok(/already installed/.test(await err(P, `fc.raw.useCrypto(fc.raw.webCrypto())`) ?? ""), "C-3: another crypto backend afterwards is refused (nothing loaded later swaps the checks)");
    ok(/already installed/.test(await err(P, `fc.raw.useSchemas(() => ({}))`) ?? ""), "C-3: another schema loader afterwards is refused");
    const r = await P.ev(`fc.checkFixtures(fc.fleetCore(), F).then((r) => r.bad.length)`);
    ok(r === 0, "C-3: and the cases still agree after those attempts", r);
    ok((await P.ev(`Object.isFrozen(fc.fleetCore().fleetSchema()) && Object.isFrozen(fc.fleetCore().fleetSchema().$defs)`)) === true, "C-4: the installed schema is deep-frozen");
  }
  {
    // (schemas of another revision, before any install: each refused, and nothing installed by the attempts)
    const P = await page();
    const real = `JSON.parse(${JSON.stringify(schemaText)})`;
    const r1 = await err(P, `fc.raw.useSchemas((n) => n === "reasons.json" ? { freeze: "0".repeat(64), reasons: [] } : ${real})`);
    ok(/reasons\.json isn't the frozen revision/.test(r1 ?? ""), "C-5: reasons.json of another revision is refused", r1);
    const r2 = await err(P, `fc.raw.useSchemas((n) => n === "reasons.json" ? JSON.parse(${JSON.stringify(reasonsText)}) : { ...${real}, $comment: "Frozen design: r2.2" })`);
    ok(/fleet\.schema\.json isn't the frozen revision/.test(r2 ?? ""), "C-5: fleet.schema.json of another revision is refused", r2);
    ok(/no fleet schemas/.test(await err(P, `fc.raw.fleetSchema()`) ?? ""), "C-5: and nothing was installed by the refused attempts");
  }
  {
    // (a page with no WebCrypto, as an insecure origin: fleetCore() throws; it never falls back to anything)
    const P = await page();
    const e = await err(P, `(Object.defineProperty(globalThis, "crypto", { value: {}, configurable: true }), fc.fleetCore())`);
    ok(/no WebCrypto here/.test(e ?? ""), "C-6: without WebCrypto, fleetCore() throws (no fallback)", e);
  }
} catch (e) {
  ok(false, "the test ran to its end: " + (e?.stack ?? e));
} finally {
  await B.close();
  server.stop(true);
}
console.log(failures ? `${failures} FAILED` : "all passed");
process.exit(failures ? 1 : 0);
