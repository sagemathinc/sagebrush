// The examples gallery's pages (plan-examples-gallery §3, U7 PR 3), built from the corpus in examples/ into the site:
//   /examples/                     every example, by kind
//   /examples/<kind>/              one kind's
//   /examples/tags/<tag>/          one tag's
//   /examples/<kind>/<slug>/       one example: what it is, its preview, its files
//   /examples/index.json           the catalog (the Examples… panel's, the loader's and the agents')
//   /examples/<kind>/<slug>/files.json and <slug>.zip
// Plain HTML, readable without JavaScript and indexable; returns the pages' URLs for the sitemap (build-sitemap.ts).
//
// Each example's page names the sha256 of the main file its preview was built from (A6), in a <meta>.
// The previews are static and inert (A4): no page has a script but its JSON-LD data block (checked here, for every
// page written), and no example's bytes reach a page unescaped.
//   - a notebook: its cells. Markdown through marked with KaTeX (trust: false) and the reviewed sanitizer for any HTML
//     in it (web/safe-html.ts); code as text; outputs as committed: text as text, an image (SVG or PNG) as an <img>
//     of a data: URL (an SVG there can't run script or fetch anything), text/latex by KaTeX, text/html by the
//     sanitizer. The interactive forms were never committed (r4.1).
//   - a board: each page as the board's own renderer draws it (web/board/svg.ts, as `sagebrush board render`), an
//     <img> of its SVG.
//   - a LaTeX document: its committed preview.html (`latex render`), with the corpus's one KaTeX stylesheet put back
//     where its marker is (after checking the marker names that stylesheet's sha256: r4.1), in an <iframe sandbox>
//     with nothing allowed.
import { Marked, type Tokens } from "marked";
import { deflateRawSync } from "node:zlib";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mathExtensions, tex } from "./markdown-math";
import { safeHtml, safeLink } from "./safe-html";
import { boardFromText } from "./board/mermaid";
import { boardSvg } from "./board/svg";
import { formatError, pageCount } from "./board/doc";
import { crc32Final, crc32Init, crc32Update } from "./workspace/export/crc32";
import { FONTS_MARK_RE, KINDS, SHARED_CSS, filesJson, listExamples, sha256 } from "../scripts/examples-lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const SITE = "https://sagebrush.space";
const REPO = "https://github.com/sagemathinc/sagebrush/tree/master";

export const esc = (s: string) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const text = (v: unknown) => (Array.isArray(v) ? v.join("") : String(v ?? ""));
export const tagSlug = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const KIND_TITLE: Record<string, string> = { notebook: "Notebooks", board: "Boards", latex: "LaTeX documents" };
const KIND_ONE: Record<string, string> = { notebook: "notebook", board: "board", latex: "LaTeX document" };
const MODE_TITLE: Record<string, string> = { python: "Python", sage: "Sage", magma: "Magma", matlab: "MATLAB" };

type Manifest = { title: string; summary: string; tags: string[]; level: string; main: string; files: string[]; author: string; license: string; mode?: string; modes?: string[]; features?: string[] };
type Example = { id: string; kind: string; slug: string; dir: string; manifest: Manifest };

// ---- Markdown (a notebook's cells): math by KaTeX; any HTML through the sanitizer; links checked; no remote images
const md = new Marked({ gfm: true });
md.use({
  extensions: mathExtensions,
  renderer: {
    html({ text: h }: Tokens.HTML | Tokens.Tag) {
      return safeHtml(h, { remote: false });
    },
    link({ href, title, tokens }: Tokens.Link) {
      const inner = this.parser.parseInline(tokens);
      const h = safeLink(href);
      return h === null ? inner : `<a href="${esc(h)}"${title ? ` title="${esc(title)}"` : ""} rel="nofollow noopener">${inner}</a>`;
    },
    // (a picture in a cell's Markdown is a fetch from wherever it names: its alt text instead)
    image({ text: alt }: Tokens.Image) {
      return esc(alt);
    },
  },
});

const B64 = /^[A-Za-z0-9+/]*={0,2}$/;
const img = (mime: string, base64: string, alt: string, cls = "out-img") =>
  `<img class="${cls}" src="data:${mime};base64,${base64}" alt="${esc(alt.slice(0, 300))}" loading="lazy" decoding="async">`;

