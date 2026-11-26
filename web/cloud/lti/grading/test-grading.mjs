// ci: web-sync.9 order=20 runner=bun
// Grading G1 step 1: the spec validator, allocation and cards (G1 r5 §2.2–2.3, §3.3, §8).
// Pure modules, synthetic data only. Run with bun: `bun web/cloud/lti/grading/test-grading.mjs`.

import { validateSpec, toHundredths, parseStrictJson } from "./spec.ts";
import { allocate, submittedOrder } from "./allocate.ts";
import { buildCards, jcs } from "./cards.ts";

let failures = 0;
let passed = 0;
function check(name, ok, detail = "") {
  if (ok) passed++;
  else {
    failures++;
    console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
  }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const enc = (o) => (o instanceof Uint8Array ? o : new TextEncoder().encode(typeof o === "string" ? o : JSON.stringify(o)));

// A template: cells with positions; questions as [id, anchor, answers, points_c].
function setup(templateIds, questions, maxPoints) {
  const template = templateIds.map((id, i) => ({ id, pos: i }));
  const spec = {
    format: "sagebrush-grading-spec",
    v: 1,
    questions: questions.map(([id, anchor, answers, points_c = 100]) => ({
      id,
      title: `Question ${id}`,
      kind: "manual",
      points_c,
      anchor,
      answers,
    })),
  };
  const total = spec.questions.reduce((s, q) => s + q.points_c, 0);
  const r = validateSpec(enc(spec), template, maxPoints ?? total / 100);
  if (!r.ok) throw new Error(`setup: ${r.reason}`);
  return { spec: r.spec, templateIds: new Set(templateIds) };
}
const cells = (ids) => ids.map((id, i) => (typeof id === "string" ? { id, pos: i, cell_type: "code", input: id } : id));
// A compact view of an allocation: per card, [prompt, [cells with flags], card flags].
function view(a) {
  const f = (c) => (c.flags.length ? `${c.id}{${c.flags.join(",")}}` : c.id);
  return {
    cards: Object.fromEntries(
      a.cards.map((k) => [k.question, [k.prompt ? f(k.prompt) : null, k.cells.map(f), k.flags]]),
    ),
    before: a.before_first.map(f),
    excluded: a.excluded,
  };
}
function fixture(name, s, value, want) {
  const got = view(allocate(cells(value), s.spec, s.templateIds));
  check(`allocate: ${name}`, eq(got, want), `\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`);
}

// ---------------------------------------------------------------------------
// §2.3's ten fixtures, with exact expected allocations

{
  // 1. astra's trace: template q1 = (A; x), q2 = (B; y); submitted B, y, A, new, x
  const s = setup(["A", "x", "B", "y"], [["q1", "A", ["x"]], ["q2", "B", ["y"]]]);
  fixture("1 astra's trace", s, ["B", "y", "A", "new", "x"], {
    cards: { q1: ["A", ["new", "x"], []], q2: ["B", ["y"], ["reordered"]] },
    before: [],
    excluded: [],
  });
}
{
  // 2. fully reversed anchors, with a new cell after each anchor
  const t = ["A1", "A2", "A3", "A4", "A5"];
  const s = setup(t, t.map((a, i) => [`q${i + 1}`, a, []]));
  fixture("2 fully reversed", s, ["A5", "n5", "A4", "n4", "A3", "n3", "A2", "n2", "A1", "n1"], {
    cards: {
      // (q1 has no question before it in template order, so it can't be "reordered")
      q1: ["A1", ["n1"], []],
      q2: ["A2", ["n2"], ["reordered"]],
      q3: ["A3", ["n3"], ["reordered"]],
      q4: ["A4", ["n4"], ["reordered"]],
      q5: ["A5", ["n5"], ["reordered"]],
    },
    before: [],
    excluded: [],
  });
}
{
  // 3. owned answers moved before their own anchor, and into another question's region
  const s = setup(["A", "x", "B", "y"], [["q1", "A", ["x"]], ["q2", "B", ["y"]]]);
  fixture("3 moved answers", s, ["y", "A", "x", "B"], {
    cards: { q1: ["A", ["x"], []], q2: ["B", ["y{moved}"], []] },
    before: [],
    excluded: [],
  });
  fixture("3b moved into another region", s, ["A", "y", "x", "B"], {
    cards: { q1: ["A", ["x"], []], q2: ["B", ["y{moved}"], []] },
    before: [],
    excluded: [],
  });
}
{
  // 4. a missing middle question, with new cells where it was: they go to q1
  const s = setup(["A", "x", "B", "y", "C", "z"], [["q1", "A", ["x"]], ["q2", "B", ["y"]], ["q3", "C", ["z"]]]);
  fixture("4 missing middle", s, ["A", "x", "m1", "m2", "C", "z"], {
    cards: {
      q1: ["A", ["x", "m1", "m2"], []],
      q2: [null, [], ["prompt missing", "answer missing"]],
      q3: ["C", ["z"], []],
    },
    before: [],
    excluded: [],
  });
}
{
  // 5. a missing anchor whose answers survive
  const s = setup(["A", "x", "B", "y"], [["q1", "A", ["x"]], ["q2", "B", ["y"]]]);
  fixture("5 anchor missing, answer survives", s, ["A", "x", "y"], {
    cards: { q1: ["A", ["x"], []], q2: [null, ["y{moved}"], ["prompt missing"]] },
    before: [],
    excluded: [],
  });
}
{
  // 6. equal pos values, ties by id in UTF-16 order: U+10000 (a surrogate pair, D800 DC00)
  // sorts before U+E000 in UTF-16, though after it in UTF-8 and in code points
  const s = setup(["A"], [["q1", "A", []]]);
  const hi = "\u{10000}";
  const pua = "\u{E000}";
  const v = [
    { id: "A", pos: 0 },
    { id: pua, pos: 1 },
    { id: hi, pos: 1 },
    { id: "b", pos: 1 },
    { id: "a", pos: 1 },
  ];
  const got = view(allocate(v, s.spec, s.templateIds));
  check("allocate: 6 ties by UTF-16 order", eq(got.cards.q1[1], ["a", "b", hi, pua]), JSON.stringify(got.cards.q1[1]));
  check("submittedOrder: UTF-16, not code points", submittedOrder(v).map((c) => c.id).join("|") === ["A", "a", "b", hi, pua].join("|"));
}
{
  // 7. a non-finite and a missing pos: after every valid one, by id, flagged
  const s = setup(["A", "x"], [["q1", "A", ["x"]]]);
  const v = [{ id: "A", pos: 0 }, { id: "zz", pos: 1 }, { id: "x" }, { id: "n", pos: "3" }];
  const got = view(allocate(v, s.spec, s.templateIds));
  check(
    "allocate: 7 invalid positions",
    eq(got.cards.q1, ["A", ["zz", "n{position invalid}", "x{position invalid}"], []]),
    JSON.stringify(got.cards.q1),
  );
}
{
  // 8. new cells before the first anchor
  const s = setup(["A", "x"], [["q1", "A", ["x"]]]);
  fixture("8 before the first question", s, ["n1", "n2", "A", "x"], {
    cards: { q1: ["A", ["x"], []] },
    before: ["n1", "n2"],
    excluded: [],
  });
}
{
  // 9. template cells outside the spec, interleaved
  const s = setup(["intro", "A", "setup", "x", "B", "y", "outro"], [["q1", "A", ["x"]], ["q2", "B", ["y"]]]);
  fixture("9 excluded template cells", s, ["intro", "A", "setup", "x", "B", "y", "outro"], {
    cards: { q1: ["A", ["x"], []], q2: ["B", ["y"], []] },
    before: [],
    excluded: ["intro", "setup", "outro"],
  });
}
{
  // 10. an empty document; everything missing; Markdown and raw cells; not-run cells
  const s = setup(["A", "x"], [["q1", "A", ["x"]]]);
  fixture("10 empty document", s, [], {
    cards: { q1: [null, [], ["prompt missing", "answer missing"]] },
    before: [],
    excluded: [],
  });
  const v = [
    { id: "A", pos: 0, cell_type: "markdown", input: "## Q1" },
    { id: "x", pos: 1, cell_type: "code", input: "1+1" },
    { id: "r", pos: 2, cell_type: "raw", input: "raw" },
  ];
  const out = new Map([
    ["x", { state: "captured", full: "blob:x" }],
    ["A", { state: "captured", full: "blob:A" }],
  ]);
  const c = buildCards(v, s.spec, s.templateIds, out);
  check("cards: 10 Markdown prompt has no output", c.cards[0].prompt.cell_type === "markdown" && !("output" in c.cards[0].prompt));
  check("cards: 10 code answer keeps its output", c.cards[0].cells[0].output?.full === "blob:x");
  check("cards: 10 raw cell is source only", c.cards[0].cells[1].cell_type === "raw" && !("output" in c.cards[0].cells[1]));
  const notRun = buildCards(v, s.spec, s.templateIds);
  check("cards: 10 not-run cells have no output", !("output" in notRun.cards[0].cells[0]));
}

// a value with a duplicate cell id is refused, not allocated twice
{
  const s = setup(["A"], [["q1", "A", []]]);
  let threw = false;
  try {
    allocate([{ id: "A", pos: 0 }, { id: "A", pos: 1 }], s.spec, s.templateIds);
  } catch {
    threw = true;
  }
  check("allocate: duplicate ids refused", threw);
}

// ---------------------------------------------------------------------------
// Totality (a property test over seeded random reorderings, deletions and insertions)

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}
{
  const t = ["i0", "A", "x1", "x2", "s1", "B", "y1", "C", "z1", "z2", "o"];
  const s = setup(t, [["q1", "A", ["x1", "x2"]], ["q2", "B", ["y1"]], ["q3", "C", ["z1", "z2"]]]);
  const r = rng(12345);
  let ok = true;
  for (let n = 0; n < 2000 && ok; n++) {
    let ids = t.filter(() => r() > 0.2);
    for (let k = Math.floor(r() * 4); k > 0; k--) ids.splice(Math.floor(r() * (ids.length + 1)), 0, `new${n}_${k}`);
    ids = ids.map((id) => ({ id, pos: r() < 0.05 ? NaN : Math.floor(r() * 8) }));
    const a = allocate(ids, s.spec, s.templateIds);
    const placed = [
      ...a.cards.flatMap((k) => [...(k.prompt ? [k.prompt.id] : []), ...k.cells.map((c) => c.id)]),
      ...a.before_first.map((c) => c.id),
      ...a.excluded,
    ];
    const prompts = a.cards.every((k) => !k.prompt || s.spec.questions.find((q) => q.id === k.question).anchor === k.prompt.id);
    ok =
      placed.length === ids.length &&
      new Set(placed).size === ids.length &&
      ids.every((c) => placed.includes(c.id)) &&
      prompts &&
      a.cards.every((k) => k.cells.every((c) => c.role === "new" || s.spec.questions.find((q) => q.id === k.question).answers.includes(c.id)));
    if (!ok) console.error("totality counterexample:", JSON.stringify(ids));
  }
  check("allocate: totality over 2,000 seeded random documents", ok);
}

