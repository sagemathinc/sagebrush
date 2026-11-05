// ci: web-sync.4 order=37 runner=bun
// The board editor's commit gate in View (web/board/edit.ts, Editor.commit; @sagebrush's ruling on #658, grader's
// C2): outside Edit nothing is written unless the caller says whose change it is, and an "answer" may change only
// the answer state of one question (answer-only.ts), never the design, another item or the pages. test-answer-only.mjs
// pins answerOnly() itself; this pins the gate that uses it, on the editor itself (a stand-in board: no page).
//   bun web/board/test-commit-gate.mjs
const et = () => new EventTarget();
globalThis.window ??= et();
globalThis.document ??= Object.assign(et(), { activeElement: null });
const { Editor } = await import("./edit.ts");

let checks = 0;
const fails = [];
const check = (ok, what) => { checks++; if (!ok) fails.push(what); };

// (a stand-in board: what the editor sets on it kept, every method it calls a no-op)
const el = Object.assign(et(), { classList: { toggle() {} }, style: {} });
const board = new Proxy({ el }, { get: (t, k) => (k in t ? t[k] : () => null), set: (t, k, v) => ((t[k] = v), true) });
const start = () => ({
  format: "sagebrush-board", version: 1,
  nodes: [
    { id: "q1", kind: "ask", prompt: "2+2?", check: "4" },
    { id: "q2", kind: "ask", prompt: "3+3?", check: "6" },
    { id: "n", title: "a note" },
  ],
});
let doc = start(), writes = 0;
const ed = new Editor(board, () => doc, async (d) => { doc = d; writes++; });
const same = (what) => JSON.stringify(doc) === JSON.stringify(what);
const q = (d, id) => d.nodes.find((n) => n.id === id);

// ---- View (the editor starts there)
check(ed.on === false, "the editor starts in View");
let before = structuredClone(doc);
check((await ed.commit((d) => { q(d, "n").title = "changed"; })) === null && same(before) && writes === 0, "C1: in View, a change no one claims: refused, nothing written");
check((await ed.commit((d) => { q(d, "q1").answer = "4"; }, false, true, "answer")) !== null && q(doc, "q1").answer === "4" && writes === 1, "in View, an answer to one question: kept");
before = structuredClone(doc);
check((await ed.commit((d) => { q(d, "q1").answer = "5"; q(d, "n").title = "changed"; }, false, true, "answer")) === null && same(before), "C2: in View, an \"answer\" that also changes another item: refused, the document unchanged");
check((await ed.commit((d) => { q(d, "q1").answer = "5"; q(d, "q1").prompt = "2+3?"; }, false, true, "answer")) === null && same(before), "C2: …that also changes the question's own design (its prompt): refused");
check((await ed.commit((d) => { q(d, "q1").answer = "5"; q(d, "q2").answer = "6"; }, false, true, "answer")) === null && same(before), "C2: …that answers two questions at once: refused");
check((await ed.commit((d) => { q(d, "q1").answer = "5"; d.nodes.push({ id: "x", title: "added" }); }, false, true, "answer")) === null && same(before), "C2: …that adds an item: refused");
check((await ed.commit((d) => { q(d, "q1").answer = "5"; d.title = "renamed"; }, false, true, "answer")) === null && same(before), "C2: …that changes the board itself: refused");
check(writes === 1, "…and none of those wrote anything: " + writes);
// (the page's own change, "page": its own grants)
check((await ed.commit((d) => { q(d, "n").title = "by the page"; }, false, true, "page")) !== null && q(doc, "n").title === "by the page", "in View, the page's own change (\"page\"): kept");

// ---- Edit: an "answer" is an edit like any other
ed.setOn(true);
check(ed.on === true, "(Edit)");
check((await ed.commit((d) => { q(d, "q1").answer = "4"; q(d, "n").title = "in Edit"; }, false, true, "answer")) !== null && q(doc, "n").title === "in Edit", "in Edit, an \"answer\" with a design change: kept (it's an edit)");

// ---- a host that doesn't allow Edit: setOn(true) refused
ed.setOn(false);
ed.allowed = false;
ed.setOn(true);
check(ed.on === false, "Edit not allowed: setOn(true) leaves it in View");

if (fails.length) {
  console.log(`FAIL: ${fails.length} of ${checks} checks\n  ` + fails.join("\n  "));
  process.exit(1);
}
console.log(`all passed (${checks} checks)`);
