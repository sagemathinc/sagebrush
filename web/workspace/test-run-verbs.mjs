// ci: web-runner order=185 runner=bun
// An agent's runs of code (chat plan PR 4a; packet r3 §5, §7, §11), the pure parts: the verbs' params (each limit and
// one over), W1's view (canonical first, then mapped; nothing outside has a spelling), the kept head and tail (at the
// boundary whole, one over cut, never inside a code point), the refused list's caps, the result's 256 KiB, inputHash
// against a fixture, and the reload record's "May run code" (never promoted).
//   bun web/workspace/test-run-verbs.mjs
import { parseReloadRecord } from "./agent-pair.ts";
import { runParams } from "./run-holder.ts";
import { RUN_LIMITS, RUN_TEXT, viewOf, canonical, Kept, refusedOut, bounded, inputHash, jsonBytes, notebookInputs, fitCells, pageRoom, Overlay } from "./run-verbs.ts";
import { createHash } from "node:crypto";

let checks = 0;
const fails = [];
const check = (ok, what) => { checks++; if (!ok) fails.push(what); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---- params (agent-pair.ts runParams): timeout_s 1 and 600 accepted; 0, 601 and a fraction refused
for (const [t, ok] of [[1, true], [600, true], [0, false], [601, false], [1.5, false], ["5", false]]) check((runParams("workspace.run_file", { path: "/a.py", timeout_s: t }) === null) === ok, `timeout_s ${JSON.stringify(t)}: ${ok ? "accepted" : "refused"}`);
check(runParams("workspace.run_file", { path: "/a.py" }) === null, "timeout_s left out: accepted");
check(runParams("workspace.run_notebook", { path: "/a.ipynb", extra: 1 }) !== null, "an unknown param: refused");
check(runParams("workspace.run_file", {}) !== null && runParams("workspace.run_file", { path: "" }) !== null && runParams("workspace.run_file", { path: "x".repeat(4097) }) !== null, "a missing, empty or over-long path: refused");
check(runParams("workspace.run_stop", {}) === null && runParams("workspace.run_stop", { path: "/a" }) !== null, "run_stop takes nothing");

// ---- W1 (§5): canonical first, then mapped; /Branches, /Trash and /Proposals have no spelling inside the view
const w = viewOf("/Branches/w1");
check(w.toReal("/") === "/Branches/w1" && w.toReal("/rv/a.csv") === "/Branches/w1/rv/a.csv", "W1: / is the branch, /x is the branch's x");
for (const bad of ["/../x", "/rv/../../x", "rv/a", "/rv//a", "/rv/./a", "/rv/", "/Branches/other/x", "/Trash/x", "/Proposals/p", "/a\u0001b"]) check(w.toReal(bad) === null, `W1: ${JSON.stringify(bad)} has no real path`);
check(w.toView("/Branches/w1/rv/a") === "/rv/a" && w.toView("/Branches/w1") === "/" && w.toView("/Branches/w2/a") === null && w.toView("/rv/a") === null && w.toView("/Branches/w1x/a") === null, "W1: only the branch's own paths are in the view");
const m = viewOf("");
check(m.toReal("/rv/a") === "/rv/a" && m.toReal("/Branches/w1/a") === null && m.toReal("/Trash/a") === null && m.toView("/Branches/w1/a") === null, "main: the real paths, without /Branches, /Trash and /Proposals");
check(canonical("/") && !canonical("") && !canonical("/a/") && !canonical("/a/..") && !canonical(5), "canonical: the one form");

// ---- the kept head and tail (§7): exact boundary whole, one over cut, never inside a code point
const H = RUN_LIMITS.cellHead, T = RUN_LIMITS.cellTail;
let k = new Kept(H, T); k.add("a".repeat(H + T));
check(k.text() === "a".repeat(H + T), "head + tail exactly: kept whole");
k = new Kept(H, T); k.add("a".repeat(H + T + 1));
check(k.text() === "a".repeat(H) + RUN_TEXT.cut(1) + "a".repeat(T), `one over: cut in the middle, said: ${k.text().length}`);
k = new Kept(4, 4); k.add("ab😀cd😀ef😀gh");
check(!/[\ud800-\udbff](?![\udc00-\udfff])|(^|[^\ud800-\udbff])[\udc00-\udfff]/.test(k.text()), `never half a code point: ${JSON.stringify(k.text())}`);
// (a cut that would fall inside a surrogate pair: the whole code point goes, never half of it)
k = new Kept(1, 8); k.add("a😀😀😀");
check(k.text() === "a" + RUN_TEXT.cut(4) + "😀😀", `a cut at a code point, never inside one: ${JSON.stringify(k.text())}`);
k = new Kept(4, 4); k.add('"'.repeat(5));
check(jsonBytes('"""""') === 10 && k.text() === '""' + RUN_TEXT.cut(2) + '""', `counted as JSON: an escape takes its 2 bytes: ${JSON.stringify(k.text())}`);
const S = RUN_LIMITS.streamHead + RUN_LIMITS.streamTail;
k = new Kept(RUN_LIMITS.streamHead, RUN_LIMITS.streamTail); for (let i = 0; i < 1000; i++) k.add("x".repeat(S / 100));
check(k.text().length < S + 40, "a stream of 10 times its bound: kept to its bound as it comes");

// ---- refused (§7, C3): 64 names and 16 KiB of path bytes, then "and N more"; unreadable ones only counted
const p64 = Array.from({ length: 64 }, (_, i) => `/r/${i}`);
check(same(refusedOut(p64, () => true), { paths: p64 }), "64 names: all said");
check(same(refusedOut([...p64, "/r/64"], () => true), { paths: p64, more: RUN_TEXT.more(1) }), "65: the 65th as \"and 1 more\"");
const big = [ "/" + "a".repeat(16 * 1024 - 1), "/b" ];
check(same(refusedOut([big[0]], () => true), { paths: [big[0]] }), "16 KiB of path bytes exactly: said");
check(same(refusedOut(big, () => true), { paths: [big[0]], more: RUN_TEXT.more(1) }), "one byte over: the next as \"and 1 more\"");
check(same(refusedOut(["/a", "/secret/x", "/secret/y"], (p) => !p.startsWith("/secret")), { paths: ["/a"], outside: RUN_TEXT.outside(2) }), "unreadable paths: never named, counted apart");

// ---- the result's 256 KiB (§7): whole at the bound, one over cut with truncated
const base = { ok: true };
const item = (n) => ({ out: "x".repeat(n) });
const room = (o) => new TextEncoder().encode(JSON.stringify(o)).length;
let lo = 1, hi = RUN_LIMITS.result;
while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (!bounded(base, [["cells", [item(mid)]]]).truncated) lo = mid; else hi = mid - 1; }
const atBound = bounded(base, [["cells", [item(lo)]]]), over = bounded(base, [["cells", [item(lo + 1)]]]);
check(!atBound.truncated && atBound.cells.length === 1 && room(atBound) <= RUN_LIMITS.result, `the largest item that fits: whole (${room(atBound)} bytes)`);
check(over.truncated?.reason === "the result is limited to 256.0 KB" && RUN_TEXT.notKept === "[output not kept: the notebook's outputs are over 8.0 MB]" && over.truncated?.reason === RUN_TEXT.truncated && over.cells.length === 0 && room(over) <= RUN_LIMITS.result, "one byte more: omitted, with truncated and its reason");

