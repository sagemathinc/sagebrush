// ci: web-sync.5 order=20 chrome
// This browser's E2E device (web/workspace/e2e/device-keys.ts; plan notes m1-page-keys-plan M1a), in headless Chromium
// with its real WebCrypto and IndexedDB, against the sync server's key chain routes in Miniflare (SYNC_E2E on, DEV
// only). The page's requests go through a small proxy that adds the test's session, as same-origin requests do:
// genesis from the page (a device, a recovery code shown once, epoch 0); its keys non-extractable; a reload finds the
// device and its pin, and the epoch's keys again; the chain view the sync client reads; a pin the chain doesn't extend
// marks the account forked for good; and "Reset this device" forgets it.
//   CHROME=google-chrome node web/workspace/test-e2e-device-keys.mjs
import { readdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { dispatch } from "../miniflare-dispatch.mjs";
import { browser } from "../agents/a14-cases.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, "../site/package.json"));
const { Miniflare, convertV4MiniflareOptions } = require("miniflare");
let failures = 0, count = 0;
const ok = (c, msg, detail) => { count++; console.log((c ? "ok   " : "FAIL ") + msg + (!c && detail !== undefined ? "  " + JSON.stringify(detail).slice(0, 600) : "")); if (!c) failures++; };
const J = JSON.stringify;

// ---- the server: the sync Worker with the E2E routes on
const SITE = "https://sagebrush.test";
const A = "de71ce00-0001-4e2e-8e2e-e2e2e2e2e201";
const script = execFileSync("bun", ["build", join(here, "../sync/test-entry.ts"), "--format", "esm", "--target", "browser", "--external", "cloudflare:workers"], { encoding: "utf8", maxBuffer: 64 << 20 });
const plan = { storage_bytes: 1 << 30, max_file_bytes: 1 << 20, sync: { enabled: true, version_bytes: 1 << 20, read_bytes_per_day: 1 << 30 } };
const rl = (id) => ({ SYNC_PREAUTH: { namespace_id: id, simple: { limit: 1_000_000, period: 60 } }, SYNC_INGRESS_IP: { namespace_id: "8" + id, simple: { limit: 1_000_000, period: 60 } }, SYNC_ACCOUNT_INGRESS: { namespace_id: "9" + id, simple: { limit: 1_000_000, period: 60 } }, SYNC_ADMIN_LIMIT: { namespace_id: "7" + id, simple: { limit: 1_000_000, period: 60 } } });
const mf = new Miniflare(convertV4MiniflareOptions({
  workers: [{
    modules: true, script, compatibilityDate: "2026-10-01", d1Databases: ["SHARE_DB"], r2Buckets: ["SHARE_BUCKET"],
    name: "on", routes: ["sagebrush.test/*"], outboundService: async () => Response.json(plan), ratelimits: rl("4301"),
    durableObjects: { SYNC_ACCOUNT: { className: "SyncAccount", useSQLite: true }, SYNC_DOC: { className: "SyncDoc", useSQLite: true } },
    bindings: { SESSION_KEY: "session-key", SHARE_DEV: "1", DEV_AUTH_TOKEN: "dev-token", COCALC_ORIGIN: "https://cocalc.test", COCALC_CLIENT_SECRET: "client-secret", PURGE_KEY: "purge-key", LIMITS_KEY: "limits-key", SYNC_ACCOUNTS: A, SYNC_E2E: "1", SYNC_TEST_PIN_MS: "1000" },
  }],
}));
const db = await mf.getD1Database("SHARE_DB", "on");
{
  const mig = join(here, "../share/migrations");
  for (const m of readdirSync(mig).filter((f) => f.endsWith(".sql")).sort())
    for (const s of readFileSync(join(mig, m), "utf8").replace(/--.*$/gm, "").split(";").map((s) => s.trim()).filter(Boolean)) await db.prepare(s).run();
}
const at = (path, init = {}) => dispatch(mf, SITE + path, { redirect: "manual", ...init });
const signIn = async (id) => (await at("/auth/dev", { method: "POST", headers: { origin: SITE, "content-type": "application/json" }, body: J({ token: "dev-token", account_id: id }) })).headers.getSetCookie().map((c) => c.split(";")[0]).find((c) => c.startsWith("__Host-sb_session="));
const session = await signIn(A);
ok((await at("/api/sync/v1/enable", { method: "POST", headers: { cookie: session, origin: SITE, "content-type": "application/json" }, body: "{}" })).status === 200, "(sync on for the account)");
const chainOf = async () => (await (await at("/api/sync/v1/e2e/chain?from=0", { headers: { cookie: session, origin: SITE } })).json());

// ---- the page: the module, and a proxy to the server with the session
const dir = mkdtempSync(join(tmpdir(), "sb-device-keys-"));
const entry = join(dir, "entry.ts");
writeFileSync(entry, `export * as K from ${J(join(here, "e2e", "device-keys.ts"))};\n`);
const js = execFileSync("bun", ["build", entry, "--format", "esm", "--target", "browser"], { encoding: "utf8", maxBuffer: 64 << 20 });
rmSync(dir, { recursive: true, force: true });
const html = `<!doctype html><script type="module">import * as m from "/s.js"; Object.assign(window, m);
window.code = async (f) => { try { return { ok: await f() }; } catch (e) { return { code: e?.code ?? String(e?.message ?? e) }; } };
window.ready = true;</script>`;
let requests = 0;
const server = createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/s.js") return res.writeHead(200, { "content-type": "text/javascript" }).end(js);
  if (!u.pathname.startsWith("/api/")) return res.writeHead(200, { "content-type": "text/html" }).end(html);
  requests++;
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const r = await at(u.pathname + u.search, { method: req.method, headers: { cookie: session, origin: SITE, ...(req.headers["content-type"] ? { "content-type": req.headers["content-type"] } : {}) }, ...(chunks.length ? { body: Buffer.concat(chunks) } : {}) });
  res.writeHead(r.status, { "content-type": r.headers.get("content-type") ?? "application/json" }).end(Buffer.from(await r.arrayBuffer()));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;

const B = await browser();
try {
  const P = await B.tab();
  const load = async () => {
    const n = P.loads;
    await P.send("Page.navigate", { url: ORIGIN + "/" });
    for (const t = Date.now(); P.loads === n && Date.now() - t < 10000; ) await new Promise((r) => setTimeout(r, 50));
    await P.until(`window.ready === true`, 10000);
  };
  await load();

  // ---- no device yet
  const none = await P.ev(`code(async () => (await K.DeviceKeys.load()) === null)`);
  ok(none.ok === true, "before turning encryption on, this browser has no device for the account", none);

  // ---- genesis from the page
  const made = await P.ev(`(async () => {
    const { keys, recoveryCode } = await K.DeviceKeys.create("laptop");
    window.keys = keys;
    const view = await keys.chain();
    return { id: keys.device.id, account: keys.account, code: recoveryCode, head: view.head, epoch: view.currentEpoch, pos: view.position(view.head), dev: view.device(keys.device.id),
      signer: Array.from(view.signerAt(view.head, keys.device.id) ?? []), e0: !!(await keys.epochKeys(0)), e1: await keys.epochKeys(1) };
  })()`);
  const c1 = await chainOf();
  ok(c1.entries?.length === 1 && c1.head?.hash === made.head && made.account === c1.account, `genesis is stored: one entry, the page's head (${J({ entries: c1.entries?.length, head: c1.head })})`);
  ok(typeof made.code === "string" && made.code.replace(/-/g, "").length === 52, `the recovery code is returned once to show: 52 characters in groups (${made.code?.length})`);
  ok(made.epoch === 0 && made.pos === 0 && made.dev?.added === 0 && made.dev?.removed === null && made.signer.length === 32, "the chain view: epoch 0, the head at position 0, the device added there and current, its signing key", made);
  ok(made.e0 === true && made.e1 === null, "the device holds epoch 0's keys and no other", { e0: made.e0, e1: made.e1 });
  const again = await P.ev(`code(async () => K.DeviceKeys.create("laptop"))`);
  ok(again.code === "exists", `turning it on again is refused (exists): ${J(again)}`);

  // ---- the keys, as stored: non-extractable, and the recovery code nowhere
  const stored = await P.ev(`new Promise((res) => { const r = indexedDB.open("sagebrush-e2e-v1"); r.onsuccess = () => { const tx = r.result.transaction(["devices", "pins"]); const d = tx.objectStore("devices").getAll(); const p = tx.objectStore("pins").getAll(); tx.oncomplete = () => res({ devices: d.result.map((x) => ({ sx: x.sign.privateKey.extractable, kx: x.kem.privateKey.extractable, id: x.id, keys: Object.keys(x).sort() })), pins: p.result, all: JSON.stringify([d.result.map((x) => ({ ...x, sign: 0, kem: 0 })), p.result]) }); }; })`);
  ok(stored.devices.length === 1 && stored.devices[0].sx === false && stored.devices[0].kx === false && stored.devices[0].id === made.id, "the device's signing and KEM private keys are stored non-extractable", stored.devices);
  ok(stored.pins.length === 1 && stored.pins[0].seq === 0 && stored.pins[0].hash === made.head && !stored.pins[0].forked, "the pin is the head the device verified", stored.pins);
  ok(!stored.all.includes(made.code.replace(/-/g, "").slice(0, 12)), "the recovery code is not stored");

  // ---- a reload: the device and its pin from IndexedDB, the epoch's keys from its wrapper again
  await load();
  const back = await P.ev(`(async () => { const k = await K.DeviceKeys.load(); window.keys = k; const v = await k.chain(true); return { id: k.device.id, head: v.head, e0: !!(await k.epochKeys(0)), sig: (await k.device.sign(new Uint8Array([1, 2, 3]))).length }; })()`);
  ok(back.id === made.id && back.head === made.head && back.e0 === true && back.sig === 64, "after a reload the same device loads, verifies the chain under its pin, reopens epoch 0's wrapper and signs", back);

  // ---- a pin the chain doesn't extend: forked, for good
  await P.ev(`new Promise((res) => { const r = indexedDB.open("sagebrush-e2e-v1"); r.onsuccess = () => { const tx = r.result.transaction("pins", "readwrite"); const s = tx.objectStore("pins"); const g = s.getAll(); const k = s.getAllKeys(); tx.oncomplete = () => { const t2 = r.result.transaction("pins", "readwrite"); t2.objectStore("pins").put({ ...g.result[0], hash: "A".repeat(42) + "A" }, k.result[0]); t2.oncomplete = () => res(true); }; }; })`);
  const forked = await P.ev(`code(async () => K.DeviceKeys.load())`);
  const forked2 = await P.ev(`code(async () => K.DeviceKeys.load())`);
  ok(forked.code === "chain_fork" && forked2.code === "forked", `a chain that doesn't extend this device's pin is refused (chain_fork), and the account is then forked here for good (${J([forked, forked2])})`);

  // ---- "Reset this device"
  const reset = await P.ev(`code(async () => { await K.resetDevice(${J(made.account)}); return (await K.DeviceKeys.load()) === null; })`);
  ok(reset.ok === true, "after Reset this device, this browser has no device for the account (it enrolls again)", reset);
  ok(requests > 0, `(the page's requests went to the server: ${requests})`);
} catch (e) {
  ok(false, "the test ran to its end: " + (e?.stack ?? e));
} finally {
  await B.close();
  server.close();
  await mf.dispose();
}
console.log(failures ? `${failures} of ${count} FAILED` : `all ${count} passed`);
process.exit(failures ? 1 : 0);
