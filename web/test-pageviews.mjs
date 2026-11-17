// ci: checks.3 order=99 runner=bun
// Page views counted on the server (web/pageviews.ts), the pure part both the site's Worker and the self-hosted server
// call: which pages count and their class (never an id, a query or a hash), the referring host, the country, bots,
// which responses are page views (not a prefetch, a script's fetch, a HEAD or an error), and the day's visitor hash
// (the same browser the same day only; another salt, another hash). Nothing of the browser's: no cookie, no storage.
//   bun web/test-pageviews.mjs
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { agentOf, classify, dayOf, isView, newSalt, pathClassOf, refHostOf, SALT_TTL_S, visitorHash } from "./pageviews.ts";

let n = 0;
const fails = [];
const check = (ok, what, detail) => {
  n++;
  if (!ok) {
    fails.push(what);
    console.log("FAIL " + what + (detail === undefined ? "" : " " + JSON.stringify(detail).slice(0, 300)));
  }
};
const headers = (h = {}) => ({ get: (k) => h[k.toLowerCase()] ?? null });
const req = (url, h = {}, o = {}) => ({ url, method: o.method ?? "GET", headers: headers(h), cf: o.cf });
const res = (status, type = "text/html; charset=utf-8") => ({ status, headers: headers(type ? { "content-type": type } : {}) });
const CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// ---- the counted pages and their classes
// (by default, the section only: nothing anyone can type into a path reaches the counts)
const classes = {
  "/": "/", "/index.html": "/",
  "/docs": "docs", "/docs/": "docs", "/docs/storage": "docs", "/docs/storage.html": "docs", "/docs/jane.doe@example.com": "docs",
  "/blog": "blog", "/blog/": "blog", "/blog/hello-sagebrush": "blog", "/blog/feed.xml": "blog",
  "/articles/": "articles", "/articles/architecture/": "articles", "/articles/architecture/01-the-map": "articles",
  "/s": "s", "/s/": "s", "/s/k3j2h4g5f6d7s8a9": "s", "/s/k3j2h4g5f6d7s8a9@4": "s",
};
for (const [p, want] of Object.entries(classes)) check(pathClassOf(p) === want, `${p} is counted as ${want}`, pathClassOf(p));
{
  // (with the site's own page names: one of them by name, anything else "other", whatever was typed)
  const known = { docs: new Set(["storage", "sharing"]), blog: new Set(["hello-sagebrush"]), articles: new Set(["architecture"]) };
  const want = {
    "/docs/storage": "docs:storage", "/docs/storage.html": "docs:storage", "/docs/": "docs", "/docs/jane.doe@example.com": "docs:other", "/docs/STORAGE": "docs:other",
    "/blog/hello-sagebrush": "blog:hello-sagebrush", "/blog/my-name-is-jane-doe": "blog:other",
    "/articles/architecture/01-the-map": "articles:architecture", "/articles/secret-plans/": "articles:other",
    "/s/k3j2h4g5f6d7s8a9": "s", "/": "/",
  };
  for (const [p, w] of Object.entries(want)) check(pathClassOf(p, known) === w, `with the site's page names: ${p} is counted as ${w}`, pathClassOf(p, known));
  check(pathClassOf("/blog/anything", { docs: new Set(["storage"]) }) === "blog", "a section without names given: the section alone");
  const planted = ["/docs/jane.doe@example.com", "/blog/555-123-4567", "/articles/my-ssn-123-45-6789/x"].map((p) => classify(req("https://sagebrush.space" + p), known)?.pathClass);
  check(planted.every((c) => c === "docs:other" || c === "blog:other" || c === "articles:other"), "a typed string (an address, a phone number) never reaches the counts", planted);
}
for (const p of ["/gh/owner/repo/blob/main/a.ipynb", "/sagebrush-app.js", "/board/", "/examples/", "/examples/notebook/welcome/", "/api/share/x", "/auth/callback", "/atlas/", "/docsx", "/blogs", "/sagebrush-worker.js", "/s.html", "/frame/board/", "/favicon.ico"])
  check(pathClassOf(p) === null, `${p} is not counted`, pathClassOf(p));
{
  // (a class never carries a share's id, a query or a hash, whatever the URL has)
  const f = classify(req("https://sagebrush.space/s/k3j2h4g5f6d7s8a9@4?token=secret#lti=abc"));
  check(f?.pathClass === "s" && !JSON.stringify(f).includes("k3j2") && !JSON.stringify(f).includes("secret") && !JSON.stringify(f).includes("lti"), "a shared page's view keeps no id, query or hash", f);
  const d = classify(req("https://sagebrush.space/docs/storage?q=x#sync"), { docs: new Set(["storage"]) });
  check(d?.pathClass === "docs:storage" && !JSON.stringify(d).includes("q=x") && !JSON.stringify(d).includes("sync"), "a docs page's view keeps its known topic only", d);
  check(classify(req("https://sagebrush.space/gh/a/b")) === null && classify(req("not a url")) === null, "a /gh/ page, or no URL: nothing");
}

