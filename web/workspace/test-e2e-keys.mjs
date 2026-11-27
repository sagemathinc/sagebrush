// ci: web-runner order=600 runner=bun
// E2E PR 2a: the key chain, epochs and keyrings, the recovery code, proofs of possession and epoch wrappers
// (design/e2e-encryption.md §2, §2.1, §2.2, §3.4, §11.1, §11.2), on the platform's WebCrypto through the fleet core's
// backend. HPKE is web/workspace/e2e/hpke-double.mjs until PR 1's hpke object lands.
//   bun web/workspace/test-e2e-keys.mjs
import { useCrypto } from "./fleet/core/crypto.mjs";
import { webCrypto } from "./fleet/core/webcrypto.mjs";
import { b64, newId, random, unb64, enc } from "./fleet/core/bytes.mjs";
import { canonText, parseCanonical } from "./fleet/core/canonical.mjs";
import { keyFromSeed } from "./fleet/core/ed25519.mjs";
import * as E from "./e2e/core/index.mjs";
import { hpkeDouble as hpke } from "./e2e/hpke-double.mjs";

useCrypto(webCrypto());

let failures = 0;
const ok = (c, msg) => { console.log((c ? "ok   " : "FAIL ") + msg); if (!c) failures++; };
async function refuses(code, f, msg) {
  try { await f(); ok(false, `${msg} (no refusal)`); }
  catch (e) { ok(e?.code === code, `${msg}${e?.code === code ? "" : ` (got ${e?.code ?? e})`}`); }
}
const ctx = { aud: "https://dev.sagebrush.space", account: newId() };
const J = JSON.stringify;
const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

// ---- fixtures: devices made the way a device makes them (keys on the device, private halves non-extractable)
async function newDevice(name, kind = "browser") {
  const id = newId();
  const sign = await keyFromSeed(random(32));
  const kem = await E.newKem();
  return { id, name, kind, sign, kem, rec: { id, name, kind, sign: b64(sign.raw), kem: b64(kem.publicRaw) }, signer: E.deviceSigner(id, sign) };
}
const recRec = (r) => ({ sign: b64(r.sign.raw), kem: b64(r.kem.publicRaw) });

/** A new epoch's fields (and its secret) for the entry after `state`: its keyring carries the current epoch's secret
 * (`secrets` maps each epoch to its secret); `generation` is a reset's new one. */
async function nextEpoch(state, secrets, suite = 1, generation = null) {
  const n = state ? state.epoch.n + 1 : 0;
  const S = E.newEpochSecret();
  const commit = await E.epochCommit(S, ctx.account, n);
  let keyring = null, ring = null;
  if (n > 0) {
    const meta = { epoch: n, generation: generation ?? state.generation, suite, prev: state.head, prev_ring: state.epoch.keyring?.hash ?? "" };
    ring = await E.sealKeyring({ S, account: ctx.account, meta, secret: secrets.get(n - 1) });
    keyring = { hash: ring.hash };
  }
  return { S, ring, epoch: { n, suite, commit, keyring } };
}

/** The add entry for `nd` signed by `by`, with the proof of possession done both ways (`extra`: more body fields). */
async function addEntry(state, by, nd, extra = {}) {
  const draft = E.nextBody(state, ctx, "add", { device: nd.rec, pop: null, ...extra });
  const pre = await E.preEntryHash(draft);
  const ch = await E.challenge(hpke, nd.kem.publicRaw, pre);
  const mac = await E.respond(hpke, nd.kem, ch.enc, pre);
  await E.checkResponse(ch.secret, ch.enc, pre, mac);
  const body = { ...draft, pop: { enc: b64(ch.enc), mac: b64(mac) } };
  return E.sealEntry(by.signer, body, by.sign, { device: nd.sign });
}

const apply = (s, bytes) => E.applyChainEntry(s, bytes, ctx).then((r) => r.state);

// ---- the recovery code
{
  const seed = E.newRecoverySeed();
  const code = E.codeOfSeed(seed);
  ok(code.length === 52 && /^[a-z2-7]+$/.test(code), "recovery: 32 bytes are 52 base32 characters");
  ok(E.showCode(code).split("-").length === 13, "recovery: shown in 13 groups of four");
  ok(hex(E.seedOfCode(E.showCode(code).toUpperCase().replace(/-/g, " "))) === hex(seed), "recovery: typed with spaces and capitals reads back");
  // (the last character carries 1 bit and 4 zero bits, so it is "a" or "q"; "b" and "r" set a pad bit)
  const last = code.at(-1), padded = code.slice(0, 51) + (last === "a" ? "b" : "r");
  for (const [typed, what] of [[code.slice(0, 51), "truncated"], [code + "a", "too long"], [code.slice(0, 50) + "1" + last, "a non-base32 character"], [padded, "non-zero pad bits"]]) {
    try { E.seedOfCode(typed); ok(false, `recovery: ${what} refused`); }
    catch (e) { ok(e.code === "recovery_failed" && e.message === "that recovery code doesn't open this account", `recovery: ${what} fails the one uniform way`); }
  }
  const a = await E.recoveryKeys(seed, ctx.account), b = await E.recoveryKeys(seed, ctx.account), c = await E.recoveryKeys(seed, newId());
  ok(hex(a.sign.raw) === hex(b.sign.raw) && hex(a.kem.publicRaw) === hex(b.kem.publicRaw), "recovery: the same seed and account derive the same keys");
  ok(hex(a.sign.raw) !== hex(c.sign.raw) && hex(a.kem.publicRaw) !== hex(c.kem.publicRaw), "recovery: another account derives other keys");
  ok(a.kem.privateKey.extractable === false, "recovery: the derived X25519 private key isn't extractable");
}

// ---- X25519 public keys
{
  const bad = ["00".repeat(32), "01" + "00".repeat(31), "e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800", "5f9c95bca3508c24b1d0b1559c83ef5b04445cc4581c8e86d8224eddd09f1157",
    "ec" + "ff".repeat(30) + "7f", "ed" + "ff".repeat(30) + "7f", "09" + "00".repeat(30) + "80"];
  for (const h of bad) await refuses("bad_key", () => E.checkKemPublic(Uint8Array.from(h.match(/../g), (x) => parseInt(x, 16))), `x25519: ${h.slice(0, 6)}…${h.slice(-2)} refused`);
  const k = await E.newKem();
  let extractable = true;
  try { await globalThis.crypto.subtle.exportKey("pkcs8", k.privateKey); } catch { extractable = false; }
  ok(!extractable && k.privateKey.extractable === false, "x25519: a device's private key is non-extractable");
}

