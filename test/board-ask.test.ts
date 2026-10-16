import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { askMarkdown, cleanDoc, layout, type DocAsk } from "../web/board/doc";
import { answerProblem, askProblems, asksOf, answerText, stepProblem } from "../web/board/ask";
import { checkText } from "../src/board-check";
import { submissionProblem } from "../src/board-answers";

// A board's questions (`kind: "ask"`): kept by the loader, shown as a note
// by a reader without controls, their answers checked, and read and written
// by `sagebrush board answers` (web/board/ask.ts, src/board-answers.ts).
const cli = join(__dirname, "..", "src", "cli.js");
const dir = mkdtempSync(join(tmpdir(), "sb-board-ask-"));
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
const run = (args: string[], input?: string) => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", cwd: dir, input });
const file = (name: string, d: unknown) => { const f = join(dir, name); writeFileSync(f, typeof d === "string" ? d : JSON.stringify(d, null, 1)); return f; };
const ask = (o: Partial<DocAsk> & { input: DocAsk["input"] }): DocAsk => ({ id: "q", kind: "ask", text: "Q?", ...o });

const BOARD = {
  format: "sagebrush-board", version: 1, title: "Decisions",
  pages: [
    { id: "intro", title: "What happened", nodes: [{ id: "n", text: "We did things." }] },
    {
      id: "decide", title: "Decisions", layout: "column",
      nodes: [
        { id: "plan", kind: "ask", text: "Which plan?", input: "radio", required: true, options: [{ value: "a", label: "Plan A" }, { value: "b", label: "Plan **B**" }] },
        { id: "g", kind: "group", title: "More", children: [{ id: "areas", kind: "ask", text: "Which modes?", input: "check", options: ["Python", "Sage", "MATLAB"] }] },
        { id: "sure", kind: "ask", text: "How sure?", input: "scale", low: "not at all", high: "very" },
        { id: "why", kind: "ask", title: "Anything else", input: "text", lines: 3, answer: "old answer" },
      ],
    },
  ],
};

test("the loader keeps a question as one; with an input it doesn't know, a note with its title and text (as an older reader shows it)", () => {
  const d = cleanDoc({ nodes: [
    { id: "a", kind: "ask", title: "T", text: "Q", input: "check", options: ["x", { value: "y", label: "Y" }, { value: 3 }, { value: "z", label: 4 }, 5], required: true, min: 1, max: Infinity, low: "l", answer: ["x"], color: "red", w: 300, extra: 1 },
    { id: "b", kind: "ask", title: "T2", text: "Q2", input: "slider", options: ["x"] },
    { id: "c", kind: "ask", input: "number", answer: NaN },
    { id: "e", kind: "ask", input: "check", answer: ["x", 1] },
    { id: "f", kind: "ask", input: "check", answer: false, required: "yes" },
  ] });
  assert.deepEqual(d.nodes, [
    { id: "a", kind: "ask", title: "T", text: "Q", input: "check", options: ["x", { value: "y", label: "Y" }, { value: "z" }], required: true, min: 1, low: "l", answer: ["x"], color: "red", w: 300 },
    { id: "b", title: "T2", text: "Q2" },
    { id: "c", kind: "ask", input: "number" },
    { id: "e", kind: "ask", input: "check" },
    { id: "f", kind: "ask", input: "check", answer: false },
  ]);
});

