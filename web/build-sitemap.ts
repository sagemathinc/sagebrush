// The site's sitemap.xml, robots.txt and docs-pages.json: the one owner of them (plan-examples-gallery §3). It builds the pages that
// have URLs, web/build-articles.ts, web/build-blog.ts, web/build-examples.ts and web/build-docs.ts, from the lists of URLs they return, so no page is in the
// site without being in the sitemap. Run by web/build.ts when web/site/ is here (or `bun web/build-sitemap.ts`).
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildArticles } from "./build-articles";
import { buildBlog } from "./build-blog";
import { buildExamples } from "./build-examples";
import { buildDocs } from "./build-docs";
import { hasSite, siteDir } from "./site-dir.mts";

export const SITE = "https://sagebrush.space";

// (a share, its API and its files are reached by their links only, never through a search engine: none is ever in the
// sitemap, and every answer of theirs says noindex (web/share/server.ts NOINDEX))
export const NOT_LISTED = /^\/(s|api|auth|c)(\/|@|$)/;
// (robots.txt blocks nothing: a fetcher it blocks never sees a share's noindex, and a share's link preview needs its page
// fetched; a blocked URL can still be indexed from its links alone)
export const ROBOTS = `User-agent: *\nAllow: /\n\nSitemap: ${SITE}/sitemap.xml\n`;

// The agent's index of the site's doc pages, /docs-pages.json: the docs, the articles and the blog, exactly the pages
// the sitemap lists there. (Not /docs-index.json: that address is the Sage function index the page's search loads,
// copied from web/dist by web/build.ts, and writing the page list there replaced it.) sagebrush-agent's sagebrush_docs
// reads a page only if it is a member, so what a turn can put in a docs URL is a choice among these and nothing else
// (#1552; the egress rule S5-S7: no card for a fixed host and a fixed set). Every member is a lowercase slug path; a page whose URL isn't one fails the build here rather than
// being left out, so the index and the sitemap can't drift apart.
export const DOCS_PAGES_FILE = "docs-pages.json";
export const DOCS_INDEX_PREFIX = /^\/(docs|articles|blog)\//;
export const DOCS_INDEX_PATH = /^\/(docs|articles|blog)\/(?:[a-z0-9][a-z0-9-]{0,79}(?:\/[a-z0-9][a-z0-9-]{0,79}){0,3}\/?)?$/;
export const DOCS_INDEX_MAX = 1000;
export const DOCS_INDEX_BYTES = 64 * 1024;

export function docsIndexJson(urls: { url: string }[]): string {
  const paths = [...new Set(urls.map((u) => u.url).filter((u) => DOCS_INDEX_PREFIX.test(u)))].sort();
  for (const p of paths) if (!DOCS_INDEX_PATH.test(p) || p.length > 200) throw new Error(`build-sitemap: ${p} can't be in the docs index (lowercase letters, digits and hyphens only, at most 4 parts)`);
  if (paths.length > DOCS_INDEX_MAX) throw new Error(`build-sitemap: ${paths.length} pages in the docs index, over ${DOCS_INDEX_MAX}`);
  const json = JSON.stringify({ v: 1, paths }) + "\n";
  if (Buffer.byteLength(json) > DOCS_INDEX_BYTES) throw new Error(`build-sitemap: the docs index is over ${DOCS_INDEX_BYTES} bytes`);
  return json;
}

export function sitemapXml(urls: { url: string; date: string }[]): string {
  const seen = new Set<string>();
  for (const u of urls) {
    if (NOT_LISTED.test(u.url)) throw new Error(`build-sitemap: ${u.url} is a share's or its API's, never listed`);
    if (seen.has(u.url)) throw new Error(`build-sitemap: ${u.url} twice`);
    seen.add(u.url);
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `  <url><loc>${SITE}${u.url}</loc><lastmod>${u.date}</lastmod></url>`).join("\n")}\n</urlset>\n`;
}

type Url = { url: string; date: string };

// (the test passes its own folder and builders: web/site/ is the cloud repo's, so a core checkout may not have it)
export async function buildSitemap(o: { out?: string; articles?: () => Url[]; blog?: () => Url[]; examples?: (out: string) => Promise<Url[]>; docs?: (out: string) => Url[] } = {}): Promise<Url[]> {
  if (o.out === undefined && !hasSite) throw new Error("build-sitemap: web/site is absent; build.ts imports this only when it is present");
  const out = o.out ?? join(siteDir, "public");
  const urls = [...(o.articles ?? buildArticles)(), ...(o.blog ?? buildBlog)(), ...(await (o.examples ?? buildExamples)(out)), ...(o.docs ?? buildDocs)(out)];
  writeFileSync(join(out, "sitemap.xml"), sitemapXml(urls));
  writeFileSync(join(out, "robots.txt"), ROBOTS);
  writeFileSync(join(out, DOCS_PAGES_FILE), docsIndexJson(urls));
  console.log(`sitemap.xml: ${urls.length} URLs`);
  return urls;
}

if (import.meta.main) await buildSitemap();
