// The Agents page's Delegate controls (Pair and Delegate plan, UI r3.2 §2; UI-3), drawn from delegate.ts's model:
//   - the switch in the header ("Delegate: on/off"): on after the person confirms what it allows; off with a
//     confirmation that may also close the running tasks for good (unticked), sent first; the page's task actions
//     disabled from the moment it starts turning off;
//   - Delegate… beside Send: a sheet with the task (the composer's text), its title, the documents (the file open in the
//     pane, editable), where it runs (this computer), and May run code (only if the grant may, frozen at Start);
//   - the Tasks list under the chats, each with its chip;
//   - a task's view in place of the chat: its status, its thread (the agent's turns), and its proposal's card, which
//     opens the proposal view (the review chunk's) in a dialog, with its actions: Merge (delegate-merge.ts: each
//     conflict picked first; an incomplete one said on the task's chip, and a kept one finished after a reload),
//     Close, and Ask for changes (S3 P2: a note, with the person's current versions of the task's own files, back to
//     the same task; its next round replaces the one shown, in place).
// Shown only for an agent on this computer whose hello offers delegate.1: nothing changes for any other.
import type { Thread, Turn } from "../workspace/agent-chat/events";
import { AgentError } from "../workspace/agent-pair";
import { chipOf, currentOf, DELEGATE_LIMITS, DELEGATE_TEXT, type DelegateDoc, type DelegateTasks } from "./delegate";
import { MergeError, clearPicks, closeRest, isDone, loadPicks, mergedParams, newRecord, prepare, recordOf, revise, run, savePicks, unpicked, unresolved, type FileMerge, type MergeIO, type MergeRecord, type Picks, type Pinned } from "./delegate-merge";

export const DELEGATE_UI_TEXT = {
  switchOn: "Delegate: on",
  switchOff: "Delegate: off",
  switchTurning: "Delegate: turning off…",
  onTitle: "Allow Delegate tasks on this computer?",
  onBody: (agent: string) => `${agent} works on its own copy of the documents you choose, on this computer, and proposes the changes back to you. Turning this on lets this page start tasks, and read every existing Delegate task of this agent installation. You can turn it off at any time.`,
  offTitle: "Turn off Delegate tasks?",
  offBody: "This page will no longer start or read tasks. Running turns stop; your tasks stay available.",
  alsoClose: (n: number) => `Also close ${n === 1 ? "my running task" : `my ${n} running tasks`} for good`,
  closeFailed: (n: number) => `Delegate is off. ${n === 1 ? "One task" : `${n} tasks`} couldn't be closed.`,
  sheetTitle: "Delegate a task",
  drafting: "Drafting a brief from this chat…",
  stopDrafting: "Stop drafting",
  briefBusy: "The agent is busy: wait a moment and open Delegate… again, or write the task yourself.",
  briefUnavailable: "This chat can't draft a brief: write the task yourself.",
  briefStopped: "Drafting stopped: write the task yourself.",
  briefFailed: "Couldn't draft a brief: write the task yourself.",
  where: "This computer",
  whereNote: "The task's copy and its runs stay on this computer.",
  run: "May run code",
  runNote: "Fixed for this task once it starts.",
  runNotGranted: "Your grant to this agent doesn't allow running code.",
  noDocs: "No documents: add a path, or open a file in the pane first.",
  start: "Start",
  starting: "Starting…",
  tasks: "Tasks",
  away: "Agent not connected: these are the tasks it had when the page last heard from it.",
  skipped: (n: number) => (n === 1 ? "One event of this task couldn't be shown here." : `${n} events of this task couldn't be shown here.`),
  proposal: (n: number, base: string, commit: string) => `Proposal: ${n === 1 ? "1 file" : `${n} files`} changed · base ${base.slice(0, 7)} · proposal ${commit.slice(0, 7)}`,
  merge: "Merge",
  merging: "Merging…",
  mergeFailed: "Couldn't merge.",
  pickAll: (n: number) => `Pick a side for ${n === 1 ? "the conflict" : `each of the ${n} conflicts`}, then Merge.`,
  picksDropped: (paths: string[]) => `Your picks for ${paths.join(", ")} were made against another version: pick again.`,
  yours: "Yours",
  keepMine: "Keep mine",
  take: (agent: string) => `Take ${agent}'s`,
  incomplete: "Merge incomplete",
  incompleteBody: (paths: string[]) => `${paths.length === 1 ? "This file" : "These files"} couldn't be merged: ${paths.join(", ")}. Each changed, or couldn't be read or written, while the merge was written. Merge again to merge ${paths.length === 1 ? "it" : "them"} as ${paths.length === 1 ? "it is" : "they are"} now, or close what's left. The files already written stay as they are.`,
  closeRest: "Close what's left",
  merged: "Merged: your files have the changes.",
  mergedPart: (written: string[], left: string[]) => `Recorded. ${written.length ? `Merged: ${written.join(", ")}.` : "Nothing was merged."} Left as they were: ${left.join(", ")}.`,
  notRecorded: (m: string) => `The agent didn't record this decision: ${m}. Files already written keep their changes.`,
  notRecordedYet: "The agent hasn't recorded this decision yet. Files already written keep their changes. Merge again to try again.",
  ask: "Ask for changes",
  closeTask: "Close",
  closeTitle: "Close this proposal?",
  closeBody: "The task ends here and its proposal isn't used. Your files don't change.",
  closeOk: "Close the task",
  closed: "Task closed",
  closeTaskFailed: "Couldn't close the task.",
  stale: "The task moved on since you opened this: here it is as it is now.",
  newRound: (n: number) => `A new proposal (round ${n}) replaces the one you were reading.`,
  askLabel: "What should change?",
  askPlaceholder: "For example: call the section Findings, and keep the plot's colors.",
  askFiles: (paths: string[]) => (paths.length ? `When available, your current versions of these files go with your note: ${paths.join(", ")}. A file that can't be read here is left out, and the task uses its own copy of it.` : "No current versions go with your note: the task works from its own copy."),
  askSend: "Send to the task",
  askSending: "Sending…",
  askLoading: "The proposal is still being read: try again in a moment.",
  askStale: "The task moved on since you opened this: it's read again, and your note is kept to send again.",
  askSent: (round: number) => `Asked. The task is working on round ${round + 1}; it appears here when it's ready.`,
  unreadable: "Couldn't read this task from the agent.",
  back: "← Back to chats",
} as const;

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] => {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids);
  return e;
};

