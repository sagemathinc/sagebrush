// ci: web-runner order=356 runner=bun chrome
// One index op, sealed and signed (e2e/index-op.ts; design e2e-encryption.md §4, §4.1), in headless Chromium with its
// real WebCrypto. Each envelope is opened again here in the runner by an independent oracle (Node's HKDF and AES-GCM,
// the layout and AAD written out by hand), and each signature checked by Node's Ed25519 over the signed bytes written
// out by hand. Then every way of tampering with an envelope or its context, the size and reference bounds (the
// server's own: protocol.ts's LIMITS and checkSealedOp), and keys that aren't an epoch's.
//   CHROME=google-chrome bun web/workspace/test-e2e-index-op.mjs
import { createCipheriv, createDecipheriv, createHash, createPublicKey, hkdfSync, verify } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { browser } from "../agents/a14-cases.mjs";
import { LIMITS, checkSealedOp } from "../sync-protocol/protocol.ts";

const here = new URL(".", import.meta.url).pathname;
let failures = 0;
const ok = (c, msg, detail) => { console.log((c ? "ok   " : "FAIL ") + msg + (!c && detail !== undefined ? "  " + JSON.stringify(detail).slice(0, 600) : "")); if (!c) failures++; };

// ---- the oracle: the layout, the keys and the AAD written out again over Node's crypto
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; };
const fld = (b) => Buffer.concat([u32(b.length), Buffer.from(b)]);
const s8 = (s) => Buffer.from(s, "utf8");
const hkdf = (ikm, info) => Buffer.from(hkdfSync("sha256", ikm, Buffer.alloc(0), info, 32));
const S = Buffer.from(Array.from({ length: 32 }, (_, i) => 100 + i));
const ACCT = "acct-1", DEV = "dev-a", EPOCH = 7;
const kIndex = (account = ACCT, n = EPOCH) => hkdf(S, Buffer.concat([s8("sagebrush.e2e.epoch.index.v1"), fld(s8(account)), u64(n)]));
const fields = (o) => Buffer.concat([fld(s8(o.account)), fld(s8(o.kind ?? "index-op")), fld(s8(o.device)), fld(s8(String(o.dseq))), fld(s8("store.1")), u64(o.len), u64(o.len)]);
const oKey = (o, sealId) => hkdf(kIndex(o.account, o.epoch), Buffer.concat([s8("sagebrush.e2e.object.key.v1"), fields(o), sealId]));
const oAad = (o, sealId) => Buffer.concat([s8("sagebrush.e2e.object.chunk.aad.v1"), fields(o), sealId, u32(1), u32(0), u32(o.len)]);
const NONCE = Buffer.alloc(12);
/** Open an envelope by hand: { version, epoch, sealId, plaintext text }, or null if it doesn't open. */
function oracleOpen(env, at) {
  const version = env[0], epoch = Number(env.readBigUInt64BE(1)), sealId = env.subarray(9, 41), ct = env.subarray(41, env.length - 16), tag = env.subarray(env.length - 16);
  const o = { account: at.account ?? ACCT, device: at.device ?? DEV, dseq: at.dseq, epoch, len: ct.length, kind: at.kind };
  try {
    const d = createDecipheriv("aes-256-gcm", oKey(o, sealId), NONCE);
    d.setAAD(oAad(o, sealId));
    d.setAuthTag(tag);
    return { version, epoch, sealId, text: Buffer.concat([d.update(ct), d.final()]).toString("utf8") };
  } catch {
    return null;
  }
}
/** Seal plaintext bytes by hand, as an envelope of any shape the tests want. */
function oracleSeal(text, at) {
  const sealId = Buffer.alloc(32, 9), pt = Buffer.isBuffer(text) ? text : Buffer.from(text, "utf8");
  const o = { account: at.account ?? ACCT, device: at.device ?? DEV, dseq: at.dseq, epoch: at.epoch ?? EPOCH, len: pt.length, kind: at.kind };
  const c = createCipheriv("aes-256-gcm", oKey(o, sealId), NONCE);
  c.setAAD(oAad(o, sealId));
  const ct = Buffer.concat([c.update(pt), c.final(), c.getAuthTag()]);
  return Buffer.concat([Buffer.from([at.version ?? 1]), u64(o.epoch), sealId, ct]);
}
// (the signed bytes, by hand: the domain line, then the fields with their keys sorted and no spaces)
const signedByHand = (c, env) => s8("sagebrush.e2e.sealed-op.v1\n" + JSON.stringify({
  account: c.account, adds: c.adds, chain_generation: c.chainGeneration, device: c.device, dseq: c.dseq,
  env: createHash("sha256").update(env).digest("base64url"), head: c.head, releases: c.releases, signer: c.signer, sync_generation: c.syncGeneration,
}));
const edPublic = (raw) => createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(raw)]), format: "der", type: "spki" });