// ---- inputHash (§4) against a fixture computed here, never from the run's own bytes
const sha = (s) => createHash("sha256").update(s).digest("hex");
const nbIn = notebookInputs({ mode: "python", cells: [{ code: "print(1)", outputs: [{ text: "ignored" }] }, { type: "markdown", code: "t" }] });
check(new TextDecoder().decode(nbIn) === '{"mode":"python","cells":[{"type":"code","code":"print(1)"},{"type":"markdown","code":"t"}]}', "a notebook's inputs: language, kinds and sources, never outputs");
const fx = [{ view: "/b.txt", kind: "file", sha256: sha("x") }, { view: "/a.py", kind: "file", sha256: sha("print(1)\n") }];
const want = sha(`/a.py\tfile\t${sha("print(1)\n")}\n/b.txt\tfile\t${sha("x")}\n`);
check((await inputHash(fx)) === want, "inputHash: the fixture's precomputed value, sorted by path");

// ---- the reload record's run (Q5): present only as true; absent is a grant that may not run code
const rec = (g) => JSON.stringify({ v: 1, pairingId: "a".repeat(24), session: "A".repeat(43), port: 9000, agent: { name: "x", client: "y" }, grant: { folders: ["/"], write: true, expires: null, ...g }, workspace: "w", page: "/" });
check(parseReloadRecord(rec({}))?.grant.run === undefined, "a record without run: kept, and may not run code");
check(parseReloadRecord(rec({ run: true }))?.grant.run === true, "a record with run: true");
check(parseReloadRecord(rec({ run: false })) === null && parseReloadRecord(rec({ run: 1 })) === null, "run anything but true: no record");

