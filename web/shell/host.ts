// ShellHost: the page's mediator between the shell worker and the workspace (plan-bash-shell r3 §2–§3,
// addendum D8 r3).  The worker never holds the Workspace or any handle to it: each file call of an
// invocation is one fs.request (web/shell/loader.ts), which this answers with at most one workspace verb,
// checked at use.
//
// - **Principals** (r3 §2.1), bound by the page when it opens a run, never named by a request: the person
//   (the whole workspace), or a grant (folders by fid, write or not, live() re-read at every use: an agent's
//   pairing grant in step 7, a document's interpreter grants in step 5).
// - **Every request checked at use** (§2.2): the run's random 64-bit id, the canonical path (Trash refused),
//   the mode, the grant inside the verb's locked section through the workspace's admit option, on the
//   resolved entry's identity (api.ts AdmitCheck), revocation at every use.
// - **Writes bound to identity** (§3.2): every redirection target is the observation made at its open (a
//   present file's fid and rev, for `>>` its bytes too, from one readUpTo; or absent), checked under the
//   lock at commit, never re-observed.
// - **Redirections** (§3.3 rules 1–9): an open with `>` of an existing file is a pending truncation, of an
//   absent path a pending creation, both seen as empty by this run and committed at the invocation's
//   ordinary end (or before another mutation of that path); a non-empty write or append is one commit.
// - **The outcome is the host's** (D8 point 5): when an invocation ends, before anything pending is
//   committed or anything published, its outcome comes from what this host recorded and did: Stop (row 1),
//   a lost worker (2), a revoked or expired grant (3), a limit (4, step 3), a fault (5), else ordinary (6).
//   Rows 1–5 latch the run's terminal state and close its admission in the same step that records them
//   (the fence); a rejection of the shell's exec() is ordinary only if it names one of this invocation's
//   own refusals (provenance).
import { Workspace, WorkspaceError, identOf, type AdmitCheck, type Entry } from "../workspace/api";
import { normPath, parentOf, nameOf, join, within, TRASH, PathError } from "../workspace/paths";
import { ShellUnavailableError, type Shell, type ShellOutcome, type FsRequest, type FsAnswer } from "./loader";

/** Who a run belongs to (r3 §2.1). */
export type Principal =
  | { kind: "person" }
  | {
      kind: "grant";
      /** the op log's actor for its changes ("agent:<name>"; a document's, as its interpreter's) */
      actor?: string;
      /** the granted folders, by fid (design/capabilities.md §6): each covers what is inside it at the moment of use */
      folders: ReadonlySet<string>;
      write: boolean;
      /** read at every use: "ok", or the grant has been revoked or has expired */
      live: () => "ok" | "revoked" | "expired";
    };

/** A change the run committed, as results list them (r3 §5.3): local until sync says more (step 3). */
export type OpRecord = { verb: "write" | "create" | "mkdir" | "rename" | "remove" | "duplicate"; path: string; to?: string; rev?: number; committed: "local" };

/**
 * What an invocation came to (D8 point 5's rows): an ordinary end with the shell's final status (row 6),
 * or a typed one, which the forms raise (r3 §7.4) and which never carries a status.  `ops`: exactly what was
 * committed.
 */
export type HostOutcome =
  | { kind: "exit"; code: number; stdout: string; stderr: string; ops: OpRecord[] }
  | { kind: "interrupted"; row: 1; ops: OpRecord[] }
  | { kind: "unavailable"; row: 2 | 3 | 5; reason: string; ops: OpRecord[] }
  | { kind: "limit"; row: 4; key: string; value: number; ops: OpRecord[] };

/** The pending entries a run may hold at once (r3 §3.3 rule 2): past it, EMFILE. */
export const MAX_PENDING = 64;
/** How long Stop waits for the shell to unwind before the worker is ended (r3 §4.3). */
export const STOP_GRACE_MS = 2000;
/** The bytes one read may return (bash.read_bytes's default, r3 §4.2 B; the key itself is step 3's). */
export const READ_BYTES = 64 * 2 ** 20;

/** A refusal of a request: an errno, what the shell prints, recorded under an id of the run's. */
class Refusal extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}
/** The grant was revoked or expired at a use (row 3). */
class Revoked extends Error {}

