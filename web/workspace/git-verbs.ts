// An agent's git verbs past git_branch: workspace.git_commit, git_status and git_wait, page verbs like
// git_branch, only in the pages that offer branches.  What they keep:
//
//   - the history: branch-store.ts (one git repository per workspace, refs by the root folder's fid);
//   - the review state: the workspace's meta store, beside git_branch's record (BranchReview, api.ts's branchReview and
//     putBranchReview, compare-and-swap by seq).
//
// Every verb checks, at use: the branch named is a folder in /Branches with its record (as git_branch has it: a renamed root is no
// branch), `ready`, and made by the calling grant (its id); the grant is still in force.  Nothing here lets an agent
// decide or accept: those are the person's (review-actions.ts), never verbs.
//
// A commit (git_commit), in order, holding the Web Lock "sagebrush-branch-commit:<fid>" so commits on one branch
// have one parent chain:
//   1. a pending commit left by a crash is reconciled (its ref moved: finalized; else dropped);
//   2. the worktree's snapshot: every document's canonical bytes (branch-canon.ts) with its identity and revision,
//      then the whole set listed and checked again; anything that changed meanwhile: once more, then refused;
//   3. unchanged from the head: nothing written (and an unchanged commit never clears or moves a decision);
//   4. the objects (branch-store.ts), then the review state with `pending`, then the ref by compare-and-swap, then
//      the review state finalized: the new head, a new seq, the old head's decisions and note cleared;
//   5. the change told to this tab's subscribers and to other tabs (onBranch): a wake-up only, never the state.

import { BRANCHES, BRANCH_NAME, RULE_TEXT, type BranchRecord, type BranchReview, type FileDecision, type ReviewStatus } from "./branch-rules";
import { canonBytes, type Canon } from "./branch-canon";
import { HistoryFull, STORE_LIMITS, diff, openBranchStore, refOf, type BranchStore, type Files, type Full } from "./branch-store";
import type { Kind } from "./paths";
import { badValue, check } from "./agent-schema";
import { grantProblem, type Grant } from "./agent-grant";
import { CHANGED_WHILE_RUNNING, type RunVerbs } from "./agent-pair";
import { PAGE_VERBS } from "./verbs-page";
import { sha256Hex as bytesHash } from "./sha256-hex";
import { onBranch, tellBranch } from "./branch-wake";

type Listed = { path: string; kind: Kind; created: number; fid?: string; ref?: string | null; rev?: number; mode?: string };
/** What the git verbs need of the workspace (Workspace.branchHost, the host's alone). */
export type GitHost = {
  dbName: string;
  list(folder: string): Promise<Listed[]>;
  stat(p: string): Promise<Listed | undefined>;
  read(p: string): Promise<{ entry: Listed; content: unknown; rev: number }>;
  branchAtName(name: string): Promise<{ fid: string; record: BranchRecord } | null>;
  branchReview(fid: string, name: string): Promise<{ record: BranchRecord; review: BranchReview | null } | null>;
  putBranchReview(fid: string, name: string, next: BranchReview, expect: number | null, gate?: { owner: string; live: () => boolean }): Promise<"ok" | "moved" | "stale" | "grant">;
};
/** Who calls: the grant's id (the owner a branch's record names), the actor credited, and whether it's still in force. */
export type Caller = { owner: string; actor: string; live: () => boolean; ended?: Promise<void> };

/** What the agent is told, word for word (board's COPY reviews them); each says what to do next. */
export const GIT_TEXT = {
  badName: "a branch name is 1 to 40 of a-z, 0-9 and -, starting with a letter or digit",
  noBranch: (name: string) => `there's no branch "${name}" in ${BRANCHES} (or its folder was renamed or moved): make one with git_branch`,
  noHistory: "this branch was made before branches kept a history, so it can't be committed: make a new one with git_branch",
  message: `a commit message is 1 to ${STORE_LIMITS.message.toLocaleString("en-US")} characters`,
  commits: `this branch has ${STORE_LIMITS.commits} commits, the most it keeps: make a new branch with git_branch for further work`,
  history: "this workspace's branch history is full: ask the person to remove branches they no longer need",
  changed: "the branch changed while it was being committed (another tab or run is still writing to it): commit again when it's done",
  raced: "another commit on this branch came first: call git_status, then commit again",
  grantChanged: "your grant changed: ask the person to connect you again",
  accepting: "the person is accepting files from this branch right now: call git_status, then commit again",
  acceptedWhole: "the person accepted this branch whole: make a new branch with git_branch for further work",
  seconds: `git_wait's seconds are 1 to ${STORE_LIMITS.waitSeconds}`,
  waits: `you already have ${STORE_LIMITS.waitsPerGrant} git_wait calls waiting: wait for one of them to return`,
  next: {
    review: (name: string) => `The person was asked to review it. Call git_wait {"name": "${name}"} to hear their decision, or git_status.`,
    open: (name: string) => `Committed. When the work is ready, call git_commit {"name": "${name}", "message": …, "review": true} to ask the person to review it.`,
    waiting: (name: string) => `Still waiting for the person: call git_wait {"name": "${name}"} again.`,
  },
} as const;

