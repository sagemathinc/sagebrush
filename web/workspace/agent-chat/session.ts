// The agents chat's conversation, apart from any page that draws it (the Agents page, and the chat panel to come): the
// threads, the person's messages and their queue, the paired agent's turns and permission cards, and a scripted turn
// where the page offers one. Drawing, persistence and the page's words are the host's, passed in.
import { apply, awayTurn, newThread, runningTurn, type Draft, type Thread, type Turn, type TurnEvent, type UserEntry } from "./events";
import type { AgentPairing } from "../agent-pair";
import { PermissionCards } from "../agent-cards";
import { digestGate, DIGEST_CHARGE } from "../agent-relay";

export interface Saved {
  threads: Thread[];
  current: string;
}

/** A turn the page runs itself (the Agents page's scripted demo). */
export interface LocalTurn {
  interrupt(): void;
  answer(id: string, approve: boolean): void;
  done: Promise<void>;
}

export interface SessionHost {
  /** the kept threads, or null for a first visit (or a format this can't read) */
  load(): Saved | null;
  /** keep them (the session calls it after every change; the host may debounce) */
  store(s: Saved): void;
  /** the page's pairing with an agent, if any */
  pairing(): AgentPairing | null;
  /** a scripted turn for a prompt, where the page has one */
  demo?(prompt: string, emit: (d: Draft) => void): LocalTurn;
  /** whether a thread may still be answered by the scripted turn (never once a real agent was in it) */
  mayDemo(t: Thread): boolean;
  /** an event was applied to a thread (the page draws it, opens an artifact, ...); `replayed`: it came from the agent's
   *  log after a reconnect, not live (the page records it but doesn't move the pane for it) */
  emitted(thread: Thread, d: Draft, replayed?: boolean): void;
  /** what the composer shows changed (running, queued); `all`: the thread and its list too */
  changed(all: boolean): void;
  /** a message didn't go to the agent: its queue is full, it's over the connection's limit, or the agent is gone */
  notSent(why: "full" | "over" | "disconnected"): void;
}

const id = () => Math.random().toString(36).slice(2, 10);
/** One of the agent's log numbers: a positive safe integer. */
const seqOk = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;
/** A chat.rejected as a receipt: "rejected", with why as one of the agent's codes this page words (busy: too many
 *  messages waiting; anything else: the turn ended), never its message text. */
const rejection = (params: unknown) => {
  const q = (params && typeof params === "object" ? params : {}) as { reason?: { code?: unknown } };
  return { ...q, state: "rejected", reason: q.reason?.code === "busy" ? "busy" : "cancelled" };
};
const receiptOk = (v: unknown): v is NonNullable<UserEntry["receipt"]> => v === "steering" || v === "delivered" || v === "queued";

export class ChatSession {
  readonly state: Saved;
  /** queued messages, by thread */
  readonly queues = new Map<string, UserEntry[]>();
  /** the paired agent's permission cards (agent-cards.ts): kept as admitted, answered once, Allow with its digest */
  readonly cards: PermissionCards;
  private readonly local = new Map<string, { turn: LocalTurn; turn_id: string }>(); // scripted turns, by thread
  private readonly liveRunning = new Set<string>(); // threads with a turn of the paired agent running

  constructor(private readonly host: SessionHost) {
    const kept = host.load();
    if (kept && Array.isArray(kept.threads) && kept.threads.length > 0) this.state = kept;
    else {
      const t = newThread(id(), "New chat");
      this.state = { threads: [t], current: t.id };
    }
    // (the chat is where a web card's "for this turn" is offered: its pairing says egress.turn, egressTurn below)
    this.cards = new PermissionCards({ current: () => host.pairing(), gate: digestGate, charge: DIGEST_CHARGE, egressTurn: true });
  }

  /** A turn that was running when the page closed (the host calls this once it can draw): an agent's turn in a thread
   *  whose agent keeps a log (chat.resume) is away until the page is paired again and the log says how it went; any
   *  other ends interrupted, as it can't go on. */
  endInterrupted() {
    for (const t of this.state.threads) {
      const r = runningTurn(t);
      if (!r) continue;
      if (r.agent && t.agent_instance) this.setAway(t, r);
      else this.emit(t, r.turn_id, { type: "turn_finished", outcome: "interrupted" });
    }
  }

  private setAway(t: Thread, r: Turn) {
    r.away = true;
    this.save();
    this.host.changed(true);
  }

