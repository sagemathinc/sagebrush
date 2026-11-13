// ci: web-sync.1 order=12
// A share is never indexed by a search engine (William, Nov 12: a share goes from one person to another, or out in a
// tweet; never into a search), on the dev site as it is served (web/share/serve-dev.mjs: web/dist with its _headers, the
// share API and the files Worker in Miniflare): every answer for a share says X-Robots-Tag: noindex, nofollow, its page
// carries <meta name="robots" content="noindex">, and its link preview's tags are still there for the tweet and the email.
// The share API's and the files Worker's every answer, in Miniflare, are web/share/test-share.mjs's; the site Worker's
// page, web/site/test-preview.mjs's; robots.txt and the sitemap, web/test-build-examples.mjs's.
//   bun web/build.ts && node web/share/test-share-noindex.mjs
import { createHash, randomBytes } from "node:crypto";
import { startDev } from "./serve-dev.mjs";

const A = "44444444-aaaa-4444-8444-444444444444";
const dev = await startDev({ sitePort: 0, filesPort: 0, limits: { [A]: { tier: "dev", storage_bytes: 1e7, max_file_bytes: 1e6, private_links: false } } });
const N = "noindex, nofollow";
let failures = 0, count = 0;
const ok = (c, what) => { count++; console.log((c ? "ok   " : "FAIL ") + what); if (!c) failures++; };
const sha = (b) => createHash("sha256").update(b).digest("hex");
try {
  // (a share, published through the API as the page publishes it)
  const signed = await fetch(dev.site + "/auth/dev", { method: "POST", headers: { origin: dev.site, "content-type": "application/json" }, body: JSON.stringify({ token: "dev-token", account_id: A }) });
  const cookie = signed.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const api = (path, method, body, type = "application/json") => fetch(dev.site + path, { method, headers: { origin: dev.site, cookie, "content-type": type }, body });
  const nb = Buffer.from(JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [{ cell_type: "code", id: "c1", metadata: {}, execution_count: null, outputs: [], source: "print(1)" }] }));
  await api("/api/share/check", "POST", JSON.stringify({ blobs: [{ sha256: sha(nb), size: nb.length }] }));
  await api(`/api/share/blob/${sha(nb)}`, "PUT", nb, "application/octet-stream");
  const files = [{ path: "n.ipynb", sha256: sha(nb), size: nb.length }];
  const first = await (await api("/api/share/first-upload", "POST", JSON.stringify({ title: "Never indexed", license: "MIT", files, attempt: randomBytes(16).toString("hex") }))).json();
  ok(signed.status === 200 && /^[a-z2-7]{12}$/.test(first.collection ?? ""), "(a share, published: " + first.collection + ")");
  const id = first.collection, v = first.version;

  // (the page: its link, a pinned version's, a share that doesn't exist, /s/ itself and its image; GET and HEAD)
  const pages = [`/s/${id}`, `/s/${id}@${v.slice(0, 16)}`, "/s/zzzzzzzzzzzz", "/s/", "/s/og.png"];
  const got = [];
  for (const p of pages) for (const method of ["GET", "HEAD"]) {
    const r = await fetch(dev.site + p, { method });
    got.push([method, p, r.status, r.headers.get("x-robots-tag")]);
  }
  ok(got.every((x) => x[2] === 200 && x[3] === N), "the share page (its link, a pinned version, a share that doesn't exist, /s/ and its image; GET and HEAD) says X-Robots-Tag: noindex, nofollow: " + JSON.stringify(got.filter((x) => x[2] !== 200 || x[3] !== N)));
  const html = await (await fetch(`${dev.site}/s/${id}`)).text();
  ok(/<meta name="robots" content="noindex">/.test(html), "...and the page itself carries <meta name=\"robots\" content=\"noindex\">");
  ok(/<meta property="og:title"/.test(html) && /<meta name="twitter:card" content="summary_large_image">/.test(html) && /<meta property="og:image"/.test(html), "...with its link preview (og and twitter tags) kept, for the tweet and the email");

  // (the API and the files, through the dev site: what the page fetches)
  const man = await fetch(`${dev.site}/api/share/c/${id}`);
  const c = await man.json();
  const file = await fetch(new URL(`/c/${id}/${sha(nb)}`, c.files_origin));
  const gone = await fetch(`${dev.site}/api/share/c/zzzzzzzzzzzz`);
  const out = await fetch(`${dev.site}/api/share/first-upload`, { method: "POST", headers: { origin: dev.site, "content-type": "application/json" }, body: "{}" });
  const r = { manifest: [man.status, man.headers.get("x-robots-tag")], file: [file.status, file.headers.get("x-robots-tag")], unknown: [gone.status, gone.headers.get("x-robots-tag")], signedOut: [out.status, out.headers.get("x-robots-tag")] };
  ok(JSON.stringify(r) === JSON.stringify({ manifest: [200, N], file: [200, N], unknown: [404, N], signedOut: [401, N] }), "its manifest, its file, an unknown share and a signed-out publish say it too: " + JSON.stringify(r));

  // (robots.txt blocks no share: a fetcher it blocks would never see the noindex, and the previews need the page)
  const robots = await fetch(dev.site + "/robots.txt");
  const rt = robots.status === 200 ? await robots.text() : "";
  ok(robots.status !== 200 || !/disallow/i.test(rt), `the site's robots.txt disallows nothing (${robots.status === 200 ? JSON.stringify(rt) : "none served here: " + robots.status})`);
} catch (e) {
  failures++;
  console.log("FAIL", e.message);
} finally {
  await dev.close();
}
console.log(failures ? `${failures} of ${count} failed` : `all ${count} passed`);
process.exit(failures ? 1 : 0);
