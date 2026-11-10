// An agent's branch (chat plan PR 3, packet r4e): git_branch copies main into /Branches/<name>/, a folder of the
// person's workspace that the agent which made it (its grant's id) may change, and no other agent.  What the host
// keeps of it is a record in the workspace's meta store, keyed by its root folder's fid, never by its name:
//
//   agent-branch:<fid>          {name, owner, status, entries, bytes, made, reason?}
//   agent-branch-h:<fid>:<k>    the base hashes, [relPath, sha256][], whole entries, each page at most PAGE_BYTES
//
// The records are the host's alone: never in an agent's entry data, never offered by forAgent.  This module holds
// what both the workspace (api.ts) and the pairing need: the limits, the agent-facing texts, the ownership rule an
// agent's change passes (branchRefusal, asked by the workspace holding its lock), and the form of what is copied
// and hashed.

import { nameOf, within, type Kind } from "./paths";

export const BRANCHES = "/Branches";
/** A branch's name: the agent's choice, for what the work is about. */
export const BRANCH_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
/** git_branch's creation-copy limits (not lifetime quotas: later edits in a branch follow the workspace's own).
 * `branches` counts every record, making, ready and failed; `hashBytes` bounds the base hashes' pages as stored
 * (their JSON in UTF-8, every page: under it), `pageBytes` each page (at most), and `pathBytes` the copied entries'
 * relative paths, each as JSON in UTF-8 (escapes counted), together (at most): daybreak2's ruling on Option A. */
export const BRANCH_LIMITS = { branches: 16, entries: 2000, bytes: 256 * 2 ** 20, pathBytes: 512 * 2 ** 10, hashBytes: 2 ** 20, pageBytes: 32 * 2 ** 10 };
export const BRANCH_KEY = "agent-branch:";
export const BRANCH_HASH_KEY = "agent-branch-h:";

export type BranchStatus = "making" | "ready" | "failed";
export type BranchRecord = { name: string; owner: string; status: BranchStatus; entries: number; bytes: number; made: number; reason?: string };

/** An entry git_branch captured (git-branch.ts): its identity and revision, and its logical size. */
export type BranchSource = { path: string; kind: Kind; created: number; fid?: string; ref?: string | null; rev: number; sha256?: string; size: number };
/** Why a branch's copy stopped (Workspace.copyForBranch): the grant changed, a source changed (`at`), or the
 * branch's root moved. */
export class BranchStop extends Error {
  constructor(readonly why: "grant" | "changed" | "moved", readonly at?: string) { super(why); }
}

/** What the agent is told (board's COPY, packet r2–r4e), word for word. */
export const BRANCH_TEXT = {
  badName: "a branch name is 1 to 40 of a-z, 0-9 and -, starting with a letter or digit",
  taken: (name: string) => `the name "${name}" is taken: pick another name for git_branch`,
  readOnly: "the grant is read only: ask the person to allow changes",
  notInGrant: "branches go in /Branches, which your grant doesn't include: ask the person to allow it, or work in the folders you have",
  branches: `this workspace has ${BRANCH_LIMITS.branches} branches, the most it holds: ask the person to remove one, or work in the folders you have`,
  entries: "main has more than 2,000 entries, the most git_branch copies: work in the folders you have",
  bytes: "main's files come to more than 256 MiB, the most git_branch copies: work in the folders you have",
  hashBytes: "main's paths are too long in total for git_branch to copy: work in the folders you have",
  failed: (reason: string, name: string) => `the branch couldn't be made (${reason}): what was copied stays in ${BRANCHES}/${name} until the person removes it; try another name, or work in the folders you have`,
  moved: "the branch couldn't be made: its folder in /Branches was moved, removed or replaced during the copy; make a new one with git_branch",
  grantChanged: "your grant changed during the copy",
  changed: (p: string) => `${p} changed while it was being copied`,
  closed: "the page closed during the copy",
  unfinished: "this branch wasn't finished, so it can't be changed: make a new one with git_branch under another name",
  otherConnection: "this branch was made under another connection: ask the person to remove it, or make a new one with git_branch",
  onlyGitBranch: "only git_branch makes a folder in /Branches",
  persons: "a branch's folder is the person's to remove or move: work inside it",
  notYours: "this folder in /Branches isn't a branch you made: make a new one with git_branch",
  next: (name: string) => `Work in ${BRANCHES}/${name}/: changes there leave the rest of the workspace as it is. Its notebooks start with file changes off, like any notebook an agent makes.`,
} as const;

/** What the workspace found for a path in /Branches (AdmitCheck's `branch`), read in the same transaction as the
 * entry: the branch's root folder there now (`/Branches/<x>`; absent: nothing there), and its record, only if the
 * record is that folder's (by fid) and names it (a folder renamed within /Branches is no branch). */
