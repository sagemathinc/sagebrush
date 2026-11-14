// ci: web-sync.4 order=11 runner=bun
// A public GitHub repository's notebook or folder, /gh/... (web/gh): the site's Worker serves it as the shared-collection
// page's asset (/s/), never indexed, and never fetches GitHub itself. Checked on handleGhPage (web/site/src/preview.ts)
// and through the Worker's own fetch (web/site/src/index.ts), its `cloudflare:workers` env stood in for here, so a
// dispatch that no longer reaches handleGhPage fails as surely as a handleGhPage that answers nothing.
//   bun web/site/test-gh-route.mjs
import { plugin } from "bun";

let checks = 0;
const fails = [];
const ok = (cond, what, detail) => { checks++; console.log(`${cond ? "ok  " : "FAIL"} ${what}${cond || detail === undefined ? "" : " " + JSON.stringify(detail)}`); if (!cond) fails.push(what); };

// (the site's assets, as the Worker's ASSETS binding serves them: each request recorded; the page says which asset it is)
const fetched = [];
// (each with the site's page policy, as _headers gives /s/*: connect-src https: and http:)
const { pagePolicy } = await import("../csp-policy.mts");
const PAGE = pagePolicy();
const ASSETS = { async fetch(req) { fetched.push({ url: req.url, method: req.method }); return new Response(`asset ${new URL(req.url).pathname}`, { headers: { "Content-Type": "text/html", "Content-Security-Policy": PAGE } }); } };
// (a GitHub page's fetches: GitHub's three hosts by exact origin, and no other site; every other directive the page's)
const GH_CONNECT = "connect-src 'self' data: blob: ws://127.0.0.1:* ws://localhost:* https://api.github.com https://raw.githubusercontent.com https://data.jsdelivr.com";
const connectOf = (r) => /connect-src [^;]+/.exec(r?.headers.get("Content-Security-Policy") ?? "")?.[0];
const restOf = (csp) => (csp ?? "").replace(/connect-src [^;]+/, "");
globalThis.__siteEnv = { ASSETS };
plugin({ name: "cloudflare-workers-env", setup(b) { b.module("cloudflare:workers", () => ({ exports: { env: globalThis.__siteEnv }, loader: "object" })); } });
const { handleGhPage } = await import("./src/preview.ts");
const worker = (await import("./src/index.ts")).default;

// ---- handleGhPage itself
for (const path of ["/gh/o/r/blob/main/a.ipynb", "/gh/o/r/tree/main/examples/notebooks", "/gh/o/r", "/gh/https://github.com/o/r/blob/main/x.ipynb"]) {
  fetched.length = 0;
  const url = new URL("https://sagebrush.space" + path);
  const r = await handleGhPage(new Request(url), url, { ASSETS });
  ok(r !== null && (await r.text()) === "asset /s/" && fetched.length === 1 && fetched[0].url === "https://sagebrush.space/s/", `${path}: the /s/ page's asset, nothing else asked for`, fetched);
  ok(r?.headers.get("X-Robots-Tag") === "noindex, nofollow", `${path}: never indexed`, r?.headers.get("X-Robots-Tag"));
  ok(connectOf(r) === GH_CONNECT && restOf(r?.headers.get("Content-Security-Policy")) === restOf(PAGE), `${path}: its policy's connect-src GitHub's three hosts exactly, the rest the page's`, r?.headers.get("Content-Security-Policy"));
}
{
  fetched.length = 0;
  const url = new URL("https://sagebrush.space/gh/o/r/blob/main/a.ipynb");
  await handleGhPage(new Request(url, { method: "HEAD" }), url, { ASSETS });
  ok(fetched[0]?.method === "HEAD", "a HEAD stays a HEAD", fetched);
}
for (const path of ["/gh", "/ghost/x", "/s/abcdefghijkl", "/", "/agents/gh/x"]) {
  const url = new URL("https://sagebrush.space" + path);
  ok(handleGhPage(new Request(url), url, { ASSETS }) === null, `${path}: not a GitHub page (null)`);
}

// ---- the Worker's own fetch: a /gh/ page reaches handleGhPage; anything else is the asset it asked for
const ctx = { waitUntil() {}, passThroughOnException() {} };
for (const path of ["/gh/o/r/blob/main/a.ipynb", "/gh/o/r/tree/main/"]) {
  fetched.length = 0;
  const r = await worker.fetch(new Request("https://sagebrush.space" + path), globalThis.__siteEnv, ctx);
  ok((await r.text()) === "asset /s/" && r.headers.get("X-Robots-Tag") === "noindex, nofollow" && fetched.length === 1, `the Worker: ${path} is the /s/ page, noindex`, fetched);
  ok(connectOf(r) === GH_CONNECT, `the Worker: ${path}'s connect-src is GitHub's three hosts exactly`, connectOf(r));
}
// (a shared collection's page, /s/<id>, keeps the site's policy as it is)
for (const path of ["/s/", "/s/abcdefghijkl"]) {
  const r = await worker.fetch(new Request("https://sagebrush.space" + path), globalThis.__siteEnv, ctx);
  ok(r.headers.get("Content-Security-Policy") === PAGE, `the Worker: ${path}'s policy is the site's page policy, unchanged`, r.headers.get("Content-Security-Policy"));
}
{
  fetched.length = 0;
  const r = await worker.fetch(new Request("https://sagebrush.space/ghost/page"), globalThis.__siteEnv, ctx);
  ok((await r.text()) === "asset /ghost/page" && r.headers.get("X-Robots-Tag") === null, "the Worker: another path is its own asset, unchanged", fetched);
}

console.log(fails.length ? `FAIL: ${fails.length} of ${checks}` : `ok: all ${checks} passed`);
process.exit(fails.length ? 1 : 0);
