// Confinement phase 2: what a document's code may change, as both sides decide it (design: PACKET-r3, astra's and
// daybreak3's DESIGN CLEAR). Pure: the worker's check (web/worker.ts, with web/shims/fs.ts) and the page's ceilings
// and admission (web/index.html makeKernel) share these, and web/notebook/test-confine.mjs pins them.
//   - A write tree is a canonical folder ("/", or "/a/b"); it covers itself and what is below it, by path segment.
//   - The state of a list: "on" (it has "/"), "scoped" (some folders), "off" (none).
//   - A policy as the page sends it to the worker: {epoch, state, trees}. Anything else is no policy (fail closed).
//   - The worker's decision for a path: its held policy only, and only while the shared epoch equals the policy's.

/** Whether folder `t` covers path `p`: itself and what is below it, by segment ("/data" doesn't cover "/database"). */
export const covers = (t, p) => t === "/" || p === t || p.startsWith(t + "/");
export const stateOf = (trees) => (trees.includes("/") ? "on" : trees.length ? "scoped" : "off");
/** What both lists allow, as a list of folders without one inside another: never more than either. */
export function meetTrees(a, b) {
  const both = [...new Set([...a.filter((t) => b.some((c) => covers(c, t))), ...b.filter((t) => a.some((c) => covers(c, t)))])];
  return both.includes("/") ? ["/"] : both.filter((t) => !both.some((u) => u !== t && covers(u, t))).sort();
}
export const sameTrees = (a, b) => a.length === b.length && a.every((t, i) => t === b[i]);
/** The largest epoch used: past it, the page starts a new interpreter rather than wrap (never a stale equality). */
export const EPOCH_MAX = 2 ** 31 - 2;
const TREE = /^\/(?:[^/\u0000-\u001f]+(?:\/[^/\u0000-\u001f]+)*)?$/;
/** A policy as the page sends it ({epoch, state, trees}), checked; null for anything else. */
export function policyOf(v) {
  if (!v || typeof v !== "object" || !Number.isInteger(v.epoch) || v.epoch < 1 || v.epoch > EPOCH_MAX) return null;
  if (!["on", "off", "scoped"].includes(v.state) || !Array.isArray(v.trees) || v.trees.length > 64) return null;
  if (!v.trees.every((t) => typeof t === "string" && t.length <= 1024 && TREE.test(t) && !t.split("/").some((x) => x === "." || x === ".."))) return null;
  if (stateOf(v.trees) !== v.state) return null; // (the state says what the trees say, or neither is believed)
  return { epoch: v.epoch, state: v.state, trees: [...v.trees] };
}
/** The worker's decision for canonical path `p`, from the policy it holds and the epoch shared now: true, or why not
 * ("changed": no policy, or one of another epoch, whatever it says, "on" included; "refused": outside it). */
export function decide(held, epochNow, p) {
  if (!held || held.epoch !== epochNow) return "changed";
  if (held.state === "on") return true;
  if (held.state === "off") return "refused";
  return held.trees.some((t) => covers(t, p)) ? true : "refused";
}
