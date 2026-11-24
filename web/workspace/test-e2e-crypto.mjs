// ci: web-runner order=354 runner=bun chrome
// The end-to-end encryption's crypto core (e2e/: design e2e-encryption.md §3), in headless Chromium with its real
// WebCrypto. Every derivation and every chunk's ciphertext is checked against an independent oracle here in the
// runner (Node's own HKDF, HMAC and AES-GCM, and the AAD encodings written out again); then every way of tampering
// with chunks, the bounds on inflating, the HPKE adapter both ways against @hpke/core (a second implementation, in
// tests only), and the browser floor.
//   CHROME=google-chrome bun web/workspace/test-e2e-crypto.mjs
import { createCipheriv, createHash, createHmac, hkdfSync } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { browser } from "../agents/a14-cases.mjs";

const here = new URL(".", import.meta.url).pathname;
const e2eDir = join(here, "e2e");
let failures = 0;
const ok = (c, msg, detail) => { console.log((c ? "ok   " : "FAIL ") + msg + (!c && detail !== undefined ? "  " + JSON.stringify(detail).slice(0, 600) : "")); if (!c) failures++; };

// ---- the oracle: the design's formulas written out again over Node's crypto, with their own encodings
const MiB = 1 << 20;
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; };
const fld = (b) => Buffer.concat([u32(b.length), Buffer.from(b)]);
const s8 = (s) => Buffer.from(s, "utf8");
const hkdf = (ikm, info, L = 32) => Buffer.from(hkdfSync("sha256", ikm, Buffer.alloc(0), info, L));
const gcm = (key, iv, aad, pt) => { const c = createCipheriv("aes-256-gcm", key, iv); c.setAAD(aad); return Buffer.concat([c.update(pt), c.final(), c.getAuthTag()]); };
const epochKey = (S, label, account, n) => hkdf(S, Buffer.concat([s8(label), fld(s8(account)), u64(n)]));
const count = (len) => Math.max(1, Math.ceil(len / MiB));
const piece = (len, i) => (i < count(len) - 1 ? MiB : len - MiB * (count(len) - 1));
const totalsAad = (h) => Buffer.concat([fld(s8(h.codec)), u64(h.plaintextLength), u64(h.compressedLength)]);
const objectFields = (h) => Buffer.concat([fld(s8(h.account)), fld(s8(h.kind)), fld(s8(h.object)), fld(s8(h.version)), totalsAad(h)]);
const objectKey = (cek, h, sealId) => hkdf(cek, Buffer.concat([s8("sagebrush.e2e.object.key.v1"), objectFields(h), sealId]));
const objectAad = (h, sealId, i) => Buffer.concat([s8("sagebrush.e2e.object.chunk.aad.v1"), objectFields(h), sealId, u32(count(h.compressedLength)), u32(i), u32(piece(h.compressedLength, i))]);
const blobAad = (h, i) => Buffer.concat([s8("sagebrush.e2e.blob.chunk.aad.v1"), fld(s8(h.account)), fld(s8(h.address)), totalsAad(h), u32(count(h.compressedLength)), u32(i), u32(piece(h.compressedLength, i))]);
const sliceOf = (bytes, len, i) => bytes.subarray(i * MiB, i * MiB + piece(len, i));

// (fixed inputs: an epoch secret, a SHA-256, a CEK, and compressed bytes that span three chunks)
const S = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
const SHA = createHash("sha256").update("a file's plaintext").digest();
const CEK = Buffer.alloc(32, 0x42);
const BIG = 2 * MiB + 3;
const big = Buffer.from(Array.from({ length: BIG }, (_, i) => (i * 7 + (i >> 9)) & 255));

