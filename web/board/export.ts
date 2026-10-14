// A board as one HTML file (Download as HTML): the board page, its script,
// and the document, inline, so it opens anywhere, offline, from a file or an
// email attachment, and can be put on any web server as it is.  Its code
// items show their code but don't run: the file carries no interpreter, and
// says so (page.ts).  With math,
// KaTeX comes too (its module as text, imported from a Blob, and its
// stylesheet with the fonts as data: URLs), about 0.7 MB more.  It is the
// whole board: pages, the tour, printing, even editing (kept in that
// browser) and exporting again.
//
// The parts are fetched from the site (/board/index.html, board.js,
// ../sagebrush-math.js, ../katex/), or, in an exported file, taken from its
// own copies (#sb-template, #sb-board, #sb-math, #sb-katex).

import type { BoardDoc } from "./doc";
import type { CachedOutputs } from "./outcache";
import { OWN_ENGINE, checked, embeddedText, engineFiles, fetched, pack, type EngineRef } from "./engine";

/** Whether this page is an exported file (its document embedded). */
export const embedded = () => document.getElementById("sb-doc");

/** An exported file's engine: the site it came from, and the engine's id (engine.ts). */
export function engineRef(): EngineRef | null {
  try {
    const r = JSON.parse(document.getElementById("sb-engine-ref")?.textContent ?? "null");
    return r && typeof r.site === "string" && typeof r.id === "string" && /^https?:/.test(r.site) ? { site: r.site, id: r.id } : null;
  } catch {
    return null;
  }
}

/** The outputs an exported file carries (#sb-outputs), as they are: outcache.ts carriedOutputs() checks them. */
export function fileOutputs(): unknown {
  try {
    return JSON.parse(document.getElementById("sb-outputs")?.textContent ?? "null");
  } catch {
    return null;
  }
}

// text for a <script> or <style>: nothing that ends it early, and no "<!--"
// (after which the parser takes a "<script" as nested, and the script's own
// end as that one's: the page stops loading); undone by unescapeInline
const inline = (s: string) => s.replace(/<\/(script|style)/gi, "<\\/$1").replace(/<!--/g, "<\\!--");
// JavaScript for a <script>: the same, written \x3C, which is "<" in a string,
// a template and a regular expression alike (where "\!" may not be), and
// stays as it is when exported again
const inlineJs = (s: string) => s.replace(/<(\/script|!--)/gi, "\\x3C$1");

