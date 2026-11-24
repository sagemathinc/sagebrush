// ci: web-runner order=355 runner=bun chrome
// A document's payloads under end-to-end encryption (e2e/doc-payload.ts; design e2e-encryption.md §3.1 and §4), in
// headless Chromium with its real WebCrypto. A patch's header is checked byte for byte against an encoding written out
// again here, and every sealed slice is opened by an independent oracle (Node's HKDF and AES-GCM) under the header it
// should bind. Then every way of moving a payload to another place (another document, epoch, key generation, client,
// position, id or parents) must fail to open, as must a presence message sent for another device.
//   CHROME=google-chrome bun web/workspace/test-e2e-doc-payload.mjs
import { createCipheriv, createDecipheriv, createHash, hkdfSync } from "node:crypto";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { browser } from "../agents/a14-cases.mjs";

const here = new URL(".", import.meta.url).pathname;
let failures = 0;
const ok = (c, msg, detail) => { console.log((c ? "ok   " : "FAIL ") + msg + (!c && detail !== undefined ? "  " + JSON.stringify(detail).slice(0, 600) : "")); if (!c) failures++; };
const J = (v) => JSON.stringify(v);

// ---- the oracle: the header and the object sealing written out again over Node's crypto
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; };
const s8 = (s) => Buffer.from(s, "utf8");
const fld = (b) => Buffer.concat([u32(b.length), Buffer.from(b)]);
const hkdf = (ikm, info) => Buffer.from(hkdfSync("sha256", ikm, Buffer.alloc(0), info, 32));
const sha = (b) => createHash("sha256").update(b).digest("hex");
const patchHead = (p) => Buffer.concat([
  s8("sagebrush.e2e.doc.patch.v1"), fld(s8(p.account)), fld(s8(p.document)), u64(p.documentEpoch), fld(s8(p.cekId)), u64(p.keyEpoch),
  fld(s8(p.client)), u64(p.cseq), fld(s8(p.patchId)), u32(p.parents.length), ...p.parents.map((q) => fld(s8(q))),
]);
const presenceHead = (p) => Buffer.concat([s8("sagebrush.e2e.doc.presence.v1"), fld(s8(p.account)), fld(s8(p.document)), fld(s8(p.cekId)), u64(p.keyEpoch), fld(s8(p.device))]);
const header = (kind, place, head, n) => ({ account: place.account, kind, object: place.document, version: sha(head), codec: "store.1", plaintextLength: n, compressedLength: n });
const fields = (h) => Buffer.concat([fld(s8(h.account)), fld(s8(h.kind)), fld(s8(h.object)), fld(s8(h.version)), fld(s8(h.codec)), u64(h.plaintextLength), u64(h.compressedLength)]);
// (one chunk: K_object = HKDF(CEK, label ‖ fields ‖ seal id), nonce 0^64 ‖ u32(0), AAD label ‖ fields ‖ seal id ‖ count ‖ index ‖ length)
function oracleOpen(cek, h, slice) {
  const sealId = slice.subarray(0, 32), body = slice.subarray(32, slice.length - 16), tag = slice.subarray(slice.length - 16);
  const k = hkdf(cek, Buffer.concat([s8("sagebrush.e2e.object.key.v1"), fields(h), sealId]));
  const d = createDecipheriv("aes-256-gcm", k, Buffer.concat([Buffer.alloc(8), u32(0)]));
  d.setAAD(Buffer.concat([s8("sagebrush.e2e.object.chunk.aad.v1"), fields(h), sealId, u32(1), u32(0), u32(h.compressedLength)]));
  d.setAuthTag(tag);
  return Buffer.concat([d.update(body), d.final()]);
}
void createCipheriv;

const CEK = Buffer.alloc(32, 0x5a), CEK2 = Buffer.alloc(32, 0x5b);
const PLACE = { account: "e2e-acct-1", document: "6f1c2a9e-0d3b-4c1e-9a7f-2b8d4e6f0a11", documentEpoch: 2, cekId: "k-3", keyEpoch: 5, client: "c7xq", cseq: 41, patchId: "0000001732466400000_c7xq", parents: ["0000001732466300000_c7xq", "0000001732466350000_b2zz"] };
const PRES = { account: "e2e-acct-1", document: PLACE.document, cekId: "k-3", keyEpoch: 5, device: "d-laptop" };
const PAYLOAD = s8(J({ patch: [[1, "hello"]], snapshot: null, version: 3 }));

