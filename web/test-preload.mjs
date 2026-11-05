// ci: web-browser/board-unit.2 order=250 runner=bun
// Background loading's pure parts (web/preload.ts): which library groups a document's first Run will fetch (its
// mode's, then those its import lines name), the exact files, the skips (Save-Data, slow, offline, hidden), the
// storage check, and the fetch loop (one at a time; a stop never cancels the file in flight, only the next).
//   bun web/test-preload.mjs
import { importTops, SCAN_LINE, SCAN_TOTAL, intentGroups, intentUrls, preloadBlocked, preloadRoom, preloadFetch, preloadStop, preloadSoon, preloadState } from "./preload.ts";

let fails = 0;
const ok = (c, what) => { console.log((c ? "ok   " : "FAIL ") + what); if (!c) fails++; };
const J = JSON.stringify;
const realFetch = globalThis.fetch;

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

// the scan is linear (PRELOAD674-SCAN-1): a long malformed line of the kind that made the old pattern backtrack, and
// its valid controls, each scanned well within a frame's budget; a line longer than SCAN_LINE: skipped
{
  const pad = " ".repeat(SCAN_LINE - 20), big = " ".repeat(200_000);
  const time = (codes) => { const t0 = performance.now(); const r = importTops(codes); return [r, performance.now() - t0]; };
  for (const [what, codes, want] of [
    ["'import ' + spaces + '!'", ["import " + pad + "!"], "[]"],
    ["'from ' + spaces + '!'", ["from " + pad + "!"], "[]"],
    ["'import' + tabs and spaces + ', ,' + '!'", ["import" + " \t".repeat(490) + ", ,!"], "[]"],
    ["(control) 'import ' + spaces + 'numpy'", ["import " + pad + "numpy"], '["numpy"]'],
    ["(control) 'from ' + spaces + 'numpy import x'", ["from " + pad + "numpy import x"], '["numpy"]'],
    ["(control) 'import numpy' + spaces", ["import numpy" + pad], '["numpy"]'],
    ["a 200,000-space import line: skipped", ["import " + big + "numpy"], "[]"],
    ["900 malformed lines (0.9 MB), then an import", [("import " + pad + "!\n").repeat(900) + "import numpy"], '["numpy"]'],
  ]) {
    const [r, ms] = time(codes);
    ok(J(r) === want && ms < 250, `scan: ${what}: ${J(r)} in ${ms.toFixed(1)} ms`);
  }
  // (many distinct names, none in the table: linear, not quadratic in their number; the table's names still found)
  const distinct = (n) => Array.from({ length: n }, (_, i) => (i % 2 ? `from unknown_${i}.x import y` : `import unknown_${i}`)).join("\n");
  for (const n of [10_000, 30_000]) {
    const lines = distinct(n);
    const t0 = performance.now(), r = importTops([lines + "\nimport numpy"]), ms = performance.now() - t0;
    ok(r.length === n + 1 && r[n] === "numpy" && ms < 250, `scan: ${n.toLocaleString()} distinct unknown imports, then numpy (${(lines.length / 1e6).toFixed(2)} MB): ${r.length} names in ${ms.toFixed(1)} ms`);
    const t1 = performance.now(), g = intentGroups(T, "python", [lines, "import scipy"]), ms1 = performance.now() - t1;
    ok(J(g) === '["sci"]' && ms1 < 250, `scan: ...as intent (another cell imports scipy): ${J(g)} in ${ms1.toFixed(1)} ms`);
  }
  // (80,000 of them, 2 MB, as many cells: the scan stops at SCAN_TOTAL, quickly)
  const many = distinct(80_000).split("\n");
  const t3 = performance.now(), r3 = importTops(many), ms3 = performance.now() - t3;
  ok(r3.length > 0 && r3.length < 80_000 && ms3 < 250, `scan: 80,000 distinct unknown imports as 80,000 cells: ${r3.length.toLocaleString()} names (the budget's) in ${ms3.toFixed(1)} ms`);
  // (a document past SCAN_TOTAL: what comes after it isn't scanned; across cells too)
  const filler = ("x = 1" + " ".repeat(90) + "\n").repeat(Math.ceil(SCAN_TOTAL / 96));
  const t2 = performance.now(), past = importTops(["import csv\n" + filler + "import numpy", "import scipy"]), ms2 = performance.now() - t2;
  ok(J(past) === '["csv"]' && ms2 < 250, `scan: only the first ${SCAN_TOTAL.toLocaleString()} characters: ${J(past)} in ${ms2.toFixed(1)} ms`);
  ok(J(importTops(["import csv", "x".repeat(10) + "\nimport numpy"])) === '["csv","numpy"]', "scan: (control) a small document: every cell scanned");
  ok(J(importTops(["import csv, nosuch, numpy", "from constructor import x", "import __proto__"], (n) => Object.hasOwn(T.tops, n))) === '["csv","numpy"]', "scan: `known`: only the names it accepts (the table's, never an object's own properties)");
  ok(J(intentGroups(T, "python", ["import constructor, toString, __proto__, hasOwnProperty"])) === "[]", "scan: names that are an object's properties, not the table's: no group");
  // (the grader's five, on 0c39a707: a tab separates, CRLF lines, the name characters, a module's text, each name once)
  for (const [code, want] of [["import\tnumpy", '["numpy"]'], ["import numpy\r\nx = 1", '["numpy"]'], ["import numpy.x!", "[]"], ["from numpy.a-b import c", "[]"], ["import a\nimport a", '["a"]']])
    ok(J(importTops([code])) === want, `scan: ${J(code)}: ${want} (${J(importTops([code]))})`);
  ok(J(importTops(["import a.b as c, d", "from e.f import g", "from . import h", "from .i import j", "import k l", "import m;", "xfrom n import o", "importp"])) === '["a","d","e"]', "scan: the forms it takes, and those it doesn't (relative, malformed, not a statement start)");
}