// The words the workspace's refusals print with (r3 §3.1's table).
const REASON: Record<string, string> = { ENOENT: "No such file or directory", EEXIST: "File exists", ECONFLICT: "changed elsewhere", ENOTDIR: "Not a directory", EISDIR: "Is a directory", EACCES: "Permission denied" };
function refusalOf(err: unknown, p: string): Refusal | null {
  if (err instanceof Refusal) return err;
  if (err instanceof PathError) return new Refusal("EINVAL", `${p}: ${err.message}`);
  if (!(err instanceof WorkspaceError)) return null;
  const code = { exists: "EEXIST", missing: "ENOENT", conflict: "ECONFLICT", storage: "ENOSPC", invalid: "EINVAL", quarantined: "EROFS", busy: "EBUSY" }[err.code as string] ?? (err.code === "limit" ? (/at most \d+ bytes|larger than/.test(err.message) ? "EFBIG" : "ENOSPC") : null);
  if (!code) return null;
  return new Refusal(code, `${p}: ${REASON[code] ?? err.message}`);
}
const refuse = (code: string, p: string, why = REASON[code]) => new Refusal(code, `${p}: ${why}`);

const hex = (n: number) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, "0")).join("");
const concat = (a: Uint8Array, b: Uint8Array) => {
  const c = new Uint8Array(a.length + b.length);
  c.set(a);
  c.set(b, a.length);
  return c;
};
const EMPTY = new Uint8Array(0);
const expectOf = (e: Entry) => ({ kind: e.kind, ref: e.ref, fid: e.fid, created: e.created });

/** A redirection target's observation (§3.2): the file as this run saw it at the open, or after its own commit. */
type Obs = { fid: string; rev: number; bytes?: Uint8Array };
type Terminal = { row: 1 } | { row: 2 | 3 | 5; reason: string } | { row: 4; key: string; value: number };