  /** The thread's away turn, if its agent can't say how it went (another run of the agent, or one without a log):
   *  it ends interrupted here, and the thread's queue goes on. */
  endAway(t: Thread) {
    const r = awayTurn(t);
    if (!r) return;
    this.emit(t, r.turn_id, { type: "turn_finished", outcome: "interrupted" });
    this.next(t);
  }

  /** The pairing is granted: ask the agent for what each of its threads missed, from the last number the page has (an
   *  agent without a log: the away turns end interrupted). */
  resume() {
    const pairing = this.host.pairing();
    if (!pairing || !this.live()) return;
    const instance = pairing.hello?.log?.instance;
    for (const t of this.state.threads) {
      if (!this.marked(t)) continue;
      if (!pairing.hello?.features?.includes("chat.resume") || !instance) { this.endAway(t); continue; }
      pairing.notify("chat.resume", { conversation: t.id, after: t.agent_seq ?? 0, ...(t.agent_instance ? { instance: t.agent_instance } : {}) });
    }
  }

  current(): Thread {
    return this.state.threads.find((t) => t.id === this.state.current) ?? this.state.threads[0];
  }
  /** a new, empty chat, made current */
  newThread(): Thread {
    const t = newThread(id(), "New chat");
    this.state.threads.push(t);
    this.state.current = t.id;
    this.save();
    return t;
  }
  select(threadId: string) {
    this.state.current = threadId;
    this.save();
  }
  save() {
    this.host.store(this.state);
  }

  live(): boolean {
    return this.host.pairing()?.state === "granted";
  }
  isRunning(t: Thread): boolean {
    return this.local.has(t.id) || this.liveRunning.has(t.id);
  }
  /** Whether the thread's last turn is away: its agent isn't connected; there is no one to stop. */
  isAway(t: Thread): boolean {
    return !!awayTurn(t);
  }
  /** the no-demo marker: a real agent was in this chat. It holds no credential; it is kept with the chats */
  marked(t: Thread): boolean {
    return !!(t as Thread & { agent?: boolean }).agent;
  }
  mark(t: Thread) {
    if (this.marked(t)) return;
    (t as Thread & { agent?: boolean }).agent = true;
    this.save();
  }
  /** not connected, in a chat the demo may not answer: Send is inert (a note still posts) */
  inert(t: Thread): boolean {
    return !this.live() && !this.host.mayDemo(t);
  }
  /** whether a message may be taken now: connected (or a demo chat), or the chat's last turn is away, when the message
   *  waits in the queue for that turn's end, which the agent's log says once the page is connected again */
  canSend(t: Thread): boolean {
    return !this.inert(t) || this.isAway(t);
  }

  /** An event, applied to its thread and kept. */
  emit(thread: Thread, turn_id: string, d: Draft, replayed = false) {
    const e = { ...d, seq: thread.applied_seq + 1, turn_id } as TurnEvent;
    apply(thread, e);
    // (a turn ended: a steer still waiting for its receipt is no longer said to be on its way)
    if (d.type === "turn_finished") for (const x of thread.entries) if (x.kind === "user" && x.mode === "steer" && x.receipt !== "delivered" && x.receipt !== "rejected" && x.receipt !== "queued") x.settled = true;
    this.host.emitted(thread, d, replayed);
    this.save();
  }

  /** Whether a message to this thread now can steer its running turn: the turn is the paired agent's, running, and
   *  that agent said it takes steers (chat.steer). */
  canSteer(thread: Thread): boolean {
    return this.live() && this.liveRunning.has(thread.id) && !this.isAway(thread) && !!this.host.pairing()?.hello?.features?.includes("chat.steer");
  }

  /** The person's message in the current thread: false when it can't be taken (the draft stays). */
  submit(text: string, mode: UserEntry["mode"]): boolean {
    text = text.trim();
    if (!text) return false;
    const thread = this.current();
    if (mode !== "note" && !this.canSend(thread)) return false;
    const busy = this.isRunning(thread);
    // (a turn away: no one to interrupt, so a message waits for its end, which the agent's log says once connected)
    const away = !busy && this.isAway(thread);
    if (away && mode === "sent") mode = "queued";
    // (a steer only where it can go into the running turn now; otherwise as Queue would be, or a send with no turn)
    if (mode === "steer" && !this.canSteer(thread)) mode = busy || away ? "queued" : "sent";
    if (mode === "queued" && !busy && !away) mode = "sent";
    const entry: UserEntry = { kind: "user", id: id(), text, mode, time: Date.now() };
    thread.entries.push(entry);
    if (thread.title === "New chat") thread.title = text.split("\n")[0].slice(0, 48);
    if (mode === "steer") {
      // (into the running turn, never interrupting it: the agent's receipts say what became of it)
      const sent = this.host.pairing()?.notifyWhy("chat.message", { conversation: thread.id, id: entry.id, author: "person", text: entry.text, steer: true });
      if (sent !== "ok") {
        thread.entries.pop();
        this.host.notSent(this.host.pairing()?.link && sent === "full" ? "full" : this.host.pairing()?.link && sent === "over" ? "over" : "disconnected");
        return false;
      }
    } else if (mode === "queued") {
      this.queues.set(thread.id, [...(this.queues.get(thread.id) ?? []), entry]);
    } else if (mode === "sent" && busy) {
      // Sending while a turn runs interrupts it, as in Claude Code; this goes first once it has stopped.
      this.queues.set(thread.id, [entry, ...(this.queues.get(thread.id) ?? [])]);
      this.interrupt(thread);
    } else if (mode === "sent") {
      this.send(thread, entry);
    }
    this.save();
    return true;
  }

