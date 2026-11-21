// ci: web-runner order=172 runner=bun
// A public GitHub repository as a shared collection's source (web/gh/source.ts), without a network: the addresses it
// reads, the commit and tree it asks GitHub for, what it lists and leaves out, its fallback to jsDelivr when GitHub's
// limit is used up, and what it says when neither can list; and git's blob id (src/runtime/sha1.ts), which every
// mounted file is checked against.
//   bun web/gh/test-gh-source.mjs
import { createHash } from "node:crypto";
import { parseGh, ghPath, listGh, GhError, FILE_MAX } from "./source.ts";
import { sha1Hex, gitBlobSha1 } from "../../src/runtime/sha1.ts";

let failures = 0;
const ok = (c, msg, detail) => { console.log((c ? "ok   " : "FAIL ") + msg + (c || detail === undefined ? "" : " " + JSON.stringify(detail).slice(0, 400))); if (!c) failures++; };
const throws = (f) => { try { f(); return null; } catch (e) { return e; } };

// ---- git's blob id: SHA-1, as node's, at every length a block boundary can fall on; and git's own known answer
let same = true;
for (let n = 0; n < 300; n++) { const b = new Uint8Array(n).map((_, i) => (i * 131 + n * 7) & 255); if (sha1Hex(b) !== createHash("sha1").update(b).digest("hex")) { same = false; break; } }
ok(same, "SHA-1 equals node's at every length 0..299");
ok(sha1Hex(new TextEncoder().encode("abc")) === "a9993e364706816aba3e25717850c26c9cd0d89d", "SHA-1 of \"abc\" (FIPS 180's example)");
ok(gitBlobSha1(new TextEncoder().encode("hello\n")) === "ce013625030ba8dba906f756967f9e9ca394464a", "git's blob id of \"hello\\n\" (what `git hash-object` gives)");
ok(gitBlobSha1(new Uint8Array(0)) === "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391", "git's blob id of an empty file");

// ---- addresses
const A = (s) => { try { return parseGh(s); } catch (e) { return e; } };
ok(JSON.stringify(A("o-1/r.x/blob/main/a/b.ipynb")) === JSON.stringify({ owner: "o-1", repo: "r.x", kind: "blob", ref: "main", path: "a/b.ipynb" }), "a blob: owner, repo, ref and path");
ok(JSON.stringify(A("o/r/tree/main/nb")) === JSON.stringify({ owner: "o", repo: "r", kind: "tree", ref: "main", path: "nb" }), "a tree: its folder");
ok(JSON.stringify(A("o/r")) === JSON.stringify({ owner: "o", repo: "r", kind: "tree", ref: "HEAD", path: "" }), "a repository alone: its default branch's root");
ok(JSON.stringify(A("o/r/raw/v1/x.csv")) === JSON.stringify({ owner: "o", repo: "r", kind: "blob", ref: "v1", path: "x.csv" }), "raw/ is a file");
ok(A("https://github.com/o/r/blob/main/n.ipynb").path === "n.ipynb" && A("https:/github.com/o/r/blob/main/n.ipynb").path === "n.ipynb" && A("github.com/o/r/tree/main").kind === "tree", "a github.com address pasted as it is (with its scheme, with the one slash a path keeps, or none)");
ok(JSON.stringify(A("https://raw.githubusercontent.com/o/r/abc/d/e.txt")) === JSON.stringify({ owner: "o", repo: "r", kind: "blob", ref: "abc", path: "d/e.txt" }), "a raw.githubusercontent.com address: ref then path");
ok(A("o/r.git/blob/main/x").repo === "r" && A("o/r/blob/main/x?plain=1#L3").path === "x", "a .git suffix, a query and a fragment are dropped");
ok(A("o/r/blob/main/a%20b/c%2Bd.py").path === "a b/c+d.py", "segments are URL-decoded once");
for (const bad of ["", "o", "-o/r", "o-/r", "o--x/r", "o/r/blob/main", "o/r/blame/main/x", "o/r/blob/main/../x", "o/r/blob/main/a//b", "o/r/blob/main/a\\b", "o/r/tree/main/%00", "o/./tree/main", "o/r/blob/main/%E0%A4%A"])
  ok(A(bad) instanceof GhError && A(bad).code === "address", `refused: ${JSON.stringify(bad)}`);
