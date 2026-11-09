// ci: checks.3 order=35
// The Agents page on the site (#869): after the default build (no flags), web/build.ts has built the page into
// web/dist/agents, and, on a build with the site (web/site, web/site-dir.mts), copied exactly its page and script into
// web/site/public/agents, byte for byte: no tarball (the help box points at the reviewed tarball's own URL) and nothing
// left from an earlier build.  Its policy: /agents/* in the site's _headers, frame-ancestors 'none'.
//   bun web/build.ts && node web/agents/test-agents-site.mjs
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const web = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const fails = [];
const ok = (c, what) => (console.log(`${c ? "ok  " : "FAIL"} ${what}`), c || fails.push(what));

const FILES = ["agents.js", "connect.html", "index.html"];
const dist = join(web, "dist", "agents");
ok(existsSync(dist) && FILES.every((f) => existsSync(join(dist, f)) && statSync(join(dist, f)).size > 0), "the default build (no flags) built the Agents page: dist/agents/index.html and agents.js, and connect.html");
const html = existsSync(join(dist, "index.html")) ? readFileSync(join(dist, "index.html"), "utf8") : "";
ok(/<script[^>]+src="\/agents\/agents\.js"/.test(html), "its page loads its own script, /agents/agents.js");
ok(/<a href="\/agents\/connect">/.test(html), "its help box links to \"How to connect your agent\", /agents/connect");

// (the site, as web/site-dir.mts decides it: web/site present and SAGEBRUSH_NO_SITE not 1)
const site = join(web, "site");
if (process.env.SAGEBRUSH_NO_SITE !== "1" && existsSync(site)) {
  const pub = join(site, "public", "agents");
  const have = existsSync(pub) ? readdirSync(pub).sort() : [];
  ok(JSON.stringify(have) === JSON.stringify(FILES), `the site serves exactly the pages and the script at /agents: ${JSON.stringify(have)}`);
  ok(FILES.every((f) => existsSync(join(pub, f)) && existsSync(join(dist, f)) && readFileSync(join(pub, f)).equals(readFileSync(join(dist, f)))), "…byte for byte as built in dist/agents");
  ok(!have.some((f) => f.endsWith(".tgz")), "…and no sagebrush-agent tarball from the site");
  const headers = existsSync(join(site, "public", "_headers")) ? readFileSync(join(site, "public", "_headers"), "utf8") : "";
  const rule = /^\/agents\/\*\n((?:[ \t].*\n?)*)/m.exec(headers)?.[1] ?? "";
  ok(/frame-ancestors 'none'/.test(rule) && /connect-src[^;]*ws:\/\/127\.0\.0\.1:\*/.test(rule), "the site's _headers give /agents/* its policy: frame-ancestors 'none', the loopback socket allowed");
  // ("How to connect your agent": a page without scripts, so it adds no hash to the rule, and its links stay on the site)
  const conn = existsSync(join(pub, "connect.html")) ? readFileSync(join(pub, "connect.html"), "utf8") : "";
  ok(conn.includes("<h1>How to connect your agent to Sagebrush</h1>") && !/<script/i.test(conn), "…with \"How to connect your agent to Sagebrush\", a page without scripts");
} else console.log("(no site in this checkout: the site's copy isn't checked)");

console.log(fails.length ? `test-agents-site: ${fails.length} failed` : "test-agents-site: all passed");
process.exit(fails.length ? 1 : 0);