// redirects are refused, never followed (PRELOAD674-REDIRECT-1), as the runner broker's: real servers on two origins
// (a same-origin redirect, a cross-origin one, a loop), each a failure that ends the loop, the other origin never
// asked
{
  const seen = [];
  const other = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (q) => (seen.push(new URL(q.url).pathname), new Response("unrelated")) });
  const site = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    fetch: (q) => {
      const p = new URL(q.url).pathname;
      seen.push(p);
      if (p === "/lib/ok.json") return new Response("{}");
      if (p === "/lib/same.json") return Response.redirect(new URL("/lib/ok.json", q.url).href, 302);
      if (p === "/lib/cross.json") return Response.redirect(`http://127.0.0.1:${other.port}/x.json`, 302);
      if (p === "/lib/loop.json") return Response.redirect(q.url, 302);
      return new Response("", { status: 404 });
    },
  });
  globalThis.fetch = realFetch;
  const at = (f) => `http://127.0.0.1:${site.port}/lib/${f}`;
  try {
    ok(J(await preloadFetch([at("ok.json")], () => null)) === J([at("ok.json")]), "redirects: (control) a file answered directly is fetched");
    for (const f of ["same.json", "cross.json", "loop.json"]) {
      seen.length = 0;
      const done = await preloadFetch([at(f), at("ok.json")], () => null);
      ok(J(done) === "[]" && J(seen) === J([`/lib/${f}`]), `redirects: ${f}: refused, not followed, and the loop ends: ` + J([done, seen]));
    }
  } finally {
    site.stop(true);
    other.stop(true);
  }
}

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
  const asked3 = [];
  globalThis.fetch = async (u) => (asked3.push(u), { ok: false, status: 404 });
  ok(J(await preloadFetch(["f0", "f1"], () => null)) === "[]" && J(asked3) === '["f0"]', "a file answered 404: the loop ends, the next never asked: " + J(asked3));
  const asked4 = [];
  globalThis.fetch = async (u) => (asked4.push(u), { ok: true, body: null });
  ok(J(await preloadFetch(["n0", "n1"], () => null)) === "[]" && J(asked4) === '["n0"]', "a response without a body: the loop ends, the next never asked: " + J(asked4));
  // (the stall timer is re-armed at each piece: a file that keeps sending, each piece within stallMs, for longer
  // than stallMs in all, is fetched; one that sends a piece and then nothing is abandoned stallMs after that piece)
  const drip = (n, gap) => ({ getReader: () => { let i = 0; return { read: () => new Promise((r) => setTimeout(() => r(i++ < n ? { done: false, value: new Uint8Array(1) } : { done: true }), gap)) }; } });
  globalThis.fetch = async () => ({ ok: true, body: drip(8, 30) });
  ok(J(await preloadFetch(["d0"], () => null, 80)) === '["d0"]', "a file sending a piece every 30 ms for ~270 ms (stall 80 ms): fetched");
  const asked5 = [];
  globalThis.fetch = async (u, init) => {
    asked5.push(u);
    let i = 0;
    return { ok: true, body: { getReader: () => ({ read: () => (i++ === 0 ? new Promise((r) => setTimeout(() => r({ done: false, value: new Uint8Array(1) }), 60)) : new Promise((_, no) => init.signal.addEventListener("abort", () => no(new Error("aborted"))))) }) } };
  };
  const t1 = Date.now(), d5 = await preloadFetch(["q0", "q1"], () => null, 80), dt = Date.now() - t1;
  ok(J(d5) === "[]" && J(asked5) === '["q0"]' && dt >= 130 && dt < 1000, `a file that sends a piece at 60 ms and then nothing (stall 80 ms): abandoned ~140 ms in (${dt} ms), the next never started`);
}