async function text(url: URL): Promise<string> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url.pathname}: ${r.status} ${r.statusText}`);
  return r.text();
}

function base64(bytes: ArrayBuffer): string {
  let s = "";
  const b = new Uint8Array(bytes);
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}

// KaTeX's stylesheet with its woff2 fonts inline (the woff and ttf
// alternatives dropped: every browser that runs the board reads woff2)
async function katexCss(base: URL): Promise<string> {
  const css = await text(new URL("katex/katex.min.css", base));
  const fonts = new Map<string, string>();
  for (const m of css.matchAll(/url\((fonts\/[^)]+\.woff2)\)/g)) {
    if (fonts.has(m[1])) continue;
    const r = await fetch(new URL("katex/" + m[1], base));
    if (!r.ok) throw new Error(`katex/${m[1]}: ${r.status}`);
    fonts.set(m[1], "data:font/woff2;base64," + base64(await r.arrayBuffer()));
  }
  return css.replace(/src:([^;}]*)/g, (_, list: string) => {
    const w = /url\((fonts\/[^)]+\.woff2)\)\s*format\("woff2"\)/.exec(list);
    return w ? `src:url(${fonts.get(w[1])}) format("woff2")` : "src:" + list;
  });
}

/** The board page as one HTML file holding `doc`; with `python`, the code's
 * engine too (engine.ts), compressed, so its code runs without the network. */
export async function exportHtml(doc: BoardDoc, o: { python?: boolean; outputs?: CachedOutputs[] } = {}): Promise<string> {
  const own = (id: string) => document.getElementById(id)?.textContent ?? null;
  const here = new URL(".", location.href); // (the board's directory: /board/)
  const site = new URL("..", here);
  const math = /\$|\\\(|\\\[/.test(JSON.stringify(doc));
  const ex = !!embedded();
  const template = ex ? unescapeInline(own("sb-template")!) : await text(new URL("index.html", here));
  const board = ex ? own("sb-board")! : await text(new URL("board.js", here));
  const mathJs = !math ? null : ex && own("sb-math") ? own("sb-math")! : await text(new URL("sagebrush-math.js", site));
  const mathCss = !math ? null : ex && own("sb-katex") ? own("sb-katex")! : await katexCss(site);
  // the engine: where it comes from (this site, or the file's), and with
  // python its parts, each checked (or carried as they are from a file that has them)
  const ref: EngineRef | null = ex ? engineRef() : OWN_ENGINE ? { site: site.href, id: OWN_ENGINE.id } : null;
  const engine: string[] = [];
  if (ref) engine.push(`<script type="application/json" id="sb-engine-ref">${JSON.stringify(ref).replace(/</g, "\\u003c")}</script>`);
  if (ref && o.python && OWN_ENGINE) {
    // (from the files beside this page, this build's, each checked against
    // its SHA-256; else, a page older than the site's files, from the engine's
    // own address: an engine not published there can still be carried)
    const local = checked(fetched(site.href), OWN_ENGINE.files), published = checked(fetched(new URL(`engine/${OWN_ENGINE.id}/`, ref.site).href), OWN_ENGINE.files);
    const have = embeddedText(), get = (name: string) => (ex ? published(name) : local(name).catch(() => published(name)));
    // (every part, the Sage library too: a file's board may change its language, William)
    for (const name of engineFiles(true)) engine.push(`<script type="application/octet-stream" data-sb-engine="${name}">${have.get(name) ?? (await pack(await get(name)))}</script>`);
  }
  // (the template rides along for exporting again, its scripts' ends escaped
  // as everything inline is, and unescaped when used)
  const json = JSON.stringify(doc).replace(/</g, "\\u003c");
  // (the slow items' outputs, keyed by what produced them: outcache.ts, carriedOutputs())
  const outputs = o.outputs?.length ? JSON.stringify(o.outputs.map(({ where: _w, ...e }) => e)).replace(/</g, "\\u003c") : null;
  const parts = [
    `<script type="application/json" id="sb-doc">${json}</script>`,
    outputs ? `<script type="application/json" id="sb-outputs">${outputs}</script>` : "",
    `<script type="text/plain" id="sb-template">${inline(template)}</script>`,
    mathJs ? `<script type="text/plain" id="sb-math">${inlineJs(mathJs)}</script>` : "",
    mathCss ? `<style id="sb-katex">${inline(mathCss)}</style>` : "",
    ...engine,
    `<script type="module" id="sb-board">${inlineJs(board)}</script>`,
  ].join("\n");
  const title = (doc.title ?? "Board").replace(/[<&]/g, (c) => (c === "<" ? "&lt;" : "&amp;"));
  return template
    .replace(/<title>[^<]*<\/title>/, () => `<title>${title}</title>`)
    .replace(/<link rel="canonical"[^>]*>\n?/, "")
    .replace(/<meta name="generator"[^>]*>\n?/, "")
    .replace(/<head>/, () => `<head>\n<meta name="generator" content="Sagebrush boards (sagebrush.space/board), exported ${new Date().toISOString().slice(0, 10)}">`)
    .replace(/<script type="module" src="[^"]*board\.js"><\/script>/, () => parts);
}

/** The text of an embedded part an exported page carries (#sb-template has its scripts' ends escaped). */
export function unescapeInline(s: string): string {
  return s.replace(/<\\\/(script|style)/gi, "</$1").replace(/<\\!--/g, "<!--");
}