// ---- chained keyrings and epoch commitments
{
  const gen = "g" + newId();
  const S1 = E.newEpochSecret(), S2 = E.newEpochSecret(), S3 = E.newEpochSecret(), s0 = E.newEpochSecret();
  const prevs = [null, b64(random(32)), b64(random(32)), b64(random(32))];
  const r1 = await E.sealKeyring({ S: S1, account: ctx.account, meta: { epoch: 1, generation: gen, suite: 1, prev: prevs[1], prev_ring: "" }, secret: s0 });
  const r2 = await E.sealKeyring({ S: S2, account: ctx.account, meta: { epoch: 2, generation: gen, suite: 1, prev: prevs[2], prev_ring: r1.hash }, secret: S1 });
  const r3 = await E.sealKeyring({ S: S3, account: ctx.account, meta: { epoch: 3, generation: gen, suite: 1, prev: prevs[3], prev_ring: r2.hash }, secret: S2 });
  ok(r1.bytes.length === 60 && r3.bytes.length === 60, "keyring: 60 bytes, whatever the epoch (one secret each)");
  const row = (r) => ({ ...r.meta, bytes: r.bytes });
  const o = await E.openKeyring({ S: S3, account: ctx.account, row: row(r3), expect: r3.hash });
  ok(hex(o.secret) === hex(S2) && o.prevRing === r2.hash, "keyring: opens to the previous epoch's secret and the authenticated previous keyring hash");
  const rr = await E.sealKeyring({ S: S3, account: ctx.account, meta: r3.meta, secret: S2 });
  ok(hex(rr.bytes.subarray(0, 12)) !== hex(r3.bytes.subarray(0, 12)), "keyring: a fresh nonce each time");
  await refuses("bad_keyring", () => E.openKeyring({ S: S3, account: ctx.account, row: row(rr), expect: r3.hash }), "keyring: a valid keyring that isn't the signed one is refused before decryption");
  const flip = r3.bytes.slice(); flip[20] ^= 1;
  const flipHash = await (await import("./fleet/core/bytes.mjs")).sha256b64(flip);
  await refuses("bad_keyring", () => E.openKeyring({ S: S3, account: ctx.account, row: { ...r3.meta, bytes: flip }, expect: flipHash }), "keyring: a changed ciphertext under its own hash fails authentication");
  for (const [k, v] of [["generation", "g" + newId()], ["epoch", 4], ["suite", 2], ["prev", b64(random(32))], ["prev_ring", r1.hash]])
    await refuses("bad_keyring", () => E.openKeyring({ S: S3, account: ctx.account, row: { ...row(r3), [k]: v }, expect: r3.hash }), `keyring: another ${k} in its row doesn't open it`);
  await refuses("bad_keyring", () => E.openKeyring({ S: S3, account: newId(), row: row(r3), expect: r3.hash }), "keyring: another account doesn't open it");
  await refuses("bad_keyring", () => E.openKeyring({ S: S2, account: ctx.account, row: row(r3), expect: r3.hash }), "keyring: another epoch's secret doesn't open it");
  await refuses("bad_keyring", () => E.sealKeyring({ S: S1, account: ctx.account, meta: { epoch: 2, generation: gen, suite: 1, prev: "x", prev_ring: "" }, secret: s0 }), "keyring: only epoch 1 has no previous keyring");
  // walking back: three steps, the next expected hash only from the authenticated keyring
  const rows = new Map([[1, row(r1)], [2, row(r2)], [3, row(r3)]]);
  const commits = new Map([[0, await E.epochCommit(s0, ctx.account, 0)], [1, await E.epochCommit(S1, ctx.account, 1)], [2, await E.epochCommit(S2, ctx.account, 2)]]);
  const kept = [];
  const got = await E.walkBack({ S: S3, n: 3, expect: r3.hash, to: 0, account: ctx.account, row: async (k) => rows.get(k), commit: (k) => commits.get(k), keep: async (k, x) => kept.push([k, hex(x)]) });
  ok(hex(got) === hex(s0) && kept.map(([k]) => k).join() === "2,1,0" && kept[0][1] === hex(S2), "walk: from epoch 3 back to epoch 0, keeping each verified secret");
  await refuses("bad_keyring", () => E.walkBack({ S: S3, n: 3, expect: r3.hash, to: 0, account: ctx.account, row: async (k) => (k === 2 ? row(r1) : rows.get(k)) }), "walk: a swapped row stops it");
  await refuses("bad_keyring", () => E.walkBack({ S: S3, n: 3, expect: r3.hash, to: 0, account: ctx.account, row: async (k) => (k === 1 ? undefined : rows.get(k)) }), "walk: a missing row stops it");
  await refuses("bad_keyring", () => E.walkBack({ S: S3, n: 3, expect: r2.hash, to: 0, account: ctx.account, row: async (k) => rows.get(k) }), "walk: a start hash that isn't the signed one stops it");
  await refuses("bad_keyring", () => E.walkBack({ S: S3, n: 3, expect: r3.hash, to: 0, account: ctx.account, row: async (k) => rows.get(k), commit: (k) => (k === 1 ? commits.get(0) : commits.get(k)) }), "walk: a secret that isn't its epoch's commitment stops it");
  {
    // (a forged keyring 1 sealed under S1, which a removed device of epoch 1 could make: valid metadata, a fake S0. With no
    //  commitment left for epoch 0 (after a reset), only keyring 2's authenticated prev_ring tells it from the real one)
    const fake0 = E.newEpochSecret();
    const evil = await E.sealKeyring({ S: S1, account: ctx.account, meta: r1.meta, secret: fake0 });
    const forged = new Map([[1, row(evil)], [2, row(r2)], [3, row(r3)]]);
    await refuses("bad_keyring", () => E.walkBack({ S: S3, n: 3, expect: r3.hash, to: 0, account: ctx.account, row: async (k) => forged.get(k) }), "walk: a forged earlier keyring with valid metadata is refused: the next expected hash comes only from the authenticated successor");
  }
  await refuses("limit", () => E.walkBack({ S: S3, n: 3, expect: r3.hash, to: 0, budget: 2, account: ctx.account, row: async (k) => rows.get(k) }), "walk: past its budget, refused before any step");
  const ac = new AbortController(); ac.abort();
  await refuses("aborted", () => E.walkBack({ S: S3, n: 3, expect: r3.hash, to: 0, account: ctx.account, row: async (k) => rows.get(k), signal: ac.signal }), "walk: cancellable");
  const S = S3, c = await E.epochCommit(S, ctx.account, 2);
  ok(c !== (await E.epochCommit(S, ctx.account, 3)) && c !== (await E.epochCommit(S, newId(), 2)), "epoch commitment: binds the account and the epoch");
}

// ---- proofs of possession
{
  const nd = await newDevice("phone"), other = await E.newKem();
  const pre = await E.preEntryHash({ op: "add", device: nd.rec, pop: { enc: "x", mac: "y" } });
  ok(hex(pre) === hex(await E.preEntryHash({ op: "add", device: nd.rec, pop: null })), "pop: the pre-entry hash leaves the proof out");
  ok(hex(pre) !== hex(await E.preEntryHash({ op: "add", device: { ...nd.rec, name: "other" }, pop: null })), "pop: and covers everything else");
  const ch = await E.challenge(hpke, nd.kem.publicRaw, pre);
  const kept = ch.secret;
  ok(await E.checkResponse(ch.secret, ch.enc, pre, await E.respond(hpke, nd.kem, ch.enc, pre)), "pop: the key's holder answers");
  ok(kept.every((b) => b === 0), "pop: checkResponse zeroes the challenger's secret after a success");
  const ch2 = await E.challenge(hpke, nd.kem.publicRaw, pre), kept2 = ch2.secret;
  await refuses("bad_pop", () => E.checkResponse(ch2.secret, ch2.enc, pre, new Uint8Array(32)), "pop: a wrong answer");
  ok(kept2.every((b) => b === 0), "pop: and after a failure");
  const ch3 = await E.challenge(hpke, nd.kem.publicRaw, pre);
  await refuses("bad_pop", async () => E.checkResponse(ch3.secret, ch3.enc, pre, await E.respond(hpke, other, ch3.enc, pre)), "pop: another key's holder can't");
  const pre2 = await E.preEntryHash({ op: "add", device: { ...nd.rec, name: "x" }, pop: null });
  const ch4 = await E.challenge(hpke, nd.kem.publicRaw, pre);
  await refuses("bad_pop", async () => E.checkResponse(ch4.secret, ch4.enc, pre, await E.respond(hpke, nd.kem, ch4.enc, pre2)), "pop: an answer for another entry fails");
}

