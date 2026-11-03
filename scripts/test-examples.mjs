// ci: checks.3 order=97
// The examples gallery's CI (scripts/examples-lib.mjs and scripts/examples.mjs, plan U7 final f8c4313e):
// which examples a change selects, the shard matrix and its census at every boundary, the manifest's and
// paths' refusals (A1), SVG canonicalization and output normalization (A5), and the runner on the fixture
// corpus (test/fixtures/examples) with its mutations: changed output, an error, a hang, a stale preview.
// Needs `pnpm run build` (dist/) for the runner's part.
//   node --test scripts/test-examples.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  SHARD_MAX,
  census,
  committedOutputs,
  committedPreview,
  FONTS_MARK,
  leaks,
  listExamples,
  manifestProblems,
  normalizeOutputs,
  pathProblem,
  select,
  shardCount,
  shardIds,
  sizeProblems,
  sha256,
  svgCanon,
} from "./examples-lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const FIX = join(here, "..", "test", "fixtures", "examples");
const ex = (id, extra = {}) => ({
  id,
  kind: id.split("/")[0],
  manifest: extra,
});
const CORPUS = [
  ex("board/b1"),
  ex("latex/plain"),
  ex("latex/sage-doc", { features: ["sagetex"] }),
  ex("notebook/n1"),
  ex("notebook/n2"),
];

test("select: each row of the trigger table", () => {
  const ids = (files, o) => select(files, CORPUS, o).ids;
  assert.deepEqual(ids(["examples/notebook/n1/main.ipynb"]), ["notebook/n1"]);
  assert.deepEqual(
    ids(["examples/notebook/gone/main.ipynb"]),
    [],
    "a removed example selects nothing",
  );
  assert.deepEqual(
    ids(["examples/schema.json"]),
    CORPUS.map((e) => e.id),
  );
  assert.deepEqual(
    ids(["scripts/examples-lib.mjs"]),
    CORPUS.map((e) => e.id),
  );
  assert.deepEqual(
    ids(["src/compile.ts"]),
    ["board/b1", "latex/sage-doc", "notebook/n1", "notebook/n2"],
    "engines: notebooks, boards, executable latex",
  );
  assert.deepEqual(ids(["web/board/render.ts"]), ["board/b1"]);
  assert.deepEqual(ids(["web/latex/engine/expand.ts"]), [
    "latex/plain",
    "latex/sage-doc",
  ]);
  assert.deepEqual(ids(["README.md"]), []);
  assert.deepEqual(
    ids(["README.md"], { all: true }),
    CORPUS.map((e) => e.id),
  );
});

