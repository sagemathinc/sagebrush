// ci: web-runner order=291 runner=bun
// When the page says a lost workspace can't be detected (design/workspace-durability.md, part A; witness.ts decide,
// notice.ts showLossNotice): only when no record outside IndexedDB can be read, or neither can be written. WebKit's
// OPFS (Safari's, and the Mac app's web view) throws "an unknown transient reason" and never holds a record; the
// localStorage record alone tells a loss, so that is no reason to say it. And the sentence has no nested parentheses
// when the browser's own message has some.
//   bun web/workspace/test-loss-notice.mjs
import { decide, clause } from "./witness.ts";
import { showLossNotice } from "./notice.ts";

let fails = 0, checks = 0;
const ok = (c, what) => { checks++; console.log((c ? "ok   " : "FAIL ") + what); if (!c) fails++; };
const J = JSON.stringify;
const WEBKIT = "UnknownError: The operation failed for an unknown transient reason (e.g., out of memory).";
const fresh = { fresh: true, seq: 0 }, held = { fresh: false, workspace: "0123456789abcdef", generation: 1, seq: 3 };

// decide(): one record read with none there decides
ok(decide(fresh, [{ none: true }, { unreadable: WEBKIT }]).state === "first", "a first visit where OPFS can't be read (WebKit) is a first visit, not unknown");
ok(J(decide(held, [{ none: true }, { unreadable: WEBKIT }])) === J({ state: "ok" }), "an open workspace where OPFS can't be read: ok, nothing unavailable");
ok(decide(held, [{ unreadable: WEBKIT }, { none: true }]).state === "ok" && !decide(held, [{ unreadable: WEBKIT }, { none: true }]).unavailable, "...and the other way round (localStorage unreadable, OPFS read)");
const both = decide(fresh, [{ unreadable: "SecurityError: denied." }, { unreadable: WEBKIT }]);
ok(both.state === "unknown" && !/\(\s*[^()]*\(/.test(both.why) && !/\.\s*;|\.\)/.test(both.why), `neither record can be read: unknown, and its reason has no nested parentheses or stray periods: ${both.why}`);
ok(J(decide(held, [{ unreadable: "a" }, { unreadable: "b." }])) === J({ state: "ok", unavailable: "a; b" }), "neither readable, an open workspace: ok, with both reasons as clauses");
ok(clause(" x (e.g., y).  ") === "x (e.g., y)", "clause() drops the trailing period and spaces only");

// showLossNotice(): shown only when neither record can be written; its text
// (a document with just what showLossNotice uses)
const node = (tag) => {
  const n = { tag, children: [], style: {}, attrs: {}, dataset: {}, textContent: "", parent: null, id: "",
    setAttribute(k, v) { this.attrs[k] = v; }, addEventListener() {}, append(...cs) { for (const c of cs) if (typeof c === "object") { c.parent = this; this.children.push(c); } },
    remove() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); this.parent = null; } };
  return n;
};
const body = node("body");
const find = (n, f) => (f(n) ? n : n.children.map((c) => find(c, f)).find(Boolean) ?? null);
globalThis.document = { body, createElement: node, getElementById: (id) => find(body, (n) => n.id === id) };
const notice = (w) => { const el = showLossNotice(w); const t = el ? find(el, (n) => n.tag === "span")?.textContent ?? null : null; el?.remove(); return t; };
ok(notice({ durability: { state: "ok" }, witnessDown: { opfs: WEBKIT } }) === null, "OPFS alone can't be written (WebKit): no notice");
ok(notice({ durability: { state: "ok" }, witnessDown: { local: "QuotaExceededError." } }) === null, "localStorage alone can't be written: no notice (OPFS still tells)");
const t = notice({ durability: { state: "ok" }, witnessDown: { local: "QuotaExceededError.", opfs: WEBKIT } });
ok(t === `A lost workspace can't be detected in this browser: QuotaExceededError; ${WEBKIT.replace(/\.$/, "")}.`, `neither can be written: the notice, one sentence: ${t}`);
const u = notice({ durability: both });
ok(!!u && !/\)\)|\.\)|\)\.\)/.test(u) && u.endsWith(").") === WEBKIT.endsWith(").") && u.startsWith("A lost workspace can't be detected in this browser: no record"), `neither can be read: no "))" or ".)": ${u}`);

console.log(fails ? `${fails} of ${checks} failed` : `test-loss-notice: all ${checks} passed`);
process.exit(fails ? 1 : 0);
