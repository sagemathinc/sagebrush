// A shared collection's page with its link preview (web/site/src/preview.ts,
// share-ux-plan r2 §6.3-6.5), against the real web/share-client/view.html
// served by a stand-in for the site's assets (an ETag, a CSP, 304s), and a
// stand-in for sharePreview (the cloud's D1 lookup, tested in
// web/share/test-share.mjs).
//   bun web/site/test-preview.mjs
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { handleSharePage, SHARE_PAGE } from "./src/preview.ts";

const here = dirname(fileURLToPath(import.meta.url));
const VIEW = readFileSync(join(here, "../share-client/view.html"), "utf8");
let checks = 0;
const fails = [];
const ok = (cond, what) => {
  checks++;
  if (!cond) {
    fails.push(what);
    console.log("FAIL " + what);
  }
};

const ETAG = '"view-1"';
const assetFetches = [];
const ASSETS = {
  async fetch(req) {
    assetFetches.push({ url: req.url, method: req.method, inm: req.headers.get("if-none-match") });
    if (new URL(req.url).pathname !== "/s/") return new Response("nope", { status: 404 });
    const headers = { "content-type": "text/html; charset=utf-8", etag: ETAG, "content-length": String(Buffer.byteLength(VIEW)), "content-security-policy": "default-src 'self'", "cross-origin-opener-policy": "same-origin", "last-modified": "Sun, 25 Oct 2026 00:00:00 GMT" };
    if (req.headers.get("if-none-match") === ETAG) return new Response(null, { status: 304, headers: { etag: ETAG } });
    return new Response(req.method === "HEAD" ? null : VIEW, { status: 200, headers });
  },
};
const ID = "abcdefghijk2";
const V = "a".repeat(64);
const shares = new Map([[ID, { title: "My notebook", version: V, owner: "OWNER-1234-SECRET", files: ["data.csv"] }]]);
// (shares whose version predates migration 0004: no stored title, so sharePreview answers null)
const premigration = new Set();
const preview = async (_env, id, at) => {
  if (id === "boom2boom2bo") throw new Error("D1 down");
  if (premigration.has(id)) return null;
  const s = shares.get(id);
  if (!s || (at !== null && !s.version.startsWith(at))) return null;
  return s;
};
const env = { ASSETS, SITE_ORIGIN: "https://sagebrush.test" };
const page = (path, init = {}, e = env) => {
  const url = new URL("https://sagebrush.test" + path);
  return handleSharePage(new Request(url, init), url, e, preview);
};
const bodyOf = async (r) => (r.body ? await r.text() : "");
const headersOf = (r) => JSON.stringify([...r.headers].sort());

// What a crawler sees in <head>: the title text and each tag's content, parsed.
async function parsed(html) {
  const out = { title: "", meta: {}, scripts: 0, count: {} };
  await new HTMLRewriter()
    .on("head > title", { text: (t) => (out.title += t.text) })
    .on("meta", {
      element: (e) => {
        const k = e.getAttribute("property") ?? e.getAttribute("name");
        if (!k) return;
        out.count[k] = (out.count[k] ?? 0) + 1;
        out.meta[k] = e.getAttribute("content") === null ? null : unescape(e.getAttribute("content"));
      },
    })
    .on("script", { element: () => out.scripts++ })
    .transform(new Response(html))
    .text();
  return out;
}
const unescape = (s) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const generic = await parsed(VIEW);

// ---- the static page's fixed tags (the generic card)
for (const k of ["og:type", "og:site_name", "og:title", "og:description", "og:url", "og:image", "og:image:width", "og:image:height", "og:image:alt", "twitter:card", "twitter:title", "twitter:description", "twitter:image", "twitter:image:alt", "robots"]) ok(generic.count[k] === 1, `view.html has exactly one ${k}`);
ok(generic.meta["twitter:card"] === "summary_large_image" && generic.meta.robots === "noindex", "summary_large_image, and noindex kept");
ok(generic.meta["og:title"] === "A shared notebook on Sagebrush", "the generic card's title");

