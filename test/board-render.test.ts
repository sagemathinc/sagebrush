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

// (P9a, the Codex friction recheck: code's outputs and pictures in the SVG, from what the file holds)
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
const at = "2026-11-07T00:00:00Z";

test("board render: a code item's stored preview is drawn, its text and its raster picture; without one, the way to store it is said", () => {
  const preview = { at, ms: 12000, total: 12000, outputs: [
    { output_type: "stream", name: "stdout", text: "5\n" },
    { output_type: "stream", name: "stderr", text: "careful <now>\n" },
    { output_type: "display_data", data: { "image/png": PNG, "text/plain": "Graphics object" }, metadata: {} },
  ] };
  const doc = { format: "sagebrush-board", version: 1, nodes: [{ id: "c", code: "print(2+3)", w: 300, preview }] };
  let r = cli(["-"], JSON.stringify(doc));
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!r.stdout.includes("output not stored"), "the output, not the placeholder");
  assert.match(r.stdout, />5<\/tspan>/, "the item's text output");
  assert.ok(r.stdout.includes("careful &lt;now&gt;") && !r.stdout.includes("<now>"), "stderr shown, escaped");
  assert.ok(r.stdout.includes(`<image `) && r.stdout.includes(`href="data:image/png;base64,${PNG}"`), "the preview's picture, as an <image> of its data: URL");
  assert.ok(!r.stdout.includes("Graphics object"), "the picture, not its text, when it has one");
  assert.match(r.stdout, /Preview, computed/);
  assert.ok(!r.stderr.includes("code's outputs"), r.stderr);
  // (no preview: the placeholder, and how to store the outputs, said once)
  r = cli(["-"], JSON.stringify({ ...doc, nodes: [{ id: "c", code: "print(2+3)" }] }));
  assert.equal(r.status, 0);
  assert.ok(r.stdout.includes("(output not stored)"));
  assert.ok(r.stderr.includes("shown only in part: code's outputs\n"), r.stderr);
  assert.ok(r.stderr.includes("code outputs aren't stored in this board, so they aren't drawn. To draw them, run\n  sagebrush board run FILE --store-previews --preview-ms 0\non the board's file, then render the .previews.board.json file it writes next to it.\n"), r.stderr);
  // (some stored, some not: said of those only, and the same way to store the rest)
  r = cli(["-"], JSON.stringify({ ...doc, nodes: [{ id: "c", code: "print(2+3)", preview }, { id: "d", code: "1", x: 0, y: 400 }] }));
  assert.ok(r.stderr.includes("code's outputs (of the items with no stored preview)") && r.stderr.includes("some code outputs aren't stored in this board"), r.stderr);
});

