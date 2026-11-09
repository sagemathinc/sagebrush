// The docs (web/docs/<topic>.md) as static pages of sagebrush.space: /docs/ lists every topic's sections, with a
// search over them, and /docs/<topic> is a topic, each section's heading an anchor (`## Title {#id}`) that the app's
// "Learn more" links name (web/docs-link.ts). The app's panels say one short line and link here: William, Nov 8: "have
// a rule for NO complicated 'wall of text' UI at all anywhere in the app ... put ALL walls of text there."
// Plain HTML, readable without JavaScript: the search is one inline script over an index written into the page.
// Run by web/build-sitemap.ts, which lists the URLs this returns.
import { Marked, type Tokens } from "marked";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const here = dirname(new URL(import.meta.url).pathname);
const SITE = "https://sagebrush.space";
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
// (an HTML fragment's text: tags dropped, marked's entities decoded, &amp; last)
const plain = (html: string) => html.replace(/<[^>]+>/g, "").replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(Number(n))).replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

const CSS = `
:root { color-scheme: light dark; --fg: #1d1d1f; --bg: #fff; --muted: #666; --rule: #ddd; --link: #2a6f2f; --hit: #fff3b0; }
@media (prefers-color-scheme: dark) { :root { --fg: #e8e8e6; --bg: #161616; --muted: #9a9a9a; --rule: #333; --link: #8fd18f; --hit: #4a4210; } }
body { margin: 0; background: var(--bg); color: var(--fg); font: 17px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; }
header.site { max-width: 46rem; margin: 0 auto; padding: 1rem 1.25rem; color: var(--muted); font-size: 0.95rem; }
header.site a { color: var(--muted); } header.site b a { color: var(--fg); text-decoration: none; }
main { max-width: 46rem; margin: 0 auto; padding: 0 1.25rem 3rem; }
h1 { font-size: 2rem; line-height: 1.2; margin: 1.5rem 0 1rem; }
h2 { font-size: 1.35rem; margin: 2rem 0 0.6rem; padding-top: 0.6rem; border-top: 1px solid var(--rule); }
h2 a.self { color: var(--muted); text-decoration: none; margin-left: 0.4rem; font-weight: normal; visibility: hidden; }
h2:hover a.self, h2:target a.self { visibility: visible; }
:target { scroll-margin-top: 1rem; } h2:target { background: var(--hit); }
a { color: var(--link); }
input[type=search] { width: 100%; font: inherit; padding: 0.5rem 0.7rem; border: 1px solid var(--rule); border-radius: 6px; background: var(--bg); color: var(--fg); }
ul.toc { list-style: none; padding: 0; } ul.toc li { margin: 0.35rem 0; } ul.toc .snip { color: var(--muted); font-size: 0.9rem; display: block; }
`;

export type DocSection = { topic: string; topicTitle: string; id: string; title: string; text: string };

/** A topic's markdown as HTML, with its sections: each `## Title {#id}` an anchored h2 (an id is required, so a link
 * into a section never changes when its words do). */
