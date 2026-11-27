// ci: web-runner order=355 runner=bun chrome
// The page's one signer (fleet-sign.ts, M4 note r8; app pairing r4 §3 F1 and the signing barrier) in headless Chromium,
// with real WebCrypto and IndexedDB, against a stand-in service that verifies every entry with the fleet core itself:
// F1 end to end (one genesis, inspected apart from the UI, that the core replays), each barrier input changed between
// the review and the click (zero key uses, nothing admitted), one signature per review, the journal's receipts after a
// lost answer or a reload (never a second signature), Start again's refusals, the signing capability, and a fork's
// evidence.
//   CHROME=google-chrome bun web/workspace/test-fleet-sign.mjs
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { browser } from "../agents/a14-cases.mjs";

const here = new URL(".", import.meta.url).pathname;
let failures = 0;
const ok = (c, msg, detail) => { console.log((c ? "ok   " : "FAIL ") + msg + (!c && detail !== undefined ? "  " + JSON.stringify(detail).slice(0, 700) : "")); if (!c) failures++; };

const dir = mkdtempSync(join(tmpdir(), "sb-fleet-sign-"));
const entry = join(dir, "entry.ts");
writeFileSync(entry, [
  `export * as fs from ${JSON.stringify(join(here, "fleet-sign.ts"))};`,
  `export { deviceKey, pin, resetDevice, journalList, journalPut, keyInvocations, signAsDevice, signingMinter, advancePin, forkEvidence, makeDeviceKey } from ${JSON.stringify(join(here, "fleet-device.ts"))};`,
  `export { fleetCore } from ${JSON.stringify(join(here, "fleet", "install.ts"))};`,
].join("\n"));
const built = await Bun.build({ entrypoints: [entry], target: "browser", format: "esm" });
rmSync(dir, { recursive: true, force: true });
if (!built.success) throw new Error("fleet-sign.ts didn't build: " + built.logs.join("\n"));
const js = await built.outputs[0].text();
// (the stand-in service: GET /session, /fleet, /chain and POST /chain, the last verifying the whole chain with the core
//  and the auth time against the session, as the Worker does; `mode` loses or refuses an append on demand)
const page = `<!doctype html><script type="module">
import * as m from "/fs.js"; window.m = m;
const AUD = "https://dev.sagebrush.space";
const S = window.S = { session: { account: "acct1", reauth_ms: Date.now(), fresh_ms: 300000 }, noSession: false, fleet: null, chain: [], mode: "ok", hold: null, appends: [] };
const core = m.fleetCore();
window.svc = {
  aud: AUD,
  async session() { return S.noSession ? null : { ...S.session, now_ms: Date.now() }; },
  async fleet() { return S.fleet; },
  async chain() { return [...S.chain]; },
  async append(text) {
    S.appends.push(text);
    if (S.hold) await S.hold;
    if (S.mode.startsWith("refuse:")) return { refused: S.mode.slice(7) };
    if (S.mode === "lost-before") throw new Error("lost");
    const body = JSON.parse(text).body;
    if (S.session.reauth_ms === null || Date.now() - body.auth_time_ms > 300000 || body.auth_time_ms > S.session.reauth_ms) return { refused: "stale_auth" };
    if (S.fleet && S.fleet.fleet !== body.fleet) return { refused: "exists" };
    const enc = (t) => new TextEncoder().encode(t);
    await core.replayChain([...S.chain, text].map(enc), { aud: AUD, fleet: body.fleet });
    S.chain.push(text);
    S.fleet = { fleet: body.fleet, aud: AUD };
    if (S.mode === "lost-after") throw new Error("lost");
    return { seq: S.chain.length - 1 };
  },
};
window.code = async (p) => { try { await p; return null; } catch (e) { return e?.code ?? String(e?.message ?? e); } };
window.ready = true;
</script>`;
const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (r) => {
  const p = new URL(r.url).pathname;
  if (p === "/fs.js") return new Response(js, { headers: { "content-type": "text/javascript" } });
  return new Response(page, { headers: { "content-type": "text/html" } });
} });
const site = `http://127.0.0.1:${server.port}`;
const B = await browser();
const fresh = async () => {
  const P = await B.tab();
  const n = P.loads;
  await P.send("Page.navigate", { url: site + "/" });
  for (const t = Date.now(); P.loads === n && Date.now() - t < 10000; ) await new Promise((r) => setTimeout(r, 50));
  await P.until(`window.ready === true`, 15000);
  // (a clean slate: every key, pin and journal entry of this origin gone)
  await P.ev(`new Promise((ok) => { const r = indexedDB.deleteDatabase("sagebrush-fleet-v1"); r.onsuccess = r.onerror = r.onblocked = () => ok(true); })`);
  await P.send("Page.reload", {});
  for (const t = Date.now(); P.loads === n + 1 && Date.now() - t < 10000; ) await new Promise((r) => setTimeout(r, 50));
  await P.until(`window.ready === true`, 15000);
  return P;
};
// (a review made and confirmed, held at the click: window.R)
const reviewed = (P) => P.ev(`(async () => { window.R = await m.fs.beginGenesis(svc, "laptop"); const g = R.code.split("-"); return { fleet: R.fleet, ok: R.confirm([g[R.ask[0]], g[R.ask[1]]]), code: R.code }; })()`);
const state = (P) => P.ev(`(async () => ({ uses: m.keyInvocations(), chain: S.chain.length, appends: S.appends.length, journal: (await m.journalList()).length }))()`);

