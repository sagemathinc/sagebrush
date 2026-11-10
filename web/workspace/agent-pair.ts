// The page's side of a pairing with an agent on this computer (design/workspace-agent-protocol.md): a WebSocket
// to sagebrush-mcp on the loopback address, the hello with the code the agent gave, then, once the person has
// granted it something, the workspace verbs the agent calls, each checked here before it reaches the workspace.
//
// The server checks the origin, the code and the framing; it treats the grant as opaque (§2.3, 7).  So this page
// is the only guard on what the agent may touch, and every call passes, in order:
//   1. the frame: at most 8 KiB before the hello has paired, 12 MiB after, measured before it is parsed; strict
//      JSON (no key twice in an object) — else the socket closes (1009, 1007);
//   2. the verb and its params against schema.json (agent-schema.ts);
//   3. the grant (agent-grant.ts): folders, write, expiry;
//   4. the limits: 8 calls in flight, 100 a second (a burst of 200), 8 MiB of contents;
//   5. the workspace, through forAgent: every change credited to agent:<name>.
// Nothing the server sends is ever evaluated; the page sends it nothing but notifications after the hello.

import { checkCall, badValue, AGENT_LIMITS } from "./agent-schema";
import { editProblem, type NotebookEdit } from "./notebook-edit";
import { authorize, grantFolders, grantProblem, newGrantId, norm, GRANT_ID, type Grant, type TrashEntry } from "./agent-grant";
import { BRANCHES, BRANCH_NAME, BRANCH_TEXT } from "./branch-rules";
import { within } from "./paths";

/** What the hello's result says (the agent's own claims, shown as such). */
export type Hello = { protocol: 1; agent: { name: string; client: string; version?: string }; wants: { folders?: string[]; write?: boolean; run?: boolean }; session?: string; features?: string[] };
/** What a page may offer beyond the workspace's verbs, said in its hello and in the agent's: "notebook.edit", an
 * agent's edit of an open notebook by cell (web/workspace/notebook-edit.ts, A12 step 1). */
export const FEATURES = ["notebook.edit"] as const;
/** The verbs, as Workspace.forAgent gives them. */
export type AgentVerbs = {
  list(folder: string, opts?: { recursive?: boolean }): Promise<any[]>;
  stat(p: string): Promise<any | undefined | null>;
  read(p: string): Promise<{ entry: any; content: any; rev: number }>;
  write(p: string, content: unknown, opts?: { base?: number }): Promise<{ entry: any; rev: number }>;
  create(p: string, opts?: { content?: unknown; mode?: string }): Promise<any>;
  mkdir(p: string): Promise<any>;
  rename(from: string, to: string): Promise<any>;
  duplicate(p: string, to?: string): Promise<any>;
  remove(p: string): Promise<any>;
  restore(p: string, expect?: any): Promise<any>;
  history(p: string): Promise<any[]>;
  version(p: string, i: number): Promise<Uint8Array>;
  /** The workspace's check at use of a change made elsewhere (notebook.edit): the branches' rule, asked holding its
   * lock, which is kept until the returned release is called (or a few seconds pass). */
  holdChange?(p: string): Promise<() => void>;
};
/** git_branch, the page's (git-branch.ts, through Workspace.branchHost): the branch made for the grant `owner`. */
export type GitBranch = (a: { actor: string; name: string; owner: string; folders: string[]; live: () => boolean }) => Promise<unknown>;
/** Where the page keeps grants (Workspace.agentGrants / putAgentGrant). */
export type GrantStore = { agentGrants(): Promise<Record<string, unknown>>; putAgentGrant(id: string, g: unknown | null): Promise<void> };
/** A grant as kept: the grant, and the session secret if the person ticked "Remember this agent". */
export type Kept = { grant: Grant; session?: string; port: number };

export type PairState = "connecting" | "paired" | "granted" | "closed";

const PRE_HELLO_MAX = 8 * 1024;
const enc = new TextEncoder();

/** `text` parsed as strict JSON: what JSON.parse takes, and no object with a key twice (compared as decoded). */
export function parseStrict(text: string): unknown {
  const v = JSON.parse(text);
  // (a scan of the text for each object's keys, strings skipped: JSON.parse said the text is well formed)
  const stack: (Set<string> | null)[] = [];
  let expectKey = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      const top = stack[stack.length - 1];
      if (top && expectKey) {
        const k = JSON.parse(text.slice(i, j + 1)) as string;
        if (top.has(k)) throw new SyntaxError(`a JSON object repeats the key ${JSON.stringify(k.slice(0, 64))}`);
        top.add(k);
        expectKey = false;
      }
      i = j;
    } else if (c === "{") { stack.push(new Set()); expectKey = true; }
    else if (c === "[") { stack.push(null); }
    else if (c === "}" || c === "]") { stack.pop(); }
    else if (c === "," && stack[stack.length - 1]) expectKey = true;
  }
  return v;
}

/** The bytes of a frame, or more than `max` if it is surely over (a UTF-16 unit is at least one UTF-8 byte). */
const frameBytes = (s: string, max: number) => (s.length > max ? s.length : enc.encode(s).length);

