// The Agents page's Delegate tasks (Pair and Delegate plan, UI r3.2 §2, UI-3): the tasks of the paired agent's
// installation, each with its status and its chat thread, read from the agent (design/workspace-agent-protocol.md §6,
// `delegate.1`); Start; the Delegate switch's off; and a proposal's files for the proposal view. No DOM here: the page
// (page.ts) draws it.
//
// - Nothing about a task is kept on the page: the list comes from tasks.list on every connect and switch-on, a task's
//   thread from tasks.get (paged by `after`) when it is opened, and both move on with task.event while connected.
// - Every answer and event is checked first (tasks-schema.ts). One event this page refuses is skipped and counted
//   (`skipped`), and the rest of the thread still shows.
// - A task's chat turn events go into an ordinary chat thread (agent-chat/events.ts apply), numbered by the task's seq.
//   Its task_status and proposal events move its chip and its proposal.
// - The switch's off (§6.2; UI r3.2 §11): from its first moment Start is refused here, nothing sent; the tasks the
//   person chose to close are revoked first (each failure or timeout only reported); then the grant goes without
//   `delegate`, always, whatever happened to those.
// - A proposal's files (ProposalSource): only the proposal commit named and its base, each file's bytes checked against
//   the blob id tasks.diff gave for that path at that commit (its git blob id, recomputed here).
import { AgentError, type AgentPairing } from "../workspace/agent-pair";
import { DELEGATE_FEATURE, TaskClient } from "../workspace/tasks-client";
import { TASK_RESULTS, blobId, contentBytes, taskLog, taskNotice, type DiffFile, type TaskEntry, type TaskLogEntry } from "../workspace/tasks-schema";
import { apply, newThread, type Thread, type TurnEvent } from "../workspace/agent-chat/events";
import type { ProposalDiff, ProposalSource } from "../workspace/review/proposal-view";

export type DelegateState = "unoffered" | "off" | "turning-off" | "on";
export type DelegateDoc = { path: string; kind: "notebook" | "file"; content: string };
export type DelegateTask = {
  entry: TaskEntry;
  /** its chat turn events, as a chat thread; `applied_seq` is the task's seq of the last event taken */
  thread: Thread;
  proposal: { round: number; base: string; commit: string; files: DiffFile[] } | null;
  /** the last task_status's reason, if it gave one */
  reason?: string;
  /** events this page refused, skipped */
  skipped: number;
  /** whether its thread has been read from the agent (tasks.get); until then only its chip moves */
  loaded: boolean;
  // (the turn its next untagged turn event belongs to: the agent records them without turn_id)
  turn: string | null;
};

export const DELEGATE_LIMITS = Object.freeze({ pages: 1000, closing: 4, closeMs: 10_000 });

export const DELEGATE_TEXT = {
  chip: { working: "Working", question: "Question", proposal: "Proposal ready", merged: "Merged", closed: "Closed", failed: "Failed", interrupted: "Interrupted" } as Record<string, string>,
  turningOff: "Delegate is turning off",
  off: "Delegate tasks aren't turned on for this agent",
  changed: "The proposal changed while you were reading it",
  binary: "This file isn't text",
  notThis: "That file isn't part of this proposal",
} as const;

/** A task's chip: its status, or Question while it works waiting for an answer. */
export const chipOf = (e: TaskEntry) => DELEGATE_TEXT.chip[e.status === "working" && e.question ? "question" : e.status];

export class DelegateTasks {
  /** the tasks, newest first */
  tasks: DelegateTask[] = [];
  private p: AgentPairing | null = null;
  private off = false;
  private unlisten: (() => void)[] = [];
  private wasOn = false;
  private loading = new Map<string, Promise<void>>();

  constructor(private o: { changed: () => void }) {}

  /** Follow this pairing (or none): its switch, and its task.event notifications. */
  attach(p: AgentPairing | null) {
    for (const u of this.unlisten.splice(0)) u();
    this.p = p;
    this.tasks = [];
    this.wasOn = false;
    if (p) {
      this.unlisten.push(p.onChange(() => this.moved()));
      this.unlisten.push(p.onNotification((method, params) => { if (method === "task.event") this.heard(params); }));
    }
    this.moved();
  }

  state(): DelegateState {
    const p = this.p;
    if (!p || p.state !== "granted" || p.link || !p.hello?.features?.includes(DELEGATE_FEATURE)) return "unoffered";
    if (this.off) return "turning-off";
    return p.grant?.delegate === true ? "on" : "off";
  }