test("a question as a reader without controls shows it: its text, its options marked, its answer", () => {
  const radio = ask({ input: "radio", options: [{ value: "a", label: "Plan A" }, "b"], answer: "b", required: true });
  assert.equal(askMarkdown(radio), "Q?\n\n- ○ Plan A\n- ◉ b\n\n_required_");
  assert.equal(askMarkdown(ask({ input: "check", options: ["x", "y"], answer: ["y", "zz"] })), "Q?\n\n- ☐ x\n- ☑ y\n- ☑ `zz` (not one of the options)");
  assert.equal(askMarkdown(ask({ input: "check" })), "Q?\n\n☐ _(not answered yet)_");
  // (answered with nothing, and not answered: not the same, astra's 7383b15c note)
  assert.equal(askMarkdown(ask({ input: "check", options: ["x"], answer: [] })), "Q?\n\n- ☐ x\n\n_(answered: none chosen)_");
  assert.equal(askMarkdown(ask({ input: "check", options: ["x"] })), "Q?\n\n- ☐ x\n\n_(not answered yet)_");
  assert.equal(askMarkdown(ask({ input: "text", answer: " " })), "Q?\n\n_(answered: left empty)_");
  assert.equal(askMarkdown(ask({ input: "text" })), "Q?\n\n_(not answered yet)_");
  assert.equal(askMarkdown(ask({ input: "check", answer: true })), "Q?\n\n☑ yes");
  assert.equal(askMarkdown(ask({ input: "text", answer: "two\nlines" })), "Q?\n\n> two\n> lines");
  assert.equal(askMarkdown(ask({ input: "number", min: 0 })), "Q?\n\n_(not answered yet)_ · at least 0");
  assert.equal(askMarkdown(ask({ input: "scale", low: "no", answer: 4 })), "Q?\n\n**4** · from 1 (no) to 5");
  // (laid out as a note, its id kept: edges and tour steps name it)
  const { items } = layout(cleanDoc(BOARD.pages[1] as any));
  const plan = items.find((it) => it.id === "plan")!, areas = items.find((it) => it.id === "areas")!;
  assert.equal(plan.kind, "note");
  assert.match(plan.text!, /^Which plan\?\n\n- ○ Plan A\n- ○ Plan \*\*B\*\*/);
  assert.equal(areas.parent, "g");
  assert.equal(plan.w, 320);
});

