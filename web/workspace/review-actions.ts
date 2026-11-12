// The person's decisions on an agent's branch (the review page calls these).  Never verbs: no agent
// can reach them (the pairing dispatches only the verbs in the schema, and these are in none of it).
//
//   review(...)   the person's decisions on the commit they reviewed: each file accepted, rejected, or "ask for
//                 changes", with a reason, and a note for the whole.  Accepted files are applied to main first
//                 (acceptFiles), then the decisions recorded.
//
// Bound to what was reviewed (astra's point 3): every call names the branch's root fid and name, the reviewed commit
// (its head) and its review seq; a branch that has moved on since (a new commit, or a decision already made) is
// refused, so a decision never lands on another commit.
//
// Accepting a file, per file (astra's point 4, daybreak3's E2):
//   - what is written is the document the commit captured (branch-store.ts's fullAt: a notebook with its outputs,
//     which the canonical bytes leave out), never the branch's live file: nothing changed after the review lands;
//   - main's file must be as the branch's base had it (by canonical hash, and of the same kind), or not exist if the
//     base didn't have it; otherwise refused, unless the person named that path in `overwrite` (the review page's
//     second click, which names the overwrite);
//   - an `accepting` intent, with main's preimage per file, is written into the review state first; a reload with one
//     finishes it (a file already as committed is skipped; one someone changed since drops it, before anything is
//     written); the decisions and status are written only after main's files are.

import { BRANCHES, type BranchRecord, type BranchReview, type FileDecision, type MainIdentity, type ReviewStatus } from "./branch-rules";
import { canonBytes } from "./branch-canon";
import { STORE_LIMITS, diff, openBranchStore, type Full } from "./branch-store";
import { tellBranch, type GitHost } from "./git-verbs";
import { sha256Hex as bytesHash } from "./sha256-hex";
import type { Kind } from "./paths";

type Doc = { entry: { path: string; kind: Kind; mode?: string; fid?: string; ref?: string | null; created: number }; content: unknown; rev: number };
/** What the person's actions need: the git verbs' host, the branch records, and the person's own writes. */
export type PersonHost = GitHost & {
  branchRecords(): Promise<Map<string, BranchRecord>>;
  read(p: string): Promise<Doc>;
  /** Only if `p` is still the entry `expect` at revision `base`, checked holding its lock: Workspace.reviewHost's. */
  write(p: string, content: unknown, opts: { base: number; expect: Pick<Doc["entry"], "kind" | "fid" | "created" | "ref"> }): Promise<unknown>;
  create(p: string, opts: { content: unknown; mode?: string }): Promise<unknown>;
  /** `p` put in Trash only if it is still the entry `expect` at revision `base`, checked holding `p`'s lock (a
   * WorkspaceError("conflict") otherwise, nothing moved): Workspace.reviewHost's. */
  remove(p: string, expect: { entry: Doc["entry"]; base: number }): Promise<unknown>;
};

/** What the review page is told, word for word (board's COPY reviews them). */
export const REVIEW_TEXT = {
  moved: "The branch changed since you opened it (a new commit, or a decision already made): look again.",
  notInCommit: (p: string) => `${p} isn't one of the files this commit changes.`,
  branchChanged: (p: string) => `${p} changed in the branch after it was submitted: ask the agent to commit again.`,
  mainChanged: (p: string) => `${p} changed in your files since the branch began. Accept it again to replace your version.`,
  kindChanged: (p: string) => `${p} is a different kind of file in your files now: it can't be replaced from the branch.`,
  reason: `A reason can be at most ${STORE_LIMITS.reason.toLocaleString("en-US")} characters.`,
  note: `A note can be at most ${STORE_LIMITS.note.toLocaleString("en-US")} characters.`,
} as const;

