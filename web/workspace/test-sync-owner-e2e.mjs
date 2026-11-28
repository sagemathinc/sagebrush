// ci: web-sync.5 order=21 chrome
// The sync owner's start, end to end or not (web/workspace/sync-owner.ts with sync-e2e.ts; plan notes
// m1-page-keys-plan M1d), in headless Chromium with a real Workspace in IndexedDB, sync on here and the session the
// namespace's account (through the owner's fetch):
//   - the E2E routes off (404, asked through the owner's own fetch and origin): a plain client, as before;
//   - a chain and no device here (the real chunk path: sagebrush-e2e.js fetched, its DeviceKeys.load giving none): no
//     client, and the reason shown, never plain; a chain and a device: a client with the device's keys and kit;
//   - a refused chain (forked): no client, the reason, and no try again; an unreadable one: no client, tried again;
//   - a decision that hangs: given up after the owner's wait, no client, tried again.
//   CHROME=google-chrome node web/workspace/test-sync-owner-e2e.mjs
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { browser } from "../agents/a14-cases.mjs";

const here = dirname(fileURLToPath(import.meta.url));
let failures = 0, count = 0;
const ok = (c, msg, detail) => { count++; console.log((c ? "ok   " : "FAIL ") + msg + (!c && detail !== undefined ? "  " + JSON.stringify(detail).slice(0, 600) : "")); if (!c) failures++; };
const J = JSON.stringify;

// ---- the page: the owner, the workspace, and the E2E reasons
const dir = mkdtempSync(join(tmpdir(), "sb-owner-e2e-"));
const entry = join(dir, "entry.ts");
writeFileSync(entry, [
  `export { SyncOwner } from ${J(join(here, "sync-owner.ts"))};`,
  `export { Workspace } from ${J(join(here, "api.ts"))};`,
  `export * as S from ${J(join(here, "sync-e2e.ts"))};`,
  `export { accountHash } from ${J(join(here, "..", "sync-protocol", "protocol.ts"))};`,
].join("\n"));
const js = execFileSync("bun", ["build", entry, "--format", "esm", "--target", "browser"], { encoding: "utf8", maxBuffer: 64 << 20 });
rmSync(dir, { recursive: true, force: true });
// (the E2E chunk as the site serves it, here a fake whose DeviceKeys.load gives what the page set)
const chunk = `export const DeviceKeys = { load: async () => window.chunkKeys ?? null };
export const sealOps = () => {}, sopsItem = () => {}, envHashOf = () => {}, verifyRow = () => {}, PULL_START = 1;
export class SealedHalt extends Error {}
window.chunkLoads = (window.chunkLoads ?? 0) + 1;`;
const ACCOUNT = "0e2e0e2e-0001-4e2e-8e2e-e2e2e2e2e201";
const html = `<!doctype html><script type="module">import * as m from "/s.js"; Object.assign(window, m);
// (the owner's fetch: the session is the namespace's account; the E2E chain read as the case gives it; anything else
// (the client's own requests) never answered, so a client started stays running)
window.asked = [];
window.chain = { status: 404, body: {} };
window.fetchFake = async (url, init) => {
  const p = new URL(url).pathname + new URL(url).search;
  window.asked.push(String(url));
  if (p === "/api/share/me") return new Response(JSON.stringify({ account_id: ${J(ACCOUNT)} }), { status: 200 });
  if (p === "/api/sync/v1/e2e/chain?from=0") return new Response(JSON.stringify(window.chain.body), { status: window.chain.status });
  return new Promise(() => {});
};
// (a clock whose waits fire only when the case says)
window.clock = { waits: [], now: () => Date.now(), after(ms, f) { const w = { ms, f, live: true }; this.waits.push(w); return () => { w.live = false; }; } };
window.fire = (ms) => { let n = 0; for (const w of clock.waits) if (w.live && w.ms === ms) { w.live = false; n++; w.f(); } return n; };
let n = 0;
/** A workspace with sync on here for the account, and its owner started with the options given; once its first
 * reconcile ends: whether a client runs, the client's E2E options, and the owner's own snapshot. */
window.owned = async (opts = {}) => {
  const w = await Workspace.open({ name: "oe-" + ++n, mainName: "oem-" + n });
  const ns = (await accountHash(${J(ACCOUNT)})) + ":main";
  await new Promise((res, rej) => { const tx = w.ws.transaction("meta", "readwrite"); tx.objectStore("meta").put({ ns }, "sync:current"); tx.objectStore("meta").put(1, "sync:epoch"); tx.objectStore("meta").put(2, "sync:proto"); tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
  const o = SyncOwner.of(w, { origin: location.origin, fetch: fetchFake, clock, ...opts });
  window.o = o;
  o.start();
  // (the start's own reconcile, not another pass)
  await o.reconciling;
  return window.state();
};
window.state = () => ({ client: !!o.client, e2e: o.client?.opts?.e2e ?? null, own: o.own, retries: o.stats.retries, waiting: clock.waits.filter((w) => w.live).map((w) => w.ms) });
window.ready = true;</script>`;
const server = createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/s.js") return res.writeHead(200, { "content-type": "text/javascript" }).end(js);
  if (u.pathname === "/sagebrush-e2e.js") return res.writeHead(200, { "content-type": "text/javascript" }).end(chunk);
  if (u.pathname === "/") return res.writeHead(200, { "content-type": "text/html" }).end(html);
  res.writeHead(404).end();
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;