/** An agent name as forAgent takes it: agent:<letters, digits, _ . ->, at most 64. */
export function actorOf(name: string, client: string): string {
  const n = (String(name || client || "agent").replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "agent").slice(0, 64);
  return "agent:" + n;
}

/** An entry as an agent sees it: its path, kind and what a person sees of it, nothing internal (ids, refs). */
function entryOut(e: any) {
  if (!e) return null;
  const out: Record<string, unknown> = { path: e.path, kind: e.kind, created: e.created, updated: e.updated };
  for (const k of ["mode", "size", "rev"]) if (e[k] !== undefined) out[k] = e[k];
  if (e.trashed) out.trashed = { from: e.trashed.from, at: e.trashed.at };
  return out;
}

const b64 = (u: Uint8Array) => { let s = ""; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** Contents' size in bytes, the same in both directions: a document's JSON text in UTF-8, a text's UTF-8 bytes,
 * a data file's bytes (base64's decoded length). */
export function contentBytes(c: { json: unknown } | { text: string } | { bytes: Uint8Array }): number {
  if ("json" in c) return enc.encode(JSON.stringify(c.json)).length;
  if ("text" in c) return enc.encode(c.text).length;
  return c.bytes.length;
}
const tooBig = (n: number, what: string) => new AgentError("limit", `${what}: ${n} bytes of contents, at most ${AGENT_LIMITS.maxContentBytes} in one call`);
/** Contents on the wire: a document as {json}; a data file as {text} if it is UTF-8, else {base64}; over 8 MiB
 * refused with their size (never cut). */
function contentOut(kind: string, c: unknown, what: string) {
  const MAX = AGENT_LIMITS.maxContentBytes;
  if (kind === "notebook" || kind === "board") { const n = contentBytes({ json: c }); if (n > MAX) throw tooBig(n, what); return { json: c }; }
  if (typeof c === "string") { const n = contentBytes({ text: c }); if (n > MAX) throw tooBig(n, what); return { text: c }; }
  const u = c instanceof Uint8Array ? c : c instanceof ArrayBuffer ? new Uint8Array(c) : null;
  if (!u) throw new AgentError("storage", "contents in an unknown form");
  if (u.length > MAX) throw tooBig(u.length, what);
  try { return { text: new TextDecoder("utf-8", { fatal: true }).decode(u) }; } catch { return { base64: b64(u) }; }
}
/** Contents from the wire (8 MiB at most, refused with their size, never cut). */
function contentIn(c: any, what: string): unknown {
  const v = "json" in c ? { json: c.json } : "text" in c ? { text: c.text as string } : { bytes: unb64(c.base64) };
  const n = contentBytes(v);
  if (n > AGENT_LIMITS.maxContentBytes) throw tooBig(n, what);
  return "json" in v ? v.json : "text" in v ? v.text : v.bytes;
}

export class AgentError extends Error {
  constructor(public code: string, message: string, public extra: Record<string, unknown> = {}) { super(message); }
}

/** The pairing.  `verbsFor(actor)` gives the workspace's verbs credited to `actor` (Workspace.forAgent). */
// (what is said when the grant changed under a call: nothing of what it read, and, for a change, no claim either way)
const CHANGED_WHILE_RUNNING = "the grant changed or expired while this ran: nothing of it is said (a change may or may not have been made)";

export class AgentPairing {
  state: PairState = "connecting";
  hello: Hello | null = null;
  grant: Grant | null = null;
  changes = 0;
  closeReason = "";
  private sock: WebSocket;
  private verbs: AgentVerbs | null = null;
  private inFlight = 0;
  private tokens: number;
  private refill: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<() => void>();
  private notified = new Set<(method: string, params: unknown) => void>();
  private pairingId = "";
  private remember = false;
  private helloSent: Promise<Hello>;
  // (A14: the session secret this pairing holds, from the hello or the reload record it was restored from; its
  //  generation, so an older pairing's end can't touch a newer one's record; the record it would restore from after
  //  an involuntary loss, kept in memory only)
  private sessionSecret: string | undefined;
  private readonly gen = ++pairingGen;
  lostRecord: ReloadRecord | null = null;
  private revoked = false;

