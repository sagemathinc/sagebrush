// within() (web/board/idb-open.ts), the bound on the board's cache read
// before it runs code: a result in time is that result and leaves no timer
// behind (the review's HARD-030-1); one too late is the fallback.
//   node web/board/test-idb-within.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
// (the module as the bundle has it, its types stripped: the repository's
// package is CommonJS, so Node would not load the .ts as a module itself)
const src = stripTypeScriptTypes(readFileSync(new URL("./idb-open.ts", import.meta.url), "utf8"));
const { within } = await import("data:text/javascript;base64," + Buffer.from(src).toString("base64"));

const live = new Set();
const set = globalThis.setTimeout, clear = globalThis.clearTimeout;
globalThis.setTimeout = (f, ms) => { const t = set(() => { live.delete(t); f(); }, ms); live.add(t); return t; };
globalThis.clearTimeout = (t) => { live.delete(t); clear(t); };

// fast: the result, and no timer left
for (let i = 0; i < 100; i++) assert.equal(await within(Promise.resolve(i), 2000, -1), i);
assert.equal(live.size, 0, `a fast result leaves no timer: ${live.size} left`);
// a rejection is passed on, and leaves no timer either
await assert.rejects(within(Promise.reject(new Error("no")), 2000, -1), /no/);
assert.equal(live.size, 0, "a rejection leaves no timer");
// slow: the fallback, at its deadline
const t0 = Date.now();
assert.equal(await within(new Promise(() => {}), 50, "fallback"), "fallback");
assert.ok(Date.now() - t0 >= 45, "the fallback comes at the deadline");
assert.equal(live.size, 0, "the deadline's timer is gone once it fired");
globalThis.setTimeout = set;
globalThis.clearTimeout = clear;
console.log("all passed");