// ---- the chain, end to end: genesis, add, remove (new epoch and keyring), wrappers, replace recovery, recover
const seen = new Set();
const isSeen = (id) => seen.has(id);
let state, A, B, C, seed, rec, e0, e1;
{
  A = await newDevice("laptop", "app");
  seed = E.newRecoverySeed();
  rec = await E.recoveryKeys(seed, ctx.account);
  e0 = await nextEpoch(null);
  const g = E.nextBody(null, ctx, "genesis", { device: A.rec, recovery: recRec(rec), epoch: e0.epoch });
  state = await apply(null, await E.sealEntry(A.signer, g, A.sign, { recovery: rec.sign }));
  ok(state.seq === 0 && state.epoch.n === 0 && E.currentDevice(state, A.id) && state.recovery.kemKey, "chain: genesis enrolls the device, the recovery key and epoch 0");
  await refuses("bad_form", async () => apply(null, await E.sealEntry(A.signer, g, A.sign)), "chain: genesis without the recovery key's countersignature");

  B = await newDevice("phone");
  state = await apply(state, await addEntry(state, A, B));
  ok(E.currentDevice(state, B.id)?.added === 1, "chain: add enrolls a countersigned device");
  const w = await E.wrapEpoch({ hpke, state, ctx, sender: A, recipient: { kind: "device", id: B.id }, n: 0, S: e0.S });
  const got = await E.openWrapper({ hpke, state, ctx, bytes: w, me: { kind: "device", id: B.id, recipient: B.kem }, seen: isSeen });
  ok(hex(got.S) === hex(e0.S) && got.n === 0, "wrap: the new device opens epoch 0");
  seen.add(got.id);
  await refuses("replayed", () => E.openWrapper({ hpke, state, ctx, bytes: w, me: { kind: "device", id: B.id, recipient: B.kem }, seen: isSeen }), "wrap: an exact replay is refused");

  C = await newDevice("old tablet");
  state = await apply(state, await addEntry(state, A, C));
  e1 = await nextEpoch(state, new Map([[0, e0.S]]));
  state = await apply(state, await E.sealEntry(A.signer, E.nextBody(state, ctx, "remove", { remove: C.id, epoch: e1.epoch }), A.sign));
  ok(!E.currentDevice(state, C.id) && state.epoch.n === 1 && state.epoch.keyring.hash === e1.ring.hash, "chain: remove starts epoch 1, committing its keyring");
  const w1 = await E.wrapEpoch({ hpke, state, ctx, sender: A, recipient: { kind: "device", id: B.id }, n: 1, S: e1.S });
  const g1 = await E.openWrapper({ hpke, state, ctx, bytes: w1, me: { kind: "device", id: B.id, recipient: B.kem }, seen: isSeen });
  const commits = new Map(state.epochs.map((x) => [x.n, x.commit]));
  const back = await E.walkBack({ S: g1.S, n: 1, expect: state.epoch.keyring.hash, to: 0, account: ctx.account, row: async () => ({ ...e1.ring.meta, bytes: e1.ring.bytes }), commit: (k) => commits.get(k) });
  ok(hex(back) === hex(e0.S), "keyring: a remaining device reaches epoch 0 through epoch 1's keyring");
  await refuses("bad_epoch", () => E.wrapEpoch({ hpke, state, ctx, sender: A, recipient: { kind: "device", id: B.id }, n: 0, S: e0.S }), "wrap: only the current epoch is wrapped");
  await refuses("device_unknown", () => E.wrapEpoch({ hpke, state, ctx, sender: A, recipient: { kind: "device", id: C.id }, n: 1, S: e1.S }), "wrap: never to a removed device");
  await refuses("bad_epoch", () => E.wrapEpoch({ hpke, state, ctx, sender: A, recipient: { kind: "device", id: B.id }, n: 1, S: e0.S }), "wrap: a secret that isn't the epoch's commitment");

  // the removed device can't sign, wrap or rebase
  await refuses("device_unknown", async () => apply(state, await E.sealEntry(C.signer, E.nextBody(state, ctx, "epoch", { epoch: (await nextEpoch(state, new Map([[0, e0.S], [1, e1.S]]))).epoch }), C.sign)), "chain: a removed device can't sign a later entry");
  const wc = await E.wrapEpoch({ hpke, state, ctx, sender: A, recipient: { kind: "device", id: B.id }, n: 1, S: e1.S });
  const forged = parseCanonical(wc);
  const fb = await (await import("./e2e/core/envelope.mjs")).seal("sb.e2e-wrap.v1", C.signer, forged.body, C.sign);
  await refuses("device_unknown", () => E.openWrapper({ hpke, state, ctx, bytes: fb, me: { kind: "device", id: B.id, recipient: B.kem }, seen: isSeen }), "wrap: a removed device's wrapper is refused");
  // (a field changed after signing)
  const tampered = parseCanonical(wc); tampered.body.epoch = 0;
  await refuses("bad_signature", () => E.openWrapper({ hpke, state, ctx, bytes: enc(canonText(tampered)), me: { kind: "device", id: B.id, recipient: B.kem }, seen: isSeen }), "wrap: a changed context breaks the signature");
  await refuses("bad_form", () => E.openWrapper({ hpke, state, ctx, bytes: wc, me: { kind: "device", id: A.id, recipient: A.kem }, seen: isSeen }), "wrap: not addressed to this device");
  {
    // (§3.4: HPKE's info names the sender's device and signing-key id; another current device can't re-sign a wrapper
    //  as its own, whether or not it also rewrites the sender inside the context)
    const env = await import("./e2e/core/envelope.mjs");
    let info = null;
    const spy = { ...hpke, seal: async (pk, i, aad, pt) => { info = new TextDecoder().decode(i); return hpke.seal(pk, i, aad, pt); } };
    const D2 = await newDevice("d2");
    state = await apply(state, await addEntry(state, A, D2));
    const wb = await E.wrapEpoch({ hpke: spy, state, ctx, sender: A, recipient: { kind: "device", id: B.id }, n: 1, S: e1.S });
    const ctxObj = JSON.parse(info.slice(info.indexOf("\n") + 1));
    ok(ctxObj.sender?.id === A.id && ctxObj.sender?.key === A.sign.key && ctxObj.account === ctx.account && ctxObj.recipient?.kem && ctxObj.id, "wrap: HPKE info binds the sender's device and signing-key id, the account, the recipient and the wrapper id");
    const body = parseCanonical(wb).body;
    const resigned = await env.seal("sb.e2e-wrap.v1", D2.signer, { ...body, id: newId() }, D2.sign);
    await refuses("bad_form", () => E.openWrapper({ hpke, state, ctx, bytes: resigned, me: { kind: "device", id: B.id, recipient: B.kem }, seen: isSeen }), "wrap: re-signed by another current device, the context's sender doesn't match");
    const rewritten = await env.seal("sb.e2e-wrap.v1", D2.signer, { ...body, id: body.id, sender: { id: D2.id, key: D2.sign.key } }, D2.sign);
    await refuses("bad_wrapper", () => E.openWrapper({ hpke, state, ctx, bytes: rewritten, me: { kind: "device", id: B.id, recipient: B.kem }, seen: () => false }), "wrap: and with the sender rewritten too, the HPKE context no longer opens");
  }
  await refuses("bad_form", () => E.openWrapper({ hpke, state, ctx, bytes: wc, me: { kind: "device", id: A.id, recipient: B.kem }, seen: isSeen }), "wrap: addressed to another device id, even holding its key");
  {
    // (a current device wraps a secret that isn't the epoch's, bypassing wrapEpoch's own check)
    const env = await import("./e2e/core/envelope.mjs");
    const body = { ...parseCanonical(wc).body, id: newId() };
    const { enc: _e, ct: _c, ...rest } = body;
    const sealed = await hpke.seal(B.kem.publicRaw, enc("sagebrush.e2e.wrap.v1\n" + canonText(rest)), enc("sagebrush.e2e.wrap.v1"), E.newEpochSecret());
    const bytes = await env.seal("sb.e2e-wrap.v1", A.signer, { ...rest, enc: b64(sealed.enc), ct: b64(sealed.ct) }, A.sign);
    await refuses("bad_wrapper", () => E.openWrapper({ hpke, state, ctx, bytes, me: { kind: "device", id: B.id, recipient: B.kem }, seen: isSeen }), "wrap: a secret that doesn't match the epoch's signed commitment");
  }
  await refuses("bad_form", () => E.openWrapper({ hpke, state, ctx, bytes: wc, me: { kind: "device", id: B.id, recipient: A.kem }, seen: isSeen }), "wrap: not this device's key");

  // recovery: a wrapper to the recovery key opens with the keys the code derives
  const wr = await E.wrapEpoch({ hpke, state, ctx, sender: A, recipient: { kind: "recovery", id: ctx.account }, n: 1, S: e1.S });
  const fromCode = await E.recoveryKeys(E.seedOfCode(E.showCode(E.codeOfSeed(seed))), ctx.account);
  const gr = await E.openWrapper({ hpke, state, ctx, bytes: wr, me: { kind: "recovery", id: ctx.account, recipient: fromCode.kem }, seen: isSeen });
  ok(hex(gr.S) === hex(e1.S), "recovery: the typed code opens the current epoch");

  // replace the recovery code: a current device signs, the new recovery key countersigns and proves its X25519 half
  const seed2 = E.newRecoverySeed(), rec2 = await E.recoveryKeys(seed2, ctx.account);
  const draft = E.nextBody(state, ctx, "replace-recovery", { recovery: recRec(rec2), pop: null });
  const pre = await E.preEntryHash(draft);
  const ch = await E.challenge(hpke, rec2.kem.publicRaw, pre);
  const mac = await E.respond(hpke, rec2.kem, ch.enc, pre);
  await E.checkResponse(ch.secret, ch.enc, pre, mac);
  const body = { ...draft, pop: { enc: b64(ch.enc), mac: b64(mac) } };
  await refuses("bad_form", async () => apply(state, await E.sealEntry(B.signer, body, B.sign)), "chain: a recovery replacement without the new key's countersignature");
  state = await apply(state, await E.sealEntry(B.signer, body, B.sign, { recovery: rec2.sign }));
  ok(state.recovery.signKey === rec2.sign.key, "chain: the recovery key is replaced");
  await refuses("device_unknown", () => E.wrapEpoch({ hpke, state, ctx, sender: C, recipient: { kind: "recovery", id: ctx.account }, n: 1, S: e1.S }).then((b) => E.openWrapper({ hpke, state, ctx, bytes: b, me: { kind: "recovery", id: ctx.account, recipient: rec2.kem }, seen: isSeen })), "wrap: a removed sender, even to recovery");
  await refuses("bad_form", () => E.openWrapper({ hpke, state, ctx, bytes: wr, me: { kind: "recovery", id: ctx.account, recipient: fromCode.kem }, seen: () => false }), "recovery: a wrapper to the old recovery key no longer counts");

  // recover with the new code: a new device, a new recovery key and a new epoch, in one entry signed by the old one
  const D = await newDevice("new laptop", "app");
  const seed3 = E.newRecoverySeed(), rec3 = await E.recoveryKeys(seed3, ctx.account);
  const e2 = await nextEpoch(state, new Map([[0, e0.S], [1, e1.S]]));
  const rb = E.nextBody(state, ctx, "recover", { device: D.rec, recovery: recRec(rec3), epoch: e2.epoch });
  await refuses("bad_signature", async () => apply(state, await E.sealEntry(E.recoverySigner(ctx.account, rec.sign), rb, rec.sign, { device: D.sign, recovery: rec3.sign })), "chain: the old recovery code can't recover");
  await refuses("bad_signature", async () => apply(state, await E.sealEntry(A.signer, rb, A.sign, { device: D.sign, recovery: rec3.sign })), "chain: only the recovery key signs a recovery");
  await refuses("bad_form", async () => apply(state, await E.sealEntry(E.recoverySigner(ctx.account, rec2.sign), rb, rec2.sign, { device: D.sign })), "chain: a recovery without the new recovery key's countersignature");
  const before = state;
  state = await apply(state, await E.sealEntry(E.recoverySigner(ctx.account, rec2.sign), rb, rec2.sign, { device: D.sign, recovery: rec3.sign }));
  ok(E.currentDevice(state, D.id) && state.recovery.signKey === rec3.sign.key && state.epoch.n === 2, "chain: recovery enrolls the device, replaces the code and starts epoch 2");
  await refuses("bad_signature", async () => apply(state, await E.sealEntry(E.recoverySigner(ctx.account, rec2.sign), E.nextBody(state, ctx, "recover", { device: (await newDevice("x")).rec, recovery: recRec(await E.recoveryKeys(E.newRecoverySeed(), ctx.account)), epoch: (await nextEpoch(state, new Map([[0, e0.S], [1, e1.S], [2, e2.S]]))).epoch }), rec2.sign)), "chain: a spent recovery code can't recover again");

  // pins, forks and rollbacks
  ok(state.seq === before.seq + 1, "chain: the recovery is the next entry");
  const gn = state.generation;
  ok(gn === state.hashes[0] && E.pinOf(state).generation === gn, "pin: the generation before any reset is the genesis entry's hash");
  E.checkPin(state, { seq: 2, hash: state.hashes[2], generation: gn });
  ok(true, "pin: an earlier head on the chain is accepted");
  await refuses("chain_fork", () => E.checkPin(state, { seq: 2, hash: b64(random(32)), generation: gn }), "pin: another hash at the pinned position is a fork");
  await refuses("chain_fork", () => E.checkPin(before, { seq: state.seq, hash: state.head, generation: gn }), "pin: a chain shorter than the pin is a rollback");
  await refuses("chain_reset", () => E.checkPin(state, { seq: 2, hash: state.hashes[2], generation: newId() }), "pin: a pin of another generation means the chain was reset since");
  for (const [what, pin] of [["NaN seq", { seq: NaN, hash: undefined, generation: gn }], ["a string seq", { seq: "2", hash: state.hashes[2], generation: gn }], ["a negative seq", { seq: -1, hash: state.hashes[0], generation: gn }],
    ["a fractional seq", { seq: 1.5, hash: state.hashes[1], generation: gn }], ["no hash", { seq: 1, generation: gn }], ["an extra field", { seq: 1, hash: state.hashes[1], generation: gn, x: 1 }], ["a malformed hash", { seq: 1, hash: state.hashes[1].slice(1), generation: gn }],
    ["a non-canonical hash", { seq: 1, hash: state.hashes[1].slice(0, 42) + "B", generation: gn }], ["no generation", { seq: 1, hash: state.hashes[1] }], ["an array", [1, state.hashes[1]]]])
    await refuses("bad_form", () => E.checkPin(state, pin), `pin: ${what} is refused before any comparison`);
}

