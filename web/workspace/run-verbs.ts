// An agent's runs of code in the person's page (chat plan PR 4a; design packet r3, 0a86af1a, CLEAR in every lane):
// workspace.run_notebook and workspace.run_file, and run_stop. A chunk of its own, /sagebrush-agent-run.js, fetched at
// an agent's first run; the pairing chunk (agent-ui.ts, agent-pair.ts) keeps only the run holder, its line with Stop
// and this loader (daybreak2's placement).
//
// A run, in order (each step the packet's section):
//   - "May run code" (the grant's run), the path readable under the grant, never Trash or /Proposals, and in
//     /Branches only the calling grant's own ready branch (§1);
//   - at most one run in the page: a second is refused busy, also while a stopped run drains (§2, RUN-DRAIN-1);
//   - one immutable snapshot of the files the grant can read, bounded, and its inputHash (§4);
//   - the view: a worktree run sees its branch as "/" (W1), one mapping at every path (§5);
//   - where its code may write: the branch, or the document's own trees, met with the grant's write, fixed at the
//     start and only narrowing (§3);
//   - always the sandboxed runner, never a plain worker (§6);
//   - bounds kept while output is made (§7), the result at most 256 KiB as JSON;
//   - outputs saved only into the run's own worktree notebook, if it is still that notebook (§9, SAVE-IDENTITY-2);
//   - every end closes admission first, synchronously; the run stays busy until what was admitted settles (§2).
// The numbers are daybreak2's binding ruling (reviews/chat-pr4-r3-size-limits.md); the words board's (C1-C5).

import { covers, meetTrees, stateOf } from "../notebook/confine.js";
import { BRANCHES, TRASH, within, nameOf } from "./paths";
import { inGrant, norm, type Grant } from "./agent-grant";
// (the house size form, row-meta.ts's fmtSize, as board asks; written here: row-meta.ts brings the workspace's types)
const fmtSize = (n: number) => (n < 1024 ? `${n} B` : n < 2 ** 20 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 2 ** 20).toFixed(1)} MB`);

export const PROPOSALS = "/Proposals";
const KiB = 1024, MiB = 1024 * KiB;
/** daybreak2's binding numbers (chat-pr4-r3-size-limits.md). */
export const RUN_LIMITS = Object.freeze({
  files: 2000, bytes: 64 * MiB, pathBytes: 2 * MiB,
  cells: 1000, source: 1 * MiB,
  cellHead: 1 * KiB, cellTail: 1 * KiB,
  streamHead: 32 * KiB, streamTail: 32 * KiB,
  result: 256 * KiB,
  refusedNames: 64, refusedBytes: 16 * KiB,
  timeoutDefault: 120, timeoutMax: 600,
  /** the sandbox's start, within the run's deadline: past it, "didn't start" */
  startMs: 20_000,
  /** a worktree notebook's outputs kept when saved: past this, a display isn't kept (its text says so) */
  savedOutputs: 8 * MiB,
  /** the code's changes waiting to be kept, their bytes together: past this, a change is refused, not queued */
  queued: 64 * MiB,
  /** and their number, each charged its path and this much besides its bytes (astra's RUN-BOUND-3 r2: an empty write
   *  or a delete is never free) */
  queuedOps: 4096, opBytes: 256,
});

/** The words (board's C3, word for word; the code before the colon is the error's code too). */
export const RUN_TEXT = {
  busyOwn: (view: string) => `busy: your run of ${view} is still going; wait for it or call workspace.run_stop`,
  busyOther: "busy: another run is going in this page; try again when it ends",
  noSandbox: "no sandbox: code runs only in Sagebrush's sandbox, which isn't available here",
  didntStart: "no sandbox: Sagebrush's sandbox didn't start; try again",
  tooManyFiles: (n: number) => `too large: the files you can read are over ${RUN_LIMITS.files.toLocaleString("en-US")} (${n.toLocaleString("en-US")})`,
  tooManyBytes: (n: number) => `too large: the files you can read are over ${fmtSize(RUN_LIMITS.bytes)} (${fmtSize(n)})`,
  tooManyPaths: (n: number) => `too large: the paths of the files you can read are over ${fmtSize(RUN_LIMITS.pathBytes)} (${fmtSize(n)})`,
  tooManyCells: (n: number) => `too large: the notebook has over ${RUN_LIMITS.cells.toLocaleString("en-US")} cells (${n.toLocaleString("en-US")})`,
  tooMuchSource: (n: number) => `too large: the notebook's code is over ${fmtSize(RUN_LIMITS.source)} (${fmtSize(n)})`,
  notAllowed: "not allowed: this grant may not run code (the person can allow it when they connect this agent again)",
  revoked: "the grant was revoked",
  expired: "the grant expired",
  runOff: "May run code was turned off",
  narrowed: "what you may read was narrowed",
  truncated: `the result is limited to ${fmtSize(RUN_LIMITS.result)}`,
  more: (n: number) => `and ${n} more`,
  outside: (n: number) => `${n} outside what you can read`,
  notNotebook: (p: string) => `invalid: ${p} isn't a notebook`,
  notCode: (p: string) => `invalid: ${p} isn't a .py or .sage file`,
  noSuch: (p: string) => `missing: ${p} isn't in this workspace`,
  notHere: (p: string) => `invalid: ${p} can't be run from Trash or /Proposals`,
  unreadable: (p: string) => `invalid: outside the folders this agent may read: ${JSON.stringify(p).slice(0, 120)}`,
  notText: (p: string) => `invalid: ${p} isn't UTF-8 text`,
  cut: (n: number) => `[… ${n.toLocaleString("en-US")} bytes]`,
  notKept: `[output not kept: the notebook's outputs are over ${fmtSize(RUN_LIMITS.savedOutputs)}]`,
  changed: (p: string) => `changed: ${p} was changed while the run was starting; try again`,
};