// ---- a live share: its title, canonical URLs, nothing else
{
  const r = await page(`/s/${ID}`);
  const h = await parsed(await r.text());
  ok(r.status === 200, "a live share: 200");
  ok(unescape(h.title) === "My notebook — Sagebrush", `its <title>: ${h.title}`);
  ok(h.meta["og:title"] === "My notebook" && h.meta["twitter:title"] === "My notebook", "og:title and twitter:title");
  ok(h.meta["og:url"] === `https://sagebrush.test/s/${ID}` && h.meta["og:image"] === "https://sagebrush.test/s/og.png" && h.meta["twitter:image"] === "https://sagebrush.test/s/og.png", "canonical og:url and absolute images from SITE_ORIGIN");
  ok(Object.keys(generic.count).every((k) => h.count[k] === generic.count[k]) && h.scripts === generic.scripts, "the same tags, once each, and no new script");
  ok(h.meta["og:description"] === generic.meta["og:description"], "the fixed description");
  ok(r.headers.get("cache-control") === "no-store" && !r.headers.get("etag") && !r.headers.get("last-modified") && !r.headers.get("content-length"), "no-store, and no ETag, Last-Modified or Content-Length from the static page");
  ok(r.headers.get("content-security-policy") === "default-src 'self'" && r.headers.get("cross-origin-opener-policy") === "same-origin", "the static page's security headers kept");
}
{
  const r = await page(`/s/${ID}@${V.slice(0, 16)}?utm=x#frag`);
  const h = await parsed(await r.text());
  ok(h.meta["og:url"] === `https://sagebrush.test/s/${ID}@${V}`, "a pinned link: og:url with the full version, the query dropped");
}
{
  // a hostile title
  shares.set("evil2evil2ev", { title: `x"'<>& </title><script>alert(1)</script>  `, version: V });
  const r = await page("/s/evil2evil2ev");
  const text = await r.text();
  const h = await parsed(text);
  ok(h.scripts === generic.scripts && !text.includes("<script>alert(1)"), "a hostile title adds no script");
  ok(unescape(h.title) === `x"'<>& </title><script>alert(1)</script>   — Sagebrush`, `the title, as text: ${h.title}`);
  ok(h.meta["og:title"] === `x"'<>& </title><script>alert(1)</script>  `, "the og:title attribute, escaped and intact");
  ok(Object.keys(generic.count).every((k) => h.count[k] === generic.count[k]), "...and no tag added or lost");
}
{
  const r = await page(`/s/${ID}`);
  const text = await r.text();
  ok(!text.includes("OWNER-1234-SECRET") && !text.includes("data.csv"), "nothing but the title from the share (no owner, no file list)");
}

// ---- everything else: the generic card, the same bytes for every id that isn't live (#171's review,
// board's UI-D1): with SITE_ORIGIN, its image absolute and no og:url; without, the static page as served
{
  // a deletion: live, then gone, with nothing kept between requests
  shares.set("gone2gone2go", { title: "Soon deleted", version: V });
  const before = await parsed(await (await page("/s/gone2gone2go")).text());
  shares.delete("gone2gone2go");
  ok(before.meta["og:title"] === "Soon deleted", "(live before the deletion)");
  // (a pre-migration version: sharePreview has no title for it, so null, like the rest)
  premigration.add("oldv2oldv2ol");
  const cases = [
    ["a never-existing id", await page("/s/zzzzzzzzzzzz")],
    ["an unknown pinned version", await page(`/s/${ID}@ffffffff`)],
    ["a lookup that fails", await page("/s/boom2boom2bo")],
    ["a deleted share", await page("/s/gone2gone2go")],
    ["a pre-migration version", await page("/s/oldv2oldv2ol")],
  ];
  const seen = [];
  for (const [what, r] of cases) {
    const body = await bodyOf(r), h = await parsed(body);
    ok(r.status === 200 && h.meta["og:image"] === "https://sagebrush.test/s/og.png" && h.meta["twitter:image"] === "https://sagebrush.test/s/og.png" && h.count["og:url"] === undefined && h.meta["og:title"] === generic.meta["og:title"], `${what}: the generic card, its image absolute and no og:url`);
    ok(r.headers.get("cache-control") === "no-store" && !r.headers.get("etag"), `${what}: no-store`);
    seen.push(JSON.stringify([r.status, headersOf(r), body]));
  }
  ok(seen.every((x) => x === seen[0]), "...and the five are byte-identical, headers and all: nothing tells them apart");
  const noOrigin = { ASSETS };
  const base = await ASSETS.fetch(new Request("https://sagebrush.test/s/"));
  const want = JSON.stringify([base.status, headersOf(base), await bodyOf(base)]);
  for (const path of ["/s/zzzzzzzzzzzz", "/s/gone2gone2go", "/s/oldv2oldv2ol"]) {
    const r = await page(path, {}, noOrigin);
    ok(JSON.stringify([r.status, headersOf(r), await bodyOf(r)]) === want, `without SITE_ORIGIN, ${path}: the static page, byte for byte, headers and all`);
  }
}

