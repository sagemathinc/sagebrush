// The blog (blog/*.md in the repository) as static pages of sagebrush.space: /blog/ lists the posts, newest first,
// /blog/<slug> is a post, and /blog/feed.xml is their Atom feed.  A post is markdown with a short front matter
// (title, date, author, author_url, description, and optionally image: a file beside it, its link preview's card);
// its first line after the front matter is its title as a heading.  Rendered with the articles' renderer and style
// (web/build-articles.ts), so a page is plain HTML: readable without JavaScript, with its math typeset at build time.
// A post is its author's own: a byline, no AI disclosure.  Returns its URLs for sitemap.xml (web/build-sitemap.ts).
import { mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync, existsSync, copyFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { renderer, esc, CSS } from "./build-articles";

const here = dirname(new URL(import.meta.url).pathname);
const root = join(here, "..");
const SITE = "https://sagebrush.space";
const REPO = "https://github.com/sagemathinc/sagebrush/blob/master";
const { siteDir, hasSite } = await import("./site-dir.mts");
if (!hasSite) throw new Error("build-blog: web/site is absent; build.ts imports this only when it is present");
const out = join(siteDir, "public");

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
// (2026-11-16 -> November 16, 2026)
const longDate = (d: string) => `${MONTHS[Number(d.slice(5, 7)) - 1]} ${Number(d.slice(8, 10))}, ${d.slice(0, 4)}`;

export interface Post { slug: string; title: string; date: string; author: string; authorUrl?: string; description: string; image?: string; html: string; source: string }

/** A post's file: its front matter's fields and its markdown. */
export function parsePost(slug: string, text: string): { fields: Record<string, string>; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!m) throw new Error(`blog/${slug}.md: no front matter`);
  const fields: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const f = /^([a-z_]+):\s*(.*)$/.exec(line);
    if (!f) throw new Error(`blog/${slug}.md: a front matter line isn't "name: value": ${line}`);
    fields[f[1]] = f[2].trim();
  }
  for (const k of ["title", "date", "author", "description"]) if (!fields[k]) throw new Error(`blog/${slug}.md: front matter has no ${k}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fields.date)) throw new Error(`blog/${slug}.md: date ${fields.date} isn't YYYY-MM-DD`);
  return { fields, body: text.slice(m[0].length) };
}

const HEAD = (o: { title: string; description: string; url: string; image: string; type: string; ld: object }) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(o.title)} | Sagebrush</title>
<meta name="description" content="${esc(o.description)}">
<link rel="canonical" href="${SITE}${o.url}">
<link rel="alternate" type="application/atom+xml" title="Sagebrush blog" href="${SITE}/blog/feed.xml">
<meta property="og:type" content="${o.type}">
<meta property="og:title" content="${esc(o.title)}">
<meta property="og:description" content="${esc(o.description)}">
<meta property="og:url" content="${SITE}${o.url}">
<meta property="og:site_name" content="Sagebrush">
<meta property="og:image" content="${o.image}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(o.title)}">
<meta name="twitter:description" content="${esc(o.description)}">
<meta name="twitter:image" content="${o.image}">
<link rel="icon" href="/icons/icon-192.png">
<link rel="stylesheet" href="/katex/katex.min.css">
<style>${CSS}
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

// (a post's card, or the site's icon when it has none)
const imageOf = (p: Post) => (p.image ? `${SITE}/blog/${p.image}` : `${SITE}/icons/icon-512.png`);

function postPage(p: Post): string {
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
  const html = p.html.replace(/<\/h1>\n?/, `</h1>\n<p class="byline">${by}, <time datetime="${p.date}">${longDate(p.date)}</time></p>\n`);
  return HEAD({ title: p.title, description: p.description, url, image: imageOf(p), type: "article", ld }) + html + `<p class="meta"><a href="${REPO}/${p.source}">source on GitHub</a></p>\n` + FOOT;
}

function indexPage(posts: Post[]): string {
  const description = "Posts about Sagebrush: what it is, why it is built the way it is, and what is new.";
  const ld = { "@context": "https://schema.org", "@type": "Blog", name: "Sagebrush blog", description, url: `${SITE}/blog/` };
  const list = posts.map((p) => `<li><a href="/blog/${p.slug}"><b>${esc(p.title)}</b></a><br><span class="date">${longDate(p.date)} · ${esc(p.author)}</span><br>${esc(p.description)}</li>`).join("\n");
  return HEAD({ title: "Blog", description, url: "/blog/", image: posts[0] ? imageOf(posts[0]) : `${SITE}/icons/icon-512.png`, type: "website", ld }) + `<h1>Blog</h1>\n<p>${esc(description)} <a href="/blog/feed.xml">Atom feed</a>.</p>\n<ul class="posts">\n${list}\n</ul>\n` + FOOT;
}

function feed(posts: Post[]): string {
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

/** The blog's pages and feed, written into the site; their URLs (for the sitemap). */
export function buildBlog(): { url: string; date: string }[] {
  const md = renderer();
  const dir = join(root, "blog");
  rmSync(join(out, "blog"), { recursive: true, force: true });
  mkdirSync(join(out, "blog"), { recursive: true });
  const posts: Post[] = (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".md")) : []).map((f) => {
    const slug = f.replace(/\.md$/, "");
    if (!/^[a-z0-9-]+$/.test(slug)) throw new Error(`blog/${f}: a post's name is lowercase letters, digits and dashes`);
    const { fields, body } = parsePost(slug, readFileSync(join(dir, f), "utf8"));
    const heading = body.match(/^# (.+)$/m)?.[1].trim();
    if (heading !== fields.title) throw new Error(`blog/${f}: its heading isn't its front matter's title`);
    if (fields.image && !existsSync(join(dir, fields.image))) throw new Error(`blog/${f}: its image ${fields.image} isn't beside it`);
    return { slug, title: fields.title, date: fields.date, author: fields.author, authorUrl: fields.author_url || undefined, description: fields.description, image: fields.image || undefined, html: md.parse(body) as string, source: `blog/${f}` };
  });
  posts.sort((a, b) => b.date.localeCompare(a.date) || a.slug.localeCompare(b.slug));
  for (const p of posts) {
    writeFileSync(join(out, "blog", `${p.slug}.html`), postPage(p));
    if (p.image) copyFileSync(join(dir, p.image), join(out, "blog", p.image));
  }
  writeFileSync(join(out, "blog", "index.html"), indexPage(posts));
  writeFileSync(join(out, "blog", "feed.xml"), feed(posts));
  console.log(`blog: ${posts.length} post${posts.length === 1 ? "" : "s"}`);
  return [{ url: "/blog/", date: posts[0]?.date ?? "2026-11-16" }, ...posts.map((p) => ({ url: `/blog/${p.slug}`, date: p.date }))];
}

if (import.meta.main) buildBlog();
