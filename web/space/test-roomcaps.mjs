// ci: web-browser/space order=7 runner=bun
// A file's room within the viewer's limits (src/pyroom.ts, src/jsroom.ts, src/coderoom.ts), in Bun (Sage's preparser
// is TypeScript): what is parsed is at most ROOM_TEXT bytes in UTF-8, after Sage's preparser too, and a Sage file the
// preparser would take long over (ELLIPSIS_BUDGET) isn't preparsed; and a room is checked
// whole before it is laid out, so one over the limits never is, Python's or JavaScript's. The sentinel is laid.rooms
// (src/roomlayout.ts), the count of layouts begun: a refused room leaves it as it was.
//   bun web/space/test-roomcaps.mjs
import { pythonRoom, ELLIPSIS_BUDGET } from "./src/pyroom.ts";
import { jsRoom } from "./src/jsroom.ts";
import { laid } from "./src/roomlayout.ts";
import { notebookRoom, parsed } from "./src/nbroom.ts";
import { LIMITS, ROOM_TEXT, utf8Bytes } from "./src/read.ts";
import { preparse } from "../../src/sagepre.ts";

let failures = 0;
const ok = (c, what, detail) => { console.log((c ? "ok   " : "FAIL ") + what + (c || detail === undefined ? "" : `: ${JSON.stringify(detail)}`)); if (!c) failures++; };
const refused = (f, re) => { try { f(); return null; } catch (e) { return re.test(String(e?.message)) ? true : String(e?.message); } };

// ---- Sage's preparser lengthens a file: what is parsed is held to ROOM_TEXT bytes (UTF-8) after it, exactly
{
  const gens = "R.<x> = QQ[]\n"; // 13 bytes; preparsed, 41
  const body = gens.repeat(40000); // 520,000 bytes; preparsed, 1,640,000
  ok(utf8Bytes(body) < ROOM_TEXT && utf8Bytes(preparse(body)) > ROOM_TEXT, "the sample is under the cap as written and over it preparsed", [utf8Bytes(body), utf8Bytes(preparse(body))]);
  ok(refused(() => pythonRoom(body, { path: "long.sage" }), /too long to enter/) === true, "a Sage file under 1 MiB that preparses to 1.6 MB isn't parsed");
  ok(pythonRoom("R = QQ[1, 2]\n".repeat(40000), { path: "long.py" }).nodes.length >= 1, "a Python file of the same length (not preparsed) is entered");
  // (exactly ROOM_TEXT preparsed: statements, then a comment of € and a's to fill it; a comment isn't preparsed)
  const stmts = gens.repeat(20000), head = utf8Bytes(preparse(stmts + "#\n"));
  const euros = 20000, fill = (extra) => stmts + "#" + "€".repeat(euros) + "a".repeat(ROOM_TEXT - head - 3 * euros + extra) + "\n";
  ok(utf8Bytes(preparse(fill(0))) === ROOM_TEXT && utf8Bytes(preparse(fill(1))) === ROOM_TEXT + 1, "the exact samples: 1,048,576 bytes preparsed, and one more", [utf8Bytes(preparse(fill(0))), utf8Bytes(preparse(fill(1)))]);
  let exact = null;
  try { exact = pythonRoom(fill(0), { path: "cap.sage" }); } catch (e) { exact = String(e?.message); }
  ok(typeof exact === "object" && exact?.nodes?.length >= 1, "a Sage file of exactly 1 MiB preparsed (€ in it) is entered", exact);
  ok(refused(() => pythonRoom(fill(1), { path: "cap.sage" }), /too long to enter/) === true, "one byte more preparsed isn't");
}

// ---- the preparser's time on ranges (\`..\`) grows as their number times the file's length: a Sage file over
//      ELLIPSIS_BUDGET isn't preparsed. Exactly at the bound it is; one range more isn't
{
  const L = 50000, file = (n) => "v = [1..2]\n".repeat(n) + "#" + "a".repeat(L - 11 * n - 2) + "\n";
  const at = ELLIPSIS_BUDGET / L; // 1,000 ranges in 50,000 bytes
  ok(utf8Bytes(file(at)) === L && utf8Bytes(file(at + 1)) === L && at * L === ELLIPSIS_BUDGET, "the samples: 50,000 bytes, with 1,000 ranges and 1,001");
  let r = null;
  try { r = pythonRoom(file(at), { path: "ranges.sage" }); } catch (e) { r = String(e?.message); }
  ok(r?.nodes?.length >= 1, "1,000 ranges in 50,000 bytes (5e7, the bound) are preparsed and entered", r);
  ok(refused(() => pythonRoom(file(at + 1), { path: "ranges.sage" }), /too long to enter/) === true, "1,001 ranges in the same length aren't");
  // (an ordinary Sage file with a few ranges)
  const plain = "R.<x> = QQ[]\nfor i in [1..10]:\n    print(i^2)\nv = [2,4..20]\ndef f(n):\n    return sum([1..n])\n";
  r = null;
  try { r = pythonRoom(plain, { path: "plain.sage" }); } catch (e) { r = String(e?.message); }
  ok(r?.nodes?.some((n) => n.name === "f"), "an ordinary Sage file with a few ranges is entered", r);
  // (the worst shape, "[1,..," over 1 MiB: refused before the preparser runs, in a child given a real deadline)
  const child = Bun.spawnSync(["bun", "-e", `import { pythonRoom } from ${JSON.stringify(new URL("./src/pyroom.ts", import.meta.url).pathname)};
    const s = "[1,..,".repeat(Math.floor((1 << 20) / 6));
    try { pythonRoom(s, { path: "worst.sage" }); console.log("entered"); } catch (e) { console.log(String(e?.message)); }`], { timeout: 10000, stdout: "pipe", stderr: "pipe" });
  const said = child.stdout.toString().trim();
  ok(child.exitCode === 0 && /too long to enter/.test(said), "a Sage file of 174,762 ranges in 1 MiB is refused at once (a child, within 10 s; preparsing it would take most of an hour)", { code: child.exitCode, said, signal: child.signalCode });
}