// ---- the referring host: the host only; "self" for this site; nothing for none or for a non-web referrer
check(refHostOf(null, "sagebrush.space") === "" && refHostOf("", "sagebrush.space") === "", "no referrer: \"\"");
check(refHostOf("https://www.google.com/search?q=sagebrush+notebook", "sagebrush.space") === "www.google.com", "a search engine: its host, never its query");
check(refHostOf("https://news.ycombinator.com/item?id=1", "sagebrush.space") === "news.ycombinator.com", "another site: its host only");
check(refHostOf("https://Sagebrush.Space/docs/", "sagebrush.space") === "self", "this site: \"self\"");
check(refHostOf("android-app://com.google.android.gm/", "sagebrush.space") === "" && refHostOf("not a url", "x") === "", "a non-web or broken referrer: \"\"");
check(refHostOf("https://Example.ORG:8443/x", "sagebrush.space") === "example.org" && refHostOf("http://localhost:8080/", "localhost") === "self", "lowercase, without a port (and this site on any port: \"self\")");
{
  const long = "a".repeat(63) + "." + "b".repeat(63) + "." + "c".repeat(63) + "." + "d".repeat(70) + ".com";
  const h = refHostOf(`https://${long}/`, "sagebrush.space");
  check(h.length === 253 && long.startsWith(h), "at most 253 characters (a DNS name's longest)", h.length);
}
{
  const f = classify(req("https://sagebrush.space/blog/", { referer: "https://example.org/a/b?c=d" }));
  check(f?.refHost === "example.org", "classify: the referrer's host", f);
}

// ---- the country: Cloudflare's, by cf.country or its header; unknown, Tor or anything else: ""
check(classify(req("https://sagebrush.space/", {}, { cf: { country: "DE" } }))?.country === "DE", "cf.country");
check(classify(req("http://localhost:8080/", { "cf-ipcountry": "FR" }))?.country === "FR", "CF-IPCountry (a self-hosted server behind Cloudflare)");
for (const c of ["XX", "T1", "de", "DEU", "", "1A"]) check(classify(req("https://sagebrush.space/", { "cf-ipcountry": c }))?.country === "", `country ${JSON.stringify(c)}: ""`);
check(classify(req("https://sagebrush.space/"))?.country === "", "no country: \"\"");

// ---- bots: by the User-Agent; none at all is a script
check(agentOf(CHROME) === "human" && agentOf("Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1") === "human", "a browser: human");
for (const ua of ["Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)", "Mozilla/5.0 (compatible; bingbot/2.0)", "curl/8.5.0", "python-requests/2.32", "Mozilla/5.0 HeadlessChrome/131.0", "facebookexternalhit/1.1", "Slackbot-LinkExpanding 1.0", "", null])
  check(agentOf(ua) === "bot", `a bot: ${JSON.stringify(ua)}`);

