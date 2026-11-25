// ci: web-sync.9 order=40 runner=bun
// Grading G2 step 1 (G2 r4, b51b4a30): points, slot sets, the rubric and comment codecs, the
// comment charge, the basis check and the anonymity handle. Pure; synthetic data only.
// Run with bun: `bun web/cloud/lti/grading/test-marks.mjs`.

import {
  questionPoints,
  encodeSlots,
  decodeSlots,
  validateRubricItem,
  validateComment,
  commentCharge,
  maxCommentCharge,
  checkBasis,
  memberHandle,
  handleLabel,
  MarksError,
  ANCHORS_MAX_BYTES,
} from "./marks.ts";
import { DOC_LIMITS, isCellId } from "../../../sync-protocol/doc-protocol.ts";

let failures = 0;
let passed = 0;
function check(name, ok, detail = "") {
  if (ok) passed++;
  else {
    failures++;
    console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
  }
}
const throws = (f, cls = Error) => {
  try {
    f();
    return false;
  } catch (e) {
    return e instanceof cls;
  }
};
const A = (points_c, state = "active") => ({ points_c, state });

// ---------------------------------------------------------------------------
// Points (§2.1)
{
  check("points: start zero, sum of active items", questionPoints(400, "zero", [A(150), A(100)], 0) === 250);
  check("points: clamp at P", questionPoints(400, "zero", [A(300), A(300)], 0) === 400);
  check("points: clamp at 0", questionPoints(400, "zero", [A(-100)], -50) === 0);
  check("points: start full, deductions", questionPoints(400, "full", [A(-100), A(-50)], 0) === 250);
  check("points: start full never exceeds P", questionPoints(400, "full", [A(100)], 25) === 400);
  check("points: a retired item counts 0", questionPoints(400, "zero", [A(150), A(200, "retired")], 0) === 150);
  check("points: the adjustment", questionPoints(400, "zero", [A(100)], 33) === 133);
  check("points: integer hundredths, no rounding", questionPoints(1_000_000, "zero", [A(333_333), A(333_333), A(333_334)], 0) === 1_000_000);
  check("points: P from the collection's own spec (two revisions, different P)", questionPoints(300, "full", [], 0) === 300 && questionPoints(500, "full", [], 0) === 500);
  check("points: a re-weight changes the result with nothing rewritten", questionPoints(400, "full", [A(-200)], 0) === 200 && questionPoints(400, "full", [A(-100)], 0) === 300);
  check("points: |δ| over 1,000,000 refused", throws(() => questionPoints(400, "zero", [], 1_000_001), RangeError));
  check("points: fractional P refused", throws(() => questionPoints(400.5, "zero", [], 0), RangeError));
}

// ---------------------------------------------------------------------------
// Slot sets
{
  const all = Array.from({ length: 64 }, (_, i) => i);
  check("slots: round trip, every slot", decodeSlots(encodeSlots(all)).join() === all.join());
  check("slots: bit 63 survives (8 bytes, not a JS number)", decodeSlots(encodeSlots([63])).join() === "63");
  check("slots: empty", decodeSlots(encodeSlots([])).length === 0 && encodeSlots([]).length === 8);
  check("slots: duplicates collapse, order normalized", decodeSlots(encodeSlots([5, 1, 5])).join() === "1,5");
  check("slots: 64 refused", throws(() => encodeSlots([64]), RangeError));
  check("slots: wrong length refused", throws(() => decodeSlots(new Uint8Array(7)), RangeError));
  check("slots: a large input is refused before any copy", throws(() => decodeSlots(new Uint8Array(1 << 20)), RangeError));
  const buf = new ArrayBuffer(16);
  new Uint8Array(buf)[9] = 1;
  check("slots: an offset Uint8Array view is decoded as itself", decodeSlots(new Uint8Array(buf, 8, 8)).join() === "8");
  check("slots: an ArrayBuffer of 8 bytes", decodeSlots(encodeSlots([0, 63]).buffer).join() === "0,63");
}

