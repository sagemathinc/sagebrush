import katex from "katex";
import { setKatex, tikzLabel } from "./engine/render.mjs";
import { renderTikz } from "./engine/tikz.mjs";
setKatex(katex.renderToString, katex.__renderToHTMLTree);
const label = (t, f) => tikzLabel(t, f);
for (const src of process.argv.slice(2)) { try { const h = renderTikz(src, { label }, { colors: {}, idn: 0 }); console.log(/data-box="([^"]+)"/.exec(h)[1], (h.match(/class="tikz-n"[^>]*/g) || []).map((x) => x.slice(15, 140))); } catch (e) { console.log("ERR", e.why || e.stack); } }
