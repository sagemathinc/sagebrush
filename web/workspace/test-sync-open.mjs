// ci: web-runner order=358 runner=bun
// Pull's verification of sealed index ops (sync-seal.ts verifyRow; design e2e-encryption.md §4.1; e2e PR 5c): logs
// built here as the server stores them (each op sealed and signed by sync-seal's own sealOps), against a key chain as a
// device verifies it (absolute positions from the chain's base; devices added and removed at positions). Every way a
// row can fail halts at it (SealedHalt), with the check that failed; the floor at R-1, R and R+1 around a removal; a
// compacted chain; the per-device chain's null genesis; a head newer than the device's view; and a fuzz: two readers
// of the same log against the same chain, reading it in different pages with different chain-refresh timing, stop at
// the same op with the same state, every time.
//   bun web/workspace/test-sync-open.mjs
import { createHash } from "node:crypto";
import { join } from "node:path";

const here = new URL(".", import.meta.url).pathname;
const K = await import(join(here, "sync-seal.ts"));
const { deriveEpochKeys } = await import(join(here, "e2e", "keys.ts"));
const { sealIndexOp, signIndexOp } = await import(join(here, "e2e", "index-op.ts"));

let failures = 0, count = 0;
const ok = (c, msg, detail) => { count++; console.log((c ? "ok   " : "FAIL ") + msg + (!c && detail !== undefined ? "  " + JSON.stringify(detail).slice(0, 400) : "")); if (!c) failures++; };
const J = JSON.stringify;
// (an op as canonical JSON orders it: keys sorted, so ops compare by content)
const C14 = (o) => JSON.stringify(Object.fromEntries(Object.entries(o).sort(([x], [y]) => (x < y ? -1 : 1))));
const b64u = (b) => Buffer.from(b).toString("base64url");
const rand32 = () => crypto.getRandomValues(new Uint8Array(32));
const e2eId = () => { const A = "abcdefghijklmnopqrstuvwxyz234567", r = crypto.getRandomValues(new Uint8Array(26)); return Array.from(r.subarray(0, 25), (x) => A[x & 31]).join("") + "aeimquy4"[r[25] & 7]; };
// (a seeded generator, so each fuzz round is reproducible from its seed)
const rng = (seed) => () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);

/** A key chain as a device verifies it: heads at absolute positions from `base`, devices added and removed at positions. */
async function chainOf(base = 5) {
  const account = "e2e-" + e2eId(), generation = b64u(rand32());
  const keys = { 1: await deriveEpochKeys(rand32(), account, 1), 2: await deriveEpochKeys(rand32(), account, 2) };
  const heads = [b64u(rand32())], devices = new Map(), epochs = [{ n: 1, at: base }];
  const C = {
    account, generation, keys, heads, devices, base,
    top: () => base + heads.length - 1,
    move: () => { heads.push(b64u(rand32())); return C.top(); },
    async device() {
      const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"]);
      const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
      const id = e2eId();
      if (devices.size) C.move();
      devices.set(id, { raw, added: C.top(), removed: null });
      return { id, sign: async (b) => new Uint8Array(await crypto.subtle.sign("Ed25519", pair.privateKey, b)) };
    },
    remove: (id) => { C.move(); devices.get(id).removed = C.top(); },
    epoch: (n) => { C.move(); epochs.push({ n, at: C.top() }); },
    /** a view knowing the first `known` heads (all, unless said) */
    view(known = heads.length) {
      const position = (h) => { const i = heads.slice(0, known).indexOf(h); return i < 0 ? null : base + i; };
      return {
        head: heads[known - 1], generation, currentEpoch: epochs.filter((e) => e.at <= base + known - 1).at(-1).n, position,
        signerAt: (h, id) => { const p = position(h), d = devices.get(id); return p !== null && d && d.added <= p && (d.removed === null || d.removed > p) ? d.raw : null; },
        epochAt: (h) => { const p = position(h); return p === null ? null : epochs.filter((e) => e.at <= p).at(-1).n; },
        device: (id) => { const d = devices.get(id); return d ? { added: d.added, removed: d.removed } : null; },
      };
    },
    /** a reader's key provider: a view of `known` heads, read again (all of them) when asked to refresh */
    provider(signer, known = heads.length) {
      const P = { refreshes: 0 };
      return Object.assign(P, {
        account, device: signer,
        chain: async (refresh) => { if (refresh) { P.refreshes++; known = heads.length; } return C.view(known); },
        epochKeys: async (n) => keys[n] ?? null,
      });
    },
  };
  return C;
}

const SYNC_GEN = 1;
const opOf = (dseq, i, file) => ({ dseq, t: 1_700_000_000_000 + i, by: "person", op: file ? "create" : "mkdir", path: `/p${i}${file ? ".txt" : ""}`, kind: file ? "file" : "folder", fid: (i + 1).toString(16).padStart(16, "0"), ...(file ? { sha256: createHash("sha256").update("f" + i).digest("hex"), size: 3 } : {}) });

