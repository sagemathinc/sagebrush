// ci: web-sync.1 order=63 runner=bun
// Whether a page's sync starts end to end (web/workspace/sync-e2e.ts; plan notes m1-page-keys-plan M1d), with a fake
// server and a fake E2E chunk: the E2E routes off or an empty chain is plain sync, and the chunk is never fetched; a
// chain with this browser's device is sealed sync with its keys and the whole sealing kit; a chain with no device here,
// or one this device refused, is no sync, with the reason, never plain; and an answer that can't be read is no sync
// for now, tried again.
//   bun web/workspace/test-sync-e2e-start.mjs
import { join } from "node:path";

const here = new URL(".", import.meta.url).pathname;
const S = await import(join(here, "sync-e2e.ts"));
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
const run = (srv, ch) => S.e2eStart(srv.get, ch.load);
const entries = { entries: ["genesis"] };

// ---- plain: the routes off, or no chain; the chunk never fetched
for (const [what, srv] of [["the E2E routes off (404)", server(404, {})], ["an empty chain", server(200, { entries: [] })]]) {
  const ch = chunk({ keys: {} });
  const r = await run(srv, ch);
  ok(r.kind === "plain" && ch.loads === 0 && srv.asked[0] === "/api/sync/v1/e2e/chain?from=0", `${what}: plain sync, and the E2E chunk isn't fetched`, { r, loads: ch.loads });
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
  ["an answer with no entries list", server(200, { entries: "x" }), chunk()],
  ["the chunk doesn't load", server(200, entries), chunk({ fail: true })],
  ["the device's load fails another way", server(200, entries), chunk({ code: "server" })],
]) {
  const r = await run(srv, ch);
  ok(r.kind === "blocked" && r.reason === S.UNREADABLE && r.retry === true, `${what}: no sync for now, tried again (never plain)`, r);
}

console.log(failures ? `${failures} of ${count} FAILED` : `all ${count} passed`);
process.exit(failures ? 1 : 0);
