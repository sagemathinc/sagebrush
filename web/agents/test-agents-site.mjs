// ci: checks.3 order=35
// The Agents page on the site (#869): after the default build (no flags), web/build.ts has built the page into
// web/dist/agents, and, on a build with the site (web/site, web/site-dir.mts), copied exactly its page and script into
// web/site/public/agents, byte for byte: no tarball (the help box points at the reviewed tarball's own URL) and nothing
// left from an earlier build.  Its policy: /agents/* in the site's _headers, frame-ancestors 'none'.
//   bun web/build.ts && node web/agents/test-agents-site.mjs
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const web = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const fails = [];
const ok = (c, what) => (console.log(`${c ? "ok  " : "FAIL"} ${what}`), c || fails.push(what));

const FILES = ["agents.js", "connect.md", "connect/copy.js", "connect/index.html", "index.html"];
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
// (the sha256 of each reviewed sagebrush-agent release, as published on agents.sagebrush.cloud: a version bump
// without its sha, or a sha copied from another release, fails here; a new release adds its line)
const RELEASE_SHA256 = {
  "0.7.1": "2a131b9381de4b5d011bebc482dda7d2e13402f68a58b60dfba740fa18e0931c",
  "0.7.2": "f3771776d713c9f76b4b13a8ea6f712963ea46489d5295488c9362474d3e40ab",
  "0.7.3": "85ac62b714596920ee72c8426a164652b9c841a137ce846c905b3f4122ef4242",
  "0.7.4": "d51be4668b9508477b73e5d969424702808d6a3cfd6b83bb0f1bdb00a60e4e3c",
  "0.7.5": "8fb25135ad02c52cb1aacdb83e6b731164ab90e18213121eb1cda51446b2101b",
  "0.7.6": "f6a2cdea609ddec69d5da534b6a12434abc203dac5ee4603a17e8f51723a9eb8",
  "0.7.7": "fdb1032ec6601e8a176b4f7246ffe62da18f61d5c671fb2c0a9a4c8731ae4928",
  "0.7.8": "56926520d8b1095ee83a04d962aaa458283d50932c1c542ac6038e0b7988a645",
  "0.8.0": "6aca829ad3f8ce65c975f71dfe8b73e2cb6e959fb5c4113fae8733254b40a960",
  "0.8.1": "c920ba26cc8e5fd712f30050e4d19b1e8c5967caf8db0bf1cbb7fff1ca3a3373",
  "0.8.2": "7b4ab39279a38620d4957fd8feff5e6787c5c8318a44f13a0ff13855726894f3",
  "0.8.3": "b929ae64fa92285d0c797980a2482c0d54be489530f7b3528eefa63fad81cdc8",
  "0.8.4": "c50c856a6b9275edc0e2c0315fcff2def587e6b970f0d8bef2d2db0c55f8fa4d",
  "0.8.5": "b51adaa46080a365a3a79737630c9828aa8e261b39fd18ea8fd4d7294e10cb9d",
  "0.8.6": "6a4e401ace54b5ea046006c2f160820d6950ae5d527291653eb8f6c886175b1e",
  "0.8.7": "b5ebc33c9fb2d1f2cae2bbdad044872b1df4cd1a4cb0c02df2ec32cd6079043e",
  "0.8.8": "30f3bc2a87d46925bb5adf062b7a17c8ead923da9663e1d25fae1eb4bda59dc5",
  "0.8.9": "ad534c4501d54a96206adc36419a905c86b0e60fee951fa417aa01819a230cb1",
  "0.8.10": "92b64a4c5e267df47160c643ce201af923bccfda0fb73189377e966216e22e67",
};
const tgzVersions = [...new Set([...(html + conn0).matchAll(/sagebrush-agent-([^/"<\s]*)\.tgz/g)].map((m) => m[1]))];
ok(tgzVersions.length === 1 && JSON.stringify(tgzVersions) === JSON.stringify(rc.v), `every .tgz link on both pages names the same one version, the one the pages name: ${JSON.stringify(tgzVersions)}`);
ok(RELEASE_SHA256[rc.v[0]] !== undefined && JSON.stringify(rc.sha) === JSON.stringify([RELEASE_SHA256[rc.v[0]]]), `the connect page's sha256 is the reviewed one for sagebrush-agent ${rc.v[0]}: ${JSON.stringify(rc.sha)}`);
// (the docs the vendored agent's sagebrush_docs verb may fetch, its lib/docs-paths.json: each one a file this site
//  serves, on sagebrush.space, so the agent's list and the site can't drift apart. The agent is the release these pages
//  name, through one chain: the pages' version (rc.v) -> that release's reviewed SHA-256 (RELEASE_SHA256) -> the
//  fixture engine/py/test_remote_agent.py names (its version and its pin, both equal to those) -> the fixture's bytes
//  (hashed) -> the docs list read out of them.)
/** A docs path's problem, or null: it must be a canonical URL path (one URL parsing leaves byte for byte, with no query
 *  or fragment, so no dot, encoded-dot or doubled-slash segment), naming a regular file inside `distDir` (lstat: not a
 *  link or a folder) of at most 512 KiB. */
function docsPathProblem(p, distDir) {
  if (typeof p !== "string" || !/^\/[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*$/.test(p)) return "not a plain URL path";
  let u;
  try { u = new URL(p, "https://sagebrush.space"); } catch { return "not a URL path"; }
  if (u.pathname !== p || u.search || u.hash || p.split("/").some((seg) => seg === "." || seg === "..")) return "not canonical";
  const f = join(distDir, p);
  if (!f.startsWith(distDir + "/")) return "outside web/dist";
  let st;
  try { st = lstatSync(f); } catch { return "not served"; }
  if (!st.isFile()) return "not a regular file";
  if (st.size > 512 * 1024) return "over 512 KiB";
  return null;
}
{
  const { createHash } = await import("node:crypto");
  const { execFileSync } = await import("node:child_process");
  const py = join(web, "..", "engine", "py");
  const pins = readFileSync(join(py, "test_remote_agent.py"), "utf8");
  const name = /^VENDORED = os\.path\.join\(HERE, "fixtures", "sagebrush-agent-([0-9]+\.[0-9]+\.[0-9]+)\.tgz"\)$/m.exec(pins);
  const version = name?.[1], pin = /^VENDORED_SHA256 = "([0-9a-f]{64})"$/m.exec(pins)?.[1];
  const tgz = join(py, "fixtures", `sagebrush-agent-${version}.tgz`);
  const chain = { pages: rc.v[0], fixture: version, release: RELEASE_SHA256[rc.v[0]], pin };
  const bound = version === rc.v[0] && typeof pin === "string" && pin === RELEASE_SHA256[version] && existsSync(tgz) && createHash("sha256").update(readFileSync(tgz)).digest("hex") === pin;
  ok(bound, `the vendored agent is the release these pages name: its version, its pin and its bytes all that release's ${JSON.stringify(chain)}`);
  let list = null;
  if (bound) { try { list = JSON.parse(execFileSync("tar", ["-xzOf", tgz, "package/lib/docs-paths.json"], { encoding: "utf8", timeout: 30000 })); } catch { list = null; } }
  const paths = Array.isArray(list?.paths) ? list.paths : [];
  const distDir = join(web, "dist");
  const bad = paths.map((p) => [p, docsPathProblem(p, distDir)]).filter(([, why]) => why);
  ok(bound && list?.host === "sagebrush.space" && paths.length > 0 && bad.length === 0, `…its docs (lib/docs-paths.json, ${paths.length} paths on ${list?.host}) are each a regular file this site serves, at most 512 KiB: ${JSON.stringify(bad)}`);
  // (the path rule itself, against a folder of its own: what it refuses, and what it takes)
  const { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const d = mkdtempSync(join(tmpdir(), "sb-docs-paths-"));
  try {
    writeFileSync(join(d, "ok.md"), "x");
    mkdirSync(join(d, "folder"));
    symlinkSync(join(d, "ok.md"), join(d, "link.md"));
    writeFileSync(join(d, "big.md"), "x".repeat(512 * 1024 + 1));
    writeFileSync(join(d, "a%41.md"), "x"); // (a real file whose name has a percent escape: URL parsing keeps "/a%41.md", a server decodes it)
    const refused = { "/folder": "a folder", "/link.md": "a symlink", "/big.md": "over 512 KiB", "/missing.md": "not served", "/a/../ok.md": "a dot-dot segment", "/./ok.md": "a dot segment", "/%2e%2e/ok.md": "an encoded-dot segment", "//ok.md": "a doubled slash", "/ok.md?x": "a query", "/ok.md#x": "a fragment", "ok.md": "relative", "/ok md": "a space", "/a%41.md": "a percent escape" };
    const taken = Object.entries(refused).filter(([p]) => docsPathProblem(p, d) === null).map(([, what]) => what);
    ok(docsPathProblem("/ok.md", d) === null && taken.length === 0, `…the path rule takes a regular file and refuses ${Object.values(refused).join(", ")}: ${JSON.stringify(taken)}`);
  } finally { rmSync(d, { recursive: true, force: true }); }
}
// (William, Nov 8: no wall of text in the app: the help box is one short line, its command, and Learn more)
const helpText = (/<div id="help"[^>]*>([\s\S]*?)<\/div>/.exec(html)?.[1] ?? "").replace(/<pre>[\s\S]*?<\/pre>/g, "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
ok(helpText.length > 0 && helpText.length <= 100 && /Learn more/.test(helpText), `the help box is one short line with Learn more (${helpText.length} characters): ${helpText}`);
const helpLinks = [...(/<div id="help"[^>]*>([\s\S]*?)<\/div>/.exec(html)?.[1] ?? "").matchAll(/<a\b[^>]*>/g)].map((m) => m[0]);
ok(helpLinks.length === 1 && /href="\/agents\/connect\/"/.test(helpLinks[0]) && conn0, `the help box's one link, Learn more, is the connect page (the one whose sha256 the release check reads): ${helpLinks}`);
// (the connect page's option-2 commands, exactly: sagebrush.space's is the plain npx line (0.5.0 prints the
// sagebrush.space link itself); DEV's adds DEV's origin, which since 0.8.10 also makes the printed link DEV's)
const tgz = `https://agents.sagebrush.cloud/agents/sagebrush-agent-${rc.v[0]}.tgz`;
const cmds = [...conn0.matchAll(/<pre><code>([^<]*sagebrush-agent-[^<]*)<\/code><\/pre>/g)].map((m) => m[1]);
ok(JSON.stringify(cmds) === JSON.stringify([`npx -y ${tgz}`, `npx -y ${tgz} --origin https://dev.sagebrush.space`]), `the connect page's two commands, exactly (sagebrush.space: plain npx; DEV: --origin): ${JSON.stringify(cmds)}`);

// (Chat here: the agent leg (agent-relay.ts) and the digest's canon (agent-canon.ts) are in the Agents page's
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
  // ("How to connect your agent": no inline script (only its own copy.js, under 'self'), so it adds no hash to the rule,
  //  and its links stay on the site)
  const conn = existsSync(join(pub, "connect", "index.html")) ? readFileSync(join(pub, "connect", "index.html"), "utf8") : "";
  // (its one script is its own file, connect/copy.js, under 'self': no inline script, so it adds no hash to the rule)
  const scripts = [...conn.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)];
  ok(conn.includes("<h1>How to connect your agent to Sagebrush</h1>") && scripts.length === 1 && /^<script src="\/agents\/connect\/copy\.js" defer>$/.test(scripts[0][0].replace(/<\/script>$/i, "")) && scripts[0][1] === "", "…with \"How to connect your agent to Sagebrush\", no inline script: only its own copy.js");
} else console.log("(no site in this checkout: the site's copy isn't checked)");

console.log(fails.length ? `test-agents-site: ${fails.length} failed` : "test-agents-site: all passed");
process.exit(fails.length ? 1 : 0);
