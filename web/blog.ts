// The blog's posts (blog/*.md): a post's front matter, checked, and its pages and feed as text.  No file is read or
// written here, and nothing is imported that needs the site (web/build-blog.ts does both), so web/test-blog.mjs
// checks it in any checkout.
import { relative, resolve, isAbsolute } from "node:path";

export const SITE = "https://sagebrush.space";
const REPO = "https://github.com/sagemathinc/sagebrush/blob/master";

// (as web/build-articles.ts's: an attribute's or a text's value)
export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
// (2026-11-16 -> November 16, 2026)
export const longDate = (d: string) => `${MONTHS[Number(d.slice(5, 7)) - 1]} ${Number(d.slice(8, 10))}, ${d.slice(0, 4)}`;

// (a post's card: one file name beside the post, an image's; never a path)
const IMAGE = /^[A-Za-z0-9._-]+\.(png|jpe?g|webp)$/;

export interface Post { slug: string; title: string; date: string; author: string; authorUrl?: string; description: string; image?: string; html: string; source: string }

/** A post's file: its front matter's fields, checked, and its markdown.  Throws, naming the file, on anything else. */
export function parsePost(slug: string, text: string): { fields: Record<string, string>; body: string } {
  const where = `blog/${slug}.md`;
  if (!/^[a-z0-9-]+$/.test(slug)) throw new Error(`${where}: a post's name is lowercase letters, digits and dashes`);
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!m) throw new Error(`${where}: no front matter`);
  const fields: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const f = /^([a-z_]+):\s*(.*)$/.exec(line);
    if (!f) throw new Error(`${where}: a front matter line isn't "name: value": ${line}`);
    fields[f[1]] = f[2].trim();
  }
  for (const k of ["title", "date", "author", "description"]) if (!fields[k]) throw new Error(`${where}: front matter has no ${k}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fields.date)) throw new Error(`${where}: date ${fields.date} isn't YYYY-MM-DD`);
  if (fields.image !== undefined && (!IMAGE.test(fields.image) || fields.image.includes(".."))) throw new Error(`${where}: image ${JSON.stringify(fields.image)} isn't one file name beside the post (letters, digits, . _ -; .png, .jpg, .jpeg or .webp)`);
  if (fields.author_url !== undefined && !/^https?:\/\/[^\s"<>]+$/.test(fields.author_url)) throw new Error(`${where}: author_url isn't an http(s) URL`);
  const body = text.slice(m[0].length);
  if (body.match(/^# (.+)$/m)?.[1].trim() !== fields.title) throw new Error(`${where}: its heading isn't its front matter's title`);
  return { fields, body };
}

/** Where a post's card is copied from and to: both inside their folders, or it throws. */
export function imagePaths(srcDir: string, outDir: string, image: string): { from: string; to: string } {
  const from = resolve(srcDir, image);
  const to = resolve(outDir, image);
  for (const [base, p] of [[srcDir, from], [outDir, to]] as const) {
    const r = relative(resolve(base), p);
    if (!r || r.startsWith("..") || isAbsolute(r)) throw new Error(`blog: image ${JSON.stringify(image)} isn't inside ${base}`);
  }
  return { from, to };
}

// (a post's card, or the site's icon when it has none)
export const imageOf = (p: Post) => (p.image ? `${SITE}/blog/${p.image}` : `${SITE}/icons/icon-512.png`);

const head = (css: string, o: { title: string; description: string; url: string; image: string; type: string; ld: object }) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(o.title)} | Sagebrush</title>
<meta name="description" content="${esc(o.description)}">
<link rel="canonical" href="${esc(SITE + o.url)}">
<link rel="alternate" type="application/atom+xml" title="Sagebrush blog" href="${SITE}/blog/feed.xml">
<meta property="og:type" content="${o.type}">
<meta property="og:title" content="${esc(o.title)}">
<meta property="og:description" content="${esc(o.description)}">
<meta property="og:url" content="${esc(SITE + o.url)}">
<meta property="og:site_name" content="Sagebrush">
<meta property="og:image" content="${esc(o.image)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(o.title)}">
<meta name="twitter:description" content="${esc(o.description)}">
<meta name="twitter:image" content="${esc(o.image)}">
<link rel="icon" href="/icons/icon-192.png">
<link rel="stylesheet" href="/katex/katex.min.css">
<style>${css}
p.byline { color: var(--muted); font-size: 0.95rem; margin: -0.4rem 0 1.5rem; }
ul.posts { list-style: none; padding: 0; }
ul.posts li { margin: 0 0 1.4rem; }
ul.posts .date { color: var(--muted); font-size: 0.9rem; }
</style>
<script type="application/ld+json">${JSON.stringify(o.ld).replace(/</g, "\\u003c")}</script>
<script src="/alpha-banner.js" defer></script>
</head>
<body>
<header class="site"><b><a href="/">Sagebrush</a></b> · <a href="/blog/">Blog</a> · <a href="/articles/">Articles</a></header>
<main>
`;
const FOOT = `</main>
<footer class="site">Sagebrush: open-source computational mathematics under the permissive MIT and Apache-2.0 licenses, in the browser and natively · <a href="/blog/feed.xml">Atom feed</a> · <a href="https://github.com/sagemathinc/sagebrush">github.com/sagemathinc/sagebrush</a> · a project of <a href="https://sagemath.com">SageMath, Inc.</a></footer>
</body>
</html>
`;

/** A post's page, in the articles' style (css). */
export function postPage(p: Post, css: string): string {
  const url = `/blog/${p.slug}`;
  const ld = {
    "@context": "https://schema.org",
    "@type": "BlogPosting",
    headline: p.title,
    description: p.description,
    datePublished: p.date,
    url: SITE + url,
    image: imageOf(p),
    author: { "@type": "Person", name: p.author, ...(p.authorUrl ? { url: p.authorUrl } : {}) },
    publisher: { "@type": "Organization", name: "SageMath, Inc.", url: "https://sagemath.com" },
  };
  const by = p.authorUrl ? `<a href="${esc(p.authorUrl)}">${esc(p.author)}</a>` : esc(p.author);
  const html = p.html.replace(/<\/h1>\n?/, `</h1>\n<p class="byline">${by}, <time datetime="${esc(p.date)}">${longDate(p.date)}</time></p>\n`);
  return head(css, { title: p.title, description: p.description, url, image: imageOf(p), type: "article", ld }) + html + `<p class="meta"><a href="${esc(`${REPO}/${p.source}`)}">source on GitHub</a></p>\n` + FOOT;
}

/** /blog/: the posts, newest first. */
export function indexPage(posts: Post[], css: string): string {
  const description = "Posts about Sagebrush: what it is, why it is built the way it is, and what is new.";
  const ld = { "@context": "https://schema.org", "@type": "Blog", name: "Sagebrush blog", description, url: `${SITE}/blog/` };
  const list = posts.map((p) => `<li><a href="/blog/${p.slug}"><b>${esc(p.title)}</b></a><br><span class="date">${longDate(p.date)} · ${esc(p.author)}</span><br>${esc(p.description)}</li>`).join("\n");
  return head(css, { title: "Blog", description, url: "/blog/", image: posts[0] ? imageOf(posts[0]) : `${SITE}/icons/icon-512.png`, type: "website", ld }) + `<h1>Blog</h1>\n<p>${esc(description)} <a href="/blog/feed.xml">Atom feed</a>.</p>\n<ul class="posts">\n${list}\n</ul>\n` + FOOT;
}

/** /blog/feed.xml: the posts as an Atom feed. */
export function feed(posts: Post[]): string {
  const updated = posts.length ? `${posts[0].date}T00:00:00Z` : "2026-11-16T00:00:00Z";
  const entries = posts
    .map((p) => `  <entry>
    <title>${esc(p.title)}</title>
    <link href="${SITE}/blog/${p.slug}"/>
    <id>${SITE}/blog/${p.slug}</id>
    <published>${p.date}T00:00:00Z</published>
    <updated>${p.date}T00:00:00Z</updated>
    <author><name>${esc(p.author)}</name>${p.authorUrl ? `<uri>${esc(p.authorUrl)}</uri>` : ""}</author>
    <summary>${esc(p.description)}</summary>
    <content type="html">${esc(p.html)}</content>
  </entry>`)
    .join("\n");
  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Sagebrush blog</title>
  <link href="${SITE}/blog/"/>
  <link rel="self" href="${SITE}/blog/feed.xml"/>
  <id>${SITE}/blog/</id>
  <updated>${updated}</updated>
${entries}
</feed>
`;
}