  private startLocal(thread: Thread, prompt: string) {
    const turn_id = `turn-${id()}`;
    const turn = this.host.demo!(prompt, (d) => this.emit(thread, turn_id, d));
    this.local.set(thread.id, { turn, turn_id });
    this.host.changed(false);
    turn.done.then(() => {
      if (this.local.get(thread.id)?.turn === turn) this.local.delete(thread.id);
      this.next(thread);
    });
  }

  /** The next queued message, once a turn has ended. */
  next(thread: Thread) {
    const entry = this.queues.get(thread.id)?.shift();
    if (entry) {
      entry.mode = "sent";
      this.save();
      this.send(thread, entry);
    }
    this.host.changed(true);
  }

  private send(thread: Thread, entry: UserEntry) {
    const pairing = this.host.pairing();
    if (this.live() && pairing) {
      this.mark(thread);
      this.liveRunning.add(thread.id);
      const sent = pairing.notifyWhy("chat.message", { conversation: thread.id, id: entry.id, author: "person", text: entry.text });
      if (sent !== "ok") {
        this.liveRunning.delete(thread.id);
        // (over a runner, each cause in its own words: a queue that's full now, or a message over the connection's limit)
        this.host.notSent(pairing.link && sent === "full" ? "full" : pairing.link && sent === "over" ? "over" : "disconnected");
      }
      this.host.changed(false);
    } else if (this.host.demo && this.host.mayDemo(thread)) {
      this.startLocal(thread, entry.text);
    } else {
      // (a chat a real agent was in never goes to the demo: the message waits, pending, until it's connected again)
      entry.mode = "queued";
      this.queues.set(thread.id, [entry, ...(this.queues.get(thread.id) ?? [])]);
      this.save();
    }
  }

  interrupt(thread: Thread) {
    const scripted = this.local.get(thread.id);
    if (scripted) scripted.turn.interrupt();
    else if (this.liveRunning.has(thread.id)) this.host.pairing()?.notify("chat.interrupt", { conversation: thread.id });
  }

  /** A permission prompt's answer: true when the thread changed (the card now shows the answer). */
  answer(thread: Thread, attention: string, approve: boolean | "turn", turnId: string, instance: string): boolean {
    const scripted = this.local.get(thread.id);
    if (scripted) {
      scripted.turn.answer(attention, approve !== false);
      return false;
    }
    // (a card of a turn that's away, or of no turn here, answers nothing: nothing claimed, nothing sent; once the turn
    //  is back, its card can be answered)
    const turn = thread.entries.find((e): e is Turn => e.kind === "turn" && e.turn_id === turnId && !!e.attention[attention]);
    if (!turn || turn.away) return false;
    // (claimed: the card shows the person's answer at once, both buttons gone; a second click finds it claimed)
    if (!this.cards.answer(attention, approve, thread.id, turnId, instance)) return false;
    turn.attention[attention].state = approve !== false ? "approved" : "denied";
    return true;
  }

