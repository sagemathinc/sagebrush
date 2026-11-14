// ci: web-sync.4 order=33 runner=bun
// The share page's `lti` source (web/share-client/lti.ts): a `/s/#lti=<link>`
// from the course tool, accepted only on this site's paired tool origin; the
// file list's checks; the refusals' texts; the copy's id.  A fake fetch stands
// in for the tool.
//   bun web/share-client/test-lti-loader.mjs
import { loadLti, LTI_ORIGINS, LTI_REFUSALS } from "./lti.ts";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

let checks = 0;
const fails = [];
const ok = (cond, what) => {
  checks++;
  if (!cond) {
    fails.push(what);
    console.log("FAIL", what);
  }
};

const SITE = "https://site.test", TOOL = "https://tool.test";
const ORIGINS = { [SITE]: TOOL };
const CAP = "eyJ2IjoxfQ." + "a".repeat(64);
const LINK = `${TOOL}/lti/f/${CAP}/manifest`;
const hashOf = (u) => "#lti=" + encodeURIComponent(u);
const sha = (c) => c.repeat(64);
const file = (path, start, size, c = "b") => ({ path, size, sha256: sha(c), url: `${TOOL}/lti/f/${CAP}/${start}-${size}.${"c".repeat(32)}` });
const MANIFEST = { copy: "d".repeat(32), title: "Worksheet 1", created: Date.UTC(2026, 10, 12), sha256: sha("e"), expires: Date.now() + 600000, files: [file("README.md", 39, 12), file("src/main.py", 120, 15, "f")] };
// (a fake tool: answers one manifest, recording what was asked)
const asked = [];
const tool = (status, body) => async (url, init) => {
  asked.push({ url, init });
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
};
const load = (hash, fetchFn = tool(200, MANIFEST), site = SITE) => loadLti(hash, site, fetchFn, ORIGINS);

// a good link: the collection, keyed by the copy, one revision, each file at its own address
const c = await load(hashOf(LINK));
ok(typeof c === "object" && c.id === "lti:" + "d".repeat(32), `the copy's id keys the reader's copies (${c?.id})`);
ok(c.version === sha("e") && c.latest === c.version, "one revision: no 'a newer version' link");
ok(c.manifest.title === "Worksheet 1" && c.manifest.created === "2026-11-12T00:00:00.000Z" && c.manifest.files.length === 2 && !("url" in c.manifest.files[0]), "the title, the date, and the files (path, size, SHA-256 only)");
ok(c.fileUrl(c.manifest.files[1]) === MANIFEST.files[1].url && c.fileUrl({ path: "other", sha256: sha("b"), size: 1 }) === "", "each file's address is the one the list gave it; an unknown file has none");
ok(asked.at(-1).url === LINK && asked.at(-1).init.credentials === "omit" && asked.at(-1).init.redirect === "error" && asked.at(-1).init.referrerPolicy === "no-referrer", "the list is fetched without credentials, redirects or a referrer");

// not an lti link at all: the page's existing answer
ok((await load("")) === "This is not a link to a shared collection." && (await load("#other=1")) === "This is not a link to a shared collection.", "/s/ without #lti= is not a link to a shared collection");

// the link's origin and shape
const BAD = "This assignment link isn't valid. Open the assignment again from your course.";
const n0 = asked.length;
const bads = [
  ["another origin", `https://evil.test/lti/f/${CAP}/manifest`],
  ["http, not https", LINK.replace("https:", "http:")],
  ["the tool's origin with another port", LINK.replace("tool.test", "tool.test:8443")],
  ["another path", `${TOOL}/lti/admin/bundle`],
  ["a file, not the list", `${TOOL}/lti/f/${CAP}/0-1.${"c".repeat(32)}`],
  ["a query", LINK + "?x=1"],
  ["a fragment", LINK + "#x"],
  ["credentials in the URL", LINK.replace("https://", "https://u:p@")],
  ["a dot segment", `${TOOL}/lti/f/${CAP}/../manifest`],
  ["not a URL", "not a url"],
];
for (const [what, u] of bads) ok((await load(hashOf(u))) === BAD, `refused before any fetch: ${what}`);
ok((await load("#lti=%E0%A4%A")) === BAD, "refused: a fragment that doesn't decode");
ok((await load(hashOf(LINK), tool(200, MANIFEST), "https://other-site.test")) === BAD, "refused on a site with no paired tool");
ok((await load(hashOf(LINK), tool(200, MANIFEST), "https://toString")) === BAD && (await loadLti(hashOf(LINK), "__proto__", tool(200, MANIFEST), ORIGINS)) === BAD, "...including a site named like an object's own property");
ok(asked.length === n0, `none of those fetched anything (${asked.length - n0})`);

