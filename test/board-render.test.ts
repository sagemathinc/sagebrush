import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// `sagebrush board render`: a board (its JSON, a Mermaid flowchart, from a
// file or standard input) as an SVG file, without a browser (web/board/svg.ts).
const cli = (args: string[], input?: string) => spawnSync(process.execPath, [__dirname + "/../src/cli.js", "board", "render", ...args], { encoding: "utf8", input });
const examples = __dirname + "/../../web/board/examples/";

test("board render: an example board, to a file; a Mermaid flowchart from standard input", () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-render-"));
  try {
    const out = join(dir, "b.svg");
    const r = cli([examples + "primes.json", "--svg", "-o", out, "--page", "2"]);
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
  assert.match(r.stderr, /^sagebrush board: unknown board command "nonsense": this sagebrush \(dev\) has render, run, check, answers\n/);
});

test("board render: a page that is not there, a file that is not there, no file", () => {
  const p = cli([examples + "primes.json", "--page", "9"]);
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