const said = (code: "invalid" | "missing" | "limit" | "conflict", message: string) => Object.assign(new Error(message), { code });
/** Tests' hook at a commit's boundaries (awaited: a test pauses there, changes the branch, or throws to stand for a
 * page closing there): after the snapshot is taken, after the pending state is written, after the ref moves. */
export const GIT_HOOK: { step?: (s: "taken" | "fits" | "pending" | "ref") => void | Promise<void> } = {};

// ---- the change events (onBranch): branch-wake.ts's, so a chunk without these verbs (the review page's, the runs')
// tells and hears the same ones ------------------------------------------------------------------------------------------

export { onBranch, tellBranch };
const tell = tellBranch;

// ---- the checks at use -----------------------------------------------------------------------------------------------

async function own(host: GitHost, name: unknown, c: Caller): Promise<{ fid: string; record: BranchRecord }> {
  if (typeof name !== "string" || !BRANCH_NAME.test(name)) throw said("invalid", GIT_TEXT.badName);
  if (!c.live()) throw said("invalid", GIT_TEXT.grantChanged);
  const at = await host.branchAtName(name);
  if (!at) throw said("missing", GIT_TEXT.noBranch(name));
  if (at.record.status !== "ready") throw said("invalid", RULE_TEXT.unfinished);
  if (at.record.owner !== c.owner) throw said("invalid", RULE_TEXT.otherConnection);
  return at;
}

/** A gated review write (the caller's grant and ownership checked in its transaction), its refusals said. */
async function put(host: GitHost, fid: string, name: string, next: BranchReview, expect: number, c: Caller) {
  const r = await host.putBranchReview(fid, name, next, expect, { owner: c.owner, live: c.live });
  if (r === "grant") throw said("invalid", GIT_TEXT.grantChanged);
  if (r === "moved") throw said("missing", GIT_TEXT.noBranch(name));
  if (r === "stale") throw said("conflict", GIT_TEXT.raced);
}

// ---- the snapshot of a worktree --------------------------------------------------------------------------------------

type Taken = { files: Files; ids: Map<string, string>; full: Map<string, Full> };
const encJ = new TextEncoder();
/** A document's whole bytes as submitted: a data file's bytes, a notebook's or board's JSON (outputs included). */
export const fullBytes = (kind: Kind, content: unknown): Uint8Array => (kind === "file" ? (content instanceof Uint8Array ? content : encJ.encode(String(content ?? ""))) : encJ.encode(JSON.stringify(content)));
async function take(host: GitHost, root: string, canon: Canon): Promise<Taken> {
  const files: Files = new Map(), ids = new Map<string, string>(), full = new Map<string, Full>();
  for (const e of await host.list(root)) {
    if (e.kind === "folder") continue;
    const r = await host.read(e.path);
    const rel = e.path.slice(root.length + 1);
    files.set(rel, canonBytes(e.kind, r.content, canon));
    full.set(rel, { bytes: fullBytes(e.kind, r.content), kind: e.kind, ...(r.entry.mode ? { mode: r.entry.mode } : {}) });
    ids.set(rel, `${r.entry.fid ?? ""}:${r.rev}`);
  }
  return { files, ids, full };
}
async function same(host: GitHost, root: string, t: Taken): Promise<boolean> {
  const now = (await host.list(root)).filter((e) => e.kind !== "folder");
  if (now.length !== t.ids.size) return false;
  for (const e of now) {
    const rel = e.path.slice(root.length + 1), id = t.ids.get(rel);
    if (id === undefined) return false;
    const r = await host.read(e.path);
    if (`${r.entry.fid ?? ""}:${r.rev}` !== id) return false;
  }
  return true;
}