const A = (n) => "a1:" + createHash("sha256").update("blob " + n).digest("hex");
const PREV = createHash("sha256").update("the previous envelope").digest();
const OP = { kind: "put", path: "notes/a.txt", sha: "x", size: 5 }; // (keys in canonical order: it opens as canon parsed it)
const CTX = {
  account: "aaaaaaaaaaaaaaaaaaaaaaaaaa", syncGeneration: 3, chainGeneration: "g".repeat(26), head: "A".repeat(43), device: DEV, dseq: 4,
  adds: [A(1), A(2)], releases: [A(3)], signer: "bbbbbbbbbbbbbbbbbbbbbbbbba",
};
const hx = (b) => Buffer.from(b).toString("hex");
const unhx = (h) => Buffer.from(h, "hex");
const J = (v) => JSON.stringify(v);

// ---- the page: e2e/, bundled for Chromium
const dir = mkdtempSync(join(tmpdir(), "sb-e2e-op-"));
const entry = join(dir, "entry.ts");
writeFileSync(entry, [
  `export * as e2e from ${J(join(here, "e2e", "index.ts"))};`,
  `export { fleetCore } from ${J(join(here, "fleet", "install.ts"))};`,
  `export { sealedOpMessage } from ${J(join(here, "e2e", "sealed-op.mjs"))};`,
].join("\n"));
const built = await Bun.build({ entrypoints: [entry], target: "browser", format: "esm" });
rmSync(dir, { recursive: true, force: true });
if (!built.success) throw new Error("e2e/ didn't build: " + built.logs.join("\n"));
const js = await built.outputs[0].text();
const html = `<!doctype html><script type="module">import * as m from "/e2e.js"; Object.assign(window, m);
window.hx = (b) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join("");
window.unhx = (h) => Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));
window.code = async (f) => { try { await f(); return "ok"; } catch (e) { return e?.code ?? String(e?.message ?? e); } };
window.keys = (account = ${J(ACCT)}, n = ${EPOCH}) => e2e.deriveEpochKeys(unhx("${hx(S)}"), account, n);
window.signer = () => fleetCore().keyFromSeed(new Uint8Array(32).fill(5));
window.ready = true;</script>`;
const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (r) => {
  if (new URL(r.url).pathname === "/e2e.js") return new Response(js, { headers: { "content-type": "text/javascript" } });
  return new Response(html, { headers: { "content-type": "text/html" } });
} });
const site = `http://127.0.0.1:${server.port}`;
const B = await browser();
const settle = async (P, before) => { for (const t = Date.now(); P.loads === before && Date.now() - t < 10000; ) await new Promise((r) => setTimeout(r, 50)); await P.until(`window.ready === true`, 10000); };
const page = async () => { const P = await B.tab(); const n = P.loads; await P.send("Page.navigate", { url: site + "/" }); await settle(P, n); return P; };