test("shards: every selected id exactly once, at most 24 per shard, at every boundary; over the matrix limit refused", () => {
  for (const n of [0, 1, 24, 25, 288, 289, 320, 6144]) {
    const all = Array.from(
      { length: n },
      (_, i) => `notebook/e${String(i).padStart(5, "0")}`,
    );
    const N = shardCount(n);
    assert.equal(N, Math.ceil(n / SHARD_MAX), `n=${n}`);
    const lists = Array.from({ length: N }, (_, k) => shardIds(all, k + 1, N));
    assert.deepEqual(census(all, lists), [], `n=${n}`);
    assert.ok(
      lists.every((l) => l.length <= SHARD_MAX && l.length > 0),
      `n=${n}: each shard 1 to ${SHARD_MAX}`,
    );
  }
  assert.throws(() => shardCount(6145), /GitHub's matrix limit/);
});

test("census: missing, repeated, unselected and oversized shards", () => {
  assert.deepEqual(census(["a", "b"], [["a"]]), ["b: selected but never ran"]);
  assert.deepEqual(census(["a"], [["a"], ["a"]]), ["a: ran 2 times"]);
  assert.deepEqual(census(["a"], [["a", "z"]]), ["z: ran but wasn't selected"]);
  const big = Array.from({ length: 25 }, (_, i) => `x${i}`);
  assert.match(census(big, [big]).join(), /more than 24/);
});

test("paths (A1): only strict relative paths", () => {
  for (const ok of ["main.ipynb", "data/x.csv", "a b/c-d_e.f.txt"])
    assert.equal(pathProblem(ok), null, ok);
  for (const bad of [
    "",
    "../x",
    "a/../b",
    "/abs",
    "a\\b",
    "%2e%2e/x",
    "a%2fb",
    ".hidden",
    "a/./b",
    "a/b/c/d/e",
    "a/x?y",
    "é.txt",
  ])
    assert.ok(pathProblem(bad), JSON.stringify(bad));
});

test("manifests: the schema by kind, and the folder's real files", () => {
  const tags = ["basics"];
  const base = {
    title: "T",
    summary: "S",
    tags: ["basics"],
    level: "intro",
    main: "main.ipynb",
    files: ["main.ipynb"],
    author: "A",
    license: "MIT",
    mode: "python",
  };
  assert.deepEqual(
    manifestProblems(base, "notebook", ["example.json", "main.ipynb"], tags),
    [],
  );
  const p = (
    m,
    kind = "notebook",
    present = ["example.json", ...(m.files ?? [])],
  ) => manifestProblems(m, kind, present, tags).join("; ");
  assert.match(p({ ...base, extra: 1 }), /unknown field "extra"/);
  assert.match(p({ ...base, title: undefined }), /title/);
  assert.match(p({ ...base, tags: ["nope"] }), /tags/);
  assert.match(p({ ...base, license: "CC-BY-4.0" }), /license: MIT/);
  assert.match(p({ ...base, mode: undefined }), /mode/);
  assert.match(p({ ...base, main: "other.ipynb" }), /main: one of the files/);
  assert.match(p({ ...base, files: ["main.ipynb", "Main.ipynb"] }), /collides/);
  assert.match(
    p({ ...base, files: ["main.ipynb", "d", "d/x"] }),
    /both a file and a folder/,
  );
  assert.match(p({ ...base, files: ["main.ipynb", "../x"] }), /"\.\.\/x"/);
  assert.match(
    p(base, "notebook", ["example.json", "main.ipynb", "stray.txt"]),
    /stray\.txt: in the folder but not in files/,
  );
  assert.match(
    p(base, "notebook", ["example.json"]),
    /main\.ipynb: listed but missing/,
  );
  assert.match(
    p({ ...base, loose: [{ cell: 0, output: 0, compare: "type-only" }] }),
    /loose/,
  );
  const tex = {
    ...base,
    mode: undefined,
    main: "main.tex",
    files: ["main.tex"],
  };
  delete tex.mode;
  assert.equal(p(tex, "latex"), "");
  assert.match(
    p({ ...tex, features: ["sagetex", "wysiwyg"] }, "latex"),
    /features/,
  );
  assert.match(p({ ...tex, mode: "python" }, "latex"), /unknown field "mode"/);
  assert.match(
    p({ ...tex, main: "main.ipynb", files: ["main.ipynb"] }, "latex"),
    /main: a \.tex file/,
  );
});

test("SVG canonicalization: generated ids don't matter, coordinates do (no rounding)", () => {
  const svg = (id, y) =>
    `<svg><defs><clipPath id="${id}"><rect/></clipPath></defs><path clip-path="url(#${id})" d="M 0 0 L 1 ${y}"/><use href="#${id}"/></svg>`;
  assert.equal(
    sha256(svgCanon(svg("p7a3f9e2b1c", "1"))),
    sha256(svgCanon(svg("p0d4e88aa9f", "1"))),
  );
  assert.notEqual(
    sha256(svgCanon(svg("p7a3f9e2b1c", "1"))),
    sha256(svgCanon(svg("p7a3f9e2b1c", "1.0001"))),
  );
  assert.equal(
    svgCanon('<svg id="title"/>'),
    '<svg id="title"/>',
    "a name, not a generated id, is kept",
  );
});

test("committed outputs (r4.1): an image keeps its text/plain, not its interactive forms; the rest as it came", () => {
  const scene = {
    output_type: "display_data",
    data: {
      "application/vnd.sagebrush.scene3d+json": { polys: [1, 2, 3] },
      "image/svg+xml": "<svg/>",
      "text/html": "<div class=sb3d>...</div>",
      "text/plain": "Graphics3d",
    },
    metadata: { "text/html": { isolated: true }, "image/svg+xml": { w: 1 } },
  };
  const html = { output_type: "display_data", data: { "text/html": "<table/>", "text/plain": "t" } };
  const stream = { output_type: "stream", name: "stdout", text: "x\n" };
  assert.deepEqual(committedOutputs([scene, html, stream]), [
    { output_type: "display_data", data: { "image/svg+xml": "<svg/>", "text/plain": "Graphics3d" }, metadata: { "image/svg+xml": { w: 1 } } },
    html,
    stream,
  ]);
  assert.deepEqual(committedOutputs(undefined), []);
});

test("committed previews (r4.1): KaTeX's shared stylesheet as a marker, exactly one; the rest the render's bytes", () => {
  const css = "@font-face{font-display:block;font-family:KaTeX_AMS;src:url(data:font/woff2;base64,AAAA)}.katex{x:1}";
  const page = `<!doctype html><style>${css}</style>\n<style>.tex-page{}</style><p>$x$</p>`;
  assert.deepEqual(committedPreview(page), { html: `<!doctype html>${FONTS_MARK}\n<style>.tex-page{}</style><p>$x$</p>`, fonts: css });
  assert.equal(committedPreview("<p>none</p>").fonts, null);
  assert.equal(committedPreview(`<style>${css}</style><style>${css}</style>`).fonts, null, "two: neither is taken for the shared one");
});

test("sizes (section 5, r4.1): a notebook's sources without its outputs; its outputs at most 1 MB", () => {
  const dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "examples-size-"));
  const m = { main: "main.ipynb", files: ["main.ipynb"] };
  const nb = (outputBytes) => ({
    cells: [{ cell_type: "code", metadata: {}, source: "1", outputs: [{ output_type: "stream", name: "stdout", text: "x".repeat(outputBytes) }], execution_count: null }],
    metadata: {},
    nbformat: 4,
    nbformat_minor: 5,
  });
  writeFileSync(join(dir, "main.ipynb"), JSON.stringify(nb(600 * 1024), null, 1) + "\n");
  assert.deepEqual(sizeProblems(dir, m), [], "600 KB of outputs: within the outputs' limit, not counted as sources");
  writeFileSync(join(dir, "main.ipynb"), JSON.stringify(nb(1100 * 1024), null, 1) + "\n");
  assert.match(sizeProblems(dir, m).join(), /its outputs: \d+ bytes, more than 1048576/);
  const big = nb(0);
  big.cells[0].source = "#".repeat(210 * 1024);
  writeFileSync(join(dir, "main.ipynb"), JSON.stringify(big, null, 1) + "\n");
  assert.match(sizeProblems(dir, m).join(), /main\.ipynb: \d+ bytes, more than 204800/);
});