test("an answer each input takes, and why not", () => {
  const opts = ["x", { value: "y", label: "Y" }];
  const cases: [Partial<DocAsk> & { input: DocAsk["input"] }, unknown, string | null][] = [
    [{ input: "check", options: opts }, ["y", "x"], null],
    [{ input: "check", options: opts }, [], null],
    [{ input: "check", options: opts }, ["x", "x"], '"x" is in its answer twice'],
    [{ input: "check", options: opts }, ["w"], `"w" is not one of its options' values ("x", "y")`],
    [{ input: "check", options: opts }, "x", "its answer is a list of its options' values (a check question takes any of them)"],
    [{ input: "check" }, true, null],
    [{ input: "check" }, ["x"], "a yes/no box's answer is true or false"],
    [{ input: "radio", options: opts }, "y", null],
    [{ input: "choice", options: opts }, "Y", `"Y" is not one of its options' values ("x", "y")`],
    [{ input: "radio", options: opts }, ["x"], "its answer is one of its options' values (a string)"],
    [{ input: "text" }, "", null],
    [{ input: "text" }, "a".repeat(10_001), "its answer is longer than 10000 characters"],
    [{ input: "number", min: 0, max: 1, step: 0.1 }, 0.3, null],
    [{ input: "number", min: 0, max: 1, step: 0.1 }, 0.35, "its answer 0.35 is not on its step, 0.1"],
    [{ input: "number", min: 0 }, -1, "its answer -1 is less than its min, 0"],
    [{ input: "number" }, Infinity, "its answer is a finite number"],
    [{ input: "scale" }, 5, null],
    [{ input: "scale" }, 6, "its answer 6 is not from 1 to 5"],
    [{ input: "scale", min: 0, max: 10 }, 2.5, "its answer is a whole number"],
  ];
  for (const [q, ans, want] of cases) assert.equal(answerProblem(ask(q), ans), want, JSON.stringify([q, ans]));
  // (off its step however many steps away; decimal steps still taken; steps that can't be counted refused: astra's CORR-738-1)
  assert.equal(answerProblem(ask({ input: "number", min: 0, step: 1 }), 1000000000.5), "its answer 1000000000.5 is not on its step, 1");
  assert.equal(answerProblem(ask({ input: "number", min: 0, step: 1 }), 100000000.1), "its answer 100000000.1 is not on its step, 1");
  // (exactly, each number the decimal it is written as, at any size: astra's bd46e6df and 5d768676)
  const ok = (v: number, from: number, step: number) => stepProblem(v, from, step);
  for (const [v, from, step] of [[1e9, 0, 1], [2 ** 53 - 1, 0, 1], [2 ** 53 - 2, 0, 2], [-(2 ** 53 - 1), 2 ** 53 - 1, 1], [9007199254740990, 10, 5], [0.3, 0, 0.1], [12345.7, 0, 0.1], [0.75, 0, 0.25],
    [-0.2, -1, 0.1], [0, 0, 0.1], [1.5, 0.5, 1], [2 ** 53 + 2, 0, 1], [2 ** 50 + 0.5, 0, 0.5], [1e308, -1e308, 1e300], [5, 0, 1e-320], [0, -1.2e18, 3e17]] as [number, number, number][])
    assert.equal(ok(v, from, step), null, JSON.stringify([v, from, step]));
  for (const [v, from, step] of [[2 ** 50 + 0.5, 0, 1], [1000000000000000.5, 0, 1], [0.35, 0, 0.1], [8, 1, 2], [0, -(2 ** 60), 0.75], [1e308, -1e308, 3e-300], [5, 0, 3e-320]] as [number, number, number][])
    assert.match(ok(v, from, step) ?? "", /is not on its step/, JSON.stringify([v, from, step]));
  // (2^60 is the decimal it is written as, 1152921504606847000, which 2^58's, 288230376151711740, doesn't divide: as a reader reads them)
  assert.match(ok(0, -(2 ** 60), 2 ** 58) ?? "", /is not on its step/);
  // (random starts, steps and counts at many sizes, against exact decimal arithmetic done apart: on the step accepted, half a step off refused)
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed / 2 ** 31; };
  const dec = (digits: number, exp: number) => { const n = BigInt(Math.floor(rnd() * 10 ** digits)) + 1n; return { n: rnd() < 0.5 ? -n : n, e: exp }; };
  const text = (d: { n: bigint; e: number }) => { const neg = d.n < 0n, s = (neg ? -d.n : d.n).toString(); return (neg ? "-" : "") + (d.e >= 0 ? s + "0".repeat(d.e) : (s.length > -d.e ? s.slice(0, d.e) + "." + s.slice(d.e) : "0." + "0".repeat(-d.e - s.length) + s)); };
  for (let i = 0; i < 2000; i++) {
    const e = Math.floor(rnd() * 40) - 20, f = dec(6, e + Math.floor(rnd() * 6)), st = { n: BigInt(Math.floor(rnd() * 999) + 1), e }, k = BigInt(Math.floor(rnd() * 10 ** 6)) - 500000n;
    const lo = Math.min(f.e, st.e), scale = (d: { n: bigint; e: number }) => d.n * 10n ** BigInt(d.e - lo);
    const on = { n: scale(f) + k * scale(st), e: lo }, half = { n: (scale(f) + k * scale(st)) * 2n + scale(st), e: lo };
    const [F, S, V] = [text(f), text(st), text(on)].map(Number);
    // (only numbers whose shortest form is that decimal: at most 15 significant digits)
    if ((on.n < 0n ? -on.n : on.n).toString().length > 15) continue;
    assert.equal(ok(V, F, S), null, JSON.stringify([text(on), text(f), text(st)]));
    const H = Number(text({ n: half.n * 5n, e: lo - 1 }));
    if ((half.n * 5n < 0n ? -half.n * 5n : half.n * 5n).toString().replace(/0+$/, "").length <= 15) assert.match(ok(H, F, S) ?? "", /not on its step/, JSON.stringify([H, F, S]));
  }
  assert.equal(answerProblem(ask({ input: "check", options: Array.from({ length: 101 }, (_, i) => String(i)) }), Array.from({ length: 101 }, (_, i) => String(i))), "its answer lists more than 100 values");
  assert.equal(answerText(ask({ input: "radio", options: opts, answer: "y" })), '"y" (Y)');
  assert.equal(answerText(ask({ input: "check", options: opts, answer: [] })), "(none chosen)");
});

