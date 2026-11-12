// The agents chat preview (web/agents): a full-page chat with artifacts beside
// it, the model claude.ai and chatgpt.com have converged on. The chat is
// primary; an artifact opens floating to the right, or full screen. This
// preview drives it with a scripted agent (fake-agent.ts), or with Claude on
// the person's own computer (sagebrush-agent, paired over the loopback
// address like any agent: design/workspace-agent-protocol.md), which speaks
// the same turn events (events.ts). Files the agent writes are workspace
// files (this browser's workspace), shown and edited beside the chat.
// Threads are kept in this browser's localStorage.

// (first: the pairing code leaves the address bar before anything else runs)
import "../workspace/pair-link";
import { BlockEditor } from "../board/blocks";
import { render as markdown } from "../markdown";
import { apply, newThread, runningTurn, type Artifact, type Thread, type Turn, type TurnEvent, type UserEntry } from "../workspace/agent-chat/events";
import { userNode as viewUserNode, turnNode as viewTurnNode, artifactIcon, diffHtml } from "../workspace/agent-chat/view";
import { startFakeTurn, type Draft, type FakeTurn } from "./fake-agent";
import { AgentError, RELOAD_KEY, type AgentPairing, type Kept } from "../workspace/agent-pair";
import type { NotebookEdit } from "../workspace/notebook-edit";
import { mountAgentPairing, type RestoreState } from "../workspace/agent-ui";
import * as gitBranches from "../workspace/git-branch";
import { Workspace } from "../workspace/api";
import { WS_DB } from "../workspace/db";
import { guardGestures, mountNotebook, type AgentCells, type Guard, type NotebookHost, type NotebookUi } from "./notebook-artifact";
import { mountComposer, renderComposerState, stopLabel } from "../workspace/agent-chat/composer";
import { applyPaneClasses, mountLayout, relayout } from "./layout";
import { AgentLeg, legKey, listRunners, pageLegUrl, digestGate, DIGEST_CHARGE, type LegEnd } from "../workspace/agent-relay";
import { permissionDigest } from "../workspace/agent-canon";

// (the LaTeX editor, in builds that have it: web/build.ts's define)
declare const __SB_LATEX__: boolean | undefined;
const LATEX_URL = new URL("../sagebrush-latex.js", import.meta.url).href;

const STORE = "sagebrush-agents-preview-v1";
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T;

// ---------------------------------------------------------------------------
// State

interface Saved {
  threads: Thread[];
  current: string;
}

function load(): Saved {
  try {
    const v = JSON.parse(localStorage.getItem(STORE) ?? "");
    if (v && Array.isArray(v.threads) && v.threads.length > 0) return v;
  } catch {
    // a first visit, or an old format: start fresh
  }
  const t = newThread(id(), "New chat");
  return { threads: [t], current: t.id };
}

function id() {
  return Math.random().toString(36).slice(2, 10);
}

const state = load();
let saveTimer = 0;
function save() {
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => localStorage.setItem(STORE, JSON.stringify(state)), 300);
}

const agents = new Map<string, { turn: FakeTurn; turn_id: string }>(); // scripted turns, by thread
const liveRunning = new Set<string>(); // threads with a turn of the paired agent running
let pairing: AgentPairing | null = null;
let workspace: Workspace | null = null; // this browser's workspace: where the paired agent's files are
const live = () => pairing?.state === "granted";
// The paired agent's name, as it says (Claude, Codex, ...): the demo is Claude.
const agentName = () => (pairing && pairing.state !== "closed" && pairing.hello?.agent.name?.trim().slice(0, 40)) || "Claude";
const isRunning = (thread: Thread) => agents.has(thread.id) || liveRunning.has(thread.id);
const queues = new Map<string, UserEntry[]>(); // queued messages, by thread
let openArtifact: string | null = null;
let fullscreen = false;

const current = () => state.threads.find((t) => t.id === state.current) ?? state.threads[0];

function emitTo(thread: Thread, turn_id: string, d: Draft) {
  const e = { ...d, seq: thread.applied_seq + 1, turn_id } as TurnEvent;
  apply(thread, e);
  if (d.type === "artifact") {
    openArtifact = (d as { id: string }).id;
    // (a notebook the agent wrote: which cells, as it wrote them, for the written-by label)
    const art = d as { kind?: string; path?: string };
    if (art.kind === "notebook" && art.path && workspace) {
      const path = art.path;
      agentCellsByPath.set(
        path,
        workspace.read(path).then(
          (r) => {
            const cells = (r.content as { cells?: { id?: string; code?: string }[] } | null)?.cells ?? [];
            return new Map(cells.filter((c) => typeof c.id === "string" && typeof c.code === "string").map((c) => [c.id!, c.code!]));
          },
          () => null,
        ),
      );
    }
  }
  save();
  if (thread.id === state.current) schedule();
}

// ---------------------------------------------------------------------------
// Sending

function submit(mode: UserEntry["mode"]) {
  const text = editor.value.trim();
  if (!text) return;
  const thread = current();
  // (not connected, in a chat the demo may not answer: Send is inert and the draft stays, A14 C1; a note still posts)
  if (mode !== "note" && inert(thread)) return;
  const busy = isRunning(thread);
  if (mode === "queued" && !busy) mode = "sent";
  const entry: UserEntry = { kind: "user", id: id(), text, mode, time: Date.now() };
  thread.entries.push(entry);
  if (thread.title === "New chat") thread.title = text.split("\n")[0].slice(0, 48);
  editor.value = "";
  if (mode === "queued") {
    queues.set(thread.id, [...(queues.get(thread.id) ?? []), entry]);
  } else if (mode === "sent" && busy) {
    // Sending while a turn runs interrupts it, as in Claude Code; this goes first once it has stopped.
    queues.set(thread.id, [entry, ...(queues.get(thread.id) ?? [])]);
    interrupt(thread);
  } else if (mode === "sent") {
    send(thread, entry);
  }
  save();
  renderAll();
  scrollToEnd(true);
}

function startTurn(thread: Thread, prompt: string) {
  const turn_id = `turn-${id()}`;
  const turn = startFakeTurn(prompt, (d) => emitTo(thread, turn_id, d), speed());
  agents.set(thread.id, { turn, turn_id });
  renderComposer();
  turn.done.then(() => {
    if (agents.get(thread.id)?.turn === turn) agents.delete(thread.id);
    next(thread);
  });
}

// The next queued message, once a turn has ended.
function next(thread: Thread) {
  const entry = queues.get(thread.id)?.shift();
  if (entry) {
    entry.mode = "sent";
    save();
    send(thread, entry);
  }
  renderAll();
}

function send(thread: Thread, entry: UserEntry) {
  if (live()) {
    mark(thread);
    liveRunning.add(thread.id);
    const sent = pairing!.notifyWhy("chat.message", { conversation: thread.id, id: entry.id, author: "person", text: entry.text });
    if (sent !== "ok") {
      liveRunning.delete(thread.id);
      // (over a runner, each cause in its own words (board, W2 B Copy): a queue that's full now, or a message over the
      //  connection's limit)
      if (pairing!.link && sent === "full") toast(NOT_SENT.full(agentName()), 6000);
      else if (pairing!.link && sent === "over") toast(NOT_SENT.over, 6000);
      else toast("The agent is disconnected");
    }
    renderComposer();
  } else if (mayDemo(thread)) {
    startTurn(thread, entry.text);
  } else {
    // (a chat Claude was in never goes to the demo: the message waits, pending, until Claude is connected again)
    entry.mode = "queued";
    queues.set(thread.id, [entry, ...(queues.get(thread.id) ?? [])]);
    save();
  }
}

