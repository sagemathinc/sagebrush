// ci: web-sync.1 order=64 runner=bun
// A file's bytes as an end-to-end sync client sends them (web/workspace/e2e/blob-wire.ts; e2e PR 3b-2), with real
// WebCrypto: the frame round-trips (empty, small, past one chunk) at exactly sealedSize's length; the same file under
// one epoch gives the same address and bytes (dedup), another epoch or account another address; nothing of the file or
// its SHA-256 is in the frame; and every frame that isn't the file's own under this epoch and address is refused:
// tampered bytes, chunks swapped, truncated or padded, another codec or other lengths, a header that isn't canonical,
// another file's frame, another address, and a frame that authenticates but whose plaintext isn't the file.
//   bun web/workspace/test-e2e-blob-wire.mjs
import { join } from "node:path";

const here = new URL(".", import.meta.url).pathname;
const { e2eCore } = await import(join(here, "e2e", "core-ready.ts"));
e2eCore();
const K = await import(join(here, "e2e", "keys.ts"));
const W = await import(join(here, "e2e", "blob-wire.ts"));
const C = await import(join(here, "e2e", "chunks.ts"));
const B = await import(join(here, "e2e", "bytes.ts"));
const { LABELS } = await import(join(here, "e2e", "labels.ts"));
let failures = 0, count = 0;
const ok = (c, msg, detail) => { count++; console.log((c ? "ok   " : "FAIL ") + msg + (!c && detail !== undefined ? "  " + JSON.stringify(detail).slice(0, 400) : "")); if (!c) failures++; };
const code = async (f) => { try { await f(); return "ok"; } catch (e) { return e?.code ?? String(e?.message ?? e); } };
// (the refusal's code and message: which check refused it)
const why = async (f) => { try { await f(); return "ok"; } catch (e) { return `${e?.code}: ${e?.message}`; } };
const AEAD = /doesn't open under this key and header/;
const sha = async (b) => new Uint8Array(await crypto.subtle.digest("SHA-256", b));
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const has = (hay, needle) => { outer: for (let i = 0; i + needle.length <= hay.length; i++) { for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer; return true; } return false; };

const ACC = "abcdefghijklmnopqrstuvwxya", OTHER = "bcdefghijklmnopqrstuvwxyza";
const k0 = await K.deriveEpochKeys(new Uint8Array(32).fill(1), ACC, 0);
const k1 = await K.deriveEpochKeys(new Uint8Array(32).fill(2), ACC, 1);
const kOther = await K.deriveEpochKeys(new Uint8Array(32).fill(1), OTHER, 0);
const LIM = { maxPlaintext: 4 << 20, maxCompressed: 4 << 20, maxRatio: 1 };
// (a distinctive file: a pattern that occurs nowhere by chance)
const pattern = (n) => Uint8Array.from({ length: n }, (_, i) => (i * 131 + 7) & 0xff);

// ---- round trips, at exactly sealedSize's length
for (const n of [0, 1, 4096, C.CHUNK + 1]) {
  const pt = pattern(n), s = await sha(pt);
  const f = await W.sealFile(k0, s, pt);
  const back = await W.openFile(k0, s, f.address, f.body, LIM);
  ok(f.body.length === W.sealedSize(n) && /^a1:[0-9a-f]{64}$/.test(f.address) && f.ctSha256 === hex(await sha(f.body)) && back.length === n && back.every((x, i) => x === pt[i]),
    `a ${n}-byte file: sealed at an a1: address, its frame exactly sealedSize long with ct_sha256 its SHA-256, and opened back to its bytes`, { len: f.body.length, size: W.sealedSize(n) });
  if (n >= 4096) ok(!has(f.body, pt.subarray(0, 64)) && !has(f.body, s) && !has(new TextEncoder().encode(f.address), new TextEncoder().encode(hex(s))), `…and its frame holds none of the file's bytes, nor its SHA-256 (nor does its address)`);
}