// ---- HTTP
{
  const g = await page(`/s/${ID}`);
  await g.text();
  const h = await page(`/s/${ID}`, { method: "HEAD" });
  ok(h.status === 200 && (await bodyOf(h)) === "" && headersOf(h) === headersOf(g), "HEAD: the same headers, no body");
}
{
  assetFetches.length = 0;
  const r = await page(`/s/${ID}`, { headers: { "if-none-match": ETAG } });
  ok(r.status === 200 && !r.headers.get("etag") && (await r.text()).includes("My notebook"), "If-None-Match on a live share's page: never the static page's 304");
  ok(assetFetches.every((f) => f.inm === null), "...the static page is fetched without the request's conditional headers");
  const g = await page("/s/zzzzzzzzzzzz", { headers: { "if-none-match": ETAG } });
  ok(g.status === 200 && !g.headers.get("etag"), "with SITE_ORIGIN the generic card is rewritten too: never the static page's 304");
  const g2 = await page("/s/zzzzzzzzzzzz", { headers: { "if-none-match": ETAG } }, { ASSETS });
  ok(g2.status === 304, "...without it, a generic page's conditional request works as before (the asset's 304)");
}
{
  const r = await page(`/s/${ID}`, { method: "POST", body: "x" });
  ok(r.status === 200 && (await r.text()) === VIEW, "a non-GET/HEAD request is never rewritten");
}
{
  const r = await page(`/s/${ID}`, {}, { ASSETS });
  const h = await parsed(await r.text());
  ok(h.count["og:url"] === undefined && h.meta["og:image"] === "/s/og.png" && h.meta["og:title"] === "My notebook", "without SITE_ORIGIN: no og:url, the image left relative");
}
ok((await page("/s/notashareid")) === null && (await page("/s/ABCDEFGHIJK2")) === null && (await page(`/s/${ID}/x`)) === null && !SHARE_PAGE.test("/s/"), "other paths aren't share pages");

// ---- the image (board's design, committed as rendered)
{
  const png = readFileSync(join(here, "../share-client/og.png"));
  ok(png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) && png.readUInt32BE(16) === 1200 && png.readUInt32BE(20) === 630, "og.png is a 1200x630 PNG");
  // (logo F's card, rendered from og.svg: design/logo, Oct 31; pinned by content, not only length)
  const sha = createHash("sha256").update(png).digest("hex");
  ok(png.length === 17436 && sha === "79a1ec20fa3185f803462bb25eac44a635a0b8e95884c6f0c5751d830dc66103", `og.png is the frozen card (${png.length} bytes, sha256 ${sha})`);
  const headers = readFileSync(join(here, "../_headers"), "utf8");
  ok(/\n\/s\/og\.png\n  Cross-Origin-Resource-Policy: cross-origin\n  Cache-Control: public, max-age=86400\n/.test(headers), "/s/og.png: cross-origin readable, cached a day");
  ok(/"s\/og\.png"/.test(readFileSync(join(here, "../build.ts"), "utf8")), "the build copies it to the site");
}

console.log(`${checks - fails.length}/${checks} passed`);
process.exit(fails.length ? 1 : 0);