function interrupt(thread: Thread) {
  const scripted = agents.get(thread.id);
  if (scripted) scripted.turn.interrupt();
  else if (liveRunning.has(thread.id)) pairing?.notify("chat.interrupt", { conversation: thread.id });
}

// The permission cards the paired agent asked, as it sent them: the fields its digest binds (child, conversation,
// request_id, action), kept as admitted, never rebuilt from what is shown. A card is answered once: the first click
// claims it, before anything is awaited (W2 B Binding 3).
type Card = { pairing: AgentPairing; child?: string; conversation: string; request_id: string; tool?: string; input?: unknown; claimed: boolean };
const cards = new Map<string, Card>();
const CARDS_MAX = 16; // (the agent asks at most 4 at once; older unanswered ones beyond this are forgotten)

function answer(thread: Thread, attention: string, approve: boolean) {
  const scripted = agents.get(thread.id);
  if (scripted) return scripted.turn.answer(attention, approve);
  const c = cards.get(attention), p = pairing;
  // (claimed: the card shows the person's answer at once, both buttons gone; a second click finds it claimed)
  if (!c || c.claimed) return;
  c.claimed = true;
  const turn = thread.entries.find((e): e is Turn => e.kind === "turn" && !!e.attention[attention]);
  if (turn) { turn.attention[attention].state = approve ? "approved" : "denied"; renderThread(); }
  if (!p || c.pairing !== p || p.state !== "granted") return;
  if (!approve) return void p.notify("chat.permission", { request_id: attention, behavior: "deny" });
  // (an agent that binds no digest (no child on its card) is one that asks none: loopback only)
  if (c.child === undefined) { if (!p.link) p.notify("chat.permission", { request_id: attention, behavior: "allow" }); else p.notify("chat.permission", { request_id: attention, behavior: "deny" }); return; }
  void allowWithDigest(p, c);
}

/** Allow, with the digest of the claimed card: computed within the page-wide digest bound, and sent only if the same
 * pairing and the same agent child are still current; a card the page's canon refuses is answered Deny. */
async function allowWithDigest(p: AgentPairing, c: Card) {
  const live = () => pairing === p && p.state === "granted" && p.hello?.child === c.child;
  const release = await digestGate.acquire(DIGEST_CHARGE, live);
  if (!release) return;
  let d: string | null = null;
  try { d = await permissionDigest({ child: c.child, conversation: c.conversation, request: c.request_id, tool: c.tool, input: c.input }); }
  catch { d = null; }
  finally { release(); }
  if (!live()) return;
  if (d === null) return void p.notify("chat.permission", { request_id: c.request_id, behavior: "deny" });
  p.notify("chat.permission", { request_id: c.request_id, behavior: "allow", digest: d });
}

/** A permission card as it arrives: kept with its fields; false if it must not be shown (it names another
 * conversation than its turn's, or over a runner it lacks the fields its digest needs): then it is denied at once. */
function admitCard(turnConversation: string, e: any): boolean {
  const p = pairing;
  if (!p || typeof e.id !== "string") return false;
  const has = typeof e.child === "string" && typeof e.conversation === "string" && typeof e.request_id === "string" && typeof e.action?.tool === "string" && "input" in e.action;
  const consistent = has && e.conversation === turnConversation && e.request_id === e.id && e.child === p.hello?.child;
  if ((p.link && !consistent) || (has && !consistent)) {
    p.notify("chat.permission", { request_id: e.id, behavior: "deny" });
    return false;
  }
  if (cards.size >= CARDS_MAX) for (const [k, v] of cards) { if (!v.claimed || cards.size >= CARDS_MAX) cards.delete(k); if (cards.size < CARDS_MAX) break; }
  let input: unknown;
  try { input = has ? structuredClone(e.action.input) : undefined; } catch { input = undefined; }
  cards.set(e.id, { pairing: p, conversation: turnConversation, request_id: e.id, claimed: false, ...(has ? { child: e.child, tool: e.action.tool, input } : {}) });
  return true;
}

// What the paired agent says: turn events for one of this page's threads.
function onAgent(method: string, params: unknown) {
  if (method !== "turn.event") return;
  const p = params as { conversation?: unknown; turn_id?: unknown; event?: { type?: unknown } } | null;
  const thread = state.threads.find((t) => t.id === p?.conversation);
  if (!thread || typeof p?.turn_id !== "string" || !p.event || typeof p.event.type !== "string") return;
  const ev = p.event as any;
  if (ev.type === "attention" && ev.state === "open" && !cards.has(ev.id) && !admitCard(thread.id, ev)) return;
  if (ev.type === "attention" && ev.state !== "open") cards.delete(ev.id);
  mark(thread);
  emitTo(thread, p.turn_id, p.event as Draft);
  const turn = thread.entries.find((e): e is Turn => e.kind === "turn" && e.turn_id === p.turn_id);
  if (turn && !turn.agent) turn.agent = pairing?.hello?.agent.name ?? "agent";
  if (p.event.type === "turn_finished") {
    liveRunning.delete(thread.id);
    next(thread);
  }
}

function speed() {
  return Number(new URLSearchParams(location.search).get("speed") ?? 1) || 1;
}

// ---------------------------------------------------------------------------
// Rendering

let frame = 0;
function schedule() {
  if (!frame) frame = requestAnimationFrame(() => {
    frame = 0;
    renderAll();
  });
}

let mathModule: Promise<{ typeset(el: Element): void }> | null = null;
function typeset(el: Element) {
  if (!el.querySelector(".math[data-tex]")) return;
  mathModule ??= import(new URL("../sagebrush-math.js", import.meta.url).href);
  mathModule.then((m) => m.typeset(el)).catch(() => {});
}

function md(src: string): string {
  return markdown(src, { remote: "click" });
}

function renderAll() {
  renderSidebar();
  renderThread();
  renderArtifacts();
  renderComposer();
}

function renderSidebar() {
  const list = $("#threads");
  list.innerHTML = "";
  for (const t of [...state.threads].reverse()) {
    const a = document.createElement("button");
    a.className = "thread" + (t.id === state.current ? " on" : "");
    a.textContent = t.title;
    if (isRunning(t)) a.append(Object.assign(document.createElement("span"), { className: "dot", title: "working" }));
    a.onclick = async () => {
      if (t.id === state.current) return;
      if (!(await mayLeaveThread())) return;
      state.current = t.id;
      openArtifact = t.artifacts.at(-1)?.id ?? null;
      save();
      renderAll();
      scrollToEnd(true);
      document.body.classList.remove("nav-open");
    };
    list.append(a);
  }
}

// What's in the DOM, by entry, so a streaming turn re-renders alone.
const rendered = new Map<string, { node: HTMLElement; key: string }>();
let renderedThread = "";

function renderThread() {
  const thread = current();
  const log = $("#log");
  if (renderedThread !== thread.id) {
    for (const r of rendered.values()) r.node.remove();
    rendered.clear();
    renderedThread = thread.id;
  }
  $("#empty").hidden = thread.entries.length > 0;
  const nearEnd = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
  const seen = new Set<string>();
  let prev: HTMLElement | null = null;
  for (const entry of thread.entries) {
    const eid = entry.kind === "user" ? entry.id : entry.turn_id;
    seen.add(eid);
    const key = entry.kind === "user" ? `${entry.mode}` : JSON.stringify([entry.parts, entry.tools, entry.attention, entry.state, entry.error]);
    let r = rendered.get(eid);
    if (!r || r.key !== key) {
      const node = entry.kind === "user" ? userNode(entry) : turnNode(thread, entry);
      if (r) r.node.replaceWith(node);
      else if (prev) prev.after(node);
      else log.append(node);
      r = { node, key };
      rendered.set(eid, r);
      typeset(node);
    }
    prev = r.node;
  }
  for (const [k, r] of rendered) if (!seen.has(k)) (r.node.remove(), rendered.delete(k));
  if (nearEnd) scrollToEnd(false);
}