try {
  const P = await page();
  console.log(`# in ${await P.ev(`navigator.userAgent`)}`);
  // (seal in the page: the envelope's hex)
  const seal = (op, at, commit, k = "await keys()") => P.ev(`(async () => hx(await e2e.sealIndexOp(${k}, ${J(at)}, ${J(op)}, { prev: ${commit.prev ? `unhx(${J(hx(commit.prev))})` : "null"}, adds: ${J(commit.adds)}, releases: ${J(commit.releases)} })))()`);
  const open = (envHex, at, commit, k = "await keys()") => P.ev(`(async () => { try { return { op: await e2e.openIndexOp(${k}, ${J(at)}, unhx(${J(envHex)}), { prev: ${commit.prev ? `unhx(${J(hx(commit.prev))})` : "null"}, adds: ${J(commit.adds)}, releases: ${J(commit.releases)} }) }; } catch (e) { return { code: e?.code ?? String(e?.message ?? e) }; } })()`);
  const C0 = { prev: null, adds: [], releases: [] }, C1 = { prev: PREV, adds: [A(1), A(2)], releases: [A(3)] };

  // ---- O: the envelope, against the oracle
  {
    const e1 = unhx(await seal(OP, { device: DEV, dseq: 1 }, C0)), e4 = unhx(await seal(OP, { device: DEV, dseq: 4 }, C1));
    const o1 = oracleOpen(e1, { dseq: 1 }), o4 = oracleOpen(e4, { dseq: 4 });
    ok(o1 && o1.version === 1 && o1.epoch === EPOCH && e1.length === 41 + Buffer.byteLength(o1.text) + 16, "O-1: an envelope is 0x01, the epoch as a u64, a 32-byte seal id and one chunk: the oracle opens it under K_index[e] (HKDF of S[e]), kind index-op, object = device, version = dseq, codec store.1", o1);
    ok(o1?.text === `{"adds":[],"op":{"kind":"put","path":"notes/a.txt","sha":"x","size":5},"prev":null,"releases":[]}`, "O-1: the sealed plaintext is canon({ op, prev, adds, releases }), written out by hand: a first op's prev is null", o1?.text);
    ok(o4?.text === `{"adds":["${A(1)}","${A(2)}"],"op":{"kind":"put","path":"notes/a.txt","sha":"x","size":5},"prev":"${PREV.toString("base64url")}","releases":["${A(3)}"]}`, "O-1: a later op seals the previous envelope's SHA-256 (base64url) and the references it declares", o4?.text);
    ok(oracleOpen(e1, { dseq: 2 }) === null && oracleOpen(e1, { dseq: 1, device: "dev-b" }) === null && oracleOpen(e1, { dseq: 1, account: "acct-2" }) === null && oracleOpen(e1, { dseq: 1, kind: "index-page" }) === null,
      "O-1: (and the oracle opens it at no other dseq, device, account or kind: each is bound in the key and the AAD)");
    const again = unhx(await seal(OP, { device: DEV, dseq: 1 }, C0));
    ok(hx(again.subarray(9, 41)) !== hx(e1.subarray(9, 41)) && hx(again) !== hx(e1), "O-2: sealing the same op twice draws a fresh seal id: no two envelopes alike");
    const back = await open(hx(e4), { device: DEV, dseq: 4 }, C1);
    ok(J(back.op) === J(OP), "O-2: it opens to the op as sealed, given the expected prev and references", back);
    const byHand = await open(hx(oracleSeal(`{"adds":[],"op":[1,"two",{"three":null}],"prev":null,"releases":[]}`, { dseq: 9 })), { device: DEV, dseq: 9 }, C0);
    ok(J(byHand.op) === J([1, "two", { three: null }]), "O-2: an envelope the oracle seals by hand opens in the page", byHand);
    const h = await P.ev(`(async () => hx(await e2e.opHash(unhx(${J(hx(e1))}))))()`);
    ok(h === createHash("sha256").update(e1).digest("hex"), "O-3: opHash is the envelope's SHA-256 (the next op's prev)");
    ok(await P.ev(`e2e.opEpoch(unhx(${J(hx(e4))}))`) === EPOCH, "O-3: opEpoch reads the envelope's epoch, to pick its keys");
  }

  // ---- T: tampering, and opening anywhere else
  {
    const at = { device: DEV, dseq: 4 }, env = unhx(await seal(OP, at, C1));
    const flip = (i) => { const b = Buffer.from(env); b[i] ^= 1; return hx(b); };
    const rows = {
      "the version byte": flip(0), "the epoch": flip(8), "the seal id": flip(20), "the ciphertext": flip(50), "the tag": flip(env.length - 1),
      "one byte cut": hx(env.subarray(0, env.length - 1)), "one byte added": hx(Buffer.concat([env, Buffer.from([0])])), "the header alone": hx(env.subarray(0, 41 + 16 - 1)),
    };
    const got = {};
    for (const [k, v] of Object.entries(rows)) got[k] = (await open(v, at, C1)).code;
    ok(Object.values(got).every((c) => c === "bad_form"), "T-1: a changed version byte, epoch, seal id, ciphertext or tag, a byte cut or added, or a header without a whole chunk: bad_form", got);
    const where = {
      "another dseq": (await open(hx(env), { device: DEV, dseq: 5 }, C1)).code,
      "another device": (await open(hx(env), { device: "dev-b", dseq: 4 }, C1)).code,
      "another account's keys": (await open(hx(env), at, C1, `await keys("acct-2")`)).code,
      "another epoch's keys": (await open(hx(env), at, C1, `await keys(${J(ACCT)}, 8)`)).code,
      "the same epoch's number, another secret": (await open(hx(env), at, C1, `await e2e.deriveEpochKeys(new Uint8Array(32).fill(1), ${J(ACCT)}, ${EPOCH})`)).code,
    };
    ok(Object.values(where).every((c) => c === "bad_form"), "T-2: it opens nowhere else: not at another dseq or device, nor under another account's, epoch's or secret's K_index", where);
    const commits = {
      "no prev expected": (await open(hx(env), at, { ...C1, prev: null })).code,
      "another prev": (await open(hx(env), at, { ...C1, prev: createHash("sha256").update("x").digest() })).code,
      "adds in another order": (await open(hx(env), at, { ...C1, adds: [A(2), A(1)] })).code,
      "one add fewer": (await open(hx(env), at, { ...C1, adds: [A(1)] })).code,
      "one add more": (await open(hx(env), at, { ...C1, adds: [A(1), A(2), A(4)] })).code,
      "a release shown as an add": (await open(hx(env), at, { ...C1, adds: [A(1), A(2), A(3)], releases: [] })).code,
      "no releases": (await open(hx(env), at, { ...C1, releases: [] })).code,
    };
    ok(Object.values(commits).every((c) => c === "bad_form"), "T-3: the sealed prev, adds and releases must be exactly the expected ones (order included), else bad_form", commits);
    const first = unhx(await seal(OP, { device: DEV, dseq: 1 }, C0));
    ok((await open(hx(first), { device: DEV, dseq: 1 }, { ...C0, prev: PREV })).code === "bad_form", "T-3: a first op (prev null) doesn't open where a previous envelope is expected");
    // (plaintext that opens but isn't exactly canon({ op, prev, adds, releases }))
    const shapes = {
      "a space": `{"adds":[], "op":1,"prev":null,"releases":[]}`, "keys out of order": `{"op":1,"adds":[],"prev":null,"releases":[]}`,
      "a key missing": `{"adds":[],"op":1,"prev":null}`, "a key more": `{"adds":[],"op":1,"prev":null,"releases":[],"x":1}`,
      "a duplicate key": `{"adds":[],"op":1,"op":2,"prev":null,"releases":[]}`, "an array": `[]`, "not JSON": `{"adds":`, "a float": `{"adds":[],"op":1.5,"prev":null,"releases":[]}`,
      "a prev that isn't 32 bytes": `{"adds":[],"op":1,"prev":"AAAA","releases":[]}`, "invalid UTF-8": Buffer.from([0x7b, 0xff, 0x7d]),
      "a byte-order mark": "\ufeff" + `{"adds":[],"op":1,"prev":null,"releases":[]}`,
    };
    const sg = {};
    for (const [k, t] of Object.entries(shapes)) sg[k] = (await open(hx(oracleSeal(t, { dseq: 2 })), { device: DEV, dseq: 2 }, k === "a prev that isn't 32 bytes" ? { ...C0, prev: PREV } : C0)).code;
    ok(Object.values(sg).every((c) => c === "bad_form"), "T-4: a sealed plaintext that isn't canon({ op, prev, adds, releases }) is refused, though it opens: a space, keys out of order, one missing or more, a duplicate, an array, not JSON, a float, a short prev, a byte-order or UTF-8 fault", sg);
    const other = {
      "version 2": (await open(hx(oracleSeal(`{"adds":[],"op":1,"prev":null,"releases":[]}`, { dseq: 2, version: 2 })), { device: DEV, dseq: 2 }, C0)).code,
      "an index page": (await open(hx(oracleSeal(`{"adds":[],"op":1,"prev":null,"releases":[]}`, { dseq: 2, kind: "index-page" })), { device: DEV, dseq: 2 }, C0)).code,
      "epoch 8 under epoch 8's keys, sealed as 7's": (await open(hx((() => { const b = oracleSeal(`{"adds":[],"op":1,"prev":null,"releases":[]}`, { dseq: 2 }); b.writeBigUInt64BE(8n, 1); return b; })()), { device: DEV, dseq: 2 }, C0, `await keys(${J(ACCT)}, 8)`)).code,
    };
    ok(J(other) === J({ "version 2": "bad_form", "an index page": "bad_form", "epoch 8 under epoch 8's keys, sealed as 7's": "bad_form" }), "T-5: another version byte, another kind (an index page) and a relabelled epoch are refused", other);
  }

  // ---- S: the signature, over the server's signed bytes
  {
    const env = unhx(await seal(OP, { device: DEV, dseq: 4 }, C1));
    const r = await P.ev(`(async () => {
      const k = await signer(), env = unhx(${J(hx(env))}), ctx = ${J(CTX)};
      const sig = await e2e.signIndexOp(k, ctx, env);
      const msg = await sealedOpMessage({ ...ctx, env });
      return { sig, raw: hx(k.raw), msg: hx(msg), ok: await e2e.verifyIndexOp(k.raw, ctx, env, sig) };
    })()`);
    const sigBytes = Buffer.from(r.sig, "base64url");
    ok(r.ok === true && sigBytes.length === 64 && r.sig === sigBytes.toString("base64url"), "S-1: an op signed with a device key verifies; the sig is 64 bytes in base64url (as checkSealedOp wants)", r);
    ok(r.msg === hx(signedByHand(CTX, env)), "S-1: the signed bytes are sealedOpMessage's, the server's own, and are the domain line plus the sorted fields written out by hand", { page: r.msg.slice(0, 120) });
    ok(verify(null, signedByHand(CTX, env), edPublic(unhx(r.raw)), sigBytes) === true, "S-1: Node's Ed25519 verifies the page's signature over the bytes written out by hand");
    const changes = {
      account: "aaaaaaaaaaaaaaaaaaaaaaaaae", syncGeneration: 4, chainGeneration: "f".repeat(26), head: "B".repeat(43), device: "dev-b", dseq: 5,
      adds: [A(2), A(1)], releases: [], signer: "bbbbbbbbbbbbbbbbbbbbbbbbbe",
    };
    const v = await P.ev(`(async () => {
      const k = await signer(), env = unhx(${J(hx(env))}), ctx = ${J(CTX)}, sig = ${J(r.sig)}, out = {};
      for (const [f, x] of Object.entries(${J(changes)})) out[f] = await e2e.verifyIndexOp(k.raw, { ...ctx, [f]: x }, env, sig);
      const env2 = env.slice(); env2[60] ^= 1;
      out.env = await e2e.verifyIndexOp(k.raw, ctx, env2, sig);
      out.otherKey = await e2e.verifyIndexOp((await fleetCore().keyFromSeed(new Uint8Array(32).fill(6))).raw, ctx, env, sig);
      out.notB64 = await e2e.verifyIndexOp(k.raw, ctx, env, sig.slice(0, -1) + "=");
      out.short = await e2e.verifyIndexOp(k.raw, ctx, env, sig.slice(0, 43));
      const bad = unhx(${J(hx(sigBytes))}); bad[3] ^= 1;
      out.flipped = await e2e.verifyIndexOp(k.raw, ctx, env, fleetCore().b64(bad));
      return out;
    })()`);
    ok(Object.values(v).every((x) => x === false) && Object.keys(v).length === 14, "S-2: the signature fails for any other account, sync or chain generation, head, device, dseq, adds (order too), releases, signer or envelope byte, another key, and a malformed, short or flipped sig", v);
    const signed = await P.ev(`(async () => {
      const k = await signer(), env = unhx(${J(hx(env))}), ctx = ${J(CTX)}, out = {};
      out.dupAdds = await code(() => e2e.signIndexOp(k, { ...ctx, adds: [ctx.adds[0], ctx.adds[0]] }, env));
      out.badRef = await code(() => e2e.signIndexOp(k, { ...ctx, releases: ["0".repeat(63)] }, env));
      out.many = await code(() => e2e.signIndexOp(k, { ...ctx, adds: Array.from({ length: 65 }, (_, i) => "a1:" + i.toString(16).padStart(64, "0")) }, env));
      out.notBytes = await code(() => e2e.signIndexOp(k, ctx, "env"));
      return out;
    })()`);
    ok(J(signed) === J({ dupAdds: "bad_form", badRef: "bad_form", many: "limit", notBytes: "bad_form" }), "S-3: nothing is signed for references the server would refuse (a duplicate, a malformed address, 65), or an envelope that isn't bytes", signed);
    // (sealedOpMessage reads the lists after hashing the envelope: a caller's array changed meanwhile must not be what is signed)
    const late = await P.ev(`(async () => {
      const k = await signer(), env = unhx(${J(hx(env))}), ctx = ${J(CTX)}, adds = [...ctx.adds];
      const p = e2e.signIndexOp(k, { ...ctx, adds }, env);
      adds.push("a1:" + "9".repeat(64));
      return e2e.verifyIndexOp(k.raw, ctx, env, await p);
    })()`);
    ok(late === true, "S-4: the references are read when signing starts: changing the caller's array afterwards changes nothing signed", late);
  }

  // ---- L: the bounds, the server's own
  {
    ok(LIMITS.sealedOpBytes === (await P.ev(`e2e.OP_ENV_MAX`)) && LIMITS.sealedOpRefs === (await P.ev(`e2e.OP_REFS_MAX`)), "L-1: the envelope's size and reference bounds are the server's LIMITS.sealedOpBytes and sealedOpRefs");
    const room = await P.ev(`e2e.OP_PLAINTEXT_MAX`);
    const pad = room - J({ adds: [], op: "", prev: null, releases: [] }).length;
    const fit = await P.ev(`(async () => { const env = await e2e.sealIndexOp(await keys(), { device: "d", dseq: 1 }, "x".repeat(${pad}), { prev: null, adds: [], releases: [] }); return { n: env.length, hex: hx(env) }; })()`);
    ok(fit.n === LIMITS.sealedOpBytes, "L-2: the largest op seals to an envelope of exactly the server's limit", fit.n);
    const form = (() => { try { return checkSealedOp({ dseq: 1, head: "A".repeat(43), chain_gen: "A".repeat(43), env: Buffer.from(unhx(fit.hex)).toString("base64"), adds: [], releases: [], signer: CTX.signer, sig: "A".repeat(86) }).env.length; } catch (e) { return String(e?.message ?? e); } })();
    ok(form === LIMITS.sealedOpBytes, "L-2: and the server's checkSealedOp takes it", form);
    const over = await P.ev(`code(async () => e2e.sealIndexOp(await keys(), { device: "d", dseq: 1 }, "x".repeat(${pad + 1}), { prev: null, adds: [], releases: [] }))`);
    ok(over === "limit", "L-2: one byte more is refused (limit) before anything is sealed", over);
    const big = await P.ev(`code(() => e2e.opEpoch(new Uint8Array(${LIMITS.sealedOpBytes + 1}).fill(1)))`);
    const huge = await P.ev(`code(() => { const b = new Uint8Array(60).fill(0xff); b[0] = 1; return e2e.opEpoch(b); })`);
    ok(big === "limit" && huge === "bad_form", "L-3: opEpoch refuses an envelope past the limit (limit) and an epoch past 2^53 - 1 (bad_form)", [big, huge]);
    const r = await P.ev(`(async () => {
      const k = await keys(), at = { device: "d", dseq: 1 }, C = { prev: null, adds: [], releases: [] }, out = {};
      const refs = (n) => Array.from({ length: n }, (_, i) => "a1:" + i.toString(16).padStart(64, "0"));
      out.refs64 = await code(() => e2e.sealIndexOp(k, at, 1, { ...C, adds: refs(64), releases: refs(64) }));
      out.refs65 = await code(() => e2e.sealIndexOp(k, at, 1, { ...C, adds: refs(65) }));
      out.dup = await code(() => e2e.sealIndexOp(k, at, 1, { ...C, releases: [refs(1)[0], refs(1)[0]] }));
      out.badAddr = await code(() => e2e.sealIndexOp(k, at, 1, { ...C, adds: ["a1:" + "G".repeat(64)] }));
      out.noLists = await code(() => e2e.sealIndexOp(k, at, 1, { prev: null }));
      out.dseq0 = await code(() => e2e.sealIndexOp(k, { device: "d", dseq: 0 }, 1, C));
      out.dseqFrac = await code(() => e2e.sealIndexOp(k, { device: "d", dseq: 1.5 }, 1, C));
      out.noDevice = await code(() => e2e.sealIndexOp(k, { device: "", dseq: 1 }, 1, C));
      out.shortPrev = await code(() => e2e.sealIndexOp(k, at, 1, { ...C, prev: new Uint8Array(31) }));
      out.prevString = await code(() => e2e.sealIndexOp(k, at, 1, { ...C, prev: "x" }));
      out.notCanonical = await code(() => e2e.sealIndexOp(k, at, 0.5, C));
      out.undefinedOp = await code(() => e2e.sealIndexOp(k, at, undefined, C));
      out.copy = await code(() => e2e.sealIndexOp({ ...k }, at, 1, C));
      out.otherIndex = await code(() => e2e.sealIndexOp(Object.freeze({ ...k, index: k.wrap }), at, 1, C));
      out.openCopy = await code(async () => e2e.openIndexOp({ ...k }, at, await e2e.sealIndexOp(k, at, 1, C), C));
      return out;
    })()`);
    ok(J(r) === J({ refs64: "ok", refs65: "limit", dup: "bad_form", badAddr: "bad_form", noLists: "bad_form", dseq0: "bad_form", dseqFrac: "bad_form", noDevice: "bad_form", shortPrev: "bad_form", prevString: "bad_form", notCanonical: "bad_form", undefinedOp: "bad_form", copy: "bad_form", otherIndex: "bad_form", openCopy: "bad_form" }),
      "L-4: 64 references each way seal and 65 don't (limit); a duplicate or malformed address, missing lists, a dseq that isn't a positive integer, no device, a prev that isn't 32 bytes, an op without canonical form, and keys deriveEpochKeys didn't make (a copy, or another index key) are bad_form", r);
    // (the caller's arrays and buffers, changed while sealing is under way, change nothing sealed)
    const race = await P.ev(`(async () => {
      const k = await keys(), at = { device: "d", dseq: 2 }, prev = new Uint8Array(32).fill(7), adds = ["a1:" + "1".repeat(64)];
      const p = e2e.sealIndexOp(k, at, { n: 1 }, { prev, adds, releases: [] });
      prev.fill(8); adds.push("a1:" + "2".repeat(64));
      const env = await p;
      return await code(() => e2e.openIndexOp(k, at, env, { prev: new Uint8Array(32).fill(7), adds: ["a1:" + "1".repeat(64)], releases: [] }));
    })()`);
    ok(race === "ok", "L-5: the prev and adds are read when sealing starts: changing the caller's buffer and array afterwards changes nothing sealed", race);
  }
} catch (e) {
  ok(false, "the test ran to its end: " + (e?.stack ?? e));
} finally {
  await B.close();
  server.stop(true);
}
console.log(failures ? `${failures} FAILED` : "all passed");
process.exit(failures ? 1 : 0);