// ---------------------------------------------------------------------------
// Determinism: the same inputs give byte-identical JCS, whatever the key insertion order

{
  const s = setup(["A", "x", "B", "y"], [["q1", "A", ["x"]], ["q2", "B", ["y"]]]);
  const v1 = [
    { id: "B", pos: 2, cell_type: "code", input: "b" },
    { id: "x", pos: 1, cell_type: "code", input: "é ∑ \u{1F600}" },
    { id: "A", pos: 0, cell_type: "markdown", input: "a" },
    { id: "y", pos: 3, cell_type: "code", input: "y" },
  ];
  const v2 = [...v1].reverse().map((c) => Object.fromEntries(Object.entries(c).reverse()));
  const one = jcs(buildCards(v1, s.spec, s.templateIds));
  const two = jcs(buildCards(v2, s.spec, s.templateIds));
  check("cards: JCS byte-identical across input order", one === two);
  check("jcs: keys sorted by UTF-16", jcs({ b: 1, a: [1, 2.5, "x"], "\u{10000}": 0, "\u{E000}": 0 }) === '{"a":[1,2.5,"x"],"b":1,"\u{10000}":0,"\u{E000}":0}');
  let threw = false;
  try {
    jcs({ n: NaN });
  } catch {
    threw = true;
  }
  check("jcs: non-finite refused", threw);
}

