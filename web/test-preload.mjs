// ci: web-browser/board-unit.2 order=250 runner=bun
// Background loading's pure parts (web/preload.ts): which library groups a document's first Run will fetch (its
// mode's, then those its import lines name), the exact files, the skips (Save-Data, slow, offline, hidden), the
// storage check, and the fetch loop (one at a time; a stop never cancels the file in flight, only the next).
//   bun web/test-preload.mjs
import { intentGroups, intentUrls, preloadBlocked, preloadRoom, preloadFetch, preloadStop } from "./preload.ts";

let fails = 0;
const ok = (c, what) => { console.log((c ? "ok   " : "FAIL ") + what); if (!c) fails++; };
const J = JSON.stringify;

const T = {
  groups: { core: [300, "a".repeat(16), "b".repeat(16)], sci: [2000, "c".repeat(16), "d".repeat(16)], sage: [9000, "e".repeat(16), "f".repeat(16)], "mod-csv": [10, "1".repeat(16)] },
  modes: { sage: ["core", "sci", "sage"] },
  tops: { numpy: "sci", scipy: "sci", csv: "mod-csv", random: "core", sage_all: "sage" },
};

// intent: the mode's groups, then the imports' (each once, in order)
ok(J(intentGroups(T, "python", ["print(1)", "x = 2"])) === "[]", "a plain python notebook: no group");
ok(J(intentGroups(T, "python", ["import numpy as np\nprint(np.arange(3))"])) === '["sci"]', "import numpy: sci");
ok(J(intentGroups(T, "python", ["from numpy.linalg import inv"])) === '["sci"]', "from numpy.linalg import ...: sci (the top-level name)");
ok(J(intentGroups(T, "python", ["import csv, numpy as np, random"])) === '["mod-csv","sci","core"]', "import a, b as c, d: each, in order");
ok(J(intentGroups(T, "python", ["def f():\n    import scipy\n    return scipy"])) === '["sci"]', "an import inside a function counts");
ok(J(intentGroups(T, "python", ["import numpy  # comment"])) === '["sci"]', "an import line with a trailing comment");
ok(J(intentGroups(T, "python", ["import numpy", "import scipy"])) === '["sci"]', "a group named twice: once");
ok(J(intentGroups(T, "python", ["s = 'import numpy'", "print('from numpy import x')"])) === "[]", "an import inside a string isn't a line's import");
ok(J(intentGroups(T, "python", ["import nosuchmodule", "import os"])) === "[]", "a module outside the table (or one the page has): nothing");
ok(J(intentGroups(T, "sage", ["factor(12)"])) === '["core","sci","sage"]', "a Sage notebook: its mode's groups");
ok(J(intentGroups(T, "sage", ["import numpy"])) === '["core","sci","sage"]', "...and an import of a group it has: no repeat");
ok(J(intentGroups(T, "matlab", ["import numpy"])) === "[]", "a MATLAB notebook: no Python import scan (its own mode's groups only, none here)");
ok(J(intentGroups({ ...T, modes: { ...T.modes, magma: ["nosuch"] } }, "magma", [])) === "[]", "a mode naming a group the table lacks: skipped");

// the files, as the worker requests them (beside it, at the site's root)
const base = "https://sagebrush.space/?nb=x";
ok(J(intentUrls(T, ["sci"], base)) === J([`https://sagebrush.space/lib/sci.src.${"c".repeat(16)}.json`, `https://sagebrush.space/lib/sci.pre.${"d".repeat(16)}.json`]), "sci: its src and pre chunk files, exactly");
ok(J(intentUrls(T, ["mod-csv"], base)) === J([`https://sagebrush.space/lib/mod-csv.src.${"1".repeat(16)}.json`]), "a group without a pre chunk: its src only");