test("normalization (A5): streams joined, HTML exact, images hashed, errors and loose outputs", () => {
  const n = (outs, loose) => normalizeOutputs(outs, loose);
  assert.deepEqual(
    n([
      { output_type: "stream", name: "stdout", text: "a" },
      { output_type: "stream", name: "stdout", text: ["b", "\n"] },
    ]).outputs,
    [{ stream: "stdout", text: "ab\n" }],
  );
  const html = (t) =>
    n([{ output_type: "display_data", data: { "text/html": t } }]).outputs;
  assert.notDeepEqual(
    html("<pre>a  b</pre>"),
    html("<pre>a b</pre>"),
    "<pre> whitespace is compared",
  );
  const png = (b) =>
    n([
      {
        output_type: "display_data",
        data: { "image/png": Buffer.from(b).toString("base64") },
      },
    ]).outputs[0].rich["image/png"];
  assert.equal(png("x"), "sha256:" + sha256("x"));
  assert.notEqual(png("x"), png("y"));
  assert.match(
    n([
      {
        output_type: "error",
        ename: "ZeroDivisionError",
        evalue: "division by zero",
      },
    ]).error,
    /ZeroDivisionError/,
  );
  assert.deepEqual(
    n(
      [{ output_type: "stream", name: "stdout", text: "changes every run" }],
      (i) => i === 0,
    ).outputs,
    [{ loose: "stream" }],
  );
  const out = [
    [{ stream: "stdout", text: "/tmp/example-XYZ/work 2026-11-03" }],
  ];
  assert.deepEqual(
    leaks(out, {
      tmp: "/tmp/example-XYZ",
      date: "2026-11-03",
      host: "nohost-here",
    }),
    [
      "the run's temporary folder (/tmp/example-XYZ)",
      "today's date (2026-11-03)",
    ],
  );
});

