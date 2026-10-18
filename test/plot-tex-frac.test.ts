import test from "node:test";
import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";

// Inline \frac in plot labels draws the same expression as the TeX: parts
// that are more than a factor are parenthesized, and so is the fraction
// when a factor or a script is next to it (astra's CORR-578-1:
// \frac{x+1}{y+1} was drawn x + 1/y + 1).  _tex_text is the drawn text
// without its markup.
const DIST = __dirname + "/..";

// The message of the exception the code raises (its last line).
function run(code: string): Promise<string> {
  const w = new Worker(
    `
    const { parentPort, workerData } = require("node:worker_threads");
    const c = require(workerData.dist + "/src/compile.js");
    Promise.resolve(c.initParser && c.initParser()).then(() => {
      c.R.importModule("sys").path.push(c.libDir());
      try {
        c.execModule(workerData.code, "<test>", "__main__");
        parentPort.postMessage({ done: "finished" });
      } catch (e) {
        parentPort.postMessage({ done: c.R.formatException(e).trim().split("\\n").pop() });
      }
    });
    `,
    { eval: true, workerData: { dist: DIST, code } },
  );
  return new Promise((resolve, reject) => {
    w.on("message", (m) => (w.terminate(), resolve(m.done)));
    w.on("error", reject);
  });
}

test("\\frac keeps its grouping inline", async () => {
  const cases: [string, string][] = [
    ["\\frac{x+1}{y+1}", "(x + 1)/(y + 1)"],
    ["\\frac{1}{2}", "1/2"],
    ["\\frac{a}{bc}", "a/(bc)"],
    ["\\frac{xy}{z}", "xy/z"],
    ["\\frac{1}{\\frac{a}{b}}", "1/(a/b)"],
    ["\\frac{\\frac{a}{b}}{c}", "(a/b)/c"],
    ["\\frac{a}{b}c", "(a/b)c"],
    ["2\\frac{1}{3}", "2(1/3)"],
    ["\\frac{1}{2}\\frac{3}{4}", "(1/2)(3/4)"],
    ["-\\frac{a+b}{\\pi} + 1", "-(a + b)/π + 1"],
    ["1 + \\frac{1}{2}", "1 + 1/2"],
    ["\\frac{1.5}{2.25}", "1.5/2.25"],
  ];
  const texs = JSON.stringify(JSON.stringify(cases.map((c) => c[0])));
  const code = `import _graphics, json\nraise ValueError(json.dumps([_graphics._tex_text(t) for t in json.loads(${texs})]))`;
  const got = await run(code);
  assert.ok(got.startsWith("ValueError: "), got);
  const texts: string[] = JSON.parse(got.slice("ValueError: ".length));
  cases.forEach(([tex, want], i) => assert.equal(texts[i], want, tex));
});

test("Graphics.save refuses an infinite, NaN, zero or negative dpi or figsize before any arithmetic on it", async () => {
  // (daybreak2's limits review: int(width * dpi) ran first, an OverflowError
  // escaped for dpi=inf)
  const bad = ["dpi=float('inf')", "dpi=float('nan')", "dpi=0", "dpi=-5", "dpi=10**6", "figsize=[float('inf'), 3]", "figsize=[float('nan'), 3]", "figsize=[0, 3]"];
  for (const b of bad) {
    const code = `import sage_all as S, tempfile, os\nG = S.plot(S.x, (S.x, 0, 1))\ntry:\n    G.save(os.path.join(tempfile.mkdtemp(), 'a.png'), ${b})\nexcept ValueError as e:\n    raise ValueError('refused' if 'Sagebrush writes at most' in str(e) else str(e))`;
    assert.equal(await run(code), "ValueError: refused", b);
  }
});
