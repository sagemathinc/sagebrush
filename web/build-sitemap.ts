// The site's sitemap.xml and robots.txt: the one owner of both (plan-examples-gallery §3). It builds the pages that
// have URLs, web/build-articles.ts, web/build-examples.ts and web/build-docs.ts, from the lists of URLs they return, so no page is in the
// site without being in the sitemap. Run by web/build.ts when web/site/ is here (or `bun web/build-sitemap.ts`).
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildArticles } from "./build-articles";
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
export async function buildSitemap(o: { out?: string; articles?: () => Url[]; examples?: (out: string) => Promise<Url[]>; docs?: (out: string) => Url[] } = {}): Promise<Url[]> {
  if (o.out === undefined && !hasSite) throw new Error("build-sitemap: web/site is absent; build.ts imports this only when it is present");
  const out = o.out ?? join(siteDir, "public");
  const urls = [...(o.articles ?? buildArticles)(), ...(await (o.examples ?? buildExamples)(out)), ...(o.docs ?? buildDocs)(out)];
  writeFileSync(join(out, "sitemap.xml"), sitemapXml(urls));
  writeFileSync(join(out, "robots.txt"), ROBOTS);
  console.log(`sitemap.xml: ${urls.length} URLs`);
  return urls;
}

if (import.meta.main) await buildSitemap();
