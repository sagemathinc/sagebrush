// ci: web-runner order=597 runner=bun
// "Run on a GPU" (gpu-start.ts) against a fake PageKeys with r12.1's auto-sign conditions: one click starts and
// auto-adds the first matching key; anything else is the approval card or a warning; a refused start spends the
// intent; token_used withdraws the notice; without E2E it just starts.
//   bun web/workspace/test-gpu-start.mjs
import { CONSENT, GpuRefused, GpuStart, SECOND_KEY, WHY_WORDS } from "./gpu-start.ts";

let failures = 0;
const ok = (c, msg) => { console.log((c ? "ok   " : "FAIL ") + msg); if (!c) failures++; };
const tick = () => new Promise((r) => setTimeout(r, 0));

/** A fake PageKeys: page memory, the r12.1 conditions over plain objects. */
function fakeKeys() {
  const pendingCbs = new Set(), usedCbs = new Set();
  const intents = [];
  const devices = [];
  const k = {
    account: "acct", device: { id: "dev-page" }, intents, devices, signed: [], removed: [],
    startIntent() {
      const it = {
        id: "N" + (intents.length + 1), reservation: null, expires: Date.now() + 600_000, spent: false, firstSeen: false,
        bind(r) { if (it.reservation != null || it.spent) { it.spent = true; throw new Error("bind"); } it.reservation = r; },
        cancel() { it.spent = true; },
      };
      intents.push(it);
      return it;
    },
    async pending() { return []; },
    onPending(cb) { pendingCbs.add(cb); return () => pendingCbs.delete(cb); },
    async devices() { return devices; },
    async enrollAtStart(it, p) {
      if (!intents.includes(it)) return { ok: false, why: "other-page" };
      if (p.intent == null) return { ok: false, why: "no-intent" };
      if (p.intent !== it.id) return { ok: false, why: "other-page" };
      if (it.spent) return { ok: false, why: "used" };
      if (Date.now() > it.expires) return { ok: false, why: "expired" };
      if (it.reservation == null) return { ok: false, why: "not-bound" };
      if (p.reservation !== it.reservation) return { ok: false, why: "other-reservation" };
      it.spent = true;
      const id = "dev-" + p.session;
      k.signed.push(id);
      k.chainAdd(id, p, k.signsAs);
      return { ok: true, device: id };
    },
    async approve(p) { const id = "dev-" + p.session; k.signed.push(id); k.chainAdd(id, p, "card"); return { device: id }; },
    // the replayed chain: kind, addedAtStart and reservation come only from the signed add's `provisioned` field
    signsAs: "start",
    chainAdd(id, p, approved) {
      const provisioned = { reservation: p.reservation, instance: p.instance, retire_on: approved === "start" ? "reservation-retired" : null, approved };
      devices.push({ id, name: p.name, kind: "provisioned", fingerprint: p.fingerprint, current: false, provisioned,
        get addedAtStart() { return this.provisioned?.approved === "start"; }, get reservation() { return this.provisioned?.reservation ?? null; } });
    },
    async removeDevice(id, opts) { k.removed.push({ id, ...opts }); },
    onTokenUsed(cb) { usedCbs.add(cb); return () => usedCbs.delete(cb); },
    deliver(p) { for (const cb of pendingCbs) cb(p); },
    tokenUsed(w) { for (const cb of usedCbs) cb(w); },
    listeners: () => pendingCbs.size + usedCbs.size,
  };
  return k;
}
const pend = (o) => ({ session: "s1", intent: "N1", reservation: "res1", instance: null, kind: "provisioned", fingerprint: "ABCD-EFGH", name: "gpu-ab12", ...o });
const api = (answer = { machineId: "m1", reservation: "res1" }) => {
  const calls = [];
  return { calls, async start(body) { calls.push(body); if (answer instanceof Error) throw answer; return answer; } };
};