try {
  // ---- F1, end to end
  {
    const P = await fresh();
    const begun = await P.ev(`(async () => { window.R = await m.fs.beginGenesis(svc, "laptop"); return { fleet: R.fleet, code: R.code, ask: R.ask }; })()`);
    ok(/^[a-z2-7]{25}[aeimquy4]$/.test(begun.fleet) && /^([a-z2-7]{4}-){6}[a-z2-7]{2}$/.test(begun.code) && begun.ask[0] < begun.ask[1], "F1: a review with a new fleet id, its recovery code shown in groups of four, and two groups asked back", begun);
    const wrong = await P.ev(`R.confirm(["aaaa", "bbbb"])`);
    ok(wrong === false && (await P.ev(`R.code`)) === begun.code, "F1: a failed confirmation keeps the code on the screen (r4's ruling)");
    ok((await P.ev(`code(R.signOnce(svc))`)) === "not_confirmed" && (await state(P)).uses === 0, "F1: nothing is signed before the confirmation passes");
    // (the failed signOnce above claimed nothing: a review signs once only after a confirmation; make a fresh one)
    const r2 = await reviewed(P);
    ok(r2.ok === true, "F1: the two asked groups, typed back: confirmed");
    const res = await P.ev(`R.signOnce(svc)`);
    const st = await state(P);
    ok(res.fleet === r2.fleet && res.seq === 0 && st.uses === 1 && st.chain === 1 && st.journal === 0, "F1: one genesis signed (one key use), admitted by the service, and its journal entry dropped after the receipt", { res, st });
    const env = await P.ev(`JSON.parse(S.chain[0])`);
    ok(env.type === "sb.device-chain.v1" && env.body.op === "genesis" && env.body.seq === 0 && env.body.device.tier === "browser" && env.body.device.name === "laptop" && env.signer.kind === "device" && env.signer.id === env.body.device.id, "F1: the envelope, read apart from the UI: a genesis at seq 0, a browser-tier device, signed by that device", env.body);
    const pinned = await P.ev(`m.pin(${JSON.stringify(r2.fleet)})`);
    ok(pinned && pinned.seq === 0 && !pinned.forked, "F1: and this device's pin is at seq 0, by the normal verified sync", pinned);
    ok((await P.ev(`R.code`)) !== "" && (await P.ev(`(R.close(), R.code)`)) === "", "F1: the code is gone from the review once its screen closes");
    ok((await P.ev(`code(R.signOnce(svc))`)) === "closed" && (await state(P)).uses === 1, "F1: a closed review signs nothing more");
    await P.send("Page.close").catch(() => {});
  }
  // ---- one signature per review
  {
    const P = await fresh();
    await reviewed(P);
    const both = await P.ev(`Promise.all([code(R.signOnce(svc)), code(R.signOnce(svc))])`);
    const st = await state(P);
    ok(both.filter((c) => c === null).length === 1 && both.includes("signed_already") && st.uses === 1 && st.appends === 1, "barrier: two clicks at once give ONE signature and one submit", { both, st });
    await P.send("Page.close").catch(() => {});
  }
  // ---- the barrier: each input changed between the review and the click
  const held = [
    ["the sign-in renewed (another reauth_ms)", `S.session.reauth_ms = Date.now() + 1`, "changed"],
    ["a fleet made meanwhile for this account", `S.fleet = { fleet: "aaaaaaaaaaaaaaaaaaaaaaaaaa", aud: svc.aud }`, "has_fleet"],
    ["the device key replaced", `m.resetDevice(R.fleet).then(() => m.makeDeviceKey(R.fleet))`, "changed"],
    ["the screen closed", `R.close()`, "closed"],
    ["the sign-in older than 4.5 min, the session unchanged", `(S.session.reauth_ms = Date.now() - 271000, true)`, "reauth_needed"],
    ["no session any more", `(S.noSession = true, true)`, "no_session"],
  ];
  for (const [what, change, want] of held) {
    const P = await fresh();
    await reviewed(P);
    const before = await state(P);
    await P.ev(`Promise.resolve(${change}).then(() => true)`);
    const got = await P.ev(`code(R.signOnce(svc))`);
    const after = await state(P);
    ok(got === want && after.uses === before.uses && after.appends === 0 && after.chain === 0, `barrier: ${what} between the review and the click: refused (${want}), zero key uses, nothing submitted`, { got, before, after });
    await P.send("Page.close").catch(() => {});
  }
  // ---- beginning F1: what refuses it
  {
    const P = await fresh();
    ok((await P.ev(`(S.session.reauth_ms = Date.now() - 121000, code(m.fs.beginGenesis(svc, "x")))`)) === "reauth_needed", "begin: under 3 min of the sign-in's freshness left: re-auth first (the code never crosses a redirect)");
    ok((await P.ev(`(S.session.reauth_ms = null, code(m.fs.beginGenesis(svc, "x")))`)) === "reauth_needed", "begin: no explicit re-auth on this session (reauth_ms null): re-auth first");
    ok((await P.ev(`(S.session.reauth_ms = Date.now(), S.noSession = true, code(m.fs.beginGenesis(svc, "x")))`)) === "no_session", "begin: no session: refused");
    ok((await P.ev(`(S.noSession = false, S.fleet = { fleet: "aaaaaaaaaaaaaaaaaaaaaaaaaa", aud: svc.aud }, code(m.fs.beginGenesis(svc, "x")))`)) === "has_fleet", "begin: the account has a fleet: refused");
    ok((await state(P)).uses === 0, "begin: none of these made a signature");
    await P.send("Page.close").catch(() => {});
  }
  // ---- receipts: a lost answer, a reload, a refusal
  {
    const P = await fresh();
    await reviewed(P);
    ok((await P.ev(`(S.mode = "lost-after", code(R.signOnce(svc)))`)) === null, "receipt: the answer lost after the service admitted it: the receipt read finds it landed (signOnce succeeds)");
    const st = await state(P);
    ok(st.uses === 1 && st.chain === 1 && st.journal === 0, "receipt: one signature, one entry, the journal cleared", st);
    await P.send("Page.close").catch(() => {});
  }
  {
    const P = await fresh();
    const r = await reviewed(P);
    const first = await P.ev(`(S.mode = "lost-before", code(R.signOnce(svc)))`);
    const j = await P.ev(`m.journalList()`);
    ok(first === "submit_lost" && j.length === 1 && j[0].state === "submitted" && j[0].envelopes.length === 1, "receipt: lost before the service had it: the signed entry stays in the journal, submitted", { first, j: j.map((e) => e.state) });
    // (a reload: the review is gone; settleGenesis reads the receipt, then resubmits the SAME bytes)
    await P.send("Page.reload", {});
    await P.until(`window.ready === true`, 15000);
    const res = await P.ev(`(S.mode = "ok", m.fs.settleGenesis(svc))`);
    const st = await state(P);
    const same = await P.ev(`S.chain[0] === ${JSON.stringify(j[0].envelopes[0])}`);
    ok(res?.fleet === r.fleet && st.uses === 0 && same && st.journal === 0, "receipt: after a reload, the same signed bytes are resubmitted (no new signature on this page), and they land", { res, st, same });
    await P.send("Page.close").catch(() => {});
  }
  {
    const P = await fresh();
    await reviewed(P);
    const got = await P.ev(`(S.mode = "refuse:stale_auth", code(R.signOnce(svc)))`);
    const st = await state(P);
    ok(got === "reauth_needed" && st.journal === 0 && st.chain === 0, "receipt: a stale_auth refusal: those bytes can never land, so the journal entry is dropped; re-auth, then a new review", { got, st });
    await P.send("Page.close").catch(() => {});
  }
  {
    const P = await fresh();
    const r = await reviewed(P);
    // (a crash between the journal's pending entry and the key: pending, never sent)
    await P.ev(`m.journalPut({ id: "pendingreview0000000000000", fleet: R.fleet, flow: "genesis", state: "pending", captured: ["x"], envelopes: [], at: Date.now() }).then(() => true)`);
    await P.ev(`(R.close(), true)`);
    const res = await P.ev(`m.fs.settleGenesis(svc)`);
    const st = await state(P);
    const key = await P.ev(`m.deviceKey(${JSON.stringify(r.fleet)})`);
    ok(res === null && st.journal === 0 && st.appends === 0 && key === null, "receipt: a pending entry (never signed or sent) is dropped, never sent, and its unused key deleted", { res, st, key });
    await P.send("Page.close").catch(() => {});
  }
  // ---- Start again
  {
    const P = await fresh();
    const r = await reviewed(P);
    await P.ev(`(window.release = null, S.hold = new Promise((ok) => (window.release = ok)), window.going = R.signOnce(svc).catch((e) => e.code), true)`);
    await P.until(`S.appends.length === 1`, 10000);
    ok((await P.ev(`code(m.fs.startAgain(svc, ${JSON.stringify(r.fleet)}))`)) === "journal_open", "Start again: refused while a genesis submit from this page is still outstanding");
    await P.ev(`(release(), going).then(() => true)`);
    ok((await P.ev(`code(m.fs.startAgain(svc, ${JSON.stringify(r.fleet)}))`)) === "has_fleet", "Start again: refused once the genesis landed (the device is pinned)");
    await P.send("Page.close").catch(() => {});
  }
  {
    const P = await fresh();
    const r = await reviewed(P);
    await P.ev(`(R.close(), true)`);
    ok((await P.ev(`code(m.fs.startAgain(svc, ${JSON.stringify(r.fleet)}))`)) === null && (await P.ev(`m.deviceKey(${JSON.stringify(r.fleet)})`)) === null, "Start again: with nothing submitted, no pin and no fleet, the unused key is deleted");
    await P.send("Page.close").catch(() => {});
  }
  // ---- the signing capability
  {
    const P = await fresh();
    await reviewed(P);
    const forged = await P.ev(`code(m.signAsDevice(Object.freeze({ fleet: R.fleet }), R.fleet, new Uint8Array([1, 2, 3])))`);
    const minter = await P.ev(`code(Promise.resolve().then(() => m.signingMinter()))`);
    ok(forged === "not_granted" && (await state(P)).uses === 0, "capability: a grant that wasn't minted signs nothing (not_granted), zero key uses", forged);
    ok(/already taken/.test(minter ?? ""), "capability: the minter was taken by fleet-sign as it loaded; no second caller gets one", minter);
    await P.send("Page.close").catch(() => {});
  }
  // ---- a fork's evidence: both entries' exact texts
  {
    const P = await fresh();
    await reviewed(P);
    await P.ev(`R.signOnce(svc)`);
    const r = await P.ev(`(async () => { const f = R.fleet; const p = await m.pin(f); try { await m.advancePin(f, { seq: 0, hash: "Q".repeat(42) + "A" }, "the-other-entry"); } catch {} return m.forkEvidence(f); })()`);
    const genesis = await P.ev(`S.chain[0]`);
    ok(r && r.pinned === genesis && r.conflicting === "the-other-entry" && r.seen.seq === 0, "fork: the evidence keeps both conflicting entries' exact texts (the pinned genesis, and the one seen)", r);
    ok((await P.ev(`m.fs.beginGenesis(svc, "x").then(() => null, (e) => e.code)`)) === "has_fleet", "fork: (and a forked device's account still has its fleet: no new F1)");
    await P.send("Page.close").catch(() => {});
  }
} catch (e) {
  ok(false, "the test ran to its end: " + (e?.stack ?? e));
} finally {
  await B.close();
  server.stop(true);
}
console.log(failures ? `${failures} FAILED` : "test-fleet-sign: all passed");
process.exit(failures ? 1 : 0);