// ---- dedup within an epoch; other epochs and accounts, other addresses
{
  const pt = pattern(100), s = await sha(pt);
  const [a, b] = [await W.sealFile(k0, s, pt), await W.sealFile(k0, s, pt)];
  ok(a.address === b.address && a.ctSha256 === b.ctSha256 && a.address === (await W.addressOf(k0, s)), "the same file under one epoch: the same address and the same frame (two devices' uploads are one blob), addressOf agreeing");
  const e1 = await W.sealFile(k1, s, pt), o = await W.sealFile(kOther, s, pt);
  ok(e1.address !== a.address && o.address !== a.address && o.address !== e1.address, "another epoch, or another account: another address for the same file");
  ok((await code(() => W.openFile(k1, s, a.address, a.body, LIM))) === "bad_form" && (await code(() => W.openFile(kOther, s, a.address, a.body, LIM))) === "bad_form",
    "a frame opened under another epoch's or another account's keys: refused");
}

// ---- tampering: every frame that isn't this file's own is refused
{
  const pt = pattern(C.CHUNK + 500), s = await sha(pt);
  const f = await W.sealFile(k0, s, pt);
  const head = 4 + 4 + new DataView(f.body.buffer, f.body.byteOffset + 4, 4).getUint32(0);
  const mut = (g) => { const b = f.body.slice(); g(b); return b; };
  const swapped = (() => {
    const c1 = f.body.subarray(head, head + C.CHUNK + C.TAG), c2 = f.body.subarray(head + C.CHUNK + C.TAG);
    // (the second chunk is shorter: swapped, each is the other's length, so the frame's length still holds)
    return B.concat(f.body.subarray(0, head), c2, c1);
  })();
  const reHead = (o) => { const t = new TextEncoder().encode(JSON.stringify(o)); return B.concat(new TextEncoder().encode("SBB1"), B.u32(t.length), t, f.body.subarray(head)); };
  const cases = [
    ["a flipped ciphertext byte", mut((b) => { b[head + 10] ^= 1; })],
    ["a flipped tag byte in the last chunk", mut((b) => { b[b.length - 1] ^= 1; })],
    ["the chunks swapped", swapped],
    ["truncated by a byte", f.body.subarray(0, f.body.length - 1)],
    ["one byte more", B.concat(f.body, new Uint8Array(1))],
    ["another magic", mut((b) => { b[3] = 0x32; })],
    ["another codec", reHead({ codec: "zstd.1", compressedLength: pt.length, plaintextLength: pt.length })],
    ["other lengths", reHead({ codec: "store.1", compressedLength: pt.length - 1, plaintextLength: pt.length - 1 })],
    ["a header that isn't canonical (fields in another order)", reHead({ plaintextLength: pt.length, codec: "store.1", compressedLength: pt.length })],
    ["a header with a field more", reHead({ codec: "store.1", compressedLength: pt.length, plaintextLength: pt.length, x: 1 })],
    ["a header with spaces (its fields in order, but not the canonical bytes)", (() => { const t = new TextEncoder().encode(`{"codec": "store.1", "compressedLength": ${pt.length}, "plaintextLength": ${pt.length}}`); return B.concat(new TextEncoder().encode("SBB1"), B.u32(t.length), t, f.body.subarray(head)); })()],
    ["a header writing a length another way (1e3 style)", (() => { const t = new TextEncoder().encode(`{"codec":"store.1","compressedLength":${pt.length}.0,"plaintextLength":${pt.length}}`); return B.concat(new TextEncoder().encode("SBB1"), B.u32(t.length), t, f.body.subarray(head)); })()],
    ["a header length past the frame", mut((b) => { new DataView(b.buffer).setUint32(4, 1 << 20); })],
    ["nothing", new Uint8Array(0)],
  ];
  for (const [what, body] of cases) {
    const r = await why(() => W.openFile(k0, s, f.address, body, LIM));
    // (the ciphertext's own tampering fails where it is authenticated; every other change, at the frame's checks first)
    const atAead = /ciphertext|tag|swapped/.test(what);
    ok(r.startsWith("bad_form") && AEAD.test(r) === atAead, `${what}: refused (bad_form), ${atAead ? "at chunk authentication" : "by the frame's own checks, before anything is decrypted"}`, r);
    if (/spaces|another way/.test(what)) ok(/canonical/.test(r), `…by the canonical check`, r);
  }
  // (lengths that aren't store.1's, with a frame whose length is the compressed one's: refused as not store.1's)
  {
    const t = new TextEncoder().encode(JSON.stringify({ codec: "store.1", compressedLength: pt.length, plaintextLength: pt.length + 1 }));
    const r = await why(() => W.openFile(k0, s, f.address, B.concat(new TextEncoder().encode("SBB1"), B.u32(t.length), t, f.body.subarray(head)), LIM));
    ok(/store\.1/.test(r), "a compressed length other than the plaintext's: refused as not store.1's, before anything is decrypted", r);
  }
  // (another file's own frame, served at this one's address; and this frame named by another address)
  const pt2 = pattern(77).map((x) => x ^ 0x55), s2 = await sha(pt2), f2 = await W.sealFile(k0, s2, pt2);
  ok((await code(() => W.openFile(k0, s, f.address, f2.body, LIM))) === "bad_form", "another file's frame served at this file's address: refused");
  const wrongAt = await why(() => W.openFile(k0, s, f2.address, f.body, LIM));
  ok(/not this file's address/.test(wrongAt), "this frame under another address: refused by the address check, before anything is decrypted (the AAD would refuse it too)", wrongAt);
  ok((await code(() => W.openFile(k0, s, f.address, f.body, { ...LIM, maxPlaintext: 100 }))) === "limit", "a file past what this device opens: limit");
  // (the clear header is a parsing hint only: lengths changed consistently, the frame cut to match, pass every form
  // check and fail where the AAD binds them, at chunk authentication; the codec, only store.1 being pinned, can't get
  // that far, and its place in the AAD is pinned by test-e2e-crypto.mjs B-1)
  {
    const small = pattern(300), ss = await sha(small), fs = await W.sealFile(k0, ss, small);
    const hd = 4 + 4 + new DataView(fs.body.buffer, fs.body.byteOffset + 4, 4).getUint32(0);
    const t = new TextEncoder().encode(JSON.stringify({ codec: "store.1", compressedLength: 299, plaintextLength: 299 }));
    const shorter = B.concat(new TextEncoder().encode("SBB1"), B.u32(t.length), t, fs.body.subarray(hd, fs.body.length - 1));
    const r = await why(() => W.openFile(k0, ss, fs.address, shorter, LIM));
    ok(AEAD.test(r), "lengths changed in the header, the frame cut to match: refused at chunk authentication (the AAD binds them), not at a form check", r);
    const r2 = await why(() => W.openFile(k0, ss, fs.address, (() => { const b = fs.body.slice(); b[hd] ^= 1; return b; })(), LIM));
    ok(AEAD.test(r2), "…and a changed ciphertext byte, likewise", r2);
  }
}

// ---- a frame that authenticates under the file's key, address and AAD, but whose plaintext isn't the file: refused
// (made by hand here, the AAD written out as chunks.ts lays it: what only a holder of the epoch's keys could make)
{
  const want = pattern(50), sWant = await sha(want), other = pattern(50).map((x) => x ^ 0xff);
  const address = await W.addressOf(k0, sWant);
  const kFile = await K.fileKey(K.mintedEpoch(k0).blobKey, sWant, "store.1");
  const aad = B.concat(B.utf8(LABELS.blobChunkAad), B.name(ACC, "a"), B.field(B.utf8(address)), B.field(B.utf8("store.1")), B.u64(50), B.u64(50), B.u32(1), B.u32(0), B.u32(50));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: new Uint8Array(12), additionalData: aad, tagLength: 128 }, await K.chunkKey(kFile, 0), other));
  const t = new TextEncoder().encode(JSON.stringify({ codec: "store.1", compressedLength: 50, plaintextLength: 50 }));
  const forged = B.concat(new TextEncoder().encode("SBB1"), B.u32(t.length), t, ct);
  const r = await code(() => W.openFile(k0, sWant, address, forged, LIM));
  // (the control: the same construction over the file's own bytes opens, so the refusal is the plaintext check's)
  const ctOwn = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: new Uint8Array(12), additionalData: aad, tagLength: 128 }, await K.chunkKey(kFile, 0), want));
  const own = await code(() => W.openFile(k0, sWant, address, B.concat(new TextEncoder().encode("SBB1"), B.u32(t.length), t, ctOwn), LIM));
  ok(own === "ok" && r === "bad_form", "a frame that authenticates but opens to other bytes than the file: refused (its control, the file's own bytes so made, opens)", { own, r });
}

console.log(failures ? `${failures} of ${count} FAILED` : `all ${count} passed`);
process.exit(failures ? 1 : 0);