  constructor(
    readonly port: number,
    how: { code: string } | { session: string; pairingId: string; agent?: { name: string; client: string } },
    private opts: { verbsFor: (actor: string, host: { owner: () => string | null }) => AgentVerbs; gitBranch?: GitBranch; store: GrantStore; trashEntry: (p: string) => Promise<TrashEntry | null | undefined>; page: { origin: string; path: string }; now?: () => number; WebSocketImpl?: typeof WebSocket; notebookEdit?: (edit: NotebookEdit, may: () => boolean, hold?: () => Promise<() => void>) => Promise<unknown>; reload?: { storage: ReloadStorage | null; scope: ReloadScope; leaving: () => boolean } },
  ) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new AgentError("invalid", "a port is 1 to 65535");
    const now = this.now();
    this.tokens = AGENT_LIMITS.burst;
    this.refill = now;
    const WS = opts.WebSocketImpl ?? WebSocket;
    this.sock = new WS(`ws://127.0.0.1:${port}/sagebrush`);
    if ("pairingId" in how) { this.pairingId = how.pairingId; this.sessionSecret = how.session; }
    this.helloSent = new Promise<Hello>((resolve, reject) => {
      this.sock.onopen = () => {
        const params: Record<string, unknown> = { protocol: 1, page: opts.page };
        if ("code" in how) params.code = String(how.code).trim().replace(/[\s-]+/g, "");
        else params.session = how.session;
        this.sock.send(JSON.stringify({ jsonrpc: "2.0", id: "p1", method: "hello", params }));
      };
      this.sock.onerror = () => {};
      this.sock.onclose = (e) => {
        const why = this.closeReason || e.reason || (e.code === 1006 ? "the connection failed (is the agent's sagebrush-mcp running, and is this browser allowed to reach it?)" : `closed (${e.code})`);
        this.end(why);
        reject(new AgentError("refused", why));
      };
      this.sock.onmessage = (e) => {
        if (this.state === "closed") return; // (nothing after the end)
        if (typeof e.data !== "string") return this.close(1003, "only text frames");
        const max = this.state === "connecting" ? PRE_HELLO_MAX : AGENT_LIMITS.maxFrameBytes;
        if (frameBytes(e.data, max) > max) return this.close(1009, `a message over ${max} bytes`);
        let msg: any;
        try { msg = parseStrict(e.data); } catch (err) { return this.close(1007, "not strict JSON: " + (err as Error).message); }
        if (!msg || typeof msg !== "object" || Array.isArray(msg) || msg.jsonrpc !== "2.0") return this.close(1002, "not JSON-RPC 2.0");
        if (this.state === "connecting") {
          if (msg.id !== "p1") return this.close(1002, "the first answer must be the hello's");
          if (msg.error) {
            const m = String(msg.error?.data?.message ?? msg.error?.message ?? "refused").slice(0, 300);
            this.end("the agent refused: " + m);
            return reject(new AgentError(String(msg.error?.data?.code ?? "refused"), m));
          }
          const r = msg.result;
          if (!r || r.protocol !== 1 || !r.agent || typeof r.agent.name !== "string") return this.close(1002, "a hello result in an unknown form");
          this.hello = { protocol: 1, agent: { name: String(r.agent.name).slice(0, 80), client: String(r.agent.client ?? "").slice(0, 40), version: r.agent.version ? String(r.agent.version).slice(0, 40) : undefined }, wants: { folders: Array.isArray(r.wants?.folders) ? r.wants.folders.slice(0, 50).map(String) : undefined, write: !!r.wants?.write, run: !!r.wants?.run }, session: typeof r.session === "string" ? r.session : undefined, features: Array.isArray(r.features) ? r.features.filter((f: unknown): f is string => typeof f === "string" && (FEATURES as readonly string[]).includes(f)) : [] };
          // (A14: a restore's session must be answered by the agent it was given to, name and client; else closed)
          if ("agent" in how && how.agent && (this.hello.agent.name !== how.agent.name || this.hello.agent.client !== how.agent.client)) {
            this.close(1000, "another agent answered this page's session");
            return reject(new AgentError("identity", "another agent answered this page's session"));
          }
          if (!this.pairingId) this.pairingId = [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, "0")).join("");
          if (this.hello.session) this.sessionSecret = this.hello.session;
          this.state = "paired";
          this.emit();
          return resolve(this.hello);
        }
        if (typeof msg.method === "string" && msg.id === undefined) {
          // (a notification: the chat on the same connection, §4; only once paired, given to the page's listeners)
          for (const cb of this.notified) cb(msg.method, msg.params);
          return;
        }
        if (typeof msg.method === "string" && typeof msg.id === "string") return void this.call(msg.id, msg.method, msg.params);
        // (an answer: the page sends no requests after the hello)
      };
    });
  }

  private now() { return this.opts.now ? this.opts.now() : Date.now(); }
  /** The hello's result, once paired. */
  paired(): Promise<Hello> { return this.helloSent; }
  get id() { return this.pairingId; }
  onChange(cb: () => void) { this.listeners.add(cb); return () => void this.listeners.delete(cb); }
  /** The server's notifications (the chat, §4): what it says is data for the page to show, never run. */
  onNotification(cb: (method: string, params: unknown) => void) { this.notified.add(cb); return () => void this.notified.delete(cb); }
  /** A notification to the server (the chat, §4): only while granted, and within the frame bound (else false). */
  notify(method: string, params: unknown): boolean {
    if (this.state !== "granted") return false;
    return this.sendBounded({ jsonrpc: "2.0", method, params });
  }
  private emit() { for (const cb of this.listeners) cb(); }

  /** The person's grant: sent to the server, kept (with the session secret if `remember`), and in force from now.
   * `id`: the id of the grant this resumes (a remembered one, or the reload record's); else this pairing's grant's,
   * if it has one; else a new one (Q1: made here, never the agent's). */
  async allow(g: { folders: string[]; write: boolean; expires: number | null; id?: string }, remember: boolean) {
    if (this.state !== "paired" && this.state !== "granted") throw new AgentError("invalid", "not paired");
    const h = this.hello!, now = this.now();
    const id = typeof g.id === "string" && GRANT_ID.test(g.id) ? g.id : this.grant?.id ?? newGrantId();
    const grant: Grant = { id, agent: h.agent.name, client: h.agent.client, folders: grantFolders(g.folders), write: !!g.write, run: false, expires: g.expires, created: this.grant?.created ?? now, lastUsed: now };
    this.grant = grant;
    this.remember = remember;
    this.verbs = this.opts.verbsFor(actorOf(h.agent.name, h.agent.client), { owner: () => grant.id });
    this.send({ jsonrpc: "2.0", method: "grant.changed", params: { agent: grant.agent, client: grant.client, folders: grant.folders, write: grant.write, run: false, expires: grant.expires } });
    // (what this page offers beyond the verbs: a notification, which a server that doesn't know it ignores, §1 rule 4)
    if (this.opts.notebookEdit) this.send({ jsonrpc: "2.0", method: "page.features", params: { features: ["notebook.edit"] } });
    await this.keep();
    // (S4: while it waited, the grant may have been revoked, the pairing closed or the grant replaced: then nothing
    //  of this allow() goes on, no record, no timer, no "granted")
    if ((this.state as AgentPairing["state"]) === "closed" || this.grant !== grant) return;
    this.keepForReload();
    if (this.timer) clearTimeout(this.timer);
    if (grant.expires !== null) this.timer = setTimeout(() => void this.revoke("the grant expired"), Math.max(0, grant.expires - now));
    this.state = "granted";
    this.emit();
  }
  private async keep() {
    if (!this.grant || !this.pairingId) return;
    // (only a remembered grant outlives the page: "until this page closes" is never kept. The session kept is the one in
    //  force: the hello's after a code, the remembered one after a reconnect, whose hello carries none; the hello's alone
    //  lost it on the first reconnect, and the next had nothing to send (T1, found by git-proto at b72938d8a))
    if (this.remember && this.grant.expires !== null) await this.opts.store.putAgentGrant(this.pairingId, { grant: this.grant, session: this.sessionSecret, port: this.port } satisfies Kept);
  }

  /** The reload record (A14): written for an unremembered grant only (a remembered one is kept in IndexedDB, above),
   * with the grant exactly as allowed; never for a pairing without a session secret. */
  private keepForReload() {
    const r = this.opts.reload, g = this.grant, h = this.hello;
    if (!r || !g || !h || this.remember || !this.pairingId || !this.sessionSecret || this.gen !== pairingGen) return;
    putReloadRecord(r.storage, { v: 1, pairingId: this.pairingId, session: this.sessionSecret, port: this.port, agent: { name: h.agent.name, client: h.agent.client }, grant: { folders: g.folders, write: g.write, expires: g.expires, id: g.id }, workspace: r.scope.workspace, page: r.scope.page });
  }
  /** The record removed from storage, if it is this pairing's (its id) and this is the newest pairing (its gen). */
  private dropReload() {
    const r = this.opts.reload;
    if (!r || this.gen !== pairingGen) return;
    let held: ReloadRecord | null = null;
    try { held = parseReloadRecord(r.storage?.getItem(RELOAD_KEY) ?? null); } catch { held = null; }
    if (!held || held.pairingId === this.pairingId) putReloadRecord(r.storage, null);
  }

  /** Dropped: the socket closed and nothing else (no grant change sent, nothing forgotten): an attempt another pairing
   * has superseded, which must not touch what the person has since chosen. */
  drop(why = "superseded") { this.close(1000, why); }

  /** Revoke: the server told ({}), the socket closed, the kept grant and session forgotten, at once. */
  async revoke(why = "revoked") {
    const id = this.pairingId;
    this.revoked = true;
    this.lostRecord = null;
    this.dropReload();
    this.grant = null;
    this.verbs = null;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.sock.readyState === 1) this.send({ jsonrpc: "2.0", method: "grant.changed", params: {} });
    this.close(1000, why);
    if (id) await this.opts.store.putAgentGrant(id, null);
  }

  private send(m: unknown) { if (this.sock.readyState === 1) this.sock.send(JSON.stringify(m)); }
  /** Close the socket for `why`, with the protocol's code `code` (1002 framing, 1003 not text, 1007 not strict JSON,
   * 1009 too big).  A page's WebSocket may send only 1000 or 3000-4999, with a reason of at most 123 UTF-8 bytes, so
   * the code goes as 4000 + code (1000 stays 1000); if the browser refuses even that, a plain close(), so the socket
   * never stays open. */
  private close(code: number, why: string) {
    this.closeReason ||= why;
    this.grant = null;
    this.verbs = null;
    const wire = code === 1000 ? 1000 : 4000 + (code % 1000);
    let reason = why;
    while (enc.encode(reason).length > 123) reason = reason.slice(0, -1);
    try { this.sock.close(wire, reason); } catch { try { this.sock.close(); } catch {} }
    this.end(why);
  }
  private end(why: string) {
    if (this.state === "closed") return;
    this.closeReason ||= why;
    // (A14: an involuntary loss, while the page stays: the record leaves storage, so a later reload doesn't try a
    //  session that just failed, and stays in memory for the bar's one [Reconnect]; a revoke dropped it already; the
    //  page leaving (a reload) keeps it, for the restore)
    const r = this.opts.reload;
    if (r && !this.revoked && !r.leaving() && this.gen === pairingGen) {
      let held: ReloadRecord | null = null;
      try { held = parseReloadRecord(r.storage?.getItem(RELOAD_KEY) ?? null); } catch { held = null; }
      if (held && held.pairingId === this.pairingId) { this.lostRecord = held; putReloadRecord(r.storage, null); }
    }
    this.state = "closed";
    this.grant = null;
    this.verbs = null;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.emit();
  }

  /** Send one message if it is within the frame bound; else false (nothing sent, nothing cut). */
  private sendBounded(m: unknown): boolean {
    const s = JSON.stringify(m);
    if (frameBytes(s, AGENT_LIMITS.maxFrameBytes) > AGENT_LIMITS.maxFrameBytes) return false;
    if (this.sock.readyState === 1) this.sock.send(s);
    return true;
  }
  private tooBigFrame(id: string) {
    this.sendBounded({ jsonrpc: "2.0", id, error: { code: -32000, message: "the answer would be over the frame bound", data: { code: "limit", message: `the answer would be over ${AGENT_LIMITS.maxFrameBytes} bytes as a message` } } });
  }
  /** An answer, never over the frame bound: one that would be is replaced by a limit error (nothing cut). */
  private reply(id: string, result: unknown) {
    if (!this.sendBounded({ jsonrpc: "2.0", id, result })) this.tooBigFrame(id);
  }
  /** An error, never over the frame bound either: a conflict's current contents are dropped first (said why),
   * and if it is still too big, a bare limit error. */
  private fail(id: string, code: string, message: string, extra: Record<string, unknown> = {}) {
    const msg = (x: Record<string, unknown>) => ({ jsonrpc: "2.0", id, error: { code: -32000, message, data: { code, message, ...x } } });
    if (this.sendBounded(msg(extra))) return;
    if ("current" in extra) {
      const { current: _c, ...rest } = extra;
      if (this.sendBounded(msg({ ...rest, currentOmitted: `its current contents would make the answer over ${AGENT_LIMITS.maxFrameBytes} bytes as a message: read it` }))) return;
    }
    this.tooBigFrame(id);
  }
  /** Whether `g` (and `verbs`) are still this pairing's grant, in force now: checked after every wait, before anything
   * is said or done on it. */
  private current(g: Grant | null, verbs: AgentVerbs | null) {
    return this.state === "granted" && g !== null && verbs !== null && this.grant === g && this.verbs === verbs && grantProblem(g, this.now()) === null;
  }

  /** One call from the server: checked, then done, then answered (never thrown). */
  private async call(id: string, method: string, params: unknown) {
    if (!/^s[0-9]{1,15}$/.test(id)) return this.close(1002, "a request id the server doesn't make");
    // (the limits first: a flood is refused before any work)
    const now = this.now();
    this.tokens = Math.min(AGENT_LIMITS.burst, this.tokens + ((now - this.refill) * AGENT_LIMITS.perSecond) / 1000);
    this.refill = now;
    if (this.inFlight >= AGENT_LIMITS.inFlight) return this.fail(id, "limit", `${AGENT_LIMITS.inFlight} calls are already in flight`, { retryAfterMs: 250 });
    if (this.tokens < 1) return this.fail(id, "limit", `more than ${AGENT_LIMITS.perSecond} calls a second`, { retryAfterMs: Math.ceil(((1 - this.tokens) * 1000) / AGENT_LIMITS.perSecond) });
    this.tokens -= 1;
    if (method === "notebook.edit") return void this.edit(id, params);
    // (a branch's name, said as the agent was told it (board's C1), rather than as the schema's pattern)
    const p0 = params as any;
    const bad = method === "workspace.git_branch" && p0 && typeof p0 === "object" && !Array.isArray(p0) && typeof p0.name === "string" && !BRANCH_NAME.test(p0.name) ? BRANCH_TEXT.badName : checkCall(method, params);
    if (bad) return this.fail(id, "invalid", bad);
    // (the slot is taken before anything is awaited, and given back on every way out: authorization's own reads count)
    this.inFlight++;
    const g = this.grant, verbs = this.verbs;
    try {
      const auth: { expect?: TrashEntry } = {};
      const no = await authorize(method, params, g, now, this.opts.trashEntry, auth);
      // (while it was authorized, the grant may have been revoked or have expired: it must be the same one, and
      // still in force now, before anything is said, the refusal too, and before the workspace is touched)
      if (!this.current(g, verbs)) return this.fail(id, "invalid", grantProblem(this.grant, this.now()) ?? "the grant changed while this was checked");
      if (no) return this.fail(id, "invalid", no);
      const result = method === "workspace.git_branch" ? await this.branch(g!, verbs!, (params as any).name) : await this.run(verbs!, method.slice("workspace.".length), params as any, auth.expect);
      // (after the last wait, before anything is said: the same grant, in force now, or nothing of what it read)
      if (!this.current(g, verbs)) return this.fail(id, "invalid", CHANGED_WHILE_RUNNING);
      g!.lastUsed = this.now();
      this.reply(id, result);
    } catch (err: any) {
      // (the same check before any error is said: after a change, nothing more is read or said)
      if (!this.current(g, verbs)) return this.fail(id, "invalid", CHANGED_WHILE_RUNNING);
      if (err instanceof AgentError) return this.fail(id, err.code, err.message, err.extra);
      const code = typeof err?.code === "string" && ["invalid", "exists", "missing", "conflict", "limit", "storage"].includes(err.code) ? err.code : "invalid";
      const extra: Record<string, unknown> = {};
      if (code === "conflict" && method === "workspace.write") {
        // (the current contents, if within the content bound: else the conflict is said without them, and why)
        try { const r = await verbs!.read((params as any).path); extra.current = { entry: entryOut(r.entry), rev: r.rev, content: contentOut(r.entry.kind, r.content, (params as any).path) }; }
        catch (e2: any) { if (e2 instanceof AgentError && e2.code === "limit") extra.currentOmitted = e2.message; }
        // (that read was a wait too: checked again before it is said)
        if (!this.current(g, verbs)) return this.fail(id, "invalid", CHANGED_WHILE_RUNNING);
      }
      this.fail(id, code, String(err?.message ?? err).slice(0, 500), extra);
    } finally {
      this.inFlight--;
    }
  }

  /** Whether this pairing edits notebooks by cell: the page offers it and the agent said it uses it (its hello). */
  private edits() { return !!this.opts.notebookEdit && !!this.hello?.features?.includes("notebook.edit"); }

  /** An agent's edit of a notebook (notebook-edit.ts): its grammar, then the grant as for a write of its path, then the
   * page's own apply (the open notebook's host); the same grant checked after every wait, as for the verbs. */
  private async edit(id: string, params: unknown) {
    if (!this.edits()) return this.fail(id, "invalid", "not a verb: \"notebook.edit\"");
    const bad = badValue(params) ?? editProblem(params);
    if (bad) return this.fail(id, "invalid", bad);
    const e = params as NotebookEdit;
    this.inFlight++;
    const g = this.grant, verbs = this.verbs, now = this.now();
    try {
      const no = await authorize("workspace.write", { path: e.path }, g, now, this.opts.trashEntry);
      if (!this.current(g, verbs)) return this.fail(id, "invalid", grantProblem(this.grant, this.now()) ?? "the grant changed while this was checked");
      if (no) return this.fail(id, "invalid", no);
      // (the branches' rule (chat plan PR 3, P3-2), for a notebook in /Branches, the only place it says anything: the
      //  page asks it right before its own synchronous apply, holding the workspace's lock across both (`hold`), so
      //  nothing moves the branch between the check and the change; an edit elsewhere never waits on the lock)
      const np = norm(e.path);
      let hold: (() => Promise<() => void>) | undefined;
      if (np !== null && within(np, BRANCHES)) {
        if (!verbs?.holdChange) throw new AgentError("invalid", "this page can't check a notebook's branch");
        hold = () => verbs.holdChange!(np);
      }
      // (with the check of this very grant, for the page to make right before it changes anything: astra's C1)
      const result = await this.opts.notebookEdit!(e, () => this.current(g, verbs), hold);
      if (!this.current(g, verbs)) return this.fail(id, "invalid", CHANGED_WHILE_RUNNING);
      g!.lastUsed = this.now();
      this.changes++;
      this.emit();
      this.reply(id, result);
    } catch (err: any) {
      if (!this.current(g, verbs)) return this.fail(id, "invalid", CHANGED_WHILE_RUNNING);
      if (err instanceof AgentError) return this.fail(id, err.code, err.message, err.extra);
      this.fail(id, "invalid", String(err?.message ?? err).slice(0, 500));
    } finally {
      this.inFlight--;
    }
  }

  /** git_branch (chat plan PR 3): the page's, for this grant, while it is the one in force. */
  private async branch(g: Grant, verbs: AgentVerbs, name: string): Promise<unknown> {
    if (!this.opts.gitBranch) throw new AgentError("invalid", "not a verb: \"workspace.git_branch\"");
    const h = this.hello!;
    const out = await this.opts.gitBranch({ actor: actorOf(h.agent.name, h.agent.client), name, owner: g.id, folders: g.folders, live: () => this.current(g, verbs) });
    this.changes++;
    this.emit();
    return out;
  }

  private async run(v: AgentVerbs, verb: string, p: any, expect?: TrashEntry): Promise<unknown> {
    const sized = (c: any) => contentIn(c, p.path ?? "contents");
    const changed = <T,>(x: T) => { this.changes++; this.emit(); return x; };
    switch (verb) {
      case "list": {
        const all = await v.list(p.folder, p.recursive ? { recursive: true } : {});
        const from = p.cursor === undefined ? 0 : /^[0-9]{1,9}$/.test(p.cursor) ? Number(p.cursor) : NaN;
        if (!Number.isFinite(from)) throw new AgentError("invalid", "not a cursor this page gave");
        const page = all.slice(from, from + AGENT_LIMITS.maxList).map(entryOut);
        return from + page.length < all.length ? { entries: page, more: true, cursor: String(from + page.length) } : { entries: page };
      }
      case "stat": return { entry: entryOut(await v.stat(p.path)) };
      case "read": {
        const r = await v.read(p.path);
        if (r.entry.kind === "folder") throw new AgentError("invalid", `${p.path} is a folder: list it`);
        // (a notebook's ref, for an edit by cell: the document read, so an edit never reaches another put at its path)
        return { entry: entryOut(r.entry), rev: r.rev, content: contentOut(r.entry.kind, r.content, p.path), ...(this.edits() && r.entry.kind === "notebook" && typeof r.entry.ref === "string" ? { ref: r.entry.ref } : {}) };
      }
      case "write": {
        // (an agent that edits notebooks by cell never rewrites one whole: that would drop its outputs, A12)
        if (this.edits() && /\.ipynb$/i.test(String(p.path))) throw new AgentError("invalid", `${p.path} is a notebook: change it with workspace_edit_notebook (by cell, its outputs kept), not a whole write`);
        const r = await v.write(p.path, sized(p.content), p.base !== undefined ? { base: p.base } : {}); return changed({ entry: entryOut(r.entry), rev: r.rev }); }
      case "create": return changed({ entry: entryOut(await v.create(p.path, { ...(p.content ? { content: sized(p.content) } : {}), ...(p.mode ? { mode: p.mode } : {}) })) });
      case "mkdir": return changed({ entry: entryOut(await v.mkdir(p.path)) });
      case "rename": return changed({ entry: entryOut(await v.rename(p.from, p.to)) });
      case "duplicate": return changed({ entry: entryOut(await v.duplicate(p.path, p.to)) });
      case "remove": return changed({ entry: entryOut(await v.remove(p.path)) });
      // (only the very entry authorized: Workspace.restore checks it holding its lock, so one put in its place meanwhile isn't restored)
      case "restore": if (!expect) throw new AgentError("invalid", "restore without its authorized entry"); return changed({ entry: entryOut(await v.restore(p.path, expect)) });
      case "history": {
        const all = await v.history(p.path);
        const from = p.cursor === undefined ? 0 : /^[0-9]{1,9}$/.test(p.cursor) ? Number(p.cursor) : NaN;
        if (!Number.isFinite(from)) throw new AgentError("invalid", "not a cursor this page gave");
        const page = all.slice(from, from + AGENT_LIMITS.maxHistory).map((x: any) => ({ t: x.t, size: x.size, sha256: x.sha256, by: x.by }));
        return from + page.length < all.length ? { versions: page, more: true, cursor: String(from + page.length) } : { versions: page };
      }
      case "version": return { content: contentOut("file", await v.version(p.path, p.index), `${p.path} version ${p.index}`) };
    }
    throw new AgentError("invalid", `not a verb: ${verb}`);
  }
}

