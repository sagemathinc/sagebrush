// ci: web-runner order=352 runner=bun chrome
// This browser's device key and chain pin for an Autonomous fleet (fleet-device.ts; app pairing r4 §1-§2, §6 H2), in
// headless Chromium with real WebCrypto and IndexedDB: the module bundled by Bun and served on loopback (a secure
// context), each case on a page of its own.
//   CHROME=google-chrome bun web/workspace/test-fleet-device.mjs
import { join } from "node:path";
import { browser } from "../agents/a14-cases.mjs";

const here = new URL(".", import.meta.url).pathname;
let failures = 0;
const ok = (c, msg, detail) => { console.log((c ? "ok   " : "FAIL ") + msg + (!c && detail !== undefined ? "  " + JSON.stringify(detail).slice(0, 600) : "")); if (!c) failures++; };

const built = await Bun.build({ entrypoints: [join(here, "fleet-device.ts")], target: "browser", format: "esm" });
if (!built.success) throw new Error("fleet-device.ts didn't build: " + built.logs.join("\n"));
const js = await built.outputs[0].text();
const html = `<!doctype html><script type="module">import * as m from "/fleet-device.js"; window.fd = m; window.ready = true;</script>`;
const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (r) => new URL(r.url).pathname === "/fleet-device.js" ? new Response(js, { headers: { "content-type": "text/javascript" } }) : new Response(html, { headers: { "content-type": "text/html" } }) });
const site = `http://127.0.0.1:${server.port}`;

