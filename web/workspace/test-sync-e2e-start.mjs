// ci: web-sync.1 order=63 runner=bun
// Whether a page's sync starts end to end (web/workspace/sync-e2e.ts; plan notes m1-page-keys-plan M1d), with a fake
// server, a fake E2E chunk and this browser's marks in memory: with the account marked as syncing sealed here, the
// server saying there's no chain (404, empty) is no sync, never plain (sec2's H1); with no mark, the E2E routes off or
// an empty chain is plain sync, and the chunk is never fetched; a
// chain with this browser's device is sealed sync with its keys and the whole sealing kit; a chain with no device here,
// or one this device refused, is no sync, with the reason, never plain; and an answer that can't be read is no sync
// for now, tried again.
//   bun web/workspace/test-sync-e2e-start.mjs
import { join } from "node:path";

const here = new URL(".", import.meta.url).pathname;
const S = await import(join(here, "sync-e2e.ts"));
const { e2eAccountOf } = await import(join(here, "e2e-here.ts"));
// (the signed-in account's hash, and the E2E account id the server names for it)
const H = "ab".repeat(32), ACC = e2eAccountOf(H);
let failures = 0, count = 0;
const ok = (c, msg, detail) => { count++; console.log((c ? "ok   " : "FAIL ") + msg + (!c && detail !== undefined ? "  " + JSON.stringify(detail).slice(0, 400) : "")); if (!c) failures++; };

/** A server answering the chain read as given (status, body, or a thrown error). */
const server = (status, body) => {
  const s = { asked: [] };
  s.get = async (path) => {
    s.asked.push(path);
    if (status === "throw") throw new Error("offline");
    return { status, json: async () => (body === "bad" ? Promise.reject(new Error("not json")) : body) };
  };
  return s;
};
/** A chunk whose DeviceKeys.load gives `keys` (or throws `code`); `fail` makes the chunk itself not load. */
const chunk = ({ keys = null, code = null, fail = false } = {}) => {
  const c = { loads: 0 };
  c.load = async () => {
    c.loads++;
    if (fail) throw new Error("chunk");
    const kit = { sealOps() {}, sopsItem() {}, envHashOf() {}, verifyRow() {}, PULL_START: 1, SealedHalt: class {} };
    return { ...kit, DeviceKeys: { load: async () => { if (code) throw Object.assign(new Error(code), { code }); return keys; } } };
  };
  return c;
};
/** This browser's E2E state (a device or a pin), in memory: the account hashes it holds; `fail` makes reading it throw. */
const hereOf = (have = [], fail = false) => ({ sealed: async (h) => { if (fail) throw new Error("idb"); return have.includes(h); } });
const run = (srv, ch, here = hereOf(), contentSealed = true) => S.e2eStart({ hash: H, get: srv.get, chunk: ch.load, here, contentSealed });
const entries = { account: ACC, entries: ["genesis"] };

// ---- plain: the routes off, or no chain; the chunk never fetched
for (const [what, srv] of [["the E2E routes off (404)", server(404, {})], ["an empty chain", server(200, { account: ACC, entries: [] })]]) {
  const ch = chunk({ keys: {} });
  const r = await run(srv, ch);
  ok(r.kind === "plain" && ch.loads === 0 && srv.asked[0] === "/api/sync/v1/e2e/chain?from=0", `${what}: plain sync, and the E2E chunk isn't fetched`, { r, loads: ch.loads });
}