/**
 * A log as the server keeps it: rows sealed and signed by sync-seal's sealOps, each device's chain after its last
 * accepted envelope. `plan`: [{ dev, file?, then? }] in log order; `then(C)` runs before that op is sealed (a device
 * added or removed, an epoch: the head moves, as it would between sends).
 */
async function logOf(C, signers, plan) {
  const rows = [], last = new Map(), dseq = new Map();
  let seq = 0;
  for (const [i, step] of plan.entries()) {
    if (step.then) await step.then(C);
    const s = signers[step.dev], syncDev = `sync-dev-${step.dev}`;
    const d = (dseq.get(syncDev) ?? 0) + (step.gap ?? 0) + 1;
    dseq.set(syncDev, d);
    const P = C.provider(s);
    const [sealed] = await K.sealOps(P, SYNC_GEN, syncDev, [step.op ? { ...step.op, dseq: d } : opOf(d, i, step.file)], last.get(syncDev) ?? null);
    last.set(syncDev, sealed.envHash);
    rows.push({ seq: ++seq, device: syncDev, dseq: d, env: sealed.env, head: sealed.head, chain_gen: sealed.chainGen, adds: sealed.adds, releases: sealed.releases, signer: sealed.signer, sig: sealed.sig, _op: opOf(d, i, step.file) });
  }
  return rows;
}
const wire = (r) => { const { _op, ...w } = r; return w; };

/** A reader: verifies the rows in order from PULL_START, page by page; the verdict, where it stopped, and the state. */
async function read(P, rows, pages = [rows.length]) {
  let st = K.PULL_START, at = 0, opened = [];
  for (const n of pages) {
    for (const r of rows.slice(at, at + n)) {
      try {
        const v = await K.verifyRow(P, SYNC_GEN, wire(r), st);
        st = v.state;
        opened.push(v.op);
      } catch (e) {
        if (!(e instanceof K.SealedHalt)) throw e;
        return { verdict: "halt", seq: e.seq, why: e.why, state: st, opened };
      }
    }
    at += n;
  }
  return { verdict: "ok", seq: rows.length ? rows[rows.length - 1].seq : 0, state: st, opened };
}
const haltOf = async (P, rows, k, change) => {
  const t = rows.map((r, i) => (i === k ? change({ ...r }) : r));
  return read(P, t);
};

// ---- V1: an honest log of two devices, interleaved, files and folders, across a head move
{
  const C = await chainOf();
  const a = await C.device(), b = await C.device();
  const rows = await logOf(C, { a, b }, [{ dev: "a" }, { dev: "b", file: true }, { dev: "a", file: true }, { dev: "b", then: (C) => C.move() }, { dev: "a" }]);
  const r = await read(C.provider(a), rows);
  // (a file op opens with its blob's address under its epoch beside it, derived by verifyRow (e2e PR 3b-2): the op
  // itself, without those two fields, is what was sealed)
  const bare = (op) => { const { address, addressEpoch, ...rest } = op; return rest; };
  ok(r.verdict === "ok" && r.opened.length === 5 && r.opened.every((op, i) => C14(bare(op)) === C14(rows[i]._op)), "V1: an honest log of two devices verifies, and every op opens to what was sealed", r);
  const { addressOf } = await import(join(here, "e2e", "blob-wire.ts"));
  const files = [];
  for (const [i, op] of r.opened.entries()) if (op.kind === "file" && op.sha256) files.push({ op, row: rows[i], want: await addressOf(C.keys[1], Buffer.from(op.sha256, "hex")) });
  ok(files.length === 2 && files.every(({ op, row, want }) => op.address === want && op.addressEpoch === 1 && row.adds.length === 1 && row.adds[0] === want),
    "V1: each file op opens with its blob's address under its epoch (1), the one its row's visible add names: " + J(files.map(({ op }) => [op.address?.slice(0, 10), op.addressEpoch])));
  ok(r.state.seq === 5 && r.state.floor === C.top() && r.state.devices["sync-dev-a"].dseq === 3 && r.state.devices["sync-dev-b"].dseq === 2,
    "V1: the state after it: the last seq, the floor at the newest head, each device's last dseq", r.state);
  const again = await read(C.provider(b), rows, [2, 2, 1]);
  ok(J(again.state) === J(r.state) && again.verdict === "ok", "V1: read in other pages by another device: the same state");
}