// ---- L: the label table
{
  const { LABELS } = await import(join(e2eDir, "labels.ts"));
  const all = Object.values(LABELS);
  ok(Object.isFrozen(LABELS), "L-1: the label table is frozen");
  ok(new Set(all).size === all.length, "L-1: every label is distinct", all);
  const prefixed = all.flatMap((a) => all.filter((b) => a !== b && b.startsWith(a)).map((b) => `${a} < ${b}`));
  ok(prefixed.length === 0, "L-1: no label is a prefix of another (each is followed by its inputs)", prefixed);
  ok(all.every((l) => /^sagebrush\.[a-z0-9.-]+\.v1$/.test(l)), "L-1: every label is sagebrush.<purpose>.v1", all);
  const chain = ["sagebrush.keyring.v1", "sagebrush.kem-pop.v1", "sagebrush.e2e.recovery.sign.v1", "sagebrush.e2e.recovery.kem.v1", "sagebrush.e2e.epoch-commit.v1"];
  ok(chain.every((l) => all.includes(l)), "L-1: the key chain's five labels are in the same table");
  // (the design's own spellings, where it gives them)
  ok(LABELS.blobAddress === "sagebrush.blob.v1" && LABELS.blobFile === "sagebrush.blob.file.v1" && LABELS.blobChunk === "sagebrush.blob.chunk.v1", "L-1: the blob labels are §3.3's");
  // (no label spelled outside the table: every "sagebrush.<...>.v1" in e2e/ is in labels.ts)
  const files = readdirSync(e2eDir, { recursive: true }).filter((f) => /\.(?:ts|mts|js|mjs)$/.test(f) && f !== "labels.ts");
  const stray = files.flatMap((f) => [...readFileSync(join(e2eDir, f), "utf8").matchAll(/["'`]sagebrush\.[^"'`]*["'`]/g)].map((m) => `${f}: ${m[0]}`));
  ok(files.length >= 5 && stray.length === 0, `L-2: no module of e2e/ (${files.length} files, subdirectories too) spells a label itself (all come from LABELS)`, stray);
}

// ---- the page: e2e/ and @hpke/core, bundled for Chromium
const dir = mkdtempSync(join(tmpdir(), "sb-e2e-"));
const entry = join(dir, "entry.ts");
writeFileSync(entry, [
  `export * as e2e from ${JSON.stringify(join(e2eDir, "index.ts"))};`,
  `export { fleetCore } from ${JSON.stringify(join(here, "fleet", "install.ts"))};`,
  `export * as H from ${JSON.stringify(Bun.resolveSync("@hpke/core", here))};`,
].join("\n"));
const built = await Bun.build({ entrypoints: [entry], target: "browser", format: "esm" });
rmSync(dir, { recursive: true, force: true });
if (!built.success) throw new Error("e2e/ didn't build: " + built.logs.join("\n"));
const js = await built.outputs[0].text();
const html = `<!doctype html><script type="module">import * as m from "/e2e.js"; Object.assign(window, m);
window.hx = (b) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join("");
window.unhx = (h) => Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));
window.big = (n) => Uint8Array.from({ length: n }, (_, i) => (i * 7 + (i >> 9)) & 255);
window.msg = async (f) => { try { await f(); return "ok"; } catch (e) { return (e?.code ? e.code + ": " : "") + String(e?.message ?? e); } };
window.code = async (f) => { try { await f(); return "ok"; } catch (e) { return e?.code ?? String(e?.message ?? e); } };
window.sha = async (b) => new Uint8Array(await crypto.subtle.digest("SHA-256", b));
window.keys = () => e2e.deriveEpochKeys(unhx("${S.toString("hex")}"), "acct-1", 7);
window.blob = async (bytes, codec = "store.1") => { const k = await keys(), s = await sha(bytes), r = await e2e.sealBlob(k, s, bytes, codec); return { ...r, kf: await e2e.fileKey(k.blob, s, codec) }; };
window.ready = true;</script>`;
const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (r) => {
  if (new URL(r.url).pathname === "/e2e.js") return new Response(js, { headers: { "content-type": "text/javascript" } });
  return new Response(html, { headers: { "content-type": "text/html" } });
} });
const site = `http://127.0.0.1:${server.port}`;
const B = await browser();
const settle = async (P, before) => { for (const t = Date.now(); P.loads === before && Date.now() - t < 10000; ) await new Promise((r) => setTimeout(r, 50)); await P.until(`window.ready === true`, 10000); };
const page = async () => { const P = await B.tab(); const n = P.loads; await P.send("Page.navigate", { url: site + "/" }); await settle(P, n); return P; };
const J = (v) => JSON.stringify(v);

try {
  const P = await page();
  const ua = await P.ev(`navigator.userAgent`);
  console.log(`# in ${ua}`);

  // ---- F: the browser floor
  {
    const f = await P.ev(`e2e.checkFloor().then((r) => ({ ...r }))`);
    ok(f.ok === true, "F-1: this Chromium passes the floor (X25519 and Ed25519 with private keys that aren't extractable; HKDF, HMAC, AES-GCM by known answers)", f);
    const none = await P.ev(`e2e.checkFloor(undefined).then((r) => ({ ...r }))`);
    ok(none.ok === true, "F-1: (no argument means this page's crypto)", none);
    const stub = (method, alg) => `(() => { const s = crypto.subtle; const sub = new Proxy(s, { get: (t, k) => k === ${J(method)} ? (async (...r) => { if (r.some((a) => (a?.name ?? a) === ${J(alg)})) throw new DOMException("NotSupportedError"); return s[k](...r); }) : (typeof t[k] === "function" ? t[k].bind(t) : t[k]) }); return { subtle: sub, getRandomValues: (b) => crypto.getRandomValues(b) }; })()`;
    for (const [method, alg, name] of [["generateKey", "X25519", "x25519"], ["generateKey", "Ed25519", "ed25519"], ["importKey", "HKDF", "hkdf"], ["importKey", "AES-GCM", "aesGcm"]]) {
      const r = await P.ev(`e2e.checkFloor(${stub(method, alg)}).then((r) => ({ ...r }))`);
      ok(r.ok === false && J(r.missing) === J([name]) && r.message === "This browser can't sync securely; update it or use the desktop app.", `F-2: a browser without ${alg} fails the floor (missing ${name}) and is told it can't sync securely`, r);
    }
    // (a browser whose X25519 private key comes back extractable fails: the floor is about non-extractable keys)
    const leaky = `(() => { const s = crypto.subtle; return { getRandomValues: (b) => crypto.getRandomValues(b), subtle: new Proxy(s, { get: (t, k) => k === "generateKey" ? (async (a, x, u) => s.generateKey(a, true, u)) : (typeof t[k] === "function" ? t[k].bind(t) : t[k]) }) }; })()`;
    const lk = await P.ev(`e2e.checkFloor(${leaky}).then((r) => ({ ...r }))`);
    ok(lk.ok === false && lk.missing.includes("x25519") && lk.missing.includes("ed25519"), "F-2: private keys that come back extractable fail the floor", lk);
    const bad = await P.ev(`e2e.checkFloor({ subtle: crypto.subtle, getRandomValues: (b) => crypto.getRandomValues(b) }).then((r) => r.ok)`);
    ok(bad === true, "F-2: (and the same crypto unwrapped passes)");
    const hk = `(() => { const s = crypto.subtle; return { getRandomValues: (b) => crypto.getRandomValues(b), subtle: new Proxy(s, { get: (t, k) => k === "deriveBits" ? (async (a, key, len) => { const b = new Uint8Array(await s.deriveBits(a, key, len)); if (a.name === "HKDF") b[0] ^= 1; return b.buffer; }) : (typeof t[k] === "function" ? t[k].bind(t) : t[k]) }) }; })()`;
    const hr = await P.ev(`e2e.checkFloor(${hk}).then((r) => ({ ...r }))`);
    ok(hr.ok === false && J(hr.missing) === J(["hkdf"]), "F-2: an HKDF that gives a wrong answer fails the floor (RFC 5869's known answer)", hr);
    // (an engine whose raw Ed25519 import gives another key: RFC 8032's known signature then doesn't verify)
    const swap = `(() => { const s = crypto.subtle; return { getRandomValues: (b) => crypto.getRandomValues(b), subtle: new Proxy(s, { get: (t, k) => k === "importKey" ? (async (f, d, a, ...r) => (a?.name === "Ed25519" ? (await s.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])).publicKey : s.importKey(f, d, a, ...r))) : (typeof t[k] === "function" ? t[k].bind(t) : t[k]) }) }; })()`;
    const sw = await P.ev(`e2e.checkFloor(${swap}).then((r) => ({ ...r }))`);
    ok(sw.ok === false && J(sw.missing) === J(["ed25519"]), "F-2: an Ed25519 that doesn't verify RFC 8032's known signature fails the floor", sw);
    // (an AES-GCM that ignores the AAD fails: the probe checks a changed AAD is refused)
    const noAad = `(() => { const s = crypto.subtle; const strip = ({ additionalData, ...a }) => a; return { getRandomValues: (b) => crypto.getRandomValues(b), subtle: new Proxy(s, { get: (t, k) => k === "encrypt" || k === "decrypt" ? ((a, ...r) => s[k](a?.name === "AES-GCM" ? strip(a) : a, ...r)) : (typeof t[k] === "function" ? t[k].bind(t) : t[k]) }) }; })()`;
    const na = await P.ev(`e2e.checkFloor(${noAad}).then((r) => ({ ...r }))`);
    ok(na.ok === false && J(na.missing) === J(["aesGcm"]), "F-2: an AES-GCM that ignores its AAD fails the floor", na);
    // (fakes that a round trip alone would pass: each standard's known answer catches them)
    const fake = (body) => `(() => { const s = crypto.subtle; return { getRandomValues: (b) => crypto.getRandomValues(b), subtle: new Proxy(s, { get: (t, k) => { ${body} return typeof t[k] === "function" ? t[k].bind(t) : t[k]; } }) }; })()`;
    const fakes = {
      x25519: fake(`if (k === "deriveBits") return async (a, key, len) => a.name === "X25519" ? new Uint8Array(32).fill(0x42).buffer : s.deriveBits(a, key, len);`),
      hmac: fake(`if (k === "sign") return async (a, key, d) => (a?.name ?? a) === "HMAC" ? new Uint8Array(32).buffer : s.sign(a, key, d);`),
      aesGcm: fake(`if (k === "encrypt") return async (a, key, d) => a.name === "AES-GCM" ? new Uint8Array([...new Uint8Array(d.buffer ?? d), ...new Uint8Array(16)]).buffer : s.encrypt(a, key, d);
        if (k === "decrypt") return async (a, key, d) => { if (a.name !== "AES-GCM") return s.decrypt(a, key, d); if (new Uint8Array(a.additionalData).length !== 20) throw new DOMException("OperationError"); return new Uint8Array(d.buffer ?? d).slice(0, -16).buffer; };`),
      ed25519: fake(`if (k === "exportKey") return async (f, key) => key.type === "private" && key.algorithm.name === "Ed25519" ? new Uint8Array(48).buffer : s.exportKey(f, key);`),
    };
    const fr = {};
    for (const [name, c] of Object.entries(fakes)) fr[name] = await P.ev(`e2e.checkFloor(${c}).then((r) => ({ ...r }))`);
    ok(Object.entries(fr).every(([name, r]) => r.ok === false && J(r.missing) === J([name])), "F-3: a constant X25519 shared secret, an HMAC of zeros, a fake AES-GCM that appends 16 zero bytes, and an Ed25519 private key that exports anyway each fail the floor (RFC 7748, RFC 4231 and the GCM specification's known answers; the export is attempted)", fr);
    // (an AES-GCM that encrypts correctly but opens under the AAD it was sealed with, whatever it is given: it passes the
    //  known answer and fails only because a changed AAD isn't refused)
    const aadIgnored = fake(`if (k === "decrypt") return async (a, key, d) => a.name === "AES-GCM" && new Uint8Array(a.additionalData).length === 21 ? s.decrypt({ ...a, additionalData: new Uint8Array(a.additionalData).subarray(0, 20) }, key, d) : s.decrypt(a, key, d);`);
    const ai = await P.ev(`e2e.checkFloor(${aadIgnored}).then((r) => ({ ...r }))`);
    // (a browser that hands back generated private keys marked extractable, though exporting them fails: the flag itself fails the floor)
    const flagOnly = fake(`if (k === "generateKey") return async (a, x, u) => s.generateKey(a, true, u);
        if (k === "exportKey") return async (f, key) => { if (key.type === "private") throw new DOMException("InvalidAccessError"); return s.exportKey(f, key); };`);
    const fo = await P.ev(`e2e.checkFloor(${flagOnly}).then((r) => ({ ...r }))`);
    ok(fo.ok === false && J(fo.missing) === J(["x25519", "ed25519"]), "F-3: private keys marked extractable fail the floor even when an export of them fails", fo);
    ok(ai.ok === false && J(ai.missing) === J(["aesGcm"]), "F-3: an AES-GCM that passes the known answer but opens a changed AAD fails the floor (the refusal is checked on its own)", ai);
    const nw = await P.ev(`e2e.checkFloor({}).then((r) => ({ ...r }))`);
    ok(nw.ok === false && J(nw.missing) === J(["webcrypto"]), "F-2: no WebCrypto at all (an insecure origin) fails the floor", nw);
  }

  // ---- K: epoch keys, the wire address, file and chunk keys, against the oracle
  {
    const r = await P.ev(`(async () => {
      const k = await e2e.deriveEpochKeys(unhx(${J(S.toString("hex"))}), "acct-1", 7);
      const z = new Uint8Array(16), iv = new Uint8Array(12);
      const enc = async (key) => hx(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, z));
      const fk = await e2e.fileKey(k.blob, unhx(${J(SHA.toString("hex"))}), "zstd.1");
      const ck = await e2e.chunkKey(fk, 5);
      return {
        address: await e2e.wireAddress(k.addr, unhx(${J(SHA.toString("hex"))})),
        index: await enc(k.index), wrap: await enc(k.wrap), file: hx(fk), chunk5: await enc(ck),
        frozen: Object.isFrozen(k), n: k.n, account: k.account,
        keys: ["addr", "blob", "index", "wrap"].map((x) => [x, k[x].extractable, k[x].algorithm.name, [...k[x].usages].sort().join(",")]),
        chunkKey: [ck.extractable, ck.algorithm.name, [...ck.usages].sort().join(",")],
      };
    })()`);
    const kAddr = epochKey(S, "sagebrush.e2e.epoch.addr.v1", "acct-1", 7), kBlob = epochKey(S, "sagebrush.e2e.epoch.blob.v1", "acct-1", 7);
    const zEnc = (k) => gcm(k, Buffer.alloc(12), Buffer.alloc(0), Buffer.alloc(16)).toString("hex");
    const want = "a1:" + createHmac("sha256", kAddr).update(Buffer.concat([s8("sagebrush.blob.v1"), SHA])).digest("hex");
    ok(r.address === want, "K-1: wireAddress = a1: + hex(HMAC-SHA256(K_addr[e], label ‖ sha)), K_addr = HKDF(S, label ‖ account ‖ u64(e))", { got: r.address, want });
    ok(r.index === zEnc(epochKey(S, "sagebrush.e2e.epoch.index.v1", "acct-1", 7)), "K-1: K_index[e] is HKDF(S[e]) under its own label, account and epoch");
    ok(r.wrap === zEnc(epochKey(S, "sagebrush.e2e.epoch.wrap.v1", "acct-1", 7)), "K-1: K_wrap[e] likewise");
    const kFile = hkdf(kBlob, Buffer.concat([s8("sagebrush.blob.file.v1"), SHA, s8("zstd.1")]));
    ok(r.file === kFile.toString("hex"), "K-1: K_file = HKDF(K_blob[e], label ‖ sha ‖ codec)");
    ok(r.chunk5 === zEnc(hkdf(kFile, Buffer.concat([s8("sagebrush.blob.chunk.v1"), u32(5)]))), "K-1: K_chunk = HKDF(K_file, label ‖ u32(index))");
    ok(r.frozen && r.n === 7 && r.account === "acct-1", "K-2: the epoch's keys come frozen, with their epoch and account");
    ok(J(r.keys) === J([["addr", false, "HMAC", "sign"], ["blob", false, "HKDF", "deriveBits"], ["index", false, "AES-GCM", "decrypt,encrypt"], ["wrap", false, "AES-GCM", "decrypt,encrypt"]]), "K-2: no epoch key is extractable, and each has only its own use", r.keys);
    ok(J(r.chunkKey) === J([false, "AES-GCM", "decrypt,encrypt"]), "K-2: a chunk key isn't extractable", r.chunkKey);
    // (each input separates: another epoch, account, secret, sha or codec gives other keys)
    const sep = await P.ev(`(async () => {
      const S = unhx(${J(S.toString("hex"))}), sha = unhx(${J(SHA.toString("hex"))});
      const addr = async (S, a, n) => e2e.wireAddress((await e2e.deriveEpochKeys(S, a, n)).addr, sha);
      const S2 = S.slice(); S2[31] ^= 1; const sha2 = sha.slice(); sha2[0] ^= 1;
      const k = await e2e.deriveEpochKeys(S, "acct-1", 7);
      return {
        base: await addr(S, "acct-1", 7), epoch: await addr(S, "acct-1", 8), account: await addr(S, "acct-2", 7), secret: await addr(S2, "acct-1", 7),
        sha: await e2e.wireAddress(k.addr, sha2),
        files: [hx(await e2e.fileKey(k.blob, sha, "zstd.1")), hx(await e2e.fileKey(k.blob, sha, "zstd.2")), hx(await e2e.fileKey(k.blob, sha2, "zstd.1"))],
      };
    })()`);
    ok(new Set([sep.base, sep.epoch, sep.account, sep.secret, sep.sha]).size === 5 && sep.files[0] === r.file && new Set(sep.files).size === 3, "K-3: another epoch, account, secret or sha gives another address; another codec or sha another file key", sep);
    const refusals = await P.ev(`(async () => {
      const S = unhx(${J(S.toString("hex"))}), sha = unhx(${J(SHA.toString("hex"))}), k = await e2e.deriveEpochKeys(S, "a", 0);
      return {
        short: await code(() => e2e.deriveEpochKeys(S.subarray(1), "a", 0)), notBytes: await code(() => e2e.deriveEpochKeys([...S], "a", 0)),
        epochNeg: await code(() => e2e.deriveEpochKeys(S, "a", -1)), epochFrac: await code(() => e2e.deriveEpochKeys(S, "a", 1.5)), epochBig: await code(() => e2e.deriveEpochKeys(S, "a", 2 ** 53)),
        accountEmpty: await code(() => e2e.deriveEpochKeys(S, "", 0)), accountNul: await code(() => e2e.deriveEpochKeys(S, "a\\0b", 0)),
        accountLong: await code(() => e2e.deriveEpochKeys(S, "é".repeat(129), 0)), accountMax: await code(() => e2e.deriveEpochKeys(S, "x".repeat(256), 0)), accountOver: await code(() => e2e.deriveEpochKeys(S, "x".repeat(257), 0)),
        loneHigh: await code(() => e2e.deriveEpochKeys(S, "a" + String.fromCharCode(0xd800), 0)), loneLow: await code(() => e2e.deriveEpochKeys(S, String.fromCharCode(0xdc00) + "a", 0)),
        reversedPair: await code(() => e2e.deriveEpochKeys(S, String.fromCharCode(0xdc00, 0xd800), 0)), pair: await code(() => e2e.deriveEpochKeys(S, "a\u{1F600}b", 0)),
        highLead: await code(() => e2e.deriveEpochKeys(S, String.fromCharCode(0xd83d) + "ab", 0)), highMiddle: await code(() => e2e.deriveEpochKeys(S, "a" + String.fromCharCode(0xd83d) + "b", 0)),
        highThenHigh: await code(() => e2e.deriveEpochKeys(S, String.fromCharCode(0xd83d, 0xd83d, 0xde00), 0)), lowTrail: await code(() => e2e.deriveEpochKeys(S, "ab" + String.fromCharCode(0xde00), 0)),
        lowMiddle: await code(() => e2e.deriveEpochKeys(S, "a" + String.fromCharCode(0xde00) + "b", 0)), pairs: await code(() => e2e.deriveEpochKeys(S, "\u{1F600}\u{10FFFF}\u{10000}", 0)),
        shaShort: await code(() => e2e.wireAddress(k.addr, sha.subarray(1))), fileSha: await code(() => e2e.fileKey(k.blob, sha.subarray(1), "zstd.1")),
        codecUpper: await code(() => e2e.fileKey(k.blob, sha, "Zstd")), codecEmpty: await code(() => e2e.fileKey(k.blob, sha, "")), codecLong: await code(() => e2e.fileKey(k.blob, sha, "z".repeat(33))),
        codecMax: await code(() => e2e.fileKey(k.blob, sha, "z".repeat(32))), chunkNeg: await code(() => e2e.chunkKey(new Uint8Array(32), -1)), chunkBig: await code(() => e2e.chunkKey(new Uint8Array(32), 2 ** 32)),
        chunkMax: await code(() => e2e.chunkKey(new Uint8Array(32), 2 ** 32 - 1)), fileShort: await code(() => e2e.chunkKey(new Uint8Array(31), 0)),
      };
    })()`);
    const wantR = { short: "bad_form", notBytes: "bad_form", epochNeg: "bad_form", epochFrac: "bad_form", epochBig: "bad_form", accountEmpty: "bad_form", accountNul: "bad_form", accountLong: "bad_form", accountMax: "ok", accountOver: "bad_form", loneHigh: "bad_form", loneLow: "bad_form", reversedPair: "bad_form", pair: "ok", highLead: "bad_form", highMiddle: "bad_form", highThenHigh: "bad_form", lowTrail: "bad_form", lowMiddle: "bad_form", pairs: "ok", shaShort: "bad_form", fileSha: "bad_form", codecUpper: "bad_form", codecEmpty: "bad_form", codecLong: "bad_form", codecMax: "ok", chunkNeg: "bad_form", chunkBig: "bad_form", chunkMax: "ok", fileShort: "bad_form" };
    ok(J(refusals) === J(wantR), "K-4: malformed inputs are refused (bad_form): a secret, sha or file key not 32 bytes, an epoch or index out of range, an empty, NUL or over-256-byte name, an unpinned codec; the bounds themselves pass", refusals);
  }

  {
    // (the well-formedness check against the platform's own String.prototype.isWellFormed, over 4000 seeded
    //  pseudo-random strings dense in surrogates)
    const r = await P.ev(`(async () => {
      const units = [0x41, 0xd800, 0xd83d, 0xdbff, 0xdc00, 0xde00, 0xdfff, 0xe000, 0xfffd];
      let disagree = [], refusedIll = 0, acceptedWell = 0, n = 0, seed = 12345;
      const next = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) % units.length; // (seeded: the same strings every run)
      for (let t = 0; t < 4000; t++) {
        const len = 1 + (t % 6), s = String.fromCharCode(...Array.from({ length: len }, () => units[next()]));
        const ours = (await code(() => e2e.deriveEpochKeys(new Uint8Array(32), s, 0))) === "ok";
        if (ours !== s.isWellFormed()) disagree.push([...s].map((c) => c.charCodeAt(0).toString(16)));
        if (ours) acceptedWell++; else refusedIll++;
        n++;
      }
      return { n, disagree: disagree.slice(0, 5), refusedIll, acceptedWell };
    })()`);
    ok(r.disagree.length === 0 && r.refusedIll > 200 && r.acceptedWell > 200, `K-5: names are admitted exactly when String.prototype.isWellFormed says so (${r.n} seeded strings: ${r.acceptedWell} admitted, ${r.refusedIll} refused)`, r);
  }

  // ---- B: blobs: sealBlob derives everything from (epoch, sha, codec); the chunks are exactly the oracle's
  {
    const r = await P.ev(`(async () => {
      const a = await blob(big(${BIG})), b = await blob(big(${BIG}));
      return { header: { ...a.header }, frozen: Object.isFrozen(a.header), chunks: a.chunks.map(hx), same: a.chunks.every((c, i) => hx(c) === hx(b.chunks[i])) };
    })()`);
    const shaBig = createHash("sha256").update(big).digest();
    const kAddr = epochKey(S, "sagebrush.e2e.epoch.addr.v1", "acct-1", 7), kBlob = epochKey(S, "sagebrush.e2e.epoch.blob.v1", "acct-1", 7);
    const h = { account: "acct-1", address: "a1:" + createHmac("sha256", kAddr).update(Buffer.concat([s8("sagebrush.blob.v1"), shaBig])).digest("hex"), codec: "store.1", plaintextLength: BIG, compressedLength: BIG };
    ok(J(r.header) === J(h) && r.frozen, "B-1: sealBlob's header is the epoch's account, the file's wire address, the codec and both lengths, frozen (the oracle's)", r.header);
    const kFile = hkdf(kBlob, Buffer.concat([s8("sagebrush.blob.file.v1"), shaBig, s8("store.1")]));
    const want = Array.from({ length: count(BIG) }, (_, i) => gcm(hkdf(kFile, Buffer.concat([s8("sagebrush.blob.chunk.v1"), u32(i)])), Buffer.alloc(12), blobAad(h, i), sliceOf(big, BIG, i)).toString("hex"));
    ok(r.chunks.length === 3 && r.chunks.every((c, i) => c === want[i]), "B-1: each blob chunk is AES-256-GCM under its K_chunk (from K_file, from K_blob[e], the sha and the codec) with a zero nonce, and an AAD binding label, account, address, codec, both totals, count, index and length (the oracle's bytes)", r.chunks.map((c) => c.length));
    ok(r.chunks.map((c) => c.length / 2).join() === [MiB + 16, MiB + 16, 3 + 16].join(), "B-1: chunks of exactly 1 MiB, the last shorter, each with its 16-byte tag");
    ok(r.same, "B-2: the same epoch, file and codec always give the same chunks (two devices upload the same ciphertext)");
  }
  {
    // (a zero nonce is safe only while each chunk key encrypts one byte string: sealBlob owns that, taking a pinned
    //  codec's name, never an implementation)
    const r = await P.ev(`(async () => {
      const k = await keys(), p = big(64), s = await sha(p), q = p.slice(); q[0] ^= 1;
      const clean = await e2e.sealBlob(k, s, p, "store.1");
      const p2 = p.slice(), s2 = s.slice();
      const pending = e2e.sealBlob(k, s2, p2, "store.1"); p2.fill(0); s2.fill(0);
      const m = await pending;
      const C = e2e.CODECS;
      let added = true; try { C.evil = { name: "evil", deflate: (x) => x }; } catch { added = false; }
      return {
        refused: {
          otherBytes: await code(() => e2e.sealBlob(k, s, q, "store.1")), unpinned: await code(() => e2e.sealBlob(k, s, p, "zstd.1")),
          inherited: await code(() => e2e.sealBlob(k, s, p, "constructor")), inheritedPinned: await code(() => e2e.pinnedCodec("constructor")), anImplementation: await code(() => e2e.sealBlob(k, s, p, { name: "store.1", deflate: (x) => x })),
          badName: await code(() => e2e.sealBlob(k, s, p, "STORE")), noKeys: await code(() => e2e.sealBlob({}, s, p, "store.1")),
          shaShort: await code(() => e2e.sealBlob(k, s.subarray(1), p, "store.1")), notPlain: await code(() => e2e.sealBlob(k, s, [...p], "store.1")),
          forgedAccount: await code(() => e2e.sealBlob({ ...k, account: "acct-2" }, s, p, "store.1")), frozenCopy: await code(() => e2e.sealBlob(Object.freeze({ ...k }), s, p, "store.1")),
          mixed: await code(async () => e2e.sealBlob({ ...k, blob: (await e2e.deriveEpochKeys(unhx("${S.toString("hex")}"), "acct-2", 7)).blob }, s, p, "store.1")),
        },
        genuineOther: await (async () => { const k2 = await e2e.deriveEpochKeys(unhx("${S.toString("hex")}"), "acct-2", 7), h2 = (await e2e.sealBlob(k2, s, p, "store.1")).header; return [h2.account, h2.address !== clean.header.address]; })(),
        snapshot: m.chunks.every((c, i) => hx(c) === hx(clean.chunks[i])) && m.header.address === clean.header.address,
        otherFile: (await e2e.sealBlob(k, await sha(q), q, "store.1")).header.address !== clean.header.address,
        registry: [Object.isFrozen(C), Object.keys(C), "evil" in C, Object.isFrozen(C["store.1"])],
      };
    })()`);
    ok(Object.values(r.refused).every((v) => v === "bad_form") && Object.keys(r.refused).length === 12, "B-3: sealBlob refuses a plaintext its SHA-256 doesn't name (a second byte string under one file key), a codec name this build doesn't pin (an inherited property's name too: constructor, a well-formed codec name), a codec implementation instead of a name, an ill-formed name, no epoch keys, a short sha, a plaintext that isn't bytes, and epoch keys deriveEpochKeys didn't make: a copy with another account, a frozen copy, one mixing two epochs' handles", r.refused);
    ok(J(r.genuineOther) === J(["acct-2", true]), "B-3: (another account's own keys seal under that account, at another address)", r.genuineOther);
    ok(r.snapshot, "B-3: it works on copies: changing the caller's plaintext and sha right after the call still gives the clean blob");
    ok(r.otherFile, "B-3: another file is another address (and so another file key)");
    ok(J(r.registry) === J([true, ["store.1"], false, true]), "B-4: the codec registry is frozen, holds only store.1 here, and nothing can be added to it", r.registry);
  }
  {
    // (the admission gate: every pinned codec has its determinism row here; a codec joining codecs.ts without one fails.
    //  store.1's compressed length is its plaintext length, so a compressing codec's row must also check sealBlob's
    //  header keeps the two lengths apart: until then a swap of them can't be seen)
    const DETERMINISM_ROWS = ["store.1"];
    const r = await P.ev(`(async () => {
      const out = {};
      for (const [name, c] of Object.entries(e2e.CODECS)) {
        const runs = [];
        for (const n of [0, 1, 1000, ${MiB + 5}]) {
          const x = big(n), a = c.deflate(x), b = c.deflate(x.slice());
          runs.push(hx(a) === hx(b) && a !== x && a.buffer !== x.buffer && hx(c.inflate(a, n)) === hx(x) && c.inflate(a, n) !== a);
        }
        out[name] = [c.name === name, runs.every(Boolean), await code(() => c.inflate(big(10), 9))];
      }
      return out;
    })()`);
    ok(J(Object.keys(r)) === J(DETERMINISM_ROWS), "C-1: every codec the registry pins has a determinism row in this test (the admission gate)", Object.keys(r));
    ok(J(r["store.1"]) === J([true, true, "limit"]), "C-1: store.1 gives the same bytes for the same input, in new buffers, inflates back within its bound and refuses past it", r["store.1"]);
  }

  // ---- O: documents and snapshots: the oracle opens what the page seals; the nonce is the prefix and the index
  const objH = { account: "acct-1", kind: "snapshot", object: "doc-9", version: "v3", codec: "zstd.1", plaintextLength: 4 * MiB, compressedLength: BIG };
  {
    const r = await P.ev(`(async () => {
      const cek = await e2e.importCek(unhx(${J(CEK.toString("hex"))}));
      const a = await e2e.sealObject(cek, ${J(objH)}, big(${BIG})), b = await e2e.sealObject(cek, ${J(objH)}, big(${BIG}));
      return { sealId: hx(a.sealId), chunks: a.chunks.map(hx), sealId2: hx(b.sealId), chunks2: b.chunks.map(hx), cek: [cek.extractable, cek.algorithm.name, [...cek.usages].join()] };
    })()`);
    const sealId = Buffer.from(r.sealId, "hex"), k = objectKey(CEK, objH, sealId);
    const want = Array.from({ length: count(BIG) }, (_, i) => gcm(k, Buffer.concat([Buffer.alloc(8), u32(i)]), objectAad(objH, sealId, i), sliceOf(big, BIG, i)).toString("hex"));
    ok(sealId.length === 32 && r.chunks.length === 3 && r.chunks.every((c, i) => c === want[i]), "O-1: each object chunk is AES-256-GCM under K_object = HKDF(CEK, label ‖ header fields ‖ seal id), nonce 0^64 ‖ u32(index), and an AAD binding label, account, kind, object, version, codec, totals, seal id, count, index and length (the oracle's bytes)");
    ok(r.sealId !== r.sealId2 && r.chunks.every((c, i) => c !== r.chunks2[i]), "O-1: each sealing draws a fresh 32-byte seal id, so the same bytes seal differently", [r.sealId, r.sealId2]);
    ok(J(r.cek) === J([false, "HKDF", "deriveKey"]), "O-1: importCek gives an HKDF key that isn't extractable and only derives keys", r.cek);
  }
  {
    // (round trips at the chunk boundaries, with an identity inflate: plaintext = compressed)
    const sizes = [0, 1, MiB - 1, MiB, MiB + 1, 2 * MiB + 3];
    const r = await P.ev(`(async () => {
      const cek = await e2e.importCek(unhx(${J(CEK.toString("hex"))}));
      const L = { maxPlaintext: 64 << 20, maxCompressed: 64 << 20, maxRatio: 1 };
      const out = [];
      for (const n of ${J(sizes)}) {
        const bytes = big(n), id = (c) => c.slice();
        const oh = { ...${J(objH)}, plaintextLength: n, compressedLength: n };
        const o = await e2e.sealObject(cek, oh, bytes), b = await blob(bytes);
        const oo = await e2e.openObject(cek, oh, o, id, L), bo = await e2e.openBlob(b.kf, b.header, b.chunks, id, L);
        out.push([n, o.chunks.length, b.chunks.length, hx(oo) === hx(bytes), hx(bo) === hx(bytes)]);
      }
      return out;
    })()`);
    ok(J(r) === J(sizes.map((n) => [n, count(n), count(n), true, true])), "O-2: objects and blobs of 0, 1, 1 MiB - 1, 1 MiB, 1 MiB + 1 and 2 MiB + 3 bytes open to their bytes (an empty one is one chunk with a tag)", r);
  }

  // ---- T: tampering, for objects and blobs alike: each is refused, and the inflate is never called
  {
    const r = await P.ev(`(async () => {
      const cek = await e2e.importCek(unhx(${J(CEK.toString("hex"))}));
      const cek2 = await e2e.importCek(new Uint8Array(32).fill(0x43));
      const B0 = await blob(big(${BIG})), kf = B0.kf, bh = B0.header, b = B0.chunks, kf2 = kf.slice(); kf2[0] ^= 1;
      const L = { maxPlaintext: 64 << 20, maxCompressed: 64 << 20, maxRatio: 8 };
      let calls = 0; const inflate = (c, max) => { calls++; return new Uint8Array(max); };
      const oh = ${J(objH)};
      const o = await e2e.sealObject(cek, oh, big(${BIG})), o2 = await e2e.sealObject(cek, oh, big(${BIG}));
      const flip = (cs, i, at) => cs.map((c, j) => { if (j !== i) return c; const d = c.slice(); d[at] ^= 1; return d; });
      const chunkCases = (cs) => ({
        flipFirst: flip(cs, 0, 0), flipMiddle: flip(cs, 1, 500000), flipTag: flip(cs, 2, cs[2].length - 1),
        swapped: [cs[1], cs[0], cs[2]], dropped: cs.slice(0, 2), added: [...cs, cs[2]], firstTwice: [cs[0], cs[0], cs[2]],
        cutShort: [cs[0], cs[1], cs[2].subarray(0, cs[2].length - 1)], longer: [cs[0], cs[1], new Uint8Array([...cs[2], 0])],
        notArray: "x", notBytes: [cs[0], cs[1], [...cs[2]]],
      });
      const headerCases = (h, extra) => Object.fromEntries([
        ["account", { ...h, account: "acct-2" }], ["codec", { ...h, codec: "zstd.2" }], ["plaintextLength", { ...h, plaintextLength: h.plaintextLength - 1 }],
        ["compressedLength", { ...h, compressedLength: h.compressedLength - 1 }], ...extra.map(([k, v]) => [k, { ...h, [k]: v }]),
      ]);
      const out = { object: {}, blob: {} };
      for (const [k, cs] of Object.entries(chunkCases(o.chunks))) out.object["chunks: " + k] = await code(() => e2e.openObject(cek, oh, { sealId: o.sealId, chunks: cs }, inflate, L));
      for (const [k, h] of Object.entries(headerCases(oh, [["kind", "document"], ["object", "doc-8"], ["version", "v4"]]))) out.object["header: " + k] = await code(() => e2e.openObject(cek, h, o, inflate, L));
      const p = o.sealId.slice(); p[31] ^= 1;
      out.object["seal id changed"] = await code(() => e2e.openObject(cek, oh, { sealId: p, chunks: o.chunks }, inflate, L));
      out.object["seal id short"] = await code(() => e2e.openObject(cek, oh, { sealId: o.sealId.subarray(1), chunks: o.chunks }, inflate, L));
      out.object["a chunk of another sealing"] = await code(() => e2e.openObject(cek, oh, { sealId: o.sealId, chunks: [o.chunks[0], o2.chunks[1], o.chunks[2]] }, inflate, L));
      out.object["another CEK"] = await code(() => e2e.openObject(cek2, oh, o, inflate, L));
      for (const [k, cs] of Object.entries(chunkCases(b))) out.blob["chunks: " + k] = await code(() => e2e.openBlob(kf, bh, cs, inflate, L));
      for (const [k, h] of Object.entries(headerCases(bh, [["address", "a1:" + "cd".repeat(32)]]))) out.blob["header: " + k] = await code(() => e2e.openBlob(kf, h, b, inflate, L));
      out.blob["another file key"] = await code(() => e2e.openBlob(kf2, bh, b, inflate, L));
      out.blob["address not a1:"] = await code(() => e2e.openBlob(kf, { ...bh, address: "a2:" + "ab".repeat(32) }, b, inflate, L));
      out.object["kind unknown"] = await code(() => e2e.openObject(cek, { ...oh, kind: "page" }, o, inflate, L));
      out.calls = calls;
      out.intact = [await code(() => e2e.openObject(cek, oh, o, inflate, L)), await code(() => e2e.openBlob(kf, bh, b, inflate, L)), calls];
      return out;
    })()`);
    const { calls, intact, ...groups } = r;
    const wrong = Object.entries(groups).flatMap(([g, cs]) => Object.entries(cs).filter(([, v]) => v !== "bad_form").map(([k, v]) => `${g} ${k}: ${v}`));
    ok(wrong.length === 0 && Object.keys(groups.object).length === 23 && Object.keys(groups.blob).length === 18, `T-1: every tampering is refused (bad_form): ${Object.keys(groups.object).length} object cases (a flipped byte or tag; chunks swapped, dropped, added, repeated, cut short, longer; a header field changed; the seal id; a chunk of another sealing; another CEK) and ${Object.keys(groups.blob).length} blob cases`, wrong);
    ok(calls === 0, "T-2: the inflate was never called for a refused object (authentication first)", calls);
    ok(J(intact) === J(["ok", "ok", 2]), "T-2: (and the untouched ones open, calling it once each)", intact);
  }

  {
    // (a wrong shape is refused before anything is decrypted: no work, and no memory, for a chunk of the wrong size)
    const r = await P.ev(`(async () => {
      const cek = await e2e.importCek(unhx(${J(CEK.toString("hex"))}));
      const L = { maxPlaintext: 64 << 20, maxCompressed: 64 << 20, maxRatio: 8 };
      let inflates = 0; const inflate = (c, max) => { inflates++; return new Uint8Array(max); };
      const oh = ${J(objH)};
      const B0 = await blob(big(${BIG})), kf = B0.kf, bh = B0.header, b = B0.chunks;
      const o = await e2e.sealObject(cek, oh, big(${BIG}));
      const real = crypto.subtle.decrypt; let decrypts = 0;
      crypto.subtle.decrypt = function (...a) { decrypts++; return real.apply(this, a); };
      const out = {};
      try {
        const hole = (cs, i) => { const a = [...cs]; delete a[i]; return a; };
        const shapes = (cs) => ({ dropped: cs.slice(0, 2), added: [...cs, cs[2]], cutShort: [cs[0], cs[1], cs[2].subarray(1)], longer: [cs[0], cs[1], new Uint8Array(cs[2].length + 1)], firstShort: [cs[0].subarray(1), cs[1], cs[2]], holeMiddle: hole(cs, 1), holeLast: hole(cs, 2), undefinedMiddle: [cs[0], undefined, cs[2]] });
        for (const [k, cs] of Object.entries(shapes(o.chunks))) out["object " + k] = [await code(() => e2e.openObject(cek, oh, { sealId: o.sealId, chunks: cs }, inflate, L)), decrypts, inflates];
        out["object seal id short"] = [await code(() => e2e.openObject(cek, oh, { sealId: o.sealId.subarray(1), chunks: o.chunks }, inflate, L)), decrypts, inflates];
        for (const [k, cs] of Object.entries(shapes(b))) out["blob " + k] = [await code(() => e2e.openBlob(kf, bh, cs, inflate, L)), decrypts, inflates];
        for (const [k, address] of [["address a2:", "a2:" + bh.address.slice(3)], ["address upper-case", bh.address.toUpperCase().replace("A1:", "a1:")], ["address short", bh.address.slice(0, -1)]]) out["blob " + k] = [await code(() => e2e.openBlob(kf, { ...bh, address }, b, inflate, L)), decrypts, inflates];
        out.holes = [1 in shapes(o.chunks).holeMiddle, 2 in shapes(o.chunks).holeLast, shapes(o.chunks).holeMiddle.length];
      } finally { crypto.subtle.decrypt = real; }
      return out;
    })()`);
    const { holes, ...shapes } = r;
    const wrong = Object.entries(shapes).filter(([, v]) => J(v) !== J(["bad_form", 0, 0]));
    ok(J(holes) === J([false, false, 3]), "T-3: (the sparse arrays really have holes, and keep their length)", holes);
    ok(Object.keys(shapes).length === 20 && wrong.length === 0, "T-3: a wrong number of chunks, a chunk of the wrong length, a hole or undefined in the middle or at the end, a short seal id, or a blob address that isn't a1: and 64 lower-case hex digits is refused (bad_form) before any chunk is decrypted or anything inflated", wrong);
  }

  {
    // (two names that TextEncoder writes alike, U+D800 and U+D801 alone both becoming U+FFFD, can't stand for each
    //  other: an ill-formed name is refused wherever a key, an object or a blob is named)
    const r = await P.ev(`(async () => {
      const cek = await e2e.importCek(unhx(${J(CEK.toString("hex"))}));
      const L = { maxPlaintext: 64, maxCompressed: 64, maxRatio: 1 }, id = (c) => c.slice();
      const a = String.fromCharCode(0xd800), b = String.fromCharCode(0xd801);
      const same = hx(new TextEncoder().encode(a)) === hx(new TextEncoder().encode(b));
      const oh = { ...${J(objH)}, plaintextLength: 5, compressedLength: 5 };
      const good = await e2e.sealObject(cek, oh, big(5)), goodBlob = await blob(big(5));
      const out = { same };
      for (const [k, v] of [["account", a], ["object", b], ["version", a + "x"]]) {
        out["seal object " + k] = await code(() => e2e.sealObject(cek, { ...oh, [k]: v }, big(5)));
        out["open object " + k] = await code(() => e2e.openObject(cek, { ...oh, [k]: v }, good, id, L));
      }
      out["open blob account"] = await code(() => e2e.openBlob(goodBlob.kf, { ...goodBlob.header, account: b }, goodBlob.chunks, id, L));
      out["epoch keys"] = [await code(() => e2e.deriveEpochKeys(new Uint8Array(32), a, 0)), await code(() => e2e.deriveEpochKeys(new Uint8Array(32), b, 0))];
      return out;
    })()`);
    const { same, ...cases } = r;
    const wrong = Object.entries(cases).filter(([, v]) => J(v) !== J("bad_form") && J(v) !== J(["bad_form", "bad_form"]));
    ok(same === true && Object.keys(cases).length === 8 && wrong.length === 0, "T-4: U+D800 and U+D801 alone encode alike (U+FFFD), and every name built from either is refused: an object's account, id or version (sealing and opening), a blob's account (opening; sealing takes it from the epoch's keys), an epoch's account (deriving)", { same, wrong });
  }

  // ---- Z: no plaintext left behind: every decrypted chunk and the assembled compressed bytes are cleared, whatever
  //      the outcome; sealing works on copies and clears them, and leaves the caller's buffers as they were
  {
    const r = await P.ev(`(async () => {
      const cek = await e2e.importCek(unhx(${J(CEK.toString("hex"))}));
      const L = { maxPlaintext: 64 << 20, maxCompressed: 64 << 20, maxRatio: 1 }, n = ${BIG}, bytes = big(n), oh = { ...${J(objH)}, plaintextLength: n, compressedLength: n };
      const before = hx(bytes);
      const o = await e2e.sealObject(cek, oh, bytes), B0 = await blob(bytes);
      const sealedLeft = hx(bytes) === before;
      const real = crypto.subtle.decrypt; let got = [];
      crypto.subtle.decrypt = function (...a) { return real.apply(this, a).then((ab) => { got.push(ab); return ab; }); };
      const zero = (b) => new Uint8Array(b instanceof ArrayBuffer ? b : b.buffer).every((x) => x === 0);
      const flip = (cs) => cs.map((c, j) => { if (j !== cs.length - 1) return c; const d = c.slice(); d[0] ^= 1; return d; });
      const out = { sealedLeft };
      try {
        const opens = { object: (cs, f) => e2e.openObject(cek, oh, { sealId: o.sealId, chunks: cs }, f, L), blob: (cs, f) => e2e.openBlob(B0.kf, B0.header, cs, f, L) };
        for (const [kind, open] of Object.entries(opens)) {
          const cs = kind === "object" ? o.chunks : B0.chunks;
          let c = null;
          got = []; const r1 = await open(cs, (x) => { c = x; return x.slice(); });
          out[kind + " opened"] = [hx(r1) === before, got.length, got.every(zero), zero(c)];
          got = []; c = null; const r2 = await open(cs, (x) => { c = x; return x; });
          out[kind + " inflate hands back its input"] = [hx(r2) === before, got.length, got.every(zero), zero(c)];
          got = []; c = null; const e3 = await code(() => open(flip(cs), (x) => { c = x; return x.slice(); }));
          out[kind + " last chunk forged"] = [e3, got.length, got.every(zero), c];
          got = []; c = null; const e4 = await code(() => open(cs, (x) => { c = x; throw new Error("codec failed"); }));
          out[kind + " inflate throws"] = [e4, got.length, got.every(zero), zero(c)];
          got = []; c = null; const e5 = await code(() => open(cs, (x) => { c = x; return x.subarray(1); }));
          out[kind + " inflate short"] = [e5, got.length, got.every(zero), zero(c)];
        }
      } finally { crypto.subtle.decrypt = real; }
      // (sealBlob leaves the caller's plaintext and sha as they were)
      const plain = big(100), s100 = await sha(plain), k = await keys();
      await e2e.sealBlob(k, s100, plain, "store.1");
      out["sealBlob leaves its inputs"] = [hx(plain) === hx(big(100)), hx(s100) === hx(await sha(big(100)))];
      // (its own copy of the plaintext, caught as WebCrypto hashes it: cleared after a seal, and after a refused one)
      const realDigest = crypto.subtle.digest; let hashed = [];
      crypto.subtle.digest = function (alg, data) { hashed.push(data); return realDigest.call(this, alg, data); };
      try {
        await e2e.sealBlob(k, s100, plain, "store.1");
        const afterSeal = [hashed.length, hashed.every(zero)];
        hashed = []; const other = big(100); other[0] ^= 1;
        const refused = await code(() => e2e.sealBlob(k, s100, other, "store.1"));
        out["sealBlob clears its copy"] = [...afterSeal, refused, hashed.length, hashed.every(zero), hx(other) !== hx(big(100))];
      } finally { crypto.subtle.digest = realDigest; }
      return out;
    })()`);
    ok(r.sealedLeft, "Z-1: sealing an object or a blob leaves the caller's bytes as they were");
    for (const kind of ["object", "blob"]) {
      ok(J(r[kind + " opened"]) === J([true, 3, true, true]) && J(r[kind + " inflate hands back its input"]) === J([true, 3, true, true]), `Z-1: opening a${kind === "object" ? "n" : ""} ${kind} clears its 3 decrypted chunks and the assembled bytes, and still returns the plaintext (a copy, when the inflate hands back its input)`, [r[kind + " opened"], r[kind + " inflate hands back its input"]]);
      ok(J(r[kind + " last chunk forged"]) === J(["bad_form", 2, true, null]), `Z-2: a${kind === "object" ? "n" : ""} ${kind} whose last chunk is forged: the 2 chunks decrypted before it are cleared, and nothing is inflated`, r[kind + " last chunk forged"]);
      ok(J(r[kind + " inflate throws"]) === J(["codec failed", 3, true, true]) && J(r[kind + " inflate short"]) === J(["bad_form", 3, true, true]), `Z-2: when a${kind === "object" ? "n" : ""} ${kind}'s inflate throws or comes up short, the chunks and the assembled bytes are cleared too`, [r[kind + " inflate throws"], r[kind + " inflate short"]]);
    }
    ok(J(r["sealBlob clears its copy"]) === J([1, true, "bad_form", 1, true, true]), "Z-3: sealBlob clears its own copy of the plaintext after a seal, and after one refused because the plaintext isn't the sha's (the caller's buffer is untouched)", r["sealBlob clears its copy"]);
    ok(J(r["sealBlob leaves its inputs"]) === J([true, true]), "Z-3: sealBlob works on its own copies and leaves the caller's plaintext and sha as they were", r["sealBlob leaves its inputs"]);
  }

  // ---- D: bounded inflating, after authentication
  {
    const r = await P.ev(`(async () => {
      const cek = await e2e.importCek(unhx(${J(CEK.toString("hex"))}));
      const oh = { ...${J(objH)}, plaintextLength: 1000, compressedLength: 10 };
      const o = await e2e.sealObject(cek, oh, big(10));
      const B0 = await blob(big(10)), kf = B0.kf, bh = B0.header, b = B0.chunks;
      // (an object of 1000 bytes compressed to 10; a stored blob of 10 bytes, whose header is changed for the bounds)
      const Lo = { maxPlaintext: 1000, maxCompressed: 10, maxRatio: 100 }, Lb = { maxPlaintext: 10, maxCompressed: 10, maxRatio: 1 };
      let calls = 0, asked = []; const inflate = (n) => (c, max) => { calls++; asked.push(max); return new Uint8Array(n); };
      const obj = (f, lim, h = {}) => code(() => e2e.openObject(cek, { ...oh, ...h }, o, f, lim));
      const bl = (f, lim, h = {}) => code(() => e2e.openBlob(kf, { ...bh, ...h }, b, f, lim));
      const out = {
        exact: [await obj(inflate(1000), Lo), await bl(inflate(10), Lb)],
        overPlaintext: [await obj(inflate(1000), { ...Lo, maxPlaintext: 999 }), await bl(inflate(10), { ...Lb, maxPlaintext: 9 })],
        overCompressed: [await obj(inflate(1000), { ...Lo, maxCompressed: 9 }), await bl(inflate(10), { ...Lb, maxCompressed: 9 })],
        overRatio: [await obj(inflate(1000), { ...Lo, maxRatio: 99 }), await bl(inflate(21), { maxPlaintext: 100, maxCompressed: 10, maxRatio: 2 }, { plaintextLength: 21 })],
        callsBeforeOutput: calls,
        inflatesMore: [await obj(inflate(1001), Lo), await bl(inflate(11), Lb)], inflatesLess: [await obj(inflate(999), Lo), await bl(inflate(9), Lb)],
        notBytes: [await obj(() => "x".repeat(1000), Lo), await bl(() => "x".repeat(10), Lb)],
        throws: [await obj(() => { throw new Error("codec: past maxOut"); }, Lo), await bl(() => { throw new Error("codec: past maxOut"); }, Lb)],
        noInflate: [await obj(undefined, Lo), await bl(undefined, Lb)], noLimits: [await obj(inflate(1000), undefined), await bl(inflate(10), undefined)],
        limitZero: [await obj(inflate(1000), { ...Lo, maxRatio: 0 }), await bl(inflate(10), { ...Lb, maxRatio: 0 })],
        limitInfinite: [await obj(inflate(1000), { ...Lo, maxPlaintext: Infinity }), await bl(inflate(10), { ...Lb, maxPlaintext: Infinity })],
        pinnedInflate: await bl((c, max) => e2e.pinnedCodec(bh.codec).inflate(c, max), Lb),
      };
      out.asked = [...new Set(asked)];
      return out;
    })()`);
    ok(J(r.exact) === J(["ok", "ok"]) && r.pinnedInflate === "ok", "D-1: an object or blob inflating to exactly its declared length opens (a blob with its pinned codec's inflate too)", r);
    ok(J([r.overPlaintext, r.overCompressed, r.overRatio]) === J([["limit", "limit"], ["limit", "limit"], ["limit", "limit"]]) && r.callsBeforeOutput === 2, "D-1: over the plaintext ceiling, the compressed ceiling or the ratio: limit, before the inflate is called", r);
    ok(J(r.asked) === J([1000, 10]), "D-1: the inflate is told the declared length as its maximum output", r.asked);
    ok(J([r.inflatesMore, r.inflatesLess, r.notBytes]) === J([["bad_form", "bad_form"], ["bad_form", "bad_form"], ["bad_form", "bad_form"]]), "D-2: an inflate giving more, fewer or no bytes is refused (bad_form)", r);
    ok(J(r.throws) === J(["codec: past maxOut", "codec: past maxOut"]), "D-2: an inflate that stops by throwing passes its error through");
    ok([r.noInflate, r.noLimits, r.limitZero, r.limitInfinite].every((x) => J(x) === J(["bad_form", "bad_form"])), "D-3: opening without an inflate or without finite, positive limits is refused", r);
  }

  // ---- S: sealing refuses what it can't seal
  {
    const r = await P.ev(`(async () => {
      const cek = await e2e.importCek(unhx(${J(CEK.toString("hex"))}));
      const k = await keys(), s10 = await sha(big(10)), oh = { ...${J(objH)}, compressedLength: 10 };
      return [
        await code(() => e2e.sealObject(cek, oh, big(9))), await code(() => e2e.sealObject(cek, oh, [...big(10)])), await code(() => e2e.sealObject(cek, { ...oh, plaintextLength: -1 }, big(10))),
        await code(() => e2e.sealObject(cek, { ...oh, kind: "x" }, big(10))), await code(() => e2e.sealObject(cek, { ...oh, version: "" }, big(10))),
        await code(() => e2e.sealBlob(k, s10, big(11), "store.1")), await code(() => e2e.sealBlob(k, s10.subarray(1), big(10), "store.1")), await code(() => e2e.sealBlob(null, s10, big(10), "store.1")),
        await code(() => e2e.sealBlob(k, s10, big(10), "ZSTD")), e2e.chunkCount(0), e2e.chunkCount(${MiB}), e2e.chunkCount(${MiB + 1}),
        await code(() => e2e.chunkCount(2 ** 52)),
      ];
    })()`);
    ok(J(r) === J(["bad_form", "bad_form", "bad_form", "bad_form", "bad_form", "bad_form", "bad_form", "bad_form", "bad_form", 1, 1, 2, "limit"]), "S-1: sealing refuses bytes of another length or not bytes, a bad header, a blob's plaintext its sha doesn't name, a short sha, no keys, an unpinned codec, and more chunks than a u32 counts", r);
  }

  // ---- H: the HPKE adapter (the fleet core's), and interop with @hpke/core both ways
  {
    const r = await P.ev(`(async () => {
      const gen = () => crypto.subtle.generateKey({ name: "X25519" }, false, ["deriveBits"]);
      const kp = await gen(), raw = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
      const R = { publicRaw: raw, privateKey: kp.privateKey }, info = new TextEncoder().encode("ctx"), aad = new Uint8Array([1, 2]), key = crypto.getRandomValues(new Uint8Array(32));
      const { enc, ct } = await e2e.hpke.seal(raw, info, aad, key);
      const extractable = await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"]);
      const ed = await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"]);
      const other = await gen();
      return {
        size: enc.length + ct.length, opens: hx(await e2e.hpke.open(R, enc, info, aad, ct)) === hx(key), pair: hx(await e2e.hpke.open(kp, enc, info, aad, ct)) === hx(key),
        wrongInfo: await code(() => e2e.hpke.open(R, enc, new TextEncoder().encode("ctx2"), aad, ct)), wrongAad: await code(() => e2e.hpke.open(R, enc, info, new Uint8Array([1]), ct)),
        wrongKey: await code(() => e2e.hpke.open(other, enc, info, aad, ct)), wrongPublic: await code(async () => e2e.hpke.open({ publicRaw: new Uint8Array(await crypto.subtle.exportKey("raw", other.publicKey)), privateKey: kp.privateKey }, enc, info, aad, ct)),
        extractable: await msg(() => e2e.hpke.open(extractable, enc, info, aad, ct)), ed25519: await msg(() => e2e.hpke.open({ publicRaw: raw, privateKey: ed.privateKey }, enc, info, aad, ct)),
        publicShort: await msg(() => e2e.hpke.open({ publicRaw: raw.subarray(1), privateKey: kp.privateKey }, enc, info, aad, ct)),
        noKey: await msg(() => e2e.hpke.open({ publicRaw: raw }, enc, info, aad, ct)),
        ecdh: await msg(async () => e2e.hpke.open({ publicRaw: raw, privateKey: (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"])).privateKey }, enc, info, aad, ct)),
        zeroEnc: await code(() => e2e.hpke.open(R, new Uint8Array(32), info, aad, ct)),
        exports: await (async () => {
          const x = new TextEncoder().encode("pop"), s = await e2e.hpke.sendExport(raw, info, x, 32);
          return {
            agree: hx(await e2e.hpke.receiveExport(R, s.enc, info, x, 32)) === hx(s.secret) && hx(await e2e.hpke.receiveExport(kp, s.enc, info, x, 32)) === hx(s.secret),
            size: [s.enc.length, s.secret.length], otherInfo: hx(await e2e.hpke.receiveExport(R, s.enc, new TextEncoder().encode("ctx2"), x, 32)) !== hx(s.secret),
            otherContext: hx(await e2e.hpke.receiveExport(R, s.enc, info, new TextEncoder().encode("pok"), 32)) !== hx(s.secret),
            otherKey: hx(await e2e.hpke.receiveExport(other, s.enc, info, x, 32)) !== hx(s.secret),
            badLength: [await code(() => e2e.hpke.sendExport(raw, info, x, 0)), await code(() => e2e.hpke.receiveExport(R, s.enc, info, x, 8161))],
            extractable: await msg(() => e2e.hpke.receiveExport(extractable, s.enc, info, x, 32)),
          };
        })(),
        frozen: Object.isFrozen(e2e.hpke),
      };
    })()`);
    ok(r.size === 80, "H-1: a 32-byte key wrapped with HPKE is 80 bytes (enc 32 + key 32 + tag 16)", r.size);
    ok(r.opens && r.pair, "H-1: it opens with { publicRaw, privateKey } and with the CryptoKeyPair itself");
    ok(J([r.wrongInfo, r.wrongAad, r.wrongKey, r.wrongPublic, r.zeroEnc]) === J(["bad_form", "bad_form", "bad_form", "bad_form", "bad_form"]), "H-2: another info, aad, key pair or stated public key, or an all-zero enc, doesn't open (bad_form)", r);
    const key = "bad_form: a recipient's private key is an X25519 key for deriveBits";
    ok(J([r.extractable, r.ed25519, r.ecdh, r.publicShort, r.noKey]) === J(["bad_form: a recipient's private key must not be extractable", key, key, "bad_form: an X25519 public key is 32 bytes", key]), "H-2: an extractable private key, a key of another algorithm (Ed25519; ECDH P-256, which also derives bits), no key, or a public key not 32 bytes is refused before any use", r);
    const x = r.exports;
    ok(x.agree && J(x.size) === J([32, 32]), "H-3: Export (RFC 9180 §5.3): the recipient derives the sender's secret, with { publicRaw, privateKey } and with the pair", x);
    ok(x.otherInfo && x.otherContext && x.otherKey, "H-3: another info, exporter context or key pair gives another secret", x);
    ok(J(x.badLength) === J(["bad_form", "bad_form"]) && x.extractable === "bad_form: a recipient's private key must not be extractable", "H-3: a length outside 1 to 8160 and an extractable private key are refused", x);
    ok(r.frozen, "H-3: the hpke object is frozen");
    const io = await P.ev(`(async () => {
      const suite = new H.CipherSuite({ kem: new H.DhkemX25519HkdfSha256(), kdf: new H.HkdfSha256(), aead: new H.Aes256Gcm() });
      const out = [];
      for (const [n, infoLen, aadLen] of [[0, 0, 0], [32, 17, 3], [1000, 200, 64]]) {
        const pt = big(n), info = crypto.getRandomValues(new Uint8Array(infoLen)), aad = crypto.getRandomValues(new Uint8Array(aadLen));
        // theirs to ours: they seal to our key, we open
        const kp = await crypto.subtle.generateKey({ name: "X25519" }, false, ["deriveBits"]), raw = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
        const s = await suite.createSenderContext({ recipientPublicKey: await suite.kem.deserializePublicKey(raw), info });
        const ct = new Uint8Array(await s.seal(pt, aad));
        const a = hx(await e2e.hpke.open(kp, new Uint8Array(s.enc), info, aad, ct)) === hx(pt);
        // ours to theirs: we seal to their key, they open
        const theirs = await suite.kem.generateKeyPair(), theirRaw = new Uint8Array(await suite.kem.serializePublicKey(theirs.publicKey));
        const m = await e2e.hpke.seal(theirRaw, info, aad, pt);
        const r = await suite.createRecipientContext({ recipientKey: theirs, enc: m.enc, info });
        const b = hx(await r.open(m.ct, aad)) === hx(pt);
        // Export, both ways: their sender's secret is our recipient's, and ours is theirs
        const xc = crypto.getRandomValues(new Uint8Array(infoLen)), L = 32 + n % 61;
        const theirsSecret = hx(await s.export(xc, L)), oursOpen = hx(await e2e.hpke.receiveExport(kp, new Uint8Array(s.enc), info, xc, L));
        const ox = await e2e.hpke.sendExport(theirRaw, info, xc, L);
        const theirsOpen = hx(await (await suite.createRecipientContext({ recipientKey: theirs, enc: ox.enc, info })).export(xc, L));
        const ex = theirsSecret === oursOpen && theirsOpen === hx(ox.secret) && ox.secret.length === L;
        // and theirs refuses ours under another info
        let refused = false;
        try { await (await suite.createRecipientContext({ recipientKey: theirs, enc: m.enc, info: new Uint8Array([...info, 0]) })).open(m.ct, aad); } catch { refused = true; }
        out.push([n, a, b, ex, refused]);
      }
      return out;
    })()`);
    ok(J(io) === J([[0, true, true, true, true], [32, true, true, true, true], [1000, true, true, true, true]]), "I-1: @hpke/core (tests only) and our HPKE agree both ways: theirs seals and ours opens, ours seals and theirs opens, for 0, 32 and 1000 bytes; each side's exported secret (32, 64 and 48 bytes) is the other's; theirs refuses ours under another info", io);
  }
} catch (e) {
  ok(false, "the test ran to its end: " + (e?.stack ?? e));
} finally {
  await B.close();
  server.stop(true);
}
console.log(failures ? `${failures} FAILED` : "all passed");
process.exit(failures ? 1 : 0);
