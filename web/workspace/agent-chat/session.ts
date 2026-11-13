// The agents chat's conversation, apart from any page that draws it (the Agents page, and the chat panel to come): the
// threads, the person's messages and their queue, the paired agent's turns and permission cards, and a scripted turn
// where the page offers one. Drawing, persistence and the page's words are the host's, passed in.
import { apply, newThread, runningTurn, type Draft, type Thread, type Turn, type TurnEvent, type UserEntry } from "./events";
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
  /** an event was applied to a thread (the page draws it, opens an artifact, ...) */
  emitted(thread: Thread, d: Draft): void;
  /** what the composer shows changed (running, queued); `all`: the thread and its list too */
  changed(all: boolean): void;
  /** a message didn't go to the agent: its queue is full, it's over the connection's limit, or the agent is gone */
  notSent(why: "full" | "over" | "disconnected"): void;
}

const id = () => Math.random().toString(36).slice(2, 10);

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
    this.cards = new PermissionCards({ current: () => host.pairing(), gate: digestGate, charge: DIGEST_CHARGE });
  }

  /** A turn that was running when the page closed can't go on: it ends interrupted (the host calls this once it can
   *  draw). */
  endInterrupted() {
    for (const t of this.state.threads) {
      const r = runningTurn(t);
      if (r) this.emit(t, r.turn_id, { type: "turn_finished", outcome: "interrupted" });
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

  /** An event, applied to its thread and kept. */
  emit(thread: Thread, turn_id: string, d: Draft) {
    const e = { ...d, seq: thread.applied_seq + 1, turn_id } as TurnEvent;
    apply(thread, e);
    this.host.emitted(thread, d);
    this.save();
  }

  /** The person's message in the current thread: false when it can't be taken (the draft stays). */
  submit(text: string, mode: UserEntry["mode"]): boolean {
    text = text.trim();
    if (!text) return false;
    const thread = this.current();
    if (mode !== "note" && this.inert(thread)) return false;
    const busy = this.isRunning(thread);
    if (mode === "queued" && !busy) mode = "sent";
    const entry: UserEntry = { kind: "user", id: id(), text, mode, time: Date.now() };
    thread.entries.push(entry);
    if (thread.title === "New chat") thread.title = text.split("\n")[0].slice(0, 48);
    if (mode === "queued") {
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
  answer(thread: Thread, attention: string, approve: boolean, turnId: string, instance: string): boolean {
    const scripted = this.local.get(thread.id);
    if (scripted) {
      scripted.turn.answer(attention, approve);
      return false;
    }
    // (claimed: the card shows the person's answer at once, both buttons gone; a second click finds it claimed)
    if (!this.cards.answer(attention, approve, thread.id, turnId, instance)) return false;
    const turn = thread.entries.find((e): e is Turn => e.kind === "turn" && e.turn_id === turnId && !!e.attention[attention]);
    if (!turn) return false;
    turn.attention[attention].state = approve ? "approved" : "denied";
    return true;
  }

  /** What the paired agent says: turn events for one of these threads. */
  onAgent(method: string, params: unknown) {
    if (method !== "turn.event") return;
    const p = params as { conversation?: unknown; turn_id?: unknown; event?: { type?: unknown } } | null;
    const thread = this.state.threads.find((t) => t.id === p?.conversation);
    if (!thread || typeof p?.turn_id !== "string" || !p.event || typeof p.event.type !== "string") return;
    // (a permission card: shown as the cards make it from its admitted action, or not at all)
    const ev = p.event.type === "attention" ? this.cards.view(thread.id, p.turn_id, p.event) : p.event;
    if (!ev) return;
    this.mark(thread);
    this.emit(thread, p.turn_id, ev as Draft);
    const turn = thread.entries.find((e): e is Turn => e.kind === "turn" && e.turn_id === p.turn_id);
    if (turn && !turn.agent) turn.agent = this.host.pairing()?.hello?.agent.name ?? "agent";
    if (p.event.type === "turn_finished") {
      this.liveRunning.delete(thread.id);
      this.next(thread);
    }
  }

  /** The pairing ended: turns the agent can no longer finish end here, as interrupted. */
  endLive() {
    for (const tid of [...this.liveRunning]) {
      const thread = this.state.threads.find((t) => t.id === tid);
      const r = thread && runningTurn(thread);
      if (thread && r) this.emit(thread, r.turn_id, { type: "turn_finished", outcome: "interrupted" });
    }
    this.liveRunning.clear();
  }
}