// ---- the reload record (A14 plan r3.1 + r3.2): an unremembered grant survives a reload of the same page
// One record in sessionStorage per page, closed and bounded: the pairing, its session secret, the agent it was, and the
// grant exactly. It newly keeps an unremembered bearer secret for the page's life (remembered ones are in IndexedDB,
// longer). It is never in a URL, the chat, a toast, diagnostics or an export. A copy in another tab (window.open, a
// duplicated or restored tab) is independent: a consume here doesn't reach it, so each page's own checks decide.

export const RELOAD_KEY = "sb-agent-reload-v1";
// (the newest pairing's number on this page: only the newest writes or drops the record, A14 r3.1 §3)
let pairingGen = 0;
/** At most this long between the page leaving (pagehide) and its reload for the restore to be silent (R1-b). */
export const RELOAD_FRESH_MS = 30_000;
const RELOAD_MAX = 4096;

export type ReloadRecord = {
  v: 1; pairingId: string; session: string; port: number;
  agent: { name: string; client: string };
  grant: { folders: string[]; write: boolean; expires: number | null; id?: string };
  workspace: string; page: string; leftAt?: number;
};
/** The page a record belongs to: its workspace's store and its own address (R1-d). */
export type ReloadScope = { workspace: string; page: string };
type ReloadStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const isStr = (v: unknown, max: number): v is string => typeof v === "string" && v.length > 0 && v.length <= max;
const keysAre = (o: object, want: string[], optional: string[] = []) => {
  const k = Object.keys(o);
  return want.every((w) => k.includes(w)) && k.every((x) => want.includes(x) || optional.includes(x));
};