export function renderTopic(topic: string, md: string): { title: string; description: string; html: string; sections: DocSection[] } {
  const src = md.replace(/^(?:<!--[\s\S]*?-->\n?)+/, "");
  const description = md.match(/^<!--\s*description:\s*([\s\S]*?)-->/)?.[1].replace(/\s+/g, " ").trim() ?? "";
  const title = src.match(/^# (.+)$/m)?.[1].trim() ?? topic;
  const ids = new Set<string>();
  const m = new Marked({ gfm: true });
  m.use({
    renderer: {
      heading({ tokens, depth, text }: Tokens.Heading) {
        if (depth !== 2) return `<h${depth}>${this.parser.parseInline(tokens)}</h${depth}>\n`;
        const hit = /\s*\{#([a-z0-9-]+)\}\s*$/.exec(text);
        if (!hit) throw new Error(`docs/${topic}.md: "## ${text}" has no {#id}`);
        if (ids.has(hit[1])) throw new Error(`docs/${topic}.md: #${hit[1]} twice`);
        ids.add(hit[1]);
        const words = this.parser.parseInline(tokens).replace(/\s*\{#[a-z0-9-]+\}\s*$/, "");
        return `<h2 id="${hit[1]}">${words}<a class="self" href="#${hit[1]}" aria-label="Link to this section">#</a></h2>\n`;
      },
    },
  });
  const html = m.parse(src) as string;
  // (the sections, for the index and its search: each h2 to the next)
  const sections: DocSection[] = [];
  const parts = html.split(/(?=<h2 id=")/).slice(1);
  for (const p of parts) {
    const id = /^<h2 id="([^"]+)">/.exec(p)![1];
    const head = /^<h2[^>]*>([\s\S]*?)<a class="self"/.exec(p)![1];
    sections.push({ topic, topicTitle: title, id, title: plain(head), text: plain(p.replace(/^<h2[\s\S]*?<\/h2>/, "")) });
  }
  return { title, description, html, sections };
}

function page(o: { url: string; title: string; description: string; body: string; script?: string }): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(o.title)} | Sagebrush docs</title>
<meta name="description" content="${esc(o.description)}">
<link rel="canonical" href="${SITE}${o.url}">
<link rel="icon" href="/icons/icon-192.png">
<style>${CSS}</style>
<script src="/alpha-banner.js" defer></script>
</head>
<body>
<header class="site"><b><a href="/">Sagebrush</a></b> · <a href="/docs/">Docs</a></header>
<main>
${o.body}
</main>
${o.script ?? ""}</body>
</html>
`;
}

// (the index's search: every section's words in a JSON block, filtered as you type; the list shown is the same links
// as without JavaScript, so a search only hides what doesn't match. A query in the address, /docs/?q=sync, is kept)
const SEARCH = `<script>
(() => {
  const all = JSON.parse(document.getElementById("docs-index").textContent);
  const q = document.getElementById("q"), items = [...document.querySelectorAll("ul.toc li")], none = document.getElementById("none");
  const run = () => {
    const words = q.value.toLowerCase().split(/\\s+/).filter(Boolean);
    let shown = 0;
    items.forEach((li, i) => {
      const s = all[i], hay = (s.topicTitle + " " + s.title + " " + s.text).toLowerCase();
      const hit = words.every((w) => hay.includes(w));
      li.hidden = !hit;
      if (hit) shown++;
    });
    none.hidden = shown > 0;
    const u = new URL(location.href);
    if (q.value) u.searchParams.set("q", q.value); else u.searchParams.delete("q");
    history.replaceState(null, "", u);
  };
  q.value = new URL(location.href).searchParams.get("q") ?? "";
  q.addEventListener("input", run);
  run();
})();
</script>
`;

/** The docs' pages written into `out` (out/docs/), from the topics in `src`; their URLs, for the sitemap. */
export function buildDocs(out: string, src = join(here, "docs")): { url: string; date: string }[] {
  const date = new Date().toISOString().slice(0, 10);
  rmSync(join(out, "docs"), { recursive: true, force: true });
  mkdirSync(join(out, "docs"), { recursive: true });
  const urls: { url: string; date: string }[] = [];
  const index: DocSection[] = [];
  for (const f of readdirSync(src).filter((f) => /^[a-z0-9-]+\.md$/.test(f)).sort()) {
    const topic = f.slice(0, -3);
    const t = renderTopic(topic, readFileSync(join(src, f), "utf8"));
    writeFileSync(join(out, "docs", topic + ".html"), page({ url: `/docs/${topic}`, title: t.title, description: t.description, body: t.html }));
    urls.push({ url: `/docs/${topic}`, date });
    index.push(...t.sections);
  }
  const list = index.map((s) => `<li><a href="/docs/${s.topic}#${s.id}">${esc(s.topicTitle)}: ${esc(s.title)}</a><span class="snip">${esc(s.text.length > 140 ? s.text.slice(0, 137).replace(/\s+\S*$/, "") + "…" : s.text)}</span></li>`).join("\n");
  const body = `<h1>Docs</h1>
<input type="search" id="q" placeholder="Search the docs" aria-label="Search the docs" autocomplete="off">
<ul class="toc">
${list}
</ul>
<p id="none" hidden>Nothing matches.</p>
<script type="application/json" id="docs-index">${JSON.stringify(index).replace(/</g, "\\u003c")}</script>`;
  writeFileSync(join(out, "docs", "index.html"), page({ url: "/docs/", title: "Docs", description: "How to use Sagebrush: storage, sync and more.", body, script: SEARCH }));
  urls.push({ url: "/docs/", date });
  console.log(`docs: ${urls.length - 1} topics, ${index.length} sections`);
  return urls;
}

if (import.meta.main) {
  const { siteDir, hasSite } = await import("./site-dir.mts");
  if (!hasSite) throw new Error("build-docs: web/site is absent");
  buildDocs(join(siteDir, "public"));
}
