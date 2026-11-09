// ci: web-runner order=373 runner=bun
// Confinement phase 2's shared decisions (web/notebook/confine.js; the worker's check in web/worker.ts and the page's
// ceilings in web/index.html use these; design PACKET-r3): folders cover by path segment; the meet of two lists never
// allows more than either; a policy is believed only in its exact shape; the worker decides from the policy it holds,
// and only while the shared epoch is that policy's (both torn combinations refuse); scratch is /tmp and /$pyjs by
// segment (web/shims/fs.ts).
//   bun web/notebook/test-confine.mjs
import { covers, stateOf, meetTrees, sameTrees, policyOf, decide, EPOCH_MAX } from "./confine.js";
import { scratch } from "../shims/fs.ts";

const results = [];
const check = (ok, what, detail) => { results.push([!!ok, what]); if (!ok) console.log("FAIL", what, JSON.stringify(detail)?.slice(0, 400)); };
const J = JSON.stringify;

// ---- folders, by segment
check(covers("/data", "/data") && covers("/data", "/data/x/y") && !covers("/data", "/database") && !covers("/data", "/dat") && covers("/", "/anything") && !covers("/a/b", "/a"), "a folder covers itself and below it, by segment: /data not /database", null);
check(scratch("/tmp") && scratch("/tmp/x") && scratch("/$pyjs") && scratch("/$pyjs/m") && !scratch("/tmpfile") && !scratch("/tmp2/x") && !scratch("/$pyjsx") && !scratch("/a/tmp"), "scratch is /tmp and /$pyjs and below, by segment (/tmpfile, /tmp2, /$pyjsx are ordinary)", null);
check(stateOf([]) === "off" && stateOf(["/a"]) === "scoped" && stateOf(["/a", "/"]) === "on", "the state of a list: off, scoped, on", null);

// ---- the meet: never more than either list
const M = (a, b) => J(meetTrees(a, b));
check(M(["/"], ["/a", "/b"]) === J(["/a", "/b"]) && M(["/a", "/b"], ["/"]) === J(["/a", "/b"]) && M(["/"], ["/"]) === J(["/"]), "the meet with anywhere is the other list", null);
check(M(["/a"], ["/a/b"]) === J(["/a/b"]) && M(["/a/b"], ["/a"]) === J(["/a/b"]) && M(["/a"], ["/b"]) === J([]) && M([], ["/"]) === J([]), "the meet: the narrower of nested folders; nothing for disjoint ones or none", null);
check(M(["/a", "/b"], ["/b", "/c"]) === J(["/b"]) && M(["/data"], ["/database"]) === J([]), "the meet of overlapping lists: what both cover (/data and /database share nothing)", null);
// (a widening never raises it: the ceiling met with a wider list is the ceiling)
check(M(["/a"], ["/a", "/w"]) === J(["/a"]), "a widening of the trees doesn't widen the meet with the old ceiling", null);
check(sameTrees(["/a"], ["/a"]) && !sameTrees(["/a"], ["/a", "/b"]), "sameTrees", null);

// ---- a policy, as sent
const good = { epoch: 3, state: "scoped", trees: ["/a", "/b/c"] };
check(J(policyOf(good)) === J(good) && J(policyOf({ epoch: 1, state: "on", trees: ["/"] })) === J({ epoch: 1, state: "on", trees: ["/"] }) && J(policyOf({ epoch: 1, state: "off", trees: [] })) === J({ epoch: 1, state: "off", trees: [] }), "a policy in its shape is taken", null);
const bad = [null, 5, "x", {}, { ...good, epoch: 0 }, { ...good, epoch: 1.5 }, { ...good, epoch: EPOCH_MAX + 1 }, { ...good, state: "maybe" }, { ...good, trees: "/a" }, { ...good, trees: ["a"] }, { ...good, trees: ["/a/../b"] }, { ...good, trees: ["/a/./b"] }, { ...good, trees: ["/a//b"] }, { ...good, trees: ["/a/"] }, { ...good, trees: ["/a\u0001"] }, { ...good, state: "on" }, { ...good, state: "off" }, { epoch: 1, state: "scoped", trees: [] }, { ...good, trees: Array(65).fill("/a") }];
check(bad.every((v) => policyOf(v) === null), "anything else is no policy: a bad epoch, state or tree, or a state the trees don't say", bad.filter((v) => policyOf(v) !== null));

// ---- the worker's decision: only from the policy held, and only while the epoch is its own
const S = { epoch: 4, state: "scoped", trees: ["/a"] }, ON = { epoch: 4, state: "on", trees: ["/"] }, OFF = { epoch: 4, state: "off", trees: [] };
check(decide(S, 4, "/a/x") === true && decide(S, 4, "/b/x") === "refused" && decide(S, 4, "/ab") === "refused" && decide(ON, 4, "/z") === true && decide(OFF, 4, "/a") === "refused", "with its own epoch: scoped by folder, on anywhere, off nowhere", null);
// (torn: an old `on` with the new epoch published, and a new scoped/off with the old epoch still shared)
check(decide({ ...ON, epoch: 3 }, 4, "/z") === "changed" && decide({ ...S, epoch: 5 }, 4, "/a/x") === "changed" && decide({ ...OFF, epoch: 5 }, 4, "/x") === "changed", "both torn combinations refuse, `on` included: old on with the new epoch; a new policy with the old one", null);
check(decide(null, 4, "/a") === "changed" && decide(null, 0, "/a") === "changed", "no policy held: refused", null);

const failed = results.filter(([ok]) => !ok);
if (failed.length) { console.log(`FAIL: ${failed.length} of ${results.length}`); process.exit(1); }
console.log(`ok: confinement phase 2's decisions, ${results.length} checks`);
