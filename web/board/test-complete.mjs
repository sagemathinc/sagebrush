// A code item's Tab completions as the board takes them from its
// interpreter (code.ts admitCompletion): within COMPLETION_LIMITS and the
// contract (a prefix that ends the code before the caret, names that each
// begin with it), else refused whole (daybreak2's HARD-CH-1).
//   bun web/board/test-complete.mjs
import { admitCompletion, COMPLETION_LIMITS as L } from "./code.ts";

let checks = 0;
const fails = [];
const check = (ok, what) => { checks++; if (!ok) fails.push(what); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

check(same(admitCompletion({ matches: ["isinstance", "issubclass"], prefix: "is" }, "x = is"), { matches: ["isinstance", "issubclass"], prefix: "is" }), "an answer within the contract is taken");
check(same(admitCompletion({ matches: ["x.bit_count", "x.bit_length"], prefix: "x.bit_" }, "print(x.bit_"), { matches: ["x.bit_count", "x.bit_length"], prefix: "x.bit_" }), "...a dotted name's too");
check(same(admitCompletion({ matches: [], prefix: "zz" }, "zz"), { matches: [], prefix: "zz" }), "...none");
// (as many as numpy has: taken)
const np = Array.from({ length: 600 }, (_, i) => "np.f" + i);
check(admitCompletion({ matches: np, prefix: "np." }, "np.")?.matches.length === 600, "600 names, as numpy's: taken");
// refused: too many, too long, too much text, not names, a prefix that isn't the code's, names that don't complete it
check(admitCompletion({ matches: Array(L.matches + 1).fill("a"), prefix: "a" }, "a") === null, `more than ${L.matches} names: refused`);
check(admitCompletion({ matches: ["a" + "b".repeat(L.name)], prefix: "a" }, "a") === null, `a name longer than ${L.name}: refused`);
const long = Array.from({ length: Math.ceil(L.total / L.name) + 1 }, (_, i) => ("a" + i).padEnd(L.name, "x"));
check(long.length <= L.matches && admitCompletion({ matches: long, prefix: "a" }, "a") === null, `more than ${L.total} characters in all: refused`);
check(admitCompletion({ matches: ["ab", 3], prefix: "a" }, "a") === null, "a name that isn't a string: refused");
check(admitCompletion({ matches: ["ab"], prefix: "b".repeat(1e6) }, "a") === null, "a prefix longer than the code: refused");
check(admitCompletion({ matches: ["xy"], prefix: "x" }, "a") === null, "a prefix that doesn't end the code: refused");
check(admitCompletion({ matches: ["is", "print"], prefix: "is" }, "is") === null, "a name that doesn't begin with the prefix: refused");
check(admitCompletion({ matches: ["a"] }, "a") === null && admitCompletion({ prefix: "a" }, "a") === null && admitCompletion(null, "a") === null && admitCompletion("ab", "a") === null, "no prefix, no names, not an object: refused");
const kept = ["ab"], got = admitCompletion({ matches: kept, prefix: "a" }, "a");
kept.push("ac");
check(same(got?.matches, ["ab"]), "...and what is taken is a copy, not the interpreter's array");

console.log(`${checks - fails.length}/${checks} checks passed`);
for (const f of fails) console.log("FAIL", f);
process.exit(fails.length ? 1 : 0);