// ---- concurrency, staleness and reuse (§2.1)
{
  const P = await newDevice("p"), Q = await newDevice("q");
  const rk = await E.recoveryKeys(E.newRecoverySeed(), ctx.account);
  const ep0 = await nextEpoch(null);
  const gen = await E.sealEntry(P.signer, E.nextBody(null, ctx, "genesis", { device: P.rec, recovery: recRec(rk), epoch: ep0.epoch }), P.sign, { recovery: rk.sign });
  let s = await apply(null, gen);
  const addQ = await addEntry(s, P, Q);
  s = await apply(s, addQ);
  // P and Q remove each other on the same head: the first wins, the second is stale; rebased, its signer is removed
  const epP = await nextEpoch(s, new Map([[0, ep0.S]])), epQ = await nextEpoch(s, new Map([[0, ep0.S]]));
  const pRemovesQ = await E.sealEntry(P.signer, E.nextBody(s, ctx, "remove", { remove: Q.id, epoch: epP.epoch }), P.sign);
  const qRemovesP = await E.sealEntry(Q.signer, E.nextBody(s, ctx, "remove", { remove: P.id, epoch: epQ.epoch }), Q.sign);
  const s2 = await apply(s, pRemovesQ);
  await refuses("chain_fork", () => apply(s2, qRemovesP), "concurrency: the second of two removals on one head is stale");
  await refuses("device_unknown", async () => apply(s2, await E.sealEntry(Q.signer, E.nextBody(s2, ctx, "remove", { remove: P.id, epoch: (await nextEpoch(s2, new Map([[0, ep0.S], [1, epP.S]]))).epoch }), Q.sign)), "concurrency: rebased, the removed device's entry is refused");
  await refuses("chain_fork", () => apply(s2, addQ), "concurrency: a replayed old entry is refused");
  await refuses("bad_form", async () => apply(s, await E.sealEntry(P.signer, E.nextBody(s, ctx, "remove", { remove: P.id, epoch: epP.epoch }), P.sign)), "chain: a device can't remove itself");
  await refuses("device_unknown", async () => apply(s, await E.sealEntry(P.signer, E.nextBody(s, ctx, "remove", { remove: newId(), epoch: epP.epoch }), P.sign)), "chain: removing an unknown device");
  await refuses("key_reused", async () => apply(s2, await addEntry(s2, P, Q)), "reuse: a removed device can't be added back with its id and keys");
  const Q2 = await newDevice("q2");
  await refuses("key_reused", async () => apply(s2, await addEntry(s2, P, { ...Q2, id: Q.id, rec: { ...Q2.rec, id: Q.id }, signer: E.deviceSigner(Q.id, Q2.sign) })), "reuse: nor a removed device's id with new keys");
  await refuses("key_reused", async () => apply(s2, await addEntry(s2, P, { ...Q2, rec: { ...Q2.rec, sign: Q.rec.sign }, sign: Q.sign })), "reuse: nor a new id with an old signing key");
  await refuses("bad_signature", async () => {
    const body = E.nextBody(s2, ctx, "add", { device: Q2.rec, pop: { enc: b64(random(32)), mac: b64(random(32)) } });
    return apply(s2, await E.sealEntry(P.signer, body, P.sign, { device: P.sign }));
  }, "chain: an add countersigned by the wrong key");
  await refuses("bad_form", async () => {
    const body = E.nextBody(s2, ctx, "add", { device: Q2.rec, pop: { enc: b64(random(32)), mac: b64(random(32)) } });
    return apply(s2, await E.sealEntry(P.signer, body, P.sign, { device: Q2.sign, recovery: rk.sign }));
  }, "chain: an add with an extra countersignature");

  // epochs: the next one only, carrying every earlier one, of a known suite at or above the minimum
  const bad = async (epoch, code, what) => refuses(code, async () => apply(s2, await E.sealEntry(P.signer, E.nextBody(s2, ctx, "epoch", { epoch }), P.sign)), `epoch: ${what}`);
  const good = await nextEpoch(s2, new Map([[0, ep0.S], [1, epP.S]]));
  await bad({ ...good.epoch, n: 3 }, "bad_epoch", "a skipped number");
  await bad({ ...good.epoch, n: 1 }, "bad_epoch", "a repeated number");
  await bad({ ...good.epoch, keyring: { ...good.epoch.keyring, epochs: [1] } }, "bad_form", "a keyring with fields beyond its hash");
  await bad({ ...good.epoch, suite: 2 }, "bad_suite", "an unknown suite");
  await bad({ ...good.epoch, keyring: null }, "bad_form", "no keyring after epoch 0");
  const s3 = await apply(s2, await E.sealEntry(P.signer, E.nextBody(s2, ctx, "epoch", { epoch: good.epoch }), P.sign));
  ok(s3.epoch.n === 2, "epoch: a device starts the next epoch");
  await refuses("bad_suite", async () => apply(s3, await E.sealEntry(P.signer, E.nextBody(s3, ctx, "min-suite", { min_suite: 1 }), P.sign)), "suite: the minimum only rises");
  await refuses("bad_suite", async () => apply(s3, await E.sealEntry(P.signer, E.nextBody(s3, ctx, "min-suite", { min_suite: 2 }), P.sign)), "suite: never above the suites in use (and never unknown)");

  // form: other account or audience, non-canonical bytes, unknown op, extra field
  await refuses("bad_form", () => E.applyChainEntry(s, pRemovesQ, { ...ctx, account: newId() }), "form: a state of another account");
  await refuses("bad_form", () => E.applyChainEntry(null, gen, { ...ctx, account: newId() }), "form: another account's entry");
  await refuses("bad_signature", async () => apply(s, await E.sealEntry(E.recoverySigner(ctx.account, rk.sign), E.nextBody(s, ctx, "epoch", { epoch: epP.epoch }), rk.sign)), "chain: the recovery key signs nothing but a recovery");
  await refuses("bad_audience", () => E.applyChainEntry(null, gen, { ...ctx, aud: "https://sagebrush.space" }), "form: another audience's entry");
  await refuses("bad_form", () => E.applyChainEntry(s, pRemovesQ, { ...ctx, aud: "https://sagebrush.space" }), "form: a state of another audience");
  const pretty = enc(JSON.stringify(parseCanonical(pRemovesQ), null, 1));
  await refuses("bad_form", () => apply(s, pretty), "form: non-canonical bytes");
  await refuses("bad_form", async () => apply(s, await E.sealEntry(P.signer, { ...E.nextBody(s, ctx, "remove", { remove: Q.id, epoch: epP.epoch }), extra: 1 }, P.sign)), "form: an extra field");
  await refuses("bad_form", async () => apply(s, await E.sealEntry(P.signer, E.nextBody(s, ctx, "promote", {}), P.sign)), "form: an unknown op");
  const sig = parseCanonical(pRemovesQ); sig.sig = b64(new Uint8Array(64));
  await refuses("bad_signature", () => apply(s, enc(canonText(sig))), "form: a zeroed signature");
}

