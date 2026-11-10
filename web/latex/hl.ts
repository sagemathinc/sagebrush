// Code shown in the LaTeX preview (a sageblock's, a PythonTeX block's: <pre class="... sageblock">), coloured as the
// notebook colours Sage and Python. Its own chunk, /sagebrush-latex-hl.js, fetched only once a preview shows such a block
// (daybreak2's SIZE plan, astra's SEC terms, Nov 10):
//  - the text is only ever set as text: the highlighter's HTML (escaped text and <span class="hX"> only) is read back
//    into tokens, which must give back the block's text exactly, and drawn as text nodes and fixed-class spans; any
//    other shape, or a mismatch, leaves the block plain (the code page's reading, web/code/tokens.ts, copied here so this
//    chunk takes nothing else of that page's);
//  - a block over HL_MAX UTF-8 bytes stays plain, counted before anything is highlighted or allocated for it;
//  - the work is a queue, at most FRAME_MS a frame: many blocks never make one long task; a render's repeated calls
//    share one queue; a block replaced (not in the page any more) or a page closed (its signal) is dropped.
import { highlight } from "../notebook/highlight.js";

/** Over this many UTF-8 bytes, a block stays plain: the preview's own limit (the notebook's highlighter has none) */
export const HL_MAX = 64 * 1024;
const FRAME_MS = 8;
// (the code page's colours, web/code/page.ts)
const CSS = "pre.sageblock .hc{color:#6a737d;font-style:italic}pre.sageblock .hs{color:#22863a}pre.sageblock .hn{color:#005cc5}pre.sageblock .hk{color:#d73a49;font-weight:600}pre.sageblock .hb,pre.sageblock .hf{color:#6f42c1}pre.sageblock .hf{font-weight:600}pre.sageblock .hd{color:#e36209}";

type Tok = [cls: string, text: string];
// (the one shape of the notebook highlighter's HTML: & and < escaped, nothing else)
const SHAPE = /<span class="(h[a-z])">([^<]*)<\/span>|([^<]+)/y;
const unesc = (s: string) => s.replace(/&(lt|amp);/g, (_, e) => (e === "lt" ? "<" : "&"));
/** The tokens of the highlighter's HTML for `src`, or null if it isn't that shape or doesn't give back `src` exactly.
 * The highlighter ends with one "\n" of its own, dropped here (an empty `src` gives no tokens; a trailing "\n" of
 * `src`'s own stays). As web/code/tokens.ts's tokensFromHtml. */
export function tokensFromHtml(html: string, src: string): Tok[] | null {
  const out: Tok[] = [];
  for (let i = 0; i < html.length; ) {
    SHAPE.lastIndex = i;
    const m = SHAPE.exec(html);
    if (!m) return null;
    out.push(m[1] ? [m[1], unesc(m[2])] : ["", unesc(m[3])]);
    i = SHAPE.lastIndex;
  }
  const last = out.at(-1);
  if (last && last[1].endsWith("\n")) last[1] = last[1].slice(0, -1);
  if (last && last[1] === "") out.pop();
  return out.map((t) => t[1]).join("") === src ? out : null;
}

/** Whether `s` is at most `max` bytes as UTF-8, counted from its UTF-16 units without encoding it (a pair of
 * surrogates is 4 bytes; a lone one, as TextEncoder writes it, 3) */
export function fitsUtf8(s: string, max = HL_MAX): boolean {
  if (s.length > max) return false;
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c < 0xdc00 && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) { n += 4; i++; }
    else n += 3;
    if (n > max) return false;
  }
  return true;
}

/** Colours one block in place (marked done either way); false if it stays plain */
export function colourBlock(pre: HTMLElement): boolean {
  pre.dataset.hl = "1";
  const src = pre.textContent ?? "";
  if (!src || !fitsUtf8(src)) return false;
  const toks = tokensFromHtml(highlight(src, true), src);
  if (!toks) return false;
  const doc = pre.ownerDocument, frag = doc.createDocumentFragment();
  for (const [cls, text] of toks) {
    if (!cls) { frag.append(doc.createTextNode(text)); continue; }
    const s = doc.createElement("span");
    s.className = cls;
    s.textContent = text;
    frag.append(s);
  }
  pre.replaceChildren(frag);
  return true;
}

// (one queue per preview: a render's repeated calls while it is waiting add nothing)
const queued = new WeakSet<HTMLElement>();
/** Colours `root`'s blocks not yet done, FRAME_MS a frame, until there are none, `root` leaves the page, or `signal`
 * is aborted (the editor closed). */
export function colour(root: HTMLElement, signal: AbortSignal) {
  if (signal.aborted || queued.has(root)) return;
  const d = root.ownerDocument;
  if (!d.getElementById("sb-tex-hl")) { const st = d.createElement("style"); st.id = "sb-tex-hl"; st.textContent = CSS; d.head.append(st); }
  queued.add(root);
  const step = () => {
    if (signal.aborted || !root.isConnected) { queued.delete(root); return; }
    const t0 = performance.now();
    for (const pre of root.querySelectorAll<HTMLElement>("pre.sageblock:not([data-hl])")) {
      if (performance.now() - t0 > FRAME_MS) { requestAnimationFrame(step); return; }
      colourBlock(pre);
    }
    queued.delete(root);
  };
  requestAnimationFrame(step);
}