const B = await browser();
try {
  const P = await B.tab();
  const load = async () => {
    const n = P.loads;
    await P.send("Page.navigate", { url: ORIGIN + "/" });
    for (const t = Date.now(); P.loads === n && Date.now() - t < 10000; ) await new Promise((r) => setTimeout(r, 50));
    await P.until(`window.ready === true`, 10000);
  };
  await load();
  const S = await P.ev(`({ NO_DEVICE: S.NO_DEVICE, FORKED: S.FORKED, UNREADABLE: S.UNREADABLE })`);

  // ---- the routes off: plain, asked through the owner's fetch and origin; the chunk never fetched
  {
    const r = await P.ev(`(async () => { const s = await owned(); return { ...s, asked: asked.filter((u) => u.includes("/e2e/")), loads: window.chunkLoads ?? 0 }; })()`);
    ok(r.client && r.e2e === null && J(r.asked) === J([ORIGIN + "/api/sync/v1/e2e/chain?from=0"]) && r.loads === 0,
      "the E2E routes off (404, read through the owner's fetch at its origin): a plain client, as before, and the E2E chunk not fetched", r);
  }

  // ---- a chain and no device here, through the real chunk path: no client, the reason, no try again
  {
    await load();
    const r = await P.ev(`(async () => { chain = { status: 200, body: { entries: ["genesis"] } }; return { ...(await owned()), loads: window.chunkLoads ?? 0 }; })()`);
    ok(!r.client && r.own.state === "off" && r.own.reason === S.NO_DEVICE && r.loads === 1 && r.waiting.length === 0,
      "a chain and no device in this browser (the chunk fetched, its load giving none): no client, never plain, and the reason shown; no try again", r);
  }

  // ---- a chain and a device: a client with the device's keys and the whole kit
  {
    await load();
    const r = await P.ev(`(async () => { chain = { status: 200, body: { entries: ["genesis"] } }; window.chunkKeys = { account: "a", device: { id: "d", sign: async () => new Uint8Array(64) }, recoveryUnconfirmed: false, chain: async () => ({}), epochKeys: async () => null }; const s = await owned(); return { client: s.client, keys: s.e2e?.keys === window.chunkKeys, kit: Object.keys(s.e2e?.kit ?? {}).sort() }; })()`);
    ok(r.client && r.keys && J(r.kit) === J(["PULL_START", "SealedHalt", "envHashOf", "sealOps", "sopsItem", "verifyRow"]),
      "a chain and this browser's device: a client started with the device's keys and the whole sealing kit", r);
  }

  // ---- given decisions: refused (final) and unreadable (tried again)
  {
    await load();
    const f = await P.ev(`owned({ e2eStart: async () => ({ kind: "blocked", reason: S.FORKED, retry: false }) })`);
    ok(!f.client && f.own.reason === S.FORKED && f.waiting.length === 0, "a refused chain (forked): no client, the reason shown, and no try again", f);
    await load();
    const u = await P.ev(`(async () => { let calls = 0; const s = await owned({ e2eStart: async () => (++calls === 1 ? { kind: "blocked", reason: S.UNREADABLE, retry: true } : { kind: "plain" }) }); const waits = s.waiting; fire(waits[0]); for (let i = 0; i < 100 && !o.client; i++) await new Promise((r) => setTimeout(r, 20)); await o.reconciling; return { first: s, waits, then: state(), calls }; })()`);
    ok(!u.first.client && u.first.own.reason === S.UNREADABLE && u.waits.length === 1 && u.then.client && u.calls === 2 && u.then.retries === 1,
      "keys that can't be checked: no client and the reason, then tried again after the owner's wait, and the client starts once they can be", u);
  }

  // ---- a decision that hangs: given up after the owner's wait (askMs), no client, tried again
  {
    await load();
    const r = await P.ev(`(async () => {
      let deciding = false;
      const p = owned({ e2eStart: () => { deciding = true; return new Promise(() => {}); } });
      for (let i = 0; i < 250 && !deciding; i++) await new Promise((r) => setTimeout(r, 20));
      const fired = fire(15000);
      const s = await p;
      return { fired, ...s };
    })()`);
    ok(r.fired >= 1 && !r.client && r.own.reason === S.UNREADABLE && r.waiting.length === 1,
      "a start decision that hangs is given up after the owner's wait: no client, the reason, and a try again waiting", r);
  }
} catch (e) {
  ok(false, "the test ran to its end: " + (e?.stack ?? e));
} finally {
  await B.close?.();
  server.close();
}
console.log(failures ? `${failures} of ${count} FAILED` : `all ${count} passed`);
process.exit(failures ? 1 : 0);
