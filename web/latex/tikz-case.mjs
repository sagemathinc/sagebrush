// One hostile TikZ case in a process of its own, for web/latex/test-latex-tikz.mjs: the test runs each case here under a
// deadline that kills the process, so a case that never ends, or runs out of memory, fails as that case instead of
// hanging the test. It reads {src, limits} as JSON on stdin (limits: TIKZ_LIMITS entries lowered for this case) and
// writes {why, ms, peak}: the named problem (null if the picture was drawn), the time renderTikz took, and the most
// text it read or was about to make at any point (opts.trace), in bytes.
//   echo '{"src": "\\draw (0,0) -- (1,0);"}' | bun web/latex/tikz-case.mjs
import { readFileSync } from "node:fs";
import { renderTikz, TikzError, TIKZ_LIMITS } from "./engine/tikz.mjs";

const { src, limits } = JSON.parse(readFileSync(0, "utf8"));
Object.assign(TIKZ_LIMITS, limits || {});
const t = performance.now();
let why = null;
const trace = { peak: 0 };
try { renderTikz(src, { trace }, { colors: {}, idn: 0 }); } catch (e) { why = e instanceof TikzError ? e.why : "NOT NAMED: " + e?.message; }
process.stdout.write(JSON.stringify({ why, ms: Math.round(performance.now() - t), peak: trace.peak }));