// the skips
const vis = { visibilityState: "visible" }, hid = { visibilityState: "hidden" };
ok(preloadBlocked({ onLine: true }, vis) === null, "no connection info, online, visible: may run");
ok(preloadBlocked({ onLine: true, connection: { effectiveType: "4g" } }, vis) === null, "4g: may run");
ok(preloadBlocked({ onLine: true, connection: { saveData: true, effectiveType: "4g" } }, vis) === "save-data", "Save-Data: skipped");
for (const t of ["slow-2g", "2g", "3g"]) ok(preloadBlocked({ onLine: true, connection: { effectiveType: t } }, vis) === "slow", `${t}: skipped`);
ok(preloadBlocked({ onLine: false }, vis) === "offline", "offline: skipped");
ok(preloadBlocked({ onLine: true }, hid) === "hidden", "a hidden tab: skipped");

// storage: at least 4x the plan's bytes left of the quota (unknown: yes)
const est = (quota, usage) => ({ storage: { estimate: async () => ({ quota, usage }) } });
ok((await preloadRoom(1000, est(10_000, 5_000))) === true, "5,000 left for 1,000 (4,000 needed): room");
ok((await preloadRoom(1000, est(10_000, 6_001))) === false, "3,999 left for 1,000: no room");
ok((await preloadRoom(1000, {})) === true, "no storage estimate: room");

// the fetch loop: one at a time, each read to its end; stopped before the next once a Run starts (the one in flight
// finishes); stopped too when blocked, on a failure, or on a stall
// (a body of `chunks` bytes; `hang`: then nothing more, until the request's signal aborts it, as a real fetch's read)
const body = (chunks, hang = false, signal) => ({ getReader: () => { let i = 0; return { read: () => (i < chunks ? Promise.resolve({ done: false, value: new Uint8Array(1), i: i++ }) : hang ? new Promise((_, no) => signal?.addEventListener("abort", () => no(new Error("aborted")))) : Promise.resolve({ done: true })) }; } });
// (first, while nothing has stopped the loop) a file that stops sending is abandoned after `stallMs`, and nothing
// after it starts
{
  const asked = [];
  globalThis.fetch = async (u, init) => { asked.push(u); return { ok: true, body: body(1, u === "s1", init.signal) }; };
  const t0 = Date.now(), done = await preloadFetch(["s0", "s1", "s2"], () => null, 80);
  ok(J(done) === '["s0"]' && J(asked) === '["s0","s1"]' && Date.now() - t0 < 2000, `a file that stalls (no data for 80 ms): abandoned, the next never started (${Date.now() - t0} ms): ` + J([done, asked]));
  // (blocked between files: Save-Data turned on, say)
  let n = 0;
  const asked2 = [];
  globalThis.fetch = async (u) => { asked2.push(u); return { ok: true, body: body(1) }; };
  ok(J(await preloadFetch(["b0", "b1"], () => (n++ ? "save-data" : null))) === '["b0"]' && J(asked2) === '["b0"]', "blocked between files: the next one isn't started");
  globalThis.fetch = async () => ({ ok: false, status: 404 });
  ok(J(await preloadFetch(["f0", "f1"], () => null)) === "[]", "a file answered 404: the loop ends");
}
{
  const started = [], finished = [];
  let release;
  globalThis.fetch = async (u, init) => {
    started.push([u, init.priority, init.credentials, init.referrerPolicy]);
    if (u === "u2") await new Promise((r) => (release = r));
    finished.push(u);
    return { ok: true, body: body(2) };
  };
  const p = preloadFetch(["u1", "u2", "u3"], () => null);
  for (let i = 0; i < 50 && !release; i++) await new Promise((r) => setTimeout(r, 5));
  preloadStop(); // (a Run while u2 is in flight)
  release();
  const done = await p;
  ok(J(started.map((s) => s[0])) === '["u1","u2"]' && started.every((s) => s[1] === "low" && s[2] === "omit" && s[3] === "no-referrer"), "low priority, the broker's shape (no cookie, no referrer), one at a time; a Run while u2 is in flight: u3 never starts: " + J(started));
  ok(J(done) === '["u1","u2"]' && J(finished) === '["u1","u2"]', "...and u2, in flight, finishes (read to its end): " + J(done));
  ok(J(await preloadFetch(["u4"], () => null)) === "[]", "after a stop, nothing more starts");
}
if (fails) { console.log(`${fails} failed`); process.exit(1); }
console.log("all passed");