/** A refusal: its code (machine-readable) and board's sentence. */
export class RunError extends Error {
  constructor(public code: string, message: string) { super(message); }
}
const refuse = (text: string): never => { const code = text.slice(0, text.indexOf(":")).replace(/ /g, "_"); throw new RunError(code, text); };

/** What the page gives a run (index.html): its workspace's run host (Workspace.runHost), the interpreter's classes, the
 * runner's address, whether the sandbox can be had here at all, and a document's own write trees. */
export type RunHost = {
  ws: { runHost(actor: string, owner: () => string | null): RunWs };
  WorkerKernel: new (o: any) => any;
  RunnerWorker: new (src: string, o?: any) => any;
  runnerSrc: string;
  /** "none": by design (the app, `sagebrush notebook`, a page not cross-origin isolated) */
  sandbox: "ok" | "none";
  /** a notebook's write trees as the person allowed them (perms.writeTrees); [] for anything without a record */
  docTrees(ref: string): string[];
  /** a change to any notebook's write trees (perms.onChange): the run's ceiling narrows at once (astra's RUN-POLICY-2 r2) */
  docChange?(cb: () => void): () => void;
  /** tests only (a local host): a named hold the test releases ("snapshot", "listed", "start", "started", "save",
   * "deliver") */
  hold?(stage: string): Promise<void>;
};
/** Workspace.runHost's (api.ts): the run's view of the workspace, credited to the agent, every change admitted. */
type RunWs = {
  list(folder: string): Promise<any[]>;
  stat(p: string): Promise<any>;
  read(p: string, admit: (c: any) => void): Promise<{ entry: any; content: any; rev: number }>;
  readUpTo(p: string, max: number, admit: (c: any) => void): Promise<{ entry: any; content: Uint8Array }>;
  branchAt(p: string): Promise<{ no: string | null; root?: { path: string; fid?: string } }>;
  putFile(p: string, bytes: Uint8Array, admit: (c: any) => void): Promise<unknown>;
  remove(p: string, admit: (c: any) => void): Promise<unknown>;
  write(p: string, content: unknown, base: number, admit: (c: any) => void): Promise<unknown>;
};

/** The run holder, kept in the pairing chunk (agent-ui.ts): the page's one run, and its line. */
export type RunHolder = {
  /** the page's one run: while its chunk loads, the pairing's record of it (`loading`, Stop already working on it) */
  current: { owner: string; view: string; stop(): void; loading?: { stopped: boolean; cause?: "stopped" | "timeout"; wake?: () => void }; deadlineAt?: number } | null;
  show(agent: string, view: string, stop: () => void): void;
  hide(): void;
};
/** The calling pairing, as a run needs it. */
export type RunCtx = {
  agent: string; actor: string; grant: Grant;
  /** this grant still in force, with run, its folders unchanged */
  live(): boolean;
  /** why it isn't: one of RUN_TEXT's reasons */
  why(): string;
  /** the grant now (null if none): a write-only narrowing applies at once */
  grantNow(): Grant | null;
  onChange(cb: () => void): () => void;
};

// ---------------------------------------------------------------- pure helpers (unit-tested: test-run-verbs.mjs)

const enc = new TextEncoder();
/** A string's size as it goes in a JSON text, its quotes left out (escapes counted, daybreak2's rule). */
export const jsonBytes = (s: string) => enc.encode(JSON.stringify(s)).length - 2;
/** The canonical path form (as fsCanon and normPath take it): absolute, no "", ".", ".." segment, no control
 * character, no trailing "/" except "/" itself. */