/** One committed output as static HTML (A4). */
export function outputHtml(o: any): string {
  if (o.output_type === "stream") return `<pre class="out${o.name === "stderr" ? " err" : ""}">${esc(text(o.text))}</pre>`;
  if (o.output_type === "error") return `<pre class="out err">${esc(`${o.ename}: ${o.evalue}`)}</pre>`;
  const d = o.data ?? {};
  const alt = text(d["text/plain"]);
  if (d["image/svg+xml"] !== undefined) return img("image/svg+xml", Buffer.from(text(d["image/svg+xml"])).toString("base64"), alt);
  if (d["image/png"] !== undefined) {
    const b = text(d["image/png"]).replace(/\s+/g, "");
    return B64.test(b) ? img("image/png", b, alt) : `<pre class="out">${esc(alt)}</pre>`;
  }
  if (d["text/latex"] !== undefined) {
    const s = text(d["text/latex"]).trim();
    const m = /^\$\$([\s\S]*)\$\$$/.exec(s) ?? /^\$([\s\S]*)\$$/.exec(s);
    return `<div class="math-display out-math">${tex(m ? m[1] : s, true)}</div>`;
  }
  if (d["text/markdown"] !== undefined) return `<div class="out-md">${md.parse(text(d["text/markdown"])) as string}</div>`;
  if (d["text/html"] !== undefined) return `<div class="out-html">${safeHtml(text(d["text/html"]), { remote: false })}</div>`;
  if (d["text/plain"] !== undefined) return `<pre class="out">${esc(alt)}</pre>`;
  return "";
}

/** A notebook's preview: its cells, with their committed outputs. */
export function notebookHtml(nb: any): string {
  const parts: string[] = [];
  for (const c of nb.cells ?? []) {
    if (c.cell_type === "markdown") parts.push(`<div class="cell md">${md.parse(text(c.source)) as string}</div>`);
    else if (c.cell_type === "code") {
      const outs = (c.outputs ?? []).map(outputHtml).join("");
      parts.push(`<div class="cell code"><pre class="src"><code>${esc(text(c.source))}</code></pre>${outs ? `<div class="outs">${outs}</div>` : ""}</div>`);
    }
  }
  return `<div class="nb">${parts.join("\n")}</div>`;
}

/** A board's preview: each page's SVG, as the board draws it (web/board/svg.ts, as `sagebrush board render`). */
export async function boardHtml(file: string, name: string): Promise<{ html: string; pages: number }> {
  const t = readFileSync(file, "utf8");
  const doc = boardFromText(t, name);
  const bad = formatError(doc);
  if (bad) throw new Error(`build-examples: ${file}: ${bad}`);
  const n = pageCount(doc);
  const math = JSON.stringify(doc).includes("$") ? (await import("../src/board-math")).texSvg : undefined;
  const pages: string[] = [];
  for (let p = 0; p < n; p++) {
    const { svg } = boardSvg(doc, { page: p, math });
    pages.push(`<figure class="board-page">${img("image/svg+xml", Buffer.from(svg).toString("base64"), `page ${p + 1} of ${n}`, "board-img")}${n > 1 ? `<figcaption>Page ${p + 1} of ${n}</figcaption>` : ""}</figure>`);
  }
  return { html: pages.join("\n"), pages: n };
}

/**
 * A LaTeX preview as served: the committed preview.html with the corpus's one KaTeX stylesheet back where its
 * marker is. The marker must be the only one and name that stylesheet's sha256 (r4.1; astra: the renderer's own
 * resource, never CSS from an example); the preview may hold no script.
 */
export function latexPreview(committed: string, css: string): string {
  const want = sha256(css);
  const marks = [...committed.matchAll(FONTS_MARK_RE)];
  if (marks.length !== 1) throw new Error(`build-examples: a LaTeX preview has ${marks.length} stylesheet markers, not 1`);
  if (marks[0][1] !== want) throw new Error(`build-examples: a LaTeX preview's marker names ${marks[0][1].slice(0, 12)}, not examples/${SHARED_CSS} (${want.slice(0, 12)})`);
  if (/<script/i.test(committed)) throw new Error("build-examples: a LaTeX preview holds a script");
  return committed.replace(marks[0][0], () => `<style>${css}</style>`);
}