function scrollToEnd(force: boolean) {
  const log = $("#log");
  if (force || log.scrollHeight - log.scrollTop - log.clientHeight < 200) log.scrollTop = log.scrollHeight;
}

function userNode(e: UserEntry): HTMLElement {
  return viewUserNode(e, md);
}

function turnNode(thread: Thread, turn: Turn): HTMLElement {
  return viewTurnNode(thread, turn, {
    answer: (att, approve) => answer(thread, att, approve),
    openArtifact: (id) => { openArtifact = id; renderArtifacts(); },
    md,
  });
}

// The pane: a head (tabs and buttons, redrawn when what it shows changes) and one host per artifact, kept while
// its thread is shown. A host is mounted once: full screen, a new artifact or another tab only hide or show it,
// so a notebook keeps its kernel, a running cell and its pending saves (the artifacts plan, BAP-1).
type Bar = Parameters<NotebookUi["bar"]>[0];
type Host = {
  key: string;
  el: HTMLElement;
  body: string; // (a static host's content key: redrawn only when the artifact's body changes)
  copy: () => string;
  nb?: NotebookHost;
  running: boolean;
  /** Changed by the agent while another tab was shown: its tab says so until it is shown. */
  changed?: boolean;
  flush?: () => Promise<void>;
  /** Closing: saved, or kept as a copy, or (false) neither, and then it stays (ART-C2/C4 r3). */
  release?: () => Promise<Released>;
  /** Closing without keeping anything. */
  dispose?: () => Promise<void>;
  /** After a failed close: what it kept frozen, as a file to download. */
  download?: () => { name: string; text: string; type: string } | null;
  /** Its own bar (a warning, a refusal, with its actions): shown whenever it is the host shown, and only then (ART-C5). */
  bar: Bar;
};
const hosts = new Map<string, Host>();
let paneThread: string | null = null;
let headKey = "";
// The cells the agent wrote in each notebook (path -> cell id -> source), for the written-by label.
const agentCellsByPath = new Map<string, Promise<AgentCells | null>>();

const hostKey = (threadId: string, artifactId: string) => `${threadId}\u0000${artifactId}`;

function paneShell(pane: HTMLElement) {
  if (!pane.querySelector(":scope > .pane-head")) pane.innerHTML = `<div class="pane-head"></div><div class="pane-bar" hidden></div><div class="pane-body"></div>`;
  return { head: $(".pane-head", pane), body: $(".pane-body", pane), bar: $(".pane-bar", pane) };
}

/** Close every host of a thread: each saves, or keeps what it couldn't save as a copy, then goes (notebooks stopped,
 * editors destroyed). One that could do neither stays, shown, with its own bar: Try again, or Close without keeping.
 * True when all have gone. */
async function releaseHosts(threadId: string | null): Promise<boolean> {
  if (!threadId) return true;
  const mine = [...hosts].filter(([k]) => k.startsWith(threadId + "\u0000"));
  let kept: [string, Host] | null = null;
  await Promise.all(
    mine.map(async ([k, h]) => {
      const r: Released = h.release ? await h.release().catch((e) => ({ ok: false as const, why: String((e as Error)?.message ?? e) })) : { ok: true };
      if (r.ok) {
        if (hosts.get(k) === h) hosts.delete(k);
        h.el.remove();
        return;
      }
      kept = [k, h];
      h.bar = {
        kind: "refused",
        text: r.why,
        actions: [
          { label: "Try again", run: () => void closePaneOf(threadId) },
          // (the one rescue that needs no storage: the frozen content, downloaded)
          ...(h.download?.() ? [{ label: "Download a copy", run: () => saveDownload(h.download!()) }] : []),
          {
            label: "Close without keeping",
            run: () =>
              void (async () => {
                await h.dispose?.();
                if (hosts.get(k) === h) hosts.delete(k);
                h.el.remove();
                await closePaneOf(threadId);
              })(),
          },
        ],
      };
    }),
  );
  if (!kept) return true;
  const [k] = kept as [string, Host];
  if (current().id === threadId) {
    openArtifact = k.slice(threadId.length + 1);
    renderArtifacts();
  }
  return false;
}