/** A record as kept, or null for anything else: the exact keys, each in its bounds (finite numbers only), its
 * folders as grantFolders gives them back. Fails closed: a record that isn't exactly this is no record. */
export function parseReloadRecord(raw: string | null): ReloadRecord | null {
  // (the bound in UTF-8 bytes, as stored, not UTF-16 code units: a non-ASCII record is counted as it is, S3)
  if (typeof raw !== "string" || raw.length > RELOAD_MAX || enc.encode(raw).length > RELOAD_MAX) return null;
  let v: any;
  try { v = parseStrict(raw); } catch { return null; }
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  if (!keysAre(v, ["v", "pairingId", "session", "port", "agent", "grant", "workspace", "page"], ["leftAt"])) return null;
  if (v.v !== 1 || typeof v.pairingId !== "string" || !/^[0-9a-f]{24}$/.test(v.pairingId)) return null;
  if (typeof v.session !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(v.session)) return null;
  if (!Number.isInteger(v.port) || v.port < 1 || v.port > 65535) return null;
  const a = v.agent, g = v.grant;
  if (!a || typeof a !== "object" || Array.isArray(a) || !keysAre(a, ["name", "client"])) return null;
  if (!isStr(a.name, 80) || typeof a.client !== "string" || a.client.length > 40) return null;
  if (!g || typeof g !== "object" || Array.isArray(g) || !keysAre(g, ["folders", "write", "expires"], ["id"])) return null;
  if ("id" in g && !(typeof g.id === "string" && GRANT_ID.test(g.id))) return null;
  if (!Array.isArray(g.folders) || g.folders.length < 1 || g.folders.length > 64 || !g.folders.every((f: unknown) => isStr(f, 512))) return null;
  if (typeof g.write !== "boolean") return null;
  if (g.expires !== null && !(typeof g.expires === "number" && Number.isFinite(g.expires))) return null;
  let folders: string[];
  try { folders = grantFolders(g.folders); } catch { return null; }
  if (folders.length !== g.folders.length || folders.some((f, i) => f !== g.folders[i])) return null;
  if (!isStr(v.workspace, 256) || !isStr(v.page, 256)) return null;
  if ("leftAt" in v && !(typeof v.leftAt === "number" && Number.isFinite(v.leftAt))) return null;
  return v as ReloadRecord;
}