// ---- a ZIP of an example's files: deflated, in the manifest's order, with a fixed time (the same bytes every build)
export function zip(files: { name: string; bytes: Uint8Array }[]): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, "utf8");
    const data = deflateRawSync(f.bytes, { level: 9 });
    const crc = crc32Final(crc32Update(crc32Init(), f.bytes));
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0);
    h.writeUInt16LE(20, 4);
    h.writeUInt16LE(0x0800, 6); // UTF-8 names
    h.writeUInt16LE(8, 8); // deflate
    h.writeUInt16LE(0, 10); // 00:00
    h.writeUInt16LE(0x21, 12); // 1980-01-01
    h.writeUInt32LE(crc, 14);
    h.writeUInt32LE(data.length, 18);
    h.writeUInt32LE(f.bytes.length, 22);
    h.writeUInt16LE(name.length, 26);
    h.writeUInt16LE(0, 28);
    local.push(h, name, data);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(0x031e, 4); // made by: unix, 3.0
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x0800, 8);
    c.writeUInt16LE(8, 10);
    c.writeUInt16LE(0, 12);
    c.writeUInt16LE(0x21, 14);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(data.length, 20);
    c.writeUInt32LE(f.bytes.length, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE((0o100644 << 16) >>> 0, 38); // a regular file, rw-r--r--
    c.writeUInt32LE(offset, 42);
    central.push(c, name);
    offset += h.length + name.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, cd, end]);
}

// ---- the pages
const CSS = `
:root { color-scheme: light dark; --fg: #1d1d1f; --bg: #fff; --muted: #666; --rule: #ddd; --link: #2a6f2f; --code: #f4f4f2; --card: #fafaf8; }
@media (prefers-color-scheme: dark) { :root { --fg: #e8e8e6; --bg: #161616; --muted: #9a9a9a; --rule: #333; --link: #8fd18f; --code: #222; --card: #1d1d1d; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 17px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; }
header.site, footer.site { max-width: 60rem; margin: 0 auto; padding: 1rem 1.25rem; color: var(--muted); font-size: 0.95rem; }
header.site a, footer.site a { color: var(--muted); }
header.site b a { color: var(--fg); text-decoration: none; }
main { max-width: 60rem; margin: 0 auto; padding: 0 1.25rem 2rem; }
h1 { font-size: 2rem; line-height: 1.2; margin: 1.5rem 0 0.6rem; }
h2 { font-size: 1.35rem; margin: 2rem 0 0.8rem; padding-top: 0.6rem; border-top: 1px solid var(--rule); }
a { color: var(--link); }
p.lead { font-size: 1.1rem; margin: 0 0 1rem; }
p.meta { color: var(--muted); font-size: 0.92rem; }
.chips a, .chip { display: inline-block; font-size: 0.8rem; padding: 0.05rem 0.5rem; margin: 0 0.25rem 0.25rem 0; border: 1px solid var(--rule); border-radius: 999px; color: var(--muted); text-decoration: none; }
ul.cards { list-style: none; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(16rem, 1fr)); gap: 0.8rem; }
ul.cards li { background: var(--card); border: 1px solid var(--rule); border-radius: 8px; padding: 0.8rem 1rem; }
ul.cards li a.t { font-weight: 600; text-decoration: none; }
ul.cards li p { margin: 0.3rem 0; font-size: 0.92rem; }
.actions a { margin-right: 1rem; }
pre { background: var(--code); padding: 0.6rem 0.9rem; overflow-x: auto; border-radius: 6px; font-size: 0.85rem; line-height: 1.45; margin: 0.4rem 0; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.nb .cell { margin: 0.9rem 0; }
.nb h1 { font-size: 1.5rem; margin: 1rem 0 0.5rem; } .nb h2 { font-size: 1.25rem; border-top: 0; margin: 1.2rem 0 0.5rem; } .nb h3 { font-size: 1.1rem; }
.nb .cell.code pre.src { border-left: 3px solid var(--link); }
.nb .outs { margin-left: 0.9rem; }
.nb pre.out { background: none; padding: 0.2rem 0.9rem; }
.nb pre.out.err { color: #b91c1c; }
img.out-img, img.board-img { max-width: 100%; height: auto; background: #fff; border-radius: 4px; }
.math-display { overflow-x: auto; margin: 0.6rem 0; }
.out-html table { border-collapse: collapse; } .out-html td, .out-html th { border: 1px solid var(--rule); padding: 0.2rem 0.5rem; }
figure.board-page { margin: 1rem 0; } figure.board-page figcaption { color: var(--muted); font-size: 0.85rem; }
iframe.latex { width: 100%; height: 80vh; border: 1px solid var(--rule); border-radius: 6px; background: #eef0f2; }
details summary { cursor: pointer; color: var(--muted); }
p.ai { color: var(--muted); font-size: 0.88rem; border-left: 3px solid var(--rule); padding: 0.2rem 0 0.2rem 0.8rem; }
`;