// ---- H: the header, in Node (pure: no crypto beyond SHA-256)
{
  const m = await import(join(here, "e2e", "doc-payload.ts"));
  const hex = (b) => Buffer.from(b).toString("hex");
  const cases = [PLACE, { ...PLACE, parents: [] }, { ...PLACE, parents: Array.from({ length: 8 }, (_, i) => `p${i}`) }, { ...PLACE, client: "é∑", patchId: "x y" }];
  ok(cases.every((p) => hex(m.patchHead(p)) === patchHead(p).toString("hex")), "H-1: a patch's header is its label, then each field length-prefixed or fixed-width, and the parents counted, as written out here");
  ok(hex(m.presenceHead(PRES)) === presenceHead(PRES).toString("hex"), "H-1: a presence message's header likewise");
  // (no two places encode alike: the splits a plain concatenation would confuse)
  const pairs = [
    [{ ...PLACE, client: "a", patchId: "bc" }, { ...PLACE, client: "ab", patchId: "c" }],
    [{ ...PLACE, parents: ["a", "b"] }, { ...PLACE, parents: ["ab"] }],
    [{ ...PLACE, parents: ["a", "b"] }, { ...PLACE, parents: ["b", "a"] }],
    [{ ...PLACE, document: "d", cekId: "1k" }, { ...PLACE, document: "d1", cekId: "k" }],
    [{ ...PLACE, documentEpoch: 1, keyEpoch: 2 }, { ...PLACE, documentEpoch: 2, keyEpoch: 1 }],
  ];
  ok(pairs.every(([a, b]) => hex(m.patchHead(a)) !== hex(m.patchHead(b))), "H-2: places a plain concatenation would confuse encode differently (a field boundary moved, parents split or reordered, the two epochs swapped)");
  const code = (f) => { try { f(); return "ok"; } catch (e) { return e?.code ?? String(e?.message ?? e); } };
  const bad = {
    "9 parents": { ...PLACE, parents: Array.from({ length: 9 }, (_, i) => `p${i}`) },
    "parents not a list": { ...PLACE, parents: "p" },
    "negative cseq": { ...PLACE, cseq: -1 },
    "fractional epoch": { ...PLACE, documentEpoch: 1.5 },
    "key epoch past 2^53": { ...PLACE, keyEpoch: 2 ** 53 },
    "empty client": { ...PLACE, client: "" },
    "NUL in the id": { ...PLACE, patchId: "a\0b" },
    "empty parent": { ...PLACE, parents: [""] },
    "no account": { ...PLACE, account: undefined },
  };
  const got = Object.fromEntries(Object.entries(bad).map(([k, p]) => [k, code(() => m.patchHead(p))]));
  ok(Object.values(got).every((v) => v === "bad_form"), "H-3: a header is refused (bad_form) for more than 8 parents, parents not a list, a number that isn't a whole number below 2^53, or a name that's empty, missing or holds NUL", got);
  ok(m.PARENTS_MAX === (await import(join(here, "..", "sync-protocol", "protocol.ts"))).LIMITS.patchParents, "H-3: the header's parent bound is the protocol's");
}

// ---- the page: e2e/ bundled for Chromium
const dir = mkdtempSync(join(tmpdir(), "sb-e2e-doc-"));
const entry = join(dir, "entry.ts");
writeFileSync(entry, `export * as e2e from ${J(join(here, "e2e", "index.ts"))};`);
const built = await Bun.build({ entrypoints: [entry], target: "browser", format: "esm" });
rmSync(dir, { recursive: true, force: true });
if (!built.success) throw new Error("e2e/ didn't build: " + built.logs.join("\n"));
const js = await built.outputs[0].text();
const html = `<!doctype html><script type="module">import * as m from "/e2e.js"; Object.assign(window, m);
window.hx = (b) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join("");
window.unhx = (h) => Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));
window.code = async (f) => { try { await f(); return "ok"; } catch (e) { return e?.code ?? String(e?.message ?? e); } };
window.cek = (h) => e2e.importCek(unhx(h));
window.ready = true;</script>`;
const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (r) => {
  if (new URL(r.url).pathname === "/e2e.js") return new Response(js, { headers: { "content-type": "text/javascript" } });
  return new Response(html, { headers: { "content-type": "text/html" } });
} });
const site = `http://127.0.0.1:${server.port}`;
const B = await browser();
const settle = async (P, before) => { for (const t = Date.now(); P.loads === before && Date.now() - t < 10000; ) await new Promise((r) => setTimeout(r, 50)); await P.until(`window.ready === true`, 10000); };