// preloadSoon, the whole path with a stub page: a stub `extra`'s files (the LaTeX editor's, say) are fetched with the
// document's; too little storage: "no-room" and nothing fetched
{
  const nav = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const run = async (o, estimate) => {
    Object.defineProperty(globalThis, "navigator", { value: { onLine: true, storage: { estimate: async () => estimate } }, configurable: true, writable: true });
    globalThis.document = { visibilityState: "visible" };
    globalThis.location = { href: "https://sagebrush.space/" };
    Object.assign(preloadState, { outcome: null, urls: [], fetched: [] });
    const asked = [];
    globalThis.fetch = async (u) => (asked.push(u), { ok: true, body: body(1) });
    preloadSoon({ table: T, wait: 1, ...o });
    for (let i = 0; i < 200 && preloadState.outcome === null; i++) await new Promise((r) => setTimeout(r, 5));
    return [preloadState.outcome, asked];
  };
  const sci = intentUrls(T, ["sci"], "https://sagebrush.space/");
  const tex = ["https://sagebrush.space/sagebrush-latex.js", "https://sagebrush.space/sagebrush-latex-worker.js"];
  let [out, asked] = await run({ doc: () => ({ mode: "python", codes: ["import numpy"] }), extra: async () => ({ urls: tex, bytes: 300000 }) }, { quota: 1e9, usage: 0 });
  ok(out === "fetched" && J(asked) === J([...sci, ...tex]), "preloadSoon: the document's files, then the extra's (a .tex: the editor's two): " + J([out, asked]));
  [out, asked] = await run({ doc: () => ({ mode: "python", codes: [] }), extra: async () => ({ urls: tex, bytes: 300000 }) }, { quota: 1e9, usage: 0 });
  ok(out === "fetched" && J(asked) === J(tex), "preloadSoon: a plain notebook in a workspace with a .tex: the editor's two only: " + J([out, asked]));
  // (sci's 2,000 bytes need 8,000 free: 7,999 is too little)
  [out, asked] = await run({ doc: () => ({ mode: "python", codes: ["import numpy"] }) }, { quota: 10_000, usage: 2_001 });
  ok(out === "no-room" && J(asked) === "[]", "preloadSoon: too little storage: no-room, nothing fetched: " + J([out, asked]));
  [out, asked] = await run({ doc: () => ({ mode: "python", codes: ["import numpy"] }) }, { quota: 10_000, usage: 2_000 });
  ok(out === "fetched" && J(asked) === J(sci), "preloadSoon: (control) just enough storage: fetched: " + J([out, asked]));
  if (nav) Object.defineProperty(globalThis, "navigator", nav);
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