  task(id: string) { return this.tasks.find((t) => t.entry.task === id); }

  // (the pairing moved: a switch turned on reads the list; without the switch, no tasks are shown)
  private moved() {
    const on = this.state() === "on";
    if (on && !this.wasOn) void this.refresh().catch(() => {});
    if (!on && this.state() !== "turning-off" && this.tasks.length) this.tasks = [];
    this.wasOn = on;
    this.o.changed();
  }

  private client(): TaskClient {
    if (!this.p) throw new AgentError("closed", "the agent isn't connected");
    return TaskClient.of(this.p);
  }

  /** The list, from tasks.list: each task's entry, its thread kept (and read further if it is open and moved on). */
  async refresh() {
    const p = this.p;
    const { tasks } = TASK_RESULTS["tasks.list"](await this.client().request("tasks.list", {}));
    if (p !== this.p || this.state() !== "on") return;
    const next: DelegateTask[] = [];
    for (const entry of [...tasks].sort((a, b) => b.updated - a.updated)) {
      const t = this.task(entry.task);
      if (t) {
        t.entry = { ...entry, seq: Math.max(entry.seq, t.thread.applied_seq) };
        if (t.loaded && entry.seq > t.thread.applied_seq) void this.open(entry.task).catch(() => {});
        next.push(t);
      } else next.push(fresh(entry));
    }
    this.tasks = next;
    this.o.changed();
  }

  /** A task's thread read from the agent: tasks.get from what this page has, page by page, until its seq. */
  open(id: string): Promise<void> {
    const held = this.loading.get(id);
    if (held) return held;
    const run = (async () => {
      const p = this.p;
      for (let page = 0; page < DELEGATE_LIMITS.pages; page++) {
        const t = this.task(id);
        if (!t) return;
        const r = taskLog(await this.client().request("tasks.get", { task: id, after: t.thread.applied_seq }));
        if (p !== this.p || this.task(id) !== t) return;
        if (r.task.task !== id) throw new AgentError("bad_request", "the agent answered for another task");
        let cur = t;
        if (r.reset) {
          // (the agent doesn't know where this page was: read again from the start)
          cur = fresh(r.task);
          this.tasks = this.tasks.map((x) => (x === t ? cur : x));
        }
        for (const e of r.events) if (!take(cur, e)) break;
        cur.entry = { ...r.task, seq: Math.max(r.task.seq, cur.thread.applied_seq) };
        cur.loaded = true;
        this.o.changed();
        if (r.last >= r.task.seq || !r.events.length) return;
      }
    })();
    this.loading.set(id, run);
    return run.finally(() => this.loading.delete(id));
  }

  // (a task.event: an open task's thread takes it in order (a gap reads the log again); a task not open moves its chip
  //  only; a task not listed yet reads the list)
  private heard(params: unknown) {
    if (this.state() !== "on") return;
    let n: { task: string } & TaskLogEntry;
    try { n = taskNotice(params); } catch { return; }
    const t = this.task(n.task);
    if (!t) { void this.refresh().catch(() => {}); return; }
    if (!t.loaded) {
      if ("event" in n) chip(t, n.event as any, n.seq);
      this.o.changed();
      return;
    }
    if (!take(t, n)) void this.open(n.task).catch(() => {});
    this.o.changed();
  }

  /** Start a task (tasks.start): only with the switch on, never while it turns off. */
  async start(o: { title: string; prompt: string; docs: DelegateDoc[]; run: boolean }): Promise<string> {
    const s = this.state();
    if (s !== "on") throw new AgentError("forbidden", s === "turning-off" ? DELEGATE_TEXT.turningOff : DELEGATE_TEXT.off);
    const r = TASK_RESULTS["tasks.start"](await this.client().request("tasks.start", { title: o.title, prompt: o.prompt, target: "local", run: o.run, docs: o.docs }));
    await this.refresh().catch(() => {});
    return r.task;
  }

  /** The switch turned on (AgentPairing.setDelegate). */
  turnOn(): boolean { return !!this.p && this.state() === "off" && this.p.setDelegate(true); }

