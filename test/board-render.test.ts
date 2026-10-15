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

test("board: only `board render` is the board's command (else a program named board, as before)", () => {
  const r = spawnSync(process.execPath, [__dirname + "/../src/cli.js", "board", "nonsense"], { encoding: "utf8" });
  assert.doesNotMatch(r.stderr + r.stdout, /usage: sagebrush board render/);
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