// the list's checks: every file under this same link, on the tool's origin, in canonical form
const withFile = (f) => ({ ...MANIFEST, files: [f] });
const listBads = [
  ["a file on another origin", withFile({ ...file("a", 1, 1), url: `https://evil.test/lti/f/${CAP}/1-1.${"c".repeat(32)}` })],
  ["a file under another link", withFile({ ...file("a", 1, 1), url: `${TOOL}/lti/f/other.${"a".repeat(64)}/1-1.${"c".repeat(32)}` })],
  ["a file URL not in canonical form", withFile({ ...file("a", 1, 1), url: `${TOOL}/lti/f/${CAP}/./1-1.${"c".repeat(32)}` })],
  ["a file URL with a query", withFile({ ...file("a", 1, 1), url: `${TOOL}/lti/f/${CAP}/1-1.${"c".repeat(32)}?x` })],
  ["a file URL naming the list", withFile({ ...file("a", 1, 1), url: `${TOOL}/lti/f/${CAP}/manifest` })],
  ["a bad SHA-256", withFile({ ...file("a", 1, 1), sha256: "x" })],
  ["a negative size", withFile({ ...file("a", 1, 1), size: -1 })],
  ["an empty path", withFile({ ...file("", 1, 1) })],
  ["two files with one path", { ...MANIFEST, files: [file("a", 1, 1), file("a", 2, 1)] }],
  ["no files list", { ...MANIFEST, files: null }],
  ["a bad copy id", { ...MANIFEST, copy: "D".repeat(32) }],
  ["a bad bundle SHA-256", { ...MANIFEST, sha256: "e" }],
  ["a date that isn't a time", { ...MANIFEST, created: "yesterday" }],
  ["a title that isn't text", { ...MANIFEST, title: 7 }],
];
for (const [what, m] of listBads) ok((await load(hashOf(LINK), tool(200, m))) === BAD, `the list refused: ${what}`);
ok((await load(hashOf(LINK), tool(200, "not json"))) === BAD, "the list refused: not JSON");

// the tool's refusals, each in the page's words
for (const [code, status] of [["heavy_busy", 503], ["rate", 429], ["folder_budget", 429], ["expired", 410], ["gone", 410], ["bundle_invalid", 500]])
  ok((await load(hashOf(LINK), tool(status, { error: code }))) === LTI_REFUSALS[code], `${status} ${code}: "${LTI_REFUSALS[code]}"`);
ok((await load(hashOf(LINK), tool(502, "<html>"))) === "Your course's files couldn't be loaded (HTTP 502). Open the assignment again from your course." && (await load(hashOf(LINK), tool(404, { error: "toString" }))).includes("HTTP 404"), "any other answer is said with its status (an error code named like an object's property too)");
ok((await load(hashOf(LINK), async () => { throw new TypeError("network"); })).startsWith("Sagebrush couldn't reach your course's files."), "a network failure says so");

// the pairing in production: DEV's site and DEV's tool only
ok(JSON.stringify(LTI_ORIGINS) === JSON.stringify({ "https://dev.sagebrush.space": "https://lti-dev.sagebrush.space" }), "the paired origins: DEV's site and DEV's course tool, nothing else");

// view.ts: the entry is a LOADERS entry above folderOf (outside the copy-race test's slice), for /s/ exactly
const view = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "view.ts"), "utf8");
const entry = view.indexOf("[/^\\/s\\/$/, () => loadLti(location.hash, location.origin, fetch.bind(globalThis))]");
ok(entry > view.indexOf("export const LOADERS") && entry < view.indexOf("const folderOf = "), "view.ts: the lti entry is in LOADERS, above folderOf");
const re = /^\/s\/$/;
ok(re.test("/s/") && !re.test("/s") && !re.test("/s/lti") && !re.test("/s/abcdefghijkl"), "its path is /s/ exactly, never a share's");

console.log(`${checks - fails.length}/${checks} passed`);
process.exit(fails.length ? 1 : 0);
