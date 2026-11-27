// ci: web-sync.1 order=105 runner=bun
// The reference server's sealed ops with keyed releases (design/e2e-encryption.md §4.1): a release names the add it
// ends, { address, add }, the seq of the accepted op whose adds named it. Its bookkeeping matches the server's
// (web/sync/account.ts index_refs): a release must name a live add of that address and ends it once; it gives no
// shared reference back (every blob an op names is held until the account is purged).
//   bun web/sync-protocol/test-reference-sealed.mjs
import { ReferenceServer } from "./reference-server.ts";
import { sealedOpMessage } from "../workspace/e2e/sealed-op.mjs";
import { e2eCore } from "../workspace/e2e/core-ready.ts";

e2eCore();
let failures = 0, count = 0;
function ok(cond, what) {
  count++;
  console.log((cond ? "ok   " : "FAIL ") + what);
  if (!cond) failures++;
}

const pair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
const b64 = (b) => Buffer.from(b).toString("base64url");
const signer = "a".repeat(26), device = "b".repeat(16), account = "ref-sealed-account";
const head = b64(new Uint8Array(32).fill(3)), generation = b64(new Uint8Array(32).fill(4));
const x = "d".repeat(64), y = "e".repeat(64);
const a = {
  state: "active", generation: 1,
  chain: { account, head, generation, signers: new Map([[signer, raw]]) },
  devices: new Map([[device, { next_dseq: 1, answers: new Map(), refused: 0 }]]),
  blobs: new Map([[x, new Uint8Array([9])], [y, new Uint8Array([8])]]),
  refs: new Map(), indexRefs: new Map(), ops: [], sealed: 0,
};
const s = new ReferenceServer();
async function op(dseq, adds, releases) {
  const env = new Uint8Array([dseq]);
  const msg = await sealedOpMessage({ account, syncGeneration: 1, chainGeneration: generation, head, device, dseq, env, adds, releases, signer });
  const sig = b64(new Uint8Array(await crypto.subtle.sign("Ed25519", pair.privateKey, msg)));
  return { dseq, head, chain_gen: generation, env: Buffer.from(env).toString("base64"), adds, releases, signer, sig };
}
const send = async (o) => (await s.sealedOps(a, device, [o]))[0];
const live = (addr, add) => a.indexRefs.get(`${addr}:${add}`) === null;

// two adds of x (seqs 1 and 2) and one of y (seq 3)
const a1 = await send(await op(1, [x], [])), a2 = await send(await op(2, [x], [])), a3 = await send(await op(3, [y], []));
ok(a1?.seq === 1 && a2?.seq === 2 && a3?.seq === 3 && a.refs.get(x) === 2 && live(x, 1) && live(x, 2) && live(y, 3), "(x added twice, y once: three live adds, x's shared count 2)");

// a release naming another add of the address: refused, and nothing changes
const wrong = await send(await op(4, [], [{ address: x, add: 3 }]));
ok(wrong?.code === "invalid" && live(x, 1) && live(x, 2) && live(y, 3) && a.refs.get(x) === 2, "a release naming an add that isn't x's (seq 3 added y): refused invalid, nothing changes: " + JSON.stringify(wrong));
const never = await send(await op(5, [], [{ address: x, add: 99 }]));
ok(never?.code === "invalid", "a release naming an add seq no op has: refused invalid");

// the valid twin: a correctly keyed release is accepted, ends that add once, and gives no shared reference back
const r1 = await send(await op(6, [], [{ address: x, add: 1 }]));
ok(Number.isInteger(r1?.seq) && a.indexRefs.get(`${x}:1`) === r1.seq && live(x, 2) && a.refs.get(x) === 2,
  "a release of x's add 1: accepted, that add ended by it, x's add 2 still live, the shared count kept at 2 (held until purged): " + JSON.stringify({ r1, refs: a.refs.get(x) }));

// the same add again: already released, refused
const again = await send(await op(7, [], [{ address: x, add: 1 }]));
ok(again?.code === "invalid" && a.indexRefs.get(`${x}:1`) === r1.seq, "releasing x's add 1 again (already released): refused invalid, its release unchanged: " + JSON.stringify(again));

// and the other add, released once, then the address has no live add left
const r2 = await send(await op(8, [], [{ address: x, add: 2 }]));
ok(Number.isInteger(r2?.seq) && !live(x, 1) && !live(x, 2) && live(y, 3), "x's add 2 released: both of x's adds ended, y's untouched");

console.log(failures ? `${failures} of ${count} FAILED` : `all ${count} passed`);
process.exit(failures ? 1 : 0);
