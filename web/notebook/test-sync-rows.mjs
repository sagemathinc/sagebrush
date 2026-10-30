// web/notebook/sync-rows.js and stores.js's admission (plan-sync-slice2-client r4 §4, F1, F2, F8): sync's rows'
// keys, their bounds, their order and their charge; the one predicate; document ids that would reach sync's
// reserved range refused at every store opened and every import; sync rows owned by the workspace in both history
// databases.
//   bun web/notebook/test-sync-rows.mjs
import * as R from "./sync-rows.js";
import { IdbStore, IdbPatchStore, ownedByWorkspace, docIdProblem, isSyncKey, SYNC_KEY_PREFIX } from "./stores.js";
import { keepBundle } from "./bundle.js";

let checks = 0;
const fails = [];
const check = (ok, what) => { checks++; if (!ok) fails.push(what); };
const J = JSON.stringify;
const throws = (f, Kind = Error) => { try { f(); return false; } catch (e) { return e instanceof Kind; } };

// ---- the predicate and the prefix
check(SYNC_KEY_PREFIX === "\u0001" && R.SYNC_NB === "\u0001s:", "the prefix is \\u0001, sync's nb \\u0001s:");
check(isSyncKey("\u0001s:a") && isSyncKey("\u0001") && !isSyncKey("nb-1") && !isSyncKey("board:local:0123456789ab") && !isSyncKey("__sagebrush-workspace__") && !isSyncKey(1) && !isSyncKey(null), "isSyncKey: only nb keys beginning with \\u0001");
check(!isSyncKey("a\u0001s:b") && !isSyncKey(" \u0001"), "isSyncKey: the prefix at the start only, never inside a key");
check(R.isSyncKey === isSyncKey, "sync-rows.js re-exports stores.js's one predicate");

// ---- handles
check(R.handleOf(0) === "0" && R.handleOf(35) === "z" && R.handleOf(36) === "10", "handles: base 36");
check(R.handleOf(Number.MAX_SAFE_INTEGER).length <= 12, "the largest safe counter is a handle of at most 12 characters: " + R.handleOf(Number.MAX_SAFE_INTEGER));
check(throws(() => R.handleOf(-1), RangeError) && throws(() => R.handleOf(1.5), RangeError) && throws(() => R.handleOf("1"), RangeError), "handleOf refuses a negative, fractional or non-number counter");
check(J(R.docNb("a1")) === J("\u0001s:a1"), "docNb: the document's rows' nb");
for (const bad of ["", "A", "a b", "x".repeat(13), "a\u0001", 7]) check(throws(() => R.docNb(bad), RangeError), `docNb refuses ${J(bad)}`);

// ---- row keys: families, bounds
check(J(R.rowKey("a", "j")) === J(["\u0001s:a", "j"]), "rowKey: [nb, letter + rest]");
// (thirteen since P2b: "a", the merge mode a synced history asks for (a replay restore's legacy), plan-merge-align r3.2)
check(Object.values(R.FAMILIES).join("") === "lojprgcmxskza" && new Set(Object.values(R.FAMILIES)).size === 13, "thirteen families, each its own letter (F2)");
for (const [name, l] of Object.entries(R.FAMILIES)) check(R.rowKey("b", l, "q")[1] === l + "q", `family ${name}: ${l}`);
check(throws(() => R.rowKey("a", "q"), RangeError) && throws(() => R.rowKey("a", "ll"), RangeError), "an unknown family refused");
check(R.rowKey("a", "x", "y".repeat(39))[1].length === 40 && throws(() => R.rowKey("a", "x", "y".repeat(40)), RangeError), "a time of 40 characters is kept, 41 refused");
check(throws(() => R.rowKey("a", "x", "é"), RangeError) && throws(() => R.rowKey("a", "x", "\n"), RangeError) && throws(() => R.rowKey("a", "x", 3), TypeError), "a time is printable ASCII, a string");
// (lseq-ordered keys: string order is numeric order)
{
  const ns = [0, 1, 9, 10, 99, 100, 12345, 2 ** 40, Number.MAX_SAFE_INTEGER];
  const keys = ns.map((n) => R.seqKey("a", "l", n)[1]);
  check(keys.every((k) => k.length === 17) && J([...keys].sort()) === J(keys), "seqKey: 16 digits, string order is numeric order: " + keys.slice(0, 4).join(","));
  check(throws(() => R.seqKey("a", "l", -1), RangeError) && throws(() => R.seqKey("a", "l", 2 ** 53), RangeError) && throws(() => R.seqKey("a", "l", 0.5), RangeError), "seqKey refuses a negative, unsafe or fractional number");
}