test("board render: the way to store code's outputs names this file and the one it writes, the command on its own line", () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-hint-"));
  try {
    const f = join(dir, "basic.board.json"), g = join(dir, "my plot.previews.board.json");
    writeFileSync(f, JSON.stringify({ format: "sagebrush-board", version: 1, nodes: [{ id: "c", code: "1" }] }));
    let r = cli([f, "-o", join(dir, "o.svg")]);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stderr.endsWith(`sagebrush board render: code outputs aren't stored in this file, so they aren't drawn. To draw them, run\n  sagebrush board run ${f} --store-previews --preview-ms 0\nthen render ${join(dir, "basic.previews.board.json")}, which that command writes next to it.\n`), r.stderr);
    // (a .previews.board.json already: written over, with -o; a name with a space: quoted)
    writeFileSync(g, JSON.stringify({ format: "sagebrush-board", version: 1, nodes: [{ id: "c", code: "1" }] }));
    r = cli([g, "-o", join(dir, "o.svg")]);
    assert.ok(r.stderr.includes(`  sagebrush board run '${g}' --store-previews --preview-ms 0 -o '${g}'\nthen render ${g} again.\n`), r.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("board render: a picture whose bytes are in the file is drawn as an <image>; an https: one stays a box and nothing in the file loads", () => {
  const doc = { format: "sagebrush-board", version: 1, images: { dot: { w: 1, h: 1, src: `data:image/png;base64,${PNG}` }, far: { w: 10, h: 10, src: "https://example.com/x.png" } },
    nodes: [{ id: "a", image: "dot", w: 120 }, { id: "b", image: "far", x: 300, w: 120 }] };
  const r = cli(["-"], JSON.stringify(doc));
  assert.equal(r.status, 0, r.stderr);
  const hrefs = [...r.stdout.matchAll(/<image [^>]*href="([^"]*)"/g)].map((m) => m[1]);
  assert.deepEqual(hrefs, [`data:image/png;base64,${PNG}`]);
  assert.ok(!r.stdout.includes("example.com"), "no address of the document's in the file");
  assert.ok(r.stderr.includes("pictures (shown as a box)"), r.stderr);
  // (a data: URL whose header doesn't give a size: a box, not an <image>)
  const bad = cli(["-"], JSON.stringify({ ...doc, images: { dot: { w: 10, h: 10, src: "data:image/png;base64,iVBORw0KGgo=" } }, nodes: [{ id: "a", image: "dot" }] }));
  assert.ok(!bad.stdout.includes("<image "), "an unreadable picture isn't drawn");
});

test("board render: python's P9 reproduction, after board run --store-previews --preview-ms 0, shows the text output", () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-p9-"));
  try {
    const f = join(dir, "basic.board.json");
    writeFileSync(f, JSON.stringify({ format: "sagebrush-board", version: 1, title: "probe", mode: "sage", nodes: [{ id: "c", title: "code", code: "print(2+3)", x: 0, y: 0, w: 300 }, { id: "p", title: "plot", code: "plot(sin(x),(x,0,3))", x: 0, y: 200, w: 300 }] }));
    const run = spawnSync(process.execPath, [__dirname + "/../src/cli.js", "board", "run", f, "--store-previews", "--preview-ms", "0"], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr + run.stdout);
    const r = cli([join(dir, "basic.previews.board.json")]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, />5<\/tspan>/, "the item's output, as stored");
    // (and its plot, an SVG, kept as its text in the preview and drawn as an <image> of its base64 data: URL: P9a, part 2)
    assert.match(r.stdout, /<image [^>]*href="data:image\/svg\+xml;base64,[A-Za-z0-9+/=]+"/, "the plot, as an <image>");
    assert.ok(!r.stderr.includes("code's outputs"), r.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("board render and check: an SVG picture is drawn as an <image> of its one form, its markup never in the file; past the bounds, refused", () => {
  // (hostile content: a script, an event handler, a remote image and a style import, which as an image does nothing)
  const hostile = '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="200" height="100" onload="alert(1)"><script>alert(2)</script>' +
    '<style>@import url(https://example.com/x.css);</style><image href="https://example.com/x.png" width="10" height="10"/><a xlink:href="javascript:alert(3)"><text y="50">hi "there" &amp; &lt;b&gt;</text></a></svg>';
  const doc = { format: "sagebrush-board", version: 1, images: { s: { w: 200, h: 100, src: "data:image/svg+xml;charset=utf-8," + encodeURIComponent(hostile) } }, nodes: [{ id: "a", image: "s", w: 220 }] };
  const r = cli(["-"], JSON.stringify(doc));
  assert.equal(r.status, 0, r.stderr);
  const hrefs = [...r.stdout.matchAll(/<image [^>]*href="([^"]*)"/g)].map((m) => m[1]);
  assert.equal(hrefs.length, 1);
  assert.match(hrefs[0], /^data:image\/svg\+xml;base64,[A-Za-z0-9+/]+={0,2}$/, "the one form, base64");
  assert.equal(Buffer.from(hrefs[0].slice(26), "base64").toString("utf8"), hostile, "the picture as it was, as data");
  for (const bad of ["<script", "onload", "example.com", "javascript:", "@import"]) assert.ok(!r.stdout.includes(bad), `no ${bad} in the file's markup`);
  assert.ok(!r.stderr.includes("pictures (shown as a box)"), r.stderr);
  // (board check: the picture is one the board shows; one past MAX_SIDE is an error)
  const dir = mkdtempSync(join(tmpdir(), "sb-svgpic-"));
  try {
    const f = join(dir, "s.board.json");
    writeFileSync(f, JSON.stringify(doc));
    const ok = spawnSync(process.execPath, [__dirname + "/../src/cli.js", "board", "check", f], { encoding: "utf8" });
    assert.ok(!/won't show this picture/.test(ok.stdout + ok.stderr), ok.stdout + ok.stderr);
    writeFileSync(f, JSON.stringify({ ...doc, images: { s: { w: 9000, h: 10, src: "data:image/svg+xml;charset=utf-8," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="9000" height="10"/>') } } }));
    const big = spawnSync(process.execPath, [__dirname + "/../src/cli.js", "board", "check", f], { encoding: "utf8" });
    assert.match(big.stdout + big.stderr, /won't show this picture: it is 9000 × 10 pixels/, big.stdout + big.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
