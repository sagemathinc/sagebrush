// The Agents page's Delegate controls (Pair and Delegate plan, UI r3.2 §2; UI-3), drawn from delegate.ts's model:
//   - the switch in the header ("Delegate: on/off"): on after the person confirms what it allows; off with a
//     confirmation that may also close the running tasks for good (unticked), sent first; the page's task actions
//     disabled from the moment it starts turning off;
//   - Delegate… beside Send: a sheet with the task (the composer's text), its title, the documents (the file open in the
//     pane, editable), where it runs (this computer), and May run code (only if the grant may, frozen at Start);
//   - the Tasks list under the chats, each with its chip;
//   - a task's view in place of the chat: its status, its thread (the agent's turns), and its proposal's card, which
//     opens the proposal view (the review chunk's) in a dialog, with its actions: Merge (delegate-merge.ts: each
//     conflict picked first; an incomplete one said on the task's chip, and a kept one finished after a reload) and
//     Close; Ask for changes comes next.
// Shown only for an agent on this computer whose hello offers delegate.1: nothing changes for any other.
import type { Thread, Turn } from "../workspace/agent-chat/events";
import { AgentError } from "../workspace/agent-pair";
import { chipOf, type DelegateDoc, type DelegateTasks } from "./delegate";
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
  where: "This computer",
  whereNote: "The task's copy and its runs stay on this computer.",
  run: "May run code",
  runNote: "Fixed for this task once it starts.",
  runNotGranted: "Your grant to this agent doesn't allow running code.",
  noDocs: "No documents: add a path, or open a file in the pane first.",
  start: "Start",
  starting: "Starting…",
  tasks: "Tasks",
  skipped: (n: number) => (n === 1 ? "One event of this task couldn't be shown here." : `${n} events of this task couldn't be shown here.`),
  proposal: (n: number, base: string, commit: string) => `Proposal: ${n === 1 ? "1 file" : `${n} files`} changed · base ${base.slice(0, 7)} · proposal ${commit.slice(0, 7)}`,
  laterActions: "Ask for changes comes in the next update.",
  merge: "Merge",
  merging: "Merging…",
  mergeFailed: "Couldn't merge.",
  pickAll: (n: number) => `Pick a side for ${n === 1 ? "the conflict" : `each of the ${n} conflicts`}, then Merge.`,
  picksDropped: (paths: string[]) => `Your picks for ${paths.join(", ")} were made against another version: pick again.`,
  yours: "Yours",
  keepMine: "Keep mine",
  take: (agent: string) => `Take ${agent}'s`,
  incomplete: "Merge incomplete",
  incompleteBody: (paths: string[]) => `${paths.length === 1 ? "This file" : "These files"} changed while the merge was written, and ${paths.length === 1 ? "wasn't" : "weren't"} merged: ${paths.join(", ")}. Merge again to merge ${paths.length === 1 ? "it" : "them"} as ${paths.length === 1 ? "it is" : "they are"} now, or close what's left. The files already written stay as they are.`,
  closeRest: "Close what's left",
  merged: "Merged: your files have the changes.",
  notRecorded: (m: string) => `Your files have the merge, but the agent didn't record it: ${m}`,
  notRecordedYet: "Your files have the merge, but the agent hasn't recorded it yet. Merge again to try again.",
  ask: "Ask for changes",
  closeTask: "Close",
  closeTitle: "Close this proposal?",
  closeBody: "The task ends here and its proposal isn't used. Your files don't change.",
  closeOk: "Close the task",
  closed: "Task closed",
  closeTaskFailed: "Couldn't close the task.",
  stale: "The task moved on since you opened this: here it is as it is now.",
  newRound: (n: number) => `A new proposal (round ${n}) replaces the one you were reading.`,
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
  turnNode: (thread: Thread, turn: Turn) => HTMLElement;
  /** the task view shown (true) or gone (false): the page hides or shows its chat */
  shown: (on: boolean) => void;
  site: URL;
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
      const rec = recordOf(await io.load(task), task);
      if (!rec) return;
      const after = await run(io, rec);
      if (isDone(after)) { if ((await recordMerge(task, after)) !== true) incomplete.add(task); }
      else incomplete.add(task);
      render();
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
    dlg.append(form);
    document.body.append(dlg);
    dlg.addEventListener("close", () => dlg.remove(), { once: true });
    dlg.showModal();
    form.onsubmit = async (e) => {
      e.preventDefault();
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
    let pv: { close(): void; refresh(): void } | null = null, src: ReturnType<typeof D.source> | null = null, busy = false;
    // (its actions, at the proposal's foot: Close now; Merge and Ask for changes in the next steps)
    const act = (key: string, label: string) => { const b = el("button", { type: "button", textContent: label }); b.dataset.act = key; return b; };
    const merge = act("merge", T.merge), ask = act("ask", T.ask), closeBtn = act("close", T.closeTask);
    const status = el("p", { className: "st", role: "status" });
    const later = el("p", { className: "st", textContent: T.laterActions });
    // (Ask for changes' own block goes in askSlot, under the actions, for the commit shown (me.commit) and its files
    //  (src.seen().files))
    const askSlot = el("div", { className: "ask-slot" });
    // (Merge's conflicts, to pick, and what is left of an incomplete merge)
    const mergeSlot = el("div", { className: "merge-slot" });
    const bar = el("div", { className: "proposal-actions" }, el("div", { className: "row" }, merge, ask, closeBtn), status, mergeSlot, askSlot, later);
    ask.setAttribute("aria-disabled", "true");
    ask.title = T.laterActions;
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
      src = D.source(id, c);
      pv = mod.openProposal(src, panel, { notebook: () => import(new URL("sagebrush-notebook.js", h.site).href), actions: bar });
    };
    // (the task as it is now: a newer round replaces the one shown, in place; Close only while it is a proposal)
    me.sync = () => {
      const t = D.task(id);
      const next = t?.proposal?.commit;
      if (next && next !== me.commit && t?.entry.status === "proposal") { mount(next); status.textContent = T.newRound(t.entry.round); }
      const can = !busy && D.state() === "on" && t?.entry.status === "proposal" && t.proposal?.commit === me.commit;
      can ? closeBtn.removeAttribute("aria-disabled") : closeBtn.setAttribute("aria-disabled", "true");
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
        rest.onclick = async () => { const r = closeRest(rec); await h.merge!.save(id, r); await finish(r); };
        mergeSlot.replaceChildren(el("p", { className: "incomplete", textContent: T.incompleteBody(left) }), rest);
        incomplete.add(id);
        render();
        return;
      }
      const ok = await recordMerge(id, rec);
      if (ok === true) { dlg.close(); h.toast(T.merged); }
      else status.textContent = ok;
    };
    merge.onclick = async () => {
      if (merge.getAttribute("aria-disabled") === "true" || !h.merge || !src) return;
      const seen = src.seen();
      if (!seen) return;
      const io = h.merge, pin: Pinned = { task: id, base: seen.base, proposal: seen.commit, seq: seen.seq, files: seen.files };
      busy = true;
      me.sync();
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
        busy = false;
        me.sync();
      }
    };
    closeBtn.onclick = async () => {
      if (closeBtn.getAttribute("aria-disabled") === "true") return;
      const seen = src?.seen();
      if (!seen) return;
      if (!(await confirmDialog(T.closeTitle, T.closeBody, T.closeOk))) return;
      busy = true;
      me.sync();
      try {
        await D.close(id, me.commit, seen.seq);
        dlg.close();
        h.toast(T.closed);
      } catch (err) {
        // (the task moved on since this was read: read again, nothing closed)
        if ((err as AgentError)?.code === "stale") { status.textContent = T.stale; pv?.refresh(); }
        else status.textContent = `${T.closeTaskFailed} ${(err as Error)?.message ?? ""}`.trim();
      } finally {
        busy = false;
        me.sync();
      }
    };
    mount(commit);
    me.sync();
  }

  function render() {
    shown?.sync();
    const s = D.state(), offered = s !== "unoffered";
    sw.hidden = !offered;
    sw.textContent = s === "on" ? T.switchOn : s === "turning-off" ? T.switchTurning : T.switchOff;
    sw.setAttribute("aria-pressed", String(s === "on"));
    btn.hidden = !offered;
    s === "turning-off" ? btn.setAttribute("aria-disabled", "true") : btn.removeAttribute("aria-disabled");
    side.hidden = !(s === "on" || s === "turning-off") || !D.tasks.length;
    if (s === "on") for (const t of D.tasks) if (t.entry.status === "proposal") recover(t.entry.task);
    const chipText = (t: (typeof D.tasks)[number]) => (t.entry.status === "proposal" && incomplete.has(t.entry.task) ? T.incomplete : chipOf(t.entry));
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