  /** What the paired agent says: turn events for one of these threads, live or (chat.replay) from its log. `from`: the
   *  pairing it came through; one that isn't the current pairing changes nothing (a late message from a replaced
   *  one must never be read against the new one's run). */
  onAgent(method: string, params: unknown, from?: AgentPairing) {
    if (from !== undefined && from !== this.host.pairing()) return;
    if (method === "chat.replay") return this.onReplay(params);
    if (method === "chat.receipt") return this.onReceipt(params, false);
    if (method === "chat.rejected") return this.onReceipt(rejection(params), false);
    if (method !== "turn.event") return;
    const p = params as { conversation?: unknown } | null;
    const thread = this.state.threads.find((t) => t.id === p?.conversation);
    if (!thread) return;
    // (an agent that keeps a log numbers every event, in the run its hello names: an event without a valid number is
    //  dropped; a thread last in another run starts again. An agent without a log: events as they come, unnumbered)
    const instance = this.resumable();
    if (instance) {
      if (!seqOk((params as { seq?: unknown }).seq)) return;
      if (thread.agent_instance !== instance) this.newRun(thread, instance);
      this.agentEvent(thread, params, false);
    } else {
      const { seq: _drop, ...rest } = params as Record<string, unknown>;
      this.agentEvent(thread, rest, false);
    }
  }

  /** A steer's receipt, live or replayed: it marks the person's steer with what the agent says became of it. Only a
   *  receipt for a steer this thread has, with a known state; numbered (in the run the hello names) where the agent
   *  keeps a log, once. A "queued" steer runs next on the agent's side: the page never sends it again. */
  private onReceipt(params: unknown, replayed: boolean) {
    const p = params as { conversation?: unknown; id?: unknown; state?: unknown; reason?: unknown; seq?: unknown } | null;
    const thread = this.state.threads.find((t) => t.id === p?.conversation);
    if (!thread || !p || typeof p.id !== "string" || !(receiptOk(p.state) || p.state === "rejected")) return;
    if (!replayed) {
      const instance = this.resumable();
      // (numbered where the agent keeps a log; a refusal it never logged, "busy", comes unnumbered)
      if (instance && !(p.state === "rejected" && p.seq === undefined)) {
        if (!seqOk(p.seq)) return;
        if (thread.agent_instance !== instance) this.newRun(thread, instance);
      }
    }
    if (seqOk(p.seq)) {
      if (p.seq <= (thread.agent_seq ?? 0)) return;
      thread.agent_seq = p.seq;
    }
    const entry = thread.entries.find((e): e is UserEntry => e.kind === "user" && e.id === p.id && e.mode === "steer");
    // ("delivered" and "rejected" are final: no late or repeated receipt brings a steer back)
    if (entry && entry.receipt !== "delivered" && entry.receipt !== "rejected") {
      entry.receipt = p.state;
      if (typeof p.reason === "string") entry.receipt_reason = p.reason.slice(0, 16);
    }
    this.save();
    if (!replayed) this.host.changed(true);
  }

  /** The run named by the live pairing's hello, if that agent said it keeps a log (chat.resume); else undefined. */
  private resumable(): string | undefined {
    const pairing = this.host.pairing();
    if (!this.live() || !pairing?.hello?.features?.includes("chat.resume")) return undefined;
    return pairing.hello.log?.instance;
  }

  /** The thread now follows another run of the agent: what was away from the earlier one ends interrupted. */
  private newRun(thread: Thread, instance: string) {
    if (thread.agent_instance) this.endAway(thread);
    thread.agent_instance = instance;
    thread.agent_seq = 0;
  }

  /** One turn event of the agent's, live or replayed: once (by the agent's number), never reopening a finished turn. */
  private agentEvent(thread: Thread, params: unknown, replayed: boolean) {
    const p = params as { seq?: unknown; turn_id?: unknown; event?: { type?: unknown } } | null;
    if (typeof p?.turn_id !== "string" || !p.event || typeof p.event.type !== "string") return;
    if (seqOk(p.seq)) {
      if (p.seq <= (thread.agent_seq ?? 0)) return;
      thread.agent_seq = p.seq;
    }
    const known = thread.entries.find((e): e is Turn => e.kind === "turn" && e.turn_id === p.turn_id);
    if (known?.outcome) return this.save(); // (a turn the page has as finished is never reopened)
    // (a permission card: shown as the cards make it from its admitted action, or not at all)
    const ev = p.event.type === "attention" ? this.cards.view(thread.id, p.turn_id, p.event) : p.event;
    if (!ev) return this.save();
    this.mark(thread);
    this.emit(thread, p.turn_id, ev as Draft, replayed);
    const turn = thread.entries.find((e): e is Turn => e.kind === "turn" && e.turn_id === p.turn_id);
    if (turn && !turn.agent) turn.agent = this.host.pairing()?.hello?.agent.name ?? "agent";
    if (p.event.type === "turn_finished") {
      this.liveRunning.delete(thread.id);
      this.next(thread);
    } else if (!replayed && turn && !turn.outcome) {
      // (a live event of a turn the page didn't start here, or had as away: it is running)
      if (turn.away) delete turn.away;
      this.liveRunning.add(thread.id);
    }
  }