function withCommitLock<R>(fid: string, f: () => Promise<R>): Promise<R> {
  const locks = (globalThis.navigator as any)?.locks;
  if (!locks || typeof locks.request !== "function") return Promise.reject(said("invalid", "this browser has no Web Locks, which commits need: nothing was changed"));
  return locks.request("sagebrush-branch-commit:" + fid, f);
}

/** A pending commit left by a crash, made right: its ref moved (finalized) or not (dropped).  The state after. */
async function reconcile(host: GitHost, store: BranchStore, fid: string, name: string, cur: BranchReview): Promise<BranchReview> {
  if (!cur.pending) return cur;
  const ref = await refOf(fid), moved = (await store.head(ref)) === cur.pending.head;
  const next: BranchReview = moved ? finalized(cur, cur.pending.head, cur.pending.review, cur.pending.title) : { ...cur, seq: cur.seq + 1, pending: undefined, updated: Date.now() };
  const put = await host.putBranchReview(fid, name, next, cur.seq);
  if (put === "moved") throw said("missing", GIT_TEXT.noBranch(name));
  if (put === "stale") throw said("conflict", GIT_TEXT.raced);
  return next;
}
function finalized(cur: BranchReview, head: string, review: boolean, title?: string): BranchReview {
  const seq = cur.seq + 1;
  return {
    seq, base: cur.base, head, commits: cur.commits + 1, canon: cur.canon, updated: Date.now(),
    status: review ? "review" : "open", ...(review ? { reviewSeq: seq, ...(title ? { title } : {}) } : {}),
  };
}

// ---- git_branch's base commit -----------------------------------------------------------------------------------------

/** The new branch's first commit, its base (git_branch, after its copies, before it is published): the worktree's
 * canonical bytes, each checked against the base hash its copy recorded (the same function made both: a difference
 * is a bug, said, never committed).  Returns the commit, written and referenced. */
export async function baseCommit(host: Omit<GitHost, "branchAtName" | "branchReview" | "putBranchReview">, fid: string, name: string, hashes: Map<string, string>, canon: Canon, who: string): Promise<string> {
  const store = await openBranchStore(host.dbName);
  const root = BRANCHES + "/" + name;
  const files: Files = new Map(), full = new Map<string, Full>();
  for (const e of await host.list(root)) {
    if (e.kind === "folder") continue;
    const r = await host.read(e.path);
    const rel = e.path.slice(root.length + 1);
    files.set(rel, canonBytes(e.kind as Exclude<Kind, "folder">, r.content, canon));
    full.set(rel, { bytes: fullBytes(e.kind, r.content), kind: e.kind, ...(r.entry.mode ? { mode: r.entry.mode } : {}) });
  }
  if (files.size !== hashes.size) throw said("conflict", `the branch's copy doesn't match main as it was copied (${files.size} files, ${hashes.size} hashes)`);
  for (const [rel, b] of files) if ((await bytesHash(b)) !== hashes.get(rel)) throw said("conflict", `the branch's copy of /${rel} doesn't match main as it was copied`);
  if (!(await store.fits(files))) throw said("limit", GIT_TEXT.history);
  const { oid } = await store.writeCommit(files, null, `Branch ${name} from main`, { name: who }, canon, full).catch((e) => { throw e instanceof HistoryFull ? said("limit", GIT_TEXT.history) : e; });
  if (!(await store.setRef(await refOf(fid), oid, null))) throw said("conflict", GIT_TEXT.raced);
  return oid;
}

// ---- the verbs ---------------------------------------------------------------------------------------------------------

/** The review state, made if this is the branch's first use since git_branch (its ref is its base). */
async function stateOf(host: GitHost, store: BranchStore, fid: string, name: string, record: BranchRecord): Promise<BranchReview> {
  const got = await host.branchReview(fid, name);
  if (!got) throw said("missing", GIT_TEXT.noBranch(name));
  if (got.review) return reconcile(host, store, fid, name, got.review);
  const head = await store.head(await refOf(fid));
  if (!head || !record.canon) throw said("invalid", GIT_TEXT.noHistory);
  const first: BranchReview = { seq: 1, base: head, head, commits: 1, canon: record.canon, status: "open", updated: Date.now() };
  const put = await host.putBranchReview(fid, name, first, null);
  if (put === "moved") throw said("missing", GIT_TEXT.noBranch(name));
  if (put === "stale") return stateOf(host, store, fid, name, record);
  return first;
}

