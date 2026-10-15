import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanPreview } from "../web/board/preview";
import { codeOrder } from "../web/board/doc";

// `sagebrush board run`: every code item of a board run as the board runs it
// in a browser (src/board-run.ts), each item's output or error reported.
const run = (args: string[], input?: string) => spawnSync(process.execPath, [__dirname + "/../src/cli.js", "board", "run", ...args], { encoding: "utf8", input, timeout: 120_000 });
const examples = __dirname + "/../../web/board/examples/";
const board = (nodes: any[], more: any = {}) => JSON.stringify({ format: "sagebrush-board", version: 1, title: "T", ...more, nodes: nodes.map((n, i) => ({ x: (i % 3) * 400, y: Math.floor(i / 3) * 300, w: 300, ...n })) });
const json = (args: string[], input?: string) => { const r = run([...args, "--json"], input); return { status: r.status, stderr: r.stderr, report: JSON.parse(r.stdout) }; };
const item = (rep: any, id: string) => rep.items.find((i: any) => i.id === id);

test("board run: an example board, every item as the board shows it", () => {
  const r = run([examples + "live.json"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /871 takes 178 steps/);
  assert.match(r.stdout, /111 steps, as high as 9232/);
  assert.match(r.stdout, /5 ok \(of 5 code items, python\)/);
});

test("board run: what fails, says why, and what reads it is not run; the others run", () => {
  const { status, report } = json(["-", "--timeout", "2"], board([
    { id: "a", title: "Fine", code: "x = 6 * 7\nprint(x)" },
    { id: "b", title: "Raises", code: "y = x / 0" },
    { id: "c", title: "Reads y", code: "print(y + 1)" },
    { id: "d", title: "Syntax", code: "def f(:\n  pass" },
    { id: "h", title: "Forever", code: "n = 0\nwhile True:\n    n += 1" },
    { id: "k", title: "Reads n", code: "print(n)" },
    { id: "j", title: "After", code: "x + 1" },
  ]));
  assert.equal(status, 1);
  assert.equal(report.ok, false);
  assert.deepEqual(report.items.map((i: any) => [i.id, i.status]), [["a", "ok"], ["b", "failed"], ["c", "not run"], ["d", "error"], ["h", "timeout"], ["k", "not run"], ["j", "ok"]]);
  assert.equal(item(report, "a").stdout, "42\n");
  assert.match(item(report, "b").error, /ZeroDivisionError/);
  assert.match(item(report, "c").error, /item 2 "Raises", which it depends on, raised an error/);
  assert.match(item(report, "d").error, /^SyntaxError/);
  assert.match(item(report, "h").error, /ran out of time: stopped after 2 s[\s\S]*KeyboardInterrupt/);
  assert.match(item(report, "k").error, /item 5 "Forever", which it depends on, ran out of time/);
  assert.equal(item(report, "j").stdout, "43\n", "a last expression's value, as the board shows it");
});

test("board run: an item that does not stop when interrupted: the interpreter is stopped, and what was left is not run", () => {
  const t0 = Date.now();
  const { status, report } = json(["-", "--timeout", "1"], board([{ id: "s", code: "import time\ntime.sleep(100)" }, { id: "t", code: "print(1)" }]));
  assert.equal(status, 1);
  assert.deepEqual(report.items.map((i: any) => i.status), ["timeout", "not run"]);
  assert.match(report.items[1].error, /the interpreter was stopped/);
  assert.ok(Date.now() - t0 < 20_000);
});

test("board run: each language, as its board runs it", () => {
  const sage = json(["-"], board([{ id: "a", code: "K.<a> = NumberField(x^2 + 5)\nK.class_number()" }], { mode: "sage" }));
  assert.equal(sage.status, 0, JSON.stringify(sage.report));
  assert.equal(item(sage.report, "a").stdout, "2\n");
  const magma = json(["-"], board([{ id: "a", code: "x := 10;\nprint Factorization(x^4 - 1);" }, { id: "b", code: "print x + 1;" }], { mode: "magma" }));
  assert.equal(magma.status, 0, JSON.stringify(magma.report));
  assert.equal(item(magma.report, "a").stdout.trim(), "[ <3, 2>, <11, 1>, <101, 1> ]");
  assert.equal(item(magma.report, "b").stdout.trim(), "11");
  const matlab = json(["-"], board([{ id: "a", code: "A = magic(3);\nd = det(A)" }, { id: "c", code: "undefined_fn(3)" }], { mode: "matlab" }));
  assert.equal(matlab.status, 1);
  assert.match(item(matlab.report, "a").stdout, /d =\s+-360/);
  assert.equal(item(matlab.report, "c").status, "failed");
  assert.match(item(matlab.report, "c").error, /Unrecognized function or variable 'undefined_fn'/);
});

test("board run: the board's seed, as in a browser: the same numbers each time, others with another seed", () => {
  const code = [{ id: "r", code: "import random\nprint(random.random())" }];
  const a = json(["-"], board(code)), b = json(["-"], board(code)), c = json(["-"], board(code, { seed: "ab".repeat(32) }));
  assert.equal(item(a.report, "r").stdout, item(b.report, "r").stdout);
  assert.notEqual(item(a.report, "r").stdout, item(c.report, "r").stdout);
});

test("board run --store-previews: a copy with its items' outputs as previews, never over a file that is there", () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-run-"));
  try {
    const f = join(dir, "x.board.json"), copy = join(dir, "x.previews.board.json");
    writeFileSync(f, board([{ id: "a", title: "Fine", code: "print(42)" }, { id: "b", code: "1 / 0" }, { id: "c", code: "import matplotlib.pyplot as plt\nplt.plot([1, 2])\nplt.show()" }]));
    const before = readFileSync(f, "utf8");
    // (fast items: no previews, as the board keeps them)
    let r = run([f, "--store-previews"]);
    assert.equal(r.status, 1, r.stderr);
    let d = JSON.parse(readFileSync(copy, "utf8"));
    assert.ok(d.nodes.every((n: any) => !n.preview));
    // (there already: not written over, unless named)
    r = run([f, "--store-previews", "--preview-ms", "0"]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /is there already: name it with -o/);
    r = run([f, "--store-previews", "--preview-ms", "0", "-o", copy]);
    d = JSON.parse(readFileSync(copy, "utf8"));
    assert.equal(d.format, "sagebrush-board");
    const p = Object.fromEntries(d.nodes.map((n: any) => [n.id, n.preview]));
    assert.deepEqual(p.a.outputs, [{ output_type: "stream", name: "stdout", text: "42\n" }]);
    assert.match(p.b.outputs[0].text, /ZeroDivisionError/);
    // (a plot is an SVG, which a preview can't hold here: none, and the board runs it)
    assert.equal(p.c, undefined);
    for (const x of [p.a, p.b]) assert.deepEqual(cleanPreview(x), x, "a preview as the board reads it");
    assert.equal(readFileSync(f, "utf8"), before, "the board itself untouched");
    assert.equal(run(["-", "--store-previews"], board([])).status, 2, "standard input needs -o");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("board run: what it is told wrong, a board that is not one, and text for a terminal", () => {
  assert.equal(run([]).status, 2);
  assert.equal(run([examples + "live.json", "--bogus"]).status, 2);
  assert.equal(run([examples + "live.json", "-o", "x.json"]).status, 2, "-o is for --store-previews");
  assert.equal(run(["/nonexistent.board.json"]).status, 1);
  assert.equal(run(["-"], '{"format": "something-else"}').status, 1);
  const r = run(["-"], board([{ id: "a\u001b[31m", title: "T\u001b[2J", code: "print('\\x1b[31mred')" }]));
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!r.stdout.includes("\u001b"), "no control character reaches the terminal: " + JSON.stringify(r.stdout));
  assert.equal(run(["-"], board([{ id: "n", title: "no code" }])).status, 0);
  assert.ok(!existsSync("x.json"));
});

test("board run: an id on two pages is two items, each run and reported, neither keeping a preview (CORR-CD6-1)", () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-run-"));
  try {
    const f = join(dir, "p.board.json"), copy = join(dir, "p.previews.board.json");
    const page = (title: string, said: string) => ({ title, nodes: [{ id: "same", title, code: `print(${JSON.stringify(said)})`, x: 0, y: 0, w: 300 }] });
    writeFileSync(f, JSON.stringify({ format: "sagebrush-board", version: 1, title: "Pages", pages: [page("One", "first"), page("Two", "second")] }));
    const { status, report } = json([f, "--store-previews", "--preview-ms", "0"]);
    assert.equal(status, 0);
    assert.deepEqual(report.items.map((i: any) => [i.n, i.id, i.page, i.title, i.status, i.stdout]), [[1, "same", 1, "One", "ok", "first\n"], [2, "same", 2, "Two", "ok", "second\n"]]);
    // (a cell by its page keeps no preview, as the board's: its cell, and seed, change as pages come and go)
    const d = JSON.parse(readFileSync(copy, "utf8"));
    assert.deepEqual(d.pages.map((p: any) => p.nodes[0].preview), [undefined, undefined]);
    assert.match(run([f]).stdout, /\("same", page 2\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("board run --store-previews: a file made while the board ran is not written over (HARD-CD6-2); a write that fails is said", () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-run-"));
  try {
    const f = join(dir, "t.board.json"), copy = join(dir, "t.previews.board.json");
    writeFileSync(f, board([{ id: "a", code: `open(${JSON.stringify(copy)}, "w").write("made by the board")` }]));
    const r = run([f, "--store-previews", "--preview-ms", "0"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /is there now \(made while the board ran\): not written over/);
    assert.equal(readFileSync(copy, "utf8"), "made by the board");
    const w = run([f, "--store-previews", "-o", join(dir, "no", "such", "dir.json")]);
    assert.equal(w.status, 1);
    assert.match(w.stderr, /^sagebrush board run: could not write .*: ENOENT\n$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("board run: no control character reaches the terminal from an early error either (HARD-CD6-3)", () => {
  for (const r of [
    run(["-"], JSON.stringify({ format: "evil\u001b[31m", nodes: [] })),
    run([examples + "live.json", "--bad\u001b[31m"]),
    run(["/nonexistent\u001b[2J.board.json"]),
  ]) {
    assert.ok(r.status === 1 || r.status === 2, String(r.status));
    assert.ok(r.stderr.length && !/[\u0000-\u0008\u000b-\u001f\u007f]/.test(r.stderr), JSON.stringify(r.stderr));
  }
});

test("board run: --timeout is a number of seconds a timer can wait; --preview-ms 0 or more (CORR-CD6-4)", () => {
  for (const t of ["Infinity", "2147484", "0", "-1", "NaN", "x"]) {
    const r = run([examples + "live.json", "--timeout", t]);
    assert.equal(r.status, 2, t);
    assert.match(r.stderr, /--timeout takes a number of seconds, more than 0 and at most 2147483/);
  }
  assert.equal(run([examples + "live.json", "--timeout", "2147483"]).status, 0);
  for (const t of ["Infinity", "-1"]) assert.match(run([examples + "live.json", "--store-previews", "--preview-ms", t]).stderr, /--preview-ms takes a number of milliseconds, 0 or more/);
});

test("board run: an item whose own id is another's cell's (x, x, x@p2): three cells, each run and reported (CORR-239-1)", () => {
  const page = (title: string, id: string, said: string) => ({ title, nodes: [{ id, title, code: `print(${JSON.stringify(said)})`, x: 0, y: 0, w: 300 }] });
  const { status, report } = json(["-"], JSON.stringify({ format: "sagebrush-board", version: 1, title: "Three", pages: [page("One", "x", "first"), page("Two", "x", "second"), page("Three", "x@p2", "real")] }));
  assert.equal(status, 0);
  assert.deepEqual(report.items.map((i: any) => [i.n, i.id, i.page, i.stdout]), [[1, "x", 1, "first\n"], [2, "x", 2, "second\n"], [3, "x@p2", 3, "real\n"]]);
});

test("board run: a board of a later version of the format is refused as the board refuses it, nothing run", () => {
  const r = run(["-"], JSON.stringify({ format: "sagebrush-board", version: 99, nodes: [{ id: "a", code: "print('ran')" }] }));
  assert.equal(r.status, 1);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /^sagebrush board run: -: this board is in version 99 of the format, from a later Sagebrush; this sagebrush \((dev|\d+\.\d+\.\d+\S*)\) reads version 1: update sagebrush \(npx sagebrush@latest\)\n$/);
});

test("board run: what it says of a board it refuses is one line, a newline or a tab in the format or the file's name escaped; what a cell prints keeps its lines (HARD-EC2-1)", () => {
  const evil = JSON.stringify({ format: "evil\nINJECTED: ok\tX", nodes: [] });
  let r = run(["-"], evil);
  assert.equal(r.status, 1);
  assert.equal(r.stderr, 'sagebrush board run: -: not a Sagebrush board: its format is "evil\\x0aINJECTED: ok\\x09X"\n');
  const dir = mkdtempSync(join(tmpdir(), "sb-run-"));
  try {
    const file = join(dir, "a\nINJECTED: ok\tb.json");
    writeFileSync(file, evil);
    r = run([file]);
    assert.equal(r.status, 1);
    assert.equal(r.stderr.split("\n").length, 2, r.stderr);
    assert.ok(r.stderr.includes("a\\x0aINJECTED: ok\\x09b.json: not a Sagebrush board"), r.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  r = run([examples + "live.json", "--x\ny"]);
  assert.equal(r.status, 2);
  assert.ok(r.stderr.startsWith("sagebrush board run: unknown option --x\\x0ay\n"), r.stderr);
  r = run(["-"], board([{ id: "p", code: "print('one\\ttwo\\nthree')" }]));
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes("one\ttwo\n       three\n"), r.stdout);
});

test("board run: its cells are the board's (doc.ts codeOrder), each with its cell's seed, as in the browser", () => {
  // (x on two pages, and a third page's item whose id is the first x's cell's: x@p1~2, x@p2, x@p1)
  const page = (title: string, id: string) => ({ title, nodes: [{ id, title, code: "import random\nprint(random.random())", x: 0, y: 0, w: 300 }] });
  const doc = { format: "sagebrush-board", version: 1, title: "Seeds", pages: [page("One", "x"), page("Two", "x"), page("Three", "x@p1")] };
  const cells = codeOrder(doc as any).map((c) => c.id);
  assert.deepEqual(cells, ["x@p1~2", "x@p2", "x@p1"]);
  const { status, report } = json(["-"], JSON.stringify(doc));
  assert.equal(status, 0);
  // (each prints what an item alone, whose id is that cell's, prints: its seed is its cell's)
  const alone = cells.map((id) => json(["-"], board([{ id, code: "import random\nprint(random.random())" }])).report.items[0].stdout);
  assert.deepEqual(report.items.map((i: any) => i.stdout), alone);
  assert.equal(new Set(alone).size, 3);
});

test("board run: a board of a later version is refused in the same words as board render's (CLI_READER)", () => {
  const later = JSON.stringify({ format: "sagebrush-board", version: 99, nodes: [{ id: "a", code: "print('ran')" }] });
  const render = spawnSync(process.execPath, [__dirname + "/../src/cli.js", "board", "render", "-"], { encoding: "utf8", input: later });
  const r = run(["-"], later);
  assert.equal(r.status, 1);
  assert.equal(render.status, 1);
  assert.equal(r.stderr.replace(/^sagebrush board run: /, ""), render.stderr.replace(/^sagebrush board render: /, ""));
});

test("board run: a Magma item that fails fails its cell; what reads it is not run, the others are, and the exit is 1", () => {
  const { status, report } = json(["-"], board([
    { id: "a", code: "x := 5;\nprint x;" },
    { id: "b", code: "y := x div 0;" },
    { id: "c", code: "print y + 1;" },
    { id: "d", code: "print 7;" },
  ], { mode: "magma" }));
  assert.equal(status, 1);
  assert.equal(report.ok, false);
  assert.deepEqual(report.items.map((i: any) => [i.id, i.status]), [["a", "ok"], ["b", "failed"], ["c", "not run"], ["d", "ok"]]);
  assert.match(report.items[1].stdout, /Runtime error/);
  assert.equal(report.items[3].stdout, "7\n");
});

test("board run: pictures the board leaves out for their names are named on stderr, and the board still runs", () => {
  const pic = { w: 10, h: 10, src: "data:image/png;base64,iVBORw0KGgo=" };
  const r = run(["-"], board([{ id: "a", image: "figure.png" }, { id: "c", code: "print(1)" }], { images: { "figure.png": pic } }));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /1\n/);
  assert.equal(r.stderr, 'sagebrush board run: pictures left out: a picture\'s name is letters, digits, _ and -, at most 100 characters (plot-1, not "plot 1" or "figure.png"), and this one is not: "figure.png"\n');
});
