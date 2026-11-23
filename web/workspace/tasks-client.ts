// Delegate's requests from the page to the agent: the transport of pair-delegate-plan-r3.3 §2.5 (P0, frozen), groundwork
// rather than all of its enforcement. JSON-RPC requests over the pairing (AgentPairing.own), with ids "p<n>" (the hello is
// "p1"), only to an agent whose negotiated hello lists DELEGATE_FEATURE, only these methods, at most
// TASK_REQUESTS.pending at once. Each request the page sends, and each answer's raw frame as received (its envelope,
// whitespace and multibyte characters counted), at most TASK_REQUESTS.frameBytes; an answer over it is refused
// ("too_large") before its result or error reaches the caller (the pairing's own frames keep their own bound). Each is
// rejected with "timeout" if no answer comes within its time: a bound on waiting, not a promise that the agent answers.
// Every pending one ends with the pairing. Its own module, so the pages that don't offer Delegate (the LaTeX editor's
// pairing) carry none of it.
// The grant's delegate:true (the Agents page's switch, AgentPairing.setDelegate) is checked here before each request,
// and by the agent always. Not here: §2.5's schema of each result, which every caller checks before any use.
import { AgentError, type AgentPairing } from "./agent-pair";
import { grantMemory } from "./agent-grant";
import { MEMORY_FEATURE, MEMORY_METHODS } from "./memory-schema";

export const DELEGATE_FEATURE = "delegate.1";
/** Delegate briefs: chat.brief, a draft of a task's brief from a Pair chat, sent only to an agent that lists it. */
export const BRIEF_FEATURE = "chat.brief";
export const TASK_METHODS: readonly string[] = ["tasks.start", "tasks.list", "tasks.get", "tasks.diff", "tasks.file", "tasks.merged", "tasks.close", "tasks.ask", "tasks.stop", "tasks.revoke", "tasks.resume", "tasks.answer"];
export const TASK_REQUESTS = Object.freeze({ pending: 8, frameBytes: 4 * 2 ** 20, timeoutMs: 30_000, longMs: 120_000, long: ["tasks.start", "tasks.merged"] as readonly string[] });

const enc = new TextEncoder();
// (one client per pairing: its ids are the pairing's)
const clients = new WeakMap<AgentPairing, TaskClient>();

export class TaskClient {
  private next = 1;
  private pending = new Map<string, { resolve: (r: unknown) => void; reject: (e: AgentError) => void; timer: ReturnType<typeof setTimeout> }>();
  private out: { send(m: unknown): "ok" | "closed" | "over" | "link" };
  private unwatch: () => void;

  /** The pairing's client (made on first use). */
  static of(p: AgentPairing): TaskClient {
    let c = clients.get(p);
    if (!c) { c = new TaskClient(p); clients.set(p, c); }
    return c;
  }
  private constructor(private p: AgentPairing) {
    this.out = p.own((msg, bytes) => this.answered(msg, bytes));
    // (the pairing's end ends every pending request)
    this.unwatch = p.onChange(() => { if (p.state === "closed") this.endAll(p.closeReason || "the agent isn't connected"); });
  }

  /** Whether this pairing's agent offers Delegate. */
  offered(): boolean { return !!this.p.hello?.features?.includes(DELEGATE_FEATURE); }

  /** One request: its result, or an AgentError whose code is the agent's (data.code), or the page's own:
   * "unavailable" (over a runner: M1 is loopback only), "closed" (not granted, or the pairing ended), "forbidden" (the
   * agent doesn't offer delegate.1), "bad_request" (not one of TASK_METHODS, nor chat.brief to an agent that lists it), "busy" (TASK_REQUESTS.pending already),
   * "too_large" (the message over TASK_REQUESTS.frameBytes or the connection's bound), "timeout". */
  request(method: string, params: Record<string, unknown>, o: { timeoutMs?: number } = {}): Promise<unknown> {
    const no = (code: string, why: string) => Promise.reject(new AgentError(code, why));
    if (this.p.link) return no("unavailable", "Delegate works only with an agent on this computer for now");
    if (this.p.state !== "granted") return no("closed", "the agent isn't connected");
    // (agent memory v1, §7.1: its own gate, not Delegate's: the agent offers memory.1, and the grant holds memory)
    if (method.startsWith("memory.")) {
      if (!this.p.hello?.features?.includes(MEMORY_FEATURE)) return no("forbidden", "this agent doesn't offer memory");
      if (!grantMemory(this.p.grant)) return no("forbidden", "memory isn't turned on for this agent");
      if (!MEMORY_METHODS.includes(method)) return no("bad_request", "not a memory request");
      return this.send(method, params, o);
    }
    if (!this.offered()) return no("forbidden", "this agent doesn't offer Delegate");
    if (this.p.grant?.delegate !== true) return no("forbidden", "Delegate tasks aren't turned on for this agent");
    if (!TASK_METHODS.includes(method) && !(method === BRIEF_FEATURE && this.p.hello?.features?.includes(BRIEF_FEATURE))) return no("bad_request", "not a Delegate request");
    return this.send(method, params, o);
  }

  private send(method: string, params: Record<string, unknown>, o: { timeoutMs?: number }): Promise<unknown> {
    const no = (code: string, why: string) => Promise.reject(new AgentError(code, why));
    if (this.pending.size >= TASK_REQUESTS.pending) return no("busy", "too many requests to the agent at once");
    const id = "p" + ++this.next;
    const m = { jsonrpc: "2.0", id, method, params };
    const text = JSON.stringify(m);
    if (text.length > TASK_REQUESTS.frameBytes || enc.encode(text).length > TASK_REQUESTS.frameBytes) return no("too_large", "the request is over the connection's limit");
    const sent = this.out.send(m);
    if (sent !== "ok") return sent === "over" ? no("too_large", "the request is over the connection's limit") : sent === "link" ? no("unavailable", "Delegate works only with an agent on this computer for now") : no("closed", "the agent isn't connected");
    const ms = o.timeoutMs ?? (TASK_REQUESTS.long.includes(method) ? TASK_REQUESTS.longMs : TASK_REQUESTS.timeoutMs);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { if (this.pending.delete(id)) reject(new AgentError("timeout", "the agent didn't answer in time")); }, ms);
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  private answered(msg: any, bytes: number): boolean {
    const r = this.pending.get(msg.id);
    if (!r) return false;
    this.pending.delete(msg.id);
    clearTimeout(r.timer);
    // (an answer's raw frame over §2.5's bound: refused, its result or error never handed on)
    if (bytes > TASK_REQUESTS.frameBytes) { r.reject(new AgentError("too_large", "the agent's answer is over the limit")); return true; }
    if (msg.error !== undefined) {
      const code = typeof msg.error?.data?.code === "string" ? msg.error.data.code.slice(0, 40) : "error";
      r.reject(new AgentError(code, String(msg.error?.message ?? "refused").slice(0, 300)));
    } else r.resolve(msg.result);
    return true;
  }
  private endAll(why: string) {
    for (const [id, r] of [...this.pending]) { clearTimeout(r.timer); this.pending.delete(id); r.reject(new AgentError("closed", why)); }
    this.unwatch();
  }
}