// ---- a room is checked whole before it is laid out, and refused ones never are (Python, then JavaScript)
const langs = {
  python: { room: (t) => pythonRoom(t, { path: "many.py" }), fn: (i, body) => `def f${i}():\n    ${body || "pass"}\n`, call: (j) => `f${j}()` },
  javascript: { room: (t) => jsRoom(t, { path: "many.js" }), fn: (i, body) => `function f${i}() { ${body} }\n`, call: (j) => `f${j}();` },
};
for (const [lang, L] of Object.entries(langs)) {
  const fns = (n) => Array.from({ length: n }, (_, i) => L.fn(i, "")).join("");
  // (n functions each calling every other: n(n-1) links)
  const calling = (n) => Array.from({ length: n }, (_, i) => L.fn(i, Array.from({ length: n }, (_, j) => j).filter((j) => j !== i).map(L.call).join(lang === "python" ? "; " : " "))).join("");
  let before = laid.rooms, r = null;
  try { r = L.room(fns(LIMITS.nodes)); } catch (e) { r = String(e?.message); }
  ok(r?.nodes?.length === LIMITS.nodes && r.nodes.every((n) => Array.isArray(n.position)) && laid.rooms === before + 1, `${lang}: a file of ${LIMITS.nodes} functions is laid out, once`, typeof r === "string" ? r : laid.rooms - before);
  before = laid.rooms;
  ok(refused(() => L.room(fns(LIMITS.nodes + 1)), /more than 4000 objects/) === true && laid.rooms === before, `${lang}: one function more is refused before any layout begins`, laid.rooms - before);
  before = laid.rooms;
  try { r = L.room(calling(141)); } catch (e) { r = String(e?.message); }
  ok(r?.edges?.length === 141 * 140 && laid.rooms === before + 1, `${lang}: 141 functions calling each other (19,740 links) are laid out`, typeof r === "string" ? r : r?.edges?.length);
  before = laid.rooms;
  ok(refused(() => L.room(calling(150)), /more than 20000 links/) === true && laid.rooms === before, `${lang}: 150 of them (22,350 links) are refused before any layout begins`, laid.rooms - before);
}

// ---- a notebook's room: its cells and code admitted before any cell is parsed (parsed.cells, the sentinel)
{
  const nb = (cells, mode = "python") => ({ format: "sagebrush-notebook-cells", mode, cells });
  const room = (x) => { try { return notebookRoom(x, { path: "n.ipynb" }); } catch (e) { return String(e?.message); } };
  // (code exactly ROOM_TEXT in all, over two cells, € in it; then one byte more)
  const half = ROOM_TEXT / 2, cell = (n, k) => ({ id: "c" + k, code: "x = 1\n#" + "€".repeat(1000) + "a".repeat(n - 7 - 3000) });
  const at = [cell(half, 1), cell(half, 2)];
  ok(at.reduce((n, c) => n + utf8Bytes(c.code), 0) === ROOM_TEXT, "the cells' code is exactly 1 MiB in UTF-8");
  let before = parsed.cells;
  const r1 = room(nb(at));
  ok(r1?.nodes?.length === 2 && parsed.cells === before + 2, "a notebook of exactly 1 MiB of code is entered", r1);
  before = parsed.cells;
  ok(/too long to enter/.test(room(nb([cell(half, 1), cell(half + 1, 2)]))) && parsed.cells === before, "one byte more: refused before any cell is parsed");
  // (as many cells as a space may have objects; one more is refused before any is parsed)
  const many = (n) => Array.from({ length: n }, (_, k) => ({ id: "c" + k, code: "x = " + k }));
  before = parsed.cells;
  const r2 = room(nb(many(LIMITS.nodes)));
  ok(r2?.nodes?.length === LIMITS.nodes && parsed.cells === before + LIMITS.nodes, `${LIMITS.nodes} cells are entered`, typeof r2 === "string" ? r2 : r2?.nodes?.length);
  before = parsed.cells;
  ok(/more than 4000 cells/.test(room(nb(many(LIMITS.nodes + 1)))) && parsed.cells === before, "one cell more: refused before any is parsed");
  // (the count stops at the first cell past the limit: the next isn't even looked at)
  let touched = false;
  const later = { id: "later", get code() { touched = true; return "y = 2"; } };
  ok(/too long to enter/.test(room(nb([{ id: "big", code: "#".repeat(ROOM_TEXT + 1) }, later]))) && !touched, "the count stops at the first cell past 1 MiB: the cell after it isn't read");
  // (Sage: the preparser's work on ranges, summed over the cells)
  const ranges = (k) => ({ id: "s" + k, code: "v = [1..2]\n".repeat(600) + "#" + "a".repeat(50000 - 6600 - 2) + "\n" }); // (600 ranges in 50,000 bytes: 3e7)
  ok(utf8Bytes(ranges(0).code) === 50000, "a Sage cell of 600 ranges in 50,000 bytes (3e7)");
  ok(room(nb([ranges(0)], "sage"))?.nodes?.length === 1, "one such cell is entered");
  before = parsed.cells;
  ok(/too long to enter/.test(room(nb([ranges(0), ranges(1)], "sage"))) && parsed.cells === before, "two (6e7 in all, over 5e7): refused before any is parsed");
}

console.log(failures ? `${failures} FAILED` : "all passed");
process.exit(failures ? 1 : 0);
