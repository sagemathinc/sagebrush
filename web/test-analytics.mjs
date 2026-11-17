// ci: checks.3 order=99 runner=bun
// Cloudflare Web Analytics on the site's public pages (web/analytics.js, web/analytics.mts): the pages that should load
// the beacon's script do (the docs, the blog, the articles, the shared /s/ page) and the app's don't (the notebook, the
// board, the agents, the examples' pages); the script adds Cloudflare's exact snippet on sagebrush.space only, never on
// /gh/, an LTI launch or in a frame; the policies (web/csp.ts headersFor) admit the beacon's two origins on those
// pages' rules only, every other directive as it was, and never on /gh/; the offline service worker leaves the beacon
// alone.
//   bun web/test-analytics.mjs
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runInNewContext } from "node:vm";
import { ANALYTICS_CONNECT_ORIGIN, ANALYTICS_PAGES, ANALYTICS_SCRIPT_ORIGIN, ANALYTICS_TAG } from "./analytics.mts";
import { ghPolicy, pagePolicy, withAnalytics } from "./csp-policy.mts";
import { headersFor } from "./csp.ts";
import { buildDocs } from "./build-docs.ts";
import { indexPage, postPage } from "./blog.ts";

const here = dirname(new URL(import.meta.url).pathname);
let n = 0;
const fails = [];
const check = (ok, what, detail) => {
  n++;
  if (!ok) {
    fails.push(what);
    console.log("FAIL " + what + (detail === undefined ? "" : " " + JSON.stringify(detail).slice(0, 400)));
  }
};
const read = (p) => readFileSync(join(here, p), "utf8");
const SNIPPET = { src: "https://static.cloudflareinsights.com/beacon.min.js", beacon: '{"token": "bbae8a56ea934552933137eedcc08651"}' };

// ---- the script: Cloudflare's snippet, exactly, on sagebrush.space's own pages only
const run = (href, { framed = false } = {}) => {
  const u = new URL(href), added = [];
  const el = () => { const a = {}; return { type: "", src: "", setAttribute: (k, v) => (a[k] = v), attrs: a }; };
  const doc = { createElement: (t) => Object.assign(el(), { tag: t }), head: { append: (x) => added.push(x) } };
  const win = {};
  win.top = framed ? {} : win;
  runInNewContext(read("analytics.js"), { window: win, document: doc, location: { hostname: u.hostname, pathname: u.pathname, hash: u.hash } });
  return added;
};
{
  const a = run("https://sagebrush.space/docs/storage");
  check(a.length === 1 && a[0].tag === "script" && a[0].type === "module" && a[0].src === SNIPPET.src && a[0].attrs["data-cf-beacon"] === SNIPPET.beacon, "on sagebrush.space: Cloudflare's snippet, exactly (a module script, its src, its token)", a);
  check(run("https://sagebrush.space/s/abc123").length === 1 && run("https://sagebrush.space/blog/").length === 1, "…on a shared page and the blog too");
  for (const href of ["http://localhost:8765/docs/storage", "https://dev.sagebrush.space/docs/storage", "https://example.org/s/abc", "https://preview-1.sagebrush.pages.dev/docs/"]) check(run(href).length === 0, `not on another host (a self-hosted site, DEV, a preview, a test): ${href}`);
  check(run("https://sagebrush.space/gh/owner/repo/blob/main/a.ipynb").length === 0, "not on /gh/ (the /s/ page, served for a GitHub repository)");
  check(run("https://sagebrush.space/s/#lti=xyz").length === 0, "not on an LTI launch (#lti=)");
  check(run("https://sagebrush.space/docs/storage", { framed: true }).length === 0, "not in a frame");
}

// ---- the pages that load it, and those that don't
check(ANALYTICS_TAG === '<script src="/analytics.js" defer></script>', "the pages' tag: the first-party script, deferred");
{
  const out = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "analytics-docs-"));
  buildDocs(out);
  for (const p of ["docs/index.html", "docs/storage.html", "docs/privacy.html"]) {
    const html = readFileSync(join(out, p), "utf8");
    check(html.includes(ANALYTICS_TAG + "\n</head>") && !html.includes("cloudflareinsights"), `${p}: loads the script, in its head (and names no Cloudflare URL itself)`);
  }
  const privacy = readFileSync(join(out, "docs/privacy.html"), "utf8");
  check(privacy.includes("We use Cloudflare Web Analytics, which sets no cookies and collects no personal data, to count page views.") && readFileSync(join(out, "docs/index.html"), "utf8").includes('href="/docs/privacy#page-views"'), "the privacy page says it, and the docs' index links to it");
}
{
  const post = { slug: "p", title: "T", date: "2026-11-17", author: "A", description: "D", html: "<p>x</p>", source: "p.md" };
  check(postPage(post, "").includes(ANALYTICS_TAG + "\n</head>") && indexPage([post], "").includes(ANALYTICS_TAG + "\n</head>"), "the blog's pages (a post, the index): load the script");
}
check(/<script src="\/alpha-banner\.js" defer><\/script>\n\$\{ANALYTICS_TAG\}\n<\/head>/.test(read("build-articles.ts")), "the articles' page template: loads the script");
check(read("share-client/view.html").includes(ANALYTICS_TAG + "\n</head>"), "the shared /s/ page: loads the script (which adds nothing on /gh/)");
for (const p of ["index.html", "board/index.html", "agents/index.html", "agents/connect/index.html", "embed/index.html", "questions/index.html", "threads/index.html", "build-examples.ts", "atlas/render.ts", "board/export.ts", "output-shell/build.mts"]) {
  const s = read(p);
  check(!s.includes("analytics.js") && !s.includes("ANALYTICS_TAG") && !s.includes("cloudflareinsights"), `not in the app's or the examples' pages: ${p}`);
}

