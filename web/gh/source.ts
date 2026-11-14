// A public GitHub repository as a shared collection's source (the share page's view, web/share-client/view.ts): the
// address parsed, the ref pinned to one commit, the repository listed with each file's git blob id, and each file read
// from raw.githubusercontent.com at that commit, by the reader's own browser. Nothing goes through Sagebrush's servers
// and nothing is stored there.
//
// Two calls on GitHub's unauthenticated API per open (its limit is about 60 an hour for the reader's network): the
// commit the ref names, then that commit's tree. When the API answers that the limit is used up, the listing comes
// from jsDelivr instead (each file's SHA-256), at the ref, which it may keep for up to 12 hours: the page says so.
// Every file is checked against its listing when the interpreter first reads it (web/shims/fs.ts): bytes that differ
// stop the read.

export type GhAddress = { owner: string; repo: string; kind: "blob" | "tree"; ref: string; path: string };
export type GhFile = { path: string; size: number; sha256?: string; gitSha1?: string; url: string };
export type GhListing = {
  owner: string; repo: string; ref: string;
  /** the 40-hex commit everything is read at; null when the listing came from jsDelivr at the ref */
  commit: string | null;
  files: GhFile[];
  /** paths not mounted, each with why: a submodule, a link, a file over the size cap */
  skipped: { path: string; why: string }[];
  /** the listing came from jsDelivr: it may be up to 12 hours behind GitHub */
  viaJsdelivr: boolean;
  /** GitHub cut the tree short (a very large repository): some files aren't listed */
  partial: boolean;
};
export class GhError extends Error {
  constructor(message: string, public code: "address" | "notfound" | "ratelimited" | "network") { super(message); }
}

const API = "https://api.github.com", RAW = "https://raw.githubusercontent.com", JSD = "https://data.jsdelivr.com/v1/packages/gh";
/** A file over this isn't mounted */
export const FILE_MAX = 64 * 1024 * 1024;

// (GitHub's own name rules: an owner is 1-39 letters, digits and single hyphens, not at either end; a repository
// 1-100 letters, digits, . _ -, never "." or "..")
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;
// (a path or ref segment: not empty, not . or .., no backslash, no control character)
const segOk = (s: string) => s !== "" && s !== "." && s !== ".." && !/[\\\u0000-\u001f\u007f]/.test(s);

const ADDRESS = "That isn't a GitHub file or folder address.";

