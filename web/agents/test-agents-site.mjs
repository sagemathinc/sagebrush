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

const FILES = ["agents.js", "connect/index.html", "index.html"];
// (a directory's files, as paths under it, sorted)
const walk = (dir, rel = "") => existsSync(join(dir, rel)) ? readdirSync(join(dir, rel), { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(dir, rel + e.name + "/") : [rel + e.name]).sort() : [];
const dist = join(web, "dist", "agents");
ok(existsSync(dist) && FILES.every((f) => existsSync(join(dist, f)) && statSync(join(dist, f)).size > 0), "the default build (no flags) built the Agents page: dist/agents/index.html and agents.js, and connect/index.html");
const html = existsSync(join(dist, "index.html")) ? readFileSync(join(dist, "index.html"), "utf8") : "";
ok(/<script[^>]+src="\/agents\/agents\.js"/.test(html), "its page loads its own script, /agents/agents.js");
ok(/<a href="\/agents\/connect\/">/.test(html), "its help box links to \"How to connect your agent\", /agents/connect/ (a directory's index: served without .html on every host)");
// (the help box and the connect page name one sagebrush-agent release, the same one, with the same sha256: a new
// release changes the URL, the sha and every "sagebrush-agent X.Y.Z" mention together, in both pages)
const conn0 = existsSync(join(dist, "connect", "index.html")) ? readFileSync(join(dist, "connect", "index.html"), "utf8") : "";
const release = (t) => ({ v: [...new Set([...t.matchAll(/sagebrush-agent(?:-|(?:<\/code>)?\s+)(\d+\.\d+\.\d+)/g)].map((m) => m[1]))], sha: [...new Set([...t.matchAll(/\b[0-9a-f]{64}\b/g)].map((m) => m[0]))] });
const rh = release(html), rc = release(conn0);
ok(rh.v.length === 1 && rc.sha.length === 1 && JSON.stringify(rh.v) === JSON.stringify(rc.v) && rh.sha.every((x) => rc.sha.includes(x)), `the help box and the connect page name the same one release, and the connect page its sha256 (the help box no other): ${JSON.stringify(rh)} / ${JSON.stringify(rc)}`);
// (William, Nov 8: no wall of text in the app: the help box is one short line, its command, and Learn more)
const helpText = (/<div id="help"[^>]*>([\s\S]*?)<\/div>/.exec(html)?.[1] ?? "").replace(/<pre>[\s\S]*?<\/pre>/g, "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
ok(helpText.length > 0 && helpText.length <= 100 && /Learn more/.test(helpText), `the help box is one short line with Learn more (${helpText.length} characters): ${helpText}`);
const helpLinks = [...(/<div id="help"[^>]*>([\s\S]*?)<\/div>/.exec(html)?.[1] ?? "").matchAll(/<a\b[^>]*>/g)].map((m) => m[0]);
ok(helpLinks.length === 1 && /href="\/agents\/connect\/"/.test(helpLinks[0]) && conn0, `the help box's one link, Learn more, is the connect page (the one whose sha256 the release check reads): ${helpLinks}`);
// (the connect page's option-2 commands, exactly: sagebrush.space's is the plain npx line (0.3.1 prints the
// sagebrush.space link itself); DEV's sets the printed link and adds DEV's origin)
const tgz = `https://agents.sagebrush.cloud/agents/sagebrush-agent-${rc.v[0]}.tgz`;
const cmds = [...conn0.matchAll(/<pre><code>([^<]*sagebrush-agent-[^<]*)<\/code><\/pre>/g)].map((m) => m[1]);
ok(JSON.stringify(cmds) === JSON.stringify([`npx -y ${tgz}`, `SAGEBRUSH_AGENT_PAGE=https://dev.sagebrush.space/agents/ npx -y ${tgz} --origin https://dev.sagebrush.space`]), `the connect page's two commands, exactly (sagebrush.space: plain npx; DEV: its page and --origin): ${JSON.stringify(cmds)}`);

// (Chat here, W2 B: the agent leg (agent-relay.ts) and the digest's canon (agent-canon.ts) are in the Agents page's
//  own script only, never in another page's: their marks, the hello's htu and the digest's domain, nowhere else in dist)
{
  const marks = ["sb-agent-hello:", "sb-agent-permission/1"];
  const js = walk(join(web, "dist")).filter((f) => /\.(m?js|cjs)$/.test(f) && !f.startsWith("agents/"));
  const carriers = js.filter((f) => { const t = readFileSync(join(web, "dist", f), "utf8"); return marks.some((m) => t.includes(m)); });
  const agents = existsSync(join(dist, "agents.js")) ? readFileSync(join(dist, "agents.js"), "utf8") : "";
  ok(marks.every((m) => agents.includes(m)) && carriers.length === 0, `the agent leg and the canon are in agents.js only (${js.length} other scripts in dist checked; carrying them: ${JSON.stringify(carriers)})`);
}
// (and its policy reaches the relay's agent leg on the page's own origin through 'self' (CSP Level 3 matches ws:/wss:
//  of the same host), with no wss: source of any other host added)
{
  const rule = /^\/agents\/\*\n((?:[ \t].*\n?)*)/m.exec(readFileSync(join(web, "dist", "_headers"), "utf8"))?.[1] ?? "";
  const connect = /connect-src ([^;]*)/.exec(rule)?.[1] ?? "";
  ok(connect.split(/\s+/).includes("'self'") && !/(^|\s)wss:/.test(connect) && !/wss:\/\/\*/.test(connect), `/agents/*'s connect-src: 'self', and no other host's wss: (${connect})`);
}

// (the site, as web/site-dir.mts decides it: web/site present and SAGEBRUSH_NO_SITE not 1)
const site = join(web, "site");
if (process.env.SAGEBRUSH_NO_SITE !== "1" && existsSync(site)) {
  const pub = join(site, "public", "agents");
  const have = walk(pub);
  ok(JSON.stringify(have) === JSON.stringify(FILES), `the site serves exactly the pages and the script at /agents: ${JSON.stringify(have)}`);
  ok(FILES.every((f) => existsSync(join(pub, f)) && existsSync(join(dist, f)) && readFileSync(join(pub, f)).equals(readFileSync(join(dist, f)))), "…byte for byte as built in dist/agents");
  ok(!have.some((f) => f.endsWith(".tgz")), "…and no sagebrush-agent tarball from the site");
  const headers = existsSync(join(site, "public", "_headers")) ? readFileSync(join(site, "public", "_headers"), "utf8") : "";
  const rule = /^\/agents\/\*\n((?:[ \t].*\n?)*)/m.exec(headers)?.[1] ?? "";
  ok(/frame-ancestors 'none'/.test(rule) && /connect-src[^;]*ws:\/\/127\.0\.0\.1:\*/.test(rule), "the site's _headers give /agents/* its policy: frame-ancestors 'none', the loopback socket allowed");
  // ("How to connect your agent": a page without scripts, so it adds no hash to the rule, and its links stay on the site)
  const conn = existsSync(join(pub, "connect", "index.html")) ? readFileSync(join(pub, "connect", "index.html"), "utf8") : "";
  ok(conn.includes("<h1>How to connect your agent to Sagebrush</h1>") && !/<script/i.test(conn), "…with \"How to connect your agent to Sagebrush\", a page without scripts");
} else console.log("(no site in this checkout: the site's copy isn't checked)");

console.log(fails.length ? `test-agents-site: ${fails.length} failed` : "test-agents-site: all passed");
process.exit(fails.length ? 1 : 0);