/** What a page may do with a parsed record:
 *  - "silent": reconnect now, with no gesture (a reload, fresh, same scope, not expired: R1-a..e);
 *  - "click": keep it in memory for one [Reconnect] (the same scope, not expired; only the reload or freshness failed);
 *  - "discard": never usable (another workspace or page, or the grant is over). */
export function reloadDecision(r: ReloadRecord, o: { scope: ReloadScope; navType: string; now: number }): "silent" | "click" | "discard" {
  if (r.workspace !== o.scope.workspace || r.page !== o.scope.page) return "discard";
  if (r.grant.expires !== null && !(o.now < r.grant.expires)) return "discard";
  if (o.navType !== "reload" || r.leftAt === undefined) return "click";
  const age = o.now - r.leftAt;
  return age >= 0 && age <= RELOAD_FRESH_MS ? "silent" : "click";
}

/** What taking the record found (S1): "none", no storage or no entry (genuinely absent); "bad", an entry this page
 * may not use: unreadable, not removable (consumed before any attempt, R1-c, or not at all), or not exactly a
 * record; "ok", the record, already removed. A "bad" take is never silently replaced by another grant. */
export type ReloadTake = { kind: "none" } | { kind: "bad" } | { kind: "ok"; record: ReloadRecord };
/** The record, taken: read, removed at once (before any attempt, R1-c, this page only), then parsed. Fails closed: an
 * entry that can't be read or removed is "bad", never used. */