try {
  const P = await B.tab();
  { const n = P.loads; await P.send("Page.navigate", { url: site + "/" }); await settle(P, n); }
  console.log(`# in ${await P.ev(`navigator.userAgent`)}`);
  const K = J(CEK.toString("hex")), K2 = J(CEK2.toString("hex")), PL = J(PLACE), PR = J(PRES), PAY = J(PAYLOAD.toString("hex"));

  // ---- P: patches
  {
    const r = await P.ev(`(async () => {
      const k = await cek(${K}), pay = unhx(${PAY});
      const a = await e2e.sealPatch(k, ${PL}, pay), b = await e2e.sealPatch(k, ${PL}, pay);
      const back = await e2e.openPatch(k, ${PL}, a);
      return { a: hx(a), b: hx(b), back: hx(back), empty: hx(await e2e.openPatch(k, ${PL}, await e2e.sealPatch(k, ${PL}, new Uint8Array(0)))) };
    })()`);
    const a = Buffer.from(r.a, "hex"), n = PAYLOAD.length;
    ok(a.length === 32 + n + 16, "P-1: a sealed patch is its 32-byte seal id and one chunk (its payload's length plus the 16-byte tag)", [a.length, n]);
    let opened = null; try { opened = oracleOpen(CEK, header("patch", PLACE, patchHead(PLACE), n), a); } catch (e) { opened = String(e); }
    ok(Buffer.isBuffer(opened) && opened.equals(PAYLOAD), "P-1: the oracle opens it as an object of kind patch: the document as its object, the header's SHA-256 as its version, codec store.1, under K_object from the CEK and the seal id", String(opened).slice(0, 80));
    ok(r.back === PAYLOAD.toString("hex") && r.empty === "", "P-2: openPatch gives the payload back for the same place (and an empty payload too)");
    ok(r.a !== r.b && r.a.slice(0, 64) !== r.b.slice(0, 64), "P-2: two sealings of the same payload differ (each has its own seal id)");
  }
  {
    // (every way of moving a sealed patch: each opened with one thing changed must be refused)
    const moved = {
      account: { account: "e2e-acct-2" }, document: { document: "6f1c2a9e-0d3b-4c1e-9a7f-2b8d4e6f0a12" }, "document epoch": { documentEpoch: 3 },
      "key generation": { cekId: "k-4" }, "key epoch": { keyEpoch: 6 }, client: { client: "c7xr" }, cseq: { cseq: 42 }, "patch id": { patchId: "0000001732466400001_c7xq" },
      "a parent changed": { parents: ["0000001732466300000_c7xq", "0000001732466350001_b2zz"] }, "parents reordered": { parents: [...PLACE.parents].reverse() },
      "a parent dropped": { parents: PLACE.parents.slice(0, 1) }, "a parent added": { parents: [...PLACE.parents, "p"] },
    };
    const r = await P.ev(`(async () => {
      const k = await cek(${K}), k2 = await cek(${K2}), place = ${PL};
      const s = await e2e.sealPatch(k, place, unhx(${PAY})), out = {};
      for (const [what, change] of Object.entries(${J(moved)})) out[what] = await code(() => e2e.openPatch(k, { ...place, ...change }, s));
      out["another CEK"] = await code(() => e2e.openPatch(k2, place, s));
      const flip = (i) => { const c = s.slice(); c[i] ^= 1; return c; };
      out["a seal id bit"] = await code(() => e2e.openPatch(k, place, flip(3)));
      out["a ciphertext bit"] = await code(() => e2e.openPatch(k, place, flip(40)));
      out["a tag bit"] = await code(() => e2e.openPatch(k, place, flip(s.length - 1)));
      out["a byte cut"] = await code(() => e2e.openPatch(k, place, s.subarray(0, s.length - 1)));
      out["a byte added"] = await code(() => e2e.openPatch(k, place, new Uint8Array([...s, 0])));
      const pres = await e2e.sealPresence(k, ${PR}, unhx(${PAY}));
      out["a presence message as a patch"] = await code(() => e2e.openPatch(k, place, pres));
      out["the payload unsealed"] = await code(() => e2e.openPatch(k, place, unhx(${PAY})));
      return out;
    })()`);
    const wrong = Object.entries(r).filter(([, v]) => v !== "bad_form");
    ok(Object.keys(r).length === 20 && wrong.length === 0, `P-3: a patch opens only where it was sealed: ${Object.keys(r).length} moves and damages are each refused (bad_form): another account, document, document epoch, key generation, key epoch, client, cseq or patch id, its parents changed, reordered, cut or added to, another CEK, a flipped bit in the seal id, ciphertext or tag, a byte cut or added, a presence message, and an unsealed payload`, wrong);
  }
  {
    const r = await P.ev(`(async () => {
      const k = await cek(${K}), place = ${PL};
      return {
        big: await code(() => e2e.sealPatch(k, place, new Uint8Array(e2e.CHUNK + 1))),
        chunk: (await e2e.sealPatch(k, place, new Uint8Array(e2e.CHUNK))).length,
        short: await code(() => e2e.openPatch(k, place, new Uint8Array(47))),
        notBytes: await code(() => e2e.sealPatch(k, place, "text")),
        badPlace: await code(() => e2e.sealPatch(k, { ...place, cseq: -1 }, new Uint8Array(1))),
      };
    })()`);
    ok(r.big === "limit" && r.chunk === 32 + (1 << 20) + 16, "P-4: a payload is at most one chunk (1 MiB): one byte more is refused (limit)", r);
    ok(r.short === "bad_form" && r.notBytes === "bad_form" && r.badPlace === "bad_form", "P-4: a slice shorter than a seal id and a tag, a payload that isn't bytes, and a malformed place are refused (bad_form)", r);
  }

  // ---- S: presence
  {
    const r = await P.ev(`(async () => {
      const k = await cek(${K}), pres = ${PR}, s = await e2e.sealPresence(k, pres, unhx(${PAY})), out = {};
      for (const [what, change] of Object.entries({ device: { device: "d-phone" }, document: { document: "d2" }, "key generation": { cekId: "k-4" }, "key epoch": { keyEpoch: 4 }, account: { account: "e2e-acct-2" } }))
        out[what] = await code(() => e2e.openPresence(k, { ...pres, ...change }, s));
      out["a patch as presence"] = await code(async () => e2e.openPresence(k, pres, await e2e.sealPatch(k, ${PL}, unhx(${PAY}))));
      return { s: hx(s), back: hx(await e2e.openPresence(k, pres, s)), refused: out };
    })()`);
    const s = Buffer.from(r.s, "hex");
    let opened = null; try { opened = oracleOpen(CEK, header("presence", PRES, presenceHead(PRES), PAYLOAD.length), s); } catch (e) { opened = String(e); }
    ok(Buffer.isBuffer(opened) && opened.equals(PAYLOAD) && r.back === PAYLOAD.toString("hex"), "S-1: a presence message is sealed as an object of kind presence, bound to the document, the key generation and epoch, and the sending device (the oracle opens it; so does openPresence)");
    const wrong = Object.entries(r.refused).filter(([, v]) => v !== "bad_form");
    ok(Object.keys(r.refused).length === 6 && wrong.length === 0, "S-2: a presence message opens only for its device, document, key generation, key epoch and account, and a patch doesn't open as one", wrong);
  }

  // ---- X: Clear history's root is a patch in the new document epoch
  {
    const r = await P.ev(`(async () => {
      const k = await cek(${K}), root = { ...${PL}, documentEpoch: 3, cseq: 1, parents: [] };
      const s = await e2e.sealPatch(k, root, unhx(${PAY}));
      return { opens: hx(await e2e.openPatch(k, root, s)), oldEpoch: await code(() => e2e.openPatch(k, { ...root, documentEpoch: 2 }, s)) };
    })()`);
    ok(r.opens === PAYLOAD.toString("hex") && r.oldEpoch === "bad_form", "X-1: Clear history's root (cseq 1, no parents, the new document epoch) is an ordinary patch, and doesn't open in the old epoch");
  }
} catch (e) {
  ok(false, "the test ran to its end: " + (e?.stack ?? e));
} finally {
  await B.close();
  server.stop(true);
}
console.log(failures ? `${failures} FAILED` : "all passed");
process.exit(failures ? 1 : 0);
