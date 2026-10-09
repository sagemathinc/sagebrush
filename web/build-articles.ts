// The articles (articles/<series>/*.md in the repository) as static pages of
// sagebrush.space: /articles/ lists the series, /articles/<series>/ is a
// series' README, /articles/<series>/<name> each article.  Rendered here
// (marked, with the math typeset by KaTeX at build time), so a page is
// plain HTML: readable without JavaScript and indexable.  Also writes
// sitemap.xml and robots.txt.  Run by web/build.ts (or `bun
// web/build-articles.ts`); writes into web/site/public.
import { Marked, type Tokens } from "marked";
import katex from "katex";
import { mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";

const here = dirname(new URL(import.meta.url).pathname);
const root = join(here, "..");
const SITE = "https://sagebrush.space";
const REPO = "https://github.com/sagemathinc/sagebrush/blob/main";
const out = join(here, "site", "public");

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const tex = (s: string, displayMode: boolean) => katex.renderToString(s, { displayMode, throwOnError: false, output: "html" });

function renderer(): Marked {
  const m = new Marked({ gfm: true });
  m.use({
    extensions: [
      {
        name: "mathBlock",
        level: "block",
        start: (src: string) => src.match(/^\$\$/m)?.index,
        tokenizer(src: string) {
          const r = /^\$\$([\s\S]+?)\$\$[ \t]*(?:\n|$)/.exec(src);
          if (r) return { type: "mathBlock", raw: r[0], text: r[1] };
        },
        renderer: (t: any) => `<div class="math-display">${tex(t.text.trim(), true)}</div>\n`,
      },
      {
        name: "mathInline",
        level: "inline",
        start: (src: string) => src.indexOf("$") < 0 ? undefined : src.indexOf("$"),
        tokenizer(src: string) {
          const d = /^\$\$([\s\S]+?)\$\$/.exec(src);
          if (d) return { type: "mathInline", raw: d[0], text: d[1], display: true };
          const r = /^\$((?:\\.|[^\\$\n])+?)\$/.exec(src);
          if (r) return { type: "mathInline", raw: r[0], text: r[1], display: false };
        },
        renderer: (t: any) => tex(t.text.trim(), t.display),
      },
    ],
    renderer: {
      // links between articles: name.md -> name, README.md -> the series
      link({ href, title, tokens }: Tokens.Link) {
        let h = href;
        if (/^[\w.-]+\.md(#.*)?$/.test(h)) h = h.replace(/^README\.md/, "./").replace(/\.md(?=#|$)/, "");
        const text = this.parser.parseInline(tokens);
        return `<a href="${esc(h)}"${title ? ` title="${esc(title)}"` : ""}>${text}</a>`;
      },
    },
  });
  return m;
}

// the description: an HTML comment "<!-- description: ... -->" first in the
// file, else the plain text of the first paragraph after the title
function describe(md: string): string {
  const c = md.match(/^<!--\s*description:\s*([\s\S]*?)-->/);
  if (c) return c[1].replace(/\s+/g, " ").trim();
  const body = md.split("\n").slice(1).join("\n").trim();
  const para = body.split(/\n\s*\n/).find((p) => p.trim() && !/^\s*(\*Code:|\||```|#|<!--)/.test(p)) ?? "";
  const plain = para
    .replace(/\$\$?([^$]+)\$\$?/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[`*_]/g, "")
    .replace(/\\mathbb\{(\w)\}/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  return plain.length > 200 ? plain.slice(0, 197).replace(/\s+\S*$/, "") + "…" : plain;
}

function gitDate(file: string): string {
  try {
    return execFileSync("git", ["log", "-1", "--format=%cs", "--", file], { cwd: root }).toString().trim() || new Date().toISOString().slice(0, 10);
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

// Honest disclosure on every page; a file may replace it with a comment
// "<!-- disclosure: ... -->" among its first lines (e.g. an article written
// from code that this model did not write)
const DISCLOSURE = "Written by Claude Opus 5.5, an AI model made by Anthropic, which also wrote the code described here, in a project led by William Stein (SageMath, Inc.). Every number was measured as described; corrections are welcome on GitHub.";

const CSS = `
:root { color-scheme: light dark; --fg: #1d1d1f; --bg: #fff; --muted: #666; --rule: #ddd; --link: #2a6f2f; --code: #f4f4f2; }
@media (prefers-color-scheme: dark) { :root { --fg: #e8e8e6; --bg: #161616; --muted: #9a9a9a; --rule: #333; --link: #8fd18f; --code: #222; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 17px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; }
header.site, footer.site { max-width: 46rem; margin: 0 auto; padding: 1rem 1.25rem; color: var(--muted); font-size: 0.95rem; }
header.site a, footer.site a { color: var(--muted); }
header.site b a { color: var(--fg); text-decoration: none; }
main { max-width: 46rem; margin: 0 auto; padding: 0 1.25rem 2rem; }
h1 { font-size: 2rem; line-height: 1.2; margin: 1.5rem 0 1rem; }
h2 { font-size: 1.4rem; margin: 2.2rem 0 0.8rem; padding-top: 0.6rem; border-top: 1px solid var(--rule); }
h3 { font-size: 1.15rem; margin: 1.6rem 0 0.6rem; }
a { color: var(--link); }
code { background: var(--code); padding: 0.1em 0.3em; border-radius: 3px; font-size: 0.88em; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
pre { background: var(--code); padding: 0.8rem 1rem; overflow-x: auto; border-radius: 6px; font-size: 0.85rem; line-height: 1.45; }
pre code { background: none; padding: 0; }
table { border-collapse: collapse; margin: 1rem 0; font-size: 0.92rem; display: block; overflow-x: auto; }
th, td { border: 1px solid var(--rule); padding: 0.35rem 0.6rem; text-align: left; vertical-align: top; }
th { background: var(--code); }
.math-display { overflow-x: auto; margin: 1rem 0; }
blockquote { margin: 1rem 0; padding-left: 1rem; border-left: 3px solid var(--rule); color: var(--muted); }
nav.series { display: flex; justify-content: space-between; gap: 1rem; margin-top: 3rem; padding-top: 1rem; border-top: 1px solid var(--rule); font-size: 0.95rem; }
nav.series a { text-decoration: none; }
p.meta { color: var(--muted); font-size: 0.9rem; margin-top: -0.5rem; }
p.ai { color: var(--muted); font-size: 0.88rem; border-left: 3px solid var(--rule); padding: 0.2rem 0 0.2rem 0.8rem; margin: 0 0 1.5rem; }
`;

interface Page { url: string; title: string; description: string; date: string; html: string; source: string; prev?: Page; next?: Page; series: string; seriesTitle: string; index: boolean; disclosure?: string }

function page(p: Page): string {
  const canonical = SITE + p.url;
  const ld = {
    "@context": "https://schema.org",
    "@type": p.index ? "CollectionPage" : "TechArticle",
    headline: p.title,
    description: p.description,
    dateModified: p.date,
    url: canonical,
    author: { "@type": "Organization", name: "Sagebrush (SageMath, Inc.)", url: SITE },
    contributor: { "@type": "SoftwareApplication", name: "Claude Opus 5.5", applicationCategory: "AI model", creator: { "@type": "Organization", name: "Anthropic" } },
    publisher: { "@type": "Organization", name: "SageMath, Inc.", url: "https://sagemath.com" },
    isPartOf: p.index ? undefined : { "@type": "CreativeWorkSeries", name: p.seriesTitle, url: `${SITE}/articles/${p.series}/` },
  };
  const nav = p.index ? "" : `<nav class="series"><span>${p.prev ? `← <a href="${p.prev.url}">${esc(p.prev.title)}</a>` : `<a href="/articles/${p.series}/">${esc(p.seriesTitle)}</a>`}</span><span>${p.next ? `<a href="${p.next.url}">${esc(p.next.title)}</a> →` : ""}</span></nav>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(p.title)}${p.index ? "" : " — " + esc(p.seriesTitle)} | Sagebrush</title>
<meta name="description" content="${esc(p.description)}">
<link rel="canonical" href="${canonical}">
<meta property="og:type" content="article">
<meta property="og:title" content="${esc(p.title)}">
<meta property="og:description" content="${esc(p.description)}">
<meta property="og:url" content="${canonical}">
<meta property="og:site_name" content="Sagebrush">
<meta property="og:image" content="${SITE}/icons/icon-512.png">
<meta name="twitter:card" content="summary">
<link rel="icon" href="/icons/icon-192.png">
<link rel="stylesheet" href="/katex/katex.min.css">
<style>${CSS}</style>
<script type="application/ld+json">${JSON.stringify(ld).replace(/</g, "\\u003c")}</script>
</head>
<body>
<header class="site"><b><a href="/">Sagebrush</a></b> · <a href="/articles/">Articles</a>${p.index ? "" : ` · <a href="/articles/${p.series}/">${esc(p.seriesTitle)}</a>`}</header>
<main>
${p.html.replace("</h1>", `</h1>\n<p class="ai">${esc(p.disclosure ?? DISCLOSURE)}</p>`)}
${p.index ? "" : `<p class="meta">Updated ${p.date} · <a href="${REPO}/${p.source}">source on GitHub</a></p>`}
${nav}
</main>
<footer class="site">Sagebrush: open-source computational mathematics under the permissive MIT and Apache-2.0 licenses, in the browser and natively · <a href="https://github.com/sagemathinc/sagebrush">github.com/sagemathinc/sagebrush</a> · a project of <a href="https://sagemath.com">SageMath, Inc.</a></footer>
</body>
</html>
`;
}

const md = renderer();
const urls: { url: string; date: string }[] = [{ url: "/", date: new Date().toISOString().slice(0, 10) }, { url: "/atlas/", date: new Date().toISOString().slice(0, 10) }, { url: "/demo/jfm/", date: new Date().toISOString().slice(0, 10) }];
const seriesList: { slug: string; title: string; description: string; count: number }[] = [];
rmSync(join(out, "articles"), { recursive: true, force: true });
const adir = join(root, "articles");
// the series in this order, then any others alphabetically
const ORDER = ["groebner", "number-theory", "foundations"];
const rank = (s: string) => (ORDER.indexOf(s) < 0 ? ORDER.length : ORDER.indexOf(s));
for (const series of existsSync(adir) ? readdirSync(adir).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b)) : []) {
  const sdir = join(adir, series);
  const files = readdirSync(sdir).filter((f) => f.endsWith(".md")).sort();
  if (!files.includes("README.md")) continue;
  const readme = readFileSync(join(sdir, "README.md"), "utf8");
  const seriesTitle = (readme.match(/^# (.+)$/m)?.[1] ?? series).trim();
  const pages: Page[] = files.map((f) => {
    const full = readFileSync(join(sdir, f), "utf8");
    const src = full.replace(/^(?:<!--[\s\S]*?-->\n?)+/, "");
    const extra = full.match(/<!--\s*disclosure:\s*([\s\S]*?)-->/)?.[1].replace(/\s+/g, " ").trim();
    const index = f === "README.md";
    const name = f.replace(/\.md$/, "");
    return {
      url: index ? `/articles/${series}/` : `/articles/${series}/${name}`,
      title: (src.match(/^# (.+)$/m)?.[1] ?? name).replace(/\$/g, "").trim(),
      description: describe(full),
      date: gitDate(`articles/${series}/${f}`),
      html: md.parse(src) as string,
      source: `articles/${series}/${f}`,
      series,
      seriesTitle,
      index,
      disclosure: extra,
    };
  });
  const arts = pages.filter((p) => !p.index);
  arts.forEach((p, i) => {
    p.prev = arts[i - 1];
    p.next = arts[i + 1];
  });
  mkdirSync(join(out, "articles", series), { recursive: true });
  for (const p of pages) {
    const file = p.index ? join(out, "articles", series, "index.html") : join(out, "articles", series, p.url.split("/").pop() + ".html");
    writeFileSync(file, page(p));
    urls.push({ url: p.url, date: p.date });
  }
  const r = pages.find((p) => p.index)!;
  seriesList.push({ slug: series, title: seriesTitle, description: r.description, count: arts.length });
}
// /articles/: the series
const list = seriesList.map((s) => `<h2><a href="/articles/${s.slug}/">${esc(s.title)}</a></h2>\n<p>${esc(s.description)} (${s.count} articles)</p>`).join("\n");
writeFileSync(join(out, "articles", "index.html"), page({
  url: "/articles/", title: "Articles", description: "How Sagebrush's mathematics engines are implemented, algorithm by algorithm: what worked, what did not, and why.",
  date: new Date().toISOString().slice(0, 10), source: "articles", series: "", seriesTitle: "Articles", index: true,
  html: `<h1>Articles</h1>\n<p>How Sagebrush's mathematics engines are implemented, algorithm by algorithm, top to bottom: what worked, what did not and why, and what would have saved time. The engines are written from the literature and are open source under the permissive MIT and Apache-2.0 licenses, unlike the GPL or closed systems they are measured against.</p>\n${list}`,
}));
urls.push({ url: "/articles/", date: new Date().toISOString().slice(0, 10) });
writeFileSync(join(out, "sitemap.xml"), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `  <url><loc>${SITE}${u.url}</loc><lastmod>${u.date}</lastmod></url>`).join("\n")}\n</urlset>\n`);
writeFileSync(join(out, "robots.txt"), `User-agent: *\nAllow: /\n\nSitemap: ${SITE}/sitemap.xml\n`);
console.log(`articles: ${urls.length - 4} pages in ${seriesList.length} series, sitemap.xml`);
