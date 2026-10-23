// The notebook's package set pin is durable before any start uses it
// (web/index.html notebookPkgset; astra's CORR-PR68-3 on c6580f48): a pin
// already in memory, e.g. on a restart while the first start's save is held,
// waits for nb.saved() like a new one; a failed save rejects and is never
// taken as success; a pin that wins during the save is the one returned; a
// notebook left meanwhile rejects.  The exact function from index.html, run
// in node against a fake notebook whose saves the test holds and releases.
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

// a fake notebook: setMeta, a saved() the test controls, and the shown notebook
function setup({ latest = S, meta = {} } = {}) {
  const saves = [];
  const nb = {
    meta: { ...meta },
    setMeta(x) { Object.assign(this.meta, x); },
    saved() { return new Promise((resolve, reject) => saves.push({ resolve, reject })); },
  };
  const current = { id: "n" };
  const fetches = { n: 0 };
  const fetch = async () => { fetches.n++; return { ok: true, json: async () => ({ id: latest }) }; };
  const notebookPkgset = new Function("nb", "current", "LOCAL", "statusEl", "fetch", source + "\nreturn notebookPkgset;")(nb, current, false, {}, fetch);
  const track = (p) => { const t = { done: false, value: undefined, error: undefined }; p.then((v) => { t.done = true; t.value = v; }, (e) => { t.done = true; t.error = e; }); return t; };
  return { nb, current, saves, fetches, call: () => track(notebookPkgset("n")) };
}
async function settle(saves, how = "resolve") {
  for (let i = 0; i < 10; i++) {
    await tick();
    while (saves.length) saves.shift()[how](how === "reject" ? new Error("not saved") : undefined);
  }
  await tick();
}

// 1. a restart while the first start's save is held: neither start resolves until the save does
{
  const t = setup();
  const first = t.call();
  await tick(); await tick();
  ok(t.nb.meta.pkgset === S && t.saves.length === 1 && !first.done, "the first start pinned S in memory and waits for its save");
  const second = t.call();
  await tick(); await tick();
  ok(!second.done, `a restart while that save is held does not resolve either (CORR-PR68-3's trace)`);
  await settle(t.saves);
  ok(first.value === S && second.value === S, "once the save is durable, both starts resolve S");
}

// 2. a failed save rejects, and the retry (a later start) resolves only after its own save succeeds
{
  const t = setup();
  const first = t.call();
  await settle(t.saves, "reject");
  ok(first.done && first.error !== undefined && first.value === undefined, "a failed save rejects the start, though the metadata holds S");
  const retry = t.call();
  await tick(); await tick();
  ok(!retry.done && t.saves.length === 1, "the retry waits for a new save, never trusting the in-memory pin");
  await settle(t.saves);
  ok(retry.value === S, "and resolves S once that save succeeds");
}

// 3. another pin wins during the save: the winner is returned, once it too is durable
{
  const t = setup();
  const first = t.call();
  await tick(); await tick();
  t.nb.meta.pkgset = T; // (merged in from another tab or device while the save was held)
  t.saves.shift().resolve();
  await tick(); await tick();
  ok(!first.done && t.saves.length === 1, "a pin that changed during the save is saved again before use");
  await settle(t.saves);
  ok(first.value === T, "and the winning pin T is the one returned, not S");
}

// 4. the notebook left during the save: the start rejects
{
  const t = setup();
  const first = t.call();
  await tick(); await tick();
  t.current.id = "other";
  await settle(t.saves);
  ok(first.done && /left/.test(String(first.error?.message)), "a notebook left while its pin was being saved rejects");
}

// 5. a pin loaded with the notebook: still one saved() (a no-op when nothing is pending), and no fetch of latest
{
  const t = setup({ meta: { pkgset: S } });
  const first = t.call();
  await settle(t.saves);
  ok(first.value === S && t.fetches.n === 0, "a pin already in the notebook is used once saved() answers, without asking latest");
}

// 6. an invalid pin is refused, not guessed
{
  const t = setup({ meta: { pkgset: "nope" } });
  const first = t.call();
  await settle(t.saves);
  ok(first.value === null && t.fetches.n === 0, "an invalid pin turns optional packages off");
}

console.log(failures ? `${failures} failures` : "all passed");
process.exit(failures ? 1 : 0);
