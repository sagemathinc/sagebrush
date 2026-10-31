// The lookalike report's controls (plan L2; grader's L2-a/b/c, astra's L-4 declaration): each rule undone in
// web/workspace/api.ts (a fixed text substitution, asserted to happen once), the site built, then
// test-workspace-lookalike.mjs runs the fixtures that cover the rule; exactly the declared checks must FAIL, at least
// one of them, and no other.  api.ts is in the page's own bundle, so each control builds the whole site (bun
// web/build.ts) with the file changed, and the file is put back (its sha256 checked) whatever happens; the site is
// built once more from the restored file at the end.
//   node web/workspace/test-workspace-lookalike-controls.mjs [name ...]   (a server on web/dist: SB_URL)
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url)), root = join(here, "..", "..");
const API = join(here, "api.ts");
const sha = (b) => createHash("sha256").update(b).digest("hex");
// (plan L2b r3 §4: each control's FAIL set, the fixture labels whose checks fail, predicted before the run and
// frozen in PLAN-r3.md (c2c9c15e); a control passes when the labels that fail EQUAL its set)
const ALL = ["none", "pair", "pair-between", "many-groups", "many-members", "trash", "move", "eof", "absent-nkey", "unique", "larger-than-page", "exactly-page", "page-plus-one", "two-pages-plus-one", "three-pages-then", "five-thousand", "boundary", "exact-end", "whole-page", "straddle-m1", "straddle-m9", "straddle-m10", "straddle-m11", "straddle-m5-n15", "concurrent", "eof-reject"];
const MULTI = ["unique", "larger-than-page", "exactly-page", "page-plus-one", "two-pages-plus-one", "three-pages-then", "five-thousand", "boundary", "exact-end", "whole-page", "straddle-m1", "straddle-m9", "straddle-m10", "straddle-m11", "straddle-m5-n15", "concurrent", "eof-reject"];
const STRADDLE = ["straddle-m1", "straddle-m9", "straddle-m10", "straddle-m11", "straddle-m5-n15"];
const IX = `      const ix = tx.objectStore("entries").index("byNfc");`;
const NEXT = `page(IDBKeyRange.lowerBound(k, true));`;
// [name, rule, [find, replace][], the predicted FAIL set (labels)]
const CONTROLS = [
  // (the store resumed by an nkey bound may page backwards for ever: the control's walk stops after 40 pages, so a
  // fixture fails rather than waits)
  ["L2-a", "the walk reads the byNfc index (not the store, in path order)", [[IX, `      const ix = tx.objectStore("entries") as unknown as IDBIndex;`], [NEXT, `if (((globalThis as any).__lkPages = ((globalThis as any).__lkPages ?? 0) + 1) < 40) page(IDBKeyRange.lowerBound(k, true)); else done();`]], ALL],
  ["L2-b", "every row of a page is grouped (none left out at a group's start)", [["        if (e.nkey !== key) { flush(); key = e.nkey as string; cur = []; n = 0; }", "        if (e.nkey !== key) { flush(); key = e.nkey as string; cur = []; n = 0; return; }"]], ["pair", "pair-between", "many-groups", "many-members", "trash", "move", "eof", "absent-nkey", "boundary", ...STRADDLE, "concurrent", "exact-end"]],
  ["L2-c", "each value read is counted (a counter never called fails the counts)", [["    const T = (globalThis as any).__SB_LOOKALIKE_TEST__ as LookalikeTest | undefined;", "    const T0 = (globalThis as any).__SB_LOOKALIKE_TEST__ as LookalikeTest | undefined, T = T0 && ({ ...T0, deliver: undefined } as LookalikeTest);"]], ALL.filter((x) => x !== "eof-reject")],
  ["value-first", "the resume cursor's first answer is advanced unread (not read and counted)", [["                return x.advance(m);", "                T?.deliver?.((x.value as Entry).path);\n                return x.advance(m);"]], ["straddle-m1", "straddle-m9", "straddle-m5-n15", "concurrent"]],
  ["advance-1", "advance(m), not m - 1", [["                return x.advance(m);", "                return x.advance(m - 1);"]], ["straddle-m1", "straddle-m9", "straddle-m5-n15", "concurrent"]],
  ["advance+1", "advance(m), not m + 1", [["                return x.advance(m);", "                return x.advance(m + 1);"]], ["straddle-m1", "straddle-m9", "straddle-m5-n15", "concurrent", "eof-reject"]],
  ["one-too-many", "the cursor reads exactly the shown rows it lacks", [["              if (++got < want) x.continue(); else group();", "              if (++got < want + 1) x.continue(); else group();"]], ["straddle-m1", "straddle-m9", "straddle-m5-n15", "concurrent"]],
  ["inclusive", "the next page starts after the group taken by key (exclusive)", [[NEXT, `if (((globalThis as any).__lkPages = ((globalThis as any).__lkPages ?? 0) + 1) < 40) page(IDBKeyRange.lowerBound(k)); else done();`]], MULTI],
  ["n-is-m", "a group's size is its count, not its rows in hand", [["            const total = T?.countFor ? T.countFor(k, c.result as number) : (c.result as number);", "            const total = m;"]], ["larger-than-page", "exactly-page", "page-plus-one", "two-pages-plus-one", "three-pages-then", "five-thousand", ...STRADDLE, "concurrent", "eof-reject"]],
  ["j+1", "the trailing run starts at its first row (not one later)", [["          while (j > 0 && rows[j - 1].nkey === k) j--;", "          while (j > 0 && rows[j - 1].nkey === k) j--;\n          if (j < len - 1) j++;"]], ["larger-than-page", "exactly-page", "page-plus-one", "two-pages-plus-one", "three-pages-then", "five-thousand", "boundary", "exact-end", "whole-page", "straddle-m9", "straddle-m10", "straddle-m11", "straddle-m5-n15", "concurrent", "eof-reject"]],
  ["full-is-end", "only a short page is the end", [["          if (len < LOOKALIKE_PAGE) {", "          if (len <= LOOKALIKE_PAGE) {"]], MULTI],
  ["count-lowerbound", "a group is counted over only(k)", [["          const c = ix.count(IDBKeyRange.only(k));", "          const c = ix.count(IDBKeyRange.lowerBound(k));"]], [...STRADDLE, "boundary", "three-pages-then", "unique", "whole-page"]],
  ["no-eof", "fewer rows than counted rejects", [[`              T?.mark?.("value");\n              if (!x) return no(new Error("the lookalike report's rows were fewer than counted"));`, `              T?.mark?.("value");\n              if (!x) return group();`]], ["eof-reject"]],
  ["two-tx", "the walk is one read-only transaction (not one per request)", [[IX, `      const one = () => tx.db.transaction("entries", "readonly").objectStore("entries").index("byNfc");\n      const ix = { getAll: (a: any, b: any) => one().getAll(a, b), count: (r: any) => one().count(r), openCursor: (r: any) => one().openCursor(r) };`]], ["concurrent"]],
  ["path-key", "a group is a run of one nkey (not of one path)", [["        if (e.nkey !== key) { flush(); key = e.nkey as string;", "        if (e.path !== key) { flush(); key = e.path;"]], ["pair", "pair-between", "many-groups", "many-members", "trash", "move", "eof", "absent-nkey", "boundary", "exact-end", "larger-than-page", "exactly-page", "page-plus-one", "two-pages-plus-one", "three-pages-then", "five-thousand", "whole-page", ...STRADDLE, "concurrent"]],
  ["basename-key", "a group is one folder's (not one name's across folders)", [["        if (e.nkey !== key) { flush(); key = e.nkey as string;", "        const bn = e.path.slice(e.path.lastIndexOf(\"/\") + 1).normalize(\"NFC\"); if (bn !== key) { flush(); key = bn;"]], ["pair"]],
  ["logical", "a path is shown at its logical place during a move", [["      const shown = (p: string) => (ev.active ? ev.ms.logicalOf(p).L : p);", "      const shown = (p: string) => p;"]], ["move"]],
  ["yield", "no other await between the walk's requests", [[NEXT, `setTimeout(() => page(IDBKeyRange.lowerBound(k, true)), 0);`]], [...MULTI, "no page errors"]],
];
const only = new Set(process.argv.slice(2));
const original = readFileSync(API);
const origSha = sha(original);
let bad = 0, built = false;
const build = () => spawnSync("bun", ["web/build.ts"], { cwd: root, encoding: "utf8", maxBuffer: 1 << 26 });
try {
  for (const [name, rule, subs, predicted] of CONTROLS) {
    if (only.size && !only.has(name)) continue;
    let text = original.toString("utf8");
    let err = null;
    for (const [find, repl] of subs) {
      const k = text.split(find).length - 1;
      if (k !== 1) { err = `the control's text is in api.ts ${k} times, not once: ${find.slice(0, 80)}`; break; }
      text = text.replace(find, () => repl);
    }
    if (err) { bad++; console.log(`FAIL ${name} (${rule}): ${err}`); continue; }
    try {
      writeFileSync(API, text);
      built = true;
      const b = build();
      if (b.status !== 0) { bad++; console.log(`FAIL ${name} (${rule}): the control's site didn't build: ${(b.stderr || b.stdout).slice(-400)}`); continue; }
    } finally {
      writeFileSync(API, original);
    }
    if (sha(readFileSync(API)) !== origSha) throw new Error("api.ts wasn't put back as it was");
    // (a report waited for 20 s at most under a control: a control's walk that never answers fails its fixture)
    const r = spawnSync(process.execPath, [join(here, "test-workspace-lookalike.mjs")], { encoding: "utf8", env: { ...process.env, LK_REPORT_MS: "20000" }, maxBuffer: 1 << 26 });
    // (each control's whole run kept, for its exact FAIL lines in full)
    writeFileSync(join(tmpdir(), `sb-lookalike-control-${name}.log`), (r.stdout ?? "") + (r.stderr ?? ""));
    const failed = [...new Set((r.stdout ?? "").split("\n").filter((l) => /^FAIL /.test(l)))];
    // (the failing labels: each FAIL line's label, its text before the first colon)
    const labels = [...new Set(failed.map((l) => l.slice(5).split(":")[0]))].sort(), want = [...new Set(predicted)].sort();
    const missing = want.filter((x) => !labels.includes(x)), extra = labels.filter((x) => !want.includes(x));
    const ok = missing.length === 0 && extra.length === 0;
    if (!ok) bad++;
    console.log(`${ok ? "ok  " : "FAIL"} ${name}: undone "${rule}": the failing labels ${ok ? "equal the prediction" : "DIFFER from the prediction"} (${labels.length} labels)${missing.length ? `; predicted but passed: ${missing.join(", ")}` : ""}${extra.length ? `; failed unpredicted: ${extra.join(", ")}` : ""}`);
    for (const l of failed) console.log(`     ${want.includes(l.slice(5).split(":")[0]) ? "named" : "OTHER"}: ${l.slice(5, 150)}`);
  }
} finally {
  writeFileSync(API, original);
  // (the site as the product is, built again from the restored file)
  if (built) { const b = build(); console.log(b.status === 0 ? "(the site built again from the restored api.ts)" : "FAIL the site couldn't be built again: " + (b.stderr || "").slice(-300)); if (b.status !== 0) bad++; }
}
console.log(sha(readFileSync(API)) === origSha ? "(api.ts as it was: " + origSha.slice(0, 16) + ")" : "FAIL api.ts changed");
console.log(bad ? `${bad} controls not as required` : "every control's checks failed, and only they");
process.exit(bad ? 1 : 0);