  /** A chat.replay: what the thread missed while the page was away, in the agent's order. Checked whole before
   *  anything is applied: from the live pairing that said chat.resume, for the run its hello named; numbers positive
   *  safe integers; every entry about this thread; a message the person's. Anything else, the replay changes nothing. */
  private onReplay(params: unknown) {
    const p = params as { conversation?: unknown; instance?: unknown; last?: unknown; events?: unknown; done?: unknown } | null;
    const thread = this.state.threads.find((t) => t.id === p?.conversation);
    if (!thread || !p || typeof p.instance !== "string" || p.instance !== this.resumable()) return;
    if (!Number.isSafeInteger(p.last) || (p.last as number) < 0 || typeof p.done !== "boolean" || !Array.isArray(p.events)) return;
    type Entry = { seq: number; method: string; params: Record<string, unknown> };
    const ok = (e: unknown): e is Entry => {
      const x = e as { seq?: unknown; method?: unknown; params?: unknown } | null;
      if (!x || !seqOk(x.seq) || typeof x.method !== "string" || !x.params || typeof x.params !== "object" || Array.isArray(x.params)) return false;
      const q = x.params as Record<string, unknown>;
      if (q.conversation !== thread.id) return false;
      if (x.method === "chat.message") return q.author === "person" && typeof q.id === "string" && typeof q.text === "string";
      if (x.method === "chat.receipt") return typeof q.id === "string" && receiptOk(q.state);
      if (x.method === "chat.rejected") return typeof q.id === "string";
      return true;
    };
    if (!p.events.every(ok)) return;
    // (`running`, step 2: the conversation's turn the agent is still running, at most one id; absent from an agent
    //  without it (the field absent), as none. Anything else, null included: the replay changes nothing)
    const running = "running" in p ? (p as { running?: unknown }).running : [];
    if (!Array.isArray(running) || running.length > 1 || !running.every((r) => typeof r === "string")) return;
    if (thread.agent_instance !== p.instance) this.newRun(thread, p.instance);
    for (const e of p.events as Entry[]) {
      if (e.seq <= (thread.agent_seq ?? 0)) continue;
      if (e.method === "turn.event") this.agentEvent(thread, { ...e.params, seq: e.seq }, true);
      else if (e.method === "chat.receipt") this.onReceipt({ ...e.params, seq: e.seq }, true);
      else if (e.method === "chat.rejected") this.onReceipt({ ...rejection(e.params), seq: e.seq }, true);
      else {
        thread.agent_seq = e.seq;
        const m = e.params as { id: string; text: string };
        // (a message the person sent from another tab: shown as sent; never queued again, never sent again)
        if (e.method === "chat.message" && !thread.entries.some((x) => x.kind === "user" && x.id === m.id)) {
          thread.entries.push({ kind: "user", id: m.id, text: m.text, mode: (e.params as { steer?: unknown }).steer === true ? "steer" : "sent", time: Date.now() });
        }
      }
    }
    const last = p.last as number;
    if (p.done === true || (thread.agent_seq ?? 0) >= last) {
      // (the log has nothing more. An away turn the agent says it is still running goes back to running here (only
      //  that exact turn, already in this thread: `running` never makes or binds another, D8); any other away turn
      //  can't go on, and ends interrupted, the safety net for an agent that ended it without the page seeing)
      const away = awayTurn(thread);
      if (away && running[0] === away.turn_id) {
        delete away.away;
        this.liveRunning.add(thread.id);
        // (as an event of its own, so the page draws the turn as running again)
        this.emit(thread, away.turn_id, { type: "turn_state", state: "running" }, true);
      } else this.endAway(thread);
    } else if (p.done === false) {
      // (stopped early: ask again from the last number this page has)
      this.host.pairing()?.notify("chat.resume", { conversation: thread.id, after: thread.agent_seq ?? 0, instance: p.instance });
    }
    this.save();
    this.host.changed(true);
  }

  /** The pairing ended. With an agent that keeps a log (`resumable`), its running turns are away until the page is
   *  paired again; otherwise they end here, as interrupted. */
  endLive(resumable = false) {
    for (const tid of [...this.liveRunning]) {
      const thread = this.state.threads.find((t) => t.id === tid);
      const r = thread && runningTurn(thread);
      if (!thread || !r) continue;
      if (resumable && thread.agent_instance) this.setAway(thread, r);
      else this.emit(thread, r.turn_id, { type: "turn_finished", outcome: "interrupted" });
    }
    this.liveRunning.clear();
  }
}