// ---- keys from secret bytes: no private material exported, and the same public keys as the reference derivations
{
  const subtle = globalThis.crypto.subtle, orig = subtle.exportKey;
  let privateExports = 0;
  subtle.exportKey = function (format, key) { if (key?.type === "private") privateExports++; return orig.call(this, format, key); };
  let same = 0;
  try {
    for (let i = 0; i < 16; i++) {
      const seed = random(32);
      const k = await E.ed25519FromSeed(seed), x = await E.kemFromSeed(seed);
      // (the references: the fleet core's derivation, which exports a private JWK, run outside the counted window)
      subtle.exportKey = orig;
      const refEd = await keyFromSeed(seed);
      const jwk = await subtle.exportKey("jwk", await subtle.importKey("pkcs8", Uint8Array.of(0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20, ...seed), { name: "X25519" }, true, ["deriveBits"]));
      subtle.exportKey = function (format, key) { if (key?.type === "private") privateExports++; return orig.call(this, format, key); };
      if (hex(k.raw) === hex(refEd.raw) && b64(x.publicRaw) === jwk.x && k.key === refEd.key) same++;
    }
    const r = await E.recoveryKeys(E.newRecoverySeed(), ctx.account);
    const sig = await r.sign.sign(enc("m"));
    ok((await globalThis.crypto.subtle.verify({ name: "Ed25519" }, await globalThis.crypto.subtle.importKey("raw", r.sign.raw, { name: "Ed25519" }, true, ["verify"]), sig, enc("m"))) === true, "seeded: the recovery signing key signs under its public key");
  } finally {
    subtle.exportKey = orig;
  }
  ok(same === 16, "seeded: Ed25519 and X25519 public keys equal the reference derivations, 16 random seeds");
  ok(privateExports === 0, "seeded: no private key is ever exported while deriving them");
}

// ---- custody: buffers that held secrets are zeroed, and seeded private keys are imported non-extractable
{
  const subtle = globalThis.crypto.subtle;
  const spy = (name, wrap) => { const o = subtle[name]; subtle[name] = function (...a) { return wrap(o.bind(this), ...a); }; return () => { subtle[name] = o; }; };
  const zero = (b) => b && new Uint8Array(b.buffer ?? b, b.byteOffset ?? 0, b.byteLength).every((x) => x === 0);
  // (walkBack: every intermediate secret it decrypted is zeroed, on success and on failure; only the result is handed out)
  {
    const gen = "g" + newId(), S1 = E.newEpochSecret(), S2 = E.newEpochSecret(), s0 = E.newEpochSecret();
    const r1 = await E.sealKeyring({ S: S1, account: ctx.account, meta: { epoch: 1, generation: gen, suite: 1, prev: "a", prev_ring: "" }, secret: s0 });
    const r2 = await E.sealKeyring({ S: S2, account: ctx.account, meta: { epoch: 2, generation: gen, suite: 1, prev: "b", prev_ring: r1.hash }, secret: S1 });
    const rows = new Map([[1, { ...r1.meta, bytes: r1.bytes }], [2, { ...r2.meta, bytes: r2.bytes }]]);
    for (const [what, commit] of [["success", () => undefined], ["a failed commitment", (k) => (k === 0 ? b64(random(32)) : undefined)]]) {
      const opened = [];
      const undo = spy("decrypt", async (f, ...a) => { const r = await f(...a); opened.push(r); return r; });
      let out = null;
      try { out = await E.walkBack({ S: S2, n: 2, expect: r2.hash, to: 0, account: ctx.account, row: async (k) => rows.get(k), commit }); } catch { /* (the failure case) */ } finally { undo(); }
      const zeroed = opened.filter((b) => zero(b)).length;
      ok(opened.length === 2 && zeroed === (out ? 1 : 2), `custody: walkBack zeroes every intermediate secret after ${what} (the result is the caller's)`);
    }
  }
  let undo;
  // (checkResponse: the MAC it computes, on success and failure)
  const nd = await newDevice("z");
  const pre = await E.preEntryHash({ op: "add", device: nd.rec, pop: null });
  for (const [what, right] of [["success", true], ["failure", false]]) {
    const ch = await E.challenge(hpke, nd.kem.publicRaw, pre);
    const answer = right ? await E.respond(hpke, nd.kem, ch.enc, pre) : new Uint8Array(32);
    let want = null;
    undo = spy("sign", async (f, alg, ...a) => { const r = await f(alg, ...a); if ((alg?.name ?? alg) === "HMAC") want = r; return r; });
    try { await E.checkResponse(ch.secret, ch.enc, pre, answer); } catch { /* (the failure case) */ } finally { undo(); }
    ok(want?.byteLength === 32 && zero(want), `custody: checkResponse zeroes the MAC it computed after ${what}`);
  }
  // (seeded keys: every private key imported while deriving them is non-extractable, on its own, export or not)
  const imported = [];
  undo = spy("importKey", async (f, fmt, ...a) => { const k = await f(fmt, ...a); if (fmt === "pkcs8") imported.push(k); return k; });
  try { await E.ed25519FromSeed(random(32)); await E.kemFromSeed(random(32)); } finally { undo(); }
  ok(imported.length >= 3 && imported.every((k) => k.type === "private" && k.extractable === false), "custody: every seeded private key is imported non-extractable");
}