/** One run (r3 §4.4): one execution request, with its own id, ledger, fence and pending writes. */
export class ShellRun {
  readonly id = hex(8);
  /** the latched terminal condition (D8 point 5's fence): once set, nothing more is admitted */
  terminal: Terminal | null = null;
  readonly ops: OpRecord[] = [];
  /** the refusals made, by id, with the invocation each was made in */
  private refusals = new Map<string, number>();
  private obs = new Map<string, Obs>();
  private pending = new Map<string, "trunc" | "create">();
  private queue: Promise<unknown> = Promise.resolve();
  private invocation = 0;
  private stopping: AbortController | null = null;
  private stopTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private host: ShellHost, readonly principal: Principal) {}

  /** Latch a terminal condition and close admission, in this one step (the fence). */
  latch(t: Terminal) {
    if (!this.terminal) this.terminal = t;
  }

  /** Stop (r3 §4.3, row 1): latched at once; the shell's signal aborted; the worker ended if it hasn't unwound within 2 s. */
  stop() {
    this.latch({ row: 1 });
    this.stopping?.abort();
    if (this.stopping && !this.stopTimer) this.stopTimer = setTimeout(() => this.host.endShell("it didn't stop within 2 s"), STOP_GRACE_MS);
  }

  /** One invocation of the run: `{ SCRIPT\n}` (D8 point 1) in `cwd`, classified by this host. */
  async invoke(script: string, opts: { stdin?: string; cwd?: string } = {}): Promise<HostOutcome> {
    const n = ++this.invocation;
    if (this.terminal) return this.typed();
    let shell: Shell;
    try {
      shell = await this.host.shellFor();
    } catch (err) {
      this.latch({ row: 2, reason: err instanceof ShellUnavailableError ? err.reason : String((err as Error)?.message ?? err) });
      return this.typed();
    }
    const ctl = (this.stopping = new AbortController());
    let o: ShellOutcome | null = null;
    try {
      o = await shell.exec(`{ ${script}\n}`, { stdin: opts.stdin, cwd: opts.cwd ?? "/", run: this.id, signal: ctl.signal, onRequest: (r) => this.admit(n, r) });
    } catch (err) {
      // (the worker was lost, or ended by Stop's grace: row 2 unless Stop came first)
      this.latch({ row: 2, reason: err instanceof ShellUnavailableError ? err.reason : String((err as Error)?.message ?? err) });
    } finally {
      this.stopping = null;
      if (this.stopTimer) clearTimeout(this.stopTimer);
      this.stopTimer = null;
    }
    // (everything admitted has finished before the outcome is decided: the last request's answer may still be in the queue)
    await this.queue.catch(() => {});
    // (D8 point 5: the host's facts first; the shell's status never decides a typed outcome)
    if (this.terminal) return this.typed();
    if (o && "rejected" in o) {
      const r = o.rejected.refusal;
      // (provenance: only a refusal this host recorded for this very invocation; never inferred from what came last)
      if (r === null || this.refusals.get(r) !== n) {
        this.latch({ row: 5, reason: `internal error: the shell's run failed (${o.rejected.message.slice(0, 200)})` });
        return this.typed();
      }
      return this.ordinary({ code: 1, stdout: "", stderr: o.rejected.message.endsWith("\n") ? o.rejected.message : o.rejected.message + "\n" });
    }
    return this.ordinary(o!.exit);
  }

  private typed(): HostOutcome {
    // (pending truncations and creations are dropped, unflushed: rule 7)
    this.pending.clear();
    const t = this.terminal!, ops = [...this.ops];
    if (t.row === 1) return { kind: "interrupted", row: 1, ops };
    if (t.row === 4) return { kind: "limit", row: 4, key: t.key, value: t.value, ops };
    return { kind: "unavailable", row: t.row, reason: t.reason, ops };
  }

  // An ordinary end (row 6): what is pending committed (D8 point 4), then the shell's final status.  A
  // pending commit refused now (changed elsewhere meanwhile) is said on stderr, and makes a 0 status 1.
  private async ordinary(r: { code: number; stdout: string; stderr: string }): Promise<HostOutcome> {
    let { code, stderr } = r;
    for (const p of [...this.pending.keys()].sort()) {
      try {
        await this.flush(p);
      } catch (err) {
        const ref = refusalOf(err, p);
        if (!ref) {
          this.latch({ row: 5, reason: `internal error: ${(err as Error)?.message ?? err}` });
          return this.typed();
        }
        stderr += `bash: ${ref.message}\n`;
        if (code === 0) code = 1;
      }
    }
    return { kind: "exit", code, stdout: r.stdout, stderr, ops: [...this.ops] };
  }

  // Each request in turn: at most one admitted at a time, so after a latch at most the one already
  // admitted finishes (D8 point 5's one allowance), and the rest are refused without workspace work.
  private admit(n: number, r: FsRequest): Promise<FsAnswer> {
    const next = this.queue.then(() => this.answer(n, r));
    this.queue = next.catch(() => {});
    return next;
  }

  private async answer(n: number, { op, args }: FsRequest): Promise<FsAnswer> {
    if (this.terminal || n !== this.invocation) return { err: { code: "EBADF", message: "this run has ended" } };
    const p = typeof args[0] === "string" ? args[0] : "";
    try {
      return { ok: await this.verb(op, args) };
    } catch (err) {
      if (err instanceof Revoked) {
        // (row 3: latched before the answer goes back; the refusal is EACCES, but not an ordinary one)
        this.latch({ row: 3, reason: "access was revoked" });
        return { err: { code: "EACCES", message: `${p}: access was revoked` } };
      }
      const ref = refusalOf(err, p);
      if (!ref) {
        // (row 5: a failure, not a refusal; latched before the answer goes back)
        this.latch({ row: 5, reason: `internal error: ${String((err as Error)?.message ?? err).slice(0, 200)}` });
        return { err: { code: "EIO", message: `${p}: internal error` } };
      }
      const id = hex(8);
      this.refusals.set(id, n);
      return { err: { code: ref.code, message: ref.message, refusal: id } };
    }
  }

  // ---------------------------------------------------------------- the verbs (r3 §3.1)

  private get ws(): Workspace {
    return this.host.workspaceFor(this.principal);
  }
  // (the canonical path, §2.2 step 3: the workspace's own rules; Trash is the workspace's, never the shell's)
  private canon(p: unknown): string {
    const q = normPath(p);
    if (within(q, TRASH) && q !== "/") throw refuse("EACCES", q, "Trash is the workspace's: restore or empty it in the file browser");
    return q;
  }
  // (the grant at use, §2.2 step 4: asked by the workspace inside the verb's locked section)
  private get check(): ((c: AdmitCheck) => void) | undefined {
    const pr = this.principal;
    if (pr.kind === "person") return undefined;
    return (c: AdmitCheck) => {
      if (pr.live() !== "ok") throw new Revoked();
      const covered = c.chain.some((e) => !!e.fid && pr.folders.has(e.fid)) || (c.entry?.kind === "folder" && !!c.entry.fid && pr.folders.has(c.entry.fid));
      if (!covered) throw refuse("EACCES", c.path, "Permission denied (outside this shell's access)");
    };
  }
  private live() {
    if (this.principal.kind === "grant" && this.principal.live() !== "ok") throw new Revoked();
  }
  // (§2.2 steps 5–6: a mutation needs write, and the grant is re-read now)
  private mutating(p: string) {
    const pr = this.principal;
    if (pr.kind === "grant") {
      if (pr.live() !== "ok") throw new Revoked();
      if (!pr.write) throw refuse("EROFS", p, "Read-only file system (this shell may only read)");
    }
  }
  private record(o: OpRecord) {
    this.ops.push(o);
  }

  private async verb(op: string, args: unknown[]): Promise<unknown> {
    switch (op) {
      case "read": return this.read(this.canon(args[0]));
      case "exists": return this.exists(this.canon(args[0]));
      case "stat": return this.statOf(this.canon(args[0]));
      case "list": return this.list(this.canon(args[0]));
      case "write": return this.write(this.canon(args[0]), bytes(args[1]));
      case "append": return this.append(this.canon(args[0]), bytes(args[1]));
      case "mkdir": return this.mkdir(this.canon(args[0]), args[1] === true);
      case "create": return this.createEmpty(this.canon(args[0]));
      case "rm": return this.rm(this.canon(args[0]), args[1] === true, args[2] === true);
      case "mv": return this.mv(this.canon(args[0]), this.canon(args[1]));
      case "cp": return this.cp(this.canon(args[0]), this.canon(args[1]), args[2] === true);
    }
    throw new Refusal("ENOTSUP", `${String(args[0] ?? "")}: ${op} isn't supported`);
  }

  private async read(p: string): Promise<Uint8Array> {
    if (p === "/") throw refuse("EISDIR", p);
    if (this.pending.has(p)) return EMPTY;
    const e = await this.ws.stat(p, { admit: this.check });
    if (!e) throw refuse("ENOENT", p);
    if (e.kind === "folder") throw refuse("EISDIR", p);
    if (e.kind === "file") return (await this.ws.readUpTo(p, READ_BYTES, { admit: this.check })).content;
    // (a notebook or board reads as its JSON text: the same document as stat admitted, by its ref)
    const r = await this.ws.read(p);
    if (r.entry.ref !== e.ref) throw refuse("ECONFLICT", p);
    const b = new TextEncoder().encode(JSON.stringify(r.content, null, 1) + "\n");
    if (b.length > READ_BYTES) throw refuse("EFBIG", p, `larger than ${READ_BYTES} bytes`);
    return b;
  }
  private async exists(p: string): Promise<boolean> {
    // (the top is always there; no grant names it, and saying so tells nothing)
    if (p === "/" || this.pending.has(p)) return true;
    try {
      return !!(await this.ws.stat(p, { admit: this.check }));
    } catch (err) {
      // (outside the grant is "not there" to a probe: nothing told, nothing refused)
      if (err instanceof Refusal && err.code === "EACCES") return false;
      throw err;
    }
  }
  // (`identity`: the entry's own (a data file's or folder's fid, a document's ref), which just-bash's mv and cp
  // compare to tell whether two paths are one file)
  private async statOf(p: string): Promise<{ kind: string; size: number; mtime: number; identity: string }> {
    if (p === "/") return { kind: "folder", size: 0, mtime: 0, identity: "top" };
    if (this.pending.has(p)) return { kind: "file", size: 0, mtime: Date.now(), identity: "pending:" + p };
    const e = await this.ws.stat(p, { admit: this.check });
    if (!e) throw refuse("ENOENT", p);
    return { kind: e.kind === "folder" ? "folder" : "file", size: e.size ?? 0, mtime: e.updated, identity: identOf(e) ?? "path:" + e.path };
  }
  private async list(p: string): Promise<{ name: string; kind: string }[]> {
    const e = p === "/" ? undefined : await this.ws.stat(p, { admit: this.check });
    if (p !== "/" && !e) throw refuse("ENOENT", p);
    if (e && e.kind !== "folder") throw refuse("ENOTDIR", p);
    // (the top itself, which no grant names, may be listed: what it shows is only what the grant covers)
    const check = this.check, top = check && ((c: AdmitCheck) => (c.role === "target" && c.path === "/" ? this.live() : check(c)));
    const out = (await this.ws.list(p, { admit: top })).map((x) => ({ name: nameOf(x.path), kind: x.kind === "folder" ? "folder" : "file" }));
    const have = new Set(out.map((x) => x.name));
    for (const q of this.pending.keys()) if (parentOf(q) === p && !have.has(nameOf(q))) out.push({ name: nameOf(q), kind: "file" });
    return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  // The target of a redirection's open, observed (§3.2): a data file's (fid, rev), absent, or refused.
  private async target(p: string, withBytes: boolean): Promise<Obs | null> {
    if (p === "/") throw refuse("EISDIR", p);
    const e = await this.ws.stat(p, { admit: this.check });
    if (e && e.kind === "folder") throw refuse("EISDIR", p);
    if (e && e.kind !== "file") throw refuse("EACCES", p, "a notebook or board: edit it in its editor");
    if (!e) {
      const up = parentOf(p), f = up === "/" ? null : await this.ws.stat(up, { admit: this.check });
      if (up !== "/" && !f) throw refuse("ENOENT", p);
      if (f && f.kind !== "folder") throw refuse("ENOTDIR", p);
      return null;
    }
    if (!withBytes) return { fid: e.fid!, rev: e.rev ?? 0 };
    // (`>>`: the entry and its bytes from one readUpTo, never a stat and then a separate read)
    // (and it must be the file just stated: changed between the two, it is a conflict, never a mixed observation)
    const r = await this.ws.readUpTo(p, READ_BYTES, { admit: this.check });
    if (r.entry.fid !== e.fid || (r.entry.rev ?? 0) !== (e.rev ?? 0)) throw refuse("ECONFLICT", p);
    return { fid: r.entry.fid!, rev: r.entry.rev ?? 0, bytes: r.content };
  }
  private hold(p: string, kind: "trunc" | "create") {
    if (!this.pending.has(p) && this.pending.size >= MAX_PENDING) throw refuse("EMFILE", p, `more than ${MAX_PENDING} redirections are pending in this run`);
    this.pending.set(p, kind);
  }
  // One commit of `b` as `p`'s whole contents, on its observation (rules 3, 4): a write with (base, fid), or an
  // exclusive create for a pending creation; the observation is then the commit's.
  private async commit(p: string, b: Uint8Array) {
    const pend = this.pending.get(p), o = this.obs.get(p);
    if (pend === "create" || (!o && pend === undefined)) {
      let e: Entry;
      try {
        e = await this.ws.create(p, { content: b, admit: this.check });
      } catch (err) {
        // (someone else made it meanwhile: of two creators exactly one wins, the newcomer untouched)
        if (err instanceof WorkspaceError && err.code === "exists") throw refuse("ECONFLICT", p);
        throw err;
      }
      this.pending.delete(p);
      this.obs.set(p, { fid: e.fid!, rev: e.rev ?? 0, bytes: b });
      this.record({ verb: "create", path: p, rev: e.rev ?? 0, committed: "local" });
      return;
    }
    if (!o) throw new Error(`${p}: a commit without its observation`);
    let out: { entry: Entry; rev: number };
    try {
      out = await this.ws.write(p, b, { base: o.rev, fid: o.fid, keepEmpty: false, admit: this.check });
    } catch (err) {
      if (err instanceof WorkspaceError && err.code === "missing") throw refuse("ECONFLICT", p);
      if (err instanceof WorkspaceError && err.code === "invalid" && !/at most|larger/.test(err.message)) throw refuse("EACCES", p, "a notebook or board now: edit it in its editor");
      throw err;
    }
    this.pending.delete(p);
    this.obs.set(p, { fid: out.entry.fid!, rev: out.rev, bytes: b });
    this.record({ verb: "write", path: p, rev: out.rev, committed: "local" });
  }
  // What is pending at `p` (or under it) committed now: before another mutation of it, and at the end (rule 1).
  private async flush(p: string) {
    for (const q of [...this.pending.keys()].sort()) if (within(q, p)) await this.commit(q, EMPTY);
  }

  private async write(p: string, b: Uint8Array) {
    this.mutating(p);
    if (b.length === 0) {
      // (rules 1 and 2: the open of `>`; an observation this run already holds is kept, never re-made)
      if (this.pending.has(p)) return;
      if (!this.obs.has(p)) {
        const o = await this.target(p, false);
        if (o) this.obs.set(p, o);
        return this.hold(p, o ? "trunc" : "create");
      }
      return this.hold(p, "trunc");
    }
    if (!this.pending.has(p) && !this.obs.has(p)) {
      const o = await this.target(p, false);
      if (o) this.obs.set(p, o);
    }
    await this.commit(p, b);
  }
  private async append(p: string, b: Uint8Array) {
    this.mutating(p);
    if (b.length === 0) {
      // (rules 2 and 5: the open of `>>`; the observation, with the bytes, taken once)
      if (this.pending.has(p) || this.obs.get(p)?.bytes) return;
      const o = await this.target(p, true);
      if (o) this.obs.set(p, o);
      else this.hold(p, "create");
      return;
    }
    if (this.pending.has(p)) return this.commit(p, b);
    let o = this.obs.get(p);
    if (!o?.bytes) {
      const t = await this.target(p, true);
      if (!t) {
        this.hold(p, "create");
        return this.commit(p, b);
      }
      this.obs.set(p, (o = t));
    }
    await this.commit(p, concat(o.bytes!, b));
  }
  private async mkdir(p: string, recursive: boolean) {
    this.mutating(p);
    const e = await this.ws.stat(p, { admit: this.check });
    if (e && (!recursive || e.kind !== "folder")) throw refuse("EEXIST", p);
    if (e) return;
    if (!recursive) {
      const up = parentOf(p), f = up === "/" ? null : await this.ws.stat(up, { admit: this.check });
      if (up !== "/" && !f) throw refuse("ENOENT", p);
      if (f && f.kind !== "folder") throw refuse("ENOTDIR", p);
    }
    await this.ws.mkdir(p, { admit: this.check });
    this.record({ verb: "mkdir", path: p, committed: "local" });
  }
  private async createEmpty(p: string) {
    this.mutating(p);
    if (this.pending.has(p)) throw refuse("EEXIST", p);
    await this.ws.create(p, { content: EMPTY, admit: this.check });
    this.record({ verb: "create", path: p, rev: 0, committed: "local" });
  }
  private forget(p: string) {
    for (const q of [...this.obs.keys()]) if (within(q, p)) this.obs.delete(q);
  }
  private async rm(p: string, recursive: boolean, force: boolean) {
    this.mutating(p);
    if (p === "/") throw refuse("EACCES", p, "the top folder can't be removed");
    await this.flush(p);
    const e = await this.ws.stat(p, { admit: this.check });
    if (!e) {
      if (force) return;
      throw refuse("ENOENT", p);
    }
    if (e.kind === "folder" && !recursive) throw refuse("EISDIR", p);
    // (always to Trash, everything in it, as one op; a large folder's rewrite settled before the next request: §3.4)
    await this.ws.remove(p, expectOf(e), undefined, { admit: this.check });
    await this.ws.rewriteSettled();
    this.forget(p);
    this.record({ verb: "remove", path: p, committed: "local" });
  }
  private async mv(a: string, b: string) {
    this.mutating(a);
    await this.flush(a);
    const e = await this.ws.stat(a, { admit: this.check });
    if (!e) throw refuse("ENOENT", a);
    if (await this.ws.stat(b, { admit: this.check })) throw refuse("EEXIST", b);
    await this.ws.rename(a, b, { expect: expectOf(e), admit: this.check });
    await this.ws.rewriteSettled();
    this.forget(a);
    this.record({ verb: "rename", path: a, to: b, committed: "local" });
  }
  // cp (§3.4): a data file, one duplicate; a folder (-r), walked first under admit, every descendant
  // admitted, or nothing is copied; then exactly F + D ops.  Documents are copied in the file browser.
  private async cp(a: string, b: string, recursive: boolean) {
    this.mutating(b);
    await this.flush(a);
    const e = await this.ws.stat(a, { admit: this.check });
    if (!e) throw refuse("ENOENT", a);
    if (await this.ws.stat(b, { admit: this.check })) throw refuse("EEXIST", b);
    if (e.kind !== "folder") {
      if (e.kind !== "file") throw refuse("EACCES", a, "a notebook or board: copy it in the file browser");
      await this.ws.duplicate(a, b, { admit: this.check });
      this.record({ verb: "duplicate", path: a, to: b, committed: "local" });
      return;
    }
    if (!recursive) throw refuse("EISDIR", a);
    let refused: Refusal | null = null;
    const walk = this.check && ((c: AdmitCheck) => {
      try {
        this.check!(c);
      } catch (err) {
        if (err instanceof Refusal) refused ??= err;
        throw err;
      }
    });
    const all = await this.ws.list(a, { recursive: true, admit: walk });
    if (refused) throw refused;
    const doc = all.find((x) => x.kind !== "file" && x.kind !== "folder");
    if (doc) throw refuse("EACCES", doc.path, "a notebook or board: copy it in the file browser");
    const to = (q: string) => b + q.slice(a.length);
    await this.ws.mkdir(b, { admit: this.check });
    this.record({ verb: "mkdir", path: b, committed: "local" });
    for (const x of all.sort((u, v) => (u.path < v.path ? -1 : 1))) {
      if (x.kind === "folder") {
        await this.ws.mkdir(to(x.path), { admit: this.check });
        this.record({ verb: "mkdir", path: to(x.path), committed: "local" });
      } else {
        await this.ws.duplicate(x.path, to(x.path), { admit: this.check });
        this.record({ verb: "duplicate", path: x.path, to: to(x.path), committed: "local" });
      }
    }
  }
}

