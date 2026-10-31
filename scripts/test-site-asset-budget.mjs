// The site asset budget gate's check 1 (scripts/site-asset-budget.mjs): the reviewed PROD differences are accepted
// exactly, and every broader change is refused. Each case builds three small trees (base PROD, PROD, DEV) and runs the
// gate on them, reading only check 1's line.
//   node scripts/test-site-asset-budget.mjs
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const GATE = join(dirname(fileURLToPath(import.meta.url)), "site-asset-budget.mjs");
const PAGE = "connect-src 'self' data: blob: https: http:", LOOP = " ws://127.0.0.1:* ws://localhost:*";
const A = "a".repeat(40), B = "b".repeat(40), C = "c".repeat(40);
const policy = (connect, script = "'self'") => `default-src 'self'; script-src ${script}; ${connect}; frame-src 'self'; object-src 'none'`;
const headers = ({ page = PAGE, frame = PAGE, runner = "connect-src 'none'", script, board = page, embed = page } = {}) => [
  "# every page's Content-Security-Policy",
  "/", `  Content-Security-Policy: ${policy(page, script)}`, "  X-Content-Type-Options: nosniff",
  "/index.html", `  Content-Security-Policy: ${policy(page, script)}`,
  "/frame/*", `  Content-Security-Policy: ${policy(frame)}`,
  "/runner/*", `  Content-Security-Policy: ${policy(runner)}`,
  "/board/*", `  Content-Security-Policy: ${policy(board, script)}`,
  "/embed/*", `  Content-Security-Policy: ${policy(embed, script)}`,
  "/s/*", `  Content-Security-Policy: ${policy(page, script)}`, "",
].join("\n");
const sha = (s) => createHash("sha256").update(s).digest("hex");
const sw = ({ version = "0123456789abcdef", csp = policy(PAGE), lazy = '["docs-index.json"]', extra = "", docsSha = sha(docs()) } = {}) =>
  `// the service worker\nconst VERSION = "${version}";\nconst SHELL = {"/index.html":{"headers":{"Content-Type":"text/html","Content-Security-Policy":"${csp}"}},"docs-index-python.json":{"sha256":"${docsSha}","headers":{"Content-Type":"application/json"}}};\nconst LAZY = ${lazy};${extra}\n`;
const docs = ({ ref = A, ref2 = ref, doc = "", path = "lib/a.py" } = {}) => JSON.stringify([
  { name: "a", doc: "A." + doc, source: `https://github.com/sagemathinc/sagebrush/blob/${ref}/${path}#L1-L9` },
  { name: "b", doc: "B.", source: `https://github.com/sagemathinc/sagebrush/blob/${ref2}/lib/b.py#L3-L4` },
]);
const BASE = { "dist/_headers": headers(), "dist/sw.js": sw(), "dist/docs-index-python.json": docs(), "dist/other.js": "1;" };
const REVIEWED = { "dist/_headers": headers({ page: PAGE + LOOP }), "dist/sw.js": sw({ version: "fedcba9876543210", csp: policy(PAGE + LOOP), docsSha: sha(docs({ ref: B })) }), "dist/docs-index-python.json": docs({ ref: B }) };

function tree(dir, files, dev = false) {
  const all = { "dist/index.html": "<!doctype html><title>s</title>" + (dev ? "<script src=x></script>" : ""), "site/public/robots.txt": "ok", ...files };
  if (dev) all["dist/sagebrush-latex.js"] = "0;";
  for (const [n, t] of Object.entries(all)) if (t !== undefined) { mkdirSync(dirname(join(dir, n)), { recursive: true }); writeFileSync(join(dir, n), t); }
}
function gate(prodFiles) {
  const d = mkdtempSync(join(tmpdir(), "site-budget-"));
  try {
    tree(join(d, "base"), BASE); tree(join(d, "prod"), { ...BASE, ...prodFiles }); tree(join(d, "dev"), { ...BASE, ...prodFiles }, true);
    let out;
    try { out = execFileSync(process.execPath, [GATE, "--base-prod", join(d, "base"), "--prod", join(d, "prod"), "--dev", join(d, "dev")], { encoding: "utf8", timeout: 30_000 }); }
    catch (e) { out = String(e.stdout); }
    const line = out.split("\n").find((l) => / PROD files: /.test(l));
    if (!line) throw new Error("no check 1 line:\n" + out);
    return line.startsWith("ok   ");
  } finally { rmSync(d, { recursive: true, force: true }); }
}