// ---- V2r (e2e PR 5d): a release op is exactly its form: it opens; with anything more (a path, content), it halts
{
  const C = await chainOf();
  const a = await C.device();
  const P = C.provider(a);
  const R = (extra) => ({ t: 1, by: "person", op: "release", path: "/", kind: "folder", releases: [{ address: "5".repeat(64), add: 1 }], ...extra });
  const good = await read(P, await logOf(C, { a }, [{ dev: "a" }, { dev: "a", op: R({}) }]));
  const how = {};
  for (const [name, extra] of [["another path", { path: "/x" }], ["a kind", { kind: "file" }], ["bytes", { sha256: "6".repeat(64) }], ["an identity", { fid: "0123456789abcdef" }], ["no releases", { releases: [] }]]) {
    const r = await read(P, await logOf(C, { a }, [{ dev: "a" }, { dev: "a", op: R(extra) }]));
    how[name] = r.verdict === "halt" && r.seq === 2 && /only a release/.test(r.why) ? "halt" : r;
  }
  ok(good.verdict === "ok" && good.opened[1]?.op === "release" && Object.values(how).every((x) => x === "halt"),
    "V2r: a release op of exactly its form opens; one with another path or kind, bytes, an identity, or no release halts at it", { good: good.verdict, how });
}

