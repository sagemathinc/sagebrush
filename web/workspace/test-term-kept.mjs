// ci: web-runner order=164 runner=bun
// The Terminal's kept commands (term-kept.ts, William's H9 step 2): what is kept of a history, within its bounds, and
// a stored row read back.
//   bun web/workspace/test-term-kept.mjs
import { TERM_KEPT, keepable, termKeptOf } from "./term-kept.ts";

let checks = 0;
const fails = [];
const check = (ok, what) => { checks++; if (!ok) fails.push(what); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// (ignorespace: a command starting with a space or a tab isn't kept, nor a blank one, nor what isn't text)
check(same(keepable(["ls", " echo secret", "\tcat key", "   ", "", 7, null, "pwd"]), ["ls", "pwd"]), "a leading space or tab, a blank line or a non-string: not kept");
// (the newest 500)
const many = Array.from({ length: TERM_KEPT.entries + 20 }, (_, i) => "c" + i);
const k = keepable(many);
check(k.length === TERM_KEPT.entries && k[0] === "c20" && k.at(-1) === "c519", `at most ${TERM_KEPT.entries}, the newest (${k.length}, ${k[0]}..${k.at(-1)})`);
// (1 MiB of UTF-8 together: the oldest go; one longer than that alone isn't kept)
const big = "é".repeat(TERM_KEPT.bytes / 8); // (a quarter MiB of UTF-8 each: é is 2 bytes)
const b = keepable(["old", big + "1", big + "2", big + "3", big + "4", "new"]);
check(b.length === 4 && b[0] === big + "2" && b.at(-1) === "new", `1 MiB of UTF-8 together, the oldest out (${b.length} kept, from ${b[0]?.slice(-1)})`);
check(same(keepable(["a", "x".repeat(TERM_KEPT.bytes + 1), "b"]), ["a", "b"]), "a command longer than the bound alone: not kept, the others are");
const X = "x".repeat(TERM_KEPT.bytes - 1);
check(same(keepable(["a", X]), ["a", X]), "exactly 1 MiB together: all kept");
check(same(keepable(["ab", X]), [X]), "one byte over: the oldest out");
// (a stored row read back: anything malformed as nothing kept, a cwd that isn't a path as the top)
check(same(termKeptOf(undefined), { gen: 0, cwd: "/", history: [] }), "nothing stored: nothing kept");
check(same(termKeptOf({ gen: 3, cwd: "/a", history: ["ls", " x"] }), { gen: 3, cwd: "/a", history: ["ls"] }), "a row: its gen, cwd and the kept commands");
check(same(termKeptOf({ gen: -1, cwd: "a", history: "ls" }), { gen: 0, cwd: "/", history: [] }), "a malformed row: the defaults");
check(same(termKeptOf({ gen: 1.5, cwd: 5, history: [1, "ok"] }), { gen: 0, cwd: "/", history: ["ok"] }), "a fractional gen, a cwd not text: the defaults, the text commands kept");

if (fails.length) { console.error(`FAIL: ${fails.length} of ${checks} checks\n  ` + fails.join("\n  ")); process.exit(1); }
console.log(`ok: the Terminal's kept commands, ${checks} checks`);