// ---- the registry row
check(J(R.registryKey("acct:dev-1", "0123456789ab")) === J(["\u0001s:", "d:acct:dev-1:0123456789ab"]), "registryKey: [SYNC_NB, d:ns:doc]");
check(R.registryKey("n", "01234567-89ab-4cde-8f01-23456789abcd")[1].endsWith("cd"), "registryKey takes a uuid");
check(R.registryKey("n", "lq3k2x9a0bcdefgh")[1] === "d:n:lq3k2x9a0bcdefgh" && R.registryKey("n", "x".repeat(96))[1].length === 100, "registryKey takes a notebook's base-36 id, and one of 96 characters");
for (const [ns, doc] of [["", "0123456789ab"], ["n s", "0123456789ab"], ["n", ""], ["n", "a b"], ["n", "\u0001x"], ["n", "é"], ["n", "x".repeat(97)], ["x".repeat(129), "0123456789ab"]]) check(throws(() => R.registryKey(ns, doc), RangeError), `registryKey refuses ${J([ns, doc])}`);

// ---- the charge (F8): key and value as inert JSON, two bytes a character, plus 64
check(R.rowCharge(["a", "b"], { x: 1 }) === 2 * (J(["a", "b"]).length + J({ x: 1 }).length) + 64, "rowCharge: 2 × (key + value text) + 64");
check(R.rowCharge(["a"], "é") === 2 * (J(["a"]).length + 3) + 64, "…measured on the JSON text (a non-ASCII character is one)");
check(R.rowCharge(["a"], new Map()) === -1 && R.rowCharge(["a"], { f() {} }) === -1, "a value that isn't plain JSON data: -1, never written");

// ---- admission: ids that would reach the reserved range
const ok = ["nb-1", "0123456789ab", "01234567-89ab-4cde-8f01-23456789abcd", "board:local:0123456789ab", "x"];
const bad = ["", "\u0001s:a", "\u0001", "\u0000x", "\u001fx", "\u007fx", null, undefined, 7];
for (const id of ok) check(docIdProblem(id) === null, `docIdProblem accepts ${J(id)}`);
for (const id of bad) check(typeof docIdProblem(id) === "string", `docIdProblem refuses ${J(id) ?? String(id)}`);
const fakeDb = { name: "sagebrush-history" };
for (const id of bad) {
  check(throws(() => new IdbStore(null, id), TypeError), `IdbStore refuses the id ${J(id) ?? String(id)}`);
  check(throws(() => new IdbPatchStore(fakeDb, id), TypeError), `IdbPatchStore refuses the id ${J(id) ?? String(id)}`);
}
check(new IdbStore(null, "nb-1").id === "nb-1" && new IdbPatchStore(fakeDb, "nb-1").id === "nb-1", "an ordinary id is accepted as it is");
{
  let refused = null;
  try { await keepBundle({ blobs: {}, history: [] }, "\u0001s:a", {}); } catch (e) { refused = e; }
  check(refused instanceof TypeError, "keepBundle refuses an id in the reserved range before keeping anything");
  let fine = true;
  try { await keepBundle({ blobs: {}, history: [] }, "nb-1", {}); } catch { fine = false; }
  check(fine, "…and keeps an ordinary one (nothing to keep here)");
}

// ---- ownership: sync rows are the workspace's own in both history databases
check(ownedByWorkspace("sagebrush-history", "\u0001s:a") && ownedByWorkspace("sagebrush-board-history", "\u0001s:a") && ownedByWorkspace("sagebrush-board-history", "\u0001s:"), "sync rows owned in both history databases");
check(!ownedByWorkspace("sagebrush-board-history", "board:examples/own-test.json") && ownedByWorkspace("sagebrush-board-history", "board:local:0123456789ab") && ownedByWorkspace("sagebrush-history", "nb-1"), "…and the rest as before");

console.log(fails.length ? `FAIL: ${fails.length} of ${checks} checks\n  ` + fails.join("\n  ") : `${checks}/${checks} passed`);
process.exit(fails.length ? 1 : 0);