test("a question's problems as written, past the schema", () => {
  const p = (q: Partial<DocAsk> & { input: DocAsk["input"] }) => askProblems(ask(q)).map((x) => `${x.level} ${x.field}: ${x.message}`);
  assert.deepEqual(p({ input: "radio", options: ["a", "b"] }), []);
  assert.deepEqual(p({ input: "radio", text: undefined }), ["error : a question with no `text` (nor `title`): the reader sees nothing to answer", "error options: a radio question needs `options`: the values the reader chooses one of"]);
  assert.deepEqual(p({ input: "check", options: ["a", { value: "a", label: "A" }] }), ['error options: the value "a" is in its options twice: an answer names one option']);
  assert.deepEqual(p({ input: "text", options: ["a"], lines: 0, step: 1 }), ["warning options: `options` are for check, radio and choice questions: a text question leaves them aside", "warning step: `step` is for a number question: a text question leaves it aside", "error lines: a text field's lines are a whole number from 1 to 50"]);
  assert.deepEqual(p({ input: "number", min: 2, max: 1, step: 0 }), ["error min: its min (2) is more than its max (1)", "error step: its step is more than 0"]);
  assert.deepEqual(p({ input: "scale", min: 1, max: 1000 }), ["error max: a scale of more than 100 values (from 1 to 1000): a number question takes a range"]);
  assert.deepEqual(p({ input: "scale", min: 3, max: 3 }), ["error min: its min (3) is not less than its max (3)"]);
  assert.deepEqual(p({ input: "radio", options: ["a"], answer: "b" }), [`error answer: "b" is not one of its options' values ("a")`]);
  assert.deepEqual(p({ input: "radio", options: Array.from({ length: 13 }, (_, i) => String(i)) }), ["warning input: 13 options: `choice` shows them as a list to choose from, which fits many"]);
});

test("the questions of a board, page by page, those in groups too", () => {
  assert.deepEqual(asksOf(cleanDoc(BOARD)).map((q) => [q.page, q.pageId, q.pageTitle, q.ask.id]), [[2, "decide", "Decisions", "plan"], [2, "decide", "Decisions", "areas"], [2, "decide", "Decisions", "sure"], [2, "decide", "Decisions", "why"]]);
  assert.deepEqual(asksOf(cleanDoc(BOARD.pages[1] as any)).map((q) => [q.page, q.pageId, q.ask.id]), [[1, undefined, "plan"], [1, undefined, "areas"], [1, undefined, "sure"], [1, undefined, "why"]]);
});

test("board check: a board's questions are checked, at their places in the file", () => {
  const bad = { format: "sagebrush-board", version: 1, nodes: [
    { id: "a", kind: "ask", text: "Q", input: "radio", options: ["x"], answer: "y" },
    { id: "g", kind: "group", children: [{ id: "b", kind: "ask", text: "Q", input: "scale", min: 5, max: 1 }] },
    { id: "c", kind: "ask", text: "Q", input: "slider" },
  ] };
  const got = checkText(JSON.stringify(bad)).problems;
  assert.deepEqual(got.map((p) => `${p.level} ${p.path}`), ["error nodes[2].input", "error nodes[0].answer", "error nodes[1].children[0].min"]);
  assert.match(got[0].message, /slider/);
  assert.equal(got[1].message, `"y" is not one of its options' values ("x")`);
  assert.equal(got[2].message, "its min (5) is not less than its max (1)");
  assert.deepEqual(checkText(JSON.stringify(BOARD)).problems, []);
});