// ---- V2: every way one row can fail: halted at it, the check named, nothing after it opened
{
  const C = await chainOf();
  const a = await C.device(), b = await C.device();
  const rows = await logOf(C, { a, b }, [{ dev: "a" }, { dev: "b", file: true }, { dev: "a", file: true }, { dev: "b" }]);
  const P = C.provider(a);
  const flip = (s, i = 10) => s.slice(0, i) + (s[i] === "A" ? "B" : "A") + s.slice(i + 1);
  const cases = {
    "the envelope changed": [2, (r) => ({ ...r, env: flip(r.env, 20) }), /signature/],
    "the envelope not base64": [2, (r) => ({ ...r, env: "!!" }), /isn't one/],
    "an unknown head": [2, (r) => ({ ...r, head: b64u(rand32()) }), /doesn't hold/],
    "another chain generation": [2, (r) => ({ ...r, chain_gen: b64u(rand32()) }), /generation/],
    "an unknown signer": [2, (r) => ({ ...r, signer: e2eId() }), /never a device/],
    "the other device as signer": [2, (r) => ({ ...r, signer: b.id }), /signature/],
    "the signature changed": [2, (r) => ({ ...r, sig: flip(r.sig) }), /signature/],
    "an add changed": [2, (r) => ({ ...r, adds: ["0".repeat(64)] }), /signature/],
    "a release added": [2, (r) => ({ ...r, releases: [{ address: "0".repeat(64), add: 1 }] }), /signature/],
    "another dseq": [2, (r) => ({ ...r, dseq: r.dseq + 1 }), /signature/],
    "another sync device": [2, (r) => ({ ...r, device: "sync-dev-z" }), /signature/],
    "no signature": [2, (r) => ({ ...r, sig: undefined }), /no sig/],
    "an add named twice": [2, (r) => ({ ...r, adds: [...r.adds, ...r.adds, "1".repeat(64), "1".repeat(64)] }), /twice/],
    "a release named twice": [2, (r) => ({ ...r, releases: [{ address: "2".repeat(64), add: 1 }, { address: "2".repeat(64), add: 1 }] }), /twice/],
    "a release in the old form, a bare address": [2, (r) => ({ ...r, releases: ["2".repeat(64)] }), /aren't \{ address, add \}/],
    "a release with an add seq of 0": [2, (r) => ({ ...r, releases: [{ address: "2".repeat(64), add: 0 }] }), /aren't \{ address, add \}/],
    "a release with a field more": [2, (r) => ({ ...r, releases: [{ address: "2".repeat(64), add: 1, n: 1 }] }), /aren't \{ address, add \}/],
    "releases that aren't a list": [2, (r) => ({ ...r, releases: { address: "2".repeat(64), add: 1 } }), /aren't a list/],
    "65 adds": [2, (r) => ({ ...r, adds: Array.from({ length: 65 }, (_, i) => i.toString(16).padStart(64, "0")) }), /more adds/],
    "65 releases": [2, (r) => ({ ...r, releases: Array.from({ length: 65 }, (_, i) => ({ address: i.toString(16).padStart(64, "0"), add: 1 })) }), /more releases/],
    "an add that isn't a reference": [2, (r) => ({ ...r, adds: ["nope"] }), /aren't blob references/],
  };
  const got = {};
  for (const [name, [k, change, why]] of Object.entries(cases)) {
    const r = await haltOf(P, rows, k, change);
    got[name] = r.verdict === "halt" && r.seq === rows[k].seq && why.test(r.why) && r.opened.length === k && r.state.seq === rows[k - 1].seq ? "ok" : r;
  }
  ok(Object.values(got).every((x) => x === "ok"), "V2: a changed envelope (or not base64), an unknown head, another chain generation, an unknown or other signer, a changed signature, adds, releases, dseq or sync device, no signature, a reference named twice, 65 of them, one that isn't a reference: each halts at that row (a SealedHalt, never another error), with its check named, the state where it was", got);
  // (a row out of its device's order: the same op again, later in the log)
  const replayed = [...rows, { ...rows[2], seq: 5 }];
  const rr = await read(P, replayed);
  ok(rr.verdict === "halt" && rr.seq === 5 && /dseq not past/.test(rr.why), "V2: a device's op served again later: halted, its dseq not past its device's last", rr.why);
  // (a row dropped from the middle: the next of that device names it as the envelope before it, so it doesn't open)
  const dropped = rows.filter((_, i) => i !== 0).map((r, i) => ({ ...r, seq: i + 1 }));
  const rd = await read(P, dropped);
  ok(rd.verdict === "halt" && rd.seq === 2 && /doesn't open/.test(rd.why), "V2: a device's op withheld from the middle: its next op doesn't open (it names the withheld one)", rd.why);
}

// ---- V3: the floor, and a removal: R-1, R, R+1
{
  const C = await chainOf();
  const a = await C.device(), b = await C.device(), c = await C.device();
  // (a signs at R-1; then a is removed: R; c signs at R, b at R+1)
  const rows = await logOf(C, { a, b, c }, [{ dev: "a" }, { dev: "c", then: (C) => C.remove(a.id) }, { dev: "b", then: (C) => C.move() }]);
  const R = C.devices.get(a.id).removed;
  const P = C.provider(b);
  const honest = await read(P, rows);
  ok(honest.verdict === "ok" && rows[0].head === C.heads[R - 1 - C.base] && rows[1].head === C.heads[R - C.base] && rows[2].head === C.heads[R + 1 - C.base],
    "V3: a's op authorized at R-1 (before its removal) verifies, then c's at R and b's at R+1: old history of a removed device replays", { R, heads: rows.map((r) => r.head.slice(0, 6)) });
  // (a's op served at R (its removal): a wasn't current there; at R+1 too)
  const atR = await haltOf(P, rows, 1, (r) => ({ ...r, signer: a.id }));
  ok(atR.verdict === "halt" && /wasn't a current device/.test(atR.why), "V3: an op by the removed device at R: halted, not a current device there", atR.why);
  // (b's op at R+1 first, then c's at R: the floor refuses the backward head, each device's own chain intact)
  const back = [rows[0], { ...rows[2], seq: 2 }, { ...rows[1], seq: 3 }];
  const rb = await read(P, back);
  ok(rb.verdict === "halt" && rb.seq === 3 && /before one the log has already passed/.test(rb.why), "V3: an op at R after one at R+1: halted by the floor", rb.why);
  ok(honest.state.floor === R + 1 && honest.state.floor > C.base, "V3: the floor is the absolute position (base + index), past the base", { floor: honest.state.floor, base: C.base });
}

// ---- V3b: a device signing at a head from before it was added (current now, not then): halted
{
  const C = await chainOf();
  const a = await C.device();
  const h0 = C.heads[0];
  const b = await C.device(); // (added at the next head)
  // (b seals and signs honestly, but with a view of the chain from before its addition: its op authorized at h0)
  const P0 = C.provider(b, 1);
  const [early] = await K.sealOps(P0, SYNC_GEN, "sync-dev-b", [opOf(1, 0)], null);
  const row = { seq: 1, device: "sync-dev-b", dseq: 1, env: early.env, head: early.head, chain_gen: early.chainGen, adds: early.adds, releases: early.releases, signer: early.signer, sig: early.sig };
  const r = await read(C.provider(a), [row]);
  ok(early.head === h0 && r.verdict === "halt" && /wasn't a current device/.test(r.why), "V3b: an op signed at a head from before its signer was added (a current device now): halted, not a current device there", r.why);
}

// ---- V4: a compacted chain (base > 0), a head before its anchor, and a head newer than the reader's view
{
  const C = await chainOf(40);
  const a = await C.device(), b = await C.device();
  const rows = await logOf(C, { a, b }, [{ dev: "a" }, { dev: "b", then: (C) => C.move() }]);
  const r = await read(C.provider(a), rows);
  ok(r.verdict === "ok" && r.state.floor === 40 + C.heads.length - 1, "V4: a compacted chain (base 40): positions absolute, the log verifies", r.state);
  const old = await haltOf(C.provider(a), rows, 1, (x) => ({ ...x, head: b64u(rand32()) }));
  ok(old.verdict === "halt" && /doesn't hold/.test(old.why), "V4: a head the anchored chain doesn't hold (before its anchor, or foreign): unknown, halted, never ordered", old.why);
  const behind = C.provider(a, 1);
  const rv = await read(behind, rows);
  ok(rv.verdict === "ok" && behind.refreshes >= 1, "V4: a head newer than the reader's view: the chain read again once, then the log verifies", { refreshes: behind.refreshes });
}

// ---- V5: the per-device chain: null only for a device's first accepted envelope, across a refusal gap
{
  const C = await chainOf();
  const a = await C.device();
  const rows = await logOf(C, { a }, [{ dev: "a" }, { dev: "a", gap: 1 }]);
  const r = await read(C.provider(a), rows);
  ok(r.verdict === "ok" && rows[1].dseq === rows[0].dseq + 2, "V5: a gap where a refusal was (dseq 1, then 3): the second names the first, and verifies");
  // (the second sealed as a first (prev null), signed honestly: it doesn't open where a previous envelope is known)
  const P = C.provider(a);
  const [lone] = await K.sealOps(P, SYNC_GEN, "sync-dev-a", [opOf(3, 9)], null);
  const forged = [rows[0], { ...rows[1], env: lone.env, sig: lone.sig, adds: lone.adds, releases: lone.releases }];
  const rf = await read(P, forged);
  ok(rf.verdict === "halt" && rf.seq === 2 && /doesn't open/.test(rf.why), "V5: a second null genesis (after the device's first): halted, it doesn't open", rf.why);
}

// ---- V6: the epoch: sealed under another epoch than its head's; and visible references that aren't the op's
{
  const C = await chainOf();
  const a = await C.device();
  const rows = await logOf(C, { a }, [{ dev: "a", file: true }]);
  const P = C.provider(a);
  // (sealed under epoch 2's keys while the chain says epoch 1 at that head; signed honestly)
  const op = opOf(1, 0, true);
  const env2 = await sealIndexOp(C.keys[2], { device: "sync-dev-a", dseq: 1 }, op, { prev: null, adds: rows[0].adds, releases: [] });
  const ctx = { account: C.account, syncGeneration: SYNC_GEN, chainGeneration: C.generation, head: rows[0].head, device: "sync-dev-a", dseq: 1, adds: rows[0].adds, releases: [], signer: a.id };
  const sig2 = await signIndexOp(a, ctx, env2);
  const re = await read(P, [{ ...rows[0], env: Buffer.from(env2).toString("base64"), sig: sig2 }]);
  ok(re.verdict === "halt" && /another epoch/.test(re.why), "V6: an op sealed under another epoch than its head's: halted", re.why);
  // (a file op sealed declaring no add, signed honestly: its visible references aren't its op's)
  const envN = await sealIndexOp(C.keys[1], { device: "sync-dev-a", dseq: 1 }, op, { prev: null, adds: [], releases: [] });
  const sigN = await signIndexOp(a, { ...ctx, adds: [] }, envN);
  const rn = await read(P, [{ ...rows[0], env: Buffer.from(envN).toString("base64"), sig: sigN, adds: [] }]);
  ok(rn.verdict === "halt" && /references that aren't its op's/.test(rn.why), "V6: a file op whose visible adds aren't its own (refsOf): halted", rn.why);
  // (e2e PR 3b-2: a file op whose add is its plaintext SHA-256, sealed and signed honestly as before keyed addresses:
  // its add isn't its blob's address under its epoch, and it halts; and one whose sealed op names an address itself)
  const envP = await sealIndexOp(C.keys[1], { device: "sync-dev-a", dseq: 1 }, op, { prev: null, adds: [op.sha256], releases: [] });
  const sigP = await signIndexOp(a, { ...ctx, adds: [op.sha256] }, envP);
  const rp = await read(P, [{ ...rows[0], env: Buffer.from(envP).toString("base64"), sig: sigP, adds: [op.sha256] }]);
  ok(rp.verdict === "halt" && /references that aren't its op's/.test(rp.why), "V6: a file op whose visible add is its plaintext SHA-256 (not its keyed address): halted", rp.why);
  const named = { ...op, address: rows[0].adds[0], addressEpoch: 1 };
  const envA = await sealIndexOp(C.keys[1], { device: "sync-dev-a", dseq: 1 }, named, { prev: null, adds: rows[0].adds, releases: [] });
  const sigA = await signIndexOp(a, ctx, envA);
  const ra = await read(P, [{ ...rows[0], env: Buffer.from(envA).toString("base64"), sig: sigA }]);
  ok(ra.verdict === "halt" && /names its own address/.test(ra.why), "V6: a sealed op that carries an address field of its own: halted (an address is derived, never taken from an envelope)", ra.why);
  const other = await read(P, [{ ...rows[0] }]);
  ok(other.verdict === "ok", "V6: (the control: the honest row verifies)", other.why);
}

// ---- V8: a chain reset (recovery): a new generation, positions going on from the old; the new chain's ops verify, and
// an op at a head of the old generation (absent from the anchored suffix) halts, never ordered
{
  const C = await chainOf(3);
  const a = await C.device();
  const old = await logOf(C, { a }, [{ dev: "a" }]);
  // (the reset: the recovering device alone, a new generation, the anchor at the next position)
  const nextBase = C.top() + 1;
  const R2 = await chainOf(nextBase);
  const b = await R2.device();
  const rows = await logOf(R2, { b }, [{ dev: "b" }, { dev: "b", then: (C) => C.move() }]);
  const r = await read(R2.provider(b), rows);
  ok(r.verdict === "ok" && r.state.floor === nextBase + 1 && r.state.floor > C.top(), "V8: after a reset, the new generation's ops verify, positions going on from the old chain's", { floor: r.state.floor, oldTop: C.top() });
  const mixed = [...rows, { ...old[0], seq: 3, device: "sync-dev-x" }];
  const rm = await read(R2.provider(b), mixed);
  ok(rm.verdict === "halt" && rm.seq === 3 && /doesn't hold/.test(rm.why), "V8: an op of the old generation after the reset: its head isn't in the anchored chain: halted", rm.why);
}

// ---- V7: the fuzz: the same log and the same chain, read by two devices in different pages with different refresh
// timing (each starting with a view of a different number of heads): the same verdict, stop and state, every round
const ROUNDS = Number(process.env.FUZZ_ROUNDS ?? 40);
{
  const kinds = ["env", "head", "signer", "sig", "adds", "dseq", "drop", "dup", "back", "none"];
  let agreed = 0, halted = 0, mismatched = [];
  for (let round = 0; round < ROUNDS; round++) {
    const R = rng(1000 + round);
    const C = await chainOf(Math.floor(R() * 20));
    const devs = { a: await C.device(), b: await C.device(), c: await C.device() };
    const n = 4 + Math.floor(R() * 8);
    const plan = Array.from({ length: n }, () => ({ dev: "abc"[Math.floor(R() * 3)], file: R() < 0.5, ...(R() < 0.25 ? { then: (C) => C.move() } : {}) }));
    let rows = await logOf(C, devs, plan);
    const kind = kinds[Math.floor(R() * kinds.length)], k = Math.floor(R() * rows.length);
    const t = rows.map((r) => ({ ...r }));
    if (kind === "env") t[k].env = t[k].env.slice(0, 12) + (t[k].env[12] === "A" ? "B" : "A") + t[k].env.slice(13);
    if (kind === "head") t[k].head = b64u(rand32());
    if (kind === "signer") t[k].signer = e2eId();
    if (kind === "sig") t[k].sig = b64u(rand32()) + b64u(rand32()).slice(0, 43);
    if (kind === "adds") t[k].adds = ["0".repeat(64)];
    if (kind === "dseq") t[k].dseq += 5;
    rows = kind === "drop" && rows.length > 1 ? t.filter((_, i) => i !== k).map((r, i) => ({ ...r, seq: i + 1 }))
      : kind === "dup" ? [...t, { ...t[k], seq: t.length + 1 }]
      : kind === "back" && k > 0 ? [...t.slice(0, k - 1), { ...t[k], seq: k }, { ...t[k - 1], seq: k + 1 }, ...t.slice(k + 1)]
      : t;
    const split = () => { const p = []; let left = rows.length; while (left > 0) { const m = 1 + Math.floor(R() * Math.max(1, left)); p.push(m); left -= m; } return p; };
    const one = await read(C.provider(devs.a, 1 + Math.floor(R() * C.heads.length)), rows, split());
    const two = await read(C.provider(devs.b, 1 + Math.floor(R() * C.heads.length)), rows, split());
    const same = one.verdict === two.verdict && one.seq === two.seq && J(one.state) === J(two.state) && J(one.opened) === J(two.opened);
    if (same) agreed++;
    else mismatched.push({ round, kind, one: [one.verdict, one.seq], two: [two.verdict, two.seq] });
    if (one.verdict === "halt") halted++;
    if (kind === "none" && one.verdict !== "ok") mismatched.push({ round, kind, honestHalted: one.why });
  }
  ok(agreed === ROUNDS && mismatched.length === 0, `V7: ${ROUNDS} random logs (three devices, head moves, one tamper of nine kinds or none), each read by two devices in different pages with different views of the chain: the same verdict, stop, state and opened ops every time (${halted} halted)`, mismatched.slice(0, 3));
}

// ---- V9 (document key declarations; design notes e2e-doc-key-declarations r2): exactly its form; a keyEpoch newer
// than its head's halts; one of its head's epoch is eligible only if its wrap opens there (its own account, document,
// cekId and epoch, whole); an older one is never unwrapped and never eligible, and never halts; the verdict goes with
// the op, never in it, and is the same each time the row is verified
{
  const { mintDocCek } = await import(join(here, "e2e", "doc-cek.ts"));
  const C = await chainOf();
  const a = await C.device();
  const DOC = "0123456789ab", CEK = "ab".repeat(16);
  const wrapFor = async (place, keys) => b64u((await mintDocCek(keys ?? C.keys[place.keyEpoch], place)).wrapped);
  const home = { account: C.account, document: DOC, cekId: CEK, keyEpoch: 1 };
  const D = async (extra = {}, place = home, keys) => ({ t: 1, by: "person", op: "doc-key", path: "/", kind: "folder", document: DOC, cekId: CEK, keyEpoch: 1, wrappedCek: await wrapFor(place, keys), ...extra });
  // (each case's row verified alone, after one ordinary op of the device: its verdict, or its halt)
  const one = async (op, opts = {}) => {
    const rows = await logOf(C, { a }, [{ dev: "a" }, { dev: "a", op, ...(opts.then ? { then: opts.then } : {}) }]);
    const P = opts.P ?? C.provider(a);
    let st = K.PULL_START;
    try {
      st = (await K.verifyRow(P, SYNC_GEN, wire(rows[0]), st)).state;
      const v = await K.verifyRow(P, SYNC_GEN, wire(rows[1]), st);
      return { verdict: "ok", docKey: v.docKey, op: v.op, row: rows[1], st };
    } catch (e) {
      if (!(e instanceof K.SealedHalt)) throw e;
      return { verdict: "halt", why: e.why };
    }
  };
  const good = await one(await D());
  ok(good.verdict === "ok" && good.docKey?.eligible === true && good.docKey.head === good.row.head && !("eligible" in good.op) && good.op.op === "doc-key",
    "V9: a declaration of its head's epoch whose wrap opens: eligible, with its envelope's head; the verdict beside the op, not in it", { verdict: good.verdict, docKey: good.docKey });
  // (E1: verified again from the same state, as a resumed pull or a page read again does: the same verdict, from the bytes)
  const again = await K.verifyRow(C.provider(a), SYNC_GEN, wire(good.row), good.st);
  ok(again.docKey?.eligible === true && again.docKey.head === good.docKey.head, "V9: the same row verified again (a resumed pull): the same verdict, computed again", again.docKey);
  // (C1, D2: a wrap that doesn't open here: another document, cekId, account or epoch in its place, another account's or
  // epoch's keys, a byte flipped: ineligible, never a halt)
  const other = await deriveEpochKeys(rand32(), "e2e-" + e2eId(), 1);
  const otherAcct = { ...home, account: "e2e-" + e2eId() };
  // (a wrap made by hand under this epoch's own K_wrap, with doc-cek's AAD layout written out over `place`: what a device
  // holding the key could make for any place)
  const { LABELS } = await import(join(here, "e2e", "labels.ts"));
  const BY = await import(join(here, "e2e", "bytes.ts"));
  const forge = async (place) => {
    const aad = BY.concat(BY.utf8(LABELS.docCekWrap), BY.name(place.account, "a"), BY.name(place.document, "d"), BY.name(place.cekId, "c"), BY.u64(place.keyEpoch));
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: aad }, C.keys[1].wrap, rand32()));
    return b64u(BY.concat(nonce, ct));
  };
  ok((await one({ ...(await D()), wrappedCek: await forge(home) })).docKey?.eligible === true, "V9: (the hand-made wrap, for its own place, is eligible: the forge is doc-cek's layout)");
  const flipped = async () => { const w = Buffer.from(await wrapFor(home), "base64url"); w[30] ^= 1; return b64u(w); };
  const bad = {
    "another document's wrap": await D({}, { ...home, document: "ba9876543210" }),
    "another cekId's wrap": await D({}, { ...home, cekId: "cd".repeat(16) }),
    "another account's wrap": await D({}, otherAcct, await deriveEpochKeys(rand32(), otherAcct.account, 1)),
    "another account's keys, this place": { ...(await D()), wrappedCek: b64u((await mintDocCek(other, { ...home, account: (await import(join(here, "e2e", "keys.ts"))).mintedEpoch(other).account })).wrapped) },
    "another epoch's wrap": await D({}, { ...home, keyEpoch: 2 }),
    "a flipped byte": { ...(await D()), wrappedCek: await flipped() },
    // (C1: under this account's own epoch key, so only the AAD differs: one naming another account, one another cekId)
    "this key, an AAD naming another account": { ...(await D()), wrappedCek: await forge({ ...home, account: "e2e-" + e2eId() }) },
    "this key, an AAD naming another cekId": { ...(await D()), wrappedCek: await forge({ ...home, cekId: "ef".repeat(16) }) },
  };
  const ineligible = {};
  for (const [name, op] of Object.entries(bad)) {
    const r = await one(op);
    ineligible[name] = r.verdict === "ok" && r.docKey?.eligible === false ? "ineligible" : r;
  }
  ok(Object.values(ineligible).every((x) => x === "ineligible"), "V9: a wrap for another document, cekId, account or epoch, made with another account's keys, or with a byte flipped: ineligible, not a halt", ineligible);
  // (D1: a keyEpoch newer than its head's: halts)
  const future = await one(await D({ keyEpoch: 2 }, { ...home, keyEpoch: 2 }));
  ok(future.verdict === "halt" && /epoch its head doesn't have/.test(future.why), "V9: a declaration under an epoch newer than its head's halts", future);
  // (E1: an older keyEpoch (sealed under a head of epoch 2): never unwrapped, never eligible, never a halt, even on a
  // device that doesn't hold epoch 1's keys any more)
  const old = await D();
  const C2 = await chainOf();
  const a2 = await C2.device();
  C2.epoch(2);
  const asked = [];
  const P2 = Object.assign(C2.provider(a2), { epochKeys: async (n) => { asked.push(n); return n === 1 ? null : C2.keys[n]; } });
  const rows2 = await logOf(C2, { a: a2 }, [{ dev: "a", op: { ...old, wrappedCek: b64u((await mintDocCek(C2.keys[1], { ...home, account: C2.account })).wrapped) } }]);
  let older;
  try {
    const v = await K.verifyRow(P2, SYNC_GEN, wire(rows2[0]), K.PULL_START);
    older = { verdict: "ok", docKey: v.docKey };
  } catch (e) {
    older = { verdict: "halt", why: e.why };
  }
  ok(older.verdict === "ok" && older.docKey?.eligible === false && !asked.includes(1), "V9: a declaration of an older epoch than its head's: not a halt, never eligible, its epoch's keys never asked for (unwrapped only under the head's epoch)", { older, asked });
  // (an older declaration crafted to open under the head's own key: keyEpoch 1, wrapped under epoch 2's K_wrap with an AAD
  // naming epoch 1. Still never unwrapped, never eligible: only a declaration of its head's epoch is)
  const crafted = async () => {
    const aad = BY.concat(BY.utf8(LABELS.docCekWrap), BY.name(C2.account, "a"), BY.name(DOC, "d"), BY.name(CEK, "c"), BY.u64(1));
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    return b64u(BY.concat(nonce, new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: aad }, C2.keys[2].wrap, rand32()))));
  };
  const rows3 = await logOf(C2, { a: a2 }, [{ dev: "a", op: { ...old, wrappedCek: await crafted() } }]);
  const v3 = await K.verifyRow(C2.provider(a2), SYNC_GEN, wire(rows3[0]), K.PULL_START).catch((e) => ({ halt: e.why }));
  ok(v3.docKey?.eligible === false, "V9: an older declaration crafted to open under the head's own epoch key (its AAD naming its own older epoch): not eligible, void", v3.docKey ?? v3);
  // (and doc-cek's own guard, the second line: that crafted wrap, offered to unwrapDocCek with the head epoch's keys for
  // its older epoch's place, is refused before any decryption: keys open only their own epoch's places)
  const { unwrapDocCek } = await import(join(here, "e2e", "doc-cek.ts"));
  const guard = await unwrapDocCek(C2.keys[2], { ...home, account: C2.account, keyEpoch: 1 }, Buffer.from(await crafted(), "base64url")).then(() => "opened", (e) => e?.code ?? String(e));
  ok(guard === "bad_form", "V9: unwrapDocCek refuses an epoch's keys for another epoch's place, even for a wrap made to open there", guard);
  // (C2 and the form: an `eligible` the op claims, an inner head, a field missing, a cekId or document that isn't one, a
  // wrap of the wrong length: each halts)
  const forms = {
    "an eligible it claims": await D({ eligible: true }),
    "an inner head": await D({ head: good.row.head }),
    "no cekId": (({ cekId, ...rest }) => rest)(await D()),
    "a cekId that isn't 32 hex": await D({ cekId: "AB".repeat(16) }),
    "a document that isn't a document id": await D({ document: "/a/path" }),
    "a wrap of 59 bytes": await D({ wrappedCek: b64u(new Uint8Array(59)) }),
    "a keyEpoch that isn't a number": await D({ keyEpoch: "1" }),
    "another path": await D({ path: "/x" }),
  };
  const halts = {};
  for (const [name, op] of Object.entries(forms)) {
    const r = await one(op);
    halts[name] = r.verdict === "halt" && /only a declaration/.test(r.why) ? "halt" : r;
  }
  ok(Object.values(halts).every((x) => x === "halt"), "V9: a declaration claiming eligible, with an inner head, a field missing, a cekId, document, wrap or keyEpoch that isn't one, or another path: halts at it", halts);
}

console.log(failures ? `${failures} of ${count} FAILED` : `all ${count} passed`);
process.exit(failures ? 1 : 0);