// ---- transition packages: an entry, its keyring and its wrappers, checked together before publishing
{
  const P = await newDevice("p"), Q = await newDevice("q"), R = await newDevice("r");
  const rk = await E.recoveryKeys(E.newRecoverySeed(), ctx.account);
  const ep0 = await nextEpoch(null);
  const gen = await E.sealEntry(P.signer, E.nextBody(null, ctx, "genesis", { device: P.rec, recovery: recRec(rk), epoch: ep0.epoch }), P.sign, { recovery: rk.sign });
  const after = (await E.applyChainEntry(null, gen, ctx)).state;
  const wrapAll = async (st, S, n, sender, who) => Promise.all(who.map((r) => E.wrapEpoch({ hpke, state: st, ctx, sender, recipient: r, n, S })));
  const genW = await wrapAll(after, ep0.S, 0, P, [{ kind: "device", id: P.id }, { kind: "recovery", id: ctx.account }]);
  let s = (await E.checkTransition({ state: null, ctx, entry: gen, wrappers: genW })).state;
  ok(s.seq === 0, "package: genesis with wrappers to its device and the recovery key");
  await refuses("bad_package", () => E.checkTransition({ state: null, ctx, entry: gen, wrappers: genW.slice(0, 1) }), "package: genesis without the recovery wrapper");
  await refuses("bad_package", () => E.checkTransition({ state: null, ctx, entry: gen, wrappers: genW, keyring: new Uint8Array(44) }), "package: a keyring where no epoch needs one");

  for (const D of [Q, R]) {
    const add = await addEntry(s, P, D);
    const st = (await E.applyChainEntry(s, add, ctx)).state;
    const w = await wrapAll(st, ep0.S, 0, P, [{ kind: "device", id: D.id }]);
    await refuses("bad_package", () => E.checkTransition({ state: s, ctx, entry: add, wrappers: [] }), "package: an add without the new device's wrapper");
    s = (await E.checkTransition({ state: s, ctx, entry: add, wrappers: w })).state;
  }
  const ep1 = await nextEpoch(s, new Map([[0, ep0.S]]));
  const rem = await E.sealEntry(P.signer, E.nextBody(s, ctx, "remove", { remove: R.id, epoch: ep1.epoch }), P.sign);
  const st1 = (await E.applyChainEntry(s, rem, ctx)).state;
  const full = await wrapAll(st1, ep1.S, 1, P, [{ kind: "device", id: P.id }, { kind: "device", id: Q.id }, { kind: "recovery", id: ctx.account }]);
  const pk = { state: s, ctx, entry: rem, keyring: ep1.ring.bytes, wrappers: full };
  const tr = await E.checkTransition(pk);
  ok(tr.state.epoch.n === 1 && tr.row.epoch === 1 && tr.row.prev_ring === "" && tr.row.generation === s.generation && tr.row.prev === s.head, "package: a removal with its keyring and a wrapper to every remaining device and recovery");
  await refuses("bad_package", () => E.checkTransition({ ...pk, keyring: null }), "package: a new epoch without its keyring");
  const other = await E.sealKeyring({ S: ep1.S, account: ctx.account, meta: ep1.ring.meta, secret: ep0.S });
  await refuses("bad_package", () => E.checkTransition({ ...pk, keyring: other.bytes }), "package: a keyring that isn't the committed one");
  for (let i = 0; i < 3; i++) await refuses("bad_package", () => E.checkTransition({ ...pk, wrappers: full.filter((_, j) => j !== i) }), `package: omitting required wrapper ${i + 1} of 3`);
  await refuses("bad_package", () => E.checkTransition({ ...pk, wrappers: [...full, full[0]] }), "package: a wrapper twice");
  const dup = await E.wrapEpoch({ hpke, state: st1, ctx, sender: Q, recipient: { kind: "device", id: P.id }, n: 1, S: ep1.S });
  await refuses("bad_package", () => E.checkTransition({ ...pk, wrappers: [...full, dup] }), "package: two wrappers to one recipient");
  const stale = await wrapAll(s, ep0.S, 0, P, [{ kind: "device", id: Q.id }]);
  await refuses("bad_package", () => E.checkTransition({ ...pk, wrappers: [...full.slice(0, 1), stale[0], full[2]] }), "package: a wrapper made before the entry (the old epoch)");
  {
    const env = await import("./e2e/core/envelope.mjs");
    const b = parseCanonical(full[2]).body;
    const byRemoved = await env.seal("sb.e2e-wrap.v1", R.signer, { ...b, id: newId(), sender: { id: R.id, key: R.sign.key } }, R.sign);
    await refuses("device_unknown", () => E.checkTransition({ ...pk, wrappers: [full[0], full[1], byRemoved] }), "package: a wrapper signed by the removed device");
  }
}

// ---- the recovery boundary: one failure for every way a code can fail
{
  const P = await newDevice("p");
  const seed = E.newRecoverySeed(), code = E.codeOfSeed(seed);
  const rk = await E.recoveryKeys(seed, ctx.account);
  const ep0 = await nextEpoch(null);
  const s = await apply(null, await E.sealEntry(P.signer, E.nextBody(null, ctx, "genesis", { device: P.rec, recovery: recRec(rk), epoch: ep0.epoch }), P.sign, { recovery: rk.sign }));
  const wr = await E.wrapEpoch({ hpke, state: s, ctx, sender: P, recipient: { kind: "recovery", id: ctx.account }, n: 0, S: ep0.S });
  const wd = await E.wrapEpoch({ hpke, state: s, ctx, sender: P, recipient: { kind: "device", id: P.id }, n: 0, S: ep0.S });
  const attempt = (typed, wrapper = wr, seen = () => false) => E.openRecovery({ hpke, state: s, ctx, typed, wrapper, seen });
  const r = await attempt(E.showCode(code));
  ok(hex(r.S) === hex(ep0.S) && r.sign.key === s.recovery.signKey, "recovery: the right code opens the epoch and gives the recovery signing key");
  const tampered = parseCanonical(wr); tampered.body.ct = b64(random(48));
  for (const [what, typed, w, seen] of [
    ["a malformed code", code.slice(0, 40), wr], ["a well-formed wrong code", E.codeOfSeed(E.newRecoverySeed()), wr],
    ["the right code with a device's wrapper", code, wd], ["the right code with a tampered wrapper", code, enc(canonText(tampered))],
    ["the right code with a replayed wrapper", code, wr, () => true], ["the right code with no wrapper", code, new Uint8Array(0)],
  ]) {
    try { await attempt(typed, w, seen); ok(false, `recovery: ${what} refused`); }
    catch (e) { ok(e.code === "recovery_failed" && e.message === "that recovery code doesn't open this account", `recovery: ${what} is the one uniform failure`); }
  }
}