export type BranchAt = { root?: { path: string; kind: Kind; fid?: string }; record?: BranchRecord };

/** The ownership rule (packet r4 P3-2): why an agent's change at `c.path` is refused, or null.  `owner` is the
 * agent's grant's id (null: none, which owns nothing).  Reads follow the grant alone (Q4): a duplicate's source is
 * read, so it passes here.  Outside /Branches nothing is said here: the grant decides, as for any folder. */
export function branchRefusal(c: { op: string; role: string; path: string; entry?: unknown; branch?: BranchAt }, owner: string | null): string | null {
  if (!within(c.path, BRANCHES)) return null;
  if (c.op === "duplicate" && c.role === "source") return null;
  const T = BRANCH_TEXT;
  // (/Branches itself: made by the page, the person's to remove or move)
  if (c.path === BRANCHES) return c.entry === undefined || c.role === "destination" || c.op === "mkdir" || c.op === "create" ? T.onlyGitBranch : T.persons;
  const atRoot = !c.path.slice(BRANCHES.length + 1).includes("/");
  const root = c.branch?.root, rec = c.branch?.record;
  // (making a folder, or anything, at /Branches/<x>: git_branch's alone)
  if (atRoot && (c.entry === undefined || c.role === "destination" || c.op === "mkdir" || c.op === "create" || c.op === "restore")) return T.onlyGitBranch;
  if (!root) return T.onlyGitBranch;
  if (!rec || root.kind !== "folder" || rec.name !== nameOf(root.path)) return T.notYours;
  if (rec.status !== "ready") return T.unfinished;
  if (owner === null || rec.owner !== owner) return T.otherConnection;
  // (its own ready branch: anything inside, never its folder itself)
  return atRoot ? T.persons : null;
}

/** What a branch copy of an entry writes (as Workspace.duplicate copies it: a notebook's document without its id,
 * rev and updated; a board's document; a data file's bytes), its logical size (a data file's bytes; a document's
 * JSON in UTF-8, outputs included), and the text its base hash is of: a data file's bytes; a notebook's cells'
 * kinds and sources (no outputs); a board's JSON. */
export function branchCopy(kind: Exclude<Kind, "folder">, content: any): { content: unknown; size: number; canonical: Uint8Array } {
  const enc = new TextEncoder();
  if (kind === "file") {
    const b = content instanceof Uint8Array ? content : enc.encode(String(content ?? ""));
    return { content: b, size: b.length, canonical: b };
  }
  if (kind === "notebook") {
    const { id: _i, rev: _r, updated: _u, ...doc } = content ?? {};
    const cells = Array.isArray(doc.cells) ? doc.cells : [];
    return { content: doc, size: enc.encode(JSON.stringify(doc)).length, canonical: enc.encode(JSON.stringify({ cells: cells.map((c: any) => ({ type: c?.type ?? "code", code: String(c?.code ?? "") })) })) };
  }
  const json = JSON.stringify(content);
  return { content: structuredClone(content), size: enc.encode(json).length, canonical: enc.encode(json) };
}

/** Bytes as stored: `v`'s JSON in UTF-8 (escapes, non-ASCII and unpaired surrogates as JSON.stringify writes them). */
export const jsonBytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length;

/** The base hashes in pages of whole entries, in path order, each page's JSON at most `pageBytes`; null if the
 * paths together (each's JSON, with `folders`', the copied folders' that have no hash) are over `pathBytes`, an entry alone is over a page, or the pages together reach
 * `hashBytes` (refused at capture, before anything is made; a path is never cut).  Every hash is 64 hex characters,
 * so capture lays the pages out exactly (with any 64 characters) before anything is hashed: a page's JSON is
 * `[` + its entries' JSON joined by `,` + `]`. */
export function hashPages<T extends [string, string]>(entries: T[], limits = BRANCH_LIMITS, folders: string[] = []): T[][] | null {
  const sorted = [...entries].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  let paths = 0;
  for (const e of sorted) paths += jsonBytes(e[0]);
  for (const f of folders) paths += jsonBytes(f);
  if (paths > limits.pathBytes) return null;
  const pages: T[][] = [];
  let page: T[] = [], used = 2, total = 0;
  for (const e of sorted) {
    const n = jsonBytes([e[0], "0".repeat(64)]);
    if (2 + n > limits.pageBytes) return null;
    const more = page.length ? n + 1 : n;
    if (used + more > limits.pageBytes) { pages.push(page); total += used; page = []; used = 2; }
    used += page.length ? n + 1 : n;
    page.push(e);
  }
  if (page.length) { pages.push(page); total += used; }
  return total >= limits.hashBytes ? null : pages;
}