// ---------------------------------------------------------------------------
// The rubric item codec (§2.2)
{
  const item = (o = {}) => ({ question: "q1", slot: 0, label: "Missing units", description: "", points_c: -100, state: "active", pos: 0, ...o });
  check("rubric: valid", validateRubricItem(item()).label === "Missing units");
  check("rubric: a 200-unit label", validateRubricItem(item({ label: "\u{1F600}".repeat(100) })).label.length === 200);
  for (const [name, o] of [
    ["empty label", { label: "" }],
    ["label over 200 units", { label: "x".repeat(201) }],
    ["description over 1,000 units", { description: "x".repeat(1001) }],
    ["ill-formed Unicode", { label: "\ud800" }],
    ["slot 64", { slot: 64 }],
    ["fractional points", { points_c: 1.5 }],
    ["points over 1,000,000", { points_c: -1_000_001 }],
    ["bad state", { state: "deleted" }],
    ["bad question id", { question: "Q1" }],
    ["unknown field", { extra: 1 }],
  ])
    check(`rubric: refuses ${name}`, throws(() => validateRubricItem(item(o)), MarksError));
}

// ---------------------------------------------------------------------------
// Comments and their exact charge (§2.4, §6's cross-field rule; CORR-MARKS-1, CORR-MARKS-2)
{
  const key = { member: "m".repeat(64), question: "q".repeat(32), cid: "c".repeat(64) };
  const u8 = (x) => new TextEncoder().encode(x).length;
  const c = validateComment({ text: "Good, but check units: $x^2$", reason: "", anchors: ["cell-1"] }, 4000);
  check("comment: the charge is 1,024 + 2 × its stored UTF-8 bytes", commentCharge(c, key) === 1024 + 2 * (u8(c.text) + u8(JSON.stringify(c.anchors)) + 160));
  check("comment: the anchor bound is derived from DOC_LIMITS.cellId", ANCHORS_MAX_BYTES === 2 + 8 * (2 + 6 * DOC_LIMITS.cellId) + 7 && DOC_LIMITS.cellId === 128 && ANCHORS_MAX_BYTES === 6169);

  // anchors accept exactly what sync's isCellId accepts (CORR-MARKS-2): a round trip
  const accepts = (id) => {
    try {
      validateComment({ text: "", anchors: [id] }, 4000);
      return true;
    } catch (e) {
      if (!(e instanceof MarksError)) throw e;
      return false;
    }
  };
  const max = DOC_LIMITS.cellId;
  const samples = [
    "answer:1", "a@p1", "a@p2", "x~2", "0f3a9c", "Cell_1-b", "6f1c2b9e-4d7a-4c1e-9b2a-5d8c7e3f1a04",
    '"', "\\", 'q"uote\\back', "é", "\u{4E2D}", "\u{1F600}", "\ud800", "/", " ", "a b",
    "a".repeat(max), '"'.repeat(max), "\\".repeat(max), "\ud800".repeat(max), "\u{4E2D}".repeat(max),
    "", "a".repeat(max + 1), "\u0000", "a\u001fb", "\u007f", "tab\there", "line\nbreak",
  ];
  for (const id of samples)
    check(`anchor ${JSON.stringify(id.slice(0, 12))}${id.length > 12 ? "…" : ""}: marks accepts exactly when isCellId does`, accepts(id) === isCellId(id));
  for (const v of [1, null, undefined, {}, ["a"]]) check(`anchor ${JSON.stringify(v)} refused, as isCellId refuses it`, !accepts(v) && !isCellId(v));
  {
    // seeded: random strings over every class of UTF-16 unit, lengths 0..max + 2
    let seed = 11;
    const r = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
    const pool = ["a", "Z", "0", "_", "-", ":", "@", "~", '"', "\\", "é", "\u{4E2D}", "\ud83d", "\ude00", "\u0000", "\u001f", "\u007f", " "];
    let agree = true;
    for (let n = 0; n < 3000 && agree; n++) {
      const len = Math.floor(r() * (max + 3));
      let id = "";
      for (let i = 0; i < len; i++) id += pool[Math.floor(r() * pool.length)];
      agree = accepts(id) === isCellId(id);
      if (!agree) console.error("disagree on", JSON.stringify(id));
    }
    check("anchors: marks and isCellId agree on 3,000 seeded strings", agree);
  }

  // real board ids from core's cleanDoc and codeOrder are accepted, stored and charged
  {
    const { cleanDoc, codeOrder } = await import("../../../board/doc.ts");
    const boards = [
      cleanDoc({ mode: "python", nodes: [{ id: "answer:1", code: "1+1" }, { id: 'q"1\\x', code: "2" }] }),
      cleanDoc({ mode: "python", pages: [{ id: "one", nodes: [{ id: "a", code: "1" }] }, { id: "two", nodes: [{ id: "a", code: "2" }] }] }),
      cleanDoc({ mode: "python", pages: [{ id: "one", nodes: [{ id: "a", code: "1" }, { id: "a@p1", code: "3" }] }, { id: "two", nodes: [{ id: "a", code: "2" }] }] }),
    ];
    const ids = boards.flatMap((d) => codeOrder(d).map((cell) => cell.id));
    check("board ids: codeOrder generated a@p1/a@p2 style ids", ids.some((id) => /@p\d/.test(id)), JSON.stringify(ids));
    check("board ids: codeOrder kept answer:1", ids.includes("answer:1"), JSON.stringify(ids));
    for (const id of ids) {
      check(`board id ${JSON.stringify(id)}: a cell id, accepted as an anchor`, isCellId(id) && accepts(id));
      const cm = validateComment({ text: "see here", anchors: [id] }, 4000);
      check(`board id ${JSON.stringify(id)}: kept exactly, and charged its stored JSON bytes`, cm.anchors[0] === id && commentCharge(cm, key) === 1024 + 2 * (u8("see here") + u8(JSON.stringify([id])) + 160));
    }
  }

  // the worst accepted comment at each limit is exactly the bound: BMP 3-byte text and reason,
  // 8 anchors of 128 lone surrogates (6 bytes each, escaped), maximal ASCII keys
  for (const chars of [200, 4000, 16000]) {
    const worst = validateComment({ text: "\u{4E2D}".repeat(chars), reason: "\u{4E2D}".repeat(200), anchors: Array(8).fill("\ud800".repeat(max)) }, chars);
    const charge = commentCharge(worst, key);
    check(`comment: the worst accepted comment at ${chars} chars equals maxCommentCharge`, charge === maxCommentCharge(chars), `${charge} vs ${maxCommentCharge(chars)}`);
    check(`comment: maxCommentCharge(${chars}) = 1,024 + 2 × (3c + 600 + 6,169 + 160)`, maxCommentCharge(chars) === 1024 + 2 * (3 * chars + 600 + 6169 + 160));
    // astra's escaped cases are accepted now, and stay within the bound
    for (const fill of ['"', "\\"]) {
      const e = validateComment({ text: "\u{4E2D}".repeat(chars), reason: "\u{4E2D}".repeat(200), anchors: Array(8).fill(fill.repeat(max)) }, chars);
      check(`comment: 8 anchors of ${max} ${JSON.stringify(fill)} at ${chars} chars are within the bound`, commentCharge(e, key) <= maxCommentCharge(chars));
    }
  }
  {
    // a seeded property check: every accepted comment's charge is within the bound
    let seed = 7;
    const r = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
    const alphabet = ["a", "\u{4E2D}", "\u{10000}", "é", '"', "\\"];
    const idPool = ["A", "z", "0", ":", "@", "~", '"', "\\", "é", "\u{4E2D}", "\ud800"]; // (controls are refused, as tested above)
    let ok = true;
    let tried = 0;
    for (let n = 0; n < 2000 && ok; n++) {
      const chars = [200, 4000, 16000][n % 3];
      let text = "";
      while (text.length < Math.floor(r() * chars)) text += alphabet[Math.floor(r() * alphabet.length)];
      if (text.length > chars) text = text.slice(0, chars).replace(/[\ud800-\udbff]$/, "");
      const anchors = Array.from({ length: Math.floor(r() * 9) }, () => Array.from({ length: 1 + Math.floor(r() * max) }, () => idPool[Math.floor(r() * idPool.length)]).join(""));
      let cm;
      try {
        cm = validateComment({ text, reason: "\u{4E2D}".repeat(Math.floor(r() * 201)), anchors }, chars);
      } catch (e) {
        if (e instanceof MarksError) continue;
        throw e;
      }
      tried++;
      ok = commentCharge(cm, key) <= maxCommentCharge(chars);
    }
    check("comment: every seeded accepted comment is within maxCommentCharge", ok && tried > 100, String(tried));
  }

  check("comment: text over comment_chars refused", throws(() => validateComment({ text: "x".repeat(4001) }, 4000), MarksError));
  check("comment: 9 anchors refused", throws(() => validateComment({ text: "", anchors: Array(9).fill("a") }, 4000), MarksError));
  check("comment: a reason over 200 refused", throws(() => validateComment({ text: "", reason: "r".repeat(201) }, 4000), MarksError));
  check("comment: unknown field refused", throws(() => validateComment({ text: "", html: "<b>" }, 4000), MarksError));
  check("comment: ill-formed text refused", throws(() => validateComment({ text: "\udc00" }, 4000), MarksError));
}

