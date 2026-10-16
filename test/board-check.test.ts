import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FILE_MAX, checkText } from "../src/board-check";

// sagebrush board check FILE: everything that can be said of a board before
// anyone opens it, in one report (src/board-check.ts).
const repo = join(__dirname, "..", "..");
const cli = join(__dirname, "..", "src", "cli.js");
const dir = mkdtempSync(join(tmpdir(), "sb-board-check-"));
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
const run = (args: string[], cwd = dir) => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", cwd, maxBuffer: 1 << 26 });
const file = (name: string, d: unknown) => { const f = join(dir, name); writeFileSync(f, typeof d === "string" ? d : JSON.stringify(d, null, 1)); return f; };
const lines = (text: string) => checkText(text).problems.map((p) => `${p.level} ${p.path}: ${p.message}`);

// (a PNG's first bytes: its signature and header, w x h; enough for its size)
function png(w: number, h: number): string {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]).copy(b);
  b.write("IHDR", 12, "ascii");
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  b[24] = 8; b[25] = 6;
  return "data:image/png;base64," + b.toString("base64");
}

const BAD = {
  version: 1, format: "sagebrush-board", images: { pic: { w: 10, h: 10, src: "https://example.org/p.png" }, spare: { w: 5, h: 5 } },
  pages: [
    { id: "t", template: true, nodes: [{ id: "logo", text: "L" }] },
    {
      id: "p1", uses: "tt",
      nodes: [
        { id: "a", text: "x", colour: "red", image: "pics" },
        { id: "a", text: "again" },
        { id: "s", kind: "sticker", emoji: "🌵🌵" },
        { id: "g", kind: "group", children: [{ id: "c", text: "in" }], columns: 2.5 },
      ],
      edges: [{ from: "a", to: "cc" }, { from: "logo", to: "a" }],
      steps: [{ focus: ["a", "zz"] }],
    },
  ],
};

test("every problem of a board at once, each where it is, with the name meant", () => {
  assert.deepEqual(lines(JSON.stringify(BAD)), [
    "warning : write \"format\" first and \"version\" second, as the header",
    "error pages[1].nodes[0].colour: unknown field `colour` (did you mean `color`?)",
    "error pages[1].nodes[3].columns: should be a whole number, not a number (2.5)",
    "error pages[1].nodes[0].image: no picture named \"pics\" in `images` (did you mean \"pic\"?)",
    "error pages[1].nodes[1].id: the id \"a\" is on this page twice (also pages[1].nodes[0]): an edge or a step names one item",
    "error pages[1].nodes[2].emoji: \"🌵🌵\" is not one emoji: a sticker shows one (a single character such as 🌵), else it is left out",
    "error pages[1].uses: no template page has the id \"tt\" (did you mean \"t\"?); a template page has \"template\": true and an `id`",
    "error pages[1].edges[0].to: an edge's end: no item on this page has the id \"cc\" (did you mean \"c\"?)",
    "error pages[1].edges[1].from: an edge's start: no item on this page has the id \"logo\"",
    "error pages[1].steps[0].focus[1]: a tour step's focus: no item on this page has the id \"zz\"",
    "warning images.pic: not used by any note or background",
    "warning images.spare: not used by any note or background",
    "warning images.spare: no `src`: a file needs the picture itself, a data: URL or an https: address, or the board shows an empty frame",
  ]);
  // (a page made from a template: an edge to the template's item is said to be one)
  const d = JSON.parse(JSON.stringify(BAD));
  d.pages[1].uses = "t";
  assert.ok(lines(JSON.stringify(d)).includes("error pages[1].edges[1].from: an edge's start: no item on this page has the id \"logo\": it is an item of the template page, which an edge or a step of this page can't name"));
});

test("the command: the report, its exit status, --json; the code not run when the board can't be shown", () => {
  const f = file("bad.board.json", BAD);
  const r = run(["board", "check", f]);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stdout, /^bad\.board\.json: 9 errors, 4 warnings; the board can't be shown \(see the errors above\), so its code items were not run\n/);
  assert.match(r.stdout, /\nerror    pages\[1\]\.nodes\[0\]\.colour: unknown field `colour` \(did you mean `color`\?\)\n/);
  const j = JSON.parse(run(["board", "check", "--json", f]).stdout);
  assert.equal(j.ok, false);
  assert.equal(j.errors, 9);
  assert.equal(j.warnings, 4);
  assert.equal(j.code, null);
  assert.deepEqual(j.problems[1], { level: "error", path: "pages[1].nodes[0].colour", message: "unknown field `colour` (did you mean `color`?)" });
});