// ---------------------------------------------------------------------------
// The spec: one refusal per rule (§2.2), template order, integer sums

{
  const template = ["A", "x", "B", "y", "C"].map((id, i) => ({ id, pos: i }));
  const q = (o = {}) => ({ id: "q1", title: "T", kind: "manual", points_c: 400, anchor: "A", answers: ["x"], ...o });
  const base = (qs, extra = {}) => ({ format: "sagebrush-grading-spec", v: 1, questions: qs, ...extra });
  const refused = (name, bytes, max, pattern, limits) => {
    const r = validateSpec(typeof bytes === "string" ? enc(bytes) : enc(bytes), template, max, limits);
    check(`spec refuses: ${name}`, !r.ok && pattern.test(r.reason), r.ok ? "accepted" : r.reason);
  };
  const okSpec = validateSpec(enc(base([q({ id: "q2", anchor: "B", answers: ["y"] }), q()])), template, 8);
  check("spec: a valid spec is accepted", okSpec.ok, okSpec.reason);
  check("spec: card order is the template order of anchors", okSpec.ok && okSpec.spec.questions.map((x) => x.id).join() === "q1,q2");
  check("spec: total in hundredths", okSpec.ok && okSpec.spec.total_c === 800);

  refused("duplicate key", '{"format":"sagebrush-grading-spec","v":1,"v":1,"questions":[]}', 0, /duplicate key "v"/);
  refused("unknown top-level field", base([], { extra: 1 }), 0, /unknown field "extra"/);
  refused("unknown question field", base([{ ...q(), note: "x" }]), 4, /unknown field "note"/);
  refused("missing field", base([(({ answers, ...r }) => r)(q())]), 4, /missing field "answers"/);
  refused("wrong format", { format: "x", v: 1, questions: [] }, 0, /format/);
  refused("wrong version", base([], { v: 2 }), 0, /v must be 1/);
  refused("bad id", base([q({ id: "Q1" })]), 4, /id must match/);
  refused("empty title", base([q({ title: "" })]), 4, /title/);
  refused("title over 200 UTF-16 units", base([q({ title: "\u{1F600}".repeat(101) })]), 4, /title/);
  refused("bad kind", base([q({ kind: "essay" })]), 4, /kind/);
  refused("fractional points", '{"format":"sagebrush-grading-spec","v":1,"questions":[{"id":"q1","title":"T","kind":"manual","points_c":400.0,"anchor":"A","answers":["x"]}]}', 4, /points_c must be an integer/);
  refused("negative points", base([q({ points_c: -1 })]), 4, /points_c/);
  refused("points over 1,000,000", base([q({ points_c: 1_000_001 })]), 10000.01, /points_c/);
  refused("anchor not in the template", base([q({ anchor: "Z" })]), 4, /isn't a cell of the template/);
  refused("answer not in the template", base([q({ answers: ["Z"] })]), 4, /isn't a cell of the template/);
  refused("anchors not distinct", base([q(), q({ id: "q2", answers: [] })]), 8, /in both question/);
  refused("a cell in two questions", base([q(), q({ id: "q2", anchor: "B", answers: ["x"] })]), 8, /in both question/);
  refused("a cell twice in one question", base([q({ answers: ["x", "x"] })]), 4, /named twice/);
  refused("duplicate question id", base([q(), q({ anchor: "B", answers: ["y"] })]), 8, /used twice/);
  refused("too many answers", base([q({ answers: Array(65).fill("x") })]), 4, /at most 64/);
  refused("questions over the limit", base([q(), q({ id: "q2", anchor: "B", answers: ["y"] })]), 8, /over grading\.questions_per_assignment/, { spec_bytes: 1 << 20, questions_per_assignment: 1 });
  refused("bytes over the limit", base([q()]), 4, /over grading\.spec_bytes/, { spec_bytes: 10, questions_per_assignment: 30 });
  refused("points sum off by one hundredth", base([q({ points_c: 401 })]), 4, /sum to 401 hundredths.*400 hundredths/);
  refused("max_points with three decimals", base([q()]), "4.001", /at most two decimals/);
  refused("invalid UTF-8", new Uint8Array([0x7b, 0xff, 0x7d]), 4, /UTF-8/);
  refused("a lone surrogate escape", '{"format":"sagebrush-grading-spec","v":1,"questions":[{"id":"q1","title":"\\ud800","kind":"manual","points_c":400,"anchor":"A","answers":["x"]}]}', 4, /ill-formed Unicode/);
  refused("trailing characters", JSON.stringify(base([q()])) + " x", 4, /trailing/);

  check("toHundredths: exact decimals", toHundredths("12.5") === 1250 && toHundredths(0.1) === 10 && toHundredths("3") === 300);
  check("parseStrictJson: plain JSON", eq(Object.keys(parseStrictJson('{"a":[1,"b",null,true]}')), ["a"]));
}

console.log(`test-grading: ${passed} passed, ${failures} failed`);
if (failures) process.exit(1);