let failed = 0, n = 0;
const expect = (name, want, files) => { n++; const got = gate(files); if (got !== want) failed++; console.log(`${got === want ? "ok  " : "FAIL"} ${want ? "accepts" : "refuses"}: ${name}`); };
expect("PROD the same as base (control)", true, {});
expect("the reviewed differences together", true, REVIEWED);
expect("each reviewed difference alone: _headers", true, { "dist/_headers": REVIEWED["dist/_headers"] });
expect("each reviewed difference alone: sw.js", true, { "dist/sw.js": sw({ version: "fedcba9876543210", csp: policy(PAGE + LOOP) }) });
expect("sw.js and the docs index together: its SHA-256 the new file's", true, { "dist/sw.js": REVIEWED["dist/sw.js"], "dist/docs-index-python.json": docs({ ref: B }) });
expect("each reviewed difference alone: docs-index-python.json", true, { "dist/docs-index-python.json": REVIEWED["dist/docs-index-python.json"] });
// _headers
expect("the loopback sources in the frame policy too", false, { ...REVIEWED, "dist/_headers": headers({ page: PAGE + LOOP, frame: PAGE + LOOP }) });
expect("the loopback sources in the frame policy only", false, { "dist/_headers": headers({ frame: PAGE + LOOP }) });
expect("the loopback sources in the /board/* and /embed/* rules alone (page paths)", true, { "dist/_headers": headers({ board: PAGE + LOOP, embed: PAGE + LOOP }) });
expect("a broader source in the /embed/* rule", false, { "dist/_headers": headers({ page: PAGE + LOOP, embed: PAGE + " ws:" }) });
expect("the runner policy changed", false, { ...REVIEWED, "dist/_headers": headers({ page: PAGE + LOOP, runner: "connect-src 'self'" }) });
expect("a broader source: ws:", false, { "dist/_headers": headers({ page: PAGE + " ws:" }) });
expect("a further source after the loopback ones", false, { "dist/_headers": headers({ page: PAGE + LOOP + " wss://example.com" }) });
expect("one loopback source only", false, { "dist/_headers": headers({ page: PAGE + " ws://127.0.0.1:*" }) });
expect("another page directive changed with it", false, { "dist/_headers": headers({ page: PAGE + LOOP, script: "'self' 'unsafe-eval'" }) });
expect("another header line changed", false, { "dist/_headers": headers({ page: PAGE + LOOP }).replace("nosniff", "none") });
// sw.js
expect("sw.js: another byte changed with VERSION", false, { "dist/sw.js": sw({ version: "fedcba9876543210", csp: policy(PAGE + LOOP), lazy: '["docs-index.json","x.js"]' }) });
expect("sw.js: the loopback string outside the header value too", false, { "dist/sw.js": sw({ csp: policy(PAGE + LOOP), extra: `\n// ${PAGE + LOOP};` }) });
expect("sw.js: the loopback string outside the header value only", false, { "dist/sw.js": sw({ extra: `\n// ${PAGE + LOOP};` }) });
expect("sw.js: the docs index's SHA-256 not its file's", false, { ...REVIEWED, "dist/sw.js": sw({ csp: policy(PAGE + LOOP), docsSha: sha(docs({ ref: C })) }) });
expect("sw.js: the docs index's SHA-256 changed, the file not", false, { "dist/sw.js": sw({ csp: policy(PAGE + LOOP), docsSha: sha(docs({ ref: B })) }) });
// (a base that has the loopback addition already, from the PR that added it: sw.js may differ by VERSION and the docs
//  index's SHA-256 (the file's own) only)
const LBASE = { "dist/_headers": headers({ page: PAGE + LOOP }), "dist/sw.js": sw({ csp: policy(PAGE + LOOP) }), "dist/docs-index-python.json": docs(), "dist/other.js": "1;" };
const gateOn = (base, prod) => { const save = { ...BASE }; Object.keys(BASE).forEach((k) => delete BASE[k]); Object.assign(BASE, base); try { return gate(prod); } finally { Object.keys(BASE).forEach((k) => delete BASE[k]); Object.assign(BASE, save); } };
{ n++; const got = gateOn(LBASE, { "dist/sw.js": sw({ version: "fedcba9876543210", csp: policy(PAGE + LOOP), docsSha: sha(docs({ ref: B })) }), "dist/docs-index-python.json": docs({ ref: B }) }); if (!got) failed++; console.log(`${got ? "ok  " : "FAIL"} accepts: a base with the loopback already: sw.js's VERSION and the docs SHA-256 only`); }
{ n++; const got = gateOn(LBASE, { "dist/sw.js": sw({ version: "fedcba9876543210", csp: policy(PAGE) }) }); if (got) failed++; console.log(`${!got ? "ok  " : "FAIL"} refuses: a base with the loopback already: sw.js dropping it`); }
{ n++; const got = gateOn(LBASE, { "dist/sw.js": sw({ version: "fedcba9876543210", csp: policy(PAGE + LOOP), lazy: '["x.js"]' }) }); if (got) failed++; console.log(`${!got ? "ok  " : "FAIL"} refuses: a base with the loopback already: another sw.js byte changed`); }
expect("sw.js: a broader source", false, { "dist/sw.js": sw({ csp: policy(PAGE + " ws:") }) });
// docs-index-python.json
expect("docs: a commit in a doc text", false, { "dist/docs-index-python.json": docs({ ref: B, doc: ` https://github.com/sagemathinc/sagebrush/blob/${B}/x` }) });
expect("docs: a source path changed", false, { "dist/docs-index-python.json": docs({ ref: B, path: "lib/z.py" }) });
expect("docs: two commits on one side", false, { "dist/docs-index-python.json": docs({ ref: B, ref2: C }) });
expect("docs: another field changed", false, { "dist/docs-index-python.json": docs({ ref: B }).replace('"B."', '"B!"') });
// anything else
expect("another file differing", false, { ...REVIEWED, "dist/other.js": "2;" });
expect("a reviewed file removed from PROD", false, { "dist/sw.js": undefined });
console.log(failed ? `FAIL: the site asset budget's check 1, ${failed} of ${n}` : `ok: the site asset budget's check 1, ${n} cases`);
process.exit(failed ? 1 : 0);
