// ci: web-sync.5 order=20 chrome
// This browser's E2E device (web/workspace/e2e/device-keys.ts; plan notes m1-page-keys-plan M1a), in headless Chromium
// with its real WebCrypto and IndexedDB, against the sync server's key chain routes in Miniflare (SYNC_E2E on, DEV
// only). The page's requests go through a small proxy that adds the test's session, as same-origin requests do:
// genesis from the page (a device, a recovery code shown once, epoch 0); its keys non-extractable; a reload finds the
// device and its pin, and the epoch's keys again; the chain view the sync client reads; a pin the chain doesn't extend
// (a fork, a rollback, a reset since it, an emptied or compacted chain) marks the account forked for good, for every
// object of the account in the page; the stored pin never moves back; "Reset this device" forgets the device, its pin
// and the mark; and genesis whose append fails or whose answer is lost ends either finished or with nothing left.
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
// (genesis whose append's answer is lost after it applied; one refused before it applied; one whose chain then can't be read)
const LOST = "de71ce00-0002-4e2e-8e2e-e2e2e2e2e202", REFUSED = "de71ce00-0003-4e2e-8e2e-e2e2e2e2e203", DARK = "de71ce00-0004-4e2e-8e2e-e2e2e2e2e204";
// (one answered 503 with no entry: kept, unconfirmed)
const LATE = "de71ce00-0005-4e2e-8e2e-e2e2e2e2e205";
// (one whose append fails while another device's genesis lands first)
const OTHER = "de71ce00-0006-4e2e-8e2e-e2e2e2e2e206";
const script = execFileSync("bun", ["build", join(here, "../sync/test-entry.ts"), "--format", "esm", "--target", "browser", "--external", "cloudflare:workers"], { encoding: "utf8", maxBuffer: 64 << 20 });
const plan = { storage_bytes: 1 << 30, max_file_bytes: 1 << 20, sync: { enabled: true, version_bytes: 1 << 20, read_bytes_per_day: 1 << 30 } };
const rl = (id) => ({ SYNC_PREAUTH: { namespace_id: id, simple: { limit: 1_000_000, period: 60 } }, SYNC_INGRESS_IP: { namespace_id: "8" + id, simple: { limit: 1_000_000, period: 60 } }, SYNC_ACCOUNT_INGRESS: { namespace_id: "9" + id, simple: { limit: 1_000_000, period: 60 } }, SYNC_ADMIN_LIMIT: { namespace_id: "7" + id, simple: { limit: 1_000_000, period: 60 } } });
const mf = new Miniflare(convertV4MiniflareOptions({
  workers: [{
    modules: true, script, compatibilityDate: "2026-10-01", d1Databases: ["SHARE_DB"], r2Buckets: ["SHARE_BUCKET"],
    name: "on", routes: ["sagebrush.test/*"], outboundService: async () => Response.json(plan), ratelimits: rl("4301"),
    durableObjects: { SYNC_ACCOUNT: { className: "SyncAccount", useSQLite: true }, SYNC_DOC: { className: "SyncDoc", useSQLite: true } },
    bindings: { SESSION_KEY: "session-key", SHARE_DEV: "1", DEV_AUTH_TOKEN: "dev-token", COCALC_ORIGIN: "https://cocalc.test", COCALC_CLIENT_SECRET: "client-secret", PURGE_KEY: "purge-key", LIMITS_KEY: "limits-key", SYNC_ACCOUNTS: [A, LOST, REFUSED, DARK, LATE, OTHER].join(","), SYNC_E2E: "1", SYNC_TEST_PIN_MS: "1000" },
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
const sessions = {};
for (const [k, id] of Object.entries({ A, LOST, REFUSED, DARK, LATE, OTHER })) {
  sessions[k] = await signIn(id);
  ok((await at("/api/sync/v1/enable", { method: "POST", headers: { cookie: sessions[k], origin: SITE, "content-type": "application/json" }, body: "{}" })).status === 200, `(sync on for ${k})`);
}
const session = sessions.A;
const chainOf = async () => (await (await at("/api/sync/v1/e2e/chain?from=0", { headers: { cookie: session, origin: SITE } })).json());

// ---- the page: the module, and a proxy to the server with the session
const dir = mkdtempSync(join(tmpdir(), "sb-device-keys-"));
const entry = join(dir, "entry.ts");
writeFileSync(entry, [
  `export * as K from ${J(join(here, "e2e", "device-keys.ts"))};`,
  `export { e2eStart, DOWNGRADED } from ${J(join(here, "sync-e2e.ts"))};`,
  `export { e2eAccountOf } from ${J(join(here, "e2e-here.ts"))};`,
  `export { accountHash } from ${J(join(here, "..", "sync-protocol", "protocol.ts"))};`,
  // (the core and HPKE, for a row that makes a real next entry from the page with the recovery code)
  `export { e2eCore } from ${J(join(here, "e2e", "core-ready.ts"))};`,
  `export { hpke } from ${J(join(here, "e2e", "hpke.ts"))};`,
  `export { asKey } from ${J(join(here, "fleet", "core", "ed25519.mjs"))};`,
  `export { b64 } from ${J(join(here, "fleet", "core", "bytes.mjs"))};`,
].join("\n"));
const js = execFileSync("bun", ["build", entry, "--format", "esm", "--target", "browser"], { encoding: "utf8", maxBuffer: 64 << 20 });
rmSync(dir, { recursive: true, force: true });
const html = `<!doctype html><script type="module">import * as m from "/s.js"; Object.assign(window, m);
window.code = async (f) => { try { return { ok: await f() }; } catch (e) { return { code: e?.code ?? String(e?.message ?? e) }; } };
// (the store, read and written as another tab would)
window.idb = (fn) => new Promise((res, rej) => { const r = indexedDB.open("sagebrush-e2e-v1"); r.onsuccess = () => { const tx = r.result.transaction(["devices", "pins"], "readwrite"); const out = fn(tx.objectStore("devices"), tx.objectStore("pins")); tx.oncomplete = () => res(out instanceof IDBRequest ? out.result : out); tx.onerror = () => rej(tx.error); }; });
window.pinOf = (acct) => idb((d, p) => p.get(acct));
window.deviceOf = (acct) => idb((d) => d.get(acct));
// (a transport as the module's own, as another account (the proxy's x-test-as), and with faults: an append's answer
// lost after it was forwarded, an append refused before it, the chain unreadable, or the chain served as given)
window.transport = (as, f = {}) => async (method, path, body) => {
  const isAppend = method === "POST" && path.endsWith("/e2e/chain"), isChain = method === "GET" && path.includes("/e2e/chain");
  if (isAppend) f.posted = true;
  if (isAppend && f.refuse) return { status: f.refuse, json: {} };
  if (isChain && f.otherAfter && f.posted) { const r = await window.transport(as)(method, path, body); return { status: 200, json: { ...r.json, entries: [f.otherAfter] } }; }
  if (isChain && f.dark && f.dark()) return { status: 502, json: {} };
  if (isChain && f.before) await f.before();
  if (isChain && f.serve) { const r = await window.transport(as)(method, path, body); return { status: 200, json: { ...r.json, entries: f.serve(r.json.entries) } }; }
  const r = await fetch(path, { method, headers: { "x-test-as": as, ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = await r.json().catch(() => ({}));
  if (isAppend && f.lose) return { status: 502, json: {} };
  return { status: r.status, json };
};
window.ready = true;</script>`;
let requests = 0;
const server = createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/s.js") return res.writeHead(200, { "content-type": "text/javascript" }).end(js);
  if (!u.pathname.startsWith("/api/")) return res.writeHead(200, { "content-type": "text/html" }).end(html);
  requests++;
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const as = sessions[req.headers["x-test-as"]] ?? session;
  const r = await at(u.pathname + u.search, { method: req.method, headers: { cookie: as, origin: SITE, ...(req.headers["content-type"] ? { "content-type": req.headers["content-type"] } : {}) }, ...(chunks.length ? { body: Buffer.concat(chunks) } : {}) });
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
  const back = await P.ev(`(async () => { const k = await K.DeviceKeys.load(); window.keys = k; const v = await k.chain(true); return { id: k.device.id, head: v.head, e0: !!(await k.epochKeys(0)), sig: (await k.device.sign(new Uint8Array([1, 2, 3]))).length, unconfirmed: k.recoveryUnconfirmed }; })()`);
  ok(back.id === made.id && back.head === made.head && back.e0 === true && back.sig === 64, "after a reload the same device loads, verifies the chain under its pin, reopens epoch 0's wrapper and signs", back);
  ok(back.unconfirmed === false, "and, its genesis having returned the recovery code, it loads saying so (the stored mark, read back)", back);

  const acct = J(made.account);
  // (a device record kept aside, to put back as an enrollment would after a reset; and a reset)
  const keepDevice = async () => P.ev(`(async () => { window.kept = await deviceOf(${acct}); return !!window.kept; })()`);
  const putBack = async () => P.ev(`idb((d) => { d.put(window.kept, ${acct}); return true; })`);
  const reset = async () => P.ev(`code(async () => K.resetDevice(${acct}))`);
  await keepDevice();

  // ---- T3: two objects of one account; another load meets a fork and marks it: the first object's refresh is refused
  // as forked, and its pin doesn't move
  {
    const r = await P.ev(`(async () => {
      const k1 = await K.DeviceKeys.load();
      const before = await pinOf(${acct});
      await idb((d, p) => { p.put({ ...before, hash: "A".repeat(42) + "A" }, ${acct}); });
      const second = await code(async () => K.DeviceKeys.load());
      const third = await code(async () => K.DeviceKeys.load());
      const refresh = await code(async () => k1.chain(true));
      const after = await pinOf(${acct});
      return { second, third, refresh, moved: after.hash !== "A".repeat(42) + "A", forked: !!after.forked };
    })()`);
    ok(r.second.code === "chain_fork" && r.third.code === "forked" && r.refresh.code === "forked" && !r.moved && r.forked,
      "a fork another object met marks the account: a later load and an object already loaded are both refused (forked), the pin unmoved", r);
  }

  // ---- the same, for an object already in use (its epoch keys cached, having signed): once another object marks the
  // account forked, its sign, its chain view without a refresh and its epoch keys (cached or not) are all refused
  {
    await reset(); await putBack();
    const r = await P.ev(`(async () => {
      const k1 = await K.DeviceKeys.load();
      const warm = { e0: !!(await k1.epochKeys(0)), sig: (await k1.device.sign(new Uint8Array([1]))).length, view: !!(await k1.chain()) };
      const before = await pinOf(${acct});
      await idb((d, p) => { p.put({ ...before, hash: "A".repeat(42) + "A" }, ${acct}); });
      const second = await code(async () => K.DeviceKeys.load());
      const sign = await code(async () => k1.device.sign(new Uint8Array([1])));
      const view = await code(async () => k1.chain());
      const e0 = await code(async () => k1.epochKeys(0));
      const e1 = await code(async () => k1.epochKeys(1));
      return { warm, second, sign, view, e0, e1 };
    })()`);
    ok(r.warm.e0 && r.warm.sig === 64 && r.warm.view && r.second.code === "chain_fork" && [r.sign, r.view, r.e0, r.e1].every((x) => x.code === "forked"),
      "an object in use when another marks the account forked: its sign, chain view and epoch keys (cached or not) are refused (forked)", r);
  }

  // ---- sec2's C1: given the page's own E2E account id, load and create refuse a chain answer naming another, and
  // nothing is stored for it; given the right one, load works and a later 404 is still refused
  {
    await reset(); await putBack();
    const r = await P.ev(`(async () => {
      const hash = await accountHash(${J(A)}), mine = e2eAccountOf(hash), other = "abcdefghijklmnopqrstuvwxya";
      const load = await code(async () => !!(await K.DeviceKeys.load(undefined, other)));
      const before = await idb((d) => d.count());
      const create = await code(async () => (await K.DeviceKeys.create("x", transport("OTHER"), mine)).recoveryCode);
      const otherAcct = (await (await fetch("/api/sync/v1/e2e/chain?from=0", { headers: { "x-test-as": "OTHER" } })).json()).account;
      const stored = { otherDevice: !!(await deviceOf(otherAcct)), count: await idb((d) => d.count()) };
      const right = await code(async () => (await K.DeviceKeys.load(undefined, mine)).device.id);
      const after404 = await e2eStart({ hash, get: async () => ({ status: 404, json: async () => ({}) }), chunk: async () => { throw new Error("not needed"); } });
      return { mine: mine === ${acct}, load, create, before, stored, right, after404: after404.kind + ":" + (after404.reason === DOWNGRADED) };
    })()`);
    ok(r.mine && r.load.code === "wrong_account", "load given the page's E2E id refuses a chain answer naming another (wrong_account)", r);
    ok(r.create.code === "wrong_account" && !r.stored.otherDevice && r.stored.count === r.before, "create given the page's E2E id refuses a chain answer for another account, and stores no device", r);
    ok(r.right.ok === made.id && r.after404 === "blocked:true", "given the right id, load works, and a later 404 is still refused (blocked, never plain)", r);
  }

  // ---- tests6's T1 (sec2's H1): after genesis here, the server saying there's no chain (404, empty) is never plain
  // sync; with this browser's device and pin gone (Reset this device), the same answers are plain again
  {
    const r = await P.ev(`(async () => {
      const hash = await accountHash(${J(A)});
      const fake = (status, body) => async () => ({ status, json: async () => body });
      const start = async (get) => { const s = await e2eStart({ hash, get, chunk: async () => { throw new Error("the chunk isn't needed"); } }); return s.kind + (s.reason === DOWNGRADED ? ":downgraded" : ""); };
      const out = { same: e2eAccountOf(hash) === ${acct}, after: [await start(fake(404, {})), await start(fake(200, { account: e2eAccountOf(hash), entries: [] }))] };
      // (a pin only, the device record gone)
      await idb((d) => { d.delete(${acct}); });
      out.pinOnly = [await start(fake(404, {})), await start(fake(200, { account: e2eAccountOf(hash), entries: [] }))];
      await K.resetDevice(${acct});
      out.reset = [await start(fake(404, {})), await start(fake(200, { account: e2eAccountOf(hash), entries: [] }))];
      return out;
    })()`);
    ok(r.same && J(r.after) === J(["blocked:downgraded", "blocked:downgraded"]), "after genesis in this browser, the server answering 404 or an empty chain: no sync (blocked, never plain)", r);
    ok(J(r.pinOnly) === J(["blocked:downgraded", "blocked:downgraded"]), "with only the pin left (no device record), the same: blocked, never plain", r);
    ok(J(r.reset) === J(["plain", "plain"]), "after Reset this device (no device, no pin), 404 or an empty chain is plain sync again", r);
    await putBack();
  }

  // ---- and for Reset this device (in another tab): an object in use stops too, until the page loads a device again
  {
    await reset(); await putBack();
    const r = await P.ev(`(async () => {
      const k1 = await K.DeviceKeys.load();
      const warm = { e0: !!(await k1.epochKeys(0)), sig: (await k1.device.sign(new Uint8Array([1]))).length };
      await K.resetDevice(${acct});
      const out = { warm, sign: await code(async () => k1.device.sign(new Uint8Array([1]))), view: await code(async () => k1.chain()), refresh: await code(async () => k1.chain(true)), e0: await code(async () => k1.epochKeys(0)) };
      await idb((d) => { d.put(window.kept, ${acct}); });
      out.after = await code(async () => k1.device.sign(new Uint8Array([1])));
      return out;
    })()`);
    ok(r.warm.e0 && r.warm.sig === 64 && [r.sign, r.view, r.refresh, r.e0].every((x) => x.code === "no_device") && r.after.code === "no_device",
      "an object in use when Reset this device runs (another tab): its sign, chain view, refresh and epoch keys are refused (no_device), and stay so for that object", r);
    await reset(); await putBack();
  }

  // ---- C1: a fork mark another tab writes while this object's refresh is between its pin read and its advance survives:
  // the refresh is refused (forked) and the mark is still there
  {
    await reset(); await putBack();
    const r = await P.ev(`(async () => {
      const f = { armed: false };
      const k1 = await K.DeviceKeys.load(transport("A", { before: async () => { if (f.armed) { f.armed = false; await idb((d, p) => { const g = p.get(${acct}); g.onsuccess = () => p.put({ ...g.result, forked: { at: 1, code: "chain_fork" } }, ${acct}); }); } } }));
      f.armed = true;
      const refresh = await code(async () => k1.chain(true));
      const after = await pinOf(${acct});
      return { refresh, kept: !!after?.forked };
    })()`);
    ok(r.refresh.code === "forked" && r.kept, "a fork mark another tab writes during this object's refresh is kept: the refresh is refused (forked)", r);
    await reset(); await putBack();
  }

  // ---- T1: Reset this device forgets the pin and the fork mark too: the device enrolled again loads, pinned afresh
  {
    await reset();
    const gone = await P.ev(`(async () => ({ pin: (await pinOf(${acct})) ?? null, load: await code(async () => (await K.DeviceKeys.load()) === null) }))()`);
    await putBack();
    const again = await P.ev(`(async () => { const r = await code(async () => { const k = await K.DeviceKeys.load(); return (await k.chain()).head; }); return { r, pin: await pinOf(${acct}) }; })()`);
    ok(gone.pin === null && gone.load.ok === true && again.r.ok === made.head && again.pin?.hash === made.head && !again.pin.forked,
      "after Reset this device no pin or fork mark is left, and the device enrolled again loads with a fresh pin at the head", { gone, again });
  }

  // ---- T2: a chain reset since the pin (another generation) is refused and marks the account forked
  {
    await P.ev(`idb((d, p) => { const g = p.get(${acct}); g.onsuccess = () => p.put({ ...g.result, generation: "z".repeat(26) }, ${acct}); })`);
    const r = await P.ev(`(async () => [await code(async () => K.DeviceKeys.load()), await code(async () => K.DeviceKeys.load())])()`);
    ok(r[0].code === "chain_reset" && r[1].code === "forked", "a chain of another generation than the pin's (a reset since) is refused, and the account is then forked here", r);
    await reset(); await putBack();
  }

  // ---- N1, N2: a pinned device meeting an emptied chain, or one that starts at a reset, marks it too
  for (const [what, serve, code0] of [["an emptied chain", "() => []", "no_chain"], ["a chain that starts at a reset", "() => [JSON.stringify({ body: { op: 'reset' } })]", "chain_unanchored"]]) {
    await P.ev(`code(async () => K.DeviceKeys.load())`);
    const r = await P.ev(`(async () => [await code(async () => K.DeviceKeys.load(transport("A", { serve: ${serve} }))), await code(async () => K.DeviceKeys.load())])()`);
    ok(r[0].code === code0 && r[1].code === "forked", `a pinned device meeting ${what} is refused (${code0}) and the account is then forked here`, r);
    await reset(); await putBack();
  }

  // ---- T4: another object moves the stored pin forward; this object's refresh meets the older chain: refused, and the
  // stored pin stays where it is (a refresh replays from the stored pin, never from its own memory)
  {
    const r = await P.ev(`(async () => {
      const E = e2eCore();
      const old = { serve: null };
      const k1 = await K.DeviceKeys.load(transport("A", { serve: (entries) => (old.serve ? old.serve(entries) : entries) }));
      // (a real next entry from the page: the recovery key replaced, signed by this device, the new key countersigning
      // and proving its X25519 half; its package, the epoch's secret wrapped to the new key, read with the recovery code)
      const chain = await (await fetch("/api/sync/v1/e2e/chain?from=0")).json();
      const ctx = { aud: chain.aud, account: chain.account };
      const state = await E.replayFrom(chain.entries.map((e) => new TextEncoder().encode(e)), ctx);
      const rk = await E.recoveryKeys(E.seedOfCode(${J(made.code)}), ctx.account);
      const rw = await (await fetch("/api/sync/v1/e2e/wrapper?kind=recovery")).json();
      const { S } = await E.openWrapper({ hpke, state, ctx, bytes: new TextEncoder().encode(rw.wrapper), me: { kind: "recovery", id: ctx.account, recipient: rk.kem }, seen: () => false });
      const rk2 = await E.recoveryKeys(E.newRecoverySeed(), ctx.account);
      const draft = E.nextBody(state, ctx, "replace-recovery", { recovery: { sign: b64(rk2.sign.raw), kem: b64(rk2.kem.publicRaw) }, pop: null });
      const pre = await E.preEntryHash(draft);
      const ch = await E.challenge(hpke, rk2.kem.publicRaw, pre);
      const mac = await E.respond(hpke, rk2.kem, ch.enc, pre);
      const view = await k1.chain();
      const signer = await asKey(view.signerAt(view.head, k1.device.id), k1.device.sign);
      const bytes = await E.sealEntry(E.deviceSigner(k1.device.id, signer), { ...draft, pop: { enc: b64(ch.enc), mac: b64(mac) } }, signer, { recovery: rk2.sign });
      const next = (await E.applyChainEntry(state, bytes, ctx)).state;
      const w = await E.wrapEpoch({ hpke, state: next, ctx, sender: { id: k1.device.id, sign: signer }, recipient: { kind: "recovery", id: ctx.account }, n: 0, S });
      const posted = (await fetch("/api/sync/v1/e2e/chain", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ entry: new TextDecoder().decode(bytes), keyring: null, wrappers: [new TextDecoder().decode(w)] }) })).status;
      // (another object loads the longer chain: the stored pin moves to seq 1)
      const k2 = await K.DeviceKeys.load();
      const moved = await pinOf(${acct});
      const k2head = (await k2.chain()).head;
      // (k1, still at seq 0 in memory, is now served the chain as it was: just genesis)
      old.serve = (entries) => entries.slice(0, 1);
      const refresh = await code(async () => k1.chain(true));
      const after = await pinOf(${acct});
      return { posted, k2: k2head === next.head, moved: moved.seq, refresh, after: after.seq };
    })()`);
    ok(r.posted === 201 && r.k2 && r.moved === 1 && r.refresh.code === "chain_fork" && r.after === 1,
      "another object pins seq 1; this object's refresh, served the older chain, is refused (chain_fork) and the stored pin stays at 1", r);
  }

  // ---- H1: genesis whose append fails or whose answer is lost
  {
    // (its answer lost after it applied: the chain says so, and genesis finishes, its recovery code returned)
    const lost = await P.ev(`code(async () => { const { keys, recoveryCode } = await K.DeviceKeys.create("tablet", transport("LOST", { lose: true })); return { code: recoveryCode.length, unconfirmed: keys.recoveryUnconfirmed, again: !!(await K.DeviceKeys.load(transport("LOST"))), e0: !!(await keys.epochKeys(0)) }; })`);
    ok(lost.ok?.code === 64 && lost.ok.unconfirmed === false && lost.ok.again && lost.ok.e0, "genesis whose append's answer is lost after it applied finishes: the recovery code is returned, the device loads", lost);
    // (refused before it applied, definitely (a 4xx): no device is left behind, and trying again works)
    const refused = await P.ev(`(async () => {
      const first = await code(async () => K.DeviceKeys.create("phone", transport("REFUSED", { refuse: 409 })));
      const left = await K.DeviceKeys.load(transport("REFUSED"));
      const retry = await code(async () => (await K.DeviceKeys.create("phone", transport("REFUSED"))).recoveryCode.length);
      return { first, left: left === null, retry };
    })()`);
    ok(refused.first.code === "server" && refused.left && refused.retry.ok === 64, "genesis whose append is refused (409) before it applies leaves no device behind, and trying again succeeds", refused);
    // (another device's genesis first after this one's append failed, a real one that verifies: this device goes, no
    // recovery code, try again. A first entry that doesn't verify proves nothing: the device stays, unconfirmed)
    const other = await P.ev(`(async () => {
      const E = e2eCore();
      const c = await (await fetch("/api/sync/v1/e2e/chain?from=0", { headers: { "x-test-as": "OTHER" } })).json();
      const acct = c.account, ctx = { aud: c.aud, account: c.account };
      const pair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
      const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
      const signer = await asKey(raw, async (m) => new Uint8Array(await crypto.subtle.sign("Ed25519", pair.privateKey, m)));
      const rk = await E.recoveryKeys(E.newRecoverySeed(), acct);
      // (the device's own X25519 public key: any fresh one, here another recovery key's)
      const dk = await E.recoveryKeys(E.newRecoverySeed(), acct);
      const id = ${J(made.id)};
      const body = E.nextBody(null, ctx, "genesis", { device: { id, name: "another", kind: "browser", sign: b64(raw), kem: b64(dk.kem.publicRaw) }, recovery: { sign: b64(rk.sign.raw), kem: b64(rk.kem.publicRaw) }, epoch: { n: 0, suite: 1, commit: await E.epochCommit(E.newEpochSecret(), acct, 0), keyring: null } });
      const genesis = new TextDecoder().decode(await E.sealEntry(E.deviceSigner(id, signer), body, signer, { recovery: rk.sign }));
      const valid = !!(await E.applyChainEntry(null, new TextEncoder().encode(genesis), ctx));
      const tryWith = async (otherAfter) => { try { return { ok: (await K.DeviceKeys.create("laptop", transport("OTHER", { refuse: 503, otherAfter }))).recoveryCode }; } catch (e) { return { code: e.code, message: e.message }; } };
      const first = await tryWith(genesis);
      const left = !!(await deviceOf(acct));
      const out = { valid, first, left, bad: [] };
      // (unverifiable: a bare synthetic one, and the real one with its signature changed)
      const g = JSON.parse(genesis), sig = g.sig ?? null;
      const tampered = sig ? JSON.stringify({ ...g, sig: (sig[0] === "A" ? "B" : "A") + sig.slice(1) }) : genesis.replace("another", "anothex");
      for (const bad of [JSON.stringify({ body: { op: "genesis", from: "another device" } }), tampered]) {
        const r = await tryWith(bad);
        const kept = await deviceOf(acct);
        out.bad.push({ r, kept: !!kept, shown: kept?.recoveryShown ?? null });
        await K.resetDevice(acct);
      }
      return out;
    })()`);
    ok(other.valid && other.first.code === "server" && /try again/.test(other.first.message) && !other.first.ok && other.left === false, "genesis that finds another device's genesis first, one that verifies (its own append failed), forgets this device, returns no recovery code, and says to try again", other);
    ok(other.bad.length === 2 && other.bad.every((b) => b.r.code === "server" && /reload/.test(b.r.message) && b.kept && b.shown === false),
      "genesis that finds a first entry that doesn't verify (synthetic, or a real one with its signature changed) keeps this device, unconfirmed: it proves nothing", other.bad);
    // (a 5xx with no entry, twice: the append may still land, so the device stays, unconfirmed, and isn't forgotten)
    const late = await P.ev(`(async () => {
      const acct = (await (await fetch("/api/sync/v1/e2e/chain?from=0", { headers: { "x-test-as": "LATE" } })).json()).account;
      const first = await code(async () => K.DeviceKeys.create("tv", transport("LATE", { refuse: 503 })));
      const kept = await deviceOf(acct);
      return { first, kept: !!kept, shown: kept?.recoveryShown ?? null };
    })()`);
    ok(late.first.code === "server" && late.kept && late.shown === false, "genesis answered 503 with no entry yet (read twice) keeps the device, marked unconfirmed, rather than forgetting it", late);
    // (its answer lost and the chain then unreadable: the device stays, marked as not having shown its recovery code)
    const dark = await P.ev(`(async () => {
      let posted = false;
      const first = await code(async () => K.DeviceKeys.create("desk", transport("DARK", { lose: true, dark: () => { const was = posted; posted = true; return was; } })));
      const k = await K.DeviceKeys.load(transport("DARK"));
      return { first, unconfirmed: k?.recoveryUnconfirmed ?? null };
    })()`);
    ok(dark.first.code === "server" && dark.unconfirmed === true, "genesis whose answer is lost and whose chain can't then be read keeps the device, which loads saying its recovery code may never have been shown", dark);
  }

  // ---- N3: only the current epoch's raw secret is kept, in a private field
  {
    const r = await P.ev(`(async () => { const k = await K.DeviceKeys.load(transport("LOST")); await k.epochKeys(0); return Object.keys(k).sort(); })()`);
    ok(!r.some((x) => /secret|current|derived|seen/i.test(x)), `no epoch secret or key cache is an ordinary property of the object (${J(r)})`);
  }
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