const fail = (message: string) => Object.assign(new Error(message), { code: "conflict" as const });
const hashOf = async (b: Uint8Array) => bytesHash(b);
const rel = (p: string) => p.replace(/^\//, "");

/** The branches, for the chat panel and the review page: every ready branch with its review state. */
export async function listBranches(host: PersonHost): Promise<{ name: string; fid: string; status: ReviewStatus | "open"; title?: string; head?: string; seq?: number; updated: number; evidence: "none" }[]> {
  const out = [];
  for (const [fid, rec] of await host.branchRecords()) {
    if (rec.status !== "ready") continue;
    const got = await host.branchReview(fid, rec.name);
    if (!got) continue;
    const r = got.review;
    out.push({ name: rec.name, fid, status: r?.status ?? "open", ...(r?.title ? { title: r.title } : {}), ...(r ? { head: r.head, seq: r.seq } : {}), updated: r?.updated ?? rec.made, evidence: "none" as const });
  }
  return out.sort((a, b) => b.updated - a.updated);
}

export type Decisions = { files: Record<string, { decision: FileDecision["decision"]; reason?: string }>; note?: string; overwrite?: string[] };

/** The person's review of the commit `at.head` (review seq `at.seq`) of the branch `at.name` (root fid `at.fid`). */
export async function review(host: PersonHost, at: { fid: string; name: string; head: string; seq: number }, d: Decisions): Promise<BranchReview> {
  if (d.note !== undefined && (typeof d.note !== "string" || d.note.length > STORE_LIMITS.note)) throw fail(REVIEW_TEXT.note);
  for (const v of Object.values(d.files)) if (v.reason !== undefined && (typeof v.reason !== "string" || v.reason.length > STORE_LIMITS.reason)) throw fail(REVIEW_TEXT.reason);
  const got = await host.branchReview(at.fid, at.name);
  const cur = got?.review;
  if (!cur || cur.head !== at.head || cur.reviewSeq !== at.seq || cur.status !== "review" || cur.pending) throw fail(REVIEW_TEXT.moved);
  const store = await openBranchStore(host.dbName);
  const head = await store.filesAt(cur.head), base = await store.filesAt(cur.base);
  const changed = new Map(diff(base, head).map((c) => ["/" + c.path, c.kind]));
  for (const p of Object.keys(d.files)) if (!changed.has(p)) throw fail(REVIEW_TEXT.notInCommit(p));
  // (each decision bound to its file's canonical hash in the reviewed commit; a deletion to "")
  const files: Record<string, FileDecision> = {};
  for (const [p, v] of Object.entries(d.files)) {
    const b = head.get(rel(p));
    files[p] = { decision: v.decision, ...(v.reason ? { reason: v.reason } : {}), hash: b ? await hashOf(b) : "" };
  }
  const decided = Object.values(files).map((f) => f.decision);
  const status: ReviewStatus = decided.length && decided.every((x) => x === "accepted") && decided.length === changed.size ? "accepted"
    : decided.some((x) => x === "accepted") ? "partly-accepted"
    : decided.some((x) => x === "changes") ? "changes-requested" : "rejected";
  const accept = Object.keys(files).filter((p) => files[p].decision === "accepted");
  let state = cur;
  if (accept.length) state = await acceptFiles(host, { ...at, state: cur }, accept, files, new Set(d.overwrite ?? []), { note: d.note, status });
  return record(host, store.name, at, state, files, d.note, status);
}

/** The decisions written, once main's files are (the review state's last step). */
async function record(host: PersonHost, ns: string, at: { fid: string; name: string }, state: BranchReview, files: Record<string, FileDecision>, note: string | undefined, status: ReviewStatus): Promise<BranchReview> {
  const next: BranchReview = { ...state, seq: state.seq + 1, status, files, note: note || undefined, decided: Date.now(), accepting: undefined, updated: Date.now() };
  if ((await host.putBranchReview(at.fid, at.name, next, state.seq)) !== "ok") throw fail(REVIEW_TEXT.moved);
  tellBranch({ ns, fid: at.fid, seq: next.seq });
  return next;
}

/** An accept a closed page left under way, finished: each file not yet written, written as the commit captured it,
 * if main's file is still exactly the entry and revision the accept checked. Any other file (edited since, even its
 * outputs alone; or written by this accept just before the page closed, which can't be told apart) drops the accept
 * before anything more is written. */
export async function resumeAccepting(host: PersonHost, at: { fid: string; name: string }): Promise<BranchReview | null> {
  const got = await host.branchReview(at.fid, at.name);
  const cur = got?.review, a = cur?.accepting;
  if (!cur || !a) return cur ?? null;
  const store = await openBranchStore(host.dbName);
  const todo: Step[] = [];
  for (const p of a.paths) {
    if (a.done.includes(p)) continue;
    const main = await readOrNull(host, p);
    if (!sameIdentity(identity(main), a.pre[p])) {
      await host.putBranchReview(at.fid, at.name, { ...cur, seq: cur.seq + 1, accepting: undefined, updated: Date.now() }, cur.seq);
      throw fail(REVIEW_TEXT.mainChanged(p));
    }
    todo.push({ path: p, main, full: await store.fullAt(a.head, rel(p)) });
  }
  const state = await apply(host, at, cur, todo);
  return record(host, store.name, at, state, a.files, a.note, a.status);
}

type Step = { path: string; main: Doc | null; full: Full | null };
const readOrNull = async (host: PersonHost, p: string): Promise<Doc | null> => { try { return await host.read(p); } catch { return null; } };
const hashDoc = async (d: Doc | null, canon: 1 | 2) => (d && d.entry.kind !== "folder" ? hashOf(canonBytes(d.entry.kind as Exclude<Kind, "folder">, d.content, canon)) : "");
// (a document's ref is its identity as much as a data file's fid is: a notebook or board replaced by another made at
//  the same moment, at the same revision, is another document)
const identity = (d: Doc | null): MainIdentity | null => (d ? { kind: d.entry.kind, ...(d.entry.fid !== undefined ? { fid: d.entry.fid } : {}), ...(d.entry.kind !== "file" ? { ref: d.entry.ref ?? null } : {}), created: d.entry.created, rev: d.rev } : null);
const sameIdentity = (x: MainIdentity | null, y: MainIdentity | null | undefined) => (x === null || y == null ? x === null && y === null : x.kind === y.kind && x.fid === y.fid && (x.ref ?? null) === (y.ref ?? null) && x.created === y.created && x.rev === y.rev);
const decoder = new TextDecoder();
/** Tests' hook: after every file of an accept (or a resume) is checked, before the first is written. */
export const REVIEW_HOOK: { step?: (s: "checked") => void | Promise<void> } = {};
/** Main's files written as the commit captured them (a deletion: removed), each only if it is still the entry checked,
 * at the revision checked (checked holding its lock, by the host), and each recorded in the intent once written. A
 * file changed since is the person's: never replaced, and its refusal said. The state after. */
async function apply(host: PersonHost, at: { fid: string; name: string }, state: BranchReview, steps: Step[]): Promise<BranchReview> {
  await REVIEW_HOOK.step?.("checked");
  for (const { path, main, full } of steps) {
    const content = full ? (full.kind === "file" ? full.bytes : JSON.parse(decoder.decode(full.bytes))) : undefined;
    try {
      if (!full) { if (main) await host.remove(path, { entry: main.entry, base: main.rev }); }
      else if (main) await host.write(path, content, { base: main.rev, expect: main.entry });
      else await host.create(path, { content, ...(full.mode ? { mode: full.mode } : {}) });
    } catch (e) {
      if ((e as { code?: string })?.code === "conflict" || (e as { code?: string })?.code === "exists") throw fail(REVIEW_TEXT.mainChanged(path));
      throw e;
    }
    const next: BranchReview = { ...state, seq: state.seq + 1, accepting: { ...state.accepting!, done: [...state.accepting!.done, path] }, updated: Date.now() };
    if ((await host.putBranchReview(at.fid, at.name, next, state.seq)) !== "ok") throw fail(REVIEW_TEXT.moved);
    state = next;
  }
  return state;
}

/** Main changed as the reviewed commit has `paths`, written from the documents the commit captured (never the branch's
 * live files: nothing changed after the review is applied), with the checks above; the review state with its intent
 * (the entry and revision of each file of main as checked, for a resume), after. */
async function acceptFiles(host: PersonHost, at: { fid: string; name: string; head: string; seq: number; state: BranchReview }, paths: string[], files: Record<string, FileDecision>, overwrite: Set<string>, then: { note?: string; status: ReviewStatus }): Promise<BranchReview> {
  const store = await openBranchStore(host.dbName);
  const base = await store.filesAt(at.state.base), canon = at.state.canon;
  // (every check first, then the intent, then the writes: a refusal changes nothing)
  const plan: Step[] = [], pre: Record<string, MainIdentity | null> = {};
  for (const p of paths) {
    const full = await store.fullAt(at.head, rel(p));
    if (!full && files[p].hash !== "") throw fail(REVIEW_TEXT.branchChanged(p));
    const main = await readOrNull(host, p);
    const was = base.get(rel(p));
    if (!overwrite.has(p)) {
      if (was === undefined ? main !== null : !main || main.entry.kind === "folder" || (await hashDoc(main, canon)) !== (await hashOf(was))) throw fail(REVIEW_TEXT.mainChanged(p));
    }
    if (main && (main.entry.kind === "folder" || (full && main.entry.kind !== full.kind))) throw fail(REVIEW_TEXT.kindChanged(p));
    pre[p] = identity(main);
    plan.push({ path: p, main, full });
  }
  const intent: BranchReview = { ...at.state, seq: at.state.seq + 1, accepting: { head: at.head, paths, pre, done: [], files, ...(then.note ? { note: then.note } : {}), status: then.status }, updated: Date.now() };
  if ((await host.putBranchReview(at.fid, at.name, intent, at.state.seq)) !== "ok") throw fail(REVIEW_TEXT.moved);
  return apply(host, at, intent, plan);
}