/** The address in a /gh/... path (what follows "/gh/"), or a github.com or raw.githubusercontent.com URL pasted as-is. */
export function parseGh(rest: string): GhAddress {
  let s = rest.replace(/^\/+/, "");
  // (a pasted URL, with or without its scheme, or with the one slash a path makes of "//")
  const pasted = /^(?:https?:\/{1,2})?(github\.com|raw\.githubusercontent\.com)\/(.*)$/i.exec(s);
  let raw = false;
  if (pasted) { raw = /^raw\./i.test(pasted[1]); s = pasted[2]; }
  s = s.replace(/[?#].*$/, "").replace(/\/+$/, "");
  let segs: string[];
  try { segs = s.split("/").map((x) => decodeURIComponent(x)); } catch { throw new GhError(ADDRESS, "address"); }
  const [owner, repo0, ...more] = segs;
  const repo = (repo0 ?? "").replace(/\.git$/, "");
  if (!owner || !OWNER.test(owner) || !REPO.test(repo) || repo === "." || repo === "..") throw new GhError(ADDRESS, "address");
  if (!more.every(segOk)) throw new GhError(ADDRESS, "address");
  // (raw.githubusercontent.com/<o>/<r>/<ref>/<path>: a file)
  if (raw) {
    if (more.length < 2) throw new GhError(ADDRESS, "address");
    return { owner, repo, kind: "blob", ref: more[0], path: more.slice(1).join("/") };
  }
  if (more.length === 0) return { owner, repo, kind: "tree", ref: "HEAD", path: "" };
  const [what, ref, ...path] = more;
  if (!ref || !/^(blob|tree|raw)$/.test(what)) throw new GhError(ADDRESS, "address");
  if (what !== "tree" && path.length === 0) throw new GhError(ADDRESS, "address");
  return { owner, repo, kind: what === "tree" ? "tree" : "blob", ref, path: path.join("/") };
}

/** The /gh/ address of a file or a folder at a ref (what the page links to). */
export const ghPath = (a: { owner: string; repo: string; kind: "blob" | "tree"; ref: string; path: string }) =>
  `/gh/${a.owner}/${a.repo}/${a.kind}/${[a.ref, ...(a.path ? a.path.split("/") : [])].map(encodeURIComponent).join("/")}`;

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
const rawUrl = (o: string, r: string, at: string, path: string) => `${RAW}/${o}/${r}/${[at, ...path.split("/")].map(encodeURIComponent).join("/")}`;
const resetAt = (r: Response) => { const t = Number(r.headers.get("x-ratelimit-reset")); return Number.isFinite(t) && t > 0 ? new Date(t * 1000) : null; };
const limited = (r: Response) => (r.status === 403 || r.status === 429) && r.headers.get("x-ratelimit-remaining") === "0";
const hm = (d: Date) => d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

/** Why GitHub's answer isn't a listing, as the page says it. */
function refusal(r: Response, what: string): GhError {
  if (limited(r)) {
    const at = resetAt(r);
    return new GhError(`GitHub's limit for your network is used up${at ? ` until ${hm(at)}` : ""}. Try again then.`, "ratelimited");
  }
  if (r.status === 404 || r.status === 422) return new GhError(`Not found on GitHub: ${what}. If the repository is private, Sagebrush can't open it yet.`, "notfound");
  return new GhError(`GitHub answered ${r.status} for ${what}.`, "network");
}

async function get(fetch: Fetch, url: string, accept: string): Promise<Response> {
  try {
    return await fetch(url, { headers: { Accept: accept }, credentials: "omit", referrerPolicy: "no-referrer" });
  } catch {
    throw new GhError("Couldn't reach GitHub. Check your connection and reload.", "network");
  }
}

/** The repository's files at the ref: pinned to its commit and listed by GitHub; or, when GitHub's limit is used up,
 * listed by jsDelivr at the ref. `fetch` is the page's (a test's stand-in in tests). */
export async function listGh(a: GhAddress, fetch: Fetch = globalThis.fetch.bind(globalThis)): Promise<GhListing> {
  let { owner, repo } = a;
  const what = `${owner}/${repo}${a.ref === "HEAD" ? "" : ` at ${a.ref}`}`;
  // (1) the commit the ref names; a 40-hex ref is one already
  let commit: string;
  if (/^[0-9a-f]{40}$/.test(a.ref)) commit = a.ref;
  else {
    const r = await get(fetch, `${API}/repos/${owner}/${repo}/commits/${encodeURIComponent(a.ref)}`, "application/vnd.github.sha");
    if (limited(r)) return listJsdelivr(a, fetch, refusal(r, what));
    if (!r.ok) throw refusal(r, what);
    // (a renamed repository: GitHub redirects the API call; every URL after it uses the name it redirected to, since the
    // runner fetches no redirect)
    const moved = /^https:\/\/api\.github\.com\/repos\/([^/]+)\/([^/]+)\//.exec(r.url ?? "");
    if (moved && OWNER.test(moved[1]) && REPO.test(moved[2])) [owner, repo] = [moved[1], moved[2]];
    commit = (await r.text()).trim();
    if (!/^[0-9a-f]{40}$/.test(commit)) throw new GhError(`GitHub's answer for ${what} isn't a commit.`, "network");
  }
  // (2) that commit's tree: every path with its size and git blob id
  const r = await get(fetch, `${API}/repos/${owner}/${repo}/git/trees/${commit}?recursive=1`, "application/vnd.github+json");
  if (limited(r)) return listJsdelivr(a, fetch, refusal(r, what));
  if (!r.ok) throw refusal(r, what);
  const tree = (await r.json()) as { tree?: { path: string; mode: string; type: string; sha: string; size?: number }[]; truncated?: boolean };
  const files: GhFile[] = [], skipped: GhListing["skipped"] = [];
  for (const e of tree.tree ?? []) {
    if (typeof e?.path !== "string" || !e.path.split("/").every(segOk)) continue;
    if (e.type === "commit") { skipped.push({ path: e.path, why: "a submodule: not opened" }); continue; }
    if (e.type !== "blob") continue;
    if (e.mode === "120000") { skipped.push({ path: e.path, why: "a link: not followed" }); continue; }
    if (!/^[0-9a-f]{40}$/.test(e.sha) || !Number.isSafeInteger(e.size)) continue;
    if (e.size! > FILE_MAX) { skipped.push({ path: e.path, why: "too large to open here" }); continue; }
    files.push({ path: e.path, size: e.size!, gitSha1: e.sha, url: rawUrl(owner, repo, commit, e.path) });
  }
  return { owner, repo, ref: a.ref, commit, files, skipped, viaJsdelivr: false, partial: !!tree.truncated };
}

const b64hex = (b: string) => { try { return [...atob(b)].map((c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join(""); } catch { return ""; } };

/** The jsDelivr listing at the ref, each file's SHA-256 and size; the bytes still from raw, at the ref, checked against
 * it (a file that differs, raw having moved on, stops the read). `why` is GitHub's refusal, said if jsDelivr can't
 * list it either. */
async function listJsdelivr(a: GhAddress, fetch: Fetch, why: GhError): Promise<GhListing> {
  let r: Response;
  try {
    r = await fetch(`${JSD}/${a.owner}/${a.repo}@${encodeURIComponent(a.ref)}?structure=flat`, { credentials: "omit", referrerPolicy: "no-referrer" });
  } catch {
    throw why;
  }
  if (!r.ok) throw why;
  const d = (await r.json()) as { files?: { name: string; hash: string; size: number }[] };
  const files: GhFile[] = [], skipped: GhListing["skipped"] = [];
  for (const f of d.files ?? []) {
    const path = typeof f?.name === "string" ? f.name.replace(/^\//, "") : "";
    const sha256 = b64hex(f?.hash ?? "");
    if (!path || !path.split("/").every(segOk) || !/^[0-9a-f]{64}$/.test(sha256) || !Number.isSafeInteger(f.size)) continue;
    if (f.size > FILE_MAX) { skipped.push({ path, why: "too large to open here" }); continue; }
    files.push({ path, size: f.size, sha256, url: rawUrl(a.owner, a.repo, a.ref, path) });
  }
  return { owner: a.owner, repo: a.repo, ref: a.ref, commit: null, files, skipped, viaJsdelivr: true, partial: false };
}
