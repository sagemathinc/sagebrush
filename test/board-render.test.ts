import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boardExample, boardExamples } from "./board-examples";

// `sagebrush board render`: a board (its JSON, a Mermaid flowchart, from a
// file or standard input) as an SVG file, without a browser (web/board/svg.ts).
const cli = (args: string[], input?: string) => spawnSync(process.execPath, [__dirname + "/../src/cli.js", "board", "render", ...args], { encoding: "utf8", input });

test("board render: an example board, to a file; a Mermaid flowchart from standard input", () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-render-"));
  try {
    const out = join(dir, "b.svg");
    const r = cli([boardExample("primes.json"), "--svg", "-o", out, "--page", "2"]);
    assert.equal(r.status, 0, r.stderr);
    const svg = readFileSync(out, "utf8");
    assert.match(svg, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    assert.match(svg, /<\/svg>\n$/);
    const m = cli(["-"], "flowchart LR\n  A[Start <b>here</b>] -->|go| B{Ok?}\n");
    assert.equal(m.status, 0, m.stderr);
    assert.match(m.stdout, /Start/);
    assert.ok(!/<b>|<script/.test(m.stdout), "markup in a label is text, or dropped");
    const f = join(dir, "x.mmd");
    writeFileSync(f, "graph TD\n  x --> y\n");
    assert.equal(cli([f]).status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("board render: a note whose text is cut to its box is said, its id quoted (no control character reaches the terminal)", () => {
  const r = cli(["-"], JSON.stringify({ nodes: [{ id: "a\u001b[31m", w: 90, h: 25, text: "This fixed-height note contains enough text to be clipped badly." }] }));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /text cut to its note's box/);
  assert.ok(r.stderr.includes(JSON.stringify("a\u001b[31m")) && !r.stderr.includes("\u001b"), r.stderr);
});

test("board: a board command it doesn't have is said so (agent-UX R0-3); a program named board still runs when there is one (test/board-check.test.ts)", () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-board-cmd-"));
  const r = spawnSync(process.execPath, [__dirname + "/../src/cli.js", "board", "nonsense"], { encoding: "utf8", cwd: dir });
  rmSync(dir, { recursive: true, force: true });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /^sagebrush board: unknown board command "nonsense": this sagebrush \(dev\) has render, run, check, answers, try, open\n/);
});

test("board render: a page that is not there, a file that is not there, no file", () => {
  const p = cli([boardExample("primes.json"), "--page", "9"]);
  assert.equal(p.status, 2);
  assert.match(p.stderr, /--page: from 1 to 3/);
  const n = cli(["/nonexistent/board.json"]);
  assert.equal(n.status, 1);
  assert.match(n.stderr, /ENOENT/);
  assert.equal(cli([]).status, 2);
});

test("board render: a board of a later version of the format, or another format, is refused as the board refuses it, and nothing drawn", () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-render-"));
  try {
    const out = join(dir, "later.svg");
    const later = JSON.stringify({ format: "sagebrush-board", version: 99, nodes: [{ id: "a", title: "A" }] });
    let r = cli(["-"], later);
    assert.equal(r.status, 1);
    assert.equal(r.stdout, "");
    // (the command line's own words: which sagebrush refused it, and what to do)
    assert.match(r.stderr, /^sagebrush board render: -: this board is in version 99 of the format, from a later Sagebrush; this sagebrush \((dev|\d+\.\d+\.\d+\S*)\) reads version 1: update sagebrush \(npx sagebrush@latest\)\n$/);
    r = cli(["-", "-o", out], later);
    assert.equal(r.status, 1);
    assert.throws(() => readFileSync(out), "no file written");
    // (another format, its name quoted, no control character reaching the terminal)
    r = cli(["-"], JSON.stringify({ format: "evil\u001b[31m", nodes: [] }));
    assert.equal(r.status, 1);
    assert.equal(r.stdout, "");
    assert.ok(r.stderr.includes("not a Sagebrush board: its format is") && !r.stderr.includes("\u001b"), r.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("board render: what it says of a board it refuses is one line: a newline or a tab in the format, or in the file's name, escaped (HARD-EC2-1)", () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-render-"));
  try {
    const evil = JSON.stringify({ format: "evil\nINJECTED: ok\tX", nodes: [] });
    let r = cli(["-"], evil);
    assert.equal(r.status, 1);
    assert.equal(r.stdout, "");
    assert.equal(r.stderr, 'sagebrush board render: -: not a Sagebrush board: its format is "evil\\x0aINJECTED: ok\\x09X"\n');
    const file = join(dir, "a\nINJECTED: ok\tb.json");
    writeFileSync(file, evil);
    r = cli([file]);
    assert.equal(r.status, 1);
    assert.equal(r.stderr.split("\n").length, 2, r.stderr);
    assert.ok(r.stderr.includes("a\\x0aINJECTED: ok\\x09b.json: not a Sagebrush board"), r.stderr);
    // (an option it does not know, likewise)
    r = cli(["--x\ny", "-"], evil);
    assert.equal(r.status, 2);
    assert.ok(r.stderr.startsWith("sagebrush board render: unknown option --x\\x0ay\nusage:"), r.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("board render: pictures the board leaves out for their names are named on stderr, with the rule; good names say nothing", () => {
  const src = "data:image/png;base64,iVBORw0KGgo=", pic = { w: 10, h: 10, src };
  const doc = { format: "sagebrush-board", version: 1, background: { image: "back ground" }, images: { "plot 1": pic, "fig-1": pic, "figure.png": pic }, nodes: [{ id: "a", image: "plot 1" }, { id: "b", image: "fig-1" }, { id: "c", image: "figure.png" }, { id: "g", kind: "group", children: [{ id: "d", image: "in\ngroup" }] }] };
  let r = cli(["-"], JSON.stringify(doc));
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes("<svg "), "drawn all the same");
  // (its first line: what else the render says, of pictures it shows as boxes, follows)
  assert.equal(r.stderr.split("\n")[0] + "\n", 'sagebrush board render: pictures left out: a picture\'s name is letters, digits, _ and -, at most 100 characters (plot-1, not "plot 1" or "figure.png"), and these are not: "plot 1", "figure.png", "back ground", "in\\ngroup"\n');
  // (good names: nothing said)
  r = cli(["-"], JSON.stringify({ ...doc, background: undefined, images: { "fig-1": pic }, nodes: [{ id: "b", image: "fig-1" }] }));
  assert.equal(r.status, 0);
  assert.ok(!r.stderr.includes("left out"), r.stderr);
  // (many: the first ten, and how many more)
  const many = Array.from({ length: 12 }, (_, i) => `p ${i}`);
  r = cli(["-"], JSON.stringify({ format: "sagebrush-board", version: 1, images: Object.fromEntries(many.map((n) => [n, pic])), nodes: [{ id: "a", text: "x" }] }));
  assert.match(r.stderr, /^sagebrush board render: pictures left out: .*and these are not: "p 0", [^\n]*"p 9", and 2 more\n/);
});

// A Markdown table in a note is a grid (codex friction P10a): each cell its own text, in its column, the header row
// bold and ruled off, cells aligned as the separator row says, and a narrow note's cells wrapped at words (never a
// "4 | 2" line). The reproduction is python's recheck's, repro/P10/table.board.json.
const texts = (svg: string) => [...svg.matchAll(/<text x="([\d.-]+)" y="([\d.-]+)"[^>]*>(.*?)<\/text>/g)].map((m) => ({ x: +m[1], y: +m[2], t: m[3].replace(/<[^>]*>/g, "") }));
test("board render: a Markdown table is a grid, each cell in its column, the header ruled off (P10a)", () => {
  const doc = { format: "sagebrush-board", version: 1, title: "t", mode: "sage", nodes: [{ id: "n", title: "table", text: "| Degree | Power |\n|---|---|\n| 4 | 2 |\n| 5 | 3 |", x: 0, y: 0, w: 300 }] };
  const r = cli(["-"], JSON.stringify(doc));
  assert.equal(r.status, 0, r.stderr);
  const ts = texts(r.stdout), at = (s: string) => ts.find((x) => x.t === s);
  for (const s of ["Degree", "Power", "4", "2", "5", "3"]) assert.ok(at(s), `"${s}" is a cell's own text: ${JSON.stringify(ts.map((x) => x.t))}`);
  assert.ok(!ts.some((x) => x.t.includes("|")), "no cell joined to another with a |");
  assert.ok(at("4")!.x === at("Degree")!.x && at("5")!.x === at("Degree")!.x && at("2")!.x === at("Power")!.x && at("Power")!.x > at("Degree")!.x, "each column under its header");
  assert.ok(at("Degree")!.y < at("4")!.y && at("4")!.y < at("5")!.y && at("Power")!.y === at("Degree")!.y, "the header first, a row a line");
  assert.match(r.stdout, /<tspan font-weight="bold">Degree<\/tspan>/, "the header bold");
  assert.match(r.stdout, /<path d="M[\d.]+ [\d.]+H[\d.]+" fill="none" stroke="#8a9099" stroke-width="1.5"\/>/, "the header ruled off");
});
test("board render: a table's cells aligned as its separator row says, and wrapped at words in a narrow note (P10a)", () => {
  const doc = { format: "sagebrush-board", version: 1, nodes: [
    { id: "a", text: "| left | center | right |\n|:---|:---:|---:|\n| 1 | 22 | 333 |", x: 0, y: 0, w: 300 },
    { id: "b", text: "| a very long header cell | another long one |\n|---|---|\n| some quite long content here | more |", x: 0, y: 300, w: 200 }] };
  const r = cli(["-"], JSON.stringify(doc));
  assert.equal(r.status, 0, r.stderr);
  const ts = texts(r.stdout), at = (s: string) => ts.find((x) => x.t === s)!;
  // (a column's text: left at its left padding, centered, at its right padding: the header's and the cell's sides agree)
  assert.equal(at("1").x, at("left").x, "left-aligned");
  assert.ok(at("22").x > at("center").x, "centered: a narrower cell starts further in than its header");
  assert.ok(at("333").x > at("right").x, "right-aligned: a narrower cell starts further in than its header");
  const narrow = ts.filter((x) => x.y > 300);
  assert.ok(!narrow.some((x) => x.t.includes("…")), "nothing cut with an ellipsis");
  for (const w of ["a very", "long", "header", "cell", "another", "long one", "some quite", "content", "here", "more"]) assert.ok(narrow.some((x) => x.t === w), `"${w}" a wrapped line of its own: ${JSON.stringify(narrow.map((x) => x.t))}`);
  assert.ok(!narrow.some((x) => /^(anothe|r long( one)?)$/.test(x.t)), "no word broken: each column at least as wide as its longest word");
});
// (a table's grid: each row's path, its segments' x and y; the first row's starts with its top edge)
const grids = (svg: string) => [...svg.matchAll(/<path d="([^"]+)" fill="none" stroke="#c8ccd2"\/>/g)].map((m) => m[1]);
const gridXs = (d: string) => [...d.matchAll(/M([\d.-]+) [\d.-]+|H([\d.-]+)/g)].map((m) => +(m[1] ?? m[2]));
const gridY = (d: string) => +/^M[\d.-]+ ([\d.-]+)/.exec(d)![1], within = (gs: string[], y0: number, y1: number) => gs.filter((d) => gridY(d) >= y0 && gridY(d) < y1);
test("board render: a table's grid fits its note, its rows as tall as their tallest cells, its top drawn (P10a)", () => {
  const doc = { format: "sagebrush-board", version: 1, nodes: [
    { id: "a", text: "| Degree | Power |\n|---|---|\n| 4 | 2 |", x: 0, y: 0, w: 300 },
    // (columns too wide even at their longest words: narrowed together to the note's text width, 120 - 2 * 11)
    { id: "b", text: "| supercalifragilistic | antidisestablishmentarian |\n|---|---|\n| x | y |", x: 0, y: 200, w: 120 },
    // (a row whose second cell wraps to many lines: the next row below its last)
    { id: "c", text: "| a | b |\n|---|---|\n| x | aaa bbb ccc ddd eee fff ggg hhh iii jjj kkk |\n| next | z |", x: 0, y: 400, w: 160 }] };
  const r = cli(["-"], JSON.stringify(doc));
  assert.equal(r.status, 0, r.stderr);
  const ts = texts(r.stdout), gs = grids(r.stdout);
  const top = /^M([\d.]+) ([\d.]+)H([\d.]+)M/.exec(gs[0]);
  assert.ok(top && +top[2] < ts.find((x) => x.t === "Degree")!.y - 10, `the first row's path starts with the table's top edge: ${gs[0]}`);
  const b = within(gs, 200, 400).flatMap(gridXs);
  assert.ok(b.length && Math.max(...b) <= 109.5, `the narrow note's grid inside its text width (right edge 109): ${Math.max(...b)}`);
  const cell = ts.filter((x) => x.y > 400 && /^[a-k]{3}( [a-k]{3})*$/.test(x.t));
  assert.ok(cell.length >= 3, `the long cell wrapped to 3 lines or more: ${JSON.stringify(cell.map((x) => x.t))}`);
  assert.ok(ts.find((x) => x.t === "next")!.y > Math.max(...cell.map((x) => x.y)) + 10, "the next row below the long cell's last line");
});
test("board render: a table in a centred shape is centred; a math cell's column is as wide as its formula (P10a)", () => {
  const doc = { format: "sagebrush-board", version: 1, nodes: [
    { id: "s", shape: "rect", text: "| x | y |\n|---|---|\n| 1 | 2 |", x: 0, y: 0, w: 300, h: 160 },
    { id: "m", text: "| f | g |\n|---|---|\n| $\\alpha\\beta\\gamma\\delta\\epsilon$ | t |", x: 0, y: 300, w: 400 }] };
  const r = cli(["-"], JSON.stringify(doc));
  assert.equal(r.status, 0, r.stderr);
  const gs = grids(r.stdout);
  // (the shape's text from x 11, 278 wide: the grid's left edge at 11 + (278 - its width) / 2)
  const s = within(gs, 0, 200).flatMap(gridXs), sl = Math.min(...s), sw = Math.max(...s) - sl;
  assert.ok(Math.abs(sl - (11 + (278 - sw) / 2)) <= 0.2, `centred: left ${sl}, width ${sw}`);
  const mv = /<svg x="([\d.]+)" y="3\d\d(?:\.\d)?" width="([\d.]+)"/.exec(r.stdout);
  assert.ok(mv, "the formula typeset as SVG");
  const m = within(gs, 300, 500).flatMap(gridXs), cols = [...new Set(m)].sort((p, q) => p - q);
  assert.ok(Math.abs(cols[1] - cols[0] - (+mv[2] + 12)) <= 0.2, `the math column as wide as the formula + padding: ${cols} vs ${mv[2]}`);
});
