// An agent's branch (chat plan PR 3, packet r4e): workspace.git_branch {name} copies main (every entry the grant lets
// the agent read, but /Branches, /Trash and /Proposals) into /Branches/<name>/, a folder only that grant's agent may
// change, and keeps the base hash of each copy for the later PRs' evidence.  No git store yet.
//
// One branch is made at a time in this browser profile: the run holds the Web Lock BRANCH_LOCK throughout, and so
// does the reconcile, which therefore never sees a live run's `making` record.  In order:
//   1. reconcile (records whose root left /Branches/<name> released; a `making` one of a run that ended, failed);
//   2. capture: the entries, their identity and revision, their logical sizes; the limits checked;
//   3. the root and its reservation made together (makeBranchRoot), or nothing made;
//   4. each entry copied (copyForBranch: rechecked holding the workspace's lock right before it is written);
//   5. published (publishBranch): ready, with the hashes' pages, in one transaction, if the root is still its own.
// A failure after 3 leaves the partial in place, `failed`, still charged, read-only to every agent, until the person
// removes it (the workspace has no hard delete).

import { BRANCHES, BRANCH_LIMITS, BRANCH_TEXT as T, BranchStop, branchCopy, hashPages, type BranchSource } from "./branch-rules";
import { within, normPath, type Kind } from "./paths";

export const BRANCH_LOCK = "sagebrush-git-branch";
/** What main isn't: never copied into a branch. */
const NOT_MAIN = [BRANCHES, "/Trash", "/Proposals"];
/** Tests' hook at named steps of a run (awaited: a test pauses the run there, or closes the tab). */
export const GIT_BRANCH_HOOK: { step?: (s: "captured" | "rooted" | "copied" | "copied-all", i?: number) => void | Promise<void> } = {};

type Listed = { path: string; kind: Kind; created: number; fid?: string; ref?: string | null; rev?: number; sha256?: string; size?: number };
/** What git_branch needs of the workspace: Workspace.branchHost(actor), the host's alone. */
export type BranchHost = {
  list(folder: string): Promise<Listed[]>;
  stat(p: string): Promise<Listed | undefined>;
  read(p: string): Promise<{ entry: Listed; content: unknown; rev: number }>;
  makeBranchRoot(name: string, charge: { owner: string; entries: number; bytes: number }): Promise<{ fid: string } | { refused: "taken" | "branches" | "entries" | "bytes" }>;
  copyForBranch(src: BranchSource, dest: string, root: { fid: string; name: string }, live: () => boolean): Promise<string | null>;
  publishBranch(fid: string, name: string, pages: [string, string][][]): Promise<boolean>;
  failBranch(fid: string, reason: string): Promise<void>;
  reconcileBranches(closed: string): Promise<unknown>;
};
export type GitBranchResult = { branch: string; worktree: string; files: number; bytes: number; next: string };

/** A refusal or failure as the pairing says it (its code, the agent's text). */
const said = (code: "invalid" | "exists" | "limit" | "conflict" | "storage", message: string) => Object.assign(new Error(message), { code });

/** `f` holding the creation lock (BRANCH_LOCK), exclusive across this browser's tabs. */
export function withBranchLock<R>(f: () => Promise<R>): Promise<R> {
  const locks = (globalThis.navigator as any)?.locks;
  if (!locks || typeof locks.request !== "function") return Promise.reject(said("storage", "this browser has no Web Locks, which changes to the workspace need: nothing was changed"));
  return locks.request(BRANCH_LOCK, f);
}

/** The reconcile, whenever the workspace changes here or in another tab, and once now: debounced, one at a time, and
 * never awaited by an op's callback (it only schedules), so a git_branch never waits on it. */
export function watchBranches(ws: { watch(f: () => void): () => void; reconcileBranches(closed: string): Promise<unknown> }): () => void {
  let pending = false, busy: Promise<unknown> | null = null, stopped = false;
  const go = async () => {
    while (busy) await busy;
    pending = false;
    if (stopped) return;
    busy = withBranchLock(() => ws.reconcileBranches(T.closed)).catch(() => {}).finally(() => { busy = null; });
  };
  const schedule = () => { if (pending || stopped) return; pending = true; setTimeout(() => void go(), 200); };
  const off = ws.watch(schedule);
  schedule();
  return () => { stopped = true; off(); };
}

/** What git_branch reads of main: the readable entries in `folders` (the grant's), but what isn't main, with each
 * one's identity, revision and logical size (a document read for it).  Refused, nothing made, over the entries'
 * limit (before any document is read), or if a copy's path couldn't be made (the workspace's own reason). */