function page(o: { url: string; title: string; description: string; crumbs: [string, string][]; body: string; type: string; main?: { path: string; sha256: string } }): string {
  const canonical = SITE + o.url;
  const ld = { "@context": "https://schema.org", "@type": o.type, name: o.title, description: o.description, url: canonical, license: "https://opensource.org/licenses/MIT", publisher: { "@type": "Organization", name: "SageMath, Inc.", url: "https://sagemath.com" } };
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(o.title)} | Sagebrush examples</title>
<meta name="description" content="${esc(o.description)}">
<link rel="canonical" href="${canonical}">${o.main ? `\n<meta name="sagebrush-example-main" content="${esc(o.main.path)} sha256:${o.main.sha256}">` : ""}
<meta property="og:type" content="website">
<meta property="og:title" content="${esc(o.title)}">
<meta property="og:description" content="${esc(o.description)}">
<meta property="og:url" content="${canonical}">
<meta property="og:site_name" content="Sagebrush">
<meta property="og:image" content="${SITE}/icons/icon-512.png">
<link rel="icon" href="/icons/icon-192.png">
<link rel="stylesheet" href="/katex/katex.min.css">
<link rel="preload" href="/katex/fonts/KaTeX_Main-Regular.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/katex/fonts/KaTeX_Math-Italic.woff2" as="font" type="font/woff2" crossorigin>
<style>${CSS}</style>
<script type="application/ld+json">${JSON.stringify(ld).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026")}</script>
${ALPHA_BANNER}
</head>
<body>
<header class="site"><b><a href="/">Sagebrush</a></b>${o.crumbs.map(([h, t]) => ` · <a href="${esc(h)}">${esc(t)}</a>`).join("")}</header>
<main>
${o.body}
</main>
<footer class="site">The examples are MIT licensed: copy them, change them, use them anywhere · <a href="https://github.com/sagemathinc/sagebrush/tree/master/examples">their sources on GitHub</a> · a project of <a href="https://sagemath.com">SageMath, Inc.</a></footer>
</body>
</html>
`;
}

// (the site's early-alpha notice, on every page of the site's own: web/test-alpha-banner.mjs)
const ALPHA_BANNER = '<script src="/alpha-banner.js" defer></script>';
/** Whether a tag in the page has an on* attribute: its attributes' names, not their values (an example's text reaches
 * a page escaped, so its "<" is never a tag and its quotes never end a value). */
export function handlerIn(html: string): boolean {
  for (const m of html.matchAll(/<[a-z][^>]*>/gi)) if (/\son[a-z]+\s*=/i.test(m[0].replace(/"[^"]*"|'[^']*'/g, '""'))) return true;
  return false;
}
// (no page has a script but its JSON-LD data block and the site's notice: the gallery's pages are inert, A4)
function inert(file: string, html: string): string {
  for (const m of html.matchAll(/<script\b[^>]*>/gi))
    if (!/^<script type="application\/ld\+json">$/.test(m[0]) && !(m[0] + "</script>" === ALPHA_BANNER)) throw new Error(`build-examples: ${file} has a script`);
  if (handlerIn(html)) throw new Error(`build-examples: ${file} has an event handler attribute`);
  return html;
}

function gitDate(rel: string): string {
  try {
    return execFileSync("git", ["log", "-1", "--format=%cs", "--", rel], { cwd: root }).toString().trim() || new Date().toISOString().slice(0, 10);
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

function facts(e: Example): string[] {
  const m = e.manifest;
  const f = [KIND_ONE[e.kind]];
  if (m.mode) f.push(MODE_TITLE[m.mode] ?? m.mode);
  for (const x of m.modes ?? []) f.push(MODE_TITLE[x] ?? x);
  for (const x of m.features ?? []) f.push(x);
  f.push(m.level);
  return f;
}
const tagChips = (tags: string[]) => `<span class="chips">${tags.map((t) => `<a href="/examples/tags/${tagSlug(t)}/">${esc(t)}</a>`).join("")}</span>`;
const card = (e: Example) =>
  `<li><a class="t" href="/examples/${e.id}/">${esc(e.manifest.title)}</a><p>${esc(e.manifest.summary)}</p><p class="meta">${facts(e).map(esc).join(" · ")}</p>${tagChips(e.manifest.tags)}</li>`;
const cards = (list: Example[]) => `<ul class="cards">\n${list.map(card).join("\n")}\n</ul>`;

/** The catalog: one entry per example, the fields a list or a search needs, and its files.json's hash. */
export type CatalogEntry = { id: string; kind: string; title: string; summary: string; tags: string[]; level: string; mode?: string; modes?: string[]; features?: string[]; main: string; files: number; bytes: number; files_sha256: string; url: string };

/**
 * The site's examples within plan section 5's caps (daybreak2's ruling: budgets.json's site/examples row binds only
 * the total, 180 MiB; these parts are bound here): each example's generated preview (its page, and a LaTeX
 * document's preview.html) at most 1 MiB, all of them at most 120 MiB, the ZIPs at most 60 MiB, the catalog at most
 * 200 KiB (also its own row). Exported for the tests, which pass smaller caps.
 */
export const SITE_CAPS = { preview: 1024 * 1024, previews: 120 * 1024 * 1024, zips: 60 * 1024 * 1024, catalog: 200 * 1024 };

export async function buildExamplesInto(out: string, corpus = join(root, "examples"), caps = SITE_CAPS): Promise<{ url: string; date: string }[]> {
  const dest = join(out, "examples");
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  const examples = (listExamples(corpus) as any[]).filter((e) => !e.error) as Example[];
  if (!examples.length) return [];
  const sharedFile = join(corpus, SHARED_CSS);
  const css = existsSync(sharedFile) ? readFileSync(sharedFile, "utf8") : null;
  const urls: { url: string; date: string }[] = [];
  const today = new Date().toISOString().slice(0, 10);
  const catalog: CatalogEntry[] = [];
  const sizes = new Map<string, number>();
  const write = (rel: string, data: string | Uint8Array) => {
    const f = join(dest, rel);
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, typeof data === "string" && rel.endsWith(".html") ? inert(rel, data) : data);
    sizes.set(rel, typeof data === "string" ? Buffer.byteLength(data) : data.length);
  };
  const over: string[] = [];

  for (const e of examples) {
    const m = e.manifest;
    const date = gitDate(`examples/${e.id}`);
    // its files: files.json (A6: the bytes, sizes and hashes), a ZIP of them
    const fj = { ...filesJson(e.dir, m), id: e.id };
    const fjText = JSON.stringify(fj, null, 1) + "\n";
    write(`${e.id}/files.json`, fjText);
    const bytes = m.files.map((f) => ({ name: f, bytes: readFileSync(join(e.dir, f)) }));
    write(`${e.id}/${e.slug}.zip`, zip(bytes));
    const total = bytes.reduce((n, b) => n + b.bytes.length, 0);
    catalog.push({
      id: e.id, kind: e.kind, title: m.title, summary: m.summary, tags: m.tags, level: m.level,
      ...(m.mode ? { mode: m.mode } : {}), ...(m.modes ? { modes: m.modes } : {}), ...(m.features ? { features: m.features } : {}),
      main: m.main, files: m.files.length, bytes: total, files_sha256: sha256(fjText), url: `/examples/${e.id}/`,
    });
    // its preview
    let preview: string;
    if (e.kind === "notebook") preview = notebookHtml(JSON.parse(readFileSync(join(e.dir, m.main), "utf8")));
    else if (e.kind === "board") preview = (await boardHtml(join(e.dir, m.main), m.main)).html;
    else {
      if (css === null) throw new Error(`build-examples: examples/${SHARED_CSS} is missing`);
      const committed = join(e.dir, "preview.html");
      if (!existsSync(committed)) throw new Error(`build-examples: ${e.id} has no preview.html`);
      write(`${e.id}/preview.html`, latexPreview(readFileSync(committed, "utf8"), css));
      const src = readFileSync(join(e.dir, m.main), "utf8");
      preview = `<iframe class="latex" src="preview.html" sandbox="" referrerpolicy="no-referrer" loading="lazy" title="${esc(m.title)}: the preview"></iframe>
<details><summary>${esc(m.main)}</summary><pre><code>${esc(src)}</code></pre></details>`;
    }
    const fileList = m.files.map((f) => `<li><code>${esc(f)}</code> (${fj.files.find((x: any) => x.path === f)!.bytes} bytes)</li>`).join("");
    const body = `<h1>${esc(m.title)}</h1>
<p class="lead">${esc(m.summary)}</p>
<p class="meta">${facts(e).map(esc).join(" · ")} · by ${esc(m.author)} · ${esc(m.license)} license</p>
${tagChips(m.tags)}
<p class="actions"><a href="${esc(e.slug)}.zip" download>Download (ZIP)</a><a href="${REPO}/examples/${e.id}">Source on GitHub</a></p>
<h2>Preview</h2>
${preview}
<h2>Files</h2>
<ul>${fileList}</ul>
<p class="meta">Open the ZIP's ${esc(KIND_ONE[e.kind])} in Sagebrush (File, Open) to run and change it.</p>`;
    write(`${e.id}/index.html`, page({ url: `/examples/${e.id}/`, title: m.title, description: m.summary, crumbs: [["/examples/", "Examples"], [`/examples/${e.kind}/`, KIND_TITLE[e.kind]]], body, type: "CreativeWork", main: { path: m.main, sha256: fj.files.find((x: any) => x.path === m.main)!.sha256 } }));
    urls.push({ url: `/examples/${e.id}/`, date });
    const shown = (sizes.get(`${e.id}/index.html`) ?? 0) + (sizes.get(`${e.id}/preview.html`) ?? 0);
    if (shown > caps.preview) over.push(`${e.id}: its preview is ${shown} bytes, more than ${caps.preview}`);
  }

  // the kinds, the tags, the index
  for (const kind of KINDS) {
    const list = examples.filter((e) => e.kind === kind);
    if (!list.length) continue;
    write(`${kind}/index.html`, page({ url: `/examples/${kind}/`, title: KIND_TITLE[kind], description: `Sagebrush's example ${KIND_TITLE[kind].toLowerCase()}, each with its preview.`, crumbs: [["/examples/", "Examples"]], body: `<h1>${esc(KIND_TITLE[kind])}</h1>\n${cards(list)}`, type: "CollectionPage" }));
    urls.push({ url: `/examples/${kind}/`, date: today });
  }
  const tags = [...new Set(examples.flatMap((e) => e.manifest.tags))].sort();
  for (const t of tags) {
    const list = examples.filter((e) => e.manifest.tags.includes(t));
    write(`tags/${tagSlug(t)}/index.html`, page({ url: `/examples/tags/${tagSlug(t)}/`, title: `Examples: ${t}`, description: `Sagebrush examples about ${t}.`, crumbs: [["/examples/", "Examples"]], body: `<h1>Examples: ${esc(t)}</h1>\n${cards(list)}`, type: "CollectionPage" }));
    urls.push({ url: `/examples/tags/${tagSlug(t)}/`, date: today });
  }
  const sections = KINDS.filter((k) => examples.some((e) => e.kind === k))
    .map((k) => `<h2 id="${k}"><a href="/examples/${k}/">${esc(KIND_TITLE[k])}</a></h2>\n${cards(examples.filter((e) => e.kind === k))}`)
    .join("\n");
  write("index.html", page({
    url: "/examples/", title: "Examples", description: "Notebooks, boards and LaTeX documents to read, copy and change: each with its preview, MIT licensed.",
    crumbs: [],
    body: `<h1>Examples</h1>\n<p class="lead">Notebooks, boards and LaTeX documents, each shown as it renders: read them here, then download one and open it in Sagebrush to run and change it. All are MIT licensed.</p>\n<p class="meta">By tag: ${tagChips(tags)}</p>\n${sections}`,
    type: "CollectionPage",
  }));
  urls.unshift({ url: "/examples/", date: today });
  write("index.json", JSON.stringify({ format: "sagebrush-examples", v: 1, examples: catalog }, null, 1) + "\n");
  const sum = (test: (rel: string) => boolean) => [...sizes].filter(([rel]) => test(rel)).reduce((n, [, b]) => n + b, 0);
  const previews = sum((rel) => rel.endsWith(".html")), zips = sum((rel) => rel.endsWith(".zip")), cat = sizes.get("index.json") ?? 0;
  if (previews > caps.previews) over.push(`the previews (every page) are ${previews} bytes, more than ${caps.previews}`);
  if (zips > caps.zips) over.push(`the ZIPs are ${zips} bytes, more than ${caps.zips}`);
  if (cat > caps.catalog) over.push(`index.json is ${cat} bytes, more than ${caps.catalog}`);
  if (over.length) throw new Error(`build-examples: over plan section 5's caps:\n  ${over.join("\n  ")}`);
  console.log(`examples: ${examples.length} examples, ${urls.length} pages`);
  return urls;
}

/** For build-sitemap.ts. */
export const buildExamples = (out: string) => buildExamplesInto(out);

if (import.meta.main) {
  const { siteDir } = await import("./site-dir.mts");
  await buildExamplesInto(join(siteDir, "public"));
}