function bytes(x: unknown): Uint8Array {
  if (x instanceof Uint8Array) return x;
  throw new Refusal("EINVAL", "a write's content is bytes");
}

/**
 * The page's shell host: one shell worker (from `start`, again after it is lost or ended by Stop), and the
 * workspace, which it never hands to the worker.  `run(principal)` opens a run; `exec` is one run of one
 * invocation (a panel line, a %%bash cell, a verb call).
 */
export class ShellHost {
  private shell: Shell | null = null;
  private starting: Promise<Shell> | null = null;
  private views = new Map<string, Workspace>();

  constructor(private ws: Workspace, private start: () => Promise<Shell>) {}

  /** The shell, started (again) if there is none or it has closed. */
  async shellFor(): Promise<Shell> {
    if (this.shell && this.shell.state === "open") return this.shell;
    this.shell = null;
    this.starting ??= this.start().then(
      (s) => ((this.shell = s), (this.starting = null), s),
      (err) => ((this.starting = null), Promise.reject(err)),
    );
    return this.starting;
  }
  /** Ends the shell worker (Stop's grace, r3 §4.3): what it was running fails, and the next run starts a fresh one. */
  endShell(_why: string) {
    this.shell?.terminate();
    this.shell = null;
  }
  /** The workspace as the principal changes it: its actor in the op log (r3 §2.1); never handed out. */
  workspaceFor(p: Principal): Workspace {
    if (p.kind === "person" || !p.actor) return this.ws;
    let v = this.views.get(p.actor);
    if (!v) {
      if (!/^agent:[\w.-]{1,64}$/.test(p.actor)) throw new Error("an actor is agent:<name>");
      v = Object.create(this.ws) as Workspace;
      v.actor = p.actor;
      this.views.set(p.actor, v);
    }
    return v;
  }
  run(principal: Principal): ShellRun {
    return new ShellRun(this, principal);
  }
  /** One run of one invocation; `signal` is Stop. */
  async exec(principal: Principal, script: string, opts: { stdin?: string; cwd?: string; signal?: AbortSignal } = {}): Promise<HostOutcome> {
    const r = this.run(principal);
    const onAbort = () => r.stop();
    if (opts.signal?.aborted) r.stop();
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      return await r.invoke(script, opts);
    } finally {
      opts.signal?.removeEventListener("abort", onAbort);
    }
  }
}
