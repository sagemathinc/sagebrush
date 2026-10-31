// Framing (security audit G-1): every HTML route the site serves says who may
// frame it, so another site can't put a page of ours in a frame and steer the
// clicks on it (clickjacking: the agents page's Allow and "Remember this
// agent").  Read from the _headers web/csp.ts writes, the way Cloudflare
// applies them: every rule whose path matches a URL adds its headers.
// - /agents/ and everything under it: frame-ancestors 'none' and X-Frame-Options DENY;
// - the routes made to be embedded (EMBEDDABLE): frame-ancestors * and no X-Frame-Options;
// - every other page: frame-ancestors 'self' or 'none', with X-Frame-Options SAMEORIGIN or DENY to match.
// Checked on a fixture site with a page in each kind of place, and on web/dist and
// web/site/public when a build has written them (CI builds before this step).  The checker is
// shown to refuse a policy without frame-ancestors, one with it but without X-Frame-Options,
// and a page under /agents/ that allows 'self', each a case of its own.
// And scripts (security audit G-2): no rule's script-src names another site, only 'self', its pages' hashes,
// 'wasm-unsafe-eval', and blob: and 'unsafe-eval' on the rules that have them (the runner's, the frame's, the
// shell worker's), with a control for each wrong shape.
//   bun web/test-frame-ancestors.mjs
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const here = dirname(new URL(import.meta.url).pathname);
const { headersFor } = await import(join(here, "csp.ts"));
let bad = 0;
const ok = (c, what) => { if (c) console.log("ok   " + what); else { bad = 1; console.log("FAIL " + what); } };

// the routes meant to be framed by other sites, each with where that is decided
const EMBEDDABLE = [
  "/frame/", // web/csp-policy.mts:92 framePolicy (frame-ancestors *, sandboxed without allow-same-origin), web/csp.ts:60; design/frame.md
];
// (not in _headers, so not here: the cloud's LTI pages, whose Worker computes frame-ancestors from the approved
// registrations' origins (sagebrush-cloud-private web/lti/pages.ts:9-25); `sagebrush board open`'s local server,
// which serves the frame's policy with frame-ancestors 'none' (src/board-open.ts:125-131, test/board-open.test.ts).
// Headers a Worker sets have their own checks: web/atlas/server.ts in web/atlas/test-atlas.mjs, the preview
// Worker (the agents host) in web/preview/test-preview.mjs; the service worker's kept copy of index.html takes its
// headers from web/build.ts, the same pagePolicy and frameOptions.)

// _headers text -> rules: [pattern, [[name, value], ...]]
export function parseHeaders(text) {
  const rules = [];
  for (const line of text.split("\n")) {
    if (!line || line.startsWith("#")) continue;
    if (!/^\s/.test(line)) rules.push([line.trim(), []]);
    else if (rules.length) {
      const i = line.indexOf(":");
      rules.at(-1)[1].push([line.slice(0, i).trim().toLowerCase(), line.slice(i + 1).trim()]);
    }
  }
  return rules;
}
// Cloudflare's matching: an exact path, or a splat at the end
const matches = (pattern, url) => url === pattern || (pattern.endsWith("*") && url.startsWith(pattern.slice(0, -1)));
// the headers a URL gets: every matching rule's
export const effective = (rules, url) => rules.filter(([p]) => matches(p, url)).flatMap(([, h]) => h);

const urlsOf = (p) => (p === "index.html" ? ["/", "/index.html"] : p.endsWith("/index.html") ? ["/" + p.slice(0, -10), "/" + p] : ["/" + p, "/" + p.slice(0, -5)]);
function pages(dir, rel = "") {
  const out = [];
  for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
    const p = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...pages(dir, p));
    else if (e.name.endsWith(".html")) out.push(p);
  }
  return out;
}

