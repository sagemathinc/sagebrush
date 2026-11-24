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
const objectAad = (h, i) => Buffer.concat([s8("sagebrush.e2e.object.chunk.aad.v1"), fld(s8(h.account)), fld(s8(h.kind)), fld(s8(h.object)), fld(s8(h.version)), totalsAad(h), u32(count(h.compressedLength)), u32(i), u32(piece(h.compressedLength, i))]);
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
        shaShort: await code(() => e2e.wireAddress(k.addr, sha.subarray(1))), fileSha: await code(() => e2e.fileKey(k.blob, sha.subarray(1), "zstd.1")),
        codecUpper: await code(() => e2e.fileKey(k.blob, sha, "Zstd")), codecEmpty: await code(() => e2e.fileKey(k.blob, sha, "")), codecLong: await code(() => e2e.fileKey(k.blob, sha, "z".repeat(33))),
        codecMax: await code(() => e2e.fileKey(k.blob, sha, "z".repeat(32))), chunkNeg: await code(() => e2e.chunkKey(new Uint8Array(32), -1)), chunkBig: await code(() => e2e.chunkKey(new Uint8Array(32), 2 ** 32)),
        chunkMax: await code(() => e2e.chunkKey(new Uint8Array(32), 2 ** 32 - 1)), fileShort: await code(() => e2e.chunkKey(new Uint8Array(31), 0)),
      };
    })()`);
    const wantR = { short: "bad_form", notBytes: "bad_form", epochNeg: "bad_form", epochFrac: "bad_form", epochBig: "bad_form", accountEmpty: "bad_form", accountNul: "bad_form", accountLong: "bad_form", accountMax: "ok", accountOver: "bad_form", shaShort: "bad_form", fileSha: "bad_form", codecUpper: "bad_form", codecEmpty: "bad_form", codecLong: "bad_form", codecMax: "ok", chunkNeg: "bad_form", chunkBig: "bad_form", chunkMax: "ok", fileShort: "bad_form" };
    ok(J(refusals) === J(wantR), "K-4: malformed inputs are refused (bad_form): a secret, sha or file key not 32 bytes, an epoch or index out of range, an empty, NUL or over-256-byte name, an unpinned codec; the bounds themselves pass", refusals);
  }

  // ---- B: blobs: the chunks are exactly the oracle's, deterministic, and only their own
  const blobH = { account: "acct-1", address: "a1:" + "ab".repeat(32), codec: "zstd.1", plaintextLength: 5 * MiB, compressedLength: BIG };
  const kFileB = Buffer.alloc(32, 0x17);
  {
    const r = await P.ev(`(async () => {
      const h = ${J(blobH)}, kf = unhx(${J(kFileB.toString("hex"))});
      const a = await e2e.sealBlob(kf, h, big(${BIG})), b = await e2e.sealBlob(kf, h, big(${BIG}));
      const other = await e2e.sealBlob(kf, { ...h, codec: "zstd.2" }, big(${BIG}));
      return { chunks: a.map(hx), same: a.every((c, i) => hx(c) === hx(b[i])), otherCodec: other.map(hx) };
    })()`);
    const want = Array.from({ length: count(BIG) }, (_, i) => gcm(hkdf(kFileB, Buffer.concat([s8("sagebrush.blob.chunk.v1"), u32(i)])), Buffer.alloc(12), blobAad(blobH, i), sliceOf(big, BIG, i)).toString("hex"));
    ok(r.chunks.length === 3 && r.chunks.every((c, i) => c === want[i]), "B-1: each blob chunk is AES-256-GCM under its K_chunk with a zero nonce, and an AAD binding label, account, address, codec, both totals, count, index and length (the oracle's bytes)", r.chunks.map((c) => c.length));
    ok(r.chunks.map((c) => c.length / 2).join() === [MiB + 16, MiB + 16, 3 + 16].join(), "B-1: chunks of exactly 1 MiB, the last shorter, each with its 16-byte tag");
    ok(r.same, "B-2: the same file key, header and bytes always give the same chunks (two devices upload the same ciphertext)");
    ok(r.otherCodec.every((c, i) => c !== r.chunks[i]), "B-2: another codec in the header gives other chunks");
  }

  // ---- O: documents and snapshots: the oracle opens what the page seals; the nonce is the prefix and the index
  const objH = { account: "acct-1", kind: "snapshot", object: "doc-9", version: "v3", codec: "zstd.1", plaintextLength: 4 * MiB, compressedLength: BIG };
  {
    const r = await P.ev(`(async () => {
      const cek = await crypto.subtle.importKey("raw", unhx(${J(CEK.toString("hex"))}), "AES-GCM", false, ["encrypt", "decrypt"]);
      const a = await e2e.sealObject(cek, ${J(objH)}, big(${BIG})), b = await e2e.sealObject(cek, ${J(objH)}, big(${BIG}));
      return { prefix: hx(a.prefix), chunks: a.chunks.map(hx), prefix2: hx(b.prefix) };
    })()`);
    const prefix = Buffer.from(r.prefix, "hex");
    const want = Array.from({ length: count(BIG) }, (_, i) => gcm(CEK, Buffer.concat([prefix, u32(i)]), objectAad(objH, i), sliceOf(big, BIG, i)).toString("hex"));
    ok(prefix.length === 8 && r.chunks.length === 3 && r.chunks.every((c, i) => c === want[i]), "O-1: each object chunk is AES-256-GCM under the CEK, nonce = the object's 64-bit prefix ‖ u32(index), and an AAD binding label, account, kind, object, version, codec, totals, count, index and length (the oracle's bytes)");
    ok(r.prefix !== r.prefix2, "O-1: each sealing draws a fresh random prefix", [r.prefix, r.prefix2]);
  }
  {
    // (round trips at the chunk boundaries, with an identity inflate: plaintext = compressed)
    const sizes = [0, 1, MiB - 1, MiB, MiB + 1, 2 * MiB + 3];
    const r = await P.ev(`(async () => {
      const cek = await crypto.subtle.importKey("raw", unhx(${J(CEK.toString("hex"))}), "AES-GCM", false, ["encrypt", "decrypt"]);
      const kf = unhx(${J(kFileB.toString("hex"))}), L = { maxPlaintext: 64 << 20, maxCompressed: 64 << 20, maxRatio: 1 };
      const out = [];
      for (const n of ${J(sizes)}) {
        const bytes = big(n), id = (c) => c.slice();
        const oh = { ...${J(objH)}, plaintextLength: n, compressedLength: n }, bh = { ...${J(blobH)}, plaintextLength: n, compressedLength: n };
        const o = await e2e.sealObject(cek, oh, bytes), b = await e2e.sealBlob(kf, bh, bytes);
        const oo = await e2e.openObject(cek, oh, o, id, L), bo = await e2e.openBlob(kf, bh, b, id, L);
        out.push([n, o.chunks.length, b.length, hx(oo) === hx(bytes), hx(bo) === hx(bytes)]);
      }
      return out;
    })()`);
    ok(J(r) === J(sizes.map((n) => [n, count(n), count(n), true, true])), "O-2: objects and blobs of 0, 1, 1 MiB - 1, 1 MiB, 1 MiB + 1 and 2 MiB + 3 bytes open to their bytes (an empty one is one chunk with a tag)", r);
  }

  // ---- T: tampering, for objects and blobs alike: each is refused, and the inflate is never called
  {
    const r = await P.ev(`(async () => {
      const cek = await crypto.subtle.importKey("raw", unhx(${J(CEK.toString("hex"))}), "AES-GCM", false, ["encrypt", "decrypt"]);
      const cek2 = await crypto.subtle.importKey("raw", new Uint8Array(32).fill(0x43), "AES-GCM", false, ["encrypt", "decrypt"]);
      const kf = unhx(${J(kFileB.toString("hex"))}), kf2 = kf.slice(); kf2[0] ^= 1;
      const L = { maxPlaintext: 64 << 20, maxCompressed: 64 << 20, maxRatio: 8 };
      let calls = 0; const inflate = (c, max) => { calls++; return new Uint8Array(max); };
      const oh = ${J(objH)}, bh = ${J(blobH)};
      const o = await e2e.sealObject(cek, oh, big(${BIG})), o2 = await e2e.sealObject(cek, oh, big(${BIG}));
      const b = await e2e.sealBlob(kf, bh, big(${BIG}));
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
      for (const [k, cs] of Object.entries(chunkCases(o.chunks))) out.object["chunks: " + k] = await code(() => e2e.openObject(cek, oh, { prefix: o.prefix, chunks: cs }, inflate, L));
      for (const [k, h] of Object.entries(headerCases(oh, [["kind", "document"], ["object", "doc-8"], ["version", "v4"]]))) out.object["header: " + k] = await code(() => e2e.openObject(cek, h, o, inflate, L));
      const p = o.prefix.slice(); p[7] ^= 1;
      out.object["prefix changed"] = await code(() => e2e.openObject(cek, oh, { prefix: p, chunks: o.chunks }, inflate, L));
      out.object["prefix short"] = await code(() => e2e.openObject(cek, oh, { prefix: o.prefix.subarray(1), chunks: o.chunks }, inflate, L));
      out.object["a chunk of another sealing"] = await code(() => e2e.openObject(cek, oh, { prefix: o.prefix, chunks: [o.chunks[0], o2.chunks[1], o.chunks[2]] }, inflate, L));
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
    ok(wrong.length === 0 && Object.keys(groups.object).length === 23 && Object.keys(groups.blob).length === 18, `T-1: every tampering is refused (bad_form): ${Object.keys(groups.object).length} object cases (a flipped byte or tag; chunks swapped, dropped, added, repeated, cut short, longer; a header field changed; the prefix; a chunk of another sealing; another CEK) and ${Object.keys(groups.blob).length} blob cases`, wrong);
    ok(calls === 0, "T-2: the inflate was never called for a refused object (authentication first)", calls);
    ok(J(intact) === J(["ok", "ok", 2]), "T-2: (and the untouched ones open, calling it once each)", intact);
  }

  {
    // (a wrong shape is refused before anything is decrypted: no work, and no memory, for a chunk of the wrong size)
    const r = await P.ev(`(async () => {
      const cek = await crypto.subtle.importKey("raw", unhx(${J(CEK.toString("hex"))}), "AES-GCM", false, ["encrypt", "decrypt"]);
      const kf = unhx(${J(kFileB.toString("hex"))}), L = { maxPlaintext: 64 << 20, maxCompressed: 64 << 20, maxRatio: 8 }, inflate = (c, max) => new Uint8Array(max);
      const oh = ${J(objH)}, bh = ${J(blobH)};
      const o = await e2e.sealObject(cek, oh, big(${BIG})), b = await e2e.sealBlob(kf, bh, big(${BIG}));
      const real = crypto.subtle.decrypt; let decrypts = 0;
      crypto.subtle.decrypt = function (...a) { decrypts++; return real.apply(this, a); };
      const out = {};
      try {
        const shapes = (cs) => ({ dropped: cs.slice(0, 2), added: [...cs, cs[2]], cutShort: [cs[0], cs[1], cs[2].subarray(1)], longer: [cs[0], cs[1], new Uint8Array(cs[2].length + 1)], firstShort: [cs[0].subarray(1), cs[1], cs[2]] });
        for (const [k, cs] of Object.entries(shapes(o.chunks))) out["object " + k] = [await code(() => e2e.openObject(cek, oh, { prefix: o.prefix, chunks: cs }, inflate, L)), decrypts];
        out["object prefix short"] = [await code(() => e2e.openObject(cek, oh, { prefix: o.prefix.subarray(1), chunks: o.chunks }, inflate, L)), decrypts];
        for (const [k, cs] of Object.entries(shapes(b))) out["blob " + k] = [await code(() => e2e.openBlob(kf, bh, cs, inflate, L)), decrypts];
      } finally { crypto.subtle.decrypt = real; }
      return out;
    })()`);
    const wrong = Object.entries(r).filter(([, v]) => J(v) !== J(["bad_form", 0]));
    ok(Object.keys(r).length === 11 && wrong.length === 0, "T-3: a wrong number of chunks, a chunk of the wrong length or a short prefix is refused before any chunk is decrypted", wrong);
  }

  // ---- D: bounded inflating, after authentication
  {
    const r = await P.ev(`(async () => {
      const cek = await crypto.subtle.importKey("raw", unhx(${J(CEK.toString("hex"))}), "AES-GCM", false, ["encrypt", "decrypt"]);
      const kf = unhx(${J(kFileB.toString("hex"))});
      const oh = { ...${J(objH)}, plaintextLength: 1000, compressedLength: 10 }, bh = { ...${J(blobH)}, plaintextLength: 1000, compressedLength: 10 };
      const o = await e2e.sealObject(cek, oh, big(10)), b = await e2e.sealBlob(kf, bh, big(10));
      const L = { maxPlaintext: 1000, maxCompressed: 10, maxRatio: 100 };
      let calls = 0, asked = []; const inflate = (n) => (c, max) => { calls++; asked.push(max); return new Uint8Array(n); };
      const both = async (f, lim, h = {}) => [await code(() => e2e.openObject(cek, { ...oh, ...h }, o, f, lim)), await code(() => e2e.openBlob(kf, { ...bh, ...h }, b, f, lim))];
      const out = {
        exact: await both(inflate(1000), L),
        overPlaintext: await both(inflate(1000), { ...L, maxPlaintext: 999 }),
        overCompressed: await both(inflate(1000), { ...L, maxCompressed: 9 }),
        overRatio: await both(inflate(1000), { ...L, maxRatio: 99 }),
        callsBeforeOutput: calls,
        inflatesMore: await both(inflate(1001), L), inflatesLess: await both(inflate(999), L),
        notBytes: await both(() => "x".repeat(1000), L), throws: await both(() => { throw new Error("codec: past maxOut"); }, L),
        noInflate: await both(undefined, L), noLimits: await both(inflate(1000), undefined),
        limitZero: await both(inflate(1000), { ...L, maxRatio: 0 }), limitInfinite: await both(inflate(1000), { ...L, maxPlaintext: Infinity }),
      };
      out.asked = [...new Set(asked)];
      return out;
    })()`);
    ok(J(r.exact) === J(["ok", "ok"]), "D-1: an object inflating to exactly its declared length opens");
    ok(J([r.overPlaintext, r.overCompressed, r.overRatio]) === J([["limit", "limit"], ["limit", "limit"], ["limit", "limit"]]) && r.callsBeforeOutput === 2, "D-1: over the plaintext ceiling, the compressed ceiling or the ratio: limit, before the inflate is called", r);
    ok(J(r.asked) === J([1000]), "D-1: the inflate is told the declared length as its maximum output", r.asked);
    ok(J([r.inflatesMore, r.inflatesLess, r.notBytes]) === J([["bad_form", "bad_form"], ["bad_form", "bad_form"], ["bad_form", "bad_form"]]), "D-2: an inflate giving more, fewer or no bytes is refused (bad_form)", r);
    ok(J(r.throws) === J(["codec: past maxOut", "codec: past maxOut"]), "D-2: an inflate that stops by throwing passes its error through");
    ok([r.noInflate, r.noLimits, r.limitZero, r.limitInfinite].every((x) => J(x) === J(["bad_form", "bad_form"])), "D-3: opening without an inflate or without finite, positive limits is refused", r);
  }

  // ---- S: sealing refuses what it can't seal
  {
    const r = await P.ev(`(async () => {
      const cek = await crypto.subtle.importKey("raw", unhx(${J(CEK.toString("hex"))}), "AES-GCM", false, ["encrypt", "decrypt"]);
      const kf = unhx(${J(kFileB.toString("hex"))}), oh = { ...${J(objH)}, compressedLength: 10 }, bh = { ...${J(blobH)}, compressedLength: 10 };
      return [
        await code(() => e2e.sealObject(cek, oh, big(9))), await code(() => e2e.sealObject(cek, oh, [...big(10)])), await code(() => e2e.sealObject(cek, { ...oh, plaintextLength: -1 }, big(10))),
        await code(() => e2e.sealObject(cek, { ...oh, kind: "x" }, big(10))), await code(() => e2e.sealObject(cek, { ...oh, version: "" }, big(10))),
        await code(() => e2e.sealBlob(kf, bh, big(11))), await code(() => e2e.sealBlob(kf, { ...bh, address: "ab".repeat(32) }, big(10))), await code(() => e2e.sealBlob(kf.subarray(1), bh, big(10))),
        await code(() => e2e.sealBlob(kf, { ...bh, codec: "ZSTD" }, big(10))), e2e.chunkCount(0), e2e.chunkCount(${MiB}), e2e.chunkCount(${MiB + 1}),
        await code(() => e2e.chunkCount(2 ** 52)),
      ];
    })()`);
    ok(J(r) === J(["bad_form", "bad_form", "bad_form", "bad_form", "bad_form", "bad_form", "bad_form", "bad_form", "bad_form", 1, 1, 2, "limit"]), "S-1: sealing refuses bytes of another length, a bad header, a file key not 32 bytes, and more chunks than a u32 counts", r);
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