// ---- page views: a GET of the page itself, answered with it
const doc = { "sec-fetch-dest": "document", "user-agent": CHROME };
check(isView(req("https://sagebrush.space/", doc), res(200)), "a navigation answered with the page: a view");
check(isView(req("https://sagebrush.space/", doc), res(304, null)), "…or revalidated (304): a view");
check(isView(req("https://sagebrush.space/", { accept: "text/html,application/xhtml+xml" }), res(200)), "no Sec-Fetch-Dest (an older browser) but Accept: text/html: a view");
check(!isView(req("https://sagebrush.space/", doc, { method: "HEAD" }), res(200)) && !isView(req("https://sagebrush.space/", doc, { method: "POST" }), res(200)), "HEAD or POST: not a view");
for (const s of [301, 302, 404, 500]) check(!isView(req("https://sagebrush.space/", doc), res(s)), `status ${s}: not a view`);
check(!isView(req("https://sagebrush.space/", doc), res(200, "application/json")) && !isView(req("https://sagebrush.space/", doc), res(200, null)), "not HTML: not a view");
check(!isView(req("https://sagebrush.space/", { ...doc, "sec-purpose": "prefetch" }), res(200)) && !isView(req("https://sagebrush.space/", { ...doc, "sec-purpose": "prefetch;prerender" }), res(200)) && !isView(req("https://sagebrush.space/", { ...doc, purpose: "prefetch" }), res(200)), "a prefetch or prerender: not a view");
check(!isView(req("https://sagebrush.space/", { "sec-fetch-dest": "empty" }), res(200)) && !isView(req("https://sagebrush.space/", { "sec-fetch-dest": "iframe" }), res(200)), "a script's fetch, or a frame: not a view");
check(!isView(req("https://sagebrush.space/", {}), res(200)), "neither Sec-Fetch-Dest nor Accept: not a view");

// ---- the visitor hash: the same browser the same day; another salt (day), IP or browser, another hash
{
  const a = newSalt(), b = newSalt();
  check(/^[0-9a-f]{64}$/.test(a) && a !== b, "a salt: 32 random bytes as hex, a new one each time");
  const h = await visitorHash(a, "203.0.113.7", CHROME);
  check(/^[0-9a-f]{16}$/.test(h) && h === (await visitorHash(a, "203.0.113.7", CHROME)), "the same salt, IP and browser: the same 16 hex digits");
  check(h !== (await visitorHash(b, "203.0.113.7", CHROME)), "another day's salt: another hash (days can't be linked)");
  check(h !== (await visitorHash(a, "203.0.113.8", CHROME)) && h !== (await visitorHash(a, "203.0.113.7", CHROME + " ")), "another IP or browser: another hash");
  // (a known vector, computed apart from this code (Python's hashlib): SHA-256 of the salt, IP and browser joined by
  // newlines, its first 16 hex digits; so the hash is exactly that function of the three, nothing of the IP kept)
  const SALT = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
  const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
  check((await visitorHash(SALT, "203.0.113.7", UA)) === "e08706e30a81bcde", "a known SHA-256 vector: salt, IP and browser give exactly e08706e30a81bcde");
  let threw = false;
  try { await visitorHash("not a salt", "1.2.3.4", CHROME); } catch { threw = true; }
  check(threw, "a salt not shaped as 32 bytes in hex is refused (a shape check: it can't prove the salt is random; newSalt makes it so)");
  check(dayOf(Date.UTC(2026, 10, 17, 23, 59, 59)) === "2026-11-17" && dayOf(Date.UTC(2026, 10, 18, 0, 0, 0)) === "2026-11-18", "the day: UTC");
  check(SALT_TTL_S > 24 * 3600 && SALT_TTL_S <= 27 * 3600, "a day's salt is kept for its day and a little after, not longer");
}

// ---- nothing of the browser's: the module reads no cookie, no storage, no account
{
  const src = readFileSync(join(dirname(new URL(import.meta.url).pathname), "pageviews.ts"), "utf8").replace(/^\s*(\/\/|\*|\/\*\*).*$/gm, "");
  check(!/cookie|localStorage|sessionStorage|indexedDB|document\.|window\.|navigator\.|account|session|authorization/i.test(src), "pageviews.ts reads no cookie, storage, account, session or authorization");
  const f = classify(req("https://sagebrush.space/", { cookie: "sagebrush_session=abc", authorization: "Bearer x", "user-agent": CHROME }));
  check(f && Object.keys(f).sort().join() === "agent,country,pathClass,refHost" && !JSON.stringify(f).includes("abc"), "a view's fields are exactly its class, country, referring host and agent", f);
}

console.log(`${n - fails.length}/${n} passed`);
if (fails.length) process.exit(1);