// ---- the reset: a recovery-signed compaction to a new generation (no old device kept), and loading it under an anchor
{
  const enc8 = (b) => new TextDecoder().decode(b);
  const P = await newDevice("p"), Q = await newDevice("q");
  const seed = E.newRecoverySeed(), rk = await E.recoveryKeys(seed, ctx.account);
  const sec = new Map();
  const ep0 = await nextEpoch(null);
  sec.set(0, ep0.S);
  const gen = await E.sealEntry(P.signer, E.nextBody(null, ctx, "genesis", { device: P.rec, recovery: recRec(rk), epoch: ep0.epoch }), P.sign, { recovery: rk.sign });
  let s = await apply(null, gen);
  const entries = [gen];
  const rows = new Map();
  s = await apply(s, entries[entries.push(await addEntry(s, P, Q)) - 1]);
  const ep1 = await nextEpoch(s, sec);
  sec.set(1, ep1.S);
  rows.set(1, { ...ep1.ring.meta, bytes: ep1.ring.bytes });
  const e1 = await E.sealEntry(P.signer, E.nextBody(s, ctx, "epoch", { epoch: ep1.epoch }), P.sign);
  entries.push(e1);
  s = await apply(s, e1);
  // (the reset: the recovery key signs; a new device and a new recovery key countersign; a fresh generation; the next epoch)
  const D = await newDevice("recovered");
  const rk2 = await E.recoveryKeys(E.newRecoverySeed(), ctx.account);
  const generation = newId();
  const ep2 = await nextEpoch(s, sec, 1, generation);
  sec.set(2, ep2.S);
  rows.set(2, { ...ep2.ring.meta, bytes: ep2.ring.bytes });
  const body = E.nextBody(s, ctx, "reset", { generation, device: D.rec, recovery: recRec(rk2), epoch: ep2.epoch, min_suite: 1 });
  const reset = await E.sealEntry(E.recoverySigner(ctx.account, rk.sign), body, rk.sign, { device: D.sign, recovery: rk2.sign });
  const after = (await E.applyChainEntry(s, reset, ctx)).state;
  ok(after.seq === s.seq + 1 && after.base === after.seq && after.generation === generation && after.devices.size === 1 && E.currentDevice(after, D.id) && after.recovery.signKey === rk2.sign.key && after.epoch.n === 2 && after.epochs.length === 1,
    "reset: the next position, a new generation, the recovering device alone, the new recovery key and the next epoch");
  ok(ep2.ring.meta.prev_ring === ep1.ring.hash && ep2.ring.meta.generation === generation, "reset: its keyring names the old generation's last keyring");
  // the package: the keyring row and wrappers to exactly the new device and the new recovery key
  const next = after;
  const wD = await E.wrapEpoch({ hpke, state: next, ctx, sender: D, recipient: { kind: "device", id: D.id }, n: 2, S: ep2.S });
  const wR = await E.wrapEpoch({ hpke, state: next, ctx, sender: D, recipient: { kind: "recovery", id: ctx.account }, n: 2, S: ep2.S });
  const tr = await E.checkTransition({ state: s, ctx, entry: reset, keyring: ep2.ring.bytes, wrappers: [wD, wR] });
  ok(tr.row.generation === generation && tr.row.prev_ring === ep1.ring.hash && tr.row.epoch === 2, "reset: the package checks, with the keyring row's metadata from the chain");
  const wP = await E.wrapEpoch({ hpke, state: s, ctx, sender: P, recipient: { kind: "device", id: P.id }, n: 1, S: ep1.S });
  await refuses("bad_package", () => E.checkTransition({ state: s, ctx, entry: reset, keyring: ep2.ring.bytes, wrappers: [wD] }), "reset: a package without the recovery key's wrapper");
  await refuses("bad_form", () => E.checkTransition({ state: s, ctx, entry: reset, keyring: ep2.ring.bytes, wrappers: [wD, wR, wP] }), "reset: a package with an old-generation wrapper");
  // refusals
  await refuses("bad_signature", async () => apply(s, await E.sealEntry(P.signer, body, P.sign, { device: D.sign, recovery: rk2.sign })), "reset: a device can't sign one");
  const rkOld = await E.recoveryKeys(E.newRecoverySeed(), ctx.account);
  await refuses("bad_signature", async () => apply(s, await E.sealEntry(E.recoverySigner(ctx.account, rkOld.sign), body, rkOld.sign, { device: D.sign, recovery: rk2.sign })), "reset: not under another recovery key");
  await refuses("bad_form", async () => apply(s, await E.sealEntry(E.recoverySigner(ctx.account, rk.sign), body, rk.sign, { device: D.sign })), "reset: not without the new recovery key's countersignature");
  await refuses("bad_suite", async () => apply(s, await E.sealEntry(E.recoverySigner(ctx.account, rk.sign), { ...body, min_suite: 2 }, rk.sign, { device: D.sign, recovery: rk2.sign })), "reset: carries the minimum suite exactly");
  await refuses("bad_form", async () => apply(s, await E.sealEntry(E.recoverySigner(ctx.account, rk.sign), { ...body, generation: "x" }, rk.sign, { device: D.sign, recovery: rk2.sign })), "reset: a generation that isn't a fresh id");
  await refuses("chain_fork", async () => apply(s, await E.sealEntry(E.recoverySigner(ctx.account, rk.sign), { ...body, seq: body.seq + 1 }, rk.sign, { device: D.sign, recovery: rk2.sign })), "reset: only at the next position");
  // the store's preflight: one signature check against the recorded current recovery key, before anything else
  const recNow = { sign: rk.sign.raw, signKey: rk.sign.key };
  ok(await E.preflightReset(reset, ctx, recNow), "preflight: the reset signed by the current recovery key passes");
  const byOther = await E.sealEntry(E.recoverySigner(ctx.account, rkOld.sign), body, rkOld.sign, { device: D.sign, recovery: rk2.sign });
  await refuses("bad_signature", () => E.preflightReset(byOther, ctx, recNow), "preflight: another recovery key's reset is refused");
  const sigFlip = parseCanonical(reset); sigFlip.sig = sigFlip.sig.slice(0, -2) + (sigFlip.sig.at(-2) === "A" ? "B" : "A") + sigFlip.sig.at(-1);
  await refuses("bad_signature", () => E.preflightReset(enc(canonText(sigFlip)), ctx, recNow), "preflight: a bad signature under the right key id is refused");
  await refuses("bad_signature", () => E.preflightReset(entries[1], ctx, recNow), "preflight: an entry that isn't a reset is refused");
  await refuses("bad_signature", () => E.preflightReset(reset, ctx, null), "preflight: with no recorded recovery key, refused");
  // loading the compacted chain [reset, ...] under an anchor
  const anchor = { account: ctx.account, aud: ctx.aud, generation, seq: after.seq, hash: after.head };
  const loaded = await E.loadAnchored(reset, ctx, anchor);
  ok((await E.checkpointOf(loaded)).hash === (await E.checkpointOf(after)).hash, "anchor: the loaded checkpoint is the transition's state");
  for (const k of ["account", "aud", "generation", "seq", "hash"])
    await refuses("chain_unanchored", () => E.loadAnchored(reset, ctx, { ...anchor, [k]: k === "seq" ? anchor.seq + 1 : k === "aud" ? "https://sagebrush.space" : newId() }), `anchor: another ${k} refuses it`);
  await refuses("chain_unanchored", () => E.replayFrom([reset], ctx), "anchor: a fresh client with no anchor refuses a compacted chain");
  const stripped = parseCanonical(reset); delete stripped.co.recovery;
  await refuses("bad_signature", () => E.loadAnchored(enc(canonText(stripped)), ctx, anchor), "anchor: a checkpoint without the new recovery key's countersignature");
  // the code anchor: the typed code's recovery key is the chain's current one, and countersigned the reset
  const viaCode = await E.replayFrom([reset], ctx, { anchor: { code: rk2 } });
  ok(viaCode.head === after.head, "code: the current code anchors the compacted chain");
  await refuses("chain_unanchored", () => E.replayFrom([reset], ctx, { anchor: { code: rk } }), "code: the old code doesn't");
  {
    // (a server-made reset naming the person's public recovery key, but without its countersignature, doesn't load)
    const fakeDev = await newDevice("server's");
    const fakeRk = await E.recoveryKeys(E.newRecoverySeed(), ctx.account);
    const fb = { ...body, device: fakeDev.rec, recovery: recRec(rk2) };
    const forged = await E.sealEntry(E.recoverySigner(ctx.account, fakeRk.sign), fb, fakeRk.sign, { device: fakeDev.sign, recovery: fakeRk.sign });
    await refuses("bad_signature", () => E.replayFrom([forged], ctx, { anchor: { code: rk2 } }), "code: a forged checkpoint without the code key's countersignature");
  }
  // nothing from before the reset counts after it
  const later = await E.wrapEpoch({ hpke, state: after, ctx, sender: D, recipient: { kind: "device", id: D.id }, n: 2, S: ep2.S });
  ok((await E.openWrapper({ hpke, state: after, ctx, bytes: later, me: { kind: "device", id: D.id, recipient: D.kem }, seen: () => false })).n === 2, "(a new-generation wrapper opens)");
  await refuses("bad_form", () => E.verifyWrapper(after, ctx, wP), "replay: a pre-reset wrapper is refused in the new generation");
  await refuses("chain_fork", () => apply(after, entries[1]), "replay: a pre-reset entry (with its countersignature) is refused");
  await refuses("chain_reset", () => E.checkPin(after, E.pinOf(s)), "replay: a pre-reset pin is refused as a reset");
  // a walk across both generations, back to epoch 0
  const back = await E.walkBack({ S: ep2.S, n: 2, expect: after.epoch.keyring.hash, to: 0, account: ctx.account, row: async (k) => rows.get(k), commit: (k) => (k === 2 ? after.epoch.commit : undefined) });
  ok(hex(back) === hex(ep0.S), "walk: from the new generation back across the reset to epoch 0");
  // and the chain goes on after it: an add in the new generation
  const R = await newDevice("r");
  const st2 = await apply(after, await addEntry(after, D, R));
  ok(st2.seq === after.seq + 1 && E.currentDevice(st2, R.id), "reset: ordinary operations go on after it");
  const reloaded = await E.replayFrom([reset, await addEntry(after, D, R)].slice(0, 1), ctx, { anchor });
  ok(reloaded.head === after.head, "(the compacted chain replays from its anchor)");
}