export type CommitResult = { branch: string; commit: string; unchanged: boolean; changes: { path: string; kind: string }[]; review: boolean; next: string };

export async function gitCommit(host: GitHost, p: { name: string; message: string; review?: boolean }, c: Caller): Promise<CommitResult> {
  const { fid, record } = await own(host, p.name, c);
  if (typeof p.message !== "string" || !p.message.trim() || p.message.length > STORE_LIMITS.message) throw said("invalid", GIT_TEXT.message);
  const store = await openBranchStore(host.dbName), ref = await refOf(fid), root = BRANCHES + "/" + p.name;
  return withCommitLock(fid, async () => {
    // (the checks again, holding the lock: the grant, the owner, the root by fid and name, ready)
    if ((await own(host, p.name, c)).fid !== fid) throw said("missing", GIT_TEXT.noBranch(p.name));
    let cur = await stateOf(host, store, fid, p.name, record);
    if (cur.accepting) throw said("conflict", GIT_TEXT.accepting);
    if (cur.status === "accepted") throw said("invalid", GIT_TEXT.acceptedWhole);
    let t = await take(host, root, cur.canon);
    await GIT_HOOK.step?.("taken");
    if (!(await same(host, root, t))) {
      t = await take(host, root, cur.canon);
      await GIT_HOOK.step?.("taken");
      if (!(await same(host, root, t))) throw said("conflict", GIT_TEXT.changed);
    }
    const headFiles = await store.filesAt(cur.head);
    const changes = diff(await store.filesAt(cur.base), t.files).map((x) => ({ path: "/" + x.path, kind: x.kind }));
    const review = p.review === true;
    const title = String(p.message).split("\n")[0].trim().slice(0, STORE_LIMITS.title);
    if (!diff(headFiles, t.files).length) {
      // (unchanged: nothing written; asking for review of the head as it is, if it wasn't asked)
      if (review && cur.status !== "review") {
        const next: BranchReview = { ...cur, seq: cur.seq + 1, status: "review", reviewSeq: cur.seq + 1, title, files: undefined, note: undefined, decided: undefined, updated: Date.now() };
        await put(host, fid, p.name, next, cur.seq, c);
        tell({ ns: store.name, fid, seq: next.seq });
        cur = next;
      }
      return { branch: "agent/" + p.name, commit: cur.head, unchanged: true, changes, review: cur.status === "review", next: cur.status === "review" ? GIT_TEXT.next.review(p.name) : GIT_TEXT.next.open(p.name) };
    }
    if (cur.commits >= STORE_LIMITS.commits) throw said("limit", GIT_TEXT.commits);
    if (!(await store.fits(t.files))) throw said("limit", GIT_TEXT.history);
    await GIT_HOOK.step?.("fits");
    if (!c.live()) throw said("invalid", GIT_TEXT.grantChanged);
    const { oid } = await store.writeCommit(t.files, cur.head, p.message, { name: c.actor }, cur.canon, t.full).catch((e) => { throw e instanceof HistoryFull ? said("limit", GIT_TEXT.history) : e; });
    const pending: BranchReview = { ...cur, seq: cur.seq + 1, pending: { head: oid, review, ...(review ? { title } : {}) }, updated: Date.now() };
    await put(host, fid, p.name, pending, cur.seq, c);
    await GIT_HOOK.step?.("pending");
    // (the branch checked once more right before the ref moves: a change while the objects were written drops the
    //  pending commit, nothing published)
    if (!c.live() || !(await same(host, root, t))) {
      await host.putBranchReview(fid, p.name, { ...pending, seq: pending.seq + 1, pending: undefined, updated: Date.now() }, pending.seq);
      throw said(c.live() ? "conflict" : "invalid", c.live() ? GIT_TEXT.changed : GIT_TEXT.grantChanged);
    }
    if (!(await store.setRef(ref, oid, cur.head))) throw said("conflict", GIT_TEXT.raced);
    await GIT_HOOK.step?.("ref");
    const done = finalized(pending, oid, review, title);
    try { await put(host, fid, p.name, done, pending.seq, c); }
    catch (e) {
      // (refused after the ref moved (a revoke): the ref put back, so the pending commit is dropped on the next read)
      await store.setRef(ref, cur.head, oid);
      throw e;
    }
    tell({ ns: store.name, fid, seq: done.seq });
    return { branch: "agent/" + p.name, commit: oid, unchanged: false, changes, review, next: review ? GIT_TEXT.next.review(p.name) : GIT_TEXT.next.open(p.name) };
  });
}