test("a good board: no problems, its code run; a failing item is an error at its item", () => {
  const good = { format: "sagebrush-board", version: 1, title: "Two", nodes: [{ id: "x", code: "x = 6 * 7" }, { id: "y", title: "Show", code: "print(x)" }, { id: "n", text: "a note" }], edges: [{ from: "x", to: "y" }], steps: [{ focus: "n", say: "hi" }] };
  let r = run(["board", "check", file("good.board.json", good)]);
  assert.equal(r.stdout, "good.board.json: no problems; 2 code items run (python): 2 ok\n", r.stderr);
  assert.equal(r.status, 0);
  good.nodes[1].code = "print(z)";
  r = run(["board", "check", file("good.board.json", good)]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^good\.board\.json: 1 error, 0 warnings; 2 code items run \(python\): 1 ok\n/);
  assert.match(r.stdout, /\nerror    nodes\[1\]: code item "y" \("Show"\) failed: Traceback[\s\S]*NameError: name 'z' is not defined\n/);
  // (--no-run: the structure only)
  r = run(["board", "check", "--no-run", file("good.board.json", good)]);
  assert.equal(r.stdout, "good.board.json: no problems; code items not run (--no-run)\n");
  assert.equal(r.status, 0);
});

test("an item in another language than the board's: an error, its code not run in the board's language (astra's CORR-C5A-2)", () => {
  const mixed = { format: "sagebrush-board", version: 1, title: "Mixed", nodes: [{ id: "s", mode: "sage", code: "print(2^3)" }] };
  const r = run(["board", "check", "--json", file("mixed.board.json", mixed)]);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  const rep = JSON.parse(r.stdout);
  assert.equal(rep.ok, false);
  assert.ok(rep.problems.some((p: any) => p.level === "error" && /is in Sage, not the board's Python/.test(p.message)), JSON.stringify(rep.problems));
  assert.ok(!JSON.stringify(rep).includes('"1\\n"'), "no wrong result reported: " + JSON.stringify(rep.code));
});

test("every example board has no problems", () => {
  const ex = join(repo, "web", "board", "examples");
  for (const f of readdirSync(ex).filter((f) => f.endsWith(".board.json"))) assert.deepEqual(lines(readFileSync(join(ex, f), "utf8")), [], f);
});

test("not JSON, not a board, no header, a later version", () => {
  // (where: the line and column, however JSON.parse says it)
  for (const [text, at] of [['{"format": "sagebrush-board",\n "version": 1,\n "nodes": [}', "line 3, column 12"], ['{"a": 1,}', "line 1, column 9"], ['{"a": "x', "line 1, column 9"], ['{\n "a": 01}', "line 2, column 8"]])
    assert.match(lines(text)[0], new RegExp(`^error : not JSON: .* \\(${at}\\)$`), text);
  assert.deepEqual(lines("[1, 2]"), ["error : not a board: a board is a JSON object, not a list"]);
  assert.deepEqual(lines('{"nodes": []}'), ["error : no header: a board starts with \"format\": \"sagebrush-board\", \"version\": 1"]);
  assert.deepEqual(lines('{"format": "sagebrush-board", "version": 7, "nodes": []}'), ["error version: this board is in version 7 of the format, from a later Sagebrush; this sagebrush (dev) reads version 1: update sagebrush (npx sagebrush@latest)"]);
  const r = run(["board", "check", file("later.board.json", '{"format": "sagebrush-board", "version": 7, "nodes": []}')]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /so its code items were not run/);
});

test("pictures: their sizes against what the board shows; their shape", () => {
  const d = (images: any) => JSON.stringify({ format: "sagebrush-board", version: 1, images, nodes: Object.keys(images).map((k, i) => ({ id: `n${i}`, image: k })) });
  assert.deepEqual(lines(d({ big: { w: 9000, h: 10, src: png(9000, 10) } })), ["error images.big.src: the board won't show this picture: it is 9000 × 10 pixels"]);
  // (all of a document's pictures: at most 80 million pixels; each at most 40 million)
  const many = Object.fromEntries([0, 1, 2].map((i) => [`p${i}`, { w: 6000, h: 6000, src: png(6000, 6000) }]));
  assert.deepEqual(lines(d(many)), ["error images.p2.src: the board won't show this picture: this document's pictures are too many pixels in all"]);
  assert.deepEqual(lines(d({ wide: { w: 100, h: 100, src: png(200, 100) } })), ["warning images.wide: its w and h (100 × 100) are not the picture's shape (200 × 100 pixels), so it is drawn stretched"]);
  assert.deepEqual(lines(d({ ok: { w: 50, h: 25, src: png(200, 100) } })), []);
});

test("the size a board opens is the board's (web/board/mount.ts FILE_MAX)", () => {
  const mount = readFileSync(join(repo, "web", "board", "mount.ts"), "utf8");
  const m = /export const FILE_MAX = (.+);/.exec(mount);
  assert.ok(m);
  assert.equal(FILE_MAX, eval(m![1]));
});

test("board: a command this sagebrush doesn't have is said so, not taken as a file (agent-UX R0-3)", () => {
  const r = run(["board", "frobnicate", "x.board.json"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /^sagebrush board: unknown board command "frobnicate": this sagebrush \(dev\) has render, run, check, answers, try\n/);
  assert.equal(run(["board", "check", "--help"]).status, 0);
  assert.match(run(["board", "check", "--help"]).stdout, /^usage: sagebrush board check FILE/);
  // (a script named board, here, still runs as before)
  const own = mkdtempSync(join(tmpdir(), "sb-board-script-"));
  try {
    writeFileSync(join(own, "board"), "print('a script named board')\n");
    assert.equal(run(["board"], own).stdout, "a script named board\n");
  } finally {
    rmSync(own, { recursive: true, force: true });
  }
});

test("code items run in the order they depend on each other, as the board runs them, not in reading order (agent-UX R0-6)", () => {
  const d = { format: "sagebrush-board", version: 1, nodes: [{ id: "use", code: "print(total * 2)" }, { id: "mid", code: "total = base + 1" }, { id: "def", code: "base = 20" }] };
  const f = file("order.board.json", d);
  assert.equal(run(["board", "check", f]).stdout, "order.board.json: no problems; 3 code items run (python): 3 ok\n");
  const r = run(["board", "run", f]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^ {2}1 {2}OK {7}\("use"\)[^\n]*\n {7}42\n/);
});

test("pages that share an id: an error at the second, running or not; check refuses whatever the board refuses (CORR-5DF-1)", () => {
  const d = { format: "sagebrush-board", version: 1, pages: [{ id: "p", nodes: [{ id: "a", text: "one" }] }, { id: "p", nodes: [{ id: "b", text: "two" }] }] };
  assert.deepEqual(lines(JSON.stringify(d)), ["error pages[1].id: the page id \"p\" is used twice (also pages[0].id): the board refuses a document whose pages share an id"]);
  const f = file("pages.board.json", d);
  for (const args of [["board", "check", f], ["board", "check", "--no-run", f]]) {
    const r = run(args);
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stdout, /^pages\.board\.json: 1 error, 0 warnings/);
  }
  // (a corpus: each document the board refuses, as formatError or isBoard says, has an error here)
  const { formatError, isBoard } = require("../web/board/doc");
  const base = () => ({ format: "sagebrush-board", version: 1, nodes: [{ id: "a", text: "x" }, { id: "b", kind: "group", children: [{ id: "c" }] }], edges: [{ from: "a", to: "c" }] });
  const corpus: any[] = [
    { ...base(), format: "something-else" }, { ...base(), version: 2 }, { ...base(), version: 0 }, { ...base(), version: "1" },
    { ...base(), nodes: [{ id: "a" }, { id: "a" }] }, { ...base(), nodes: [{ id: "a" }, { id: "g", kind: "group", children: [{ id: "a" }] }] },
    { format: "sagebrush-board", version: 1 }, { format: "sagebrush-board", version: 1, nodes: "x" }, { format: "sagebrush-board", version: 1, pages: [{ title: "no nodes" }] },
    d, { format: "sagebrush-board", version: 1, pages: [{ id: 1, nodes: [] }, { id: "1", nodes: [] }] },
    ...readdirSync(join(repo, "web", "board", "examples")).filter((f) => f.endsWith(".board.json")).map((f) => JSON.parse(readFileSync(join(repo, "web", "board", "examples", f), "utf8"))),
  ];
  for (const doc of corpus) {
    const refused = formatError(doc) !== null || !isBoard(doc);
    const errors = checkText(JSON.stringify(doc)).problems.filter((p) => p.level === "error");
    if (refused) assert.ok(errors.length, `the board refuses it, check says nothing: ${JSON.stringify(doc).slice(0, 120)}`);
  }
});

test("pictures named constructor, toString or __proto__: missing unless images has them (CORR-5DF-2)", () => {
  for (const name of ["constructor", "toString", "__proto__"]) {
    const note = `{"format": "sagebrush-board", "version": 1, "nodes": [{"id": "a", "image": "${name}"}]}`;
    assert.deepEqual(lines(note), [`error nodes[0].image: no picture named "${name}" in \`images\``], name);
    const bg = `{"format": "sagebrush-board", "version": 1, "background": {"image": "${name}"}, "nodes": []}`;
    assert.deepEqual(lines(bg), [`error background.image: no picture named "${name}" in \`images\``], name);
    const given = `{"format": "sagebrush-board", "version": 1, "images": {"${name}": {"w": 4, "h": 4, "src": "https://example.org/a.png"}}, "nodes": [{"id": "a", "image": "${name}"}]}`;
    assert.deepEqual(lines(given), [], name);
  }
});

test("a JSON mistake after a long valid number is found where it is (CORR-5DF-3)", () => {
  const text = `{"format":"sagebrush-board",\n"version":1,\n"nodes":[],\n"slide":{"x":0.${"1".repeat(420)},"y":0,"w":1,"h":1},\n"bad": ]}`;
  assert.equal(lines(text)[0], "error : not JSON: Unexpected token ']' (line 5, column 8)");
});

test("a board nested too deep: an ordinary error, not a crash (HARD-5DF-1)", () => {
  let node: any = { id: "leaf", text: "x" };
  for (let i = 0; i < 1000; i++) node = { id: `g${i}`, kind: "group", children: [node] };
  const f = file("deep.board.json", { format: "sagebrush-board", version: 1, nodes: [node] });
  const r = run(["board", "check", f]);
  assert.equal(r.status, 1, r.stderr);
  assert.equal(r.stderr, "");
  assert.match(r.stdout, /error    \(the board\): not a board this command checks: objects and lists nest more than 200 deep/);
});

test("the file is read in pieces and never past its limit, standard input too (HARD-5DF-2)", () => {
  const { readBounded } = require("../src/board-check");
  const f = file("ten.txt", "0123456789");
  assert.equal(readBounded(f, 10).toString(), "0123456789");
  assert.equal(readBounded(f, 9), null);
  const code = `const { readBounded } = require(${JSON.stringify(join(__dirname, "..", "src", "board-check.js"))}); const b = readBounded("-", 9); process.stdout.write(b === null ? "null" : b.toString());`;
  assert.equal(spawnSync(process.execPath, ["-e", code], { input: "0123456789", encoding: "utf8" }).stdout, "null");
  assert.equal(spawnSync(process.execPath, ["-e", code], { input: "012345678", encoding: "utf8" }).stdout, "012345678");
});

test("a 4000-character item id misspelt: its diagnostic under a small heap, no suggestion (PERF-619-1)", () => {
  const name = "a".repeat(4000);
  const f = file("long-id.board.json", { format: "sagebrush-board", version: 1, nodes: [{ id: name }], edges: [{ from: name.slice(0, -1) + "b", to: name }] });
  const r = spawnSync(process.execPath, ["--max-old-space-size=96", cli, "board", "check", f, "--no-run", "--json"], { encoding: "utf8", cwd: dir });
  assert.equal(r.status, 1, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.deepEqual(j.problems.map((p: any) => p.path), ["edges[0].from"]);
  assert.doesNotMatch(j.problems[0].message, /did you mean/);
});

test("one write bigger than the budget is cut in the worker, before it is posted (HARD-BBE-1)", () => {
  // (a session of its own, in its own process: the limits small)
  const code = `const { notebookSession } = require(${JSON.stringify(join(__dirname, "..", "src", "notebook-session.js"))});
const msgs = [];
const s = notebookSession((m) => msgs.push(m), { captureStreams: true, limit: { item: 1000, run: 2500, displays: 100 } });
(async () => {
  await s.ready;
  for (const [id, code] of [[1, "print('x' * 100000)\\nprint('after')"], [2, "print('y' * 999)"], [3, "import sys\\nsys.stderr.write('z' * 600)\\nprint('w' * 600)"]]) await s.handle({ id, code });
  process.stdout.write(JSON.stringify(msgs.filter((m) => m.stream || m.cut || m.done).map((m) => m.stream ? [m.id, m.stream, m.text.length] : m.cut ? [m.id, "cut", m.cut] : [m.id, "done"])));
})();`;
  const r = spawnSync(process.execPath, ["-e", code], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), [
    [1, "stdout", 1000], [1, "cut", "item"], [1, "done"],
    [2, "stdout", 1000], [2, "done"],
    [3, "stderr", 500], [3, "cut", "run"], [3, "done"],
  ]);
});

test("a display costs its envelope, and an item posts at most so many (HARD-58F-1)", () => {
  const code = `const { notebookSession } = require(${JSON.stringify(join(__dirname, "..", "src", "notebook-session.js"))});
const msgs = [];
const s = notebookSession((m) => msgs.push(m), { captureStreams: true, limit: { item: 1000, run: 100000, displays: 6 } });
const show = "from IPython.display import display\\nclass X:\\n    def _repr_mimebundle_(self, include=None, exclude=None):\\n        return {'text/plain': ''}\\n";
(async () => {
  await s.ready;
  for (const [id, code] of [[1, show + "for i in range(10):\\n    display(X())"], [2, show + "for i in range(10):\\n    display(X())"], [3, show.replace("''", "'x' * 100") + "for i in range(10):\\n    display(X())"]]) await s.handle({ id, code });
  const out = {};
  for (const m of msgs) if (m.display || m.cut) (out[m.id] ??= []).push(m.display ? "d" : "cut:" + m.cut);
  process.stdout.write(JSON.stringify(out));
})();`;
  const r = spawnSync(process.execPath, ["-e", code], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  // (6 empty displays, then the cut; again the next run; displays of 100
  // characters cost 64 + 10 + 100 each: 5 fit in 1000, then the size cut)
  assert.deepEqual(JSON.parse(r.stdout), { 1: ["d", "d", "d", "d", "d", "d", "cut:displays"], 2: ["d", "d", "d", "d", "d", "d", "cut:displays"], 3: ["d", "d", "d", "d", "d", "cut:item"] });
});

test("500,000 empty displays under a small heap: 10,000 kept, the cut said, the next item runs (HARD-58F-1)", () => {
  const show = "from IPython.display import display\nclass X:\n    def _repr_mimebundle_(self, include=None, exclude=None):\n        return {'text/plain': ''}\nx = X()\nfor i in range(500000):\n    display(x)\n";
  const d = { format: "sagebrush-board", version: 1, nodes: [{ id: "many", code: show }, { id: "after", code: "print('still here')" }] };
  const r = spawnSync(process.execPath, ["--max-old-space-size=96", cli, "board", "run", "--json", file("displays.board.json", d)], { encoding: "utf8", cwd: dir, maxBuffer: 1 << 26 });
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  const many = j.items.find((i: any) => i.id === "many");
  assert.equal(many.outputs.length, 10000);
  assert.match(many.stderr, /\[output cut: past 10000 displays for this item; the rest was not kept\]/);
  assert.equal(j.items.find((i: any) => i.id === "after").stdout, "still here\n");
});

test("an item printing 40 MB at once: its first 4 MB kept, the cut said (HARD-BBE-1)", () => {
  const d = { format: "sagebrush-board", version: 1, nodes: [{ id: "big", code: "print('x' * (40 * 2**20))" }, { id: "after", code: "print('still here')" }] };
  const r = run(["board", "run", "--json", file("big.board.json", d)]);
  const j = JSON.parse(r.stdout);
  const big = j.items.find((i: any) => i.id === "big");
  assert.equal(big.stdout.length, 4 * 2 ** 20);
  assert.match(big.stderr, /^\n\[output cut: past 4 MB for this item; the rest was not kept\]\n$/);
  assert.equal(j.items.find((i: any) => i.id === "after").stdout, "still here\n");
});

test("an item printing more than its output budget: cut, said once, and the run goes on (HARD-5DF-3)", () => {
  const d = { format: "sagebrush-board", version: 1, nodes: [{ id: "loud", code: "line = 'x' * 1000\nfor i in range(5000):\n    print(line)" }, { id: "after", code: "print('still here')" }] };
  const r = run(["board", "run", "--json", file("loud.board.json", d)]);
  const j = JSON.parse(r.stdout);
  const loud = j.items.find((i: any) => i.id === "loud");
  assert.ok(loud.stdout.length <= 4 * 2 ** 20 + 1000, String(loud.stdout.length));
  assert.match(loud.stderr, /\[output cut: past 4 MB for this item; the rest was not kept\]/);
  assert.equal(j.items.find((i: any) => i.id === "after").stdout, "still here\n");
});