ok(ghPath({ owner: "o", repo: "r", kind: "blob", ref: "main", path: "a b/c.ipynb" }) === "/gh/o/r/blob/main/a%20b/c.ipynb" && ghPath({ owner: "o", repo: "r", kind: "tree", ref: "v1", path: "" }) === "/gh/o/r/tree/v1", "the /gh/ address of a file and of a root folder");

// ---- listing, through a stand-in for GitHub and jsDelivr
const C = "0123456789abcdef0123456789abcdef01234567";
const sha = (s) => gitBlobSha1(new TextEncoder().encode(s));
const TREE = { truncated: false, tree: [
  { path: "nb", mode: "040000", type: "tree", sha: "f".repeat(40) },
  { path: "nb/a.ipynb", mode: "100644", type: "blob", sha: sha("{}"), size: 2 },
  { path: "nb/data.txt", mode: "100644", type: "blob", sha: sha("42\n"), size: 3 },
  { path: "nb/link", mode: "120000", type: "blob", sha: sha("data.txt"), size: 8 },
  { path: "vendor/lib", mode: "160000", type: "commit", sha: "e".repeat(40) },
  { path: "big.bin", mode: "100644", type: "blob", sha: "d".repeat(40), size: FILE_MAX + 1 },
  { path: "../evil", mode: "100644", type: "blob", sha: "c".repeat(40), size: 1 },
  { path: "nb/odd-id.txt", mode: "100644", type: "blob", sha: "not-a-blob-id", size: 1 },
] };
const res = (status, body, headers = {}, url = "") => { const r = new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers }); Object.defineProperty(r, "url", { value: url }); return r; };
function stand(routes) {
  const asked = [];
  const f = async (url, init) => { asked.push([url, init?.headers?.Accept ?? null, init?.credentials ?? null]); for (const [re, r] of routes) if (re.test(url)) return r(); return res(404, "not found"); };
  return { f, asked };
}
{
  const s = stand([[/\/commits\/main$/, () => res(200, C + "\n", {}, "https://api.github.com/repos/o/r/commits/main")], [/\/git\/trees\//, () => res(200, TREE)]]);
  const l = await listGh(A("o/r/tree/main/nb"), s.f);
  ok(l.commit === C && !l.viaJsdelivr && l.files.map((f) => f.path).join() === "nb/a.ipynb,nb/data.txt", "the commit the ref names, then its tree: the two files", l.files.map((f) => f.path));
  ok(s.asked.length === 2 && s.asked[0][0] === "https://api.github.com/repos/o/r/commits/main" && s.asked[0][1] === "application/vnd.github.sha" && s.asked[1][0] === `https://api.github.com/repos/o/r/git/trees/${C}?recursive=1` && s.asked.every((a) => a[2] === "omit"), "two calls on GitHub's API: the commit (as its SHA alone), then its tree, recursively; no credentials", s.asked);
  const d = l.files.find((f) => f.path === "nb/data.txt");
  ok(d.gitSha1 === sha("42\n") && d.size === 3 && !d.sha256 && d.url === `https://raw.githubusercontent.com/o/r/${C}/nb/data.txt`, "each file: its git blob id and size, read from raw at the commit (never the branch)");
  ok(JSON.stringify(l.skipped.map((x) => x.path).sort()) === JSON.stringify(["big.bin", "nb/link", "vendor/lib"]), "a link, a submodule and a file over the cap are listed as not opened; a path with .. or a malformed blob id isn't listed at all", l.skipped);
}
{
  const s = stand([[/\/git\/trees\//, () => res(200, TREE)]]);
  const l = await listGh(A(`o/r/tree/${C}/nb`), s.f);
  ok(l.commit === C && s.asked.length === 1, "a 40-hex ref is the commit already: one call");
}
{
  // (a renamed repository: the API redirected; every URL after it uses the new name, the runner fetching no redirect)
  const s = stand([[/\/commits\/main$/, () => res(200, C, {}, "https://api.github.com/repos/o2/r2/commits/main")], [/o2\/r2\/git\/trees\//, () => res(200, TREE)]]);
  const l = await listGh(A("o/r/tree/main"), s.f);
  ok(l.owner === "o2" && l.repo === "r2" && l.files[0].url.startsWith(`https://raw.githubusercontent.com/o2/r2/${C}/`), "a renamed repository: the name GitHub redirected to, in every URL", [l.owner, l.repo]);
}
{
  const l = await listGh(A("o/r/tree/main"), stand([]).f).catch((e) => e);
  ok(l instanceof GhError && l.code === "notfound" && /^Not found on GitHub: o\/r at main\. If the repository is private, Sagebrush can't open it yet\.$/.test(l.message), "not found (or private): said so, in one line", l.message);
}
{
  const reset = Math.floor(Date.UTC(2026, 10, 14, 18, 42) / 1000);
  const lim = () => res(403, "{}", { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) });
  const flat = { files: [{ name: "/nb/a.ipynb", hash: Buffer.from(createHash("sha256").update("{}").digest()).toString("base64"), size: 2 }, { name: "/../x", hash: "AA==", size: 1 }] };
  const s = stand([[/\/commits\//, () => lim()], [/data\.jsdelivr\.com\/v1\/packages\/gh\/o\/r@main\?structure=flat$/, () => res(200, flat)]]);
  const l = await listGh(A("o/r/tree/main"), s.f);
  ok(l.viaJsdelivr && l.commit === null && l.files.length === 1 && l.files[0].sha256 === createHash("sha256").update("{}").digest("hex") && !l.files[0].gitSha1 && l.files[0].url === "https://raw.githubusercontent.com/o/r/main/nb/a.ipynb", "GitHub's limit used up: jsDelivr's listing at the ref (SHA-256), the bytes still from raw at the ref", l.files);
  const s2 = stand([[/\/commits\//, () => lim()]]);
  const e = await listGh(A("o/r/tree/main"), s2.f).catch((x) => x);
  ok(e instanceof GhError && e.code === "ratelimited" && /^GitHub's limit for your network is used up until .+\. Try again then\.$/.test(e.message), "jsDelivr can't list it either: GitHub's limit and when it resets", e.message);
  const s3 = stand([[/\/commits\//, () => res(200, C, {}, "https://api.github.com/repos/o/r/commits/main")], [/\/git\/trees\//, () => lim()], [/jsdelivr/, () => res(200, flat)]]);
  ok((await listGh(A("o/r/tree/main"), s3.f)).viaJsdelivr, "the limit reached at the tree call: jsDelivr too");
  const s4 = stand([[/\/commits\//, () => res(403, "{}", { "x-ratelimit-remaining": "12" })]]);
  const e4 = await listGh(A("o/r/tree/main"), s4.f).catch((x) => x);
  ok(e4 instanceof GhError && e4.code === "network" && s4.asked.length === 1, "another 403 (not the limit) is said as it is, with no fallback", e4.message);
}
{
  const e = await listGh(A("o/r/tree/main"), async () => { throw new TypeError("Failed to fetch"); }).catch((x) => x);
  ok(e instanceof GhError && e.code === "network" && /^Couldn't reach GitHub/.test(e.message), "no network: \"Couldn't reach GitHub\"");
  const s = stand([[/\/commits\//, () => res(200, "<html>", {}, "https://api.github.com/repos/o/r/commits/main")]]);
  const e2 = await listGh(A("o/r/tree/main"), s.f).catch((x) => x);
  ok(e2 instanceof GhError && /isn't a commit/.test(e2.message), "an answer that isn't a 40-hex commit is refused");
}
console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