export type StatusResult = {
  branch: string; status: ReviewStatus; title?: string; note?: string; files?: Record<string, Omit<FileDecision, "hash">>;
  decidedAt?: string; head: string; base: string; seq: number; mainMoved: boolean;
};

/** Whether main has changed, since the branch's base, at any path the base holds (main's documents read as now,
 * in the same canonical form). */
async function mainMoved(host: GitHost, store: BranchStore, base: string, canon: Canon): Promise<boolean> {
  for (const [rel, b] of await store.filesAt(base)) {
    let r;
    try { r = await host.read("/" + rel); } catch { return true; }
    if (r.entry.kind === "folder") return true;
    if ((await bytesHash(canonBytes(r.entry.kind, r.content, canon))) !== (await bytesHash(b))) return true;
  }
  return false;
}

export async function gitStatus(host: GitHost, p: { name: string }, c: Caller): Promise<StatusResult> {
  const { fid, record } = await own(host, p.name, c);
  const store = await openBranchStore(host.dbName);
  const cur = await stateOf(host, store, fid, p.name, record);
  const files = cur.files ? Object.fromEntries(Object.entries(cur.files).map(([k, v]) => [k, { decision: v.decision, ...(v.reason ? { reason: v.reason } : {}) }])) : undefined;
  return {
    branch: "agent/" + p.name, status: cur.status, head: cur.head, base: cur.base, seq: cur.seq, mainMoved: await mainMoved(host, store, cur.base, cur.canon),
    ...(cur.title ? { title: cur.title } : {}), ...(cur.note ? { note: cur.note } : {}), ...(files ? { files } : {}),
    ...(cur.decided ? { decidedAt: new Date(cur.decided).toISOString() } : {}),
  };
}

/** Waits per grant (STORE_LIMITS.waitsPerGrant). */
const waiting = new Map<string, number>();
/** Tests' clock (git_wait's bound): `after(ms)` resolves after ms of that clock. */
export const GIT_WAIT_CLOCK: { after: (ms: number) => Promise<void> } = { after: (ms) => new Promise((r) => setTimeout(r, ms)) };

export async function gitWait(host: GitHost, p: { name: string; seconds?: number }, c: Caller): Promise<StatusResult & { decided: boolean; next?: string }> {
  const secs = p.seconds ?? STORE_LIMITS.waitSeconds;
  if (!Number.isInteger(secs) || secs < 1 || secs > STORE_LIMITS.waitSeconds) throw said("invalid", GIT_TEXT.seconds);
  const { fid, record } = await own(host, p.name, c);
  const store = await openBranchStore(host.dbName);
  const n = waiting.get(c.owner) ?? 0;
  if (n >= STORE_LIMITS.waitsPerGrant) throw said("limit", GIT_TEXT.waits);
  waiting.set(c.owner, n + 1);
  // (subscribed before the state is read, so a decision between the read and the wait still wakes it: `dirty` says a
  //  wake came since the last read)
  let wake: () => void = () => {}, dirty = false;
  const off = onBranch(store.name, fid, () => { dirty = true; wake(); });
  let timedOut = false;
  const timer = GIT_WAIT_CLOCK.after(secs * 1000).then(() => { timedOut = true; wake(); });
  try {
    // (a branch without a history (canon 1) refused at once, as git_status refuses it, not at the bound; this read is
    //  the loop's first)
    let first: BranchReview | undefined = await stateOf(host, store, fid, p.name, record);
    for (;;) {
      const woke = new Promise<void>((r) => (wake = r));
      // (each wake reads the review state only; git_status's whole answer, main's comparison included, once, to return)
      let r = dirty ? undefined : first;
      first = undefined;
      dirty = false;
      if (!r) {
        const cur = await host.branchReview(fid, p.name);
        if (!cur) throw said("missing", GIT_TEXT.noBranch(p.name));
        r = cur.review ?? undefined;
      }
      if (r && r.status !== "review" && !r.pending) return { ...(await gitStatus(host, p, c)), decided: true };
      if (timedOut) return { ...(await gitStatus(host, p, c)), decided: false, next: GIT_TEXT.next.waiting(p.name) };
      // (a revoke or a grant change ends the wait at once: c.ended)
      if (!dirty) await Promise.race([woke, timer, ...(c.ended ? [c.ended] : [])]);
      if (!c.live()) throw said("invalid", GIT_TEXT.grantChanged);
    }
  } finally {
    off();
    waiting.set(c.owner, (waiting.get(c.owner) ?? 1) - 1);
  }
}

