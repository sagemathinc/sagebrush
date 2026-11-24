// ci: web-browser/space order=7 runner=bun
// A file's room within the viewer's limits (src/pyroom.ts, src/jsroom.ts, src/coderoom.ts), in Bun (Sage's preparser
// is TypeScript): what is parsed is at most ROOM_TEXT bytes in UTF-8, after Sage's preparser too; and a room is checked
// whole before it is laid out, so one over the limits never is, Python's or JavaScript's. The sentinel is laid.rooms
// (src/roomlayout.ts), the count of layouts begun: a refused room leaves it as it was.
//   bun web/space/test-roomcaps.mjs
import { pythonRoom } from "./src/pyroom.ts";
import { jsRoom } from "./src/jsroom.ts";
import { laid } from "./src/roomlayout.ts";
import { LIMITS, ROOM_TEXT, utf8Bytes } from "./src/read.ts";
import { preparse } from "../../src/sagepre.ts";

let failures = 0;
const ok = (c, what, detail) => { console.log((c ? "ok   " : "FAIL ") + what + (c || detail === undefined ? "" : `: ${JSON.stringify(detail)}`)); if (!c) failures++; };
const refused = (f, re) => { try { f(); return null; } catch (e) { return re.test(String(e?.message)) ? true : String(e?.message); } };

// ---- Sage's preparser lengthens a file: what is parsed is held to ROOM_TEXT bytes (UTF-8) after it, exactly
{
  const body = "v = [1..2]\n".repeat(40000); // 440,000 bytes; preparsed, 1,400,000
  ok(utf8Bytes(body) < ROOM_TEXT && utf8Bytes(preparse(body)) > ROOM_TEXT, "the sample is under the cap as written and over it preparsed", [utf8Bytes(body), utf8Bytes(preparse(body))]);
  ok(refused(() => pythonRoom(body, { path: "long.sage" }), /too long to enter/) === true, "a Sage file under 1 MiB that preparses to 1.4 MB isn't parsed");
  ok(pythonRoom("v = [1, 2]\n".repeat(40000), { path: "long.py" }).nodes.length >= 1, "a Python file of the same length (not preparsed) is entered");
  // (exactly ROOM_TEXT preparsed: statements, then a comment of € and a's to fill it; a comment isn't preparsed)
  const stmts = "v = [1..2]\n".repeat(25000), head = utf8Bytes(preparse(stmts + "#\n"));
  const euros = 20000, fill = (extra) => stmts + "#" + "€".repeat(euros) + "a".repeat(ROOM_TEXT - head - 3 * euros + extra) + "\n";
  ok(utf8Bytes(preparse(fill(0))) === ROOM_TEXT && utf8Bytes(preparse(fill(1))) === ROOM_TEXT + 1, "the exact samples: 1,048,576 bytes preparsed, and one more", [utf8Bytes(preparse(fill(0))), utf8Bytes(preparse(fill(1)))]);
  let exact = null;
  try { exact = pythonRoom(fill(0), { path: "cap.sage" }); } catch (e) { exact = String(e?.message); }
  ok(typeof exact === "object" && exact?.nodes?.length >= 1, "a Sage file of exactly 1 MiB preparsed (€ in it) is entered", exact);
  ok(refused(() => pythonRoom(fill(1), { path: "cap.sage" }), /too long to enter/) === true, "one byte more preparsed isn't");
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

console.log(failures ? `${failures} FAILED` : "all passed");
process.exit(failures ? 1 : 0);