// ---- fitCells (986-r6-2): over the limit by less than the omission note once a cell's output is gone: the note is
// counted too, so the result as sent (bounded, the note added) stays within 256 KiB with every cell listed
{
  const base = { ok: true, ended: "done", ms: 1, inputHash: "h".repeat(64), refused: { paths: [] }, saved: "not saved: main" };
  const size = (cells, note) => new TextEncoder().encode(JSON.stringify({ ...base, cells, ...(note ? { truncated: note } : {}) })).length;
  const at = (a) => [{ index: 0, status: "ok", out: "a".repeat(a) }, { index: 1, status: "ok" }];
  const a = RUN_LIMITS.result - 20 - size(at(0));
  const cells = [{ index: 0, status: "ok", out: "a".repeat(a) }, { index: 1, status: "ok", out: "b".repeat(1000) }];
  check(size(cells.slice(0, 1).concat([{ index: 1, status: "ok" }])) === RUN_LIMITS.result - 20, "(the case: 20 bytes under the limit with the second output gone, no note)");
  const cut = fitCells(base, cells);
  const out = bounded(base, [["cells", cells]]);
  if (cut && !out.truncated) out.truncated = { omitted: [`the output of ${cut} cell${cut === 1 ? "" : "s"}`], reason: RUN_TEXT.truncated };
  const bytes = new TextEncoder().encode(JSON.stringify(out)).length;
  check(bytes <= RUN_LIMITS.result && out.cells.length === 2 && !!out.truncated && !("out" in cells[1]), `over by less than the note after a trim: within the limit (${bytes}), both cells listed, the note there (${cut} cut)`);
  // (and the latest go first: never an earlier cell's output while a later one keeps its)
  const many = Array.from({ length: 50 }, (_, i) => ({ index: i, status: "ok", out: "m".repeat(8000) }));
  fitCells(base, many);
  const has = many.map((c) => "out" in c);
  check(has.includes(false) && has.lastIndexOf(true) < has.indexOf(false), `the latest cells' outputs trimmed first: ${has.filter(Boolean).length} kept, all before the first trimmed`);
}

// ---- latex_build (PR 4b): its params, its words, and the exact room for a page (daybreak2's Q3: R exact)
check(runParams("workspace.latex_build", { path: "/a.tex" }) === null && runParams("workspace.latex_build", { path: "/a.tex", pages: [1, 2, 3, 4], timeout_s: 600 }) === null, "latex_build: a path, and up to 4 pages");
for (const bad of [[], [1, 2, 3, 4, 5], [0], [1.5], ["1"], 3])
  check(runParams("workspace.latex_build", { path: "/a.tex", pages: bad }) === "pages must be 1 to 4 page or frame numbers, each 1 to 10,000", `latex_build: pages ${JSON.stringify(bad)} refused, board's words`);
