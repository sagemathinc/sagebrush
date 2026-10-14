// outcache.ts (design/outputs.md, section 2): what a board's cache keeps
// when it is over its cap (unmarked entries first, least recently used
// first; marked ones only if they alone are over it), and which boards a
// browser over its cap drops whole (least recently used, never the one in
// use).   bun web/board/test-outcache.mjs
import { DOC_CAP, ENTRY_MAX, MemoryOutputCache, cachedLabel, carriedOutputs, dropOrder, sizeOf, sweepOrder } from "./outcache.ts";

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

// what a downloaded board carries (section 3): checked, bounded, marked as the file's
const K = (c) => c.repeat(64);
const good = { key: K("a"), outputs: [{ output_type: "stream", name: "stdout", text: "hi\n" }], at: "2026-10-14T00:00:00.000Z", ms: 2100, total: 2100, where: "browser" };
const got = carriedOutputs([good, { key: "zz", outputs: [] }, { key: K("b"), outputs: "no" }, null, 7, { key: K("c"), outputs: [], ms: -5, total: NaN, at: 9 }, { key: K("d"), outputs: ["x".repeat(ENTRY_MAX + 1)] }]);
check(got.map((e) => e.key).join() === [K("a"), K("c")].join(), "carried outputs: only well-formed entries, none over ENTRY_MAX: " + got.length);
check(got.every((e) => e.where === "file") && got[1].ms === 0 && got[1].total === 0 && got[1].at === "", "...marked as the file's (whatever the file says), numbers and dates checked");
check(carriedOutputs({ key: K("a") }).length === 0 && carriedOutputs(null).length === 0, "...and nothing from what isn't a list");
const big = Array.from({ length: 6 }, (_, i) => ({ key: K(String(i)), outputs: ["x".repeat(15e6)] }));
check(carriedOutputs(big).length === Math.floor(DOC_CAP / sizeOf(big[0].outputs)), "...at most DOC_CAP in all: " + carriedOutputs(big).length);
check(/carried in this file/.test(cachedLabel(got[0])), "...and labelled so");
const mem = new MemoryOutputCache(got);
check((await mem.get("doc1", [K("a"), K("z")])).size === 1, "in memory: the carried outputs are the first board's that asks");
check((await mem.get("doc2", [K("a")])).size === 0, "...not another's");
await mem.drop("doc1");
check((await mem.get("doc1", [K("a")])).size === 0, "...and gone with it");
await mem.put("doc3", { key: K("e"), outputs: [], at: "", ms: 1, total: 3000 });
check((await mem.get("doc3", [K("e")])).get(K("e"))?.where === undefined, "what runs is kept until the page closes, as computed here");

if (fails.length) {
  console.log(`${fails.length} of ${checks} checks failed:\n  ` + fails.join("\n  "));
  process.exit(1);
}
console.log(`${checks}/${checks} checks passed`);
