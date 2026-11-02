// "Push project to GitHub" (Stage A MVP r1 §1, frozen 460432c6): the rules shared by the panel (panel.ts), the
// collection (collect.ts) and the git worker (git-worker.ts). Pure, so the node tests run them (test/gitpush-rules.test.ts).

/** A data file larger than this isn't pushed (GitHub refuses a file over 100 MB): it's listed, and a version pushed
 * before stays in the branch. */
export const MAX_FILE = 50 * 2 ** 20;
/** At most this many bytes of changed files go in one push: the proxy takes 100 MiB a request (web/gitpush/worker.mjs),
 * so a larger first push goes as several commits, each pushed in turn. */
export const PUSH_BATCH = 80 * 2 ** 20;
/** The automatic push: every 10 minutes when something changed (M3). */
export const AUTO_MS = 10 * 60_000;
/** (M4b) A branch name to copy from: git's rules as git check-ref-format holds them, for the names a person types
 * (ASCII letters, digits, ".", "_", "-" and "/"; no "..", "//", segment starting with "." or ending with ".lock",
 * and no "/" at either end). */
export const GIT_BRANCH = /^(?!.*\.\.)(?!.*\/\/)(?!\/)(?!.*\/$)(?!.*(^|\/)\.)(?!.*\.lock(\/|$))(?!.*\.$)[A-Za-z0-9._\/-]{1,100}$/;
/** At most this many files in a copied branch (Upload's own count). */
export const COPY_FILES = 10_000;
/** Pushes go only to branches named so: never main, never anything the person didn't make here. */
export const BRANCH = /^sagebrush\/[a-z0-9][a-z0-9._-]{0,59}$/;
const SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,99}$/;

/** `{owner, repo, url}` for a GitHub repository address (https://github.com/owner/repo, with or without .git or a
 * final slash), or null. */
export function parseRepo(s: string): { owner: string; repo: string; url: string } | null {
  const m = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(s.trim());
  if (!m || !SEGMENT.test(m[1]) || !SEGMENT.test(m[2])) return null;
  return { owner: m[1], repo: m[2], url: `https://github.com/${m[1]}/${m[2]}.git` };
}

/** The branch a folder pushes to: sagebrush/<its name, made safe>, or sagebrush/workspace for the whole workspace. */
export function branchFor(folder: string): string {
  const name = folder.replace(/\/+$/, "").split("/").pop() || "workspace";
  const slug = name.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[-._]+/, "").slice(0, 60).replace(/[-._]+$/, "");
  return "sagebrush/" + (slug || "workspace");
}

// (git's verify_path: is_hfs_dotgit, is_ntfs_dotgit, is_ntfs_dotgitmodules)
const HFS_IGNORABLE = /[‌-‏‪-‮⁪-⁯﻿]/g;
/** A name a git repository can't hold: .git or .gitmodules in any case, with HFS's ignorable characters, NTFS's
 * trailing dots and spaces, an NTFS stream suffix, or a short name (git~1, gitmod~N). */
export function gitUnsafe(name: string): boolean {
  if (name === "" || name === "." || name === "..") return true;
  const hfs = name.replace(HFS_IGNORABLE, "").toLowerCase();
  const ntfs = name.toLowerCase().split(":")[0].replace(/[. ]+$/, "");
  return [hfs, ntfs].some((n) => n === ".git" || n === ".gitmodules" || n === "git~1" || /^gitmod~\d$/.test(n));
}

/** Why a path (relative to the pushed folder) is never pushed, or null: control metadata (.sagebrush, data
 * snapshots .sagebrush-data) and names git can't hold, in any segment. */
export function excluded(rel: string): string | null {
  for (const seg of rel.split("/")) {
    if (seg === ".sagebrush" || seg === ".sagebrush-data") return "Sagebrush's own data";
    if (gitUnsafe(seg)) return "a name a git repository can't hold";
  }
  return null;
}

/** A notebook document with every output, execution count and run time removed: outputs never enter a commit. */
export function stripOutputs(doc: any): any {
  return { ...doc, cells: (doc.cells ?? []).map((c: any) => (c.type === "markdown" || c.type === "raw" ? c : { ...c, outputs: [], n: null, ms: undefined })) };
}

/** A data file's signature: its hash, size and revision. Equal to the one last pushed, its bytes aren't read again.
 * Documents have none: they are always read (and the worker writes only what differs). */
export function signature(e: { kind: string; rev?: number; sha256?: string; size?: number }): string | null {
  return e.kind === "file" && e.sha256 ? `${e.sha256}:${e.size ?? ""}:${e.rev ?? ""}` : null;
}

/** The words for a failed push: fixed, never a message from GitHub or the network (they could carry a header). */
export function pushWords(err: { code?: string; data?: { statusCode?: number } } | undefined, branch: string, repo: string): string {
  const code = err?.code, status = err?.data?.statusCode;
  if (code === "PushRejectedError") return `GitHub's ${branch} has commits this browser doesn't have. Nothing was overwritten.`;
  if (status === 401 || status === 403) return `GitHub refused the token (${status}). Check it is for ${repo}, with Contents: Read and write, and not expired.`;
  if (status === 404) return `GitHub says ${repo} doesn't exist, or the token can't see it (404).`;
  if (status === 413) return "This push is larger than the proxy takes (100 MB).";
  if (status === 429) return "Too many pushes for now: try again in a minute.";
  if (typeof status === "number") return `The push failed (${status}).`;
  return "Couldn't reach GitHub through the push proxy.";
}

/** The words for a failed fetch (M4b's copy): fixed, as pushWords. */
export function fetchWords(err: { code?: string; data?: { statusCode?: number } } | undefined, branch: string, repo: string): string {
  if (err?.code === "NotFoundError") return `${repo} has no branch ${branch}.`;
  if (err?.code === "PushRejectedError") return "The copy failed.";
  return pushWords(err, branch, repo).replace("The push failed", "The copy failed");
}
