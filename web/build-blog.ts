// The blog (blog/*.md in the repository) as static pages of sagebrush.space: /blog/ lists the posts, newest first,
// /blog/<slug> is a post, and /blog/feed.xml is their Atom feed.  A post is markdown with a short front matter
// (title, date, author, author_url, description, and optionally image: one file name beside it, its link preview's
// card); its first line after the front matter is its title as a heading.  Rendered with the articles' renderer and
// style (web/build-articles.ts), so a page is plain HTML: readable without JavaScript, with its math typeset at build
// time.  A post is its author's own: a byline, no AI disclosure.  The front matter's checks and the pages' text are
// web/blog.ts's; this reads the posts and writes the pages.  Returns its URLs for sitemap.xml (web/build-sitemap.ts).
import { mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync, existsSync, copyFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { renderer, CSS } from "./build-articles";
import { parsePost, imagePaths, postPage, indexPage, feed, type Post } from "./blog";

const here = dirname(new URL(import.meta.url).pathname);
const root = join(here, "..");
const { siteDir, hasSite } = await import("./site-dir.mts");
if (!hasSite) throw new Error("build-blog: web/site is absent; build.ts imports this only when it is present");
const out = join(siteDir, "public");

/** The blog's pages and feed, written into the site; their URLs (for the sitemap). */
export function buildBlog(): { url: string; date: string }[] {
  const md = renderer();
  const dir = join(root, "blog");
  const outDir = join(out, "blog");
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const posts: Post[] = (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".md")) : []).map((f) => {
    const slug = f.replace(/\.md$/, "");
    const { fields, body } = parsePost(slug, readFileSync(join(dir, f), "utf8"));
    if (fields.image && !existsSync(imagePaths(dir, outDir, fields.image).from)) throw new Error(`blog/${f}: its image ${fields.image} isn't beside it`);
    return { slug, title: fields.title, date: fields.date, author: fields.author, authorUrl: fields.author_url || undefined, description: fields.description, image: fields.image || undefined, html: md.parse(body) as string, source: `blog/${f}` };
  });
  posts.sort((a, b) => b.date.localeCompare(a.date) || a.slug.localeCompare(b.slug));
  for (const p of posts) {
    writeFileSync(join(outDir, `${p.slug}.html`), postPage(p, CSS));
    if (p.image) {
      const { from, to } = imagePaths(dir, outDir, p.image);
      copyFileSync(from, to);
    }
  }
  writeFileSync(join(outDir, "index.html"), indexPage(posts, CSS));
  writeFileSync(join(outDir, "feed.xml"), feed(posts));
  console.log(`blog: ${posts.length} post${posts.length === 1 ? "" : "s"}`);
  return [{ url: "/blog/", date: posts[0]?.date ?? "2026-11-16" }, ...posts.map((p) => ({ url: `/blog/${p.slug}`, date: p.date }))];
}

if (import.meta.main) buildBlog();