export function takeReloadRecord(s: ReloadStorage | null): ReloadTake {
  if (!s) return { kind: "none" };
  let raw: string | null = null;
  try { raw = s.getItem(RELOAD_KEY); } catch { return { kind: "bad" }; }
  if (raw === null) return { kind: "none" };
  try { s.removeItem(RELOAD_KEY); } catch { return { kind: "bad" }; }
  const record = parseReloadRecord(raw);
  return record ? { kind: "ok", record } : { kind: "bad" };
}
/** The record written (or, with null, removed). Only a record the reader would take back exactly is written (its
 * shape and its byte bound, S3); anything else is not stored, and any older entry goes: the live grant itself is
 * never cut to fit. */
export function putReloadRecord(s: ReloadStorage | null, r: ReloadRecord | null): void {
  if (!s) return;
  const raw = r ? JSON.stringify(r) : null;
  const fits = raw !== null && parseReloadRecord(raw) !== null;
  try { if (fits) s.setItem(RELOAD_KEY, raw!); else s.removeItem(RELOAD_KEY); } catch { /* (no storage: no restore) */ }
}
/** On pagehide: the time the page left, on the record it holds (if it holds a valid one). */
export function markReloadLeft(s: ReloadStorage | null, now: number): void {
  if (!s) return;
  let r: ReloadRecord | null = null;
  try { r = parseReloadRecord(s.getItem(RELOAD_KEY)); } catch { return; }
  if (r) putReloadRecord(s, { ...r, leftAt: now });
}