export function canonical(p: unknown): p is string {
  if (typeof p !== "string" || !p.startsWith("/") || p.length > 4096 || /[\u0000-\u001f]/.test(p)) return false;
  if (p === "/") return true;
  return p.slice(1).split("/").every((s) => s !== "" && s !== "." && s !== "..");
}
/** W1's view (§5): `root` the worktree ("/Branches/x"), or "" for a main run. */
export function viewOf(root: string) {
  const reserved = (p: string) => within(p, BRANCHES) || within(p, TRASH) || within(p, PROPOSALS);
  return {
    /** a real path as the run sees it, or null if it isn't in the view */
    toView(real: string): string | null {
      if (!root) return reserved(real) ? null : real;
      if (real === root) return "/";
      return real.startsWith(root + "/") ? real.slice(root.length) : null;
    },
    /** a path the run named, canonical first, as the real path, or null: never another spelling of anything outside */
    toReal(view: unknown): string | null {
      if (!canonical(view) || (view !== "/" && reserved(view))) return null;
      return root ? (view === "/" ? root : root + view) : view;
    },
  };
}
/** Text kept as a head and a running tail (§7): at most `head` + `tail` bytes as JSON, the middle replaced by its size. */
export class Kept {
  private h = ""; private t = ""; private hb = 0; private tb = 0; private cut = 0;
  constructor(private head: number, private tail: number) {}
  add(s: string) {
    if (!s) return;
    if (this.hb < this.head) {
      const take = fit(s, this.head - this.hb);
      this.h += take; this.hb += jsonBytes(take);
      s = s.slice(take.length);
      if (!s) return;
    }
    this.t += s; this.tb += jsonBytes(s);
    if (this.tb > this.tail) {
      // (from the front, whole code points only, until it fits)
      const drop = this.tb - this.tail;
      let i = 0, gone = 0;
      while (i < this.t.length && gone < drop) {
        const cp = this.t.codePointAt(i)!, w = cp > 0xffff ? 2 : 1;
        gone += jsonBytes(this.t.slice(i, i + w));
        this.cut += jsonBytes(this.t.slice(i, i + w));
        i += w;
      }
      this.t = this.t.slice(i); this.tb -= gone;
    }
  }
  text() { return this.cut ? this.h + RUN_TEXT.cut(this.cut) + this.t : this.h + this.t; }
}
/** The longest prefix of `s` whose JSON payload is at most `n` bytes, on a code point boundary. */
function fit(s: string, n: number): string {
  if (jsonBytes(s) <= n) return s;
  let lo = 0, hi = s.length;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (jsonBytes(s.slice(0, mid)) <= n) lo = mid; else hi = mid - 1; }
  if (lo > 0 && /[\ud800-\udbff]/.test(s[lo - 1])) lo--;
  return s.slice(0, lo);
}
/** The refused paths (§7, board's C3), kept as they come: readable names up to 64 and 16 KiB of path bytes, then only
 * counted ("and N more"); unreadable ones only counted. Never more than the names it says (astra's RUN-BOUND-3). */
export class Refused {
  private names: string[] = []; private bytes = 0; private more = 0; private outside = 0;
  constructor(private readable: (p: string) => boolean) {}
  add(p: string) {
    if (this.names.includes(p)) return;
    if (!this.readable(p)) { this.outside++; return; }
    const b = enc.encode(p).length;
    if (this.names.length < RUN_LIMITS.refusedNames && this.bytes + b <= RUN_LIMITS.refusedBytes) { this.names.push(p); this.bytes += b; } else this.more++;
  }
  out() { return { paths: [...this.names], ...(this.more ? { more: RUN_TEXT.more(this.more) } : {}), ...(this.outside ? { outside: RUN_TEXT.outside(this.outside) } : {}) }; }
}
/** The refused paths as said, for a list (the unit test's): as Refused keeps them. */
export function refusedOut(paths: string[], readable: (p: string) => boolean) {
  const r = new Refused(readable);
  for (const p of paths) r.add(p);
  return r.out();
}
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const sha = async (u: Uint8Array) => hex(await crypto.subtle.digest("SHA-256", u as Uint8Array<ArrayBuffer>));
/** A notebook's canonical inputs (§4): its language and its cells' kinds and sources, never outputs. */
export const notebookInputs = (doc: any) => enc.encode(JSON.stringify({ mode: doc?.mode ?? "python", cells: (doc?.cells ?? []).map((c: any) => ({ type: c?.type ?? "code", code: String(c?.code ?? "") })) }));
/** inputHash (§4): SHA-256 of "view\tkind\tsha256\n" for each input, sorted by view path. */
export async function inputHash(items: { view: string; kind: string; sha256: string }[]) {
  const lines = [...items].sort((a, b) => (a.view < b.view ? -1 : a.view > b.view ? 1 : 0)).map((i) => `${i.view}\t${i.kind}\t${i.sha256}\n`).join("");
  return sha(enc.encode(lines));
}
/** The result as JSON within the budget (§7): parts in order; a part that doesn't fit, and those after, omitted. */
export function bounded(base: Record<string, unknown>, parts: [string, unknown[]][]) {
  const out: Record<string, unknown> = { ...base };
  const omitted: string[] = [];
  const size = () => enc.encode(JSON.stringify({ ...out, truncated: { omitted: [...omitted, "x".repeat(64)], reason: RUN_TEXT.truncated } })).length;
  for (const [key, items] of parts) {
    const kept: unknown[] = [];
    out[key] = kept;
    for (let i = 0; i < items.length; i++) {
      kept.push(items[i]);
      if (size() > RUN_LIMITS.result) { kept.pop(); omitted.push(`${key} ${i + 1}–${items.length}`); break; }
    }
  }
  if (omitted.length) out.truncated = { omitted, reason: RUN_TEXT.truncated };
  return out;
}

// ---------------------------------------------------------------- a run

type Phase = "open" | "closing";
const SCRATCH = /^\/(tmp|\$pyjs)(\/|$)/;

