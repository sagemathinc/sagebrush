import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanPreview } from "../web/board/preview";
import { codeOrder } from "../web/board/doc";
import { boardExample, boardExamples } from "./board-examples";
import { collect, interactError, interactFlags, ITEM_DISPLAYS_MAX, ITEM_OUTPUT_MAX, RUN_OUTPUT_MAX } from "../src/board-run";

// `sagebrush board run`: every code item of a board run as the board runs it
// in a browser (src/board-run.ts), each item's output or error reported.
const run = (args: string[], input?: string) => spawnSync(process.execPath, [__dirname + "/../src/cli.js", "board", "run", ...args], { encoding: "utf8", input, timeout: 120_000 });
const board = (nodes: any[], more: any = {}) => JSON.stringify({ format: "sagebrush-board", version: 1, title: "T", ...more, nodes: nodes.map((n, i) => ({ x: (i % 3) * 400, y: Math.floor(i / 3) * 300, w: 300, ...n })) });
const json = (args: string[], input?: string) => { const r = run([...args, "--json"], input); return { status: r.status, stderr: r.stderr, report: JSON.parse(r.stdout) }; };
const item = (rep: any, id: string) => rep.items.find((i: any) => i.id === id);

test("board run: an example board, every item as the board shows it", () => {
  const r = run([boardExample("live.json")]);
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
  // (with where it is, as CPython's: the line and a caret under it)
  assert.match(item(report, "d").error, /^File "<cell>", line 1\n {4}def f\(:\n {10}\^\nSyntaxError: invalid syntax$/);
  assert.match(item(report, "h").error, /ran out of time: stopped after 2 s[\s\S]*KeyboardInterrupt/);
  assert.match(item(report, "k").error, /item 5 "Forever", which it depends on, ran out of time/);
  assert.equal(item(report, "j").stdout, "43\n", "a last expression's value, as the board shows it");
});

// (Codex's friction P11a, python's reproduction /scratch/codex-friction/recheck/repro/P11/w.board.json: an @interact
// item reported ok with only "[interactive controls]", its function's run at its defaults (Sage's text mode prints
// 5/3 for this one) not shown, and a function that raises passing)
test("board run: an @interact item reports its function's run at its defaults; one whose function raises fails, saying so", () => {
  const { status, report } = json(["-"], board([
    { id: "w", title: "widget", code: "@interact\ndef pairing(u=slider(0,4,1,2), v=slider(0,4,1,1)):\n    print((2*u+v)/3)" },
    { id: "e", title: "err", code: "@interact\ndef bad(u=slider(0,4,1,2)):\n    1/0" },
    { id: "after", title: "after", code: "print('next')" },
  ], { mode: "sage" }));
  assert.equal(status, 1);
  assert.equal(item(report, "w").status, "ok");
  assert.equal(item(report, "w").stdout, "5/3\n", JSON.stringify(item(report, "w")));
  assert.equal(item(report, "e").status, "failed", JSON.stringify(item(report, "e")));
  assert.match(item(report, "e").error, /^Traceback[\s\S]*ZeroDivisionError[^\n]*\n\(raised by the item's @interact function, run with its default values\)$/);
  assert.equal(item(report, "after").status, "ok");
  assert.equal(item(report, "after").stdout, "next\n");
  // (and board check, which runs the items the same way: an error, the reason in what it keeps of it)
  const dir = mkdtempSync(join(tmpdir(), "sb-interact-")), f = join(dir, "w.board.json");
  try {
    writeFileSync(f, board([{ id: "e", title: "err", code: "@interact\ndef bad(u=slider(0,4,1,2)):\n    1/0" }], { mode: "sage" }));
    const c = spawnSync(process.execPath, [__dirname + "/../src/cli.js", "board", "check", f], { encoding: "utf8", timeout: 120_000 });
    assert.equal(c.status, 1, c.stdout + c.stderr);
    assert.match(c.stdout, /code item "e" \("err"\) failed:[\s\S]*ZeroDivisionError[\s\S]*\(raised by the item's @interact function, run with its default values\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// (what is kept of an @interact's own output area is the item's, under its caps: no copy of it beside them, a
// traceback past them still failing the item, and a clear_output() there giving back exactly what it kept; astra's
// INTERACT-BUFFER-1 on #788)
test("board run: an @interact's output: under the item's caps, a traceback past them still fails it, a clear there clears that interact's only", () => {
  const MB = 2 ** 20, tb = "Traceback (most recent call last):\n  File \"<cell>\", line 3, in bad\nZeroDivisionError: x\n";
  const textOf = (l: any[]) => l.filter((o) => o.output_type === "stream").map((o) => o.text).join("");
  const REASON = /\n\(raised by the item's @interact function, run with its default values\)$/;
  // (the item's cut: six 1 MiB writes there, then the traceback, past the item's 4 MiB: nothing kept past it, and no copy
  // of it beside the list; the traceback that was dropped still fails the item, said)
  const big: any[] = [], k1 = { run: 0 };
  for (let i = 0; i < 6; i++) collect(big, { target: 1, stream: "stderr", text: "x".repeat(MB) }, k1);
  collect(big, { target: 1, stream: "stderr", text: tb }, k1);
  assert.ok(textOf(big).length <= ITEM_OUTPUT_MAX + 200 && k1.run <= ITEM_OUTPUT_MAX, `kept ${textOf(big).length}, run ${k1.run}`);
  const e1 = interactError(big);
  assert.ok(e1 !== null && e1.length < 300 && /^\[its traceback was not kept: past the output limit\]/.test(e1) && REASON.test(e1), String(e1));
  // (the run's cut: the board's output nearly spent, the traceback dropped: the same)
  const r: any[] = [], k2 = { run: RUN_OUTPUT_MAX - 10 };
  collect(r, { target: 1, stream: "stderr", text: tb }, k2);
  assert.ok(textOf(r).includes("[output cut") && !textOf(r).includes("ZeroDivisionError") && k2.run === RUN_OUTPUT_MAX - 10);
  assert.ok(REASON.test(String(interactError(r))), String(interactError(r)));
  // (a clear in one interact's area: what it kept goes, its bytes given back to the item and the run, its traceback
  // forgotten; the cell's own output and another interact's stay)
  const l: any[] = [], k3 = { run: 0 };
  collect(l, { stream: "stdout", text: "mine\n" }, k3);
  collect(l, { target: 2, stream: "stdout", text: "two\n" }, k3);
  collect(l, { target: 1, stream: "stdout", text: "y".repeat(3 * MB) }, k3);
  collect(l, { target: 1, stream: "stderr", text: tb }, k3);
  assert.ok(REASON.test(String(interactError(l))));
  collect(l, { target: 1, clear: true }, k3);
  assert.equal(textOf(l), "mine\ntwo\n");
  assert.equal(k3.run, 9);
  assert.equal(interactError(l), null, "a traceback cleared, then nothing raised: no error");
  collect(l, { target: 1, stream: "stdout", text: "5/3\n" }, k3);
  assert.equal(interactError(l), null, "…and its run after the clear succeeding: still none");
  collect(l, { stream: "stdout", text: "z".repeat(3 * MB) }, k3);
  assert.ok(!textOf(l).includes("[output cut"), "3 MB after the clear is kept: its bytes were given back");
  // (the cell's own clear_output() after an interact raised: the item's whole output and what it knew of its interacts
  // go; no error left; astra on r2)
  const w: any[] = [], k5 = { run: 0 };
  collect(w, { target: 1, stream: "stderr", text: tb }, k5);
  collect(w, { clear: true }, k5);
  assert.equal(interactError(w), null, "a whole clear forgets the interact's traceback");
  assert.equal(interactFlags(w), 0);
  collect(w, { target: 1, stream: "stdout", text: "5/3\n" }, k5);
  assert.equal(interactError(w), null, "…and its run after succeeding: no error");
  // (an interact's clear after the item's cut: what it gave back can be written again; astra on r2)
  const c: any[] = [], k6 = { run: 0 };
  for (let i = 0; i < 5; i++) collect(c, { target: 1, stream: "stdout", text: "y".repeat(MB) }, k6);
  assert.ok(textOf(c).includes("[output cut"), "(cut)");
  collect(c, { target: 1, clear: true }, k6);
  collect(c, { stream: "stdout", text: "after the clear\n" }, k6);
  assert.ok(textOf(c).endsWith("after the clear\n"), "output after an interact's clear past the cut is kept: " + JSON.stringify(textOf(c).slice(-60)));
  // (interacts past the cut, many, each raising: at most ITEM_DISPLAYS_MAX of their flags kept, and the item still fails;
  // astra's INTERACT-META-1)
  const many: any[] = [], k7 = { run: 0 };
  for (let i = 0; i < 5; i++) collect(many, { target: 0, stream: "stdout", text: "y".repeat(MB) }, k7);
  for (let t = 1; t <= ITEM_DISPLAYS_MAX + 50; t++) collect(many, { target: t, stream: "stderr", text: tb }, k7);
  assert.ok(interactFlags(many) <= ITEM_DISPLAYS_MAX, `flags kept: ${interactFlags(many)}`);
  assert.ok(textOf(many).length <= ITEM_OUTPUT_MAX + 200);
  assert.ok(REASON.test(String(interactError(many))), "…and the item still fails, its tracebacks past the limit");
  for (let t = 1; t <= ITEM_DISPLAYS_MAX + 50; t++) collect(many, { target: t, clear: true }, k7);
  assert.ok(REASON.test(String(interactError(many))), "…its interacts' clears can't take back the ones it could not keep track of");
  // (cut, refilled and cleared again and again: the cut said once, by the item's own caps or the worker's cut alike;
  // astra's INTERACT-CUT-NOTE-1)
  const notes = (l: any[]) => l.filter((o) => o.output_type === "stream" && o.text.includes("[output cut")).length;
  const rep1: any[] = [], k8 = { run: 0 };
  for (let i = 0; i < 200; i++) {
    collect(rep1, { target: 1, stream: "stdout", text: "y".repeat(ITEM_OUTPUT_MAX) }, k8);
    collect(rep1, { target: 1, stream: "stdout", text: "more" }, k8);
    collect(rep1, { target: 1, clear: true }, k8);
  }
  assert.equal(notes(rep1), 1, "the item's own cut said once");
  const rep2: any[] = [], k9 = { run: 0 };
  for (let i = 0; i < 200; i++) {
    collect(rep2, { target: 1, stream: "stdout", text: "y" }, k9);
    collect(rep2, { cut: "item" }, k9);
    collect(rep2, { target: 1, clear: true }, k9);
  }
  assert.equal(notes(rep2), 1, "the worker's cut said once");
  // (and the run's cut: the board's output nearly spent; each cycle keeps a little there, is cut by the run's cap, and
  // its clear gives the little back)
  const rep3: any[] = [], k10 = { run: RUN_OUTPUT_MAX - 100 };
  for (let i = 0; i < 200; i++) {
    collect(rep3, { target: 1, stream: "stdout", text: "y".repeat(50) }, k10);
    collect(rep3, { target: 1, stream: "stdout", text: "y".repeat(80) }, k10);
    collect(rep3, { target: 1, clear: true }, k10);
  }
  assert.equal(notes(rep3), 1, "the run's cut said once");
  assert.equal(k10.run, RUN_OUTPUT_MAX - 100);
  assert.ok(textOf(rep2).length < 200 && textOf(rep1).length < 200, "nothing else kept growing");
  collect(rep2, { clear: true }, k9);
  collect(rep2, { cut: "item" }, k9);
  assert.equal(notes(rep2), 1, "after the item's own clear, a cut is said again, once");
  // (a traceback kept: the error is it, the reason last)
  const ok: any[] = [], k4 = { run: 0 };
  collect(ok, { target: 1, stream: "stdout", text: "5/3\n" }, k4);
  assert.equal(interactError(ok), null);
  collect(ok, { target: 1, stream: "stderr", text: tb }, k4);
  assert.match(String(interactError(ok)), /^Traceback[\s\S]*ZeroDivisionError: x\n\(raised by the item's @interact function, run with its default values\)$/);
});

test("board run: an @interact's output: what its clear gives back, and what is (and isn't) its error (grader's r788 pins)", () => {
  const MB = 2 ** 20, tb = "Traceback (most recent call last):\n  File \"<cell>\", line 3, in bad\nZeroDivisionError: x\n";
  const textOf = (l: any[]) => l.filter((o) => o.output_type === "stream").map((o) => o.text).join("");
  const displays = (l: any[]) => l.filter((o) => o.output_type === "display_data").length;
  // (I10: an interact's two writes joined into one entry, then its clear: both given back, so the item's whole
  // allowance can be written again)
  const j: any[] = [], k1 = { run: 0 };
  collect(j, { target: 1, stream: "stdout", text: "a".repeat(MB) }, k1);
  collect(j, { target: 1, stream: "stdout", text: "b".repeat(MB) }, k1);
  assert.equal(j.length, 1, "(joined)");
  collect(j, { target: 1, clear: true }, k1);
  assert.equal(k1.run, 0);
  collect(j, { stream: "stdout", text: "z".repeat(ITEM_OUTPUT_MAX) }, k1);
  assert.ok(!textOf(j).includes("[output cut") && textOf(j).length === ITEM_OUTPUT_MAX, "the item's whole allowance after the clear is kept");
  // (J5/J6: an interact's displays, up to the item's count, then its clear: as many more are kept)
  const d: any[] = [], k2 = { run: 0 };
  for (let i = 0; i < ITEM_DISPLAYS_MAX; i++) collect(d, { target: 1, display: { "text/plain": "d" } }, k2);
  assert.equal(displays(d), ITEM_DISPLAYS_MAX);
  collect(d, { target: 1, clear: true }, k2);
  assert.equal(displays(d), 0);
  for (let i = 0; i < ITEM_DISPLAYS_MAX; i++) collect(d, { display: { "text/plain": "e" } }, k2);
  assert.ok(displays(d) === ITEM_DISPLAYS_MAX && !textOf(d).includes("[output cut"), `kept ${displays(d)} displays after the clear: ${textOf(d)}`);
  // (J2: interacts past the flags' count, each raising, then the cell's own clear: the item's mark goes too, so a run
  // after it succeeding leaves no error)
  const many: any[] = [], k3 = { run: 0 };
  for (let t = 1; t <= ITEM_DISPLAYS_MAX + 50; t++) collect(many, { target: t, stream: "stderr", text: tb }, k3);
  assert.ok(interactError(many) !== null, "(raised)");
  collect(many, { clear: true }, k3);
  collect(many, { target: 1, stream: "stdout", text: "5/3\n" }, k3);
  assert.equal(interactError(many), null, "the cell's clear forgets the mark of the interacts it could not keep track of");
  // (I17/I18: a traceback's first line printed to stdout, nothing raised: no error)
  const out: any[] = [], k4 = { run: 0 };
  collect(out, { target: 1, stream: "stdout", text: "Traceback (most recent call last):\nnot really\n" }, k4);
  assert.equal(interactError(out), null, "stdout is not where an interact's error goes");
  // (I19: a warning on stderr, nothing raised: no error)
  const warn: any[] = [], k5 = { run: 0 };
  collect(warn, { target: 1, stream: "stderr", text: "UserWarning: careful\n" }, k5);
  collect(warn, { target: 1, stream: "stdout", text: "5/3\n" }, k5);
  assert.equal(interactError(warn), null, "a warning is not an error");
  // (J4: the item cut where the worker cut it, room left under the caps, then the clear of an interact that kept
  // nothing: nothing given back, so the cut stays)
  const cut: any[] = [], k6 = { run: 0 };
  collect(cut, { stream: "stdout", text: "y" }, k6);
  collect(cut, { cut: "item" }, k6);
  assert.ok(textOf(cut).includes("[output cut"), "(cut)");
  collect(cut, { target: 5, clear: true }, k6);
  collect(cut, { stream: "stdout", text: "small" }, k6);
  assert.ok(!textOf(cut).includes("small") && k6.run === 1, "a clear that gave nothing back doesn't lift the cut");
  // (I14: stderr before the traceback: the error is the traceback, from its first line)
  const pre: any[] = [], k7 = { run: 0 };
  collect(pre, { target: 1, stream: "stderr", text: "UserWarning: careful\n" }, k7);
  collect(pre, { target: 1, stream: "stderr", text: tb }, k7);
  assert.match(String(interactError(pre)), /^Traceback \(most recent call last\):\n[\s\S]*ZeroDivisionError: x\n\(raised by/);
});

test("board run: an item that does not stop when interrupted: the interpreter is stopped, and what was left is not run", () => {
  const t0 = Date.now();
  // (a catastrophic regular expression: the engine's own matching, which never polls Stop)
  const { status, report } = json(["-", "--timeout", "1"], board([{ id: "s", code: "import re\nre.match('(a+)+$', 'a' * 40 + 'b')" }, { id: "t", code: "print(1)" }]));
  assert.equal(status, 1);
  assert.deepEqual(report.items.map((i: any) => i.status), ["timeout", "not run"]);
  assert.match(report.items[1].error, /the interpreter was stopped/);
  assert.ok(Date.now() - t0 < 20_000);
});

// (the time limit's Stop wakes a time.sleep at once, as Ctrl-C does: a
// KeyboardInterrupt, the interpreter kept, and the next item run)
test("board run: an item sleeping past its time is interrupted at once, and the next item runs", () => {
  const t0 = Date.now();
  const { status, report } = json(["-", "--timeout", "1"], board([{ id: "s", code: "import time\ntime.sleep(100)" }, { id: "t", code: "print(1)" }]));
  assert.equal(status, 1);
  assert.deepEqual(report.items.map((i: any) => i.status), ["timeout", "ok"], JSON.stringify(report.items));
  assert.match(report.items[0].error, /KeyboardInterrupt/);
  assert.equal(report.items[1].stdout, "1\n");
  assert.ok(Date.now() - t0 < 15_000, String(Date.now() - t0));
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

test("board run: an item in another language than the board's is refused, not run in the board's (astra's CORR-C5A-2)", () => {
  // (Python's 2^3 is 1, Sage's 8: run here in the board's Python, it would say 1)
  const r = run(["-"], board([{ id: "s", title: "Sage", mode: "sage", code: "print(2^3)" }]));
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /code item 1 "Sage" is in Sage, not the board's Python: the command line runs a board's code in one language only/);
  // (an item whose mode is the board's own: run as before)
  const same = json(["-"], board([{ id: "s", mode: "sage", code: "print(2^3)" }], { mode: "sage" }));
  assert.equal(same.status, 0, JSON.stringify(same.report));
  assert.equal(item(same.report, "s").stdout, "8\n");
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
    // (a plot is an SVG: kept as its text, which a board shows only as an image (P9a), within the bounds)
    assert.match(p.c?.outputs?.[0]?.data?.["image/svg+xml"] ?? "", /^<svg /, JSON.stringify(p.c).slice(0, 300));
    for (const x of [p.a, p.b, p.c]) assert.deepEqual(cleanPreview(x), x, "a preview as the board reads it");
    assert.equal(readFileSync(f, "utf8"), before, "the board itself untouched");
    assert.equal(run(["-", "--store-previews"], board([])).status, 2, "standard input needs -o");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("board run: what it is told wrong, a board that is not one, and text for a terminal", () => {
  assert.equal(run([]).status, 2);
  assert.equal(run([boardExample("live.json"), "--bogus"]).status, 2);
  assert.equal(run([boardExample("live.json"), "-o", "x.json"]).status, 2, "-o is for --store-previews");
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
    run([boardExample("live.json"), "--bad\u001b[31m"]),
    run(["/nonexistent\u001b[2J.board.json"]),
  ]) {
    assert.ok(r.status === 1 || r.status === 2, String(r.status));
    assert.ok(r.stderr.length && !/[\u0000-\u0008\u000b-\u001f\u007f]/.test(r.stderr), JSON.stringify(r.stderr));
  }
});

test("board run: --timeout is a number of seconds a timer can wait; --preview-ms 0 or more (CORR-CD6-4)", () => {
  for (const t of ["Infinity", "2147484", "0", "-1", "NaN", "x"]) {
    const r = run([boardExample("live.json"), "--timeout", t]);
    assert.equal(r.status, 2, t);
    assert.match(r.stderr, /--timeout takes a number of seconds, more than 0 and at most 2147483/);
  }
  assert.equal(run([boardExample("live.json"), "--timeout", "2147483"]).status, 0);
  for (const t of ["Infinity", "-1"]) assert.match(run([boardExample("live.json"), "--store-previews", "--preview-ms", t]).stderr, /--preview-ms takes a number of milliseconds, 0 or more/);
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
  r = run([boardExample("live.json"), "--x\ny"]);
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