// ---- the provisioned tier (notes provisioned-machine-enrollment r12.1 §1, r3): a GPU machine joins only by an add a
// non-provisioned device signs, its add carries the service's labels and how it was approved, and it signs no entry
{
  const P = await newDevice("laptop"), G = await newDevice("gpu-a100-3f2c", "provisioned"), Q = await newDevice("phone");
  const rk = await E.recoveryKeys(E.newRecoverySeed(), ctx.account);
  const sec = new Map();
  const ep0 = await nextEpoch(null);
  sec.set(0, ep0.S);
  const gen = await E.sealEntry(P.signer, E.nextBody(null, ctx, "genesis", { device: P.rec, recovery: recRec(rk), epoch: ep0.epoch }), P.sign, { recovery: rk.sign });
  let s = await apply(null, gen);
  const atStart = { reservation: "rsv_01JD8Y3Q", instance: "runpod:7f3a9c", retire_on: E.RETIRE_ON, approved: "start" };
  const addG = await addEntry(s, P, G, { provisioned: atStart });
  const before = s;
  s = await apply(s, addG);
  const g = E.currentDevice(s, G.id);
  ok(g?.kind === "provisioned" && g.provisioned?.reservation === atStart.reservation && g.provisioned.instance === atStart.instance && g.provisioned.retireOn === "reservation-retired" && g.provisioned.approved === "start",
    "tier: a non-provisioned device adds a provisioned machine; the state keeps its reservation, instance, policy and approval");
  ok(E.currentDevice(s, P.id)?.provisioned === null, "tier: any other device has no provisioned labels");
  const replayed = await E.replayChain([gen, addG], ctx);
  ok(J(replayed.devices.get(G.id)?.provisioned) === J(g.provisioned), "tier: a replay finds the same labels");
  const card = await apply(before, await addEntry(before, P, G, { provisioned: { ...atStart, instance: null, retire_on: null, approved: "card" } }));
  ok(E.currentDevice(card, G.id)?.provisioned?.approved === "card", "tier: approved on the card, with no instance label and no policy");

  // (the add's form)
  for (const [what, extra] of [
    ["without its labels", {}],
    ["approved at Start without the retirement policy", { provisioned: { ...atStart, retire_on: null } }],
    ["with another policy", { provisioned: { ...atStart, retire_on: "never" } }],
    ["with another approval", { provisioned: { ...atStart, approved: "server" } }],
    ["with a reservation that isn't a label", { provisioned: { ...atStart, reservation: "a b" } }],
    ["with no reservation", { provisioned: { ...atStart, reservation: "" } }],
    ["with an instance that isn't a string or null", { provisioned: { ...atStart, instance: 7 } }],
    ["with an extra label", { provisioned: { ...atStart, region: "us" } }],
    ["with a missing label", { provisioned: (({ approved, ...r }) => r)(atStart) }],
  ]) await refuses("bad_form", async () => apply(before, await addEntry(before, P, G, extra)), `tier: a provisioned add ${what}`);
  await refuses("bad_form", async () => apply(before, await addEntry(before, P, Q, { provisioned: atStart })), "tier: another kind's add carries no provisioned labels");
  {
    // (the labels are signed: changed after signing, the signature fails)
    const t = parseCanonical(addG); t.body.provisioned.approved = "card";
    await refuses("bad_signature", () => apply(before, enc(canonText(t))), "tier: a label changed after signing breaks the signature");
  }

  // (a provisioned key signs nothing: an add, a removal of another or of itself, an epoch, a recovery key, a suite)
  const epG = await nextEpoch(s, sec);
  const byG = (op, fields, co = {}) => E.sealEntry(G.signer, E.nextBody(s, ctx, op, fields), G.sign, co);
  await refuses("provisioned_signer", async () => apply(s, await addEntry(s, G, Q)), "tier: a provisioned key can't add a device");
  await refuses("provisioned_signer", async () => apply(s, await addEntry(s, G, await newDevice("gpu-2", "provisioned"), { provisioned: atStart })), "tier: nor another provisioned machine");
  await refuses("provisioned_signer", async () => apply(s, await byG("remove", { remove: P.id, epoch: epG.epoch })), "tier: nor remove a device");
  await refuses("provisioned_signer", async () => apply(s, await byG("remove", { remove: G.id, epoch: epG.epoch })), "tier: nor remove itself");
  await refuses("provisioned_signer", async () => apply(s, await byG("epoch", { epoch: epG.epoch })), "tier: nor start an epoch");
  {
    const rk2 = await E.recoveryKeys(E.newRecoverySeed(), ctx.account);
    const draft = E.nextBody(s, ctx, "replace-recovery", { recovery: recRec(rk2), pop: null });
    const pre = await E.preEntryHash(draft);
    const ch = await E.challenge(hpke, rk2.kem.publicRaw, pre);
    const mac = await E.respond(hpke, rk2.kem, ch.enc, pre);
    await refuses("provisioned_signer", async () => apply(s, await E.sealEntry(G.signer, { ...draft, pop: { enc: b64(ch.enc), mac: b64(mac) } }, G.sign, { recovery: rk2.sign })), "tier: nor replace the recovery key");
  }
  await refuses("provisioned_signer", async () => apply(s, await byG("min-suite", { min_suite: 2 })), "tier: nor raise the minimum suite");

  // (it joins only by an add: never as genesis, a recovery's or a reset's device)
  const G2 = await newDevice("gpu-genesis", "provisioned");
  await refuses("bad_form", async () => apply(null, await E.sealEntry(G2.signer, E.nextBody(null, ctx, "genesis", { device: G2.rec, recovery: recRec(rk), epoch: ep0.epoch }), G2.sign, { recovery: rk.sign })), "tier: a provisioned machine can't be a chain's first device");
  const rk3 = await E.recoveryKeys(E.newRecoverySeed(), ctx.account);
  await refuses("bad_form", async () => apply(s, await E.sealEntry(E.recoverySigner(ctx.account, rk.sign), E.nextBody(s, ctx, "recover", { device: G2.rec, recovery: recRec(rk3), epoch: epG.epoch }), rk.sign, { device: G2.sign, recovery: rk3.sign })), "tier: nor the device a recovery enrolls");
  const generation = newId(), epR = await nextEpoch(s, sec, 1, generation);
  const resetG = await E.sealEntry(E.recoverySigner(ctx.account, rk.sign), E.nextBody(s, ctx, "reset", { generation, device: G2.rec, recovery: recRec(rk3), epoch: epR.epoch, min_suite: 1 }), rk.sign, { device: G2.sign, recovery: rk3.sign });
  await refuses("bad_form", () => apply(s, resetG), "tier: nor a reset's only device");
  await refuses("bad_form", () => E.replayFrom([resetG], ctx, { anchor: { code: rk3 } }), "tier: nor a compacted chain's, loaded under an anchor");

  // (a non-provisioned device removes it, starting the next epoch: the removal r12.1's retirement and P1 sign)
  const removed = await apply(s, await E.sealEntry(P.signer, E.nextBody(s, ctx, "remove", { remove: G.id, epoch: epG.epoch }), P.sign));
  ok(!E.currentDevice(removed, G.id) && removed.epoch.n === 1, "tier: a non-provisioned device removes it, and the removal starts the next epoch");
  // (and the server's chain store refuses the same: it replays with this core, test-e2e-chain.mjs)
}

// ---- labels: this PR's are distinct and versioned
{
  const v = Object.values(E.LABELS);
  ok(new Set(v).size === v.length && v.every((l) => /^sagebrush\.[a-z0-9.-]+\.v1$/.test(l)), "labels: distinct and versioned");
}

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
if (failures) process.exit(1);