check(runParams("workspace.run_file", { path: "/a.py", pages: [1] }) === "unknown param: pages", "pages only on latex_build");
check(RUN_TEXT.notLatex("/a.csv") === "invalid: /a.csv isn't a .tex file" && RUN_TEXT.noLatex === "no LaTeX: Sagebrush's LaTeX editor isn't available here", "latex_build's refusals: board's words");
{
  const head = { ok: true, ended: "done", ms: 1234, inputHash: "f".repeat(64), report: { file: "/a \"b\".tex", ok: true, problems: [{ message: "é\n\u0001" }] }, sagetex: { ran: 1, failed: 0, saved: "saved" }, refused: { paths: ["/x"] } };
  const want = [1, 2, 3, 4];
  const page = (n, len) => ({ n, w: 99999, h: 99999, png: "A".repeat(len) });
  const worst = (pages) => new TextEncoder().encode(JSON.stringify({ ...head, overflow: want, truncated: { omitted: [...want.map((n) => `page ${n}`), "x".repeat(64)], reason: RUN_TEXT.truncated }, pages })).length;
  const R0 = pageRoom(head, want, []);
  check(worst([page(99999, R0)]) === RUN_LIMITS.result && worst([page(99999, R0 + 1)]) === RUN_LIMITS.result + 1, `pageRoom: a PNG of exactly R bytes makes the worst-case result exactly 256 KiB, one more byte over (R ${R0})`);
  const kept = [{ n: 1, w: 816, h: 1056, png: "B".repeat(1000) }];
  const R1 = pageRoom(head, want, kept);
  check(worst([...kept, page(99999, R1)]) === RUN_LIMITS.result && R1 < R0 - 1000, `pageRoom: with a page kept, its bytes and fields counted: still exact (R ${R1})`);
  // (the real result is never larger than the worst case: smaller numbers, overflow and truncated at most as long)
  const real = new TextEncoder().encode(JSON.stringify({ ...head, overflow: [], pages: [{ n: 2, w: 754, h: 976, png: "A".repeat(R0) }] })).length;
  check(real <= RUN_LIMITS.result, `the real result with that PNG is within 256 KiB (${real} B)`);
}

// ---- latex_build's overlay (daybreak2's ruling): its bounds exactly, and one past each
{
  const MiB = 2 ** 20;
  let o = new Overlay();
  o.record("/a", new Uint8Array(40 * MiB)); o.record("/b", new Uint8Array(24 * MiB));
  check(o.bytes === 64 * MiB && o.map.get("/b") instanceof Uint8Array && !o.full, "overlay: exactly 64 MiB of latest bodies kept");
  o.record("/c", new Uint8Array(1));
  check(o.map.get("/c") === "over" && o.bytes === 64 * MiB && !o.full, "overlay: one byte past 64 MiB: kept only as over, authoritative");
  o.record("/a", new Uint8Array(10 * MiB));
  check(o.bytes === 34 * MiB && o.map.get("/a").length === 10 * MiB, "overlay: a replacement subtracts its old body first");
  o.record("/c", new Uint8Array(5));
  check(o.map.get("/c").length === 5 && o.bytes === 34 * MiB + 5, "overlay: an over path later replaced by a small body: the body kept");
  o.record("/b", null);
  check(o.map.get("/b") === null && o.bytes === 10 * MiB + 5 && o.map.size === 3, "overlay: a removal kept as null, its bytes released, its path still counted");
  for (let i = 0; i < 50; i++) o.record("/a", new Uint8Array(i));
  check(o.map.get("/a").length === 49 && o.bytes === 49 + 5 && o.map.size === 3, "overlay: repeated replacements of one path: one entry, its latest bytes");
  const data = new Uint8Array([1, 2, 3]);
  o.record("/d", data);
  check(o.map.get("/d") === data, "overlay: the body kept as given (the page's own copy), no further copy");
  o = new Overlay();
  for (let i = 0; i < RUN_LIMITS.overlayPaths; i++) o.record("/f" + i, null);
  check(o.map.size === 4096 && !o.full, "overlay: 4,096 distinct paths kept");
  o.record("/f0", new Uint8Array(1));
  check(!o.full, "overlay: an existing path again doesn't count anew");
  o.record("/one-more", null);
  check(o.full, "overlay: the 4,097th distinct path: full, the build fails closed");
  o = new Overlay();
  const long = (i) => "/" + String(i).padStart(4, "0") + "x".repeat(1024 - 6);
  for (let i = 0; i < 2048; i++) o.record(long(i), null);
  check(o.pathBytes === 2 * MiB - 2048 && !o.full, `overlay: path bytes just under 2 MiB (${o.pathBytes})`);
  o.record("/" + "y".repeat(2047), null);
  check(o.pathBytes === 2 * MiB && !o.full, "overlay: exactly 2 MiB of path bytes kept");
  o.record("/z", null);
  check(o.full, "overlay: one path byte past 2 MiB: full, the build fails closed");
}

if (fails.length) { console.error(`FAIL: ${fails.length} of ${checks} checks\n  ` + fails.join("\n  ")); process.exit(1); }
console.log(`ok: the runs' pure parts, ${checks} checks`);