// One URL's framing, as a list of problems (empty: as it should be).
export function framingProblems(rules, url) {
  const h = effective(rules, url);
  const csps = h.filter(([n]) => n === "content-security-policy").map(([, v]) => v);
  const xfo = h.filter(([n]) => n === "x-frame-options").map(([, v]) => v.toUpperCase());
  const fa = csps.flatMap((c) => c.split(";").map((d) => d.trim()).filter((d) => /^frame-ancestors\b/i.test(d)));
  const out = [];
  if (csps.length !== 1) out.push(`${csps.length} policies`);
  if (fa.length !== 1) return [...out, `frame-ancestors given ${fa.length} times`];
  const src = fa[0].replace(/^frame-ancestors\s+/i, "").trim();
  const embeddable = EMBEDDABLE.some((p) => url.startsWith(p));
  if (url === "/agents" || url.startsWith("/agents/")) {
    if (src !== "'none'") out.push(`frame-ancestors ${src}, not 'none'`);
    if (xfo.length !== 1 || xfo[0] !== "DENY") out.push(`X-Frame-Options ${JSON.stringify(xfo)}, not DENY`);
  } else if (embeddable) {
    if (src !== "*") out.push(`an embeddable route with frame-ancestors ${src}`);
    if (xfo.length) out.push(`an embeddable route with X-Frame-Options ${JSON.stringify(xfo)}`);
  } else {
    if (src !== "'self'" && src !== "'none'") out.push(`frame-ancestors ${src}`);
    const want = src === "'none'" ? "DENY" : "SAMEORIGIN";
    if (xfo.length !== 1 || xfo[0] !== want) out.push(`X-Frame-Options ${JSON.stringify(xfo)}, not ${want}`);
  }
  return out;
}

function wrongOf(dir, headers = headersFor) {
  const rules = parseHeaders(headers(dir));
  const urls = pages(dir).flatMap(urlsOf);
  return { urls, wrong: urls.map((u) => [u, framingProblems(rules, u)]).filter(([, p]) => p.length) };
}
// script-src (security audit G-2), per policy: exactly the tokens it has today (web/csp-policy.mts, the
// files-runner srcdoc's meta, the preview Worker's scripts), less the analytics beacon's host; 'sha256-' hashes
// where a policy takes its pages' scripts by hash.  No host, scheme, * or other keyword anywhere.
const SCRIPT_SRC = {
  page: ["'self'", "'wasm-unsafe-eval'"], // pagePolicy (and the atlas's, web/atlas/server.ts)
  shell: ["'self'", "blob:"], // shellWorkerPolicy
  runner: ["'unsafe-eval'", "'wasm-unsafe-eval'", "blob:"], // runnerPolicy (/runner/*, /engine/*)
  frame: ["'self'", "'unsafe-eval'", "'wasm-unsafe-eval'", "blob:"], // framePolicy (/frame/*)
  srcdoc: ["'unsafe-inline'", "'unsafe-eval'", "'wasm-unsafe-eval'", "blob:"], // web/notebook/files-runner.js's meta
  preview: ["'self'", "blob:", "'unsafe-eval'", "'wasm-unsafe-eval'"], // web/preview/worker.mjs SCRIPT_POLICY
};
const HASHED = ["page", "runner", "frame"];
// (a _headers rule's policy: by its path, as web/csp.ts chooses it)
const kindOf = (pattern) => (pattern === "/frame/*" ? "frame" : pattern === "/runner/*" || pattern === "/engine/*" ? "runner" : pattern === "/shell/worker-boot.js" ? "shell" : "page");
export function scriptSrcProblems(kind, csp) {
  const d = csp.split(";").map((x) => x.trim()).filter((x) => /^script-src\b/i.test(x));
  if (d.length !== 1) return [`script-src given ${d.length} times`];
  return d[0].split(/\s+/).slice(1).filter((t) => !SCRIPT_SRC[kind].includes(t) && !(HASHED.includes(kind) && /^'sha256-[A-Za-z0-9+/]+=*'$/.test(t))).map((t) => `script-src ${t}`);
}
const policiesOf = (text) => parseHeaders(text).flatMap(([p, h]) => h.filter(([n]) => n === "content-security-policy").map(([, v]) => [p, v]));
// the _headers rules whose script-src is wrong
const scriptWrong = (text) => policiesOf(text).filter(([p, v]) => scriptSrcProblems(kindOf(p), v).length).map(([p]) => p);
// the preview metadata prepare.mjs writes from them (the agents host's policies): [file, csp]
const { prepare } = await import(join(here, "..", "scripts", "preview", "prepare.mjs"));
function previewPolicies(dir, text) {
  writeFileSync(join(dir, "_headers"), text);
  const out = [...prepare(dir, "agents.sagebrush.cloud", []).files].filter(([p]) => p.startsWith(".preview/headers/")).map(([p, f]) => [p.slice(".preview/headers/".length, -5), JSON.parse(f.bytes.toString("utf8")).csp]);
  rmSync(join(dir, "_headers"));
  return out;
}
const previewKind = (file) => kindOf(file === "shell/worker-boot.js" ? "/shell/worker-boot.js" : "/" + file.split("/")[0] + "/*");
const previewWrong = (dir, text) => previewPolicies(dir, text).filter(([f, v]) => scriptSrcProblems(previewKind(f), v).length).map(([f]) => f);

