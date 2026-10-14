// outcache.ts (design/outputs.md, section 2): what a board's cache keeps
// when it is over its cap (unmarked entries first, least recently used
// first; marked ones only if they alone are over it), and which boards a
// browser over its cap drops whole (least recently used, never the one in
// use).   bun web/board/test-outcache.mjs
import { cachedLabel, dropOrder, sizeOf, sweepOrder } from "./outcache.ts";

let checks = 0;
const fails = [];
const check = (ok, what) => { checks++; if (!ok) fails.push(what); };

const e = (key, bytes, used) => ({ key, bytes, used });
const entries = [e("a", 40, 1), e("b", 40, 5), e("c", 40, 3), e("d", 40, 2), e("live1", 40, 0), e("live2", 40, 4)];
const live = new Set(["live1", "live2"]);
check(sweepOrder(entries, live, 1000).length === 0, "under the cap: nothing goes");
check(sweepOrder(entries, live, 160).join() === "a,d", "over it: unmarked entries, least recently used first: " + sweepOrder(entries, live, 160));
check(sweepOrder(entries, live, 80).join() === "a,d,c,b", "...all of them before any marked one");
check(sweepOrder(entries, live, 40).join() === "a,d,c,b,live1", "marked ones only when they alone are over it, least recently used first");
check(sweepOrder([], live, 0).length === 0, "an empty board: nothing");

const docs = [{ doc: "x", bytes: 300, used: 1 }, { doc: "y", bytes: 300, used: 3 }, { doc: "z", bytes: 300, used: 2 }, { doc: "me", bytes: 300, used: 0 }];
check(dropOrder(docs, "me", 2000).length === 0, "a browser under its cap: no board goes");
check(dropOrder(docs, "me", 700).join() === "x,z", "over it: boards least recently used first, whole: " + dropOrder(docs, "me", 700));
check(!dropOrder(docs, "me", 0).includes("me"), "never the board in use");

check(sizeOf([{ text: "é" }]) === JSON.stringify([{ text: "é" }]).length + 1, "sizes are bytes of UTF-8");
check(/^Computed .+ \(12 s\), kept in this browser\. Run to recompute\.$/.test(cachedLabel({ key: "k", outputs: [], at: "2026-10-13T12:00:00.000Z", ms: 1, total: 12345 })), "its label");

if (fails.length) {
  console.log(`${fails.length} of ${checks} checks failed:\n  ` + fails.join("\n  "));
  process.exit(1);
}
console.log(`${checks}/${checks} checks passed`);