// ---- the pairing's dispatch (agent-pair.ts's gitVerbs, served as its run verbs are; the pages that offer branches hand it
// in, so a pairing chunk without branches carries none of this) ----------------------------------------------------------

export const GIT_METHODS = ["workspace.git_commit", "workspace.git_status", "workspace.git_wait"] as const;
export type GitMethod = (typeof GIT_METHODS)[number];
export const isGitMethod = (m: string): m is GitMethod => (GIT_METHODS as readonly string[]).includes(m);

/** The git verbs as the pairing calls them: the parameters checked by their schema (a branch name said as the agent
 * was told it), the grant (in force; nothing more: a branch's own rule is checked at use, in each verb), and the run. */
export const GIT_VERBS = {
  params(method: GitMethod, p: unknown): string | null {
    const q = p as any;
    if (q && typeof q === "object" && !Array.isArray(q) && typeof q.name === "string" && !BRANCH_NAME.test(q.name)) return GIT_TEXT.badName;
    return badValue(p) ?? check(PAGE_VERBS[method.slice("workspace.".length) as "git_commit" | "git_status" | "git_wait"].params, p);
  },
  problem(g: Grant | null, now: number): string | null {
    return grantProblem(g, now);
  },
  run(host: GitHost, method: GitMethod, p: any, c: Caller): Promise<unknown> {
    if (method === "workspace.git_commit") return gitCommit(host, p, c);
    if (method === "workspace.git_status") return gitStatus(host, p, c);
    return gitWait(host, p, c);
  },
};

/** The git verbs as the pairing serves them (agent-pair.ts's RunVerbs, as run-holder.ts's): the parameters, then the
 * grant, checked; run while this grant is the one in force, with `ended` resolved when it no longer is (so a git_wait
 * ends at once on a revoke); answered, never thrown. `ws.branchHost(actor)`: the workspace's branch host for that agent. */
export function gitServe(ws: { branchHost(actor: string): GitHost }): RunVerbs {
  return {
    async serve(method, params, side) {
      if (!isGitMethod(method)) return side.fail("invalid", `not a verb: ${JSON.stringify(method)}`);
      const bad = GIT_VERBS.params(method, params);
      if (bad) return side.fail("invalid", bad);
      const g = side.grant, no = GIT_VERBS.problem(g, side.now());
      if (!side.current(g)) return side.fail("invalid", grantProblem(side.live.grant(), side.now()) ?? "the grant changed while this was checked");
      if (no) return side.fail("invalid", no);
      let off = () => {};
      const ended = new Promise<void>((resolve) => { off = side.onChange(() => { if (!side.current(g)) resolve(); }); });
      try {
        const result = await GIT_VERBS.run(ws.branchHost(side.actor), method, params, { owner: g!.id, actor: side.actor, live: () => side.current(g), ended });
        if (!side.current(g)) return side.fail("invalid", CHANGED_WHILE_RUNNING);
        g!.lastUsed = side.now();
        side.reply(result);
      } catch (err: any) {
        if (!side.current(g)) return side.fail("invalid", CHANGED_WHILE_RUNNING);
        const code = typeof err?.code === "string" && ["invalid", "exists", "missing", "conflict", "limit", "storage"].includes(err.code) ? err.code : "invalid";
        side.fail(code, String(err?.message ?? err));
      } finally {
        off();
      }
    },
  };
}