// ---- the runner, on the fixture corpus (needs dist/)
const run = (args, env = {}) =>
  spawnSync(process.execPath, [join(here, "examples.mjs"), ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 300_000,
  });
const copy = () => {
  const d = join(
    mkdtempSync(join(process.env.TMPDIR || tmpdir(), "examples-fix-")),
    "examples",
  );
  cpSync(FIX, d, { recursive: true });
  return d;
};

test("the fixture corpus validates, and every fixture runs and matches what is committed", () => {
  const v = run(["validate", "--root", FIX]);
  assert.equal(v.status, 0, v.stderr);
  const ids = listExamples(FIX).map((e) => e.id);
  assert.deepEqual(ids, [
    "board/hello",
    "latex/article",
    "notebook/hello-python",
    "notebook/sage-basics",
  ]);
  const r = run(["run", ...ids, "--root", FIX]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  for (const id of ids)
    assert.match(r.stdout, new RegExp(`^ok {3}${id} `, "m"));
});

test("the runner fails a changed output, an error, a hang (killed at the deadline) and a stale preview", () => {
  const root = copy();
  const nbFile = join(root, "notebook", "hello-python", "main.ipynb");
  const nb = JSON.parse(readFileSync(nbFile, "utf8"));
  const code = nb.cells.filter((c) => c.cell_type === "code");
  code[1].outputs[0].text = "0 0\n1 1\n2 5\n";
  writeFileSync(nbFile, JSON.stringify(nb));
  let r = run(["run", "notebook/hello-python", "--root", root]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /the outputs differ from the committed ones/);
  code[1].source = "1/0";
  writeFileSync(nbFile, JSON.stringify(nb));
  r = run(["run", "notebook/hello-python", "--root", root]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /cell 2 raised/);
  code[1].source = "while True:\n    pass";
  writeFileSync(nbFile, JSON.stringify(nb));
  const t = Date.now();
  r = run(["run", "notebook/hello-python", "--root", root], {
    EXAMPLES_DEADLINE_MS: "3000",
  });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /killed at 3 s/);
  assert.ok(Date.now() - t < 20_000, "killed promptly");
  // (a board whose code item raises fails, through board check's report)
  const bFile = join(root, "board", "hello", "main.board.json");
  const board = JSON.parse(readFileSync(bFile, "utf8"));
  const items = JSON.stringify(board).match(/"code":"[^"]*"/g) ?? [];
  assert.ok(items.length > 0, "the fixture board has a code item");
  writeFileSync(bFile, JSON.stringify(board).replace(items[0], '"code":"1/0"'));
  r = run(["run", "board/hello", "--root", root]);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /board check failed/);
  // (a .board.json without its format header doesn't validate: the runner would take it for an older board)
  delete board.format;
  writeFileSync(bFile, JSON.stringify(board));
  r = run(["validate", "--root", root]);
  assert.equal(r.status, 1);
  assert.match(r.stdout + r.stderr, /board\/hello: main: a \.board\.json needs "format": "sagebrush-board"/);
  writeFileSync(join(root, "latex", "article", "preview.html"), "<p>stale</p>");
  r = run(["run", "latex/article", "--root", root]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /preview\.html differs/);
});

test("ci shards and their census, end to end", () => {
  const root = copy();
  const ids = listExamples(root).map((e) => e.id);
  const out = mkdtempSync(
    join(process.env.TMPDIR || tmpdir(), "examples-ran-"),
  );
  const env = { EXAMPLES_IDS: JSON.stringify(ids) };
  for (const k of [1, 2]) {
    const r = run(
      [
        "ci",
        "--shard",
        String(k),
        "--of",
        "2",
        "--ran",
        join(out, `ran-${k}.json`),
        "--root",
        root,
      ],
      env,
    );
    assert.equal(r.status, 0, r.stdout + r.stderr);
  }
  let c = run(["census", "--ran-dir", out], env);
  assert.equal(c.status, 0, c.stderr);
  assert.match(c.stdout, /census: 2 shards, 4 runs: ok/);
  writeFileSync(join(out, "ran-2.json"), "[]\n");
  c = run(["census", "--ran-dir", out], env);
  assert.equal(c.status, 1);
  assert.match(c.stderr, /selected but never ran/);
});