/** One run of `method` for the pairing `ctx`, in the page `host`, held in `holder`: its result, or a RunError. */
export async function run(method: "workspace.run_notebook" | "workspace.run_file", params: { path: string; timeout_s?: number }, ctx: RunCtx, host: RunHost, holder: RunHolder, pre?: RunHolder["current"]): Promise<Record<string, unknown>> {
  const g = ctx.grant;
  // (`pre`: this run's record while its chunk loaded (agent-ui.ts); stopped then, it ends now, before anything is read)
  if (pre?.loading?.stopped) { if (holder.current === pre) { holder.current = null; holder.hide(); } return { ok: false, ended: pre.loading.cause ?? "stopped", ms: 0 }; }
  const release = () => { if (pre && holder.current === pre) { holder.current = null; holder.hide(); } };
  // (until the run is held, each lookup it waits on is raced with its deadline and Stop: one that hangs ends with them
  //  (daybreak3's RUN-DEADLINE-HANDOFF-1))
  let cut!: (c: "stopped" | "timeout") => void;
  const cutP = new Promise<"stopped" | "timeout">((r) => (cut = r));
  const t = setTimeout(() => cut("timeout"), Math.max(0, (pre?.deadlineAt ?? performance.now() + (params.timeout_s ?? RUN_LIMITS.timeoutDefault) * 1000) - performance.now()));
  if (pre?.loading) pre.loading.wake = () => cut(pre.loading!.cause ?? "stopped");
  const look = <T>(p: Promise<T>) => Promise.race([p, cutP.then((c): never => { throw new Cut(c); })]);
  try { return await runNow(method, params, ctx, host, holder, pre ?? null, look); }
  catch (e) { if (e instanceof Cut) return { ok: false, ended: e.cause, ms: 0 }; throw e; }
  finally { clearTimeout(t); release(); }
}
class Cut { constructor(readonly cause: "stopped" | "timeout") {} }