test("board answers: the questions and their answers; --json for a program", () => {
  const f = file("d.board.json", BOARD);
  let r = run(["board", "answers", f]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, [
    "d.board.json: 4 questions, 1 answered; required, not answered: \"plan\"",
    "page 2 (Decisions):",
    "  plan [radio, required] Which plan?", "    (not answered)",
    "  areas [check] Which modes?", "    (not answered)",
    "  sure [scale] How sure?", "    (not answered)",
    "  why [text] Anything else", '    "old answer"', "",
  ].join("\n"));
  r = run(["board", "answers", "--json", f]);
  const j = JSON.parse(r.stdout);
  assert.deepEqual([j.answered, j.complete, j.missing], [1, false, [{ page: 2, id: "plan" }]]);
  assert.deepEqual(j.questions[0], { page: 2, pageId: "decide", pageTitle: "Decisions", id: "plan", input: "radio", text: "Which plan?", required: true, options: [{ value: "a", label: "Plan A" }, { value: "b", label: "Plan **B**" }], answer: null });
  assert.equal(run(["board", "answers", join(dir, "none.json")]).status, 1);
  assert.equal(run(["board", "answers"]).status, 2);
});

test("board answers --apply: a host's submission written into the board, checked; refused, nothing written", () => {
  const f = file("apply.board.json", BOARD), before = readFileSync(f, "utf8");
  let k = 0;
  const sub = (answers: unknown, extra: object = {}) => file(`sub-${++k}.json`, { sagebrush: "answers", version: 1, id: "8c6f0a5e-4d43-4b8e-9b0e-2f3c1a7d9e10", name: "d.board.json", revision: "r7", page: { number: 2, id: "decide" }, answers, comment: "thanks", ...extra });
  const refused: [string, string][] = [
    [sub({ areas: ["Python"] }), 'the required question "plan" is not answered'],
    [sub({ plan: "c" }), `the answer to "plan": "c" is not one of its options' values ("a", "b")`],
    [sub({ plan: "a", nope: 1 }), 'an answer to "nope", which is no question on page 2'],
    [sub({ plan: "a" }, { page: { number: 3 } }), "its page.number is not a page of the board (from 1 to 2)"],
    [sub({ n: "x" }, { page: { number: 1 } }), 'an answer to "n", which is no question on page 1'],
    [file("sub-x.json", { answers: {} }), "not a submission"],
    [sub({ plan: "a" }, { comment: 5 }), "its comment is not a string of at most 10000 characters"],
  ];
  for (const [s, why] of refused) {
    const r = run(["board", "answers", f, "--apply", s]);
    assert.equal(r.status, 1, why);
    assert.ok(r.stderr.includes(why), r.stderr);
    assert.match(r.stderr, /refused, nothing written/);
    assert.equal(readFileSync(f, "utf8"), before);
  }
  // (a good one: the page's answers replaced, a question left out unanswered; the rest of the file as it was)
  let r = run(["board", "answers", f, "--apply", sub({ plan: "b", areas: ["Sage", "Python"], sure: 4 })]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^apply\.board\.json: wrote the answers to page 2, with the comment "thanks"\napply\.board\.json: 4 questions, 3 answered\n/);
  assert.match(r.stdout, /plan \[radio, required\] Which plan\?\n    "b" \(Plan \*\*B\*\*\)\n/);
  const after = JSON.parse(readFileSync(f, "utf8"));
  const nodes = after.pages[1].nodes;
  assert.deepEqual([nodes[0].answer, nodes[1].children[0].answer, nodes[2].answer, "answer" in nodes[3]], ["b", ["Sage", "Python"], 4, false]);
  const expected = JSON.parse(before);
  expected.pages[1].nodes[0].answer = "b"; expected.pages[1].nodes[1].children[0].answer = ["Sage", "Python"]; expected.pages[1].nodes[2].answer = 4; delete expected.pages[1].nodes[3].answer;
  assert.deepEqual(after, expected);
  assert.deepEqual(readdirSync(dir).filter((x) => x.endsWith(".tmp")), []);
  // (-o: written there, the board as it was; --json says what was applied)
  const g = file("o.board.json", BOARD), o = join(dir, "out.board.json");
  r = run(["board", "answers", g, "--apply", sub({ plan: "a" }), "-o", o, "--json"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).applied, { page: 2, id: "8c6f0a5e-4d43-4b8e-9b0e-2f3c1a7d9e10", name: "d.board.json", revision: "r7", comment: "thanks" });
  assert.equal(JSON.parse(readFileSync(o, "utf8")).pages[1].nodes[0].answer, "a");
  assert.equal(readFileSync(g, "utf8"), JSON.stringify(BOARD, null, 1));
  // (a submission on standard input)
  r = run(["board", "answers", g, "--apply", "-", "-o", o], readFileSync(sub({ plan: "b" }), "utf8"));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(readFileSync(o, "utf8")).pages[1].nodes[0].answer, "b");
  // (a submission past 64 KiB: not read)
  r = run(["board", "answers", g, "--apply", sub({ plan: "a", why: "x".repeat(70_000) }), "-o", o]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /too large for a submission \(at most 64 KiB\)/);
  assert.equal(run(["board", "answers", g, "-o", o]).status, 2);
});