  /** The switch turned off: the tasks in `close` revoked first (closed for good), a few at a time, each failure or
   * timeout only reported (the ids returned); then the capability revoked, always. */
  async turnOff(close: string[]): Promise<string[]> {
    const p = this.p;
    if (!p || this.off) return [];
    this.off = true;
    this.o.changed();
    const failed: string[] = [];
    try {
      const left = [...close];
      const one = async () => {
        for (let id = left.shift(); id !== undefined; id = left.shift()) {
          try { TASK_RESULTS["tasks.revoke"](await TaskClient.of(p).request("tasks.revoke", { task: id }, { timeoutMs: DELEGATE_LIMITS.closeMs })); } catch { failed.push(id); }
        }
      };
      await Promise.all(Array.from({ length: Math.min(DELEGATE_LIMITS.closing, left.length) }, one));
    } finally {
      p.setDelegate(false);
      this.off = false;
      if (p === this.p) this.tasks = [];
      this.moved();
    }
    return failed;
  }

  /** A proposal's files, for the proposal view: `commit` and its base only, each file checked against its blob id. */
  source(id: string, commit: string): ProposalSource {
    let diff: { base: string; commit: string; files: DiffFile[] } | null = null;
    return {
      diff: async (): Promise<ProposalDiff> => {
        const d = TASK_RESULTS["tasks.diff"](await this.client().request("tasks.diff", { task: id, commit }));
        if (d.task !== id || d.commit !== commit) throw new AgentError("bad_request", "the agent answered for another proposal");
        diff = d;
        return { base: d.base, proposal: d.commit, round: d.round, seq: d.seq, files: d.files.map((f) => ({ path: f.path, kind: f.kind, change: f.change })) };
      },
      file: async (path: string, at: string): Promise<string | null> => {
        const f = diff?.files.find((x) => x.path === path);
        const want = !diff || !f ? undefined : at === diff.commit ? f.blob : at === diff.base ? f.base_blob : undefined;
        if (want === undefined) throw new AgentError("bad_request", DELEGATE_TEXT.notThis);
        if (want === null) return null;
        const r = TASK_RESULTS["tasks.file"](await this.client().request("tasks.file", { task: id, commit: at, path }));
        const bytes = contentBytes(r.content);
        if (r.blob !== want || (await blobId(bytes)) !== want) throw new AgentError("stale", DELEGATE_TEXT.changed);
        if (typeof r.content === "string") return r.content;
        try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw new AgentError("bad_request", DELEGATE_TEXT.binary); }
      },
    };
  }
}

function fresh(entry: TaskEntry): DelegateTask {
  return { entry: { ...entry }, thread: newThread("task:" + entry.task, entry.title), proposal: null, skipped: 0, loaded: false, turn: null };
}

// (a task's own event on its entry: its chip and its proposal)
function chip(t: DelegateTask, e: TaskLogEntry extends infer _ ? any : never, seq: number) {
  if (e.type === "task_status") {
    t.entry = { ...t.entry, status: e.status, seq: Math.max(t.entry.seq, seq), ...(e.status === "working" ? {} : { question: false }) };
    t.reason = e.reason;
  } else if (e.type === "proposal") {
    t.proposal = { round: e.round, base: e.base, commit: e.commit, files: e.files };
    t.entry = { ...t.entry, round: e.round, proposal: e.commit, seq: Math.max(t.entry.seq, seq) };
  }
}

/** One event of a task's log, in seq order: false if it doesn't follow on (a gap: read the log again). */
function take(t: DelegateTask, e: TaskLogEntry): boolean {
  const th = t.thread;
  if (e.seq <= th.applied_seq) return true;
  if (e.seq !== th.applied_seq + 1) return false;
  if ("refused" in e) {
    t.skipped++;
    th.applied_seq = e.seq;
    return true;
  }
  const ev = e.event;
  if (ev.type !== "turn") {
    // (task_status and proposal move the chip; the question events are M2's, not shown yet)
    chip(t, ev, e.seq);
    th.applied_seq = e.seq;
    return true;
  }
  const d = ev.event as Record<string, unknown> & { type: string; turn_id?: string };
  // (a turn's events, untagged by the agent, belong to the turn its last turn_started began; tagged ones to their own)
  if (d.type === "turn_started" || !t.turn) t.turn = "s" + e.seq;
  const turn_id = typeof d.turn_id === "string" ? d.turn_id : t.turn;
  apply(th, { ...d, seq: e.seq, turn_id } as unknown as TurnEvent);
  if (d.type === "turn_finished") t.turn = null;
  th.applied_seq = e.seq;
  return true;
}