// ---- E2E state for the account in this browser (genesis or a load wrote a device or a pin): the server saying there's no chain is never plain (a downgrade), and the chunk isn't needed
for (const [what, srv] of [["the E2E routes off (404)", server(404, {})], ["an empty chain", server(200, { account: ACC, entries: [] })]]) {
  const ch = chunk({ keys: {} });
  const r = await run(srv, ch, hereOf([H]));
  ok(r.kind === "blocked" && r.reason === S.DOWNGRADED && r.retry === false && ch.loads === 0, `this browser's device or pin for the account, and ${what}: no sync, with the reason, never plain`, r);
}
{
  const other = await run(server(404, {}), chunk(), hereOf(["another account"]));
  ok(other.kind === "plain", "another account's E2E state doesn't block this one: plain on a 404", other);
  const keys = { account: "a", device: { id: "d" }, recoveryUnconfirmed: false };
  const r = await run(server(200, entries), chunk({ keys }), hereOf([H]));
  ok(r.kind === "sealed" && r.e2e.keys === keys, "E2E state here, and a chain with this browser's device: sealed sync, as without the mark", r);
  for (const [what, srv] of [["a 5xx", server(503, {})], ["the chain read throws", server("throw")]]) {
    const u = await run(srv, chunk(), hereOf([H]));
    ok(u.kind === "blocked" && u.reason === S.UNREADABLE && u.retry === true, `E2E state here, and ${what}: no sync for now, tried again`, u);
  }
  const none = await run(server(200, entries), chunk({ keys: null }), hereOf([H]));
  ok(none.kind === "blocked" && none.reason === S.NO_DEVICE, "E2E state here (a pin, the device gone), and a chain: no sync, set it up again", none);
}

// ---- sec2's C1: the chain answer's E2E account must be the one this page derives for the signed-in account
{
  let asked = null;
  const ch = chunk({ keys: { account: ACC, device: { id: "d" }, recoveryUnconfirmed: false } });
  const load = ch.load;
  ch.load = async () => { const m = await load(); return { ...m, DeviceKeys: { load: async (t, expect) => { asked = expect; return m.DeviceKeys.load(); } } }; };
  const other = e2eAccountOf("cd".repeat(32));
  for (const [what, body] of [["a chain", { account: other, entries: ["genesis"] }], ["an empty chain", { account: other, entries: [] }]]) {
    const c2 = chunk({ keys: {} });
    const r = await run(server(200, body), c2);
    ok(r.kind === "blocked" && r.reason === S.WRONG_ACCOUNT && r.retry === false && c2.loads === 0, `${what} naming another E2E account: no sync, final, the chunk not fetched`, r);
  }
  const none = await run(server(200, { entries: ["genesis"] }), chunk());
  ok(none.kind === "blocked" && none.reason === S.UNREADABLE, "a chain answer naming no account: unreadable, tried again", none);
  const r = await run(server(200, entries), ch);
  ok(r.kind === "sealed" && asked === ACC, "the device is loaded with the page's own E2E account id, for the chunk to refuse an answer naming another", { r: r.kind, asked });
  const wa = await run(server(200, entries), chunk({ code: "wrong_account" }));
  ok(wa.kind === "blocked" && wa.reason === S.WRONG_ACCOUNT && wa.retry === false, "the chunk's refusal (wrong_account): no sync, final", wa);
}

// ---- this browser's E2E state unreadable: no sync for now, tried again (never plain on a 404 it can't check)
{
  const ch = chunk();
  const unread = await run(server(404, {}), ch, hereOf([], true));
  ok(unread.kind === "blocked" && unread.reason === S.UNREADABLE && unread.retry === true && ch.loads === 0, "this browser's E2E state unreadable, and a 404: no sync for now, tried again (never plain)", unread);
}

// ---- file contents not sealed yet (CONTENT_SEALED, as shipped): a chain and this browser's device is no sync, with the
// reason, never a client that would send file contents as they are (sec2's H2); the device still loaded, so its fork
// marks apply
{
  ok(S.CONTENT_SEALED === false, "as shipped, the sync client doesn't seal file contents yet (CONTENT_SEALED false)");
  let loaded = 0;
  const ch = chunk({ keys: { account: "a", device: { id: "d" }, recoveryUnconfirmed: false } });
  const load = ch.load;
  ch.load = async () => { const m = await load(); return { ...m, DeviceKeys: { load: async () => { loaded++; return m.DeviceKeys.load(); } } }; };
  const r = await S.e2eStart({ hash: H, get: server(200, entries).get, chunk: ch.load, here: hereOf([H]) });
  ok(r.kind === "blocked" && r.reason === S.CONTENTS_PENDING && r.retry === false && loaded === 1, "as shipped, a chain and this browser's device: no sync (the reason: encrypted file contents not yet), the device loaded and verified", { r, loaded });
  const forked = await S.e2eStart({ hash: H, get: server(200, entries).get, chunk: chunk({ code: "chain_fork" }).load, here: hereOf([H]) });
  ok(forked.kind === "blocked" && forked.reason === S.FORKED, "as shipped, a refused chain still says so (forked), not only that contents aren't sealed", forked);
}

