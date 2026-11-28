// One hostile TikZ case in a process of its own, for web/latex/test-latex-tikz.mjs: the test runs each case here under a
// deadline that kills the process, so a case that never ends, or runs out of memory, fails as that case instead of
// hanging the test. It reads {src, limits, label} as JSON on stdin (limits: TIKZ_LIMITS entries lowered for this case;
// label: node text typeset by KaTeX) and
// writes {why, ms, peak}: the named problem (null if the picture was drawn), the time renderTikz took, and the most
// text it read or was about to make at any point (opts.trace), in bytes.
//   echo '{"src": "\\draw (0,0) -- (1,0);"}' | bun web/latex/tikz-case.mjs
import { readFileSync } from "node:fs";
import { renderTikz, TikzError, TIKZ_LIMITS } from "./engine/tikz.mjs";
import { setKatex, tikzLabel } from "./engine/render.mjs";

const { src, limits, label } = JSON.parse(readFileSync(0, "utf8"));
// (label: true, node text typeset by KaTeX, as the renderer does; {stub: html}, every line's HTML that string, its box
//  fixed, for a case that needs its bytes exactly; else a picture with node text is refused)
if (label === true) { const katex = (await import("katex")).default; setKatex(katex.renderToString, katex.__renderToHTMLTree); }
const labelFn = label === true ? (t, f) => tikzLabel(t, f) : label?.stub !== undefined ? () => ({ html: label.stub, w: 5, h: 5, d: 0 }) : null;
Object.assign(TIKZ_LIMITS, limits || {});
const t = performance.now();
let why = null;
const trace = { peak: 0, labelPeak: 0 };
try { renderTikz(src, { trace, ...(labelFn ? { label: labelFn } : {}) }, { colors: {}, idn: 0 }); } catch (e) { why = e instanceof TikzError ? e.why : "NOT NAMED: " + e?.message; }
process.stdout.write(JSON.stringify({ why, ms: Math.round(performance.now() - t), peak: trace.peak, labelPeak: trace.labelPeak }));