test("board answers --apply: a page whose questions are ambiguous or can't be answered is refused before anything is written (daybreak2's CORR-02C-1)", () => {
  const SUB = { sagebrush: "answers", version: 1, page: { number: 1 }, answers: { q: "a" } };
  // (two questions with one id: the board refuses such a document, and so does --apply; the check itself too)
  const twice = { format: "sagebrush-board", version: 1, nodes: [{ id: "q", kind: "ask", text: "Q", input: "radio", options: ["a"] }, { id: "g", kind: "group", children: [{ id: "q", kind: "ask", text: "Q", input: "number", required: true }] }] };
  const f = file("twice.board.json", twice), before = readFileSync(f, "utf8");
  let r = run(["board", "answers", f, "--apply", file("s1.json", SUB)]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /two items have the id "q"/);
  assert.equal(readFileSync(f, "utf8"), before);
  assert.equal(submissionProblem(cleanDoc(twice), SUB), 'two questions on page 1 have the id "q"');
  // (a question that can't be answered as written: a radio question without options)
  const bad = { format: "sagebrush-board", version: 1, nodes: [{ id: "q", kind: "ask", text: "Q", input: "radio", options: ["a"] }, { id: "r", kind: "ask", text: "R", input: "radio" }] };
  const g = file("bad.board.json", bad), was = readFileSync(g, "utf8");
  r = run(["board", "answers", g, "--apply", file("s2.json", SUB)]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /the question "r" can't be answered as written \(options: a radio question needs `options`/);
  assert.equal(readFileSync(g, "utf8"), was);
});

test("board answers --apply writes the board whole: a new file of a random name, its mode kept, nothing left when it fails (daybreak2's SEC-02C-2)", () => {
  const sub = file("s3.json", { sagebrush: "answers", version: 1, page: { number: 2 }, answers: { plan: "a" } });
  const sub2 = join(dir, "w");
  mkdirSync(sub2);
  const f = join(sub2, "m.board.json");
  writeFileSync(f, JSON.stringify(BOARD));
  chmodSync(f, 0o600);
  let r = run(["board", "answers", f, "--apply", sub]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(statSync(f).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(sub2), ["m.board.json"]);
  // (-o a directory: the rename fails; the new file is removed)
  const d = join(sub2, "adir");
  mkdirSync(d);
  r = run(["board", "answers", f, "--apply", sub, "-o", d]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /adir: /);
  assert.deepEqual(readdirSync(sub2).sort(), ["adir", "m.board.json"]);
});