// ---- the policies: the beacon's two origins on those pages' rules only, every other directive as it was
{
  const p = pagePolicy(["'sha256-x'"]), w = withAnalytics(p);
  const dirs = (s) => Object.fromEntries(s.split(";").map((d) => d.trim()).filter(Boolean).map((d) => [d.split(/\s+/)[0], d]));
  const a = dirs(p), b = dirs(w);
  check(b["script-src"] === `${a["script-src"]} ${ANALYTICS_SCRIPT_ORIGIN}` && b["connect-src"] === `${a["connect-src"]} ${ANALYTICS_CONNECT_ORIGIN}`, "withAnalytics: script-src gains https://static.cloudflareinsights.com, connect-src https://cloudflareinsights.com", b);
  check(Object.keys(a).every((k) => k === "script-src" || k === "connect-src" || a[k] === b[k]) && Object.keys(a).length === Object.keys(b).length, "…every other directive as it was");
  check(ANALYTICS_SCRIPT_ORIGIN === "https://static.cloudflareinsights.com" && ANALYTICS_CONNECT_ORIGIN === "https://cloudflareinsights.com", "the two origins, exactly");
  const g = ghPolicy(w);
  check(!g.includes("cloudflareinsights") && g === ghPolicy(p), "the /gh/ policy from the /s/ page's: neither origin, as from a policy without them", g);
}
{
  // (a site's pages, one per rule that matters, through the real rule maker)
  const dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "analytics-csp-"));
  const page = (p) => { mkdirSync(join(dir, dirname(p)), { recursive: true }); writeFileSync(join(dir, p), "<!doctype html><title>t</title>"); };
  for (const p of ["index.html", "s/index.html", "docs/index.html", "docs/storage.html", "blog/index.html", "articles/index.html", "articles/a/index.html", "board/index.html", "agents/index.html", "examples/index.html", "atlas/index.html", "frame/board/index.html", "runner/index.html"]) page(p);
  const text = headersFor(dir);
  const rules = new Map();
  let at = null;
  for (const line of text.split("\n")) {
    if (line && !/^\s|^#/.test(line)) at = line;
    else if (at && /^\s+Content-Security-Policy: /.test(line)) rules.set(at, line.trim().slice("Content-Security-Policy: ".length));
  }
  const has = (csp) => csp.includes(ANALYTICS_SCRIPT_ORIGIN) && csp.includes(ANALYTICS_CONNECT_ORIGIN);
  for (const pat of ANALYTICS_PAGES) check(rules.has(pat) && has(rules.get(pat)) && rules.get(pat) === withAnalytics(pagePolicy([])), `${pat}: the page policy with the beacon's two origins, nothing else changed`, rules.get(pat));
  const others = [...rules.keys()].filter((k) => !ANALYTICS_PAGES.includes(k));
  check(others.length >= 8 && others.every((k) => !rules.get(k).includes("cloudflareinsights")), "every other rule (/, /index.html, /board/*, /agents/*, /examples/*, /atlas/*, /frame/*, /runner/*, /gh/*): neither origin", others);
  check(rules.has("/gh/*") && !rules.get("/gh/*").includes("cloudflareinsights"), "/gh/*: neither origin");
}

// ---- the offline service worker: it leaves other origins' requests to the network, and keeps nothing of Cloudflare's
{
  const sw = read("sw.js");
  const fetchAt = sw.indexOf('self.addEventListener("fetch"'), crossAt = sw.indexOf("if (url.origin !== scope.origin) return;", fetchAt), respondAt = sw.indexOf("respondWith", fetchAt);
  check(fetchAt > 0 && crossAt > fetchAt && crossAt < respondAt, "sw.js: a request to another origin (the beacon's script, its counts) is left to the network, before anything answers it");
  check(!sw.includes("cloudflareinsights") && !sw.includes("analytics.js"), "sw.js: nothing of the beacon's kept or named");
}

console.log(`${n - fails.length}/${n} passed`);
if (fails.length) process.exit(1);
