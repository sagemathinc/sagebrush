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

import { checkCall, AGENT_LIMITS } from "./agent-schema";
import { authorize, grantFolders, grantProblem, type Grant, type TrashEntry } from "./agent-grant";

/** What the hello's result says (the agent's own claims, shown as such). */
export type Hello = { protocol: 1; agent: { name: string; client: string; version?: string }; wants: { folders?: string[]; write?: boolean; run?: boolean }; session?: string };
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
};
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
  private pairingId = "";
  private remember = false;
  private helloSent: Promise<Hello>;

  constructor(
    readonly port: number,
    how: { code: string } | { session: string; pairingId: string },
    private opts: { verbsFor: (actor: string) => AgentVerbs; store: GrantStore; trashEntry: (p: string) => Promise<TrashEntry | null | undefined>; page: { origin: string; path: string }; now?: () => number; WebSocketImpl?: typeof WebSocket },
  ) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new AgentError("invalid", "a port is 1 to 65535");
    const now = this.now();
    this.tokens = AGENT_LIMITS.burst;
    this.refill = now;
    const WS = opts.WebSocketImpl ?? WebSocket;
    this.sock = new WS(`ws://127.0.0.1:${port}/sagebrush`);
    if ("pairingId" in how) this.pairingId = how.pairingId;
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
          this.hello = { protocol: 1, agent: { name: String(r.agent.name).slice(0, 80), client: String(r.agent.client ?? "").slice(0, 40), version: r.agent.version ? String(r.agent.version).slice(0, 40) : undefined }, wants: { folders: Array.isArray(r.wants?.folders) ? r.wants.folders.slice(0, 50).map(String) : undefined, write: !!r.wants?.write, run: !!r.wants?.run }, session: typeof r.session === "string" ? r.session : undefined };
          if (!this.pairingId) this.pairingId = [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, "0")).join("");
          this.state = "paired";
          this.emit();
          return resolve(this.hello);
        }
        if (typeof msg.method === "string" && msg.id === undefined) return; // (a notification: chat comes in a later step)
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
  private emit() { for (const cb of this.listeners) cb(); }

  /** The person's grant: sent to the server, kept (with the session secret if `remember`), and in force from now. */
  async allow(g: { folders: string[]; write: boolean; expires: number | null }, remember: boolean) {
    if (this.state !== "paired" && this.state !== "granted") throw new AgentError("invalid", "not paired");
    const h = this.hello!, now = this.now();
    const grant: Grant = { agent: h.agent.name, client: h.agent.client, folders: grantFolders(g.folders), write: !!g.write, run: false, expires: g.expires, created: this.grant?.created ?? now, lastUsed: now };
    this.grant = grant;
    this.remember = remember;
    this.verbs = this.opts.verbsFor(actorOf(h.agent.name, h.agent.client));
    this.send({ jsonrpc: "2.0", method: "grant.changed", params: { agent: grant.agent, client: grant.client, folders: grant.folders, write: grant.write, run: false, expires: grant.expires } });
    await this.keep();
    if (this.timer) clearTimeout(this.timer);
    if (grant.expires !== null) this.timer = setTimeout(() => void this.revoke("the grant expired"), Math.max(0, grant.expires - now));
    this.state = "granted";
    this.emit();
  }
  private async keep() {
    if (!this.grant || !this.pairingId) return;
    // (only a remembered grant outlives the page: "until this page closes" is never kept)
    if (this.remember && this.grant.expires !== null) await this.opts.store.putAgentGrant(this.pairingId, { grant: this.grant, session: this.hello?.session, port: this.port } satisfies Kept);
  }

  /** Revoke: the server told ({}), the socket closed, the kept grant and session forgotten, at once. */
  async revoke(why = "revoked") {
    const id = this.pairingId;
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
    const bad = checkCall(method, params);
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
      const result = await this.run(verbs!, method.slice("workspace.".length), params as any, auth.expect);
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
        return { entry: entryOut(r.entry), rev: r.rev, content: contentOut(r.entry.kind, r.content, p.path) };
      }
      case "write": { const r = await v.write(p.path, sized(p.content), p.base !== undefined ? { base: p.base } : {}); return changed({ entry: entryOut(r.entry), rev: r.rev }); }
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