// ---------------------------------------------------------------------------
// The basis (§2.6)
{
  const v = { value_sha256: "a".repeat(64), census_sha256: "b".repeat(64) };
  const w = { value_sha256: "c".repeat(64), census_sha256: "d".repeat(64) };
  const verified = { outcome: "verified", ...v };
  check("basis: verified match", checkBasis(verified, null, v) === "verified");
  check("basis: verified mismatch", checkBasis(verified, null, w) === null);
  check("basis: verified, census alone differs", checkBasis(verified, null, { ...v, census_sha256: "e".repeat(64) }) === null);
  const fr = { outcome: "failed_resource", value_sha256: null, census_sha256: null };
  check("basis: an open rebuild is not gradable", checkBasis(fr, { state: "open", first: null, second: null }, v) === null);
  check("basis: built", checkBasis(fr, { state: "built", first: v, second: null }, v) === "built");
  check("basis: conflict, the first slot", checkBasis(fr, { state: "conflict", first: v, second: w }, v) === "built");
  check("basis: conflict, the alternate", checkBasis(fr, { state: "conflict", first: v, second: w }, w) === "alternate");
  check("basis: built, the other triple refused", checkBasis(fr, { state: "built", first: v, second: null }, w) === null);
  check("basis: failed_integrity refused", checkBasis({ outcome: "failed_integrity", value_sha256: null, census_sha256: null }, null, v) === null);
}

// ---------------------------------------------------------------------------
// Handles (§3.1)
{
  const s1 = new Uint8Array(32).fill(1);
  const s2 = new Uint8Array(32).fill(2);
  const h1 = await memberHandle(s1, "member-1");
  const again = await memberHandle(s1, "member-1");
  const other = await memberHandle(s2, "member-1");
  check("handle: 128 bits", h1.length === 16);
  check("handle: stable for a placement's secret", h1.join() === again.join());
  check("handle: unlinkable across placements", h1.join() !== other.join());
  check("handle: label is Student + 8 base32 characters", /^Student [A-Z2-7]{8}$/.test(handleLabel(h1)), handleLabel(h1));
  check("handle: label of a known value", handleLabel(new Uint8Array(16)) === "Student AAAAAAAA" && handleLabel(new Uint8Array(16).fill(255)) === "Student 77777777");
  let threw = false;
  try {
    await memberHandle(new Uint8Array(16), "m");
  } catch {
    threw = true;
  }
  check("handle: a short secret refused", threw);
}

console.log(`test-marks: ${passed} passed, ${failures} failed`);
if (failures) process.exit(1);
