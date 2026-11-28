// ci: web-runner order=353 runner=bun chrome
// The fleet core's page mirror (fleet/: sagebrush-agent's lib/fleet/core/, its two schemas and its fixtures, byte for
// byte, loaded through fleet/install.ts). First the mirror itself: every file pinned by sha256 to the upstream commit,
// nothing added, the core still pure. Then the agent's own fixture cases (fleet-fixture-cases.mjs) in headless Chromium
// with its real WebCrypto, through fleetCore() as the page calls it: the fleet's cases, then HPKE's (RFC 9180's vector
// for the one suite, and the agent's sealed-package and capability cases).
//   CHROME=google-chrome bun web/workspace/test-fleet-core.mjs
//   (SAGEBRUSH_AGENT_DIR=<a sagebrush-agent clone> also compares every file with the upstream commit's own bytes)
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { browser } from "../agents/a14-cases.mjs";

const here = new URL(".", import.meta.url).pathname;
const fleet = join(here, "fleet");
let failures = 0;
const ok = (c, msg, detail) => { console.log((c ? "ok   " : "FAIL ") + msg + (!c && detail !== undefined ? "  " + JSON.stringify(detail).slice(0, 600) : "")); if (!c) failures++; };

// ---- the mirror: the upstream commit and each file's sha256 there (a new upstream version means new pins, reviewed)
const UPSTREAM = "c24d74038257cb560b7cbb54a87c7469b31b506e";
const PINS = {
  "core/bytes.mjs": ["lib/fleet/core/bytes.mjs", "be5c199fcadf375336c49dae692fce6af96644af6f98b11161a4fb0d65eaaf6b"],
  "core/canon.mjs": ["lib/fleet/core/canon.mjs", "d9b7831f6772f6010689ecb74a8727280470e8e1437a2166fc0fd6b1728f08e8"],
  "core/canonical.mjs": ["lib/fleet/core/canonical.mjs", "7943e0fe146f6ad12a802e9cab7f9284a7879f0181ee9adcf2ae024ad9e819e3"],
  "core/chain-service.mjs": ["lib/fleet/core/chain-service.mjs", "ccbebba30754c45d88f3c8ed80408707a3c0116f121e631aa5d4abb274c8647e"],
  "core/grant-service.mjs": ["lib/fleet/core/grant-service.mjs", "5adf702a20d28aeee3b0194f9aad12e35f283c0437006e7358b252ec8ad7653e"],
  "core/chain.mjs": ["lib/fleet/core/chain.mjs", "774c2e7478d475c7e66ab0172d219a287d934b4efb4ebc3cbb62d10b6ec6e16e"],
  "core/control.mjs": ["lib/fleet/core/control.mjs", "32ff93c76b65e19b3a5e6189fd118ae7860ecfbae70c22a1c0469e246379165b"],
  "core/crypto.mjs": ["lib/fleet/core/crypto.mjs", "34d85de82f75c4bbae276d7fb24fddce0b8fd576825298fbe452535db12557b4"],
  "core/ed25519.mjs": ["lib/fleet/core/ed25519.mjs", "63420ae7dd5f17d159e56bc3a0ad91a3e96269a7eedf56196da2599a3a05c4ad"],
  "core/envelope.mjs": ["lib/fleet/core/envelope.mjs", "a75fdd24675a12377dfba1a2e1f2c38c846e61f1b80e0914afa988bc7501d2e5"],
  "core/hpke.mjs": ["lib/fleet/core/hpke.mjs", "38d2ac452098e275b423a8530fb62c2cc113c6f4493cbefa397aa92dd40bf6d1"],
  "core/index.mjs": ["lib/fleet/core/index.mjs", "b4c13f9a14e6eb0ff08f0c0a14109e48c11840f81065fcd08854de702c9e6f8e"],
  "core/lease-service.mjs": ["lib/fleet/core/lease-service.mjs", "b92c721e5718c2e27a983ef8612b4a1a8741443ab4797a1503f9682881fa244b"],
  "core/recovery.mjs": ["lib/fleet/core/recovery.mjs", "a636cdaab732d71eeb24c241cd6f0c61b5d1634bafd5992675976083e36a90ff"],
  "core/relay.mjs": ["lib/fleet/core/relay.mjs", "c30eab74b5305ae0e0194e76555ed11bee3a2768c12ba95c599145fd74138c2a"],
  "core/request.mjs": ["lib/fleet/core/request.mjs", "004c275e22bb893d8f59192a18d8cb7d8ad21bdf040ebe4920bd940051615636"],
  "core/schema.mjs": ["lib/fleet/core/schema.mjs", "f7e0c255623d3bfad7212c147dbe2ee6bc3a36b6c06c8879f000c1efdb52e495"],
  "core/schemas.mjs": ["lib/fleet/core/schemas.mjs", "871a9e3278d9312d82eb4871fc267e204bb5df7af587a3d1f1005571724135d1"],
  "core/sealed.mjs": ["lib/fleet/core/sealed.mjs", "bd9d9843486dd5a70061bc30c4db2defaa1afbada4fdaa52401361d53ba52fb5"],
  "core/verify.mjs": ["lib/fleet/core/verify.mjs", "bc45d490a510a5c8fa2f9c145083b3747157cd2e4d3859ad69ecee30e42ed17b"],
  "core/webcrypto.mjs": ["lib/fleet/core/webcrypto.mjs", "82f5b25fcd77710fa75f18c65df00dbea5be223315ff4f32308f3164acb0e61b"],
  "core/worker.mjs": ["lib/fleet/core/worker.mjs", "9471ad45d78b0a423ac64a07d1ee02c73b5e6241d11f11f40e6daf070801633f"],
  "fleet.schema.json": ["schema/fleet/fleet.schema.json", "e74f056439d6d360c525529e90bd945e9dd9e2edb9e299d384a5f9fce8ff887e"],
  "reasons.json": ["schema/fleet/reasons.json", "6131d4c662bd7247aa2cfb041bc5eb6449c9fcc734259f991c2d46854b88d83e"],
  "fleet-fixtures.json": ["test/fixtures/fleet-fixtures.json", "5c5ecf60b381360f0d05fe2eab3ad02a544e2c68d58cba795c749cbdbaf64129"],
  "fleet-hpke-fixtures.json": ["test/fixtures/fleet-hpke-fixtures.json", "2c4d640af72ee2514c33930763dd17521b73ca50e231fdc0cb8d54915e16736c"],
  "hpke-x25519-sha256-aes256gcm.json": ["test/fixtures/hpke-x25519-sha256-aes256gcm.json", "054c8e53704afdc91aae501f96ee964828c78fd4581e5894d21593b93a066d8e"],
  "fleet-fixture-cases.mjs": ["test/fleet-fixture-cases.mjs", "02e79a5991335ed6f798e67cb334353bf6f7139c8e23bfad15555e01bb9c4661"],
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

// ---- the core's page users: the end-to-end crypto (e2e/), and the fleet verifier (fleet-verify.ts, which signs nothing,
// and which nothing reaches yet: N-2). A page module (e2e/*.ts, fleet-verify.ts) reaches it only through
// fleet/install.ts, the one installer. e2e/core/'s pure modules
// (.mjs, like the core itself) may import the core's pure functions directly, but never an installer: not
// core/index.mjs, not webcrypto.mjs, and no useCrypto or useSchemas, so nothing there can install or swap a backend.
// A tree under its own licence (a directory holding its own LICENSE.md, below web/) is outside this scan: its users of
// the core are held to the same rule by that tree's own tests, under its licence.
// (any other web/ module, fleet/ itself and the tests aside, that imports fleet/install or fleet/core fails this row)
const web = join(here, "..");
const e2e = join(here, "e2e");
const e2eCore = join(e2e, "core");
const INSTALLERS = /\b(?:useCrypto|useSchemas|webCrypto)\b/;
// (every quoted mention of fleet/core in the file must be one of its allowed imports: a static, named import at a
//  statement's start, of a pure core module. Anything else that names the core, a side-effect import, a dynamic
//  import(), an export ... from, a namespace or default import, even a string, is unaccounted for and refused)
const coreImportOk = (t) => {
  const refs = [...t.matchAll(/["'`][^"'`\n]*fleet\/core[^"'`\n]*["'`]/g)].length;
  const named = [...t.matchAll(/(?:^|\n)[ \t]*import[ \t]*(\{[^}]*\})[ \t]*from[ \t]*["']([^"'\n]+)["']/g)].filter((m) => /fleet\/core/.test(m[2]));
  return named.length === refs && named.every((m) => /^\.\.\/\.\.\/fleet\/core\/[a-z0-9-]+\.mjs$/.test(m[2])
    && !/\/(?:index|webcrypto)\.mjs$/.test(m[2]) && !INSTALLERS.test(m[1]));
};
/** The page modules under `webDir` (a web/ tree) that reach the fleet core other than N-1 allows. */
const coreUsers = (webDir) => {
  const fleetDir = join(webDir, "workspace", "fleet"), e2eDir = join(webDir, "workspace", "e2e"), coreDir = join(e2eDir, "core");
  const out = [];
  const scan = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    if (e.isDirectory()) { if (!["node_modules", "dist", ".cache"].includes(e.name) && p !== fleetDir && !existsSync(join(p, "LICENSE.md"))) scan(p); continue; }
    if (!/\.(?:ts|mts|js|mjs)$/.test(e.name) || /^test-/.test(e.name)) continue;
    const t = readFileSync(p, "utf8");
    const inCore = p.startsWith(coreDir + "/") && p.endsWith(".mjs");
    const verifier = relative(webDir, p) === join("workspace", "fleet-verify.ts");
    if ((/fleet\/core/.test(t) && !(inCore && coreImportOk(t))) || (/fleet\/install/.test(t) && !p.startsWith(e2eDir + "/") && !verifier)) out.push(relative(webDir, p));
  } };
  scan(webDir);
  return out;
};
const users = coreUsers(web);
ok(users.length === 0, "N-1: only e2e/ and the verifier (fleet-verify.ts) use the fleet core (trees under their own licence aside): page modules through fleet/install.ts, e2e/core/'s pure modules by named imports of the core's pure functions, never an installer", users);
// (and only the fleet pages reach the verifier: /agents/fleet/'s page.ts, read only, reviewed with it. Any other page
//  module naming it is reported. The scan covers fleet/ too, its own installer included: only the byte-pinned mirror
//  files, PINS, are left out)
/** The modules under `webDir` (a web/ tree) that name the verifier, other than the verifier itself. */
const verifierUsersIn = (webDir) => {
  const fleetDir = join(webDir, "workspace", "fleet");
  const out = [];
  const scan = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    if (e.isDirectory()) { if (!["node_modules", "dist", ".cache"].includes(e.name)) scan(p); continue; }
    if (!/\.(?:ts|mts|js|mjs)$/.test(e.name) || /^test-/.test(e.name)) continue;
    if (p.startsWith(fleetDir + "/") && Object.hasOwn(PINS, relative(fleetDir, p))) continue;
    if (/fleet-verify/.test(readFileSync(p, "utf8")) && relative(webDir, p) !== join("workspace", "fleet-verify.ts")) out.push(relative(webDir, p));
  } };
  scan(webDir);
  return out;
};
const verifierUsers = verifierUsersIn(web);
ok(JSON.stringify(verifierUsers) === JSON.stringify([join("agents", "fleet", "page.ts")]), "N-2: only the fleet pages (agents/fleet/page.ts) name the verifier; no other page module does", verifierUsers);
{
  // (its control, on real files: the page's own installer importing the verifier is reported, while a pinned mirror
  //  file is left out of the scan)
  const root = mkdtempSync(join(tmpdir(), "sb-n2-"));
  mkdirSync(join(root, "workspace", "fleet", "core"), { recursive: true });
  writeFileSync(join(root, "workspace", "fleet", "install.ts"), 'export const x = 1;\nimport "../fleet-verify";\n');
  writeFileSync(join(root, "workspace", "fleet", "core", "index.mjs"), '// fleet-verify (a pinned path: not scanned)\n');
  writeFileSync(join(root, "workspace", "fleet-verify.ts"), 'export const v = 1;\n');
  const found = verifierUsersIn(root);
  rmSync(root, { recursive: true, force: true });
  ok(JSON.stringify(found) === JSON.stringify([join("workspace", "fleet", "install.ts")]), "N-2: (its control) fleet/install.ts importing the verifier is reported; a pinned mirror path isn't scanned", found);
}
// (the rule's own controls: what it lets through and what it refuses)
ok(coreImportOk('import { canonText } from "../../fleet/core/canonical.mjs";') && coreImportOk('import { crypto } from "../../fleet/core/crypto.mjs";')
  && !coreImportOk('import { useCrypto } from "../../fleet/core/crypto.mjs";') && !coreImportOk('import { webCrypto } from "../../fleet/core/webcrypto.mjs";')
  && !coreImportOk('import { canonText } from "../../fleet/core/index.mjs";') && !coreImportOk('import * as core from "../../fleet/core/bytes.mjs";')
  && !coreImportOk('import { useSchemas } from "../../fleet/core/schemas.mjs";') && !coreImportOk('import { x } from "../fleet/core/bytes.mjs";')
  && !coreImportOk('import "../../fleet/core/index.mjs";') && !coreImportOk('const m = await import("../../fleet/core/webcrypto.mjs");')
  && !coreImportOk('export { useCrypto } from "../../fleet/core/crypto.mjs";') && !coreImportOk('export * from "../../fleet/core/bytes.mjs";')
  && !coreImportOk('import core from "../../fleet/core/bytes.mjs";') && !coreImportOk('const p = "../../fleet/core/webcrypto.mjs";')
  && !coreImportOk('import { canonText } from "../../fleet/core/canonical.mjs";\nimport "../../fleet/core/webcrypto.mjs";')
  && coreImportOk('import { canonText } from "../../fleet/core/canonical.mjs";\nimport { b64, enc } from "../../fleet/core/bytes.mjs";'),
  "N-1: (its controls) named pure imports pass; an installer, the index, a namespace or default import, another path, a side-effect import, a dynamic import(), an export ... from, or any other mention of the core is refused");
{
  // (and on real files: each form planted as a module of e2e/core in a scratch web/ tree is reported by the scan)
  const forms = {
    "side-effect import": 'import "../../fleet/core/webcrypto.mjs";\n',
    "dynamic import": 'export const load = async () => await import("../../fleet/core/index.mjs");\n',
    "re-export": 'export { useCrypto } from "../../fleet/core/crypto.mjs";\n',
    "default and namespace import": 'import core, * as ns from "../../fleet/core/webcrypto.mjs";\nexport { core, ns };\n',
    "an installer by name": 'import { useCrypto } from "../../fleet/core/crypto.mjs";\nexport { useCrypto };\n',
  };
  const planted = {};
  for (const [name, body] of Object.entries(forms)) {
    const root = mkdtempSync(join(tmpdir(), "sb-n1-"));
    mkdirSync(join(root, "workspace", "e2e", "core"), { recursive: true });
    writeFileSync(join(root, "workspace", "e2e", "core", "bad.mjs"), 'import { canonText } from "../../fleet/core/canonical.mjs";\n' + body);
    writeFileSync(join(root, "workspace", "e2e", "core", "good.mjs"), 'import { canonText } from "../../fleet/core/canonical.mjs";\nexport { canonText };\n');
    planted[name] = coreUsers(root);
    rmSync(root, { recursive: true, force: true });
  }
  const wrong = Object.entries(planted).filter(([, u]) => JSON.stringify(u) !== JSON.stringify(["workspace/e2e/core/bad.mjs"]));
  ok(wrong.length === 0, `N-1: (on real files) each of ${Object.keys(forms).length} forbidden forms in an e2e/core module fails the scan, and its allowed sibling doesn't`, wrong);
}

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
const html = `<!doctype html><script type="module">import * as m from "/fc.js"; window.fc = m; window.F = await (await fetch("/fixtures.json")).json(); window.HV = (await (await fetch("/hpke-vector.json")).json()).vector; window.HF = await (await fetch("/hpke-fixtures.json")).json(); window.ready = true;</script>`;
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
const CASES = 204, HPKE_VECTOR = 260, HPKE_CASES = 34;
try {
  {
    const P = await page();
    const r = await P.ev(`fc.checkFixtures(fc.fleetCore(), F).then((r) => ({ n: r.n, bad: r.bad }))`);
    ok(r.n === CASES && r.bad.length === 0, `C-1: all ${CASES} of the agent's fixture cases agree in Chromium (canonical, base64url, ids, ed25519, chain, service keys, lease keys, envelopes, grants, grant acks, host ops, approvals, transfers, leases, fence acks, fleet fingerprints)`, r);
    // (the small-order forgery: R = identity and S = 0 under a small-order key. Chromium's own verify may accept it;
    //  the core refuses it before WebCrypto is asked. The platform's answer is printed, not asserted: it may change)
    const so = await P.ev(`(async () => { const c = F.ed25519.find((c) => /small-order/.test(c.name)); const core = fc.fleetCore(); const k = core.unb64(c.public, 32), m = core.unb64(c.msg_b64), s = core.unb64(c.sig, 64);
      let platform; try { const key = await crypto.subtle.importKey("raw", k, { name: "Ed25519" }, false, ["verify"]); platform = await crypto.subtle.verify({ name: "Ed25519" }, key, s, m); } catch (e) { platform = e.name; }
      return { name: c.name, expect: c.expect, core: await core.verifyStrict(k, m, s), platform }; })()`);
    ok(so.expect === false && so.core === false, `C-2: the small-order forgery is refused by the core (this Chromium's own verify says ${JSON.stringify(so.platform)})`, so);
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
    // (HPKE, through the page's one installed core: RFC 9180's known-answer vector for the one suite, every
    //  encryption sealed and opened in sequence, and every case of the agent's sealed-package and capability vectors)
    const P = await page();
    const v = await P.ev(`fc.checkHpkeVector(fc.fleetCore(), HV).then((r) => ({ n: r.n, bad: r.bad }))`);
    ok(v.n === HPKE_VECTOR && v.bad.length === 0, `C-6: RFC 9180's vector for DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, AES-256-GCM agrees in Chromium (${HPKE_VECTOR - 3} encryptions and 3 exports, both key pairs, enc)`, v);
    const f = await P.ev(`fc.checkHpkeFixtures(fc.fleetCore(), HF).then((r) => ({ n: r.n, bad: r.bad }))`);
    ok(f.n === HPKE_CASES && f.bad.length === 0, `C-6: all ${HPKE_CASES} of the agent's HPKE cases agree in Chromium (key ids, sealed packages, capability mints)`, f);
    // (no Claude login is ever sealed or opened here: the agent's own case for a claude-setup-token package must be among
    //  them, expecting a refusal, and C-6 has just seen the core refuse it)
    const claude = JSON.parse(hpkeFixtures.toString("utf8")).packages.filter((c) => /claude-setup-token/.test(c.name));
    ok(claude.length === 1 && claude[0].expect === "bad_form" && !f.bad.some((b) => b.name === claude[0].name), "C-9: a claude-setup-token package is refused (bad_form): the core takes no Claude purpose", claude);
    // (and the schema the page installs names no Claude provider where a subscription or a sealed package is described)
    const prov = await P.ev(`(() => { const d = fc.fleetCore().fleetSchema().$defs; return ["subscription", "sealed-package", "package_plaintext"].map((n) => JSON.stringify(d[n]?.properties?.provider?.enum ?? null)); })()`);
    ok(prov.every((e) => e === '["codex"]'), "C-10: the installed schema allows only codex as a subscription, sealed-package and package provider (no Claude subscription)", prov);
  }
  {
    // (a page with no WebCrypto, as an insecure origin: fleetCore() throws; it never falls back to anything)
    const P = await page();
    const e = await err(P, `(Object.defineProperty(globalThis, "crypto", { value: {}, configurable: true }), fc.fleetCore())`);
    ok(/no WebCrypto here/.test(e ?? ""), "C-7: without WebCrypto, fleetCore() throws (no fallback)", e);
  }
} catch (e) {
  ok(false, "the test ran to its end: " + (e?.stack ?? e));
} finally {
  await B.close();
  server.stop(true);
}
console.log(failures ? `${failures} FAILED` : "all passed");
process.exit(failures ? 1 : 0);
