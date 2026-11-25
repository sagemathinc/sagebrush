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
const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

// ---- fixtures: devices made the way a device makes them (keys on the device, private halves non-extractable)
async function newDevice(name, kind = "browser") {
  const id = newId();
  const sign = await keyFromSeed(random(32));
  const kem = await E.newKem();
  return { id, name, kind, sign, kem, rec: { id, name, kind, sign: b64(sign.raw), kem: b64(kem.publicRaw) }, signer: E.deviceSigner(id, sign) };
}
const recRec = (r) => ({ sign: b64(r.sign.raw), kem: b64(r.kem.publicRaw) });

/** A new epoch's fields (and its secret) for the entry after `state`. */
async function nextEpoch(state, secrets, suite = 1) {
  const n = state ? state.epoch.n + 1 : 0;
  const S = E.newEpochSecret();
  const commit = await E.epochCommit(S, ctx.account, n);
  let keyring = null, ring = null;
  if (n > 0) {
    ring = await E.sealKeyring({ S, account: ctx.account, n, suite, prev: state.head, secrets });
    keyring = { hash: ring.hash, epochs: [...ring.epochs] };
  }
  return { S, ring, epoch: { n, suite, commit, keyring } };
}

/** The add entry for `nd` signed by `by`, with the proof of possession done both ways. */
async function addEntry(state, by, nd) {
  const draft = E.nextBody(state, ctx, "add", { device: nd.rec, pop: null });
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

// ---- keyrings and epoch commitments
{
  const S = E.newEpochSecret(), s0 = E.newEpochSecret(), s1 = E.newEpochSecret();
  const prev = b64(random(32));
  const args = { S, account: ctx.account, n: 2, suite: 1, prev };
  const r = await E.sealKeyring({ ...args, secrets: new Map([[1, s1], [0, s0]]) });
  ok(canonText(r.epochs) === "[0,1]", "keyring: the epoch list is ordered");
  const commits = new Map([[0, await E.epochCommit(s0, ctx.account, 0)], [1, await E.epochCommit(s1, ctx.account, 1)]]);
  args.commits = commits;
  const m = await E.openKeyring({ ...args, hash: r.hash, epochs: [0, 1], bytes: r.bytes });
  ok(hex(m.get(0)) === hex(s0) && hex(m.get(1)) === hex(s1), "keyring: opens to the earlier secrets");
  const r2 = await E.sealKeyring({ ...args, secrets: new Map([[0, s0], [1, s1]]) });
  ok(hex(r.bytes.subarray(0, 12)) !== hex(r2.bytes.subarray(0, 12)), "keyring: a fresh nonce each time");
  await refuses("bad_keyring", () => E.openKeyring({ ...args, hash: r.hash, epochs: [0, 1], bytes: r2.bytes }), "keyring: a valid keyring that isn't the signed one is refused");
  const flip = r.bytes.slice(); flip[20] ^= 1;
  await refuses("bad_keyring", () => E.openKeyring({ ...args, hash: r.hash, epochs: [0, 1], bytes: flip }), "keyring: a changed byte fails the signed hash");
  for (const [k, v] of [["account", newId()], ["n", 3], ["prev", b64(random(32))], ["S", E.newEpochSecret()]])
    await refuses("bad_keyring", () => E.openKeyring({ ...args, [k]: v, hash: r.hash, epochs: [0, 1], bytes: r.bytes }), `keyring: another ${k} doesn't open it`);
  await refuses("bad_keyring", () => E.openKeyring({ ...args, hash: r.hash, epochs: [1], bytes: r.bytes }), "keyring: a different epoch list in the AAD doesn't open it");
  await refuses("bad_keyring", () => E.openKeyring({ ...args, commits: new Map([[0, commits.get(0)], [1, commits.get(0)]]), hash: r.hash, epochs: [0, 1], bytes: r.bytes }), "keyring: a secret that doesn't match its own epoch's commitment");
  await refuses("bad_keyring", () => E.openKeyring({ ...args, commits: undefined, hash: r.hash, epochs: [0, 1], bytes: r.bytes }), "keyring: no commitments, no secrets");
  {
    // (the plaintext is binary, 32 bytes per carried epoch: a keyring of 3 sealed and claimed as 2 fails before decryption)
    ok(r.bytes.length === 12 + 64 + 16, "keyring: exactly 32 bytes per secret, plus nonce and tag");
    const big = await E.sealKeyring({ S, account: ctx.account, n: 3, suite: 1, prev, secrets: new Map([[0, s0], [1, s1], [2, S]]) });
    await refuses("bad_keyring", () => E.openKeyring({ S, account: ctx.account, n: 3, suite: 1, prev, commits, hash: big.hash, epochs: [0, 1], bytes: big.bytes }), "keyring: a length that isn't the list's is refused");
  }
  await refuses("bad_form", () => E.sealKeyring({ ...args, secrets: new Map([[2, s0]]) }), "keyring: can't carry its own epoch");
  await refuses("bad_suite", () => E.sealKeyring({ ...args, suite: 2, secrets: new Map([[0, s0]]) }), "keyring: an unknown suite");
  const c = await E.epochCommit(S, ctx.account, 2);
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
  ok(!E.currentDevice(state, C.id) && state.epoch.n === 1 && canonText(state.epoch.keyring.epochs) === "[0]", "chain: remove starts epoch 1 with a keyring of epoch 0");
  const w1 = await E.wrapEpoch({ hpke, state, ctx, sender: A, recipient: { kind: "device", id: B.id }, n: 1, S: e1.S });
  const g1 = await E.openWrapper({ hpke, state, ctx, bytes: w1, me: { kind: "device", id: B.id, recipient: B.kem }, seen: isSeen });
  const commits = new Map(state.epochs.map((x) => [x.n, x.commit]));
  const ring = await E.openKeyring({ S: g1.S, account: ctx.account, n: 1, suite: 1, prev: state.epoch.prev, hash: state.epoch.keyring.hash, epochs: state.epoch.keyring.epochs, commits, bytes: e1.ring.bytes });
  ok(hex(ring.get(0)) === hex(e0.S), "keyring: a remaining device reaches epoch 0 through epoch 1's keyring");
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
  E.checkPin(state, { seq: 2, hash: state.hashes[2] });
  ok(true, "pin: an earlier head on the chain is accepted");
  await refuses("chain_fork", () => E.checkPin(state, { seq: 2, hash: b64(random(32)) }), "pin: another hash at the pinned position is a fork");
  await refuses("chain_fork", () => E.checkPin(before, { seq: state.seq, hash: state.head }), "pin: a chain shorter than the pin is a rollback");
  for (const [what, pin] of [["NaN seq", { seq: NaN, hash: undefined }], ["a string seq", { seq: "2", hash: state.hashes[2] }], ["a negative seq", { seq: -1, hash: state.hashes[0] }],
    ["a fractional seq", { seq: 1.5, hash: state.hashes[1] }], ["no hash", { seq: 1 }], ["an extra field", { seq: 1, hash: state.hashes[1], x: 1 }], ["a malformed hash", { seq: 1, hash: state.hashes[1].slice(1) }],
    ["a non-canonical hash", { seq: 1, hash: state.hashes[1].slice(0, 42) + "B" }], ["an array", [1, state.hashes[1]]]])
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
  await bad({ ...good.epoch, keyring: { ...good.epoch.keyring, epochs: [1] } }, "bad_keyring", "a keyring missing an earlier epoch");
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
  const S = E.newEpochSecret(), s0 = E.newEpochSecret(), prev = b64(random(32));
  // (sealKeyring: the plaintext it hands AES-GCM)
  let sealed = null;
  let undo = spy("encrypt", (f, alg, key, data) => { sealed = data; return f(alg, key, data); });
  let ring;
  try { ring = await E.sealKeyring({ S, account: ctx.account, n: 1, suite: 1, prev, secrets: new Map([[0, s0]]) }); } finally { undo(); }
  ok(sealed?.length === 32 && zero(sealed), "custody: sealKeyring zeroes its plaintext");
  // (openKeyring: the decrypted plaintext, on success and on a failed commitment check)
  const commits = new Map([[0, await E.epochCommit(s0, ctx.account, 0)]]);
  const args = { S, account: ctx.account, n: 1, suite: 1, prev, hash: ring.hash, epochs: [0], bytes: ring.bytes };
  for (const [what, cm] of [["success", commits], ["a failed commitment", new Map([[0, b64(random(32))]])]]) {
    let opened = null;
    undo = spy("decrypt", async (f, ...a) => (opened = await f(...a)));
    try { await E.openKeyring({ ...args, commits: cm }); } catch { /* (the failure case) */ } finally { undo(); }
    ok(opened?.byteLength === 32 && zero(opened), `custody: openKeyring zeroes its decrypted plaintext after ${what}`);
  }
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
  let s = await E.checkTransition({ state: null, ctx, entry: gen, wrappers: genW });
  ok(s.seq === 0, "package: genesis with wrappers to its device and the recovery key");
  await refuses("bad_package", () => E.checkTransition({ state: null, ctx, entry: gen, wrappers: genW.slice(0, 1) }), "package: genesis without the recovery wrapper");
  await refuses("bad_package", () => E.checkTransition({ state: null, ctx, entry: gen, wrappers: genW, keyring: new Uint8Array(44) }), "package: a keyring where no epoch needs one");

  for (const D of [Q, R]) {
    const add = await addEntry(s, P, D);
    const st = (await E.applyChainEntry(s, add, ctx)).state;
    const w = await wrapAll(st, ep0.S, 0, P, [{ kind: "device", id: D.id }]);
    await refuses("bad_package", () => E.checkTransition({ state: s, ctx, entry: add, wrappers: [] }), "package: an add without the new device's wrapper");
    s = await E.checkTransition({ state: s, ctx, entry: add, wrappers: w });
  }
  const ep1 = await nextEpoch(s, new Map([[0, ep0.S]]));
  const rem = await E.sealEntry(P.signer, E.nextBody(s, ctx, "remove", { remove: R.id, epoch: ep1.epoch }), P.sign);
  const st1 = (await E.applyChainEntry(s, rem, ctx)).state;
  const full = await wrapAll(st1, ep1.S, 1, P, [{ kind: "device", id: P.id }, { kind: "device", id: Q.id }, { kind: "recovery", id: ctx.account }]);
  const pk = { state: s, ctx, entry: rem, keyring: ep1.ring.bytes, wrappers: full };
  ok((await E.checkTransition(pk)).epoch.n === 1, "package: a removal with its keyring and a wrapper to every remaining device and recovery");
  await refuses("bad_package", () => E.checkTransition({ ...pk, keyring: null }), "package: a new epoch without its keyring");
  const other = await E.sealKeyring({ S: ep1.S, account: ctx.account, n: 1, suite: 1, prev: s.head, secrets: new Map([[0, ep0.S]]) });
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

// ---- labels: this PR's are distinct and versioned
{
  const v = Object.values(E.LABELS);
  ok(new Set(v).size === v.length && v.every((l) => /^sagebrush\.[a-z0-9.-]+\.v1$/.test(l)), "labels: distinct and versioned");
}

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
if (failures) process.exit(1);
