// ci: web-sync.4 order=36 runner=bun
// What a reader's answer may change on a board in View (web/board/answer-only.ts; @sagebrush's ruling on #658): the
// answer state of one question item, never its design, another item, or the pages.
//   bun web/board/test-answer-only.mjs
import { answerOnly, ANSWER_STATE } from "./answer-only.ts";

let checks = 0;
const fails = [];
const ok = (c, what) => { checks++; console.log((c ? "ok   " : "FAIL ") + what); if (!c) fails.push(what); };
const clone = (x) => JSON.parse(JSON.stringify(x));
const q = (id, more = {}) => ({ id, kind: "ask", title: "Which?", input: "radio", options: ["a", "b"], check: "answer == 'a'", ...more });
const base = { title: "Quiz", nodes: [q("q1"), q("q2"), { id: "n1", title: "a note", text: "hello" }, { id: "g1", kind: "group", title: "G", children: [q("q3")] }] };
const paged = { title: "Quiz", pages: [{ title: "One", nodes: [q("q1")] }, { title: "Two", nodes: [q("q1"), q("q9")] }] };
const change = (d, f) => { const c = clone(d); f(c); return c; };

ok(JSON.stringify(ANSWER_STATE) === JSON.stringify(["answer", "note", "attempts", "wrongAttempts", "result"]), "the answer state: answer, note, attempts, wrongAttempts, result");
// (allowed: one question's answer state)
ok(answerOnly(base, change(base, (d) => { d.nodes[0].answer = "a"; })), "a radio's answer");
ok(answerOnly(base, change(base, (d) => { d.nodes[1].answer = ["a", "b"]; })), "checkboxes' answer");
ok(answerOnly(base, change(base, (d) => { d.nodes[0].note = "my own words"; })), "the reader's own words (note)");
ok(answerOnly(base, change(base, (d) => { Object.assign(d.nodes[0], { answer: "b", attempts: 2, wrongAttempts: 1, result: "wrong" }); })), "a checked attempt: answer, attempts, wrong attempts, verdict");
ok(answerOnly(change(base, (d) => { d.nodes[0].answer = "a"; d.nodes[0].result = "right"; }), base), "an answer cleared (removed)");
ok(answerOnly(base, change(base, (d) => { d.nodes[3].children[0].answer = "a"; })), "a question in a group");
ok(answerOnly(paged, change(paged, (d) => { d.pages[1].nodes[0].answer = "a"; })), "a question on another page (same id as page one's)");
ok(answerOnly(base, clone(base)), "no change at all");
// (refused: its design, another item, the pages, two questions)
for (const [what, f] of [
  ["its prompt", (d) => { d.nodes[0].title = "Which, really?"; }],
  ["its options", (d) => { d.nodes[0].options = ["a", "b", "c"]; }],
  ["its check", (d) => { d.nodes[0].check = "True"; }],
  ["its kind", (d) => { d.nodes[0].kind = "note"; }],
  ["another item (a note)", (d) => { d.nodes[2].text = "changed"; }],
  ["another item's answer-named field (a note's note)", (d) => { d.nodes[2].note = "x"; }],
  ["the board's title", (d) => { d.title = "Other"; }],
  ["an item added", (d) => { d.nodes.push({ id: "n2", title: "new" }); }],
  ["an item removed", (d) => { d.nodes.splice(2, 1); }],
  ["a question removed", (d) => { d.nodes.splice(1, 1); }],
  ["a question's id", (d) => { d.nodes[0].id = "qq"; }],
  ["two questions' answers at once", (d) => { d.nodes[0].answer = "a"; d.nodes[1].answer = "b"; }],
  ["an answer and a design change together", (d) => { d.nodes[0].answer = "a"; d.nodes[0].options = ["z"]; }],
  ["a group's title", (d) => { d.nodes[3].title = "H"; }],
]) ok(!answerOnly(base, change(base, f)), `refused: ${what}`);
ok(!answerOnly(paged, change(paged, (d) => { d.pages.push({ title: "Three", nodes: [] }); })), "refused: a page added");
ok(!answerOnly(paged, change(paged, (d) => { d.pages[0].title = "Uno"; })), "refused: a page's title");
ok(!answerOnly(paged, change(paged, (d) => { d.pages[0].nodes[0].answer = "a"; d.pages[1].nodes[0].answer = "a"; })), "refused: the same id's questions on two pages at once");
ok(!answerOnly(base, null) && !answerOnly(null, base), "refused: a document gone, or made");

console.log(fails.length ? `${fails.length} of ${checks} failed` : `all passed (${checks})`);
process.exit(fails.length ? 1 : 0);
