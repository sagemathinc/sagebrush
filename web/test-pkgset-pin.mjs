// ci: web-browser/notebook order=180
// The notebook's package set (web/index.html notebookPkgset and pinUsedPkgset;
// plan-modular-packages-r4 §4.4 as amended Nov 4: pinned at first use of the
// set, to the same S that import used).  A start never writes: an unpinned
// notebook is given the site's latest unpinned, and nothing is set or saved;
// a pin already there is durable before any start uses it (astra's
// CORR-PR68-3: a pin in memory, e.g. on a restart while a save is held, waits
// for nb.saved() like any other; a failed save rejects; a pin that wins
// meanwhile is the one returned; a notebook left meanwhile rejects).  At the
// set's first use the page pins it, once, and waits for it to be durable; a
// pin already there (the same set, or another tab's) is never rewritten.  The
// exact functions from index.html, run in node against a fake notebook whose
// saves the test holds and releases.
//   node web/test-pkgset-pin.mjs
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const start = html.indexOf("let latestPkgset;");
const end = html.indexOf("\nfunction makeKernel", start);
if (start < 0 || end < 0) throw new Error("notebookPkgset not found in index.html");
const source = html.slice(start, end);

let failures = 0;
const ok = (c, msg) => {
  console.log((c ? "ok   " : "FAIL ") + msg);
  if (!c) failures++;
};
const tick = () => new Promise((r) => setImmediate(r));
const S = "a".repeat(64), T = "b".repeat(64);

// a fake notebook: setMeta (counted), a saved() the test controls, and the shown notebook
function setup({ latest = S, meta = {}, duringFetch = null } = {}) {
  const saves = [];
  const writes = [];
  const nb = {
    meta: { ...meta },
    setMeta(x) { writes.push(x); Object.assign(this.meta, x); },
    saved() { return new Promise((resolve, reject) => saves.push({ resolve, reject })); },
  };
  const current = { id: "n" };
  const fetches = { n: 0 };
  const statusEl = { textContent: "" };
  const fetch = async () => { fetches.n++; duringFetch?.(nb); return { ok: true, json: async () => ({ id: latest }) }; };
  const [notebookPkgset, pinUsedPkgset] = new Function("nb", "current", "LOCAL", "statusEl", "fetch", source + "\nreturn [notebookPkgset, pinUsedPkgset];")(nb, current, false, statusEl, fetch);
  const track = (p) => { const t = { done: false, value: undefined, error: undefined }; p.then((v) => { t.done = true; t.value = v; }, (e) => { t.done = true; t.error = e; }); return t; };
  return { nb, current, saves, writes, fetches, statusEl, call: () => track(notebookPkgset("n")), use: (set, owner = "n") => track(pinUsedPkgset(owner, set)) };
}
async function settle(saves, how = "resolve") {
  for (let i = 0; i < 10; i++) {
    await tick();
    while (saves.length) saves.shift()[how](how === "reject" ? new Error("not saved") : undefined);
  }
  await tick();
}

// 1. an unpinned notebook's start: the latest, unpinned; nothing set, nothing saved (opening or running never writes)
{
  const t = setup();
  const first = t.call();
  await settle(t.saves);
  ok(first.value === S && t.writes.length === 0 && t.nb.meta.pkgset === undefined, "a start gives the latest S unpinned: no metadata write");
  const again = t.call();
  await settle(t.saves);
  ok(again.value === S && t.writes.length === 0 && t.fetches.n === 1, "a restart: the same S, still no write, latest asked once a page");
}

// 2. a pin that arrives while latest is asked (another tab's): the next round uses it, once durable
{
  const t = setup({ duringFetch: (nb) => (nb.meta.pkgset = T) });
  const first = t.call();
  await tick(); await tick(); await tick();
  ok(!first.done && t.saves.length === 1, "a pin merged in meanwhile is waited on (durable) before use");
  await settle(t.saves);
  ok(first.value === T && t.writes.length === 0, "and that pin T is returned, not the latest S; nothing written here");
}

// 3. first use: pinned once, to the S it used, durable before it resolves
{
  const t = setup();
  const used = t.use(S);
  await tick(); await tick();
  ok(t.nb.meta.pkgset === S && t.writes.length === 1 && t.saves.length === 1 && !used.done, "the first use pins S and waits for its save");
  await settle(t.saves);
  ok(used.done && used.error === undefined, "and resolves once the pin is durable");
  // (a later use, e.g. the next import or a restarted interpreter's first use: no second write)
  const later = t.use(S);
  await settle(t.saves);
  ok(later.done && t.writes.length === 1 && t.nb.meta.pkgset === S, "a later use with the pin there writes nothing again");
}

// 4. an already-pinned notebook: its start keeps the pin (no fetch, no write), and a use never rewrites it
{
  const t = setup({ meta: { pkgset: S } });
  const first = t.call();
  await settle(t.saves);
  ok(first.value === S && t.fetches.n === 0 && t.writes.length === 0, "a pin in the notebook is used once saved() answers: no latest, no write");
  const used = t.use(S);
  await settle(t.saves);
  ok(used.done && t.writes.length === 0, "its use writes nothing");
}

// 5. a use of S when another tab pinned T meanwhile: T stays, nothing written, the reader told
{
  const t = setup({ meta: { pkgset: T } });
  const used = t.use(S);
  await settle(t.saves);
  ok(used.done && t.nb.meta.pkgset === T && t.writes.length === 0 && /another tab/.test(t.statusEl.textContent), "another tab's pin is never overwritten; restarting uses it");
}

// 6. a use after its notebook was left: nothing pinned (into the notebook shown now or any other)
{
  const t = setup();
  t.current.id = "other";
  const used = t.use(S, "n");
  await settle(t.saves);
  ok(used.done && t.writes.length === 0 && t.nb.meta.pkgset === undefined, "a left notebook's use pins nothing");
}

// 7. a failed save at first use: said, the pin kept in memory for the next save; the use still resolves
{
  const t = setup();
  const used = t.use(S);
  await settle(t.saves, "reject");
  ok(used.done && used.error === undefined && t.nb.meta.pkgset === S && /isn't saved yet/.test(t.statusEl.textContent), "a failed save is said; the run isn't held forever");
}

// 8. CORR-PR68-3 on the pinned path: a pin in memory whose save is held, and a restart, wait for it
{
  const t = setup({ meta: { pkgset: S } });
  const first = t.call();
  const second = t.call();
  await tick(); await tick();
  ok(!first.done && !second.done, "neither start resolves while the save is held");
  await settle(t.saves, "reject");
  ok(first.done && first.error !== undefined && second.done && second.error !== undefined, "a failed save rejects them, though the metadata holds S");
}

// 9. the notebook left while its pin's save is held: the start rejects
{
  const t = setup({ meta: { pkgset: S } });
  const first = t.call();
  await tick(); await tick();
  t.current.id = "other";
  await settle(t.saves);
  ok(first.done && /left/.test(String(first.error?.message)), "a notebook left while its pin was being saved rejects");
}

// 10. an invalid pin is refused, not guessed
{
  const t = setup({ meta: { pkgset: "nope" } });
  const first = t.call();
  await settle(t.saves);
  ok(first.value === null && t.fetches.n === 0, "an invalid pin turns optional packages off");
}

console.log(failures ? `${failures} failures` : "all passed");
process.exit(failures ? 1 : 0);