const F1 = "a".repeat(25) + "a", F2 = "b".repeat(25) + "e";
const H = (c) => c.repeat(43);
const B = await browser();
// (the helper's navigate and reload wait for the Agents app; this plain page is ready when its module is)
const settle = async (P, before) => { for (const t = Date.now(); P.loads === before && Date.now() - t < 10000; ) await new Promise((r) => setTimeout(r, 50)); await P.until(`window.ready === true`, 10000); };
const go = async (P, url) => { const n = P.loads; await P.send("Page.navigate", { url }); await settle(P, n); };
const reload = async (P) => { const n = P.loads; await P.send("Page.reload", {}); await settle(P, n); };
const page = async (url = site + "/") => { const P = await B.tab(); await go(P, url); return P; };
const err = (P, expr) => P.ev(`(async () => { try { await (${expr}); return null; } catch (e) { return String(e?.message ?? e); } })()`);
try {
  // ---- the key
  {
    const P = await page();
    ok((await P.ev(`fd.ed25519Available()`)) === true, "K-1: this Chromium's WebCrypto makes non-extractable Ed25519 keys");
    ok((await P.ev(`fd.deviceKey(${JSON.stringify(F1)})`)) === null, "K-1: a fleet with no key here: none");
    const pub = await P.ev(`fd.makeDeviceKey(${JSON.stringify(F1)}).then((b) => [...b])`);
    ok(Array.isArray(pub) && pub.length === 32, "K-2: makeDeviceKey gives the public key's 32 raw bytes", pub?.length);
    const again = await P.ev(`fd.deviceKey(${JSON.stringify(F1)}).then((k) => k && [...k.publicRaw])`);
    ok(JSON.stringify(again) === JSON.stringify(pub), "K-2: deviceKey gives the same public key back");
    ok(/already has a device key/.test(await err(P, `fd.makeDeviceKey(${JSON.stringify(F1)})`)), "K-2: a second key for the same fleet is refused (one per fleet per install)");
    // (the stored record, read straight from IndexedDB: the private half is a non-extractable CryptoKey, nothing else holds it)
    const stored = await P.ev(`new Promise((ok) => { const r = indexedDB.open("sagebrush-fleet-v1"); r.onsuccess = () => { const g = r.result.transaction("keys").objectStore("keys").get(${JSON.stringify(F1)}); g.onsuccess = async () => { const k = g.result; let exported = null; try { await crypto.subtle.exportKey("pkcs8", k.keys.privateKey); exported = "exported"; } catch (e) { exported = e.name; } ok({ keys: Object.keys(k).sort().join(), privType: k.keys.privateKey.type, extractable: k.keys.privateKey.extractable, alg: k.keys.privateKey.algorithm.name, exported }); }; }; })`);
    ok(stored.keys === "created,keys,publicRaw" && stored.privType === "private" && stored.extractable === false && stored.alg === "Ed25519" && stored.exported === "InvalidAccessError", "K-3: the record holds a non-extractable Ed25519 CryptoKey pair and the public bytes only; exportKey of the private half is refused", stored);
    await reload(P);
    ok(JSON.stringify(await P.ev(`fd.deviceKey(${JSON.stringify(F1)}).then((k) => k && [...k.publicRaw])`)) === JSON.stringify(pub), "K-3: the key is the same after a reload");
    ok((await P.ev(`fd.deviceKey(${JSON.stringify(F2)})`)) === null, "K-3: another fleet has no key (keys are per fleet)");
  }
  {
    // (two tabs making the first key at once: one keeps it, the other is refused; never two)
    const P = await page(), Q = await page();
    const both = await Promise.all([err(P, `fd.makeDeviceKey(${JSON.stringify(F2)})`), err(Q, `fd.makeDeviceKey(${JSON.stringify(F2)})`)]);
    ok(both.filter((e) => e === null).length === 1 && both.some((e) => /already has a device key/.test(e ?? "")), "K-4: two tabs making the same fleet's key at once: exactly one key is made", both);
  }
  {
    // (another origin of the same site's host, as DEV and PROD are: its own store, no key there)
    const P = await page(`http://localhost:${server.port}/`);
    ok((await P.ev(`fd.deviceKey(${JSON.stringify(F1)})`)) === null, "K-5: another origin has its own store: the key made on 127.0.0.1 isn't there on localhost");
  }
  {
    // (a browser without WebCrypto Ed25519: no key, no fallback, nothing stored)
    const P = await page();
    await P.ev(`(crypto.subtle.generateKey = () => Promise.reject(new DOMException("unsupported", "NotSupportedError")), true)`);
    const F3 = "c".repeat(25) + "i";
    ok((await P.ev(`fd.ed25519Available()`)) === false && /can't hold a Sagebrush device key/.test(await err(P, `fd.makeDeviceKey(${JSON.stringify(F3)})`)) && (await P.ev(`fd.deviceKey(${JSON.stringify(F3)})`)) === null, "K-6: without WebCrypto Ed25519: unavailable, makeDeviceKey refused, nothing stored");
  }
  // ---- the pin
  {
    const P = await page(), F = "d".repeat(25) + "m";
    const adv = (seq, hash) => err(P, `fd.advancePin(${JSON.stringify(F)}, { seq: ${seq}, hash: ${JSON.stringify(hash)} })`);
    const pinNow = () => P.ev(`fd.pin(${JSON.stringify(F)})`);
    ok((await pinNow()) === null, "P-1: no pin at first");
    ok((await adv(0, H("A"))) === null && (await adv(0, H("A"))) === null && (await adv(3, H("B"))) === null, "P-1: the first entry, the same again (no change), then a later one: each accepted");
    const p1 = await pinNow();
    ok(p1.seq === 3 && p1.hash === H("B") && p1.forked === false, "P-1: the pin is the newest entry", p1);
    ok((await adv(3, H("C"))) === "chain_fork", "P-2: the same seq with another hash (a fork): refused, chain_fork");
    const p2 = await pinNow();
    ok(p2.forked === true && p2.seq === 3 && p2.hash === H("B"), "P-2: the fleet is marked forked here; the pin itself is unchanged", p2);
    ok((await adv(9, H("D"))) === "chain_fork" && (await adv(3, H("B"))) === "chain_fork", "P-2: a forked fleet's pin never moves again, not even with the pinned entry itself");
    await reload(P);
    ok((await pinNow()).forked === true, "P-2: the fork mark survives a reload");
    const G = "e".repeat(25) + "q";
    const advG = (seq, hash) => err(P, `fd.advancePin(${JSON.stringify(G)}, { seq: ${seq}, hash: ${JSON.stringify(hash)} })`);
    ok((await advG(5, H("E"))) === null && (await advG(4, H("F"))) === "chain_fork" && (await P.ev(`fd.pin(${JSON.stringify(G)})`)).forked === true, "P-3: a lower seq (a rollback) is a fork too");
    for (const [why, expr] of [["fleet-upper", `fd.pin(${JSON.stringify(F.toUpperCase())})`], ["fleet-last-char", `fd.pin(${JSON.stringify("d".repeat(26))})`], ["seq-negative", `fd.advancePin(${JSON.stringify(G)}, { seq: -1, hash: ${JSON.stringify(H("A"))} })`], ["seq-float", `fd.advancePin(${JSON.stringify(G)}, { seq: 1.5, hash: ${JSON.stringify(H("A"))} })`], ["hash-short", `fd.advancePin(${JSON.stringify(G)}, { seq: 9, hash: "abc" })`]]) ok(typeof (await err(P, expr)) === "string", `P-4.${why}: refused`);
  }
  // ---- Reset this device
  {
    const P = await page(), F = "f".repeat(25) + "u";
    const before = await P.ev(`fd.makeDeviceKey(${JSON.stringify(F)}).then((b) => [...b])`);
    await err(P, `fd.advancePin(${JSON.stringify(F)}, { seq: 2, hash: ${JSON.stringify(H("A"))} })`);
    await err(P, `fd.advancePin(${JSON.stringify(F)}, { seq: 2, hash: ${JSON.stringify(H("B"))} })`);
    ok((await P.ev(`fd.pin(${JSON.stringify(F)})`)).forked === true, "R-1 precondition: a key and a forked pin");
    await P.ev(`fd.resetDevice(${JSON.stringify(F)}).then(() => true)`);
    ok((await P.ev(`fd.deviceKey(${JSON.stringify(F)})`)) === null && (await P.ev(`fd.pin(${JSON.stringify(F)})`)) === null, "R-1: Reset deletes the key and the pin, the fork mark with it");
    const after = await P.ev(`fd.makeDeviceKey(${JSON.stringify(F)}).then((b) => [...b])`);
    ok(after.length === 32 && JSON.stringify(after) !== JSON.stringify(before), "R-1: afterwards the install makes a new key (a new device), never the old one");
  }
  // ---- the module's surface: storage only, nothing that signs or gives out a private key
  {
    const P = await page();
    const names = await P.ev(`Object.keys(fd).sort().join()`);
    ok(names === "FLEET_ID,advancePin,deviceKey,ed25519Available,makeDeviceKey,pin,resetDevice", "S-1: the module exports storage only: no sign, verify or private-key accessor", names);
  }
} catch (e) {
  ok(false, "the test ran to its end: " + (e?.stack ?? e));
} finally {
  await B.close();
  server.stop(true);
}
console.log(failures ? `${failures} FAILED` : "all passed");
process.exit(failures ? 1 : 0);