async function runNow(method: "workspace.run_notebook" | "workspace.run_file", params: { path: string; timeout_s?: number }, ctx: RunCtx, host: RunHost, holder: RunHolder, pre: RunHolder["current"], look: <T>(p: Promise<T>) => Promise<T>): Promise<Record<string, unknown>> {
  const g = ctx.grant;
  if (!g.run) refuse(RUN_TEXT.notAllowed);
  if (host.sandbox !== "ok") refuse(RUN_TEXT.noSandbox);
  const real = norm(params.path);
  if (real === null || !inGrant(real, g.folders)) refuse(RUN_TEXT.unreadable(String(params.path)));
  if (within(real!, TRASH) || within(real!, PROPOSALS)) refuse(RUN_TEXT.notHere(real!));
  // (busy before anything is read: this grant's own run, or another's, which isn't named)
  const cur = holder.current;
  if (cur && cur !== pre) refuse(cur.owner === g.id ? RUN_TEXT.busyOwn(cur.view) : RUN_TEXT.busyOther);
  const ws = host.ws.runHost(ctx.actor, () => g.id);
  // (the worktree: /Branches/<name>, this grant's own ready branch, by the branches' rule as a write there is asked)
  let root = "", rootFid: string | undefined;
  if (within(real!, BRANCHES)) {
    const b = await look(ws.branchAt(real!));
    if (b.no || !b.root) refuse("invalid: " + (b.no ?? "not in a branch"));
    root = b.root!.path; rootFid = b.root!.fid;
  }
  const view = viewOf(root);
  const target = await look(ws.stat(real!));
  if (!target) refuse(RUN_TEXT.noSuch(real!));
  if (target.trashed) refuse(RUN_TEXT.notHere(real!));
  if (method === "workspace.run_notebook" && target.kind !== "notebook") refuse(RUN_TEXT.notNotebook(real!));
  if (method === "workspace.run_file" && !(target.kind === "file" && /\.(py|sage)$/i.test(real!))) refuse(RUN_TEXT.notCode(real!));
  if (!ctx.live()) refuse("invalid: " + ctx.why());
  if (holder.current && holder.current !== pre) { const c = holder.current; refuse(c.owner === g.id ? RUN_TEXT.busyOwn(c.view) : RUN_TEXT.busyOther); }
  if (pre?.loading?.stopped) return { ok: false, ended: pre.loading.cause ?? "stopped", ms: 0 };

  // ---- the run, held: from here every way out goes through end() and settle()
  const viewPath = view.toView(real!)!;
  const t0 = performance.now();
  let phase: Phase = "open", cause: "done" | "error" | "stopped" | "timeout" | "revoked" = "done", reason = "";
  let kernel: any = null, worker: any = null, gen = 0;
  const pending = new Set<Promise<unknown>>();
  let chain: Promise<unknown> = Promise.resolve();
  // (the refused, kept as they come: bounded (astra's RUN-BOUND-3); in the view's paths, as said)
  const refused = new Refused((v) => { const p = view.toReal(v); return p !== null && inGrant(p, g.folders); });
  const refuseAt = (realOrView: string, isView = false) => refused.add(isView ? realOrView : view.toView(realOrView) ?? realOrView);
  // (what's kept now, for the tests' holds: the retained bytes of what waits and what will be saved)
  let queuedBytes = 0, queuedOps = 0, savedLeft = RUN_LIMITS.savedOutputs, savedKept = 0;
  let ended!: () => void;
  const endedP = new Promise<void>((r) => (ended = r));
  // (`stopped`: an end asked (Stop, run_stop, the deadline, the grant, the page hidden), at any stage until the run
  //  settles, its own save and delivery included: astra's RUN-SAVE-STOP-1)
  let stopped = false;
  const end = (c: typeof cause, why = "") => {
    if (stopped) return;
    stopped = true;
    phase = "closing"; // (first, synchronously: nothing is admitted after this)
    cause = c; reason = why;
    clearTimeout(deadline);
    holder.hide();
    try { kernel?.close("\n"); } catch {}
    try { worker?.terminate(); } catch {}
    ended();
  };
  const me = { owner: g.id, view: viewPath, stop: () => end("stopped"), retained: () => ({ queuedBytes, queuedOps, pending: pending.size, savedBytes: savedKept }) };
  holder.current = me;
  holder.show(ctx.agent, viewPath, me.stop);
  // (the deadline counts from the call's start, the chunk's load and the checks above included (daybreak3's P1): the
  //  pairing's record carries it)
  const timeoutS = params.timeout_s ?? RUN_LIMITS.timeoutDefault;
  const deadline = setTimeout(() => end("timeout"), Math.max(0, (pre?.deadlineAt ?? performance.now() + timeoutS * 1000) - performance.now()));
  // ---- where its code may write (§3): fixed from here (the ceiling), only narrowing
  const grantTrees = (gr: Grant | null) => (gr && gr.write ? gr.folders : []);
  const docTrees = () => (root ? [root] : method === "workspace.run_notebook" && target!.ref ? host.docTrees(target!.ref) : []);
  // (the ceiling only narrows: each time the trees are asked (the grant's change, the notebook's permissions' change,
  //  each admission), what's allowed now is met with it and kept, so a narrowing can't be undone by a widening later
  //  in the same run (astra's RUN-POLICY-2))
  let ceiling = meetTrees(docTrees(), grantTrees(g));
  const treesNow = () => (ceiling = meetTrees(ceiling, meetTrees(docTrees(), grantTrees(ctx.grantNow()))));
  const viewTrees = (t: string[]) => t.map((x) => view.toView(x)).filter((x): x is string => x !== null);
  let epoch = 1, sent = viewTrees(ceiling);
  // (the trees asked, every time: the ceiling narrows, and what the interpreter is to be given follows it under a new
  //  epoch, even before the interpreter exists, so its start is given the latest (astra's RUN-POLICY-2 r3))
  const latest = () => {
    const next = viewTrees(treesNow());
    if (next.length === sent.length && next.every((t, i) => t === sent[i])) return;
    sent = next; epoch++;
  };
  const policyNow = () => {
    const was = epoch;
    latest();
    if (epoch !== was && phase === "open" && kernel?.worker) kernel.setPolicy({ epoch, state: stateOf(sent), trees: sent });
  };
  // (the grant: gone, run off or read narrowed end the run; a write-only narrowing reaches the interpreter)
  // (the page leaving ends it as Stop does: §2)
  const onHide = () => end("stopped");
  addEventListener("pagehide", onHide);
  const unwatch = ctx.onChange(() => {
    if (!ctx.live()) return end("revoked", ctx.why());
    policyNow();
  });
  const undoc = host.docChange?.(policyNow) ?? (() => {});
  try {
    // ---- the snapshot (§4): the files the grant can read in the view, each read once, bounded
    await host.hold?.("snapshot");
    const all = await ws.list(root || "/");
    const files: [string, Uint8Array][] = [], items: { view: string; kind: string; sha256: string }[] = [];
    let bytes = 0, pathBytes = 0, count = 0;
    const readable = (p: string) => inGrant(p, g.folders) && view.toView(p) !== null;
    for (const e of all as any[]) {
      if (e.kind !== "file" || e.trashed || e.remote || !readable(e.path)) continue;
      if (++count > RUN_LIMITS.files) refuse(RUN_TEXT.tooManyFiles(all.filter((x: any) => x.kind === "file" && readable(x.path)).length));
      pathBytes += enc.encode(view.toView(e.path)!).length; // (view paths, as ruled: never the branch's prefix)
      if (pathBytes > RUN_LIMITS.pathBytes) refuse(RUN_TEXT.tooManyPaths(pathBytes));
      bytes += e.size ?? 0;
      if (bytes > RUN_LIMITS.bytes) refuse(RUN_TEXT.tooManyBytes(bytes));
    }
    await host.hold?.("listed");
    let read = 0;
    // (a read admitted holding the lock: the grant still this run's, the path readable, and in a worktree its branch
    //  root still the one it started with (astra's RUN-READ-BOUND-4))
    const admitRead = (c: any) => {
      if (phase !== "open" || !ctx.live() || !readable(c.path)) throw new RunError("fenced", "the run ended");
      if (root && c.branch?.root?.fid !== rootFid) throw new RunError("changed", RUN_TEXT.changed(viewPath));
    };
    for (const e of all as any[]) {
      if (phase !== "open") break;
      if (e.kind !== "file" || e.trashed || e.remote || !readable(e.path)) continue;
      // (at most what's left of the 64 MiB, checked holding the lock before anything is read: a file grown since it was
      //  listed is refused, never read whole)
      let r: { entry: any; content: Uint8Array };
      try { r = await ws.readUpTo(e.path, RUN_LIMITS.bytes - read, admitRead); }
      catch (x: any) {
        if (x?.code === "limit") refuse(RUN_TEXT.tooManyBytes(read + Math.max(e.size ?? 0, RUN_LIMITS.bytes - read + 1)));
        if (x instanceof RunError && x.code === "fenced") break;
        throw x instanceof RunError ? x : new RunError("changed", RUN_TEXT.changed(view.toView(e.path) ?? e.path));
      }
      // (the entry read is the one listed: another file put at its path meanwhile is a change, not this input)
      if (r.entry?.kind !== "file" || r.entry.fid !== e.fid) throw new RunError("changed", RUN_TEXT.changed(view.toView(e.path) ?? e.path));
      const u = r.content;
      read += u.length;
      if (read > RUN_LIMITS.bytes) refuse(RUN_TEXT.tooManyBytes(read));
      const v = view.toView(e.path)!;
      files.push([v, u]);
      items.push({ view: v, kind: "file", sha256: await sha(u) });
    }
    if (!ctx.live() && phase === "open") end("revoked", ctx.why());
    // ---- what runs: the notebook's code cells (bounded), or the file's text
    let doc: any = null, rev = 0, ref: string | undefined, code = "";
    if (method === "workspace.run_notebook") {
      const r = await ws.read(real!, admitRead);
      if (r.entry?.kind !== "notebook" || r.entry.ref !== target.ref) throw new RunError("changed", RUN_TEXT.changed(viewPath));
      doc = r.content; rev = r.rev; ref = r.entry?.ref;
      const cells = Array.isArray(doc?.cells) ? doc.cells : [];
      if (cells.length > RUN_LIMITS.cells) refuse(RUN_TEXT.tooManyCells(cells.length));
      const src = cells.reduce((n: number, c: any) => n + enc.encode(String(c?.code ?? "")).length, 0);
      if (src > RUN_LIMITS.source) refuse(RUN_TEXT.tooMuchSource(src));
      items.push({ view: viewPath, kind: "notebook", sha256: await sha(notebookInputs(doc)) });
    } else {
      const u = files.find(([v]) => v === viewPath)?.[1];
      try { code = new TextDecoder("utf-8", { fatal: true }).decode(u ?? new Uint8Array()); } catch { refuse(RUN_TEXT.notText(real!)); }
    }
    const hash = await inputHash(items);
    if (phase !== "open") return await settle(hash);

    // (whether the change at `p` (real) from `w` may be kept now: this run open, its interpreter, the trees now)
    const admitNow = (w: any, p: string) => phase === "open" && w === kernel?.worker && ctx.live() && treesNow().some((t) => covers(t, p));
    const keep = (w: any, changes: [string, Uint8Array | null][]) => {
      const reals = changes.map(([v]) => view.toReal(v));
      if (reals.some((p) => p === null) || !reals.every((p) => admitNow(w, p!))) { for (let i = 0; i < reals.length; i++) reals[i] ? refuseAt(reals[i]!) : refuseAt(changes[i][0], true); return; }
      // (what waits to be kept is bounded by its bytes: past it, the change is refused, not queued (RUN-BOUND-3))
      const n = changes.reduce((t, [, d], i) => t + (d?.length ?? 0) + enc.encode(reals[i]!).length + RUN_LIMITS.opBytes, 0);
      if (queuedBytes + n > RUN_LIMITS.queued || queuedOps + changes.length > RUN_LIMITS.queuedOps) { for (const p of reals) refuseAt(p!); return; }
      queuedBytes += n; queuedOps += changes.length;
      // (in order, one at a time; each admitted again holding the workspace's lock, where it is final: once passed, it
      //  completes and is kept even if the run ends meanwhile (RUN-DRAIN-1); before, nothing is kept)
      chain = chain.then(async () => {
        for (let i = 0; i < changes.length; i++) {
          const p = reals[i]!, data = changes[i][1];
          const admit = (c: any) => {
            if (!admitNow(w, p)) throw new RunError("fenced", "the run ended");
            if (root && c.branch?.root?.fid !== rootFid) throw new RunError("fenced", "the branch changed");
          };
          try { data === null ? await ws.remove(p, admit) : await ws.putFile(p, data, admit); }
          catch (e) { if (!(e instanceof RunError)) refuseAt(p); }
        }
        queuedBytes -= n; queuedOps -= changes.length;
      });
      // (only what hasn't settled is held: a settled change lets go of its data)
      const c = chain;
      pending.add(c);
      void c.finally(() => pending.delete(c));
    };

    // ---- the interpreter: the sandboxed runner only (§6), given the snapshot and the policy
    const viewDir = (() => { const d = viewPath.slice(0, viewPath.lastIndexOf("/")); return d || "/"; })();
    kernel = new host.WorkerKernel({
      createWorker: () => (worker = new host.RunnerWorker(host.runnerSrc, { name: "" })),
      onStart: (w: any) => {
        gen++;
        latest();
        w.postMessage({ fsWrite: { epoch, state: stateOf(sent), trees: sent } });
        w.postMessage({ startDir: viewDir });
        // (handed over, not copied twice: the runner may hold the message until its frame is ready, so the array sent is
        //  its own; the run keeps no copy (daybreak2's one retained body copy))
        const given = files.splice(0);
        w.postMessage({ files: given }, [...new Set(given.map(([, u]) => u.buffer))]);
      },
      onMessage: (m: any, w: any) => {
        if (m.pkgsetUsed !== undefined) return true;
        if (m.fsRefused !== undefined) { if (typeof m.fsRefused === "string") refuseAt(m.fsRefused, true); return true; }
        if (m.fsChanged === undefined && m.fsRename === undefined) return false;
        if (w !== kernel.worker || phase !== "open") return true;
        const ok = (d: unknown) => d === null || d instanceof Uint8Array;
        if (m.fsRename !== undefined) {
          const ch = m.fsRename?.changes;
          if (!Array.isArray(ch) || !ch.length || ch.length > 4096 || !ch.every((x: any) => Array.isArray(x) && x.length === 2 && canonical(x[0]) && ok(x[1]))) return true;
          const real = ch.filter(([p]: [string]) => !SCRATCH.test(p));
          if (real.length) keep(w, real);
          return true;
        }
        if (!canonical(m.fsChanged) || !ok(m.data) || SCRATCH.test(m.fsChanged)) return true;
        keep(w, [[m.fsChanged, m.data]]);
        return true;
      },
    });
    await host.hold?.("start");
    if (phase !== "open") return await settle(hash);
    kernel.start();
    // (the sandbox's start, within the deadline: one that doesn't answer is said, never retried outside it)
    const started = await Promise.race([
      new Promise<boolean>((r) => { kernel.on("ready", () => r(true)); }),
      new Promise<boolean>((r) => setTimeout(() => r(false), RUN_LIMITS.startMs)),
      endedP.then(() => false),
    ]);
    if (!started && phase === "open") { end("error"); await drain(); refuse(RUN_TEXT.didntStart); }
    // (ended while the sandbox started: settled now, nothing executed, no interpreter started again (astra's
    //  RUN-START-STOP-2))
    if (phase !== "open") return await settle(hash);
    await host.hold?.("started");
    if (phase !== "open") return await settle(hash);

    // ---- run it, keeping what it says within the bounds (§7)
    // (outputs kept for a save only where there will be one: a worktree notebook (astra's RUN-BOUND-3))
    const saving = !!doc && !!root;
    const exec = (src: string, mode: string, cell?: string) => new Promise<{ status: "ok" | "error" | "stopped"; out: Kept; err: Kept; images: { count: number; bytes: number }; saved: any[] }>((resolve) => {
      const out = new Kept(method === "workspace.run_file" ? RUN_LIMITS.streamHead : RUN_LIMITS.cellHead, method === "workspace.run_file" ? RUN_LIMITS.streamTail : RUN_LIMITS.cellTail);
      const err = method === "workspace.run_file" ? new Kept(RUN_LIMITS.streamHead, RUN_LIMITS.streamTail) : out;
      // (images as their count and bytes only, never their bytes kept)
      const images = { count: 0, bytes: 0 }, saved: any[] = [];
      const savedOut = saving ? new Kept(RUN_LIMITS.streamHead, RUN_LIMITS.streamTail) : null, savedErr = saving ? new Kept(RUN_LIMITS.streamHead, RUN_LIMITS.streamTail) : null;
      // (one charge against what's left of the notebook's 8 MiB: kept if it fits, else one note and nothing more)
      const keepSaved = (o: any) => {
        if (savedLeft <= 0) return;
        const n = enc.encode(JSON.stringify(o)).length;
        if (n <= savedLeft) { saved.push(o); savedLeft -= n; savedKept += n; }
        else { saved.push({ output_type: "stream", name: "stderr", text: RUN_TEXT.notKept }); savedLeft = 0; }
      };
      // (a run closed meanwhile asks nothing more of its interpreter: an execute would start a new one)
      if (phase !== "open" || stopped) return resolve({ status: "stopped", out, err, images, saved });
      kernel.execute(src, { mode, ...(cell ? { cell } : {}) }, {
        start() {},
        out(t: string, isErr: boolean) { (isErr ? err : out).add(t); (isErr ? savedErr : savedOut)?.add(t); },
        display(b: any) {
          for (const [k, v] of Object.entries(b ?? {})) if (k.startsWith("image/") && typeof v === "string") { images.count++; images.bytes += v.length; }
          // (charged as it comes (daybreak2's SIZE-OUTPUT-6, astra's RUN-BOUND-3))
          if (saving) keepSaved({ output_type: "display_data", data: b ?? null, metadata: {} });
        },
        interact() {}, clear() {},
        input(_p: string, reply: (t: string | null) => void) { reply(null); },
        done(_ms: number, r: any) {
          if (saving) {
            const o = savedOut!.text(), e = savedErr!.text();
            if (o) { const before = saved.length; keepSaved({ output_type: "stream", name: "stdout", text: o }); if (saved.length > before) saved.unshift(saved.pop()); }
            if (e) keepSaved({ output_type: "stream", name: "stderr", text: e });
          }
          resolve({ status: r?.error ? "error" : "ok", out, err, images, saved });
        },
        stopped() { resolve({ status: "stopped", out, err, images, saved }); },
        skipped() { resolve({ status: "stopped", out, err, images, saved }); },
      });
    });
    const cellsOut: any[] = [];
    // (the cells' results charged as they come against the result's 256 KiB: past it, a cell keeps only its status
    //  (RUN-BOUND-3); bounded() still decides the whole)
    let resultLeft = RUN_LIMITS.result, resultCut = 0;
    let fileOut: Awaited<ReturnType<typeof exec>> | null = null;
    const ran = new Map<string, any[]>();
    if (doc) {
      const mode = typeof doc.mode === "string" ? doc.mode : "python";
      let failed = false;
      (doc.cells ?? []).forEach((c: any, i: number) => { if ((c?.type ?? "code") === "code") cellsOut.push({ index: i, status: "skipped", c }); });
      // (room kept first for every cell's status and the result's own fields, so a cell past the budget keeps its
      //  status and bounded() lists every cell (grader's R11))
      resultLeft -= cellsOut.reduce((t, co) => t + enc.encode(JSON.stringify({ index: co.index, status: "skipped" })).length + 1, RUN_LIMITS.refusedBytes + 1024);
      for (const co of cellsOut) {
        if (phase !== "open" || failed) break;
        const r = await exec(String(co.c.code ?? ""), mode, co.c.id);
        if (phase !== "open") break;
        co.status = r.status === "stopped" ? "skipped" : r.status;
        const o = r.out.text(), n = enc.encode(JSON.stringify({ index: co.index, status: co.status, out: o, images: r.images })).length;
        if (n <= resultLeft) { co.out = o; co.images = r.images; resultLeft -= n; } else resultCut++;
        if (saving) ran.set(String(co.c.id ?? co.index), r.saved);
        if (r.status === "error") failed = true;
      }
      if (phase === "open") cause = failed ? "error" : "done";
    } else {
      fileOut = await exec(code, /\.sage$/i.test(real!) ? "sage" : "python");
      if (phase === "open") cause = fileOut.status === "error" ? "error" : "done";
    }
    // ---- the end: admission closed first; then what was admitted settles (RUN-DRAIN-1)
    // (a run that ended by itself: what its code changed came before its end (one channel, in order), so it is all
    //  queued now; kept while the run is still open, then admission closes. An end by Stop, the deadline or the grant
    //  closed admission first (end()))
    const finished = phase === "open" && !stopped;
    if (finished) await drain();
    if (phase === "open") { phase = "closing"; try { kernel.close("\n"); } catch {} }
    await drain();
    // (outputs saved into the run's own worktree notebook only, if it is still that notebook (§9, SAVE-IDENTITY-2))
    let saved: string | undefined;
    if (doc) saved = root ? "conflict" : "not saved: main";
    if (finished && !stopped && doc && root && ctx.live()) {
      const cells = (doc.cells ?? []).map((c: any) => {
        const o = ran.get(String(c?.id ?? ""));
        return o ? { ...c, outputs: o } : c;
      });
      await host.hold?.("save");
      try {
        if (stopped) throw new RunError("fenced", "the run ended");
        await ws.write(real!, { ...doc, cells }, rev, (c: any) => {
          // (Stop, the deadline or the grant before this admission: nothing saved; after it, the save completes)
          if (stopped) throw new RunError("fenced", "the run ended");
          if (!ctx.live() || c.entry?.ref !== ref || c.branch?.root?.fid !== rootFid) throw new RunError("conflict", "conflict");
          if (!treesNow().some((t) => covers(t, real!))) throw new RunError("refused", "refused");
        });
        saved = "saved";
      } catch (e: any) { saved = e instanceof RunError && e.code === "refused" ? "refused" : "conflict"; }
    }
    await host.hold?.("deliver");
    // (settled: the line goes and the deadline with it)
    clearTimeout(deadline);
    holder.hide();
    if (!ctx.live()) { cause = "revoked"; reason = ctx.why(); }
    if (cause === "revoked") return { ok: false, ended: "revoked", reason };
    const base: Record<string, unknown> = { ok: cause === "done", ended: cause, ms: Math.round(performance.now() - t0), inputHash: hash, refused: refused.out() };
    // (an end by Stop or the deadline: its cause, nothing of what ran (RUN-DRAIN-1: no late normal result))
    if ((cause as string) === "stopped" || (cause as string) === "timeout") return base;
    if (doc) {
      const out = bounded({ ...base, saved }, [["cells", cellsOut.map(({ c: _c, ...x }) => x)]]);
      if (resultCut && !out.truncated) out.truncated = { omitted: [`the output of ${resultCut} cell${resultCut === 1 ? "" : "s"}`], reason: RUN_TEXT.truncated };
      return out;
    }
    return bounded({ ...base, exit: fileOut!.status === "error" ? 1 : 0, stdout: fileOut!.out.text(), stderr: fileOut!.err.text() }, []);
  } catch (e) {
    end(e instanceof RunError && e.code === "too_large" ? "error" : "error");
    await drain();
    throw e;
  } finally {
    unwatch(); undoc();
    removeEventListener("pagehide", onHide);
    if (holder.current === me) holder.current = null;
  }

  async function drain() {
    while (pending.size) { const ps = [...pending]; pending.clear(); await Promise.allSettled(ps); }
  }
  async function settle(hash: string) {
    await drain();
    if (cause === "revoked") return { ok: false, ended: "revoked", reason };
    return { ok: false, ended: cause, ms: Math.round(performance.now() - t0), inputHash: hash };
  }
}

/** run_stop: the calling grant's own run, if there is one. */
export function stop(ctx: RunCtx, holder: RunHolder) {
  const c = holder.current;
  if (!c || c.owner !== ctx.grant.id) return { stopped: false };
  c.stop();
  return { stopped: true };
}

// (a guard against an accidental import of the pairing chunk's own modules: this chunk names nothing but these)
export const RUN_CHUNK = nameOf("/sagebrush-agent-run.js");