function checkSite(dir, label) {
  const { urls, wrong } = wrongOf(dir);
  for (const [u, p] of wrong.slice(0, 20)) console.log(`     ${label} ${u}: ${p.join("; ")}`);
  ok(urls.length > 0 && wrong.length === 0, `${label}: all ${urls.length} HTML URLs say who may frame them (${wrong.length} wrong)`);
  const text = headersFor(dir), n = policiesOf(text).length, w = scriptWrong(text);
  for (const p of w.slice(0, 20)) console.log(`     ${label} ${p}: ${scriptSrcProblems(kindOf(p), policiesOf(text).find(([q]) => q === p)[1]).join("; ")}`);
  ok(n > 0 && w.length === 0, `${label}: all ${n} policies' script-src exactly as allowed, no other site's (${w.length} wrong)`);
}

// web/csp.ts and its imports copied, with web/csp-policy.mts changed by `edit` (a mutation control): its headersFor
let mutations = 0;
async function mutated(edit, what) {
  const mut = mkdtempSync(join(tmpdir(), `frame-anc-mut${++mutations}-`));
  mkdirSync(join(mut, "notebook"));
  for (const f of ["csp.ts", "site-dir.mts", "_headers", "notebook/files-runner.js"]) copyFileSync(join(here, f), join(mut, f));
  const src = readFileSync(join(here, "csp-policy.mts"), "utf8"), out = edit(src);
  ok(out !== null && out !== src, `control ${what}: the change applies to web/csp-policy.mts`);
  writeFileSync(join(mut, "csp-policy.mts"), out ?? src);
  const { headersFor: h } = await import(join(mut, "csp.ts"));
  return { headersFor: h, done: () => rmSync(mut, { recursive: true, force: true }) };
}
// (`a` in `src` exactly once, then replaced: or null)
const once = (src, a, b) => (src.split(a).length === 2 ? src.replace(a, b) : null);
const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