/** A file downloaded from text (a Blob and an <a download>): works where the workspace can't store anything. */
function saveDownload(f: { name: string; text: string; type: string } | null) {
  if (!f) return;
  const url = URL.createObjectURL(new Blob([f.text], { type: f.type }));
  const a = Object.assign(document.createElement("a"), { href: url, download: f.name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** The pane of a thread closed, once each of its hosts has saved or kept its content. */
async function closePaneOf(threadId: string) {
  if (current().id !== threadId) return;
  if (!(await releaseHosts(threadId)) || current().id !== threadId) return;
  openArtifact = null;
  fullscreen = false;
  renderArtifacts();
}

/** The bar of the host shown: its own state, its actions only while it is still that host (ART-C5). */
function renderBar(h: Host | undefined) {
  const bar = $("#artifacts .pane-bar");
  if (!bar) return;
  const b = h?.bar;
  if (!h || !b) {
    bar.hidden = true;
    bar.innerHTML = "";
    bar.className = "pane-bar"; // (no kind, no alert role, left from another host's bar: BAC-7)
    bar.removeAttribute("role");
    return;
  }
  bar.hidden = false;
  bar.className = `pane-bar ${b.kind}`;
  bar.setAttribute("role", "alert");
  bar.innerHTML = `<span>${esc(b.text)}</span>` + (b.actions ?? []).map((x, i) => `<button data-act="${i}">${esc(x.label)}</button>`).join("");
  for (const btn of bar.querySelectorAll<HTMLButtonElement>("[data-act]"))
    btn.onclick = () => {
      if (hosts.get(h.key) !== h || h.bar !== b || shownHost() !== h) return;
      b.actions![Number(btn.dataset.act)].run();
    };
}
const shownHost = () => hosts.get(hostKey(current().id, openArtifact ?? ""));

/** Leave the thread shown (another thread, New chat): a running cell is stopped only if the person says so. Resolves
 * to whether it may be left, still the same thread then (ART-C6). */
async function mayLeaveThread(): Promise<boolean> {
  const from = current().id;
  if (!(await mayClosePane(from)) || current().id !== from) return false;
  // (its hosts close first: one that can't keep its content keeps the thread)
  return (await releaseHosts(from)) && current().id === from;
}

/** Before a pane or thread closes: a running cell is stopped only if the person says so. */
async function mayClosePane(threadId: string | null): Promise<boolean> {
  if (!threadId) return true;
  const busy = [...hosts].filter(([k, h]) => k.startsWith(threadId + "\u0000") && h.nb?.isRunning());
  if (!busy.length) return true;
  // (the notebook's popups close first: a modal dialog is above them, in the top layer)
  for (const p of document.querySelectorAll<HTMLElement>(".sbnb-pop:not(dialog)")) p.hidden = true;
  const dlg = $<HTMLDialogElement>("#close-running");
  dlg.returnValue = "";
  dlg.showModal();
  const answer = await new Promise<string>((resolve) => dlg.addEventListener("close", () => resolve(dlg.returnValue), { once: true }));
  if (answer !== "stop") return false;
  for (const [, h] of busy) h.nb?.interrupt();
  return true;
}

function renderArtifacts() {
  const thread = current();
  const pane = $("#artifacts");
  const a = thread.artifacts.find((x) => x.id === openArtifact);
  applyPaneClasses(a, fullscreen);
  relayout(); // (the columns re-clamped for the pane now shown or gone: an agent's own open too)
  if (paneThread !== thread.id) {
    void releaseHosts(paneThread);
    paneThread = thread.id;
  }
  const { head, body } = paneShell(pane);
  if (!a) {
    for (const h of hosts.values()) (h.nb ? h.nb.hidden(true) : (h.el.hidden = true));
    headKey = "";
    renderBar(undefined);
    return;
  }
  // (the tab shown is seen: its "changed" mark goes)
  const seenHost = hosts.get(hostKey(thread.id, a.id));
  if (seenHost) seenHost.changed = false;
  // the head: tabs (a running notebook's name says so, and one the agent changed behind another), copy, full screen, close
  const hk = JSON.stringify([thread.id, thread.artifacts.map((x) => [x.id, x.title, hosts.get(hostKey(thread.id, x.id))?.running ?? false, hosts.get(hostKey(thread.id, x.id))?.changed ?? false]), a.id, fullscreen]);
  if (hk !== headKey) {
    headKey = hk;
    const tabs = thread.artifacts
      .map((x) => {
        const run = hosts.get(hostKey(thread.id, x.id))?.running;
        const changed = hosts.get(hostKey(thread.id, x.id))?.changed;
        return `<button class="tab${x.id === a.id ? " on" : ""}" data-tab="${esc(x.id)}">${artifactIcon(x)} ${esc(x.title)}${run ? ` <span class="tab-running">· running</span>` : ""}${changed ? ` <span class="tab-changed">· changed</span>` : ""}</button>`;
      })
      .join("");
    // (the control that had the focus has it again after the head is redrawn: a tab, copy, full screen or close, BAC-6)
    const had = document.activeElement instanceof HTMLElement && head.contains(document.activeElement) ? document.activeElement : null;
    const refocus = had ? (had.dataset.tab !== undefined ? `[data-tab="${CSS.escape(had.dataset.tab)}"]` : had.id ? `#${had.id}` : null) : null;
    head.innerHTML =
      `<div class="tabs">${tabs}</div>` +
      `<button class="icon" id="copy" title="Copy">⧉</button>` +
      `<button class="icon" id="full" title="${fullscreen ? "Exit full screen" : "Full screen"}">${fullscreen ? "⤡" : "⤢"}</button>` +
      `<button class="icon" id="close" title="Close">✕</button>`;
    for (const t of head.querySelectorAll<HTMLButtonElement>("[data-tab]")) t.onclick = () => ((openArtifact = t.dataset.tab!), renderArtifacts());
    $("#full", head).onclick = () => ((fullscreen = !fullscreen), renderArtifacts());
    $("#close", head).onclick = async () => {
      if (!(await mayClosePane(thread.id)) || current().id !== thread.id) return;
      await closePaneOf(thread.id);
    };
    $("#copy", head).onclick = () => {
      const h = hosts.get(hostKey(thread.id, openArtifact ?? ""));
      navigator.clipboard?.writeText(h?.copy() ?? "").then(() => toast("Copied"), () => toast("Couldn't copy"));
    };
    if (refocus) head.querySelector<HTMLElement>(refocus)?.focus();
  }
  // this artifact's host: mounted once; the others of this thread hidden (kept)
  const key = hostKey(thread.id, a.id);
  let h = hosts.get(key);
  const staticBody = a.path && workspace ? "" : a.body;
  if (h && !h.nb && !h.dispose && h.body !== staticBody) {
    h.el.remove();
    hosts.delete(key);
    h = undefined;
  }
  if (!h) {
    const el = document.createElement("div");
    el.className = "pane-host";
    body.append(el);
    h = { key, el, body: staticBody, copy: () => a.body, running: false, bar: null };
    hosts.set(key, h);
    mountHost(thread.id, a, h);
  }
  for (const x of hosts.values()) {
    const show = x === h;
    if (x.nb) x.nb.hidden(!show);
    x.el.hidden = !show;
    if (!show) x.flush?.().catch(() => {});
  }
  renderBar(h);
}

// What an artifact's host holds: a notebook, a workspace file (Markdown, LaTeX, code), or the artifact's own text.
function mountHost(threadId: string, a: Artifact, h: Host) {
  const before = document.activeElement as HTMLElement | null;
  const keepFocus = () => {
    // (an artifact opened by the agent never takes the composer's focus: BAP-6)
    if (before && document.activeElement !== before && $("#artifacts").contains(document.activeElement)) before.focus();
  };
  if (a.kind === "notebook" && a.path && workspace) {
    h.el.innerHTML = `<div class="file-path">${esc(a.path)} <span class="saved"></span> <a class="open-full" href="/w${esc(a.path)}" target="_blank" rel="noopener">Open in Sagebrush</a></div><div class="file-body"></div>`;
    const saved = $(".saved", h.el);
    const ui: NotebookUi = {
      saved: (t) => (saved.textContent = t),
      // (kept with this host, shown when it is the host shown: a hidden notebook's warning waits for it)
      bar: (b) => {
        if (hosts.get(h.key) !== h) return;
        h.bar = b;
        if (shownHost() === h) renderBar(h);
      },
      agentName,
      running: (on) => {
        h.running = on;
        headKey = "";
        if (current().id === threadId) renderArtifacts();
      },
      notice: (text) => toast(text, 8000),
    };
    // (the handle at once: closing never waits for the mount, nor for any read it makes, ART-C2)
    const nb = mountNotebook(workspace, a.path, $(".file-body", h.el), ui, agentCellsByPath.get(a.path) ?? Promise.resolve(null));
    h.nb = nb;
    h.copy = nb.copyText;
    h.flush = nb.flush;
    h.release = nb.release;
    h.dispose = nb.dispose;
    h.download = nb.download;
    nb.hidden(shownHost() !== h);
    void nb.ready.then(() => hosts.get(h.key) === h && keepFocus());
    return;
  }
  if (a.path && workspace) {
    h.el.innerHTML = `<div class="file-path">${esc(a.path)} <span class="saved"></span></div><div class="file-body"></div>`;
    const f = mountFile(a, $(".file-body", h.el), $(".saved", h.el));
    h.copy = f.text;
    h.flush = f.flush;
    h.release = f.release;
    h.dispose = f.dispose;
    h.download = f.download;
    keepFocus();
    return;
  }
  if (a.kind === "markdown") h.el.innerHTML = `<div class="doc board-text">${md(a.body)}</div>`;
  else if (a.kind === "diff") {
    const d = JSON.parse(a.body) as { before: string; after: string };
    h.el.innerHTML = diffHtml(d.before, d.after);
    h.copy = () => d.after;
  } else h.el.innerHTML = `<pre class="code">${esc(a.body)}</pre>`;
  typeset(h.el);
}

// An artifact that is a workspace file: the file itself, editable here (saved as the person, with its revision as
// base, so a change the agent made meanwhile is never overwritten). Markdown in the block editor, LaTeX in the LaTeX
// editor where this build has it (web/latex, /sagebrush-latex.js), other text as text. (ART-C3, C4:) The editor
// appears once the file and its revision are read, so no write goes without a base and no late read replaces an
// edit; writes are tracked, so flush waits for them; after a conflict nothing more is written (the text stays
// here); dispose saves the editor's latest text (the LaTeX editor's own debounce included), then destroys it.
/** A text file's copy beside it, never over another: "name (copy).ext", "name (copy 2).ext", ... */
async function keepFileCopy(path: string, text: string, signal?: AbortSignal): Promise<string> {
  const m = /^(.*?)(\.[^./]*)?$/.exec(path)!;
  for (let i = 1; ; i++) {
    const name = `${m[1]} (copy${i > 1 ? ` ${i}` : ""})${m[2] ?? ""}`;
    try {
      await workspace!.create(name, { content: text, ...(signal ? { signal } : {}) });
      return name;
    } catch (e) {
      if ((e as { code?: string }).code !== "exists" || i >= 50) throw e;
    }
  }
}
type Released = { ok: true } | { ok: false; why: string };
type FileHost = { text: () => string; flush: () => Promise<void>; release: () => Promise<Released>; dispose: () => Promise<void>; download: () => { name: string; text: string; type: string } | null };
function mountFile(a: Artifact, box: HTMLElement, saved: HTMLElement): FileHost {
  const path = a.path!;
  let alive = true;
  let open = true; // (this host's writer: closed at release, after which no write of its is admitted, ART-C4)
  let rev = -1; // (the revision the shown text is based on: known before anything is written)
  let fid: string | undefined; // (the file's identity: a write goes only to this file, never to another at its path, ART-C3)
  let text = a.body; // (the editor's text as last told)
  let savedText: string | null = null; // (the text the file has, as far as this host knows)
  let timer = 0;
  let inflight: Promise<void> = Promise.resolve();
  let stopped = false; // (a conflict or refusal: nothing more is written from here)
  let latest: () => string = () => text; // (the editor's current text, its unsent edits included)
  let destroyEditor: () => void = () => {};
  const say = (s: string) => alive && (saved.textContent = s);
  // (refused under the workspace's lock, where the write would happen, once this host's writer is closed)
  const admit = () => {
    if (!open) throw Object.assign(new Error("this file's pane was closed"), { code: "closed" });
  };
  const write = () => {
    clearTimeout(timer);
    const value = latest(); // (the text as it is now: what this write writes, whenever its turn comes)
    inflight = inflight.then(async () => {
      if (!open || stopped || rev < 0 || value === savedText) return;
      try {
        const r = await workspace!.write(path, value, { base: rev, ...(fid ? { fid } : {}), admit });
        rev = r.rev;
        savedText = value;
        say(latest() === value ? "Saved" : "Editing…");
      } catch (e) {
        if (!open) return; // (closed meanwhile: refused by design)
        stopped = true;
        const code = (e as { code?: string }).code;
        say(code === "conflict" ? "Not saved: changed or replaced elsewhere since (your text stays here; reopen to see that version)" : `Not saved: ${(e as Error).message}`);
      }
    });
    return inflight;
  };
  const changed = (value: string) => {
    if (!alive) return;
    text = value;
    say("Editing…");
    clearTimeout(timer);
    timer = window.setTimeout(() => void write(), 700);
  };
  say("Loading…");
  const tex = /\.tex$/i.test(path);
  if (tex && !__SB_LATEX__) {
    // (no LaTeX editor in this build: the source here, and the file in Sagebrush)
    saved.insertAdjacentHTML("afterend", ` <a class="open-full" href="/w${esc(path)}" target="_blank" rel="noopener">Open in Sagebrush</a>`);
  }
  type Latex = { mountEditor?: (root: HTMLElement, o: { text: string; onChange?(t: string): void; layout?: "split" | "preview" }) => { getText(): string; destroy(): void } };
  const latexMod: Promise<Latex | null> = tex && __SB_LATEX__ ? import(/* @vite-ignore */ LATEX_URL).catch(() => null) : Promise.resolve(null);
  // (the file as it is now: the agent may have written it again since this artifact)
  void Promise.all([workspace!.read(path), latexMod]).then(
    ([r, m]) => {
      if (!alive) return;
      // (a data file's content is its bytes: shown here only if they are UTF-8 text)
      let content: string | null = typeof r.content === "string" ? r.content : null;
      if (content === null && r.content instanceof Uint8Array) {
        try {
          content = new TextDecoder("utf-8", { fatal: true }).decode(r.content);
        } catch {
          content = null;
        }
      }
      if (content === null) return say("(not a text file)");
      rev = r.rev;
      fid = r.entry.kind === "file" ? r.entry.fid : undefined;
      text = savedText = content;
      say("Saved");
      if (a.kind === "markdown") {
        const ed = new BlockEditor(text, { render: md, typeset: (el) => typeset(el), onChange: changed });
        ed.el.classList.add("doc");
        box.append(ed.el);
        latest = () => ed.value;
      } else if (m?.mountEditor) {
        const host = document.createElement("div");
        host.className = "tex-host";
        box.append(host);
        const ed = m.mountEditor(host, { text, onChange: changed, layout: "split" });
        latest = () => ed.getText();
        destroyEditor = () => ed.destroy();
      } else {
        const ta = document.createElement("textarea");
        ta.className = "code-edit";
        ta.spellcheck = false;
        ta.value = text;
        ta.oninput = () => changed(ta.value);
        box.append(ta);
        latest = () => ta.value;
      }
    },
    () => {
      if (!alive) return;
      say("(not in this browser's workspace)");
      const pre = document.createElement("pre");
      pre.className = "code";
      pre.textContent = a.body;
      box.append(pre);
    },
  );
  const dispose = async () => {
    if (!alive) return;
    open = false;
    alive = false;
    clearTimeout(timer);
    destroyEditor();
    destroyEditor = () => {};
  };
  // (no edits while it closes: the editor inert (no focus, no input) and read only, and it says so, ART-C2b/C4 r4)
  let guard: Guard = "open";
  let keptText: string | null = null; // (the text a failed close kept frozen, for Download a copy)
  // (gestures inside the editor stopped at its box, before the editor's own handlers, as the guard says)
  guardGestures(box, () => guard);
  const freeze = () => {
    guard = "closing";
    box.inert = true;
    for (const t of box.querySelectorAll<HTMLTextAreaElement>("textarea")) t.readOnly = true;
    say("Closing…");
  };
  let releasing: Promise<Released> | null = null; // (one release at a time)
  const doRelease = async (): Promise<Released> => {
    {
      if (!alive) return { ok: true };
      // (0) frozen first, before anything is awaited: the text kept below is the text shown
      freeze();
      // (1) the latest text, edits inside the editor's own debounce included, written: 3 s at most
      if (open && !stopped && rev >= 0 && latest() !== savedText) await Promise.race([write(), new Promise((r) => setTimeout(r, 3000))]);
      // (2) then this host's writer is closed: a write still queued or waiting for the lock is refused where it would write
      open = false;
      clearTimeout(timer);
      // (3) text the file doesn't have is kept as a copy before the editor goes; if it can't be, the editor stays
      const value = latest();
      if (rev >= 0 && value !== savedText) {
        const ctl = new AbortController();
        const t = setTimeout(() => ctl.abort(), 5000);
        try {
          const name = await keepFileCopy(path, value, ctl.signal);
          toast(`${path}: your last changes weren't saved there; they were kept as ${name}.`, 8000);
        } catch (e) {
          const why = ctl.signal.aborted ? "the workspace is busy" : (e as Error).message;
          say("Not saved, nor kept as a copy");
          // (readable again: not inert, selectable and copyable by hand; still read only, BAC-8)
          keptText = value;
          guard = "kept";
          box.inert = false;
          return { ok: false, why: `Your last changes to ${path} couldn't be saved or kept as a copy (${why}).` };
        } finally {
          clearTimeout(t);
        }
      }
      await dispose();
      return { ok: true };
    }
  };
  return {
    text: () => latest(),
    flush: () => (alive && open && latest() !== savedText ? write() : inflight),
    // (one at a time: a Close, a thread switch and a Try again share the one under way)
    release: () => (releasing ??= doRelease().finally(() => (releasing = null))),
    dispose,
    download: () => (keptText === null ? null : { name: path.split("/").pop()!.replace(/^(.*?)(\.[^.]*)?$/, "$1 (copy)$2"), text: keptText, type: "text/plain;charset=utf-8" }),
  };
}

function renderComposer() {
  renderComposerState(isRunning(current()), queues.get(current().id)?.length ?? 0);
  renderConn();
}

// ---------------------------------------------------------------------------
// The connection (A14): a reload reconnects; a lost connection is never silent; a chat Claude was in never falls back
// to the scripted demo.

// (the no-demo marker: a real agent was in this chat. It holds no credential; it is kept with the chats)
const marked = (t: Thread) => !!(t as Thread & { agent?: boolean }).agent;
function mark(t: Thread) {
  if (marked(t)) return;
  (t as Thread & { agent?: boolean }).agent = true;
  save();
}
// (connected on this page, or a reload record found: a chat made since isn't the demo's either)
let connectedHere = false;
const mayDemo = (t: Thread) => !marked(t) && !connectedHere;
const inert = (t: Thread) => !live() && !mayDemo(t);

type ConnBar = { kind: keyof typeof CONN | "runner"; text?: string; alert: boolean; action: "reconnect" | "connect" | null };
const connText = (b: ConnBar) => b.text ?? (b.kind === "runner" ? "" : CONN[b.kind]);
// (an agent on one of your computers (W2 B): board's words, word for word)
const NOT_SENT = {
  full: (agent: string) => `Too many messages are waiting to go to ${agent}. Send this one again in a moment.`,
  over: "This message is over this connection's limit of about 4 MB, so it wasn't sent.",
};
const RUNNER = {
  connecting: (computer: string) => `Connecting to ${computer}…`,
  lost: (computer: string, why: string) => `Not connected to ${computer}${why ? `: ${why}` : ""}. Choose Chat here to connect again.`,
  disconnected: (computer: string) => `Disconnected. The agent on ${computer} may keep running for up to 5 minutes.`,
};
/** The bar after a leg to `computer` ended: the person's Disconnect (only its own line, never the runner's "The agent
 * stopped" after it), the runner's own words (agent.ended, a refused hello), or the lost line with why. */
function runnerBar(computer: string, e: LegEnd | { kind: string; why: string }): ConnBar {
  if (e.kind === "disconnected") return { kind: "runner", text: RUNNER.disconnected(computer), alert: false, action: "connect" };
  if ((e.kind === "ended" || e.kind === "refused") && e.why) return { kind: "runner", text: e.why, alert: true, action: "connect" };
  return { kind: "runner", text: RUNNER.lost(computer, e.why), alert: true, action: "connect" };
}
// (an attempt to one of your computers, between Chat here and its agent.ready: the header's "Connecting to …")
let connectingTo: string | null = null;
const CONN = {
  lost: "Claude disconnected. Your chats are kept; Claude keeps their context while sagebrush-agent runs.",
  restoring: "Reconnecting to Claude…",
  unreachable: "Couldn't connect to sagebrush-agent on this computer. It may have stopped, this browser may need permission to reach it, or another page may be connected to it.",
  refused: "sagebrush-agent didn't accept this page's last connection, so it needs a new code. If sagebrush-agent was restarted, Claude's earlier context for these chats is gone; your chats are still here.",
  expired: "Claude's access expired.",
  discarded: "Claude's earlier connection was for another page or workspace, so it needs a new code.",
  unusable: "This page's earlier connection to Claude couldn't be used, so it needs a new code.",
  kept: "Claude was connected to this page earlier.",
};
let connBar: ConnBar | null = null;
let connShown = false; // (the bar's ×: hidden until the next change)
let reconnecting = false; // (a [Reconnect] while its one attempt runs: "Reconnecting…", never disabled, C3)
let busyBtn: HTMLElement | null = null; // (which [Reconnect] started it: the bar's or the hint's)
let rememberBusy = false; // ("Use remembered access" while its attempt runs: its own "Connecting…", board's N-b)
// (a Connect dialog opened from the bar or the hint: on success, focus goes to the composer; if the grant is cancelled,
//  back to that button; board's B-A14-1)
let connectFrom: HTMLElement | null = null;
let rememberedGrant: Kept["grant"] | null = null;
let agentUi: ReturnType<typeof mountAgentPairing> | null = null;
const setText = (el: HTMLElement, t: string) => { if (el.textContent !== t) el.textContent = t; };

function setConn(b: ConnBar | null) {
  connBar = b;
  connShown = !!b;
  renderConn();
}

function grantScope(g: Kept["grant"]) {
  const where = g.folders.includes("/") ? "everywhere" : "in " + g.folders.join(", ");
  return `${g.write ? "read and write" : "read only"} ${where}${g.expires !== null ? ", until " + new Date(g.expires).toLocaleString() : ""}`;
}

function renderConn() {
  const bar = $("#conn-bar"), hint = $("#send-hint"), b = connShown ? connBar : null;
  const was = document.activeElement instanceof HTMLElement && (bar.contains(document.activeElement) || hint.contains(document.activeElement)) ? document.activeElement : null;
  bar.classList.toggle("on", !!b);
  setText($("#conn-alert"), b?.alert ? connText(b) : "");
  setText($("#conn-status"), b && !b.alert ? connText(b) : "");
  // (the action: the bar's, or Connect when there's no bar; on the bar's button, and on the hint's after ×, B-A14-3)
  const action = connBar?.action ?? "connect";
  const act = $("#conn-act"), hact = $("#send-hint-act");
  const acts = b !== null && (b.action !== null || b.kind !== "restoring");
  ($(".acts", bar) as HTMLElement).hidden = !acts;
  act.hidden = !b?.action;
  for (const btn of [act, hact]) {
    const mine = reconnecting && busyBtn === btn;
    setText(btn, mine ? "Reconnecting…" : action === "connect" ? "Connect" : "Reconnect");
    mine ? btn.setAttribute("aria-busy", "true") : btn.removeAttribute("aria-busy");
    reconnecting || rememberBusy ? btn.setAttribute("aria-disabled", "true") : btn.removeAttribute("aria-disabled");
  }
  const rem = !!b && !!rememberedGrant && b.kind !== "restoring" && b.kind !== "lost";
  ($(".remembered", bar) as HTMLElement).hidden = !rem;
  setText($("#conn-scope"), rem && rememberedGrant ? grantScope(rememberedGrant) : "");
  const rb = $("#conn-remembered");
  setText(rb, rememberBusy ? "Connecting…" : "Use remembered access");
  for (const k of ["aria-busy", "aria-disabled"]) rememberBusy ? rb.setAttribute(k, "true") : rb.removeAttribute(k);
  $("#conn-x").hidden = !b || b.kind === "restoring";
  // Send: inert while not connected in a chat the demo may not answer, never `disabled` (C1), described by what says why
  const send = $("#send"), off = inert(current());
  hint.hidden = !(off && !b);
  if (off) {
    send.setAttribute("aria-disabled", "true");
    send.setAttribute("aria-describedby", b ? (b.alert ? "conn-alert" : "conn-status") : "send-hint-text");
  } else {
    send.removeAttribute("aria-disabled");
    send.removeAttribute("aria-describedby");
  }
  // (focus never falls to the body: from a button that went away, to its twin if it's there (the hint's and the bar's
  //  are the same action), else to the composer)
  if (was && !was.checkVisibility()) {
    const twin = was === hact ? act : was === act ? hact : null;
    if (!live() && twin && twin.checkVisibility()) twin.focus();
    else editor.focus();
  }
}

/** The action, from the bar's button or the hint's: the same handler and the same states (C3, B-A14-3). */
async function doAct(btn: HTMLElement) {
  if (reconnecting || rememberBusy || !agentUi) return;
  if ((connBar?.action ?? "connect") === "connect") {
    connectFrom = btn;
    return agentUi.connect("", "", btn);
  }
  reconnecting = true;
  busyBtn = btn;
  renderConn();
  try {
    await agentUi.reconnectKept();
  } finally {
    reconnecting = false;
    busyBtn = null;
    renderConn();
  }
}
$("#conn-act").onclick = () => void doAct($("#conn-act"));
$("#send-hint-act").onclick = () => void doAct($("#send-hint-act"));
$("#conn-remembered").onclick = async () => {
  if (reconnecting || rememberBusy || !agentUi) return;
  rememberBusy = true;
  renderConn();
  const g = await agentUi.useRemembered().catch(() => null);
  rememberBusy = false;
  if (g) setConn(null);
  else setConn({ kind: "unreachable", alert: false, action: connBar?.action ?? "connect" });
};
$("#conn-x").onclick = () => {
  connShown = false;
  renderConn();
  editor.focus();
};

function onRestore(s: RestoreState) {
  connectedHere = true;
  if (s.kind === "restoring") {
    // (the bar's own [Reconnect] keeps its button, and focus on it, while it runs: C3)
    if (!reconnecting) setConn({ kind: "restoring", alert: false, action: null });
  } else if (s.kind === "restored") {
    setConn(null);
  } else {
    setConn({ kind: s.why === "not-a-reload" ? "kept" : s.why, alert: false, action: s.canReconnect ? "reconnect" : "connect" });
    // (after a record that wasn't restored, a remembered grant is offered, never tried silently)
    void agentUi?.remembered().then((g) => {
      rememberedGrant = g;
      renderConn();
    });
  }
  renderHeader();
}

let toastTimer = 0;
function toast(text: string, ms = 1500) {
  const t = $("#toast");
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (t.hidden = true), ms);
}

// ---------------------------------------------------------------------------
// The page

const editor = mountComposer({ submit, stop: () => interrupt(current()), render: md, typeset: (el) => typeset(el) });
$("#new").onclick = async () => {
  if (!(await mayLeaveThread())) return;
  const t = newThread(id(), "New chat");
  state.threads.push(t);
  state.current = t.id;
  openArtifact = null;
  save();
  renderAll();
  editor.focus();
  document.body.classList.remove("nav-open");
};
$("#menu").onclick = () => document.body.classList.toggle("nav-open");
for (const b of document.querySelectorAll<HTMLButtonElement>("[data-try]")) {
  b.onclick = () => {
    editor.value = b.dataset.try!;
    submit("sent");
  };
}
addEventListener("keydown", (e) => {
  // (Escape inside an editor in the pane is the editor's: a notebook leaves edit mode, closes its completer)
  // (and in a dialog or a notebook popup, which live on the document body: the shortcuts dialog, a completer, BAC-5)
  if (e.key === "Escape" && (e.defaultPrevented || (e.target instanceof Element && e.target.closest("#artifacts .file-body, #artifacts .nb-root, dialog, .sbnb-pop")))) return;
  if (e.key === "Escape" && fullscreen) {
    fullscreen = false;
    renderArtifacts();
  } else if (e.key === "Escape" && isRunning(current()) && !editor.field) {
    interrupt(current());
  }
});

// (a turn that was running when the page closed can't go on: it ends interrupted)
for (const t of state.threads) {
  const r = runningTurn(t);
  if (r) emitTo(t, r.turn_id, { type: "turn_finished", outcome: "interrupted" });
}
// (A14: a reload record waiting for its restore says this page was connected: no demo, even before the workspace is
// open and the restore decided; only its presence is read here)
try {
  if (sessionStorage.getItem(RELOAD_KEY) !== null) connectedHere = true;
} catch {
  // (no sessionStorage: no record)
}
renderHeader();
// The workspace, and the pairing with an agent on this computer (a ?pair=CODE&port=N link opens it at once).
// (a workspace that can't be opened is said, in words, with its error and a [Retry]: never a silent demo, which hid
// exactly this; the chats here still work as a preview)
let retrying = false;
async function openWorkspace(again = false): Promise<boolean> {
  let why = "";
  try {
    workspace = await Workspace.open();
  } catch (e) {
    workspace = null;
    why = String((e as Error)?.message ?? e).slice(0, 300);
  }
  $("#connect").hidden = !workspace;
  $("#ws-error").hidden = !!workspace;
  // (the sentence once, then the error's own words in the muted details; a failed [Retry] says so anew, and the same
  // text is cleared first, so role=alert announces it again)
  const msg = workspace ? "" : `${again ? "Still couldn't open the storage. " : ""}This browser's storage couldn't be opened, so Claude can't connect on this page. If Sagebrush is open in another tab, close it, then try again.`;
  const t = $("#ws-error-text");
  if (again && msg && t.textContent === msg) {
    t.textContent = "";
    await new Promise((r) => setTimeout(r, 100));
  }
  setText(t, msg);
  setText($("#ws-error-why"), workspace ? "" : `(${why.replace(/^this browser's storage can't be opened: /, "")})`);
  return !!workspace;
}
await openWorkspace();
// An agent's edit of a notebook by cell (A12 step 1): in its chat's pane, the notebook opened there first (as a write
// opens it), then the open notebook's own edit (notebook-artifact.ts): checked whole, applied, saved once.
async function editNotebook(e: NotebookEdit, may: () => boolean, hold?: () => Promise<() => void>): Promise<unknown> {
  const thread = state.threads.find((t) => t.id === e.conversation);
  if (!thread) throw new AgentError("invalid", "no such chat on this page");
  const turn = runningTurn(thread);
  if (!turn) throw new AgentError("busy", "this chat has no turn running: an edit comes from a turn");
  // (a chat that isn't the one shown has no pane here: its notebook isn't opened over the person's view)
  if (thread.id !== current().id) throw new AgentError("busy", "the person is looking at another chat: this one's notebook isn't open, so it isn't changed (ask them to open this chat)");
  // (the authority the host checks right before the change: the pairing's grant, and THIS turn still the running one)
  const turnId = turn.turn_id;
  const mayHere = () => may() && runningTurn(thread)?.turn_id === turnId;
  // While the person is in another artifact, the pane stays on it and so does their focus (BAC-6, board's BA12-1): the
  // notebook's host is mounted hidden (hosts are live while hidden) and its tab says it changed. The pane switches
  // to it only when it is closed or already shows it.
  const shownOther = document.body.classList.contains("has-artifact") && openArtifact !== null && openArtifact !== e.path;
  const keep = openArtifact;
  // (where the person is: put back only if the edit took it, to the page or into the notebook's host while that is
  // hidden (board's ruling); a focus or caret the person chose meanwhile, in the notebook too if they showed it, is
  // theirs, A12-R2-F1)
  const focused = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
  const range = focused instanceof HTMLTextAreaElement || focused instanceof HTMLInputElement ? [focused.selectionStart, focused.selectionEnd] : null;
  const inHidden = (n: Node) => {
    const el = hosts.get(hostKey(thread.id, e.path))?.el;
    return !!el?.hidden && el.contains(n);
  };
  const putFocusBack = () => {
    const now = document.activeElement;
    if (!shownOther || !focused?.isConnected || now === focused) return;
    if (now && now !== document.body && !inHidden(now)) return;
    focused.focus({ preventScroll: true });
    if (range && (focused instanceof HTMLTextAreaElement || focused instanceof HTMLInputElement) && range[0] !== null) focused.setSelectionRange(range[0], range[1]);
  };
  if (!thread.artifacts.some((a) => a.id === e.path && a.kind === "notebook")) emitTo(thread, turnId, { type: "artifact", id: e.path, kind: "notebook", title: e.path.split("/").pop()!, path: e.path, body: "edited by cell" });
  const art = thread.artifacts.find((a) => a.id === e.path && a.kind === "notebook");
  if (!art) throw new AgentError("busy", "the notebook couldn't be opened here");
  if (shownOther) {
    openArtifact = keep;
    hiddenHost(thread.id, art);
  } else {
    openArtifact = e.path;
    renderArtifacts();
  }
  const h = hosts.get(hostKey(thread.id, e.path));
  if (!h?.nb) throw new AgentError("busy", "the notebook couldn't be opened here");
  putFocusBack();
  await h.nb.ready;
  putFocusBack();
  const r = await h.nb.edit(e, mayHere, hold);
  putFocusBack();
  if (!r.ok) throw new AgentError(r.code, r.why, r.ids ? { ids: r.ids } : {});
  if (shownHost() !== h) {
    h.changed = true;
    headKey = "";
    if (current().id === thread.id) renderArtifacts();
  }
  return { ok: true, inserted: r.inserted };
}
/** An artifact's host made without showing it (its notebook live, hidden): for an agent's edit behind another tab. */
function hiddenHost(threadId: string, a: Artifact) {
  const key = hostKey(threadId, a.id);
  if (hosts.has(key)) return;
  const { body } = paneShell($("#artifacts"));
  const el = document.createElement("div");
  el.className = "pane-host";
  el.hidden = true;
  body.append(el);
  const h: Host = { key, el, body: "", copy: () => a.body, running: false, bar: null };
  hosts.set(key, h);
  mountHost(threadId, a, h);
}

function mountPairing(ws: Workspace) {
  agentUi = mountAgentPairing(ws, {
    program: "sagebrush-agent",
    button: $("#connect"),
    notebookEdit: editNotebook,
    // (an agent's own branch, chat plan PR 3: offered here, where agents work)
    branches: gitBranches,
    reload: {
      scope: { workspace: `${WS_DB}/${ws.identity.workspace}`, page: location.origin + location.pathname },
      onState: onRestore,
      onRemembered(g) {
        setText($("#who-status"), `connected with remembered access: ${grantScope(g)}`);
      },
    },
    quietLoss: true,
    // (Chat here: an agent on one of your computers, over the relay's agent leg (W2 B))
    runners: {
      list: () => listRunners(),
      async open(r) {
        const leg = new AgentLeg({ remoteId: r.remote_id, url: pageLegUrl(r.remote_id, "agent"), key: await legKey() }).start();
        const ended = await new Promise<LegEnd | null>((res) => { leg.on("open", () => res(null)); leg.on("end", (e) => res(e)); });
        // (the runner's notices: its words, as they are)
        leg.on("notice", (t) => toast(t, 6000));
        return { link: leg, ended };
      },
      onConnecting(r) { connectingTo = r.name; setConn(null); renderHeader(); },
      onFailed(r, e) { connectingTo = null; setConn(runnerBar(r.name, e)); renderHeader(); },
    },
    onPairing(p) {
      pairing = p;
      cards.clear();
      p.onNotification(onAgent);
      let granted = false;
      p.onChange(() => {
        if (p.link && p.state !== "connecting") connectingTo = null;
        if (p.link && p.state === "closed" && pairing === p && p.closeReason !== "not allowed") {
          // (over a runner: the person's own Disconnect says only its line; anything else, why the leg ended)
          setConn(p.closeReason === "revoked by the person" ? runnerBar(p.computer, { kind: "disconnected", why: "" })
            : p.closeReason === "the grant expired" ? { kind: "expired", alert: true, action: "connect" }
            : runnerBar(p.computer, p.linkEnd ?? { kind: "lost", why: "" }));
        }
        if (p.state === "paired" || p.state === "granted") connectedHere = true;
        if (p.state === "granted" && !granted) {
          granted = true;
          if (connBar) setConn(null);
          if (connectFrom) {
            connectFrom = null;
            editor.focus();
          }
        }
        if (p.state === "closed" && !granted && p.closeReason === "not allowed" && connectFrom?.checkVisibility()) {
          connectFrom.focus();
          connectFrom = null;
        }
        if (p.state === "closed" && pairing === p && granted && !p.link) {
          // (a connection that was in force ended: the person's Revoke says nothing more; an expiry or a loss, the bar)
          const why = p.closeReason;
          if (why === "revoked by the person") setConn(null);
          else if (why === "the grant expired") setConn({ kind: "expired", alert: true, action: "connect" });
          else setConn({ kind: "lost", alert: true, action: agentUi?.canReconnect ? "reconnect" : "connect" });
        }
        if (p.state === "closed" && pairing === p) {
          // (turns the agent can no longer finish end here, as interrupted)
          for (const tid of [...liveRunning]) {
            const thread = state.threads.find((t) => t.id === tid);
            const r = thread && runningTurn(thread);
            if (thread && r) emitTo(thread, r.turn_id, { type: "turn_finished", outcome: "interrupted" });
          }
          liveRunning.clear();
        }
        renderHeader();
        renderComposer();
      });
      renderHeader();
    },
  });
}
if (workspace) mountPairing(workspace);
// (the storage message's [Retry]: the open again, then the pairing, as a load would; never `disabled` while it runs)
$("#ws-retry").onclick = async () => {
  if (retrying) return;
  retrying = true;
  const b = $("#ws-retry");
  b.setAttribute("aria-busy", "true");
  b.setAttribute("aria-disabled", "true");
  setText(b, "Retrying…");
  try {
    if ((await openWorkspace(true)) && workspace) {
      mountPairing(workspace);
      // (the focused [Retry] was inside the message that just hid: focus goes to the next step, Connect Claude, unless
      // a dialog (the pairing link's) has taken it)
      if (document.activeElement === b || document.activeElement === document.body) $("#connect").focus();
    }
  } finally {
    retrying = false;
    b.removeAttribute("aria-busy");
    b.removeAttribute("aria-disabled");
    setText(b, "Retry");
    renderHeader();
  }
};
addEventListener("pagehide", () => {
  // (the chats, and the no-demo marker, kept now: a reload within save()'s 300 ms would lose them)
  if (saveTimer) localStorage.setItem(STORE, JSON.stringify(state));
});
$("#howto").onclick = () => ($("#help").hidden = !$("#help").hidden);

function renderHeader() {
  const who = $("#who");
  if (live() && pairing?.link) {
    who.innerHTML = `<span class="conn on"></span>${esc(agentName())} <small>on ${esc(pairing.computer)}</small>`;
  } else if (live()) {
    who.innerHTML = `<span class="conn on"></span>${esc(agentName())} <small>on your computer</small>`;
  } else if (connectingTo !== null) {
    who.innerHTML = `<span class="conn wait"></span><small>${esc(RUNNER.connecting(connectingTo))}</small>`;
  } else if (pairing && pairing.state === "paired") {
    who.innerHTML = `<span class="conn wait"></span>${esc(agentName())} <small>connected: allow it in the dialog</small>`;
  } else if (inert(current())) {
    who.innerHTML = `<span class="conn"></span>Claude <small>not connected</small>`;
  } else {
    who.innerHTML = `<span class="conn demo"></span>Claude <small>scripted demo</small>`;
  }
  for (const el of document.querySelectorAll<HTMLElement>("#editor [data-placeholder]")) el.dataset.placeholder = `Message ${agentName()}…  (Shift+Enter to send)`;
  $("#connect").textContent = live() ? "Connected" : "Connect Claude";
  $("#stop").textContent = stopLabel(agentName());
  $("#connect").toggleAttribute("disabled", live());
  $("#banner").innerHTML = live()
    ? `Connected to ${esc(agentName())} on your computer (your own login). Its files are in this browser's workspace; chats are kept in this browser.`
    : connBar?.kind === "restoring"
    ? "Reconnecting to Claude on your computer…"
    : inert(current())
    ? "Claude isn't connected to this page. Chats are kept in this browser only."
    : "Preview: the chat is driven by a <b>scripted</b> stand-in for Claude until you connect your own (\"Use your own Claude\"). Chats are kept in this browser only.";
}

renderHeader();
openArtifact = current().artifacts.at(-1)?.id ?? null;
mountLayout();
renderAll();
scrollToEnd(true);
editor.focus();
