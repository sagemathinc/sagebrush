// The LaTeX editor's engine (a module Worker, dist/sagebrush-latex-worker.js; plan sbspace r5 §4): the source text
// expanded and rendered off the page's thread, its chunks split into pieces (split.ts), bounded.
// In:  {doc, rev, text, images, inputs?, cold?, reset?}   (doc and rev: the page's request token, echoed back;
//      inputs: {docPath, known, version}, the files \input reads, inputs.ts: kept until the next)
// Out: {doc, rev, ok, items: [{g, h}], groups, pos, imageRefs, inputRefs, stats, check} or {doc, rev, ok: false, error}
//   items: every piece in order; g: the index of the chunk it came from (a group is replaced as one unit).
//   pos: per group, the source offset where it begins (-1: none known), for keeping source and preview in sync.
// KaTeX's renderToString comes from the site's shared sagebrush-math.js, imported once (no copy of KaTeX here).
import "./engine/shim.mjs";
import { Engine, withBeamer, withPythontex, installPythontex, once, declaresBeamer } from "./engine/pipeline.mjs";
import { setKatex, installBeamer } from "./engine/render.mjs";
import { splitChunk, bytes, tooLargeProblem } from "./split";
import { WRAPPER_VERSION, itemKey } from "./engine/sagetex.mjs";
import { engineInputs, type Known } from "./inputs";

export const RENDER_BOUNDS = { chunks: 20000, html: 16 * 2 ** 20 };
const TOO_LARGE = '<div class="bounderr">This document is too large for the prototype\'s preview.</div>';

let eng: any = null;
// (the page's included files, kept from the last message that had them: inputs.ts)
let inputs: { docPath: string; known: Map<string, Known>; version: number } | null = null;
const ready = import(/* @vite-ignore */ new URL("sagebrush-math.js", self.location.href).href).then((m: any) => setKatex(m.renderToString));
// (beamer's code, engine/beamer.mjs: a chunk of its own beside this worker (same origin, the same dist/ as the worker
//  itself), fetched once, when a render first says it needs it; a failed fetch stays failed until a reload)
const loadBeamer = once(() => import(/* @vite-ignore */ new URL("sagebrush-latex-beamer.js", self.location.href).href).then(installBeamer));
// (PythonTeX's results pass, engine/pythontex.mjs: a chunk of its own too, fetched only when a document has a PythonTeX
//  result to read back (the update's needPy); then the same text rendered again, not expanded again)
const loadPythontex = once(() => import(/* @vite-ignore */ new URL("sagebrush-latex-pythontex.js", self.location.href).href).then(installPythontex));

self.onmessage = async (e: MessageEvent) => {
  const m = e.data || {};
  const echo = { doc: m.doc, rev: m.rev };
  try {
    // (a document that declares beamer: its chunk fetched with KaTeX's, before the first render, so that render is the
    //  only one; a failed fetch is withBeamer's below, the notice)
    await Promise.all([ready, declaresBeamer(String(m.text ?? "")) && loadBeamer().catch(() => {})]);
    // (saved results only of this wrapper: sagetex.mjs's WRAPPER_VERSION is part of every item's key too)
    const sage = m.sage && m.sage.wrapper === WRAPPER_VERSION && Array.isArray(m.sage.saved) ? { saved: m.sage.saved.slice(0, 1000) } : undefined;
    if (!eng || m.reset) eng = new Engine({ images: m.images || {}, sage });
    else eng.opts = Object.assign({}, eng.opts, { images: m.images || {}, sage });
    if (m.inputs && typeof m.inputs.docPath === "string" && Array.isArray(m.inputs.known)) inputs = { docPath: m.inputs.docPath, known: new Map(m.inputs.known.slice(0, 1024)), version: Number(m.inputs.version) || 0 };
    const ei = inputs ? engineInputs(inputs.docPath, inputs.known) : null;
    const text = String(m.text ?? ""), opts = ei ? { inputs: { files: ei.files, resolve: ei.resolve, version: inputs!.version } } : {};
    // (rendered again with beamer's code: the same text, so not expanded again)
    let r = await withBeamer(eng.update(text, { cold: !!m.cold, ...opts }), loadBeamer, () => eng.update(text, opts));
    if (r.needPy) r = await withPythontex(r, loadPythontex, () => eng.update(text, opts));
    // (each piece with its UTF-8 size, b: the page's patch budget charges the same measure as split.ts)
    const items: { g: number; h: string; b: number }[] = [];
    let total = 0, stopped = false;
    // (a chunk shown as a placeholder: latex_check's warning at its place, check.ts)
    const tooLarge: { kind: string; name: string; at: number }[] = [];
    if (r.chunks.length > RENDER_BOUNDS.chunks) stopped = true;
    for (let g = 0; g < r.chunks.length && !stopped; g++) {
      for (const h of splitChunk(r.chunks[g], (why, size) => tooLarge.push(tooLargeProblem(why, size, r.chunkPos?.[g])))) {
        const b = bytes(h);
        total += b;
        if (total > RENDER_BOUNDS.html) { stopped = true; break; }
        items.push({ g, h, b });
      }
    }
    if (stopped) { items.length = 0; items.push({ g: 0, h: TOO_LARGE, b: bytes(TOO_LARGE) }); }
    (self as any).postMessage(Object.assign(echo, { ok: true, items, groups: stopped ? 1 : r.chunks.length, pos: stopped ? [-1] : r.chunkPos, imageRefs: r.imageRefs || [], inputRefs: r.inputRefs || [], stats: r.stats, tooLarge: stopped,
      // (what latex_check reports, check.ts: small, the problems bounded by the renderer)
      check: { outcome: String(r.stats.outcome), beamer: !!r.beamer, problems: (r.problems || []).concat(tooLarge), frames: r.frames || [], sage: (r.sageItems || []).map((it: any, k: number) => ({ mode: String(it.mode), err: it.err ?? null, at: typeof it.at === "number" ? it.at : -1, ...(r.sageStates?.[k] ? { s: r.sageStates[k].s, msg: r.sageStates[k].msg } : {}),
        // (and what the editor's Run needs, run-core.mjs: the item's key, its code, a refused one's name; the code
        //  is the document's own, so all of it is at most the text sent)
        key: itemKey(it), ...(typeof it.code === "string" && !it.err ? { code: it.code } : {}), ...(it.name ? { name: String(it.name) } : {}) })) } }));
  } catch (err: any) {
    eng = null;
    (self as any).postMessage(Object.assign(echo, { ok: false, error: String((err && err.message) || err).slice(0, 300) }));
  }
};