// the fixture: a page in each kind of place, and the shell worker's script
const fx = mkdtempSync(join(tmpdir(), "frame-anc-"));
try {
  const page = (p) => { mkdirSync(dirname(join(fx, p)), { recursive: true }); writeFileSync(join(fx, p), "<!doctype html><html><head><title>t</title></head><body><p>x</p></body></html>"); };
  for (const p of ["index.html", "agents/index.html", "agents/help.html", "board/index.html", "s/index.html", "w/index.html", "frame/board/index.html", "runner/index.html", "about.html"]) page(p);
  mkdirSync(join(fx, "shell"));
  writeFileSync(join(fx, "shell", "worker-boot.js"), "// worker\n");
  checkSite(fx, "fixture");
  const text = headersFor(fx), rules = policiesOf(text);
  const pageRules = rules.filter(([p]) => kindOf(p) === "page").map(([p]) => p);
  ok(rules.some(([p]) => kindOf(p) === "shell") && rules.some(([p]) => kindOf(p) === "frame") && rules.some(([p]) => kindOf(p) === "runner") && pageRules.length > 0, "fixture: a policy of each kind (page, shell, runner, frame)");
  // the agents host's policies, as the publisher writes them: script-src as allowed, and exactly the build's
  const meta = previewPolicies(fx, text), pagesMeta = meta.filter(([f]) => previewKind(f) === "page").map(([f]) => f);
  const scriptOf = (csp) => csp.split(";").map((x) => x.trim()).find((x) => /^script-src\b/.test(x));
  const ruleFor = (f) => rules.find(([p]) => p === (f === "shell/worker-boot.js" ? "/shell/worker-boot.js" : f.includes("/") ? "/" + f.split("/")[0] + "/*" : "/" + f))?.[1];
  ok(meta.length > 0 && previewWrong(fx, text).length === 0, `preview metadata: all ${meta.length} policies' script-src exactly as allowed`);
  ok(meta.every(([f, v]) => ruleFor(f) && scriptOf(v) === scriptOf(ruleFor(f))), "preview metadata: each script-src is the build's own (the publisher changes connect-src only)");
  // the files-runner's srcdoc (its own meta policy) and the preview Worker's scripts
  const { FILES_RUNNER } = await import(join(here, "notebook", "files-runner.js"));
  const srcdoc = /<meta http-equiv="Content-Security-Policy" content="([^"]*)">/.exec(FILES_RUNNER)?.[1] ?? "";
  ok(srcdoc && scriptSrcProblems("srcdoc", srcdoc).length === 0, "the files-runner srcdoc's script-src exactly as allowed");
  const { SCRIPT_POLICY } = await import(join(here, "preview", "worker.mjs"));
  ok(typeof SCRIPT_POLICY === "string" && scriptSrcProblems("preview", SCRIPT_POLICY).length === 0, "the preview Worker's script policy (exported) exactly as allowed");

  // the mutation controls, each failing exactly what it should
  {
    const m = await mutated((s) => once(s, "    `frame-ancestors ${frameAncestors}`,\n", ""), "(frame-ancestors out of pagePolicy)");
    const { urls, wrong } = wrongOf(fx, m.headersFor);
    const want = urls.filter((u) => !u.startsWith("/frame/") && !u.startsWith("/runner/"));
    ok(want.length > 0 && JSON.stringify(wrong.map(([u]) => u)) === JSON.stringify(want), `control: without frame-ancestors in pagePolicy, exactly its ${want.length} URLs fail (${wrong.length} did)`);
    m.done();
  }
  const PAGE_SRC = `"script-src 'self' 'wasm-unsafe-eval'"`, FRAME_SRC = `"script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval' blob:"`;
  for (const [name, edit, want, wantMeta] of [
    ["C-G2a (the beacon's host back in pagePolicy)", (s) => once(s, PAGE_SRC, `"script-src 'self' 'wasm-unsafe-eval' https://static.cloudflareinsights.com"`), pageRules, pagesMeta],
    ["C-G2b (https://example.com in framePolicy)", (s) => once(s, FRAME_SRC, `"script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval' blob: https://example.com"`), ["/frame/*"], null],
    ["C-G2c ('unsafe-eval' in pagePolicy)", (s) => once(s, PAGE_SRC, `"script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval'"`), pageRules, null],
    ["C-G2d (blob: in pagePolicy)", (s) => once(s, PAGE_SRC, `"script-src 'self' 'wasm-unsafe-eval' blob:"`), pageRules, null],
  ]) {
    const m = await mutated(edit, name), t = m.headersFor(fx), w = scriptWrong(t);
    ok(same(w, want), `control ${name}: exactly ${want.join(", ")} fail (${w.join(", ") || "none"} did)`);
    if (wantMeta) { const wm = previewWrong(fx, t); ok(wantMeta.length > 0 && same(wm, wantMeta), `control ${name}: and exactly the preview metadata of those pages (${wm.length} of ${wantMeta.length})`); }
    m.done();
  }
} finally {
  rmSync(fx, { recursive: true, force: true });
}
for (const d of [join(here, "dist"), join(here, "site", "public")]) if (existsSync(d)) checkSite(d, d.slice(here.length + 1));

