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

test("board render: a page that is not there, a file that is not there, no file", () => {
  const p = cli([examples + "primes.json", "--page", "9"]);
  assert.equal(p.status, 2);
  assert.match(p.stderr, /--page: from 1 to 3/);
  const n = cli(["/nonexistent/board.json"]);
  assert.equal(n.status, 1);
  assert.match(n.stderr, /ENOENT/);
  assert.equal(cli([]).status, 2);
});