async function capture(host: BranchHost, folders: string[], name: string): Promise<BranchSource[]> {
  const seen = new Map<string, Listed>();
  const inMain = (p: string) => p !== "/" && !NOT_MAIN.some((x) => within(p, x));
  for (const f of folders.includes("/") ? ["/"] : folders) {
    if (f !== "/") {
      if (!inMain(f)) continue;
      const e = await host.stat(f);
      if (!e) continue;
      seen.set(e.path, e);
      if (e.kind !== "folder") continue;
    }
    for (const e of await host.list(f)) if (inMain(e.path)) seen.set(e.path, e);
    if (seen.size > BRANCH_LIMITS.entries) throw said("limit", T.entries);
  }
  const out: BranchSource[] = [];
  for (const e of [...seen.values()].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    try { normPath(BRANCHES + "/" + name + e.path); } catch (err) { throw said("invalid", String((err as Error)?.message ?? err)); }
    if (e.kind === "folder") { out.push({ path: e.path, kind: "folder", created: e.created, fid: e.fid, rev: 0, size: 0 }); continue; }
    if (e.kind === "file") { out.push({ path: e.path, kind: "file", created: e.created, fid: e.fid, rev: e.rev ?? 0, sha256: e.sha256, size: e.size ?? 0 }); continue; }
    const r = await host.read(e.path);
    out.push({ path: r.entry.path, kind: r.entry.kind, created: r.entry.created, fid: r.entry.fid, ref: r.entry.ref, rev: r.rev, size: branchCopy(r.entry.kind as "notebook" | "board", r.content).size });
  }
  return out;
}

/** git_branch: the branch `name` made for the grant whose id is `owner`, from the folders it may read, while `live()`
 * (that grant, still in force).  Refusals and failures are errors with a code and the agent's text. */
export function gitBranch(host: BranchHost, a: { name: string; owner: string; folders: string[]; live: () => boolean }): Promise<GitBranchResult> {
  const { name } = a;
  const step = async (s: Parameters<NonNullable<typeof GIT_BRANCH_HOOK.step>>[0], i?: number) => { await GIT_BRANCH_HOOK.step?.(s, i); };
  const rel = (p: string) => p.slice(1);
  return withBranchLock(async () => {
    await host.reconcileBranches(T.closed);
    const all = await capture(host, a.folders, name);
    const folders = all.filter((s) => s.kind === "folder").map((s) => rel(s.path));
    const bytes = all.reduce((n, s) => n + s.size, 0);
    if (bytes > BRANCH_LIMITS.bytes) throw said("limit", T.bytes);
    // (the hashes' pages laid out now, exactly: every hash is 64 characters)
    const fill = "0".repeat(64);
    if (!hashPages(all.filter((s) => s.kind !== "folder").map((s) => [rel(s.path), fill] as [string, string]), BRANCH_LIMITS, folders)) throw said("limit", T.hashBytes);
    await step("captured");
    if (!a.live()) throw said("invalid", T.grantChanged);
    const made = await host.makeBranchRoot(name, { owner: a.owner, entries: all.length, bytes });
    if ("refused" in made) throw made.refused === "taken" ? said("exists", T.taken(name)) : said("limit", T[made.refused]);
    const { fid } = made, root = BRANCHES + "/" + name;
    await step("rooted");
    const fail = async (reason: string, text: string): Promise<never> => {
      await host.failBranch(fid, reason);
      throw said("conflict", text);
    };
    const MOVED = "its folder in /Branches was moved, removed or replaced during the copy";
    const hashes: [string, string][] = [];
    try {
      for (let i = 0; i < all.length; i++) {
        const h = await host.copyForBranch(all[i], root + all[i].path, { fid, name }, a.live);
        if (h !== null) hashes.push([rel(all[i].path), h]);
        await step("copied", i);
      }
    } catch (e) {
      if (e instanceof BranchStop && e.why === "moved") return fail(MOVED, T.moved);
      const reason = e instanceof BranchStop ? (e.why === "grant" ? T.grantChanged : T.changed(e.at ?? "")) : String((e as Error)?.message ?? e).slice(0, 200);
      return fail(reason, T.failed(reason, name));
    }
    await step("copied-all");
    const pages = hashPages(hashes, BRANCH_LIMITS, folders);
    if (!pages) return fail(T.hashBytes, T.failed(T.hashBytes, name));
    if (!(await host.publishBranch(fid, name, pages))) return fail(MOVED, T.moved);
    return { branch: `agent/${name}`, worktree: root + "/", files: hashes.length, bytes, next: T.next(name) };
  });
}