// the checker itself, on rules made to be wrong in one way each
{
  const R = (csp, xfo) => [["/*", [["cross-origin-opener-policy", "same-origin"]]], ["/x", [["content-security-policy", csp], ...(xfo ? [["x-frame-options", xfo]] : [])]]];
  const RA = (csp, xfo) => [["/agents/*", [["content-security-policy", csp], ...(xfo ? [["x-frame-options", xfo]] : [])]]];
  ok(framingProblems(R("default-src 'self'; frame-ancestors 'self'", "SAMEORIGIN"), "/x").length === 0, "checker: a page with frame-ancestors 'self' and SAMEORIGIN passes");
  ok(framingProblems(R("default-src 'self'", "SAMEORIGIN"), "/x").length > 0, "checker: a policy without frame-ancestors is refused");
  ok(framingProblems(R("default-src 'self'; frame-ancestors 'self'", ""), "/x").length > 0, "checker: frame-ancestors without X-Frame-Options is refused");
  ok(framingProblems(R("default-src 'self'; frame-ancestors https://evil.example", "SAMEORIGIN"), "/x").length > 0, "checker: another site in frame-ancestors is refused");
  ok(framingProblems(RA("default-src 'self'; frame-ancestors 'self'", "SAMEORIGIN"), "/agents/").length > 0, "checker: /agents/ allowing 'self' is refused");
  ok(framingProblems(RA("default-src 'self'; frame-ancestors 'none'", "DENY"), "/agents/").length === 0, "checker: /agents/ with 'none' and DENY passes");
  // (Cloudflare adds every matching rule's headers: X-Frame-Options in /* reaches /frame/ too)
  ok(framingProblems([["/*", [["x-frame-options", "SAMEORIGIN"]]], ["/frame/*", [["content-security-policy", "sandbox allow-scripts; frame-ancestors *"]]]], "/frame/board/").length > 0, "checker: an X-Frame-Options in /* reaching an embeddable route is refused");
  // script-src (G-2)
  const { pagePolicy } = await import(join(here, "csp-policy.mts"));
  ok(scriptSrcProblems("page", pagePolicy(["'sha256-abc+/='"])).length === 0, "checker: the page policy with a hash passes");
  ok(scriptSrcProblems("page", "script-src 'self' https:").length === 1 && scriptSrcProblems("page", "script-src *").length === 1 && scriptSrcProblems("page", "script-src 'self' data:").length === 1 && scriptSrcProblems("page", "script-src 'self' 'strict-dynamic'").length === 1, "checker: https:, *, data: and an unlisted keyword are refused");
  ok(scriptSrcProblems("page", "script-src 'self' 'unsafe-inline'").length === 1 && scriptSrcProblems("shell", "script-src 'self' blob: 'unsafe-eval'").length === 1 && scriptSrcProblems("shell", "script-src 'self' blob: 'sha256-abc='").length === 1, "checker: 'unsafe-inline', 'unsafe-eval' and a hash where a policy has none are refused");
  ok(scriptSrcProblems("page", "default-src 'self'").length === 1, "checker: a policy without script-src is refused");
}

if (bad) { console.log("FAIL: test-frame-ancestors"); process.exit(1); }
console.log("ok: every HTML route says who may frame it, and every policy takes scripts from this site only");
