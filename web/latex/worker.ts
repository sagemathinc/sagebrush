// The LaTeX editor's engine (a module Worker, dist/sagebrush-latex-worker.js; plan sbspace r5 §4): the source text
// expanded and rendered off the page's thread, its chunks split into pieces (split.ts), bounded.
// In:  {doc, rev, text, images, cold?, reset?}   (doc and rev: the page's request token, echoed back)
// Out: {doc, rev, ok, items: [{g, h}], groups, pos, imageRefs, stats} or {doc, rev, ok: false, error}
//   items: every piece in order; g: the index of the chunk it came from (a group is replaced as one unit).
//   pos: per group, the source offset where it begins (-1: none known), for keeping source and preview in sync.
// KaTeX's renderToString comes from the site's shared sagebrush-math.js, imported once (no copy of KaTeX here).
import "./engine/shim.mjs";
import { Engine } from "./engine/pipeline.mjs";
import { setKatex } from "./engine/render.mjs";
import { splitChunk, bytes } from "./split";

export const RENDER_BOUNDS = { chunks: 20000, html: 16 * 2 ** 20 };
const TOO_LARGE = '<div class="bounderr">This document is too large for the prototype\'s preview.</div>';

let eng: any = null;
const ready = import(/* @vite-ignore */ new URL("sagebrush-math.js", self.location.href).href).then((m: any) => setKatex(m.renderToString));

self.onmessage = async (e: MessageEvent) => {
  const m = e.data || {};
  const echo = { doc: m.doc, rev: m.rev };
  try {
    await ready;
    if (!eng || m.reset) eng = new Engine({ images: m.images || {} });
    else eng.opts = Object.assign({}, eng.opts, { images: m.images || {} });
    const r = eng.update(String(m.text ?? ""), { cold: !!m.cold });
    // (each piece with its UTF-8 size, b: the page's patch budget charges the same measure as split.ts)
    const items: { g: number; h: string; b: number }[] = [];
    let total = 0, stopped = false;
    if (r.chunks.length > RENDER_BOUNDS.chunks) stopped = true;
    for (let g = 0; g < r.chunks.length && !stopped; g++) {
      for (const h of splitChunk(r.chunks[g])) {
        const b = bytes(h);
        total += b;
        if (total > RENDER_BOUNDS.html) { stopped = true; break; }
        items.push({ g, h, b });
      }
    }
    if (stopped) { items.length = 0; items.push({ g: 0, h: TOO_LARGE, b: bytes(TOO_LARGE) }); }
    (self as any).postMessage(Object.assign(echo, { ok: true, items, groups: stopped ? 1 : r.chunks.length, pos: stopped ? [-1] : r.chunkPos, imageRefs: r.imageRefs || [], stats: r.stats, tooLarge: stopped }));
  } catch (err: any) {
    eng = null;
    (self as any).postMessage(Object.assign(echo, { ok: false, error: String((err && err.message) || err).slice(0, 300) }));
  }
};