{ // the one-click path
  const keys = fakeKeys(), a = api();
  let t = 1000;
  const g = new GpuStart(keys, a, () => t);
  ok(g.consentShown && CONSENT.includes("Sagebrush's service sets it up and adds it for you"), "E2E on: the consent words show under Start");
  await g.start("A40");
  ok(a.calls[0].intent === "N1" && a.calls[0].gpuType === "A40", "the start carries the intent's id, only its id");
  ok(keys.intents[0].reservation === "res1" && g.state.phase === "connecting", "the reservation from the answer is bound; connecting");
  t = 28_000;
  keys.deliver(pend());
  await tick();
  ok(g.state.phase === "ready" && g.state.added?.atStart === true && g.state.added.fingerprint === "ABCD-EFGH", "the first matching key is added at Start");
  ok(g.startupMs === 27_000, "the startup time is measured from the click");
  keys.deliver(pend({ session: "s2" }));
  await tick();
  ok(g.state.phase === "warning" && g.state.text === SECOND_KEY && keys.signed.length === 1, "a second key for the machine: a warning, nothing signed");
}
{ // the notice reads the replayed chain, not the enroll answer
  const keys = fakeKeys(), g = new GpuStart(keys, api());
  keys.signsAs = "card";
  await g.start("A40");
  keys.deliver(pend());
  await tick();
  ok(g.state.phase === "ready" && g.state.added?.atStart === false, "a chain add not approved at Start: no \"added at Start\" notice");
}
{ // a key that lands before Start's answer is held, then added
  const keys = fakeKeys();
  let release;
  const slow = { calls: [], start: (b) => new Promise((r) => { slow.calls.push(b); release = () => r({ machineId: "m1", reservation: "res1" }); }) };
  const g = new GpuStart(keys, slow);
  const p = g.start("A40");
  await tick();
  keys.deliver(pend());
  await tick();
  ok(g.state.phase === "starting" && keys.signed.length === 0, "a key before the answer is held, not signed");
  release();
  await p;
  await tick();
  ok(g.state.phase === "ready" && keys.signed.length === 1, "after bind the held key is added");
}
{ // refused start spends the intent
  const keys = fakeKeys(), g = new GpuStart(keys, api(new GpuRefused("No GPU of that kind is free right now.")));
  await g.start("A40");
  ok(g.state.phase === "refused" && g.state.text === "No GPU of that kind is free right now." && keys.intents[0].spent, "a refused start shows its words and spends N at once");
}
{ // refusals become the card, in words
  for (const [p, why] of [[pend({ intent: null }), "no-intent"], [pend({ intent: "N9" }), "other-page"], [pend(), "expired"]]) {
    const keys = fakeKeys(), g = new GpuStart(keys, api());
    await g.start("A40");
    if (why === "expired") keys.intents[0].expires = 0;
    keys.deliver(p);
    await tick();
    ok(g.state.phase === "approve" && g.state.why === WHY_WORDS[why] && keys.signed.length === 0, `${why}: the card with its reason, nothing signed`);
    await g.approve();
    ok(g.state.phase === "ready" && g.state.added?.atStart === false && keys.signed.length === 1, `${why}: Approve signs exactly that key`);
  }
}
{ // another machine's key is ignored
  const keys = fakeKeys(), g = new GpuStart(keys, api());
  await g.start("A40");
  keys.deliver(pend({ reservation: "res-other" }));
  await tick();
  ok(g.state.phase === "connecting" && keys.signed.length === 0, "a key for another reservation is not this card's: still connecting");
}
{ // Approve it myself
  const keys = fakeKeys(), a = api(), g = new GpuStart(keys, a);
  await g.start("A40", { manual: true });
  ok(a.calls[0].intent === null && keys.intents.length === 0, "Approve it myself: no intent is made or sent");
  keys.deliver(pend({ intent: null }));
  await tick();
  ok(g.state.phase === "approve" && g.state.why === null && keys.signed.length === 0, "the card, no auto-sign");
}
{ // Remove and token_used
  const keys = fakeKeys(), g = new GpuStart(keys, api());
  await g.start("A40");
  keys.deliver(pend());
  await tick();
  await g.remove();
  ok(keys.removed[0]?.rotate === true && keys.removed[0].reason === "person" && g.state.phase === "ready" && g.state.added === null, "Remove: rotated, and the notice goes");
  const g2 = new GpuStart(fakeKeys(), api());
  const k2 = fakeKeys(), g3 = new GpuStart(k2, api());
  await g3.start("A40");
  k2.deliver(pend());
  await tick();
  k2.tokenUsed({ reservation: "res-other", removed: null, text: "x" });
  ok(g3.state.phase === "ready", "token_used for another machine: nothing changes");
  k2.tokenUsed({ reservation: "res1", removed: "dev-s1", text: "Another machine used this machine's setup first." });
  ok(g3.state.phase === "warning" && g3.state.text.startsWith("Another machine"), "token_used: the warning replaces the notice");
  g2.dispose();
}
{ // without E2E
  const a = api(), g = new GpuStart(null, a);
  ok(!g.consentShown, "no E2E: no consent words");
  await g.start("A40");
  ok(a.calls[0].intent === null && g.state.phase === "ready" && g.state.added === null, "no E2E: it just starts");
}
{ // dispose spends an unfinished intent and unsubscribes
  const keys = fakeKeys(), g = new GpuStart(keys, api());
  await g.start("A40");
  g.dispose();
  ok(keys.intents[0].spent && keys.listeners() === 0, "leaving while connecting spends N and stops listening");
}

if (failures > 0) { console.log(`${failures} failed`); process.exit(1); }
console.log("all passed");