export type DelegateHost = {
  tasks: DelegateTasks;
  agent: () => string;
  mayRun: () => boolean;
  openPath: () => string | null;
  draft: () => string;
  clearDraft: () => void;
  readDoc: (path: string) => Promise<DelegateDoc>;
  /** the Pair chat shown, as the agent knows it (its conversation id), if it has one: what a brief is drafted from */
  conversation?: () => string | null;
  turnNode: (thread: Thread, turn: Turn) => HTMLElement;
  /** the task view shown (true) or gone (false): the page hides or shows its chat */
  shown: (on: boolean) => void;
  site: URL;
  /** the LaTeX page module, where this page has the LaTeX editor: a proposal's .tex shown rendered (none: its diff only) */
  latex?: (() => Promise<any>) | null;
  toast: (text: string, ms?: number) => void;
  /** Merge's workspace and agent (delegate-merge.ts workspaceIO); without it, Merge stays off */
  merge?: MergeIO;
  /** where conflict picks are kept for the session (sessionStorage) */
  session?: Storage;
};

export function mountDelegate(h: DelegateHost) {
  const T = DELEGATE_UI_TEXT, D = h.tasks;
  let open: string | null = null, readErr = false;

  // ---- Merge's decisions kept on this device (delegate-merge.ts): one at a time per task; a kept one finished when its
  //      task is listed (after a crash or a reload), and what is left of an incomplete one said on its chip
  const busyMerge = new Map<string, Promise<unknown>>();
  const one = <R>(task: string, f: () => Promise<R>): Promise<R> => {
    const run = (busyMerge.get(task) ?? Promise.resolve()).catch(() => {}).then(f);
    busyMerge.set(task, run);
    return run.finally(() => { if (busyMerge.get(task) === run) busyMerge.delete(task); });
  };
  const incomplete = new Set<string>(), looked = new Set<string>();
  // (what is under way on each task, whoever started it: a Merge (or its recovery, or Close what's left), an Ask for
  //  changes or a Close, one at a time. Kept here, not in a dialog, so a dialog closed and opened again while one runs
  //  still waits for it; each action takes it when it starts and gives it back when it ends, and every dialog's
  //  actions are drawn from it)
  const underway = new Map<string, "merge" | "ask" | "close">();
  const begin = (task: string, op: "merge" | "ask" | "close") => { if (underway.has(task)) return false; underway.set(task, op); render(); return true; };
  const end = (task: string, op: "merge" | "ask" | "close") => { if (underway.get(task) !== op) return; underway.delete(task); render(); };
  /** tasks.merged from the record, then the record forgotten: true, or what to say. A refusal that won't change on a
   * retry (stale, final, conflict) forgets it too; any other failure keeps it, to try again. */
  async function recordMerge(task: string, rec: MergeRecord): Promise<true | string> {
    try {
      await D.merged(task, await mergedParams(rec));
    } catch (err) {
      const code = (err as AgentError)?.code;
      if (code !== "stale" && code !== "final" && code !== "conflict") return T.notRecordedYet;
      await h.merge!.save(task, null);
      incomplete.delete(task);
      return T.notRecorded((err as Error).message);
    }
    await h.merge!.save(task, null);
    if (h.session) clearPicks(h.session, task);
    incomplete.delete(task);
    render();
    return true;
  }
  function recover(task: string) {
    const io = h.merge;
    if (!io || looked.has(task)) return;
    looked.add(task);
    void one(task, async () => {
      // (another action under way on this task: looked at again on a later listing)
      if (!begin(task, "merge")) { looked.delete(task); return; }
      try {
        const rec = recordOf(await io.load(task), task);
        if (!rec) return;
        const after = await run(io, rec);
        if (isDone(after)) { if ((await recordMerge(task, after)) !== true) incomplete.add(task); }
        else incomplete.add(task);
        render();
      } finally {
        end(task, "merge");
      }
    }).catch(() => { looked.delete(task); });
  }

  // (the switch, in the header; Delegate…, beside Send; the Tasks list, under the chats; the task's view, in place of
  //  the chat)
  const sw = el("button", { id: "delegate-switch", className: "link", hidden: true, type: "button" });
  document.querySelector("#connect")?.before(sw);
  const btn = el("button", { id: "delegate", hidden: true, type: "button", title: "Give the agent a task to work on by itself, on its own copy" }, "Delegate…");
  document.querySelector("#send")?.before(btn);
  const list = el("div", { className: "list" });
  const side = el("div", { id: "tasks", hidden: true }, el("div", { className: "tasks-h" }, T.tasks), list);
  document.querySelector("#threads")?.after(side);
  const view = el("section", { id: "task-view", hidden: true, ariaLabel: "Task" });
  document.querySelector("main .composer-wrap")?.before(view);

  // (Ask for changes' unsent note, kept per task in this browser)
  const noteKey = (task: string) => `sb-delegate-ask-v1:${task}`;

  function confirmDialog(title: string, body: string, ok: string, extra?: HTMLElement): Promise<boolean> {
    const dlg = el("dialog", { className: "delegate-dlg" });
    const form = el("form", { method: "dialog" },
      el("h3", { textContent: title }), el("p", { textContent: body }), ...(extra ? [extra] : []),
      el("menu", {}, el("button", { value: "cancel", textContent: "Cancel" }), " ", el("button", { value: "ok", className: "primary", textContent: ok })));
    dlg.append(form);
    document.body.append(dlg);
    dlg.showModal();
    return new Promise((resolve) => dlg.addEventListener("close", () => { resolve(dlg.returnValue === "ok"); dlg.remove(); }, { once: true }));
  }

  async function switchOn(): Promise<boolean> {
    if (D.state() !== "off") return D.state() === "on";
    if (!(await confirmDialog(T.onTitle, T.onBody(h.agent()), "Turn on"))) return false;
    return D.turnOn();
  }
  async function switchOff() {
    if (D.state() !== "on") return;
    const running = D.tasks.filter((t) => t.entry.status === "working");
    const box = el("input", { type: "checkbox", id: "delegate-also-close" });
    const extra = running.length
      ? el("div", { className: "also" }, el("label", {}, box, " ", T.alsoClose(running.length)), el("ul", {}, ...running.map((t) => el("li", { textContent: t.entry.title }))))
      : undefined;
    if (!(await confirmDialog(T.offTitle, T.offBody, "Turn off", extra))) return;
    // (from here the page's task actions are off: Delegate…, Start; the chosen tasks are closed first, then the switch)
    const failed = await D.turnOff(box.checked ? running.map((t) => t.entry.task) : []);
    if (failed.length) h.toast(T.closeFailed(failed.length), 6000);
    close();
  }
  sw.onclick = () => void (D.state() === "on" ? switchOff() : D.state() === "off" ? switchOn().then(() => render()) : undefined);

  // ---- the sheet
  btn.onclick = async () => {
    if (btn.getAttribute("aria-disabled") === "true") return;
    if (!(await switchOn())) return;
    sheet();
  };
  function sheet() {
    const prompt = el("textarea", { id: "delegate-prompt", rows: 5, value: h.draft(), required: true, maxLength: 64 * 1024 });
    const firstLine = h.draft().trim().split("\n")[0] ?? "";
    const title = el("input", { id: "delegate-title", value: firstLine.slice(0, 80), maxLength: 200, required: true });
    const docs = el("ul", { className: "docs" });
    const addDoc = (p: string) => {
      p = p.trim().replace(/^\/+/, "");
      if (!p || [...docs.querySelectorAll("li")].some((li) => li.dataset.path === p)) return;
      const x = el("button", { type: "button", className: "icon", title: "Remove", textContent: "×" });
      const li = el("li", {}, el("code", { textContent: p }), " ", x);
      li.dataset.path = p;
      x.onclick = () => li.remove();
      docs.append(li);
    };
    const here = h.openPath();
    if (here) addDoc(here);
    const more = el("input", { id: "delegate-add", placeholder: "Add a path, e.g. work/notes.ipynb" });
    more.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); addDoc(more.value); more.value = ""; } };
    const run = el("input", { type: "checkbox", id: "delegate-run", disabled: !h.mayRun() });
    const msg = el("p", { className: "msg", role: "alert" });
    const start = el("button", { type: "submit", className: "primary", textContent: T.start });
    const dlg = el("dialog", { className: "delegate-dlg sheet", ariaLabel: T.sheetTitle });
    const form = el("form", {},
      el("h3", { textContent: T.sheetTitle }),
      el("label", {}, "Task", prompt),
      el("label", {}, "Title", title),
      el("div", { className: "field" }, el("span", {}, "Documents"), docs, more),
      el("div", { className: "field" }, el("span", {}, "Where"), el("label", {}, el("input", { type: "radio", checked: true, name: "where" }), " ", T.where), el("small", { textContent: T.whereNote })),
      el("div", { className: "field" }, el("label", {}, run, " ", T.run), el("small", { textContent: h.mayRun() ? T.runNote : T.runNotGranted })),
      msg,
      el("menu", {}, el("button", { type: "button", value: "cancel", textContent: "Cancel", onclick: () => dlg.close() }), " ", start));
    // (a brief drafted by the agent from the Pair chat shown (chat.brief): only when it drafts them, there is such a
    //  chat, and nothing was typed in the composer, which stays the task as before. While it drafts, the task and its
    //  title wait, read only, and Start is off; Stop drafting, or closing the sheet, cancels it, and a late result is
    //  dropped. A refusal says so in words of the page's own, and the box is left to the person)
    const conv = h.conversation?.() ?? null;
    let drafting = false;
    const stop = el("button", { type: "button", className: "link", textContent: T.stopDrafting });
    const draftLine = el("p", { className: "st brief-drafting", hidden: true, role: "status" }, el("span", { textContent: T.drafting }), " ", stop);
    form.insertBefore(draftLine, form.querySelector("label"));
    const drafted = (on: boolean) => {
      drafting = on;
      prompt.readOnly = title.readOnly = on;
      on ? start.setAttribute("aria-disabled", "true") : start.removeAttribute("aria-disabled");
      draftLine.hidden = !on;
    };
    stop.onclick = () => { if (!drafting || !conv) return; D.cancelBrief(conv); drafted(false); msg.textContent = T.briefStopped; };
    if (conv && !h.draft().trim() && D.briefOffered()) {
      drafted(true);
      D.brief(conv).then((r) => {
        if (!drafting || !dlg.isConnected) return;
        prompt.value = r.brief;
        title.value = r.title;
        drafted(false);
      }, (err) => {
        if (!drafting || !dlg.isConnected) return;
        drafted(false);
        const code = (err as AgentError)?.code;
        msg.textContent = code === "busy" ? T.briefBusy : code === "unavailable" || code === "not_found" ? T.briefUnavailable : code === "stopped" ? T.briefStopped : T.briefFailed;
      });
    }
    dlg.append(form);
    document.body.append(dlg);
    dlg.addEventListener("close", () => { if (drafting && conv) D.cancelBrief(conv); drafting = false; dlg.remove(); }, { once: true });
    dlg.showModal();
    form.onsubmit = async (e) => {
      e.preventDefault();
      if (drafting) return;
      if (more.value.trim()) { addDoc(more.value); more.value = ""; }
      const paths = [...docs.querySelectorAll("li")].map((li) => li.dataset.path!);
      if (D.state() !== "on") { msg.textContent = D.state() === "turning-off" ? "Delegate is turning off." : "Delegate is off."; return; }
      if (!prompt.value.trim() || !title.value.trim()) { msg.textContent = "Say what the task is, and give it a title."; return; }
      if (!paths.length) { msg.textContent = T.noDocs; return; }
      start.textContent = T.starting;
      start.setAttribute("aria-disabled", "true");
      try {
        const read = await Promise.all(paths.map((p) => h.readDoc(p)));
        const id = await D.start({ title: title.value.trim(), prompt: prompt.value, docs: read, run: run.checked });
        h.clearDraft();
        dlg.close();
        show(id);
      } catch (err) {
        msg.textContent = err instanceof AgentError || err instanceof Error ? `Couldn't start the task: ${err.message}` : "Couldn't start the task.";
      } finally {
        start.textContent = T.start;
        start.removeAttribute("aria-disabled");
      }
    };
  }

  // ---- a task's view
  function show(id: string) {
    open = id;
    readErr = false;
    h.shown(true);
    render();
    void D.open(id).then(() => render(), () => { readErr = true; render(); });
  }
  function close() {
    if (open === null) return;
    open = null;
    view.hidden = true;
    h.shown(false);
    render();
  }
  // (the proposal open in its dialog, one at a time: its task, the commit shown, and how a newer round replaces it)
  let shown: { id: string; commit: string; sync(): void } | null = null;
  async function openProposal(id: string, commit: string) {
    const dlg = el("dialog", { className: "delegate-dlg proposal" });
    const panel = el("div");
    dlg.append(el("button", { type: "button", className: "x", ariaLabel: "Close", textContent: "×", onclick: () => dlg.close() }), panel);
    document.body.append(dlg);
    dlg.showModal();
    let pv: { close(): void; refresh(): void } | null = null, src: ReturnType<typeof D.source> | null = null;
    // (its actions, at the proposal's foot: Merge, Ask for changes and Close)
    const act = (key: string, label: string) => { const b = el("button", { type: "button", textContent: label }); b.dataset.act = key; return b; };
    const merge = act("merge", T.merge), ask = act("ask", T.ask), closeBtn = act("close", T.closeTask);
    const status = el("p", { className: "st", role: "status" });
    // (Ask for changes' own block goes in askSlot, under the actions, for the commit shown (me.commit) and its files
    //  (src.seen().files))
    const askSlot = el("div", { className: "ask-slot" });
    // (Merge's conflicts, to pick, and what is left of an incomplete merge)
    const mergeSlot = el("div", { className: "merge-slot" });
    const bar = el("div", { className: "proposal-actions" }, el("div", { className: "row" }, merge, ask, closeBtn), status, mergeSlot, askSlot);
    // (the files as last merged for picking, and the picks)
    let plans: FileMerge[] | null = null, picks: Record<string, Picks> = {};
    const me = { id, commit, sync: () => {} };
    shown = me;
    dlg.addEventListener("close", () => { pv?.close(); dlg.remove(); if (shown === me) shown = null; }, { once: true });
    const mod = (await import(new URL("sagebrush-review.js", h.site).href)) as typeof import("../workspace/review/review-page");
    if (!dlg.isConnected) return;
    const mount = (c: string) => {
      pv?.close();
      plans = null;
      picks = {};
      mergeSlot.replaceChildren();
      me.commit = c;
      // (a new round: any Ask for changes block was the old round's)
      askSlot.replaceChildren();
      src = D.source(id, c);
      pv = mod.openProposal(src, panel, { notebook: () => import(new URL("sagebrush-notebook.js", h.site).href), latex: h.latex ?? null, actions: bar });
    };
    // (the task as it is now: a newer round replaces the one shown, in place; Close only while it is a proposal)
    me.sync = () => {
      const t = D.task(id);
      const next = t?.proposal?.commit;
      if (next && next !== me.commit && t?.entry.status === "proposal") { mount(next); status.textContent = T.newRound(t.entry.round); }
      // (anything under way on this task, started from this dialog or another, keeps every action off)
      const can = !underway.has(id) && D.state() === "on" && t?.entry.status === "proposal" && t.proposal?.commit === me.commit;
      for (const b of [closeBtn, ask]) can ? b.removeAttribute("aria-disabled") : b.setAttribute("aria-disabled", "true");
      // (Merge: as Close, and only once every conflict shown is picked)
      const canMerge = can && !!h.merge && !(plans && unpicked(plans, picks).length);
      canMerge ? merge.removeAttribute("aria-disabled") : merge.setAttribute("aria-disabled", "true");
    };
    // (the conflicts of the files as merged, each with its two sides and a pick; the picks kept for the session)
    const drawConflicts = (pin: Pinned) => {
      const agent = h.agent();
      mergeSlot.replaceChildren(...(plans ?? []).filter((f) => f.conflicts.length).map((f) => el("div", { className: "conflicts" },
        el("h4", {}, el("code", { textContent: f.path })),
        ...f.conflicts.map((c) => {
          const side = (p: "mine" | "theirs", label: string, text: string) => {
            const b = el("button", { type: "button", textContent: label });
            b.dataset.pick = p;
            b.setAttribute("aria-pressed", String(picks[f.path]?.[c.id] === p));
            b.onclick = () => {
              (picks[f.path] ??= {})[c.id] = p;
              if (h.session) savePicks(h.session, pin, plans ?? [], picks);
              drawConflicts(pin);
              const left = plans ? unpicked(plans, picks).length : 0;
              status.textContent = left ? T.pickAll(left) : "";
              me.sync();
            };
            return el("div", { className: "side" }, el("pre", { textContent: text }), b);
          };
          const row = el("div", { className: "conflict" }, el("p", { textContent: c.label }),
            el("div", { className: "sides" }, side("mine", c.mineLabel ?? T.keepMine, `${T.yours}:\n${c.mine}`), side("theirs", c.theirsLabel ?? T.take(agent), `${agent}:\n${c.theirs}`)));
          row.dataset.conflict = c.id;
          return row;
        }))));
    };
    const fail = (err: unknown) => {
      // (the proposal changed while it was read: read again, nothing written)
      if ((err as AgentError)?.code === "stale") { status.textContent = T.stale; pv?.refresh(); }
      else status.textContent = `${T.mergeFailed} ${(err as Error)?.message ?? ""}`.trim();
    };
    // (the decision written: recorded by the agent, then forgotten here; or what is left of it shown)
    const finish = async (rec: MergeRecord) => {
      if (!isDone(rec)) {
        const left = unresolved(rec).map((f) => f.path);
        status.textContent = T.incomplete;
        const rest = el("button", { type: "button", textContent: T.closeRest });
        rest.dataset.act = "close-rest";
        rest.onclick = async () => {
          if (!begin(id, "merge")) return;
          try { const r = closeRest(rec); await h.merge!.save(id, r); await finish(r); } finally { end(id, "merge"); }
        };
        mergeSlot.replaceChildren(el("p", { className: "incomplete", textContent: T.incompleteBody(left) }), rest);
        incomplete.add(id);
        render();
        return;
      }
      const ok = await recordMerge(id, rec);
      // (what was written said as it is: all of it, or the files merged and those closed unchanged)
      const left = rec.files.filter((f) => f.closed).map((f) => f.path);
      if (ok === true) { dlg.close(); h.toast(left.length ? T.mergedPart(rec.files.filter((f) => f.state === "written").map((f) => f.path), left) : T.merged, left.length ? 6000 : undefined); }
      else status.textContent = ok;
    };
    merge.onclick = async () => {
      if (merge.getAttribute("aria-disabled") === "true" || !h.merge || !src) return;
      const seen = src.seen();
      if (!seen) return;
      const io = h.merge, pin: Pinned = { task: id, base: seen.base, proposal: seen.commit, seq: seen.seq, files: seen.files };
      // (taken for the task, checked here when used: another action under way, from any dialog, and nothing starts)
      if (!begin(id, "merge")) return;
      status.textContent = T.merging;
      try {
        await one(id, async () => {
          let rec = recordOf(await io.load(id), id);
          // (a record of another proposal: the task moved on, and the agent won't record it)
          if (rec && rec.proposal !== pin.proposal) { await io.save(id, null); rec = null; }
          if (rec && isDone(rec)) return finish(rec);
          // (the person's files read now; then the files of an incomplete merge merged again, or all)
          const fresh = await prepare(io, src!, pin, rec ? unresolved(rec).map((f) => f.path) : undefined);
          const kept = h.session ? loadPicks(h.session, pin, fresh) : { picks, dropped: [] };
          plans = fresh;
          picks = kept.picks;
          const left = unpicked(fresh, picks).length;
          if (left) {
            drawConflicts(pin);
            status.textContent = (kept.dropped.length ? T.picksDropped(kept.dropped) + " " : "") + T.pickAll(left);
            return;
          }
          mergeSlot.replaceChildren();
          rec = rec ? revise(rec, fresh, picks) : newRecord(pin, fresh, picks);
          // (the decision kept before anything is written)
          await io.save(id, rec);
          rec = await run(io, rec);
          plans = null;
          await finish(rec);
        });
      } catch (err) {
        fail(err);
      } finally {
        end(id, "merge");
      }
    };
    // (Ask for changes: its block opens under the actions, for the commit shown; pressed again, it closes, the note kept)
    ask.onclick = () => {
      if (ask.getAttribute("aria-disabled") === "true") return;
      // (only once the proposal has been read: its files say what goes with the note)
      if (!src?.seen()) { status.textContent = T.askLoading; return; }
      const b = askSlot.querySelector<HTMLElement>(".ask-block");
      if (b) { b.hidden = !b.hidden; if (!b.hidden) b.querySelector("textarea")?.focus(); return; }
      const block = askBlock(id, me.commit, () => src?.seen() ?? null, {
        // (Send takes the task's action, right after may() asked, in the same step: nothing else starts meanwhile)
        busy: (on) => { if (on) begin(id, "ask"); else end(id, "ask"); },
        // (Send only while Ask for changes is: nothing else under way on the task, from any dialog, nor the task moved on)
        may: () => !underway.has(id) && ask.getAttribute("aria-disabled") !== "true",
        // (the task moved on since the proposal was read: read again (a new seq), the note kept, to send again)
        stale: () => { status.textContent = T.askStale; pv?.refresh(); },
      });
      askSlot.replaceChildren(block);
      block.hidden = false;
      block.querySelector("textarea")?.focus();
    };
    closeBtn.onclick = async () => {
      if (closeBtn.getAttribute("aria-disabled") === "true") return;
      const seen = src?.seen();
      if (!seen) return;
      if (!(await confirmDialog(T.closeTitle, T.closeBody, T.closeOk))) return;
      // (checked again once confirmed: something may have started while the question was open)
      if (!begin(id, "close")) return;
      try {
        await D.close(id, me.commit, seen.seq);
        dlg.close();
        h.toast(T.closed);
      } catch (err) {
        // (the task moved on since this was read: read again, nothing closed)
        if ((err as AgentError)?.code === "stale") { status.textContent = T.stale; pv?.refresh(); }
        else status.textContent = `${T.closeTaskFailed} ${(err as Error)?.message ?? ""}`.trim();
      } finally {
        end(id, "close");
      }
    };
    mount(commit);
    me.sync();
  }

  // (Ask for changes, S3 P2: under the proposal's actions, the note and what goes with it; the unsent note kept per task
  //  in this browser (UI r3.2 §2), cleared once sent. `files` is the proposal's diff, read by the view)
  function askBlock(task: string, commit: string, seen: () => { seq: number; files: readonly { path: string; change: string }[] } | null, on: { busy(b: boolean): void; may(): boolean; stale(): void }): HTMLElement {
    const files = () => seen()?.files ?? [];
    const box = el("textarea", { id: "delegate-note", rows: 4, placeholder: T.askPlaceholder, ariaLabel: T.askLabel });
    try { box.value = localStorage.getItem(noteKey(task)) ?? ""; } catch { /* (no storage: nothing kept) */ }
    box.oninput = () => { try { box.value.trim() ? localStorage.setItem(noteKey(task), box.value) : localStorage.removeItem(noteKey(task)); } catch { /* (no storage) */ } };
    const own = () => files().filter((f) => f.change !== "added").map((f) => f.path);
    const which = el("p", { className: "st ask-files", textContent: T.askFiles(own()) });
    const msg = el("p", { className: "msg", role: "alert" });
    const send = el("button", { type: "button", className: "primary", textContent: T.askSend });
    const block = el("div", { className: "ask-block", hidden: true }, el("label", { htmlFor: "delegate-note", textContent: T.askLabel }), box, which, msg, send);
    send.onclick = async () => {
      if (send.getAttribute("aria-disabled") === "true") return;
      msg.textContent = "";
      if (new TextEncoder().encode(box.value.trim()).length > DELEGATE_LIMITS.noteBytes || !box.value.trim()) {
        msg.textContent = box.value.trim() ? DELEGATE_TEXT.noteLong : DELEGATE_TEXT.noteEmpty;
        return;
      }
      if (!on.may()) { msg.textContent = DELEGATE_TEXT.askMoved; return; }
      send.setAttribute("aria-disabled", "true");
      send.textContent = T.askSending;
      // (the note can't change while it is being sent: what was sent is what was there)
      box.readOnly = true;
      // (what is sent: the kept note goes after it only if it is still this, never a newer draft written meanwhile, in a
      //  dialog opened again)
      const sent = box.value;
      on.busy(true);
      try {
        const at = seen();
        if (!at) throw new AgentError("stale", DELEGATE_TEXT.askMoved);
        const current: DelegateDoc[] = await currentOf(at.files, h.readDoc);
        const r = await D.ask(task, { proposal: commit, seq: at.seq, note: box.value, current });
        try { if (localStorage.getItem(noteKey(task)) === sent) localStorage.removeItem(noteKey(task)); } catch { /* (no storage) */ }
        block.replaceChildren(el("p", { className: "st asked", textContent: T.askSent(r.round) }));
      } catch (e) {
        if (e instanceof AgentError && e.code === "stale") on.stale();
        msg.textContent = e instanceof AgentError || e instanceof Error ? e.message : String(e);
        send.removeAttribute("aria-disabled");
        send.textContent = T.askSend;
        box.readOnly = false;
      } finally {
        on.busy(false);
      }
    };
    return block;
  }

  function render() {
    shown?.sync();
    const s = D.state(), offered = s !== "unoffered";
    sw.hidden = !offered;
    sw.textContent = s === "on" ? T.switchOn : s === "turning-off" ? T.switchTurning : T.switchOff;
    sw.setAttribute("aria-pressed", String(s === "on"));
    btn.hidden = !offered;
    s === "turning-off" ? btn.setAttribute("aria-disabled", "true") : btn.removeAttribute("aria-disabled");
    // (the agent not connected: its last list, marked, with nothing to open until it is back: #1622)
    const last = s === "unoffered" ? D.lastKnown() : [];
    side.hidden = (!(s === "on" || s === "turning-off") || !D.tasks.length) && !last.length;
    side.classList.toggle("away", !!last.length);
    if (last.length) {
      list.replaceChildren(el("p", { className: "away-note", textContent: T.away }), ...last.map((e) => el("div", { className: "thread task away" }, el("span", { className: "t", textContent: e.title }), el("span", { className: `chip ${e.status}${e.question ? " question" : ""}`, textContent: chipOf(e) }))));
      if (open !== null) close();
      view.hidden = true;
      return;
    }
    if (s === "on") for (const t of D.tasks) if (t.entry.status === "proposal") recover(t.entry.task);
    const chipText = (t: (typeof D.tasks)[number]) => (t.entry.status === "proposal" && incomplete.has(t.entry.task) ? T.incomplete : chipOf(t.entry));
    // (a task that's done can't be asked again: its kept note goes)
    for (const t of D.tasks) if (t.entry.status === "closed" || t.entry.status === "merged") { try { if (localStorage.getItem(noteKey(t.entry.task)) !== null) localStorage.removeItem(noteKey(t.entry.task)); } catch { /* (no storage) */ } }
    list.replaceChildren(...D.tasks.map((t) => {
      const b = el("button", { type: "button", className: "thread task" + (t.entry.task === open ? " on" : "") }, el("span", { className: "t", textContent: t.entry.title }), el("span", { className: `chip ${t.entry.status}${t.entry.question ? " question" : ""}`, textContent: chipText(t) }));
      b.dataset.task = t.entry.task;
      b.onclick = () => show(t.entry.task);
      return b;
    }));
    const t = open ? D.task(open) : undefined;
    if (!t) {
      if (open !== null && s !== "on" && s !== "turning-off") close();
      view.hidden = true;
      return;
    }
    view.hidden = false;
    const back = el("button", { type: "button", className: "link", textContent: T.back, onclick: () => close() });
    const head = el("div", { className: "task-head" }, back, el("h2", { textContent: t.entry.title }), el("span", { className: `chip ${t.entry.status}`, textContent: chipText(t) }));
    const parts: Node[] = [head];
    if (t.reason) parts.push(el("p", { className: "reason", textContent: t.reason }));
    if (readErr) parts.push(el("p", { className: "msg", role: "alert", textContent: T.unreadable }));
    for (const e of t.thread.entries) if (e.kind === "turn") parts.push(h.turnNode(t.thread, e));
    if (t.skipped) parts.push(el("p", { className: "skipped", textContent: T.skipped(t.skipped) }));
    const p = t.proposal;
    if (p) {
      const card = el("button", { type: "button", className: "proposal-card", textContent: T.proposal(p.files.length, p.base, p.commit) });
      card.onclick = () => void openProposal(t.entry.task, p.commit);
      parts.push(card);
    }
    view.replaceChildren(...parts);
  }

  return { render, close, showing: () => open };
}