// ---- the account's E2E id, as the page derives it, is the server's (web/sync/e2e-chain.ts)
{
  const { e2eAccount } = await import(join(here, "..", "sync", "e2e-chain.ts"));
  const { e2eAccountOf } = await import(join(here, "e2e-here.ts"));
  const hashes = ["0".repeat(64), "f".repeat(64), ...Array.from({ length: 200 }, () => Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join(""))];
  const bad = hashes.filter((h) => e2eAccountOf(h) !== e2eAccount(h));
  ok(bad.length === 0, "the page's E2E account id for an account hash is the server's, for 202 hashes", bad.slice(0, 3));
}

// ---- sealed: a chain and this browser's device
{
  const keys = { account: "a", device: { id: "d" }, recoveryUnconfirmed: false };
  const r = await run(server(200, entries), chunk({ keys }));
  const kit = r.e2e?.kit ?? {};
  ok(r.kind === "sealed" && r.e2e.keys === keys && ["sealOps", "sopsItem", "envHashOf", "verifyRow", "PULL_START", "SealedHalt"].every((k) => kit[k] !== undefined) && r.recoveryUnconfirmed === false,
    "a chain and this browser's device: sealed sync, with the device's keys and the whole sealing kit", Object.keys(kit));
  const u = await run(server(200, entries), chunk({ keys: { ...keys, recoveryUnconfirmed: true } }));
  ok(u.kind === "sealed" && u.recoveryUnconfirmed === true, "a device whose recovery code may never have been shown says so to the page");
}

// ---- blocked, final: never plain sync into a sealed account
{
  const none = await run(server(200, entries), chunk({ keys: null }));
  ok(none.kind === "blocked" && none.reason === S.NO_DEVICE && none.retry === false, "a chain and no device here: no sync, with the reason to set this browser up (never plain)", none);
  for (const code of ["forked", "chain_fork", "chain_reset", "chain_unanchored"]) {
    const r = await run(server(200, entries), chunk({ code }));
    ok(r.kind === "blocked" && r.reason === S.FORKED && r.retry === false, `this device's chain refused (${code}): no sync, with the reason to reset`, r);
  }
  const nd = await run(server(200, entries), chunk({ code: "no_device" }));
  ok(nd.kind === "blocked" && nd.reason === S.NO_DEVICE && nd.retry === false, "this device no longer in the chain: no sync, set it up again", nd);
}

// ---- blocked for now, tried again: the answer couldn't be read
for (const [what, srv, ch] of [
  ["the chain read throws (offline)", server("throw"), chunk()],
  ["a 5xx", server(503, {}), chunk()],
  ["a 401", server(401, {}), chunk()],
  ["an answer that isn't JSON", server(200, "bad"), chunk()],
  ["an answer with no entries list", server(200, { account: ACC, entries: "x" }), chunk()],
  ["the chunk doesn't load", server(200, entries), chunk({ fail: true })],
  ["the device's load fails another way", server(200, entries), chunk({ code: "server" })],
]) {
  const r = await run(srv, ch);
  ok(r.kind === "blocked" && r.reason === S.UNREADABLE && r.retry === true, `${what}: no sync for now, tried again (never plain)`, r);
}

console.log(failures ? `${failures} of ${count} FAILED` : `all ${count} passed`);
process.exit(failures ? 1 : 0);
