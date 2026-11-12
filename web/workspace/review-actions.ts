// The person's decisions on an agent's branch (W3 PR A; the review page, PR B, calls these).  Never verbs: no agent
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
//   - the branch's live document must still be, canonically, the committed one (its hash equal to the commit's):
//     what is applied is what was reviewed, with its outputs, which the canonical bytes leave out;
//   - main's file must be as the branch's base had it (by canonical hash, and of the same kind), or not exist if the
//     base didn't have it; otherwise refused, unless the person named that path in `overwrite` (the review page's
//     second click, which names the overwrite);
//   - an `accepting` intent is written into the review state first; a reload with one finishes it (files already as
//     committed are skipped); the decisions and status are written only after main's files are.

import { BRANCHES, type BranchRecord, type BranchReview, type FileDecision, type ReviewStatus } from "./branch-rules";
import { canonBytes } from "./branch-canon";
import { STORE_LIMITS, diff, openBranchStore } from "./branch-store";
import { tellBranch, type GitHost } from "./git-verbs";
import { bytesHash } from "../notebook/stores.js";
import type { Kind } from "./paths";

type Doc = { entry: { path: string; kind: Kind; mode?: string }; content: unknown; rev: number };
/** What the person's actions need: the git verbs' host, the branch records, and the person's own writes. */
export type PersonHost = GitHost & {
  branchRecords(): Promise<Map<string, BranchRecord>>;
  read(p: string): Promise<Doc>;
  write(p: string, content: unknown, opts: { base: number }): Promise<unknown>;
  create(p: string, opts: { content: unknown; mode?: string }): Promise<unknown>;
  remove(p: string): Promise<unknown>;
};

/** What the review page is told, word for word (board's COPY reviews them). */
export const REVIEW_TEXT = {
  moved: "The branch changed since you opened it (a new commit, or a decision already made): look again.",
  notInCommit: (p: string) => `${p} isn't one of the files this commit changes.`,
  branchChanged: (p: string) => `${p} changed in the branch after it was submitted: ask the agent to commit again.`,
  mainChanged: (p: string) => `${p} changed in your files since the branch began. Accept it again to replace your version.`,
  kindChanged: (p: string) => `${p} is a different kind of file in your files now: it can't be replaced from the branch.`,
  reason: `A reason is at most ${STORE_LIMITS.reason} characters.`,
  note: `A note is at most ${STORE_LIMITS.note} characters.`,
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

/** An accept a closed page left under way, finished: each of its files applied unless main already has it as
 * committed (by canonical hash), then its decisions recorded.  A branch with none is returned as it is. */
export async function resumeAccepting(host: PersonHost, at: { fid: string; name: string }): Promise<BranchReview | null> {
  const got = await host.branchReview(at.fid, at.name);
  const cur = got?.review, a = cur?.accepting;
  if (!cur || !a) return cur ?? null;
  const root = BRANCHES + "/" + at.name;
  for (const p of a.paths) {
    let main: Doc | null = null;
    try { main = await host.read(p); } catch { main = null; }
    const now = main && main.entry.kind !== "folder" ? await hashOf(canonBytes(main.entry.kind as Exclude<Kind, "folder">, main.content, cur.canon)) : "";
    if (now === a.hashes[p]) continue;
    let live: Doc | null = null;
    try { live = await host.read(root + p); } catch { live = null; }
    const liveHash = live && live.entry.kind !== "folder" ? await hashOf(canonBytes(live.entry.kind as Exclude<Kind, "folder">, live.content, cur.canon)) : "";
    if (liveHash !== a.hashes[p]) throw fail(REVIEW_TEXT.branchChanged(p));
    if (!live) { if (main) await host.remove(p); continue; }
    if (main) await host.write(p, live.content, { base: main.rev });
    else await host.create(p, { content: live.content, ...(live.entry.mode ? { mode: live.entry.mode } : {}) });
  }
  return record(host, (await openBranchStore(host.dbName)).name, at, cur, a.files, a.note, a.status);
}

/** Main changed as the reviewed commit has `paths`, with the checks above; the review state with its intent, after. */
async function acceptFiles(host: PersonHost, at: { fid: string; name: string; head: string; seq: number; state: BranchReview }, paths: string[], files: Record<string, FileDecision>, overwrite: Set<string>, then: { note?: string; status: ReviewStatus }): Promise<BranchReview> {
  const store = await openBranchStore(host.dbName);
  const base = await store.filesAt(at.state.base), canon = at.state.canon;
  const root = BRANCHES + "/" + at.name;
  // (every check first, then the intent, then the writes: a refusal changes nothing)
  type Plan = { path: string; live: Doc | null; main: Doc | null };
  const plan: Plan[] = [];
  for (const p of paths) {
    let live: Doc | null = null;
    try { live = await host.read(root + p); } catch { live = null; }
    const want = files[p].hash;
    if (live && live.entry.kind === "folder") throw fail(REVIEW_TEXT.branchChanged(p));
    if ((live ? await hashOf(canonBytes(live.entry.kind as Exclude<Kind, "folder">, live.content, canon)) : "") !== want) throw fail(REVIEW_TEXT.branchChanged(p));
    let main: Doc | null = null;
    try { main = await host.read(p); } catch { main = null; }
    const was = base.get(rel(p));
    if (!overwrite.has(p)) {
      if (was === undefined ? main !== null : !main || main.entry.kind === "folder" || (await hashOf(canonBytes(main.entry.kind as Exclude<Kind, "folder">, main.content, canon))) !== (await hashOf(was))) throw fail(REVIEW_TEXT.mainChanged(p));
    }
    if (main && live && main.entry.kind !== live.entry.kind) throw fail(REVIEW_TEXT.kindChanged(p));
    plan.push({ path: p, live, main });
  }
  const intent: BranchReview = { ...at.state, seq: at.state.seq + 1, accepting: { head: at.head, paths, hashes: Object.fromEntries(paths.map((p) => [p, files[p].hash])), files, ...(then.note ? { note: then.note } : {}), status: then.status }, updated: Date.now() };
  if ((await host.putBranchReview(at.fid, at.name, intent, at.state.seq)) !== "ok") throw fail(REVIEW_TEXT.moved);
  for (const { path, live, main } of plan) {
    if (!live) { if (main) await host.remove(path); continue; }
    if (main) await host.write(path, live.content, { base: main.rev });
    else await host.create(path, { content: live.content, ...(live.entry.mode ? { mode: live.entry.mode } : {}) });
  }
  return intent;
}
