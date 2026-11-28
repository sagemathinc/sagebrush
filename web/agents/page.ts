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
import { blockLang, colorBlock } from "./code-color";
import { drawTokens, tokensOf } from "../code/tokens";
import { langOf } from "../code/langs";
import { modeKey, modeOf, rememberMode, type DocMode } from "../doc-mode";
import { runningTurn, type Artifact, type Thread, type Turn, type UserEntry } from "../workspace/agent-chat/events";
import { ChatSession } from "../workspace/agent-chat/session";
import { userNode as viewUserNode, turnNode as viewTurnNode, artifactIcon, artifactLabel, diffHtml, mirrorSectionNode } from "../workspace/agent-chat/view";
import { Mirror, MIRROR_COPY, mirrorTitle, type RemoteConversation, type Section } from "../workspace/agent-chat/mirror";
import { mountDictation } from "./dictation";
import { startFakeTurn } from "./fake-agent";
import { AgentError, RELOAD_KEY, type AgentPairing, type Created, type Kept } from "../workspace/agent-pair";
import type { NotebookEdit } from "../workspace/notebook-edit";
import { mountAgentPairing, RELEASED, type RestoreState } from "../workspace/agent-ui";
import { createdRunner } from "../workspace/agent-made";
import { runVerbsFor } from "../workspace/run-holder";
import { agentRunsFor } from "../workspace/agent-runs";
import type { PageRun } from "../workspace/run-verbs";
import type { SpaceHost } from "../workspace/space3d";
import { createPermissions } from "../notebook/permissions.js";
import * as gitBranches from "../workspace/git-branch";
import { openReviewDialog, showWhenBranches } from "../workspace/review/open-dialog";
import { Workspace } from "../workspace/api";
import { WS_DB } from "../workspace/db";
import { guardGestures, mountNotebook, type AgentCells, type Guard, type NotebookHost, type NotebookUi } from "./notebook-artifact";
import { mountComposer, renderComposerState, stopLabel } from "../workspace/agent-chat/composer";
import { applyPaneClasses, mountLayout, relayout } from "./layout";
import { AgentLeg, legKey, listComputers, pageLegUrl, removeComputer, type LegEnd } from "../workspace/agent-relay";
import { chatHere } from "./chat-here";
import { filesIcon, modeSwitch, answerAgentsLive, agentsTabLive, agentsTabRemembered, releaseAgentsTab, FILES_TAB } from "../workspace/mode-switch";
import { icon as panelIcon } from "../workspace/files-toggle";
import { entryUrl } from "../workspace/entry-url";
import { threadMarkdown, turnMarkdown, userMarkdown } from "../workspace/agent-chat/transcript";
import { DelegateTasks } from "./delegate";
import { mountDelegate } from "./delegate-ui";
import { ownClaudeCommand } from "./own-claude";
import { workspaceIO } from "./delegate-merge";
import { toIpynb } from "../notebook/ipynb.js";
import { mountVersionStamp } from "../version";
import { ATTACH_COPY, mountAttach } from "./attach";
import { inGrant } from "../workspace/agent-grant";

// (the build this site serves, under the chat list, for whoever tests it: web/version.ts; first, before anything that
// waits, so it shows even while the workspace opens; nothing where the site doesn't say)
void mountVersionStamp(document.getElementById("sbversion"));

// (the LaTeX editor, in builds that have it: web/build.ts's define)
declare const __SB_LATEX__: boolean | undefined;
declare const __SB_LATEX_HOSTS__: string[];
const LATEX_URL = new URL("../sagebrush-latex.js", import.meta.url).href;
// (the 3D view, in builds that have it and on its listed hosts, matched exactly: web/build.ts's SPACE_DEFINE, DEV and
//  PROD; its code is a chunk of its own, fetched when a .space.json is shown)
declare const __SB_SPACE__: boolean | undefined;
declare const __SB_SPACE_HOSTS__: string[];

const STORE = "sagebrush-agents-preview-v1";
// (the log mirror's cursors, by conversation: local and non-secret, M2)
const MIRROR_CURSORS = "sagebrush-agents-mirror-v1";
// The composer's draft, by chat, in this browser (as CoCalc keeps one, #1615): kept as it is typed, back when its chat is
// shown again (after another chat, Files or a reload), gone once sent. One localStorage record; each chat's draft is
// written alone into the record as read then, so another tab's drafts of other chats stay. Bounded, so the chats' own
// record has room: a draft over DRAFT_MAX isn't kept, a chat no longer stored loses its draft, and over DRAFTS_MAX in
// all the other chats' longest drafts go first, whether written before or waiting now. Both are measured as stored
// (JSON, its escapes counted). Best effort: storage that is full or unavailable keeps nothing new.
const DRAFTS = "sagebrush-agents-drafts-v1";
const DRAFT_MAX = 64 * 1024;
const DRAFTS_MAX = 512 * 1024;
function readDrafts(): Record<string, string> {
  const d: Record<string, string> = Object.create(null);
  try {
    const v = JSON.parse(localStorage.getItem(DRAFTS) ?? "{}");
    if (v && typeof v === "object" && !Array.isArray(v)) for (const [k, t] of Object.entries(v)) if (typeof t === "string") d[k] = t;
  } catch {}
  return d;
}
// (drafts not written yet: a refused write keeps them here, so a chat shows its own again and the next write retries)
const draftsPending = new Map<string, string>();
let draftTimer = 0;
function flushDrafts() {
  clearTimeout(draftTimer);
  draftTimer = 0;
  if (!draftsPending.size) return;
  const d = readDrafts();
  for (const [id, t] of draftsPending) {
    if (!t.trim()) delete d[id];
    else if (JSON.stringify(t).length <= DRAFT_MAX) d[id] = t;
    // (over the limit: the last copy within it stays)
  }
  // (the chats as stored (another tab's newer ones too), and this tab's)
  let stored: Set<string> | null = null;
  let record: { threads: Thread[] } | null = null;
  try {
    const v = JSON.parse(localStorage.getItem(STORE) ?? "null");
    if (v && Array.isArray(v.threads)) record = v;
    stored = new Set(record ? record.threads.map((t) => t?.id) : []);
  } catch {}
  // (a chat with a draft is stored too: a first visit's chat isn't until something happens in it, and its draft would
  //  come back to no chat. Added to the record as stored, not this tab's chats written over it, which would undo
  //  another tab's newer)
  const missing = stored ? state.threads.filter((t) => draftsPending.has(t.id) && !stored!.has(t.id)) : [];
  if (missing.length) {
    try {
      // (and the chat shown here as the one shown: the person is in this tab; the record's own would undo a switch
      //  whose save comes before this write)
      localStorage.setItem(STORE, JSON.stringify(record ? { ...record, threads: [...record.threads, ...missing], current: state.current } : state));
      for (const t of missing) stored!.add(t.id);
    } catch {}
  }
  if (stored) for (const id of Object.keys(d)) if (!stored.has(id) && !state.threads.some((t) => t.id === id)) delete d[id];
  // (the composer's chat keeps its draft (at most DRAFT_MAX, well under DRAFTS_MAX); the others longest first, then by
  //  id, so the same drafts always go)
  const others = Object.keys(d)
    .filter((id) => id !== draftOf)
    .sort((a, b) => d[b].length - d[a].length || (a < b ? -1 : a > b ? 1 : 0));
  while (others.length && JSON.stringify(d).length > DRAFTS_MAX) delete d[others.shift()!];
  try {
    localStorage.setItem(DRAFTS, JSON.stringify(d));
    draftsPending.clear();
  } catch {} // (refused: still waiting, in draftsPending, written with the next draft's write)
}
// (here, before anything the page waits for: a page left, even while it still opens, keeps its draft, and the chats and
//  the no-demo marker if their save is still waiting (a reload within save()'s 300 ms would lose them); only then, so
//  a tab left idle never writes its chats over another tab's newer ones)
addEventListener("pagehide", () => {
  flushDrafts();
  if (storeWaiting) {
    try {
      localStorage.setItem(STORE, JSON.stringify(state));
    } catch {}
  }
});
let storeWaiting = false;
function putDraft(id: string, text: string, now = false) {
  draftsPending.set(id, text);
  if (now) return flushDrafts();
  clearTimeout(draftTimer);
  draftTimer = window.setTimeout(flushDrafts, 300);
}
/** The chat whose draft the composer holds (null until the composer is up). */
let draftOf: string | null = null;
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T;

// ---------------------------------------------------------------------------
// The conversation (agent-chat/session.ts): its threads, the queue, the paired agent's turns and cards; this page's
// scripted demo, drawing and words around it

let saveTimer = 0;
let pairing: AgentPairing | null = null;
let stopReviewButton: (() => void) | null = null; // (the "Review changes" button shown while a branch exists)
let workspace: Workspace | null = null; // this browser's workspace: where the paired agent's files are
// The paired agent's name, as it says (Claude, Codex, ...): the demo is Claude.
const agentName = () => (pairing && pairing.state !== "closed" && pairing.hello?.agent.name?.trim().slice(0, 40)) || "Claude";
let openArtifact: string | null = null;
let fullscreen = false;

const session = new ChatSession({
  load() {
    try {
      return JSON.parse(localStorage.getItem(STORE) ?? "");
    } catch {
      return null; // (a first visit, or an old format: start fresh)
    }
  },
  store(s) {
    clearTimeout(saveTimer);
    storeWaiting = true;
    saveTimer = window.setTimeout(() => {
      storeWaiting = false;
      try {
        localStorage.setItem(STORE, JSON.stringify(s));
      } catch {} // (storage full: the chats stay here, kept at the next save that fits)
    }, 300);
  },
  pairing: () => pairing,
  demo: (prompt, emit) => startFakeTurn(prompt, emit, speed()),
  mayDemo: (t) => mayDemo(t),
  emitted(thread, d, replayed) {
    if (d.type === "artifact") {
      // (one replayed from the agent's log after a reconnect is recorded, but never moves the pane)
      // (shown: its tab back if the person had closed it, #1792, as renderArtifacts does for any artifact shown)
      if (!replayed) openArtifact = (d as { id: string }).id;
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
    // (a turn of the agent's that ended live: the log mirror uploads what it has)
    if (d.type === "turn_finished" && !replayed && !session.readOnly(thread)) void mirror.kick(thread.id);
    if (thread.id === state.current) schedule();
  },
  changed: (all) => (all ? renderAll() : renderComposer()),
  // (a replay with a tag is the log mirror's, never the display's)
  tagged: (params, from) => { mirror.onReplay(params, from); },
  notSent(why) {
    // (over a runner, each cause in its own words: a queue that's full now, or a message over the connection's limit)
    if (why === "full") toast(NOT_SENT.full(agentName()), 6000);
    else if (why === "over") toast(NOT_SENT.over, 6000);
    else toast("The agent is disconnected");
  },
});
const state = session.state;
const save = () => session.save();
const live = () => session.live();
const isRunning = (thread: Thread) => session.isRunning(thread);
const queues = session.queues;
const cards = session.cards;
const current = () => session.current();
const interrupt = (thread: Thread) => session.interrupt(thread);

// ---------------------------------------------------------------------------
// The log mirror (M2, agent-chat/mirror.ts): with it on, this page uploads its agent's log to the person's account,
// and lists and shows (read-only) what the account holds that this browser doesn't. Nothing of it shows where the
// site's mirror isn't available to the person.

const mirror = new Mirror({
  fetch: (path, init) => fetch(path, init),
  pairing: () => pairing,
  loadCursors() {
    try {
      return JSON.parse(localStorage.getItem(MIRROR_CURSORS) ?? "");
    } catch {
      return null;
    }
  },
  storeCursors(c) {
    try {
      localStorage.setItem(MIRROR_CURSORS, JSON.stringify(c));
    } catch {}
  },
  changed: () => {
    renderSidebar();
    renderMirrorSettings();
    renderHeader(); // (the status's popover says where the chats are kept)
  },
});
/** The mirrored conversation shown instead of a thread of this browser's, or null. */
let mirrorOpen: { conversation: string; locator: string; title: string; sections: Section[] } | null = null;
const mirrorTitles = new Map<string, string>();
let mirrorDeleting = false;

async function openMirror(c: RemoteConversation) {
  // (a task's view shown: it gives the main pane to the mirrored conversation, closed first, as a thread's click does)
  if (delegateUi.showing() !== null) delegateUi.close();
  if (!mirrorOpen && !(await mayLeaveThread())) return;
  const r = await mirror.readConversation(c.conversation).catch(() => null);
  // (a task opened while the conversation was read: the person's later choice stands)
  if (delegateUi.showing() !== null) return;
  if (!r) return toast(MIRROR_COPY.gap);
  const title = mirrorTitle(r.sections);
  mirrorTitles.set(c.conversation, title);
  mirrorOpen = { conversation: c.conversation, locator: r.locator, title, sections: r.sections };
  openArtifact = null;
  $("#mirror-log").dataset.conv = ""; // (drawn again, as read now: new sections, new marks)
  renderAll();
  document.body.classList.remove("nav-open");
}
function closeMirror() {
  mirrorOpen = null;
}

// ---------------------------------------------------------------------------
// Sending

function submit(mode: UserEntry["mode"]) {
  // (a mirrored conversation is read-only: nothing is sent from it)
  if (mirrorOpen) return;
  // (not connected, in a chat the demo may not answer: Send is inert and the draft stays, A14 C1; a note still posts)
  // (dictating stops as the message or note goes, its words heard so far in it: none is added after it)
  dictation.finish();
  if (!session.submit(editor.value, mode)) return;
  if (mode !== "note") void mirror.kick(current().id);
  editor.value = "";
  putDraft(draftOf || current().id, "", true);
  renderAll();
  scrollToEnd(true);
}

function answer(thread: Thread, attention: string, approve: boolean | "turn", turnId: string, instance: string) {
  if (session.answer(thread, attention, approve, turnId, instance)) renderThread();
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

// (a message's code blocks in colour, up to CODE_COLOR_MAX characters each: a longer one, re-rendered as it streams,
//  stays plain)
const CODE_COLOR_MAX = 64 * 1024;
function md(src: string): string {
  return markdown(src, { remote: "click", highlight: (code, lang) => (code.length <= CODE_COLOR_MAX ? colorBlock(code, lang) : null) });
}

function renderAll() {
  renderSidebar();
  renderMirrorView();
  renderThread();
  renderArtifacts();
  renderComposer();
}

function renderSidebar() {
  const list = $("#threads");
  list.innerHTML = "";
  for (const t of [...state.threads].reverse()) {
    const a = document.createElement("button");
    a.className = "thread" + (t.id === state.current && !mirrorOpen ? " on" : "");
    a.textContent = t.title;
    if (isRunning(t)) a.append(Object.assign(document.createElement("span"), { className: "dot", title: "working" }));
    a.onclick = async () => {
      // (a task's view shown: back to the chats, this one)
      if (delegateUi.showing() !== null) delegateUi.close();
      if (t.id === state.current && !mirrorOpen) return;
      if (!mirrorOpen && !(await mayLeaveThread())) return;
      closeMirror();
      state.current = t.id;
      openArtifact = t.artifacts.at(-1)?.id ?? null;
      save();
      renderAll();
      scrollToEnd(true);
      document.body.classList.remove("nav-open");
    };
    list.append(a);
  }
  // (a chat of this browser's that the account also holds: its mirrored copy stays readable, apart, never merged)
  const copy = mirror.cached().find((c) => c.conversation === current().id && c.streams.some((x) => x.next_n > 1));
  const cb = $("#mirror-copy");
  cb.hidden = !copy || !!mirrorOpen;
  setText(cb, MIRROR_COPY.viewCopy);
  cb.onclick = () => { if (copy) void openMirror(copy); };
  // (the account's mirrored conversations this browser doesn't have: the same list, each with a small badge, Q2)
  const here = new Set(state.threads.map((t) => t.id));
  for (const c of mirror.cached()) {
    if (here.has(c.conversation) || !c.streams.some((x) => x.next_n > 1)) continue;
    const a = document.createElement("button");
    a.className = "thread mirror" + (mirrorOpen?.conversation === c.conversation ? " on" : "");
    a.textContent = mirrorTitles.get(c.conversation) ?? MIRROR_COPY.untitled;
    a.append(Object.assign(document.createElement("span"), { className: "badge", textContent: MIRROR_COPY.badge }));
    a.onclick = () => void openMirror(c);
    list.append(a);
  }
}

/** A mirrored conversation, in place of the thread: its sections, read-only, with no composer. */
function renderMirrorView() {
  const m = mirrorOpen;
  const view = $("#mirror-log");
  $("#log").hidden = !!m;
  view.hidden = !m;
  $(".composer-wrap").hidden = !!m;
  $("#mirror-readonly").hidden = !m;
  if (!m) return void (view.dataset.conv = "");
  if (view.dataset.conv === m.conversation) return;
  view.dataset.conv = m.conversation;
  view.replaceChildren(...m.sections.map((sec) => mirrorSectionNode(sec, agentName())));
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
  $("#log-tools").hidden = thread.entries.length === 0;
  // (#1792: everything the chat has made, to open again, even with the pane closed)
  $("#all-arts-chat").hidden = !thread.artifacts.length;
  const nearEnd = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
  const seen = new Set<string>();
  let prev: HTMLElement | null = null;
  for (const entry of thread.entries) {
    const eid = entry.kind === "user" ? entry.id : entry.turn_id;
    seen.add(eid);
    const key = entry.kind === "user" ? `${entry.mode}|${entry.receipt ?? ""}|${!!entry.settled}` : JSON.stringify([entry.parts, entry.tools, entry.attention, entry.state, entry.error, !!entry.away]);
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
  return withCopy(viewUserNode(e, md), () => userMarkdown(e));
}

function turnNode(thread: Thread, turn: Turn): HTMLElement {
  const node = viewTurnNode(thread, turn, {
    answer: (att, approve, turnId, instance) => answer(thread, att, approve, turnId, instance),
    openArtifact: (id) => { openArtifact = id; renderArtifacts(); },
    md,
  });
  return withCopy(node, async () => turnMarkdown(thread, turn, { agent: agentName(), link: await fileLinks(thread) }));
}

// Copy, as Markdown (decided Nov 19 2026): one message (its Copy, shown on hover), or the whole chat (the header's Copy
// chat), the files the agent wrote as links to them on this site
function withCopy(node: HTMLElement, text: () => string | Promise<string>): HTMLElement {
  const b = document.createElement("button");
  b.className = "copy-msg";
  b.type = "button";
  b.textContent = "Copy";
  b.title = "Copy this message as Markdown";
  b.onclick = () => void copyText(text);
  node.append(b);
  return node;
}
function copyText(text: () => string | Promise<string>, done = "Copied") {
  return Promise.resolve().then(text).then((t) => navigator.clipboard.writeText(t)).then(() => toast(done), () => toast("Couldn't copy"));
}
/** The files the chat's agent wrote: their addresses on this site, where the workspace has them. */
async function fileLinks(thread: Thread): Promise<(path: string) => string | null> {
  const ws = workspace, links = new Map<string, string>();
  if (ws) for (const a of thread.artifacts) if (a.path && !links.has(a.path)) {
    const e = await ws.stat(a.path).catch(() => null);
    const url = e && entryUrl(e);
    if (url) links.set(a.path, new URL(url, location.href).href);
  }
  return (path) => links.get(path) ?? null;
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
  // (its hosts close first: one that can't keep its content keeps the thread; meanwhile the thread is being left, so
  //  an agent's run its pane let go knows it was a switch, not a close (paneRun's `left`))
  leavingThread = from;
  try {
    return (await releaseHosts(from)) && current().id === from;
  } finally {
    leavingThread = null;
  }
}
/** The thread being left while its hosts are let go (mayLeaveThread), else null. */
let leavingThread: string | null = null;

/** Before a pane or thread closes: a running cell is stopped only if the person says so. */
async function mayClosePane(threadId: string | null): Promise<boolean> {
  if (!threadId) return true;
  return mayStopRunning([...hosts].filter(([k, h]) => k.startsWith(threadId + "\u0000") && h.nb?.isRunning()));
}
/** These hosts' running cells stopped, if the person says so (one tab closing, a pane or a thread). */
async function mayStopRunning(busy: [string, Host][]): Promise<boolean> {
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

// #1792: an artifact's tab closed (its ×, or a middle click), its host saved or kept first as when the pane closes: the
// next tab is shown, or the pane closes with the last. The artifact stays in the chat: its card there, the pane's All
// artifacts, or the agent's writing it again bring the tab back.
const closedOf = (t: Thread) => new Set((Array.isArray(t.closed) ? t.closed : []).filter((x): x is string => typeof x === "string"));
function reopenTab(t: Thread, id: string) {
  const c = closedOf(t);
  if (!c.delete(id)) return;
  t.closed = [...c];
  save();
}
// (a second click while one close asks or saves changes nothing: the host's release is shared, each step checks the
//  host is still this one, and a tab closed twice is closed once)
const STOP_WAIT_MS = 5000;
const TAB_COPY = { stillRunning: "A cell is still running in this notebook, so its tab stays open." } as const;
async function closeTab(threadId: string, id: string) {
  if (current().id !== threadId) return;
  const k = hostKey(threadId, id);
  {
    const h = hosts.get(k);
    if (h?.nb?.isRunning()) {
      if (!(await mayStopRunning([[k, h]]))) return;
      // (Stop and close: the interrupt lands, at most a few seconds; a cell still running after that (one started after
      //  the person's answer, say an agent's, or one slow to stop) keeps the tab open, said: nothing is closed under it)
      for (const t = Date.now(); h.nb?.isRunning() && Date.now() - t < STOP_WAIT_MS; ) await new Promise((r) => setTimeout(r, 50));
      // (and a moment more: the notebook counts a cell queued or running as it is drawn, a beat after, so a run asked
      //  for just after the stop is counted before it is judged)
      await new Promise((r) => setTimeout(r, 150));
      if (current().id !== threadId || hosts.get(k) !== h) return;
      if (h.nb?.isRunning()) { toast(TAB_COPY.stillRunning, 6000); return; }
    }
    if (current().id !== threadId || hosts.get(k) !== h) return;
    if (h) {
      // (release freezes a notebook and ends its runs before it awaits anything: no cell starts while it saves)
      const r: Released = h.release ? await h.release().catch((e) => ({ ok: false as const, why: String((e as Error)?.message ?? e) })) : { ok: true };
      if (!r.ok) {
        if (hosts.get(k) !== h) return; // (replaced or gone meanwhile: its refusal has nothing to show on)
        // (it could neither save nor keep a copy: it stays, shown, with its bar, as on the pane's close)
        h.bar = {
          kind: "refused",
          text: r.why,
          actions: [
            { label: "Try again", run: () => void closeTab(threadId, id) },
            ...(h.download?.() ? [{ label: "Download a copy", run: () => saveDownload(h.download!()) }] : []),
            { label: "Close without keeping", run: () => void (async () => { await h.dispose?.(); if (hosts.get(k) === h) hosts.delete(k); h.el.remove(); await closeTab(threadId, id); })() },
          ],
        };
        if (current().id === threadId) { openArtifact = id; renderArtifacts(); }
        return;
      }
      // (another host in its place meanwhile (the artifact opened again): that one stays, and so does its tab)
      if (hosts.has(k) && hosts.get(k) !== h) return;
    }
    // (the keyboard's place, as it is now that the saving is done and before anything is taken away: on the tab shown
    //  next, or the chat's All artifacts once the pane closes, if it was in the pane; elsewhere, it stays put)
    const hadFocus = document.activeElement instanceof HTMLElement && $("#artifacts").contains(document.activeElement);
    if (h) {
      if (hosts.get(k) === h) hosts.delete(k);
      h.el.remove();
    }
    if (current().id !== threadId) return;
    const t = current(), closed = closedOf(t);
    closed.add(id);
    t.closed = [...closed];
    save();
    if (openArtifact === id) {
      const i = t.artifacts.findIndex((x) => x.id === id);
      const next = t.artifacts.slice(i + 1).find((x) => !closed.has(x.id)) ?? t.artifacts.slice(0, Math.max(i, 0)).reverse().find((x) => !closed.has(x.id));
      openArtifact = next?.id ?? null;
      if (!next) fullscreen = false;
    }
    renderArtifacts();
    if (hadFocus) {
      const tab = openArtifact ? document.querySelector<HTMLElement>(`#artifacts [data-tab="${CSS.escape(openArtifact)}"]`) : null;
      const all = $("#all-arts-chat");
      (tab ?? (all.hidden ? null : all))?.focus();
    }
  }
}
/** #1792: everything this chat has produced, closed tabs included: a click opens it (its tab back). */
function artifactBrowser() {
  const t = current(), closed = closedOf(t);
  const dlg = Object.assign(document.createElement("dialog"), { className: "arts-dlg" });
  dlg.setAttribute("aria-labelledby", "arts-dlg-t");
  const h = Object.assign(document.createElement("h3"), { id: "arts-dlg-t", textContent: "Artifacts in this chat" });
  const list = Object.assign(document.createElement("div"), { className: "arts-list" });
  for (const x of t.artifacts) {
    const b = Object.assign(document.createElement("button"), { type: "button", className: "arts-item" + (x.id === openArtifact ? " on" : "") });
    b.dataset.art = x.id;
    b.append(
      Object.assign(document.createElement("span"), { className: "ai", textContent: artifactIcon(x) }),
      Object.assign(document.createElement("span"), { className: "t", textContent: x.title }),
      Object.assign(document.createElement("small"), { textContent: [artifactLabel(x).replace(/&[a-z]+;|&#\d+;/g, ""), closed.has(x.id) ? "closed" : x.id === openArtifact ? "shown" : ""].filter(Boolean).join(" · ") }),
    );
    b.onclick = () => { dlg.close(); if (current().id !== t.id) return; openArtifact = x.id; renderArtifacts(); };
    list.append(b);
  }
  if (!t.artifacts.length) list.append(Object.assign(document.createElement("p"), { textContent: "Nothing yet: what the agent makes, and the files it opens, show here." }));
  const close = Object.assign(document.createElement("button"), { type: "button", textContent: "Close" });
  close.onclick = () => dlg.close();
  const menu = document.createElement("menu");
  menu.append(close);
  dlg.append(h, list, menu);
  dlg.addEventListener("close", () => dlg.remove(), { once: true });
  document.body.append(dlg);
  dlg.showModal();
  (list.querySelector<HTMLElement>(".arts-item.on") ?? list.querySelector<HTMLElement>(".arts-item"))?.focus();
}

function renderArtifacts() {
  const thread = current();
  const pane = $("#artifacts");
  // (a mirrored conversation shown: no pane, not even the hidden chat's)
  const a = mirrorOpen ? undefined : thread.artifacts.find((x) => x.id === openArtifact);
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
  // (shown again: its tab is back, #1792)
  reopenTab(thread, a.id);
  const closed = closedOf(thread);
  // (the tab shown is seen: its "changed" mark goes)
  const seenHost = hosts.get(hostKey(thread.id, a.id));
  if (seenHost) seenHost.changed = false;
  // the head: tabs (a running notebook's name says so, and one the agent changed behind another), copy, full screen, close
  const hk = JSON.stringify([thread.id, thread.artifacts.map((x) => [x.id, x.title, hosts.get(hostKey(thread.id, x.id))?.running ?? false, hosts.get(hostKey(thread.id, x.id))?.changed ?? false, closed.has(x.id)]), a.id, fullscreen]);
  if (hk !== headKey) {
    headKey = hk;
    // (a tab and its ×, #1792: closed ones aren't shown, the one shown always is)
    const tabs = thread.artifacts
      .filter((x) => x.id === a.id || !closed.has(x.id))
      .map((x) => {
        const run = hosts.get(hostKey(thread.id, x.id))?.running;
        const changed = hosts.get(hostKey(thread.id, x.id))?.changed;
        const on = x.id === a.id ? " on" : "";
        return `<span class="tab-wrap${on}"><button class="tab${on}" data-tab="${esc(x.id)}">${artifactIcon(x)} ${esc(x.title)}${run ? ` <span class="tab-running">· running</span>` : ""}${changed ? ` <span class="tab-changed">· changed</span>` : ""}</button><button class="tab-x" type="button" data-close="${esc(x.id)}" title="Close" aria-label="Close ${esc(x.title)}">×</button></span>`;
      })
      .join("");
    // (the control that had the focus has it again after the head is redrawn: a tab, copy, full screen or close, BAC-6)
    const had = document.activeElement instanceof HTMLElement && head.contains(document.activeElement) ? document.activeElement : null;
    const refocus = had ? (had.dataset.tab !== undefined ? `[data-tab="${CSS.escape(had.dataset.tab)}"]` : had.dataset.close !== undefined ? `[data-close="${CSS.escape(had.dataset.close)}"]` : had.id ? `#${had.id}` : null) : null;
    head.innerHTML =
      `<div class="tabs">${tabs}</div>` +
      `<button class="icon" id="all-arts" title="All artifacts in this chat">☰</button>` +
      `<a class="open-full" id="open-main" target="_blank" rel="noopener" hidden title="Open in Sagebrush, in a new tab">Open ↗</a>` +
      `<button class="icon" id="copy" title="Copy">⧉</button>` +
      `<button class="icon" id="full" title="${fullscreen ? "Exit full screen" : "Full screen"}">${fullscreen ? "⤡" : "⤢"}</button>` +
      `<button class="icon" id="close" title="Close">✕</button>`;
    for (const t of head.querySelectorAll<HTMLButtonElement>("[data-tab]")) {
      t.onclick = () => ((openArtifact = t.dataset.tab!), renderArtifacts());
      // (a middle click closes it, as a browser's tab; its mousedown doesn't start the page's autoscroll)
      t.onmousedown = (e) => { if (e.button === 1) e.preventDefault(); };
      t.onauxclick = (e) => { if (e.button === 1) { e.preventDefault(); void closeTab(thread.id, t.dataset.tab!); } };
    }
    for (const x of head.querySelectorAll<HTMLButtonElement>("[data-close]")) x.onclick = () => void closeTab(thread.id, x.dataset.close!);
    $("#all-arts", head).onclick = () => artifactBrowser();
    // (Open: the artifact's file on its own page in Sagebrush, as the File menu opens it (web/workspace/entry-url.ts), in a
    //  new tab, so this page and its agent stay; found by the file's id when the head is drawn, and none for a file
    //  with no page of its own, #1614)
    const open = $<HTMLAnchorElement>("#open-main", head);
    if (a.path && workspace)
      void workspace.stat(a.path).then((e) => {
        const url = e && entryUrl(e);
        if (url && open.isConnected) {
          Object.assign(open, { href: url, hidden: false });
          open.setAttribute("aria-label", `Open ${a.title} in Sagebrush (a new tab)`);
        }
      }, () => {});
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
    h.el.innerHTML = `<div class="file-path">${esc(a.path)} <span class="saved"></span> </div><div class="file-body"></div>`;
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
  // (a board the agent made: said as what the agent did, with Open, a link to the board page in a tab of its own, so
  //  the person's click opens it as any link (where its code runs), and View source for its JSON)
  if (a.kind === "board" && a.path && workspace) {
    const ws = workspace, path = a.path, name = path.split("/").pop()!;
    // (built as elements, its words as text: nothing of the agent's name or the file's is read as markup)
    const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text = "") => Object.assign(document.createElement(tag), { className: cls, textContent: text });
    const who = el("span", "who", `${agentName()} made `), b = el("b", "", name);
    who.append(b);
    const open = el("a", "open-board", "Open"), view = el("button", "view-source", "View source"), src = el("pre", "code board-source");
    open.target = "_blank"; open.rel = "noopener"; open.setAttribute("aria-disabled", "true");
    view.type = "button"; src.hidden = true;
    const row = el("div", "board-made");
    row.append(who, open, view);
    h.el.replaceChildren(row, src);
    // (its address is its id, read from the workspace: a board it can't find there (removed, or not a board now, or the
    //  lookup failed) says so, with no Open)
    void ws.stat(path).catch(() => undefined).then((e) => {
      if (e?.kind === "board" && e.ref) {
        open.href = "/board/?doc=local:" + encodeURIComponent(e.ref);
        open.removeAttribute("aria-disabled");
      } else open.replaceWith(Object.assign(document.createElement("span"), { className: "gone", textContent: "Couldn't find this board in your files." }));
    });
    view.onclick = () => {
      if (!src.hidden) { src.hidden = true; view.textContent = "View source"; return; }
      void ws.read(path).then((r) => { src.textContent = JSON.stringify(r.content, null, 2); src.hidden = false; view.textContent = "Hide source"; }, (e) => toast(`Couldn't read ${name}: ${String(e?.message ?? e)}`, 6000));
    };
    // (Copy: the board's JSON, read now, as View source shows it; what View source shows if that read failed)
    let json: string | null = null;
    void ws.read(path).then((r) => { json = JSON.stringify(r.content, null, 2); }, () => {});
    h.copy = () => json ?? src.textContent ?? "";
    keepFocus();
    return;
  }
  // (a .space.json, where this build and host offer the 3D view: the viewer in a frame, following the file as the agent
  //  writes it, and the person's selection written back to it; web/workspace/space3d.ts's mountSpace)
  if (__SB_SPACE__ && a.path && workspace && __SB_SPACE_HOSTS__.includes(location.hostname) && /\.space\.json$/i.test(a.path)) {
    const ws = workspace, path = a.path;
    let m: SpaceHost | null = null, gone = false;
    h.copy = () => m?.copy() ?? "";
    h.dispose = async () => { gone = true; await m?.dispose(); };
    void (import(new URL("../sagebrush-space3d.js", import.meta.url).href) as Promise<typeof import("../workspace/space3d")>).then(
      (mod) => { if (!gone) m = mod.mountSpace(ws, path, h.el); },
      (e) => { if (!gone) h.el.replaceChildren(`Couldn't load the 3D view: ${String(e?.message ?? e)}`); });
    keepFocus();
    return;
  }
  // (a .tex, where this host serves the LaTeX editor's page (the build's hosts, as web/latex/boot.ts's latexOn): that
  //  page in a frame, embedded (web/latex page.ts's embed): Run, the PDF, comments and its leave guard, as on the LaTeX
  //  page; mountTexFrame. Elsewhere (the CLI's page) the editor itself, in mountFile)
  if (a.path && workspace && __SB_LATEX__ && __SB_LATEX_HOSTS__.includes(location.hostname) && /\.tex$/i.test(a.path)) {
    const head = document.createElement("div"), body = document.createElement("div");
    head.className = "file-path";
    head.append(a.path);
    body.className = "file-body";
    h.el.replaceChildren(head, body);
    const f = mountTexFrame(a.path, body);
    h.copy = f.text;
    h.flush = f.flush;
    h.release = f.release;
    h.dispose = f.dispose;
    h.download = f.download;
    keepFocus();
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
// (a code or text file's colours, as the code page's (web/code/tokens.ts): up to this many characters; plain above)
const FILE_COLOR_MAX = 256 * 1024;
function mountFile(a: Artifact, box: HTMLElement, saved: HTMLElement): FileHost {
  const path = a.path!;
  // (✎ Edit / View, before the status: shown for a code or text file, below)
  const toggle = Object.assign(document.createElement("button"), { type: "button", className: "mode-toggle", hidden: true });
  saved.before(toggle);
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
      if (!open || stopped || rev < 0) return;
      // (nothing new to write: said as saved once the text shown is the file's, so no "Saving…" stays, #1617)
      if (value === savedText) return void (latest() === savedText && guard === "open" && say("Saved"));
      try {
        const r = await workspace!.write(path, value, { base: rev, ...(fid ? { fid } : {}), admit });
        rev = r.rev;
        savedText = value;
        if (guard === "open") say(latest() === value ? "Saved" : "Saving…");
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
    // (not over why a write failed (nothing more is written from here), nor over Closing…)
    if (!stopped && guard === "open") say("Saving…");
    clearTimeout(timer);
    timer = window.setTimeout(() => void write(), 700);
  };
  say("Loading…");
  const tex = /\.tex$/i.test(path);
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
        // (code and text: in colour by its language, read only, with ✎ Edit to write in it here, the colours behind the
        //  text as it is typed; opened as the person last left this file, View by default, as the code page opens it
        //  (web/doc-mode.ts), #1618)
        const lang = langOf(path) ?? blockLang(text, /\.([^./]+)$/.exec(path)?.[1] ?? "");
        const paint = (el: HTMLElement, t: string) => (t.length <= FILE_COLOR_MAX ? drawTokens(el, tokensOf(t, lang)) : (el.textContent = t));
        const key = fid ? modeKey("file", fid) : null;
        let mode: DocMode = key ? modeOf(key) : "view";
        const view = Object.assign(document.createElement("pre"), { className: "code code-view" });
        const wrap = Object.assign(document.createElement("div"), { className: "code-wrap" });
        const hl = Object.assign(document.createElement("pre"), { className: "code code-hl" });
        hl.setAttribute("aria-hidden", "true");
        const ta = Object.assign(document.createElement("textarea"), { className: "code-edit", spellcheck: false, wrap: "off" });
        ta.setAttribute("aria-label", path);
        wrap.append(hl, ta);
        // (the colours end where the field's text does, short of its scrollbars, and scroll with it)
        const fit = () => {
          hl.style.right = `${ta.offsetWidth - ta.clientWidth}px`;
          hl.style.bottom = `${ta.offsetHeight - ta.clientHeight}px`;
          hl.scrollTop = ta.scrollTop;
          hl.scrollLeft = ta.scrollLeft;
        };
        ta.oninput = () => {
          paint(hl, ta.value + "\n");
          fit();
          changed(ta.value);
        };
        ta.onscroll = fit;
        // (and again when the field's size changes: a tab shown, full screen, the window)
        const resized = new ResizeObserver(fit);
        resized.observe(ta);
        // (let go with the editor, when the pane lets this file go)
        destroyEditor = () => resized.disconnect();
        const show = () => {
          // (its label says what it does: no aria-pressed beside it, which would say the opposite)
          toggle.textContent = mode === "edit" ? "View" : "✎ Edit";
          toggle.title = mode === "edit" ? "Back to reading it" : "Edit it here (saved as you type)";
          if (mode === "edit") {
            ta.value = text;
            paint(hl, text + "\n");
            box.replaceChildren(wrap);
            fit();
          } else {
            paint(view, text);
            box.replaceChildren(view);
          }
        };
        toggle.hidden = false;
        toggle.onclick = () => {
          // (not while the pane closes: its text is frozen then)
          if (guard !== "open") return;
          mode = mode === "edit" ? "view" : "edit";
          if (key) rememberMode(key, mode);
          show();
          if (mode === "edit") ta.focus();
        };
        latest = () => (mode === "edit" ? ta.value : text);
        show();
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

// A .tex in the pane: the LaTeX editor's own page, /?tex=<fid>&latex=1&embed=1, in a frame of this site (its page's
// frame-ancestors 'self'): no header, Agent or pairing of its own there, the document alone by default. Made only when
// its tab is opened (mountHost), dropped with it. The pane asks it before closing, {t: "may-close", id}, and the
// editor's leave guard answers, its edit written or the person asked ({t: "may-close", id, ok}); only from that frame,
// of this very origin. The file is the editor's to write: nothing here writes it.
const TEX_CLOSE_MS = 30_000;
function mountTexFrame(path: string, box: HTMLElement): FileHost {
  let alive = true;
  let frame: HTMLIFrameElement | null = null;
  let text = "";
  const host = document.createElement("div");
  host.className = "tex-host";
  box.append(host);
  void workspace!.stat(path).then(
    (e) => {
      if (!alive) return;
      if (!e || e.kind !== "file" || !e.fid) return void (host.textContent = "(not in this browser's workspace)");
      frame = document.createElement("iframe");
      frame.className = "tex-frame";
      frame.title = path.split("/").pop()!;
      frame.style.cssText = "display:block;width:100%;height:100%;border:0;background:#fff";
      frame.src = "/?tex=" + encodeURIComponent(e.fid) + "&latex=1&embed=1";
      host.append(frame);
    },
    () => alive && (host.textContent = "(not in this browser's workspace)"),
  );
  // (Copy: the file as read at open; the editor in the frame has the latest)
  void workspace!.read(path).then((r) => { if (typeof r.content === "string") text = r.content; else if (r.content instanceof Uint8Array) text = new TextDecoder().decode(r.content); }, () => {});
  const mayClose = (): Promise<boolean> => new Promise((done) => {
    const w = frame?.contentWindow;
    // (no editor in the frame yet: nothing typed there to keep)
    if (!w || !frame?.contentDocument?.querySelector(".tex-page .tex-main")) return done(true);
    const id = crypto.randomUUID();
    const t = setTimeout(() => { removeEventListener("message", on); done(false); }, TEX_CLOSE_MS);
    const on = (e: MessageEvent) => {
      if (e.source !== w || e.origin !== location.origin || e.data?.t !== "may-close" || e.data.id !== id) return;
      clearTimeout(t);
      removeEventListener("message", on);
      done(e.data.ok === true);
    };
    addEventListener("message", on);
    w.postMessage({ t: "may-close", id }, location.origin);
  });
  const dispose = async () => {
    alive = false;
    frame?.remove();
    frame = null;
  };
  let releasing: Promise<Released> | null = null;
  return {
    text: () => (frame?.contentDocument?.querySelector<HTMLTextAreaElement>(".tex-src")?.value ?? text),
    flush: async () => {},
    release: () => (releasing ??= mayClose().then(async (ok): Promise<Released> => {
      if (!ok) return { ok: false, why: `${path}: the LaTeX editor didn't confirm it could close (its last edit isn't written yet, you chose to stay, or it didn't answer within 30 seconds).` };
      await dispose();
      return { ok: true };
    }).finally(() => (releasing = null))),
    dispose,
    download: () => null,
  };
}

function renderComposer() {
  showDraft();
  renderComposerState(isRunning(current()), queues.get(current().id)?.length ?? 0, session.isAway(current()), session.canSteer(current()));
  renderConn();
}

// ---------------------------------------------------------------------------
// The connection (A14): a reload reconnects; a lost connection is never silent; a chat Claude was in never falls back
// to the scripted demo.

// (the no-demo marker: a real agent was in this chat. It holds no credential; it is kept with the chats)
const marked = (t: Thread) => session.marked(t);
// (connected on this page, or a reload record found: a chat made since isn't the demo's either)
let connectedHere = false;
// (another Agents tab of this browser has the agent, as it answers "live": this one isn't the demo meanwhile, #1688)
let otherTabLive = false;
const mayDemo = (t: Thread) => !marked(t) && !connectedHere && !otherTabLive;
const inert = (t: Thread) => !live() && !mayDemo(t);

type ConnBar = { kind: keyof typeof CONN | "runner"; text?: string; alert: boolean; action: "reconnect" | "connect" | "here" | null };
const connText = (b: ConnBar) => b.text ?? (b.kind === "runner" ? "" : CONN[b.kind]);
// (an agent on one of your computers: the words, word for word as reviewed)
const NOT_SENT = {
  full: (agent: string) => `Too many messages are waiting to go to ${agent}. Send this one again in a moment.`,
  over: "This message is over this connection's limit of about 4 MB, so it wasn't sent.",
};
const RUNNER = {
  connecting: (computer: string) => `Connecting to ${computer}…`,
  waiting: (computer: string) => `Waiting for ${computer} to connect…`,
  unreachable: (computer: string) => `Couldn't connect to ${computer}. If its runner isn't running, start sagebrush remote --serve-agents on it, then choose Chat here again.`,
  lost: (computer: string, why: string) => `Not connected to ${computer}${why ? `: ${why}` : ""}. Choose Chat here to connect again.`,
  disconnected: (computer: string) => `Disconnected. The agent on ${computer} may keep running for up to 5 minutes.`,
};
/** The bar after a leg to `computer` ended: the person's Disconnect (only its own line, never the runner's "The agent
 * stopped" after it), the runner's own words (agent.ended, a refused hello), or the lost line with why. */
function runnerBar(computer: string, e: LegEnd | { kind: string; why: string }): ConnBar {
  if (e.kind === "disconnected") return { kind: "runner", text: RUNNER.disconnected(computer), alert: false, action: "connect" };
  if ((e.kind === "ended" || e.kind === "refused") && e.why) return { kind: "runner", text: e.why, alert: true, action: "connect" };
  if (e.kind === "unreachable") return { kind: "runner", text: RUNNER.unreachable(computer), alert: true, action: "connect" };
  return { kind: "runner", text: RUNNER.lost(computer, e.why), alert: true, action: "connect" };
}
// (an attempt to one of your computers, between Chat here and its agent.ready: the header's "Connecting to …")
let connectingTo: string | null = null;
let waitingFor = false; // (its runner not connected yet: the header says it waits)
// (another Agents tab of this browser has the agent: the agent serves one page at a time, so this one can't connect while
//  that one is; and it prints a new link only once that page goes: #1550)
const OTHER_TAB = "Claude is connected in another tab of this browser. Use that tab, or close it and Connect here with the new link sagebrush-agent prints.";
const CONN = {
  lost: "Claude disconnected. Your chats are kept; Claude keeps their context while sagebrush-agent runs.",
  restoring: "Reconnecting to Claude…",
  unreachable: "Couldn't connect to sagebrush-agent on this computer. It may have stopped, this browser may need permission to reach it, or another page may be connected to it.",
  refused: "sagebrush-agent didn't accept this page's last connection, so it needs a new code. If sagebrush-agent was restarted, Claude's earlier context for these chats is gone; your chats are still here.",
  expired: "Claude's access expired.",
  discarded: "Claude's earlier connection was for another page or workspace, so it needs a new code.",
  unusable: "This page's earlier connection to Claude couldn't be used, so it needs a new code.",
  kept: "Claude was connected to this page earlier.",
  elsewhere: "Claude is connected to another page. Use that page, or close it and Reconnect here.",
  otherTab: OTHER_TAB,
  // ("Use Claude here", #1550: the tab that let go says only that it was asked, never that another tab connected: the
  //  channel proves no such thing; and the tab that asked, when its attempt didn't connect)
  released: "This tab let go of Claude because another tab of this browser asked for it. Your chats here are kept.",
  notHere: "Claude couldn't be connected here with your remembered access. Your chats and draft are kept; try again, or Connect with a new link.",
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
    setText(btn, mine ? (action === "here" ? "Connecting…" : "Reconnecting…") : action === "connect" ? "Connect" : action === "here" ? "Use Claude here" : "Reconnect");
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
  const send = $("#send"), off = !session.canSend(current());
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
  if (connBar?.action === "here") return useHere(btn);
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
/** "Use Claude here" (#1550; SEC move-connection r1 option A): only on the person's click, both conditions asked
 * again first (another tab's connection is local and remembered; a remembered grant in force here); then the other tab
 * asked to let go, and this one connected with the remembered access as "Use remembered access" does: its grant
 * exactly, no new Allow, waiting a bounded while for the other tab's socket to close. Nothing is said connected
 * until it is; a failure leaves the chats and the draft as they are and says so. */
async function useHere(btn: HTMLElement) {
  if (!agentUi) return;
  reconnecting = true;
  busyBtn = btn;
  renderConn();
  let asked = false, g: Kept["grant"] | null = null;
  try {
    // (asked again at the click: either gone meanwhile, nothing is sent and the bar is drawn again from what is true now)
    if ((await agentUi.remembered()) && (await agentsTabRemembered())) {
      asked = true;
      releaseAgentsTab();
      g = await agentUi.useRemembered().catch(() => null);
    }
  } finally {
    reconnecting = false;
    busyBtn = null;
  }
  if (g) {
    setText($("#who-status"), `connected with remembered access: ${grantScope(g)}`);
    setConn(null);
  } else if (live()) setConn(null);
  else if (!asked) await checkOtherTab();
  else setConn({ kind: "notHere", alert: true, action: "connect" });
  renderHeader();
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

const editor = mountComposer({
  submit,
  stop: () => interrupt(current()),
  render: md,
  typeset: (el) => typeset(el),
  changed: (v) => { if (draftOf) putDraft(draftOf, v); },
});
// (dictation into the draft, #1791: a mic by Send where the browser turns speech into text)
const dictation = mountDictation({
  before: $("#send"),
  conversation: () => draftOf || current().id,
  // (the words heard, at the end of the draft of the chat they were spoken for: the composer's if it is shown)
  append: (conv, text) => {
    const join = (a: string) => (!a ? text : /\s$/.test(a) ? a + text : a + " " + text);
    if ((draftOf || current().id) === conv) {
      editor.value = join(editor.value);
      putDraft(conv, editor.value);
    } else putDraft(conv, join(draftsPending.get(conv) ?? readDrafts()[conv] ?? ""), true);
  },
  toast: (t, ms) => toast(t, ms),
});
/** The chat shown's draft in the composer, when another chat's was there. */
function showDraft() {
  const id = current().id;
  if (draftOf === null || draftOf === id) return;
  dictation.finish(); // (dictating belongs to the chat it started in: it stops, its words in that chat's draft)
  draftOf = id;
  editor.value = draftsPending.get(id) ?? readDrafts()[id] ?? "";
}
// (the chat shown's draft at once, as the composer comes up: the page's first render waits for the workspace, and by
//  then the person may have typed)
draftOf = "";
showDraft();
// (an image pasted or dropped into the composer: saved in its chat's folder, its path added to that chat's draft)
mountAttach({
  composer: $(".composer"),
  conversation: () => draftOf || current().id,
  create: (path, bytes) => (workspace ? workspace.createByPerson(path, { content: bytes }) : Promise.reject(new Error("this browser's workspace isn't open"))),
  append(conv, line) {
    // (what is there kept as it is, every space of it; the line after a blank line)
    const join = (v: string) => (v ? v + (v.endsWith("\n\n") ? "" : v.endsWith("\n") ? "\n" : "\n\n") : "") + line;
    if (draftOf === conv) { editor.value = join(editor.value); putDraft(conv, editor.value, true); }
    else putDraft(conv, join(draftsPending.get(conv) ?? readDrafts()[conv] ?? ""), true);
  },
  agent: () => (live() && pairing?.grant ? { name: agentName(), reads: (p) => inGrant(p, pairing!.grant!.folders) } : null),
  toast: (t) => toast(t, 6000),
});
// (Delegate, for an agent on this computer that offers it: delegate.ts's tasks, drawn by delegate-ui.ts)
const delegateTasks = new DelegateTasks({ changed: () => delegateUi?.render() });
const delegateUi = mountDelegate({
  tasks: delegateTasks,
  agent: agentName,
  mayRun: () => pairing?.grant?.run === true,
  openPath: () => current().artifacts.find((x) => x.id === openArtifact)?.path ?? null,
  draft: () => editor.value,
  // (the Pair chat shown, once something has been said in it: a brief is drafted from it, the agent saying if it can't)
  conversation: () => { const t = current(); return t.entries.some((e) => e.kind === "turn" || e.kind === "user") ? t.id : null; },
  clearDraft: () => { editor.value = ""; putDraft(draftOf || current().id, "", true); },
  // (a workspace document as the task's copy starts from it: a notebook's .ipynb text, a text file's text; its path as
  //  the protocol has it, relative)
  async readDoc(path) {
    if (!workspace) throw new Error("this browser's workspace isn't open");
    const r = await workspace.read("/" + path);
    if (/\.ipynb$/i.test(path)) return { path, kind: "notebook", content: toIpynb(r.content) };
    if (typeof r.content === "string") return { path, kind: "file", content: r.content };
    if (r.content instanceof Uint8Array) return { path, kind: "file", content: new TextDecoder("utf-8", { fatal: true }).decode(r.content) };
    throw new Error(`${path} isn't a notebook or a text file`);
  },
  // (a task's turns are the paired agent's, on this computer: never shown as the scripted demo's)
  turnNode: (thread, turn) => viewTurnNode(thread, { ...turn, agent: turn.agent ?? agentName() }, { answer: () => {}, openArtifact: () => {}, md }),
  // (a task shown takes the main pane from a mirrored conversation too: the mirror closes, as when a thread is opened)
  shown: (on) => {
    document.body.classList.toggle("task-shown", on);
    if (on && mirrorOpen) { closeMirror(); renderAll(); }
    if (!on) renderAll();
  },
  site: new URL("../", import.meta.url),
  // (a proposal's .tex rendered under its diff, where this page has the LaTeX editor, as an artifact's .tex is)
  latex: __SB_LATEX__ && __SB_LATEX_HOSTS__.includes(location.hostname) ? () => import(/* @vite-ignore */ LATEX_URL) : null,
  // (a proposal's .md rendered under its diff with this page's own Markdown renderer, the chat's: safe HTML, remote
  //  pictures click-to-load)
  markdown: md,
  toast,
  // (Merge: this browser's workspace, and the agent's record of it)
  merge: workspaceIO(() => workspace, (task, params) => delegateTasks.merged(task, params), /^(localhost|127\.0\.0\.1)$/.test(location.hostname) ? async (op, path) => { if (typeof (window as any).__mergeSeam === "function") await (window as any).__mergeSeam(op, path); } : undefined),
  session: sessionStorage,
});
// (the Files | Agents switch at the right of the chat list's header, Agents pressed: Files opens the notebook page with
//  its files, as the file panel's switch opens this page; William, Nov 12)
{ const sw = modeSwitch("agents"), brand = document.querySelector<HTMLElement>("nav.side .brand"); sw.style.marginLeft = "auto"; if (brand) { brand.style.whiteSpace = "nowrap"; brand.append(sw); } const f = sw.querySelector<HTMLButtonElement>('[data-mode="files"]'); if (f) f.onclick = () => void toFiles(); }
// (to the files: the notebook page with its file browser shown, in this tab: coming back reconnects the agent by itself
//  while its grant lasts (#1620, agent-pair.ts reloadDecision).  Only while an agent's turn runs here, in a new tab, so
//  the turn's work in this page goes on; that tab is named so its way back to Agents returns here (mode-switch.ts
//  backToAgentsTab) rather than opening a second Agents page the agent would refuse.  Else the thread is left as New
//  chat leaves it (mayLeaveThread): its files' pending edits saved, a running cell stopped only if the person says so;
//  refused, this page stays and nothing is changed.  Admitted, the browser's own choice to show the files is set, then
//  the page left)
let leaving = false;
async function toFiles() {
  if (pairing && pairing.state !== "closed" && state.threads.some((t) => isRunning(t))) {
    try { localStorage.setItem("sagebrush-files-sidebar", "1"); } catch {}
    // (opened in the click itself, so the browser allows it; refused anyway, this page stays and says so)
    const w = window.open("/", "_blank");
    if (w) { w.name = FILES_TAB; w.opener = null; }
    else toast("Your browser blocked the new tab for Files. Allow pop-ups for this site, or open it in a new tab yourself.", 6000);
    return;
  }
  if (leaving) return;
  leaving = true;
  try {
    if (!(await mayLeaveThread())) return;
    try { localStorage.setItem("sagebrush-files-sidebar", "1"); } catch {}
    location.assign("/");
  } finally {
    leaving = false;
  }
}
// (Files…, at the foot of the chat list; and the switch's own Files, through the same way out)
$("#files-big").prepend(filesIcon());
$("#files-big").onclick = () => void toFiles();
$("#new").onclick = async () => {
  if (delegateUi.showing() !== null) delegateUi.close();
  // (from a mirrored conversation: nothing of this browser's to leave; it closes)
  if (!mirrorOpen && !(await mayLeaveThread())) return;
  closeMirror();
  session.newThread();
  openArtifact = null;
  renderAll();
  editor.focus();
  document.body.classList.remove("nav-open");
};
// (the chat list's toggle, in its header and, while it is hidden, at the left of the top bar: hidden is remembered, as the
//  files' are on the other pages; where the window is narrow the list is an overlay, opened and closed as before)
{
  const SIDE_KEY = "sagebrush-agents-side-hidden", mac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  const hidden = () => document.body.classList.contains("side-hidden");
  const set = (h: boolean) => { document.body.classList.toggle("side-hidden", h); try { localStorage.setItem(SIDE_KEY, h ? "1" : ""); } catch {} };
  for (const b of [$("#sidetoggle"), $("#menu")]) {
    b.replaceChildren(panelIcon());
    b.setAttribute("aria-label", "Chats");
    b.title = `Show or hide the chats (${mac ? "⌘B" : "Ctrl+B"})`;
  }
  try { if (localStorage.getItem(SIDE_KEY) === "1") document.body.classList.add("side-hidden"); } catch {}
  $("#sidetoggle").onclick = () => { if (document.body.classList.contains("nav-open")) document.body.classList.remove("nav-open"); else set(true); };
  $("#menu").onclick = () => { if (hidden()) set(false); else document.body.classList.toggle("nav-open"); };
  addEventListener("keydown", (ev) => {
    if (ev.defaultPrevented || ev.altKey || ev.shiftKey || !(ev.ctrlKey || ev.metaKey) || ev.key.toLowerCase() !== "b") return;
    if ((ev.target as HTMLElement | null)?.closest?.("[contenteditable=''],[contenteditable='true']")) return;
    ev.preventDefault();
    set(!hidden());
  });
}
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
  } else if (e.key === "Escape" && !mirrorOpen && isRunning(current()) && !editor.field) {
    // (never while a mirrored conversation is shown over the chat: Escape there stops nothing of the hidden chat's)
    interrupt(current());
  }
});

// (a turn that was running when the page closed can't go on: it ends interrupted)
session.endInterrupted();
// (A14: a reload record of this page waiting for its restore says this page was connected: no demo, even before the
// workspace is open and the restore decided; only its page is read here (another page's record, left in the tab for that
// page, A5, says nothing about this one))
try {
  const raw = sessionStorage.getItem(RELOAD_KEY);
  let page: unknown = null;
  try { page = raw === null ? null : JSON.parse(raw)?.page ?? null; } catch {}
  if (raw !== null && (typeof page !== "string" || page === location.origin + location.pathname)) connectedHere = true;
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
  $("#review").hidden = true;
  if (workspace) { stopReviewButton?.(); stopReviewButton = showWhenBranches(workspace, $("#review")); }
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
async function editNotebook(e: NotebookEdit, may: () => boolean, hold?: () => Promise<() => void>, from?: string): Promise<unknown> {
  const thread = state.threads.find((t) => t.id === e.conversation);
  if (!thread) throw new AgentError("invalid", "no such chat on this page");
  const turn = runningTurn(thread);
  if (!turn) throw new AgentError("busy", "this chat has no turn running: an edit comes from a turn");
  // (edit.turn: the turn the edit says it came from must be the running one, else nothing changes: a late edit of a
  //  turn that ended never lands in the next turn's notebook)
  if (from !== undefined && from !== turn.turn_id) throw new AgentError("busy", "the turn this edit came from is no longer running in this chat: nothing changed");
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
  if (!thread.artifacts.some((a) => a.id === e.path && a.kind === "notebook")) session.emit(thread, turnId, { type: "artifact", id: e.path, kind: "notebook", title: e.path.split("/").pop()!, path: e.path, body: "edited by cell" });
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
// An agent's run_notebook here (run-verbs.ts's inPage, as the notebook page's agentPageRun, decided Nov 18 2026): in its
// chat's pane, the notebook opened there first as an edit opens it (shown, or mounted behind the artifact the person
// is in), then run in that notebook cell by cell, its outputs shown and saved with it. Only for the chat shown with a
// turn running (an agent's call comes from a turn); else null and nothing started: today's run instead.
function paneRun(ref: string, path: string, gone: () => void, from?: { conversation: string; turnId: string }): PageRun | null {
  // (bound as an edit is: the chat the call came from, shown, and its turn still the running one, here and at every
  //  check of the run after (its cells, its save); a call that doesn't say them (an agent without run.context), any
  //  other chat's call or a turn's that has ended: today's run)
  if (!from) return null;
  const thread = state.threads.find((t) => t.id === from.conversation);
  if (!workspace || !thread || thread.id !== current().id || runningTurn(thread)?.turn_id !== from.turnId) return null;
  const turnId = from.turnId;
  const mine = () => current().id === thread.id && runningTurn(thread)?.turn_id === turnId;
  // (the person went to another chat, the call's turn still running: before any cell, today's run, not a stop)
  const left = () => (current().id !== thread.id || leavingThread === thread.id) && runningTurn(thread)?.turn_id === turnId;
  // (a pane that can't run it, known now: today's run, and nothing added or shown)
  if (hosts.get(hostKey(thread.id, path))?.nb?.canRun(ref) === false) return null;
  const shownOther = document.body.classList.contains("has-artifact") && openArtifact !== null && openArtifact !== path;
  const keep = openArtifact;
  if (!thread.artifacts.some((a) => a.id === path && a.kind === "notebook")) session.emit(thread, turnId, { type: "artifact", id: path, kind: "notebook", title: path.split("/").pop()!, path, body: "run by the agent" });
  const art = thread.artifacts.find((a) => a.id === path && a.kind === "notebook");
  if (!art) return null;
  // (the artifact just added doesn't take the pane from the one the person is in: it stays, this one behind it)
  if (shownOther) {
    openArtifact = keep;
    hiddenHost(thread.id, art);
  }
  else {
    openArtifact = path;
    renderArtifacts();
  }
  const h = hosts.get(hostKey(thread.id, path));
  if (!h?.nb) return null;
  // (behind another tab: its tab says it changed, until it is shown)
  if (shownHost() !== h) {
    h.changed = true;
    headKey = "";
    renderArtifacts();
  }
  const pr = h.nb.pageRun(ref, path, gone, mine, left);
  // (tests only, on a loopback page: the run held at "mount", before the pane's notebook is read)
  const hold = /^(localhost|127\.0\.0\.1)$/.test(location.hostname) && typeof (window as any).__runHold === "function" ? (window as any).__runHold : null;
  return hold ? { ...pr, inputs: async () => { await hold("mount"); return pr.inputs(); } } : pr;
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

// (Chat here's section of the Connect dialog: your computers; its attempts adopt their pairing into agentUi)
const chatHereSection = chatHere({
  list: () => listComputers(),
  async open(r) {
    const leg = new AgentLeg({ remoteId: r.remote_id, url: pageLegUrl(r.remote_id, "agent"), key: await legKey() }).start();
    const ended = await new Promise<LegEnd | null>((res) => { leg.on("open", () => res(null)); leg.on("end", (e) => res(e)); });
    // (the runner's notices: its words, as they are)
    leg.on("notice", (t) => toast(t, 6000));
    return { link: leg, ended };
  },
  onConnecting(r) { connectingTo = r.name; waitingFor = false; setConn(null); renderHeader(); },
  onWaiting(r) { connectingTo = r.name; waitingFor = true; renderHeader(); },
  onFailed(r, e) { connectingTo = null; waitingFor = false; setConn(runnerBar(r.name, e)); renderHeader(); },
  remove: (r) => removeComputer(r.remote_id),
}, () => agentUi);

// A notebook the agent created (the pairing's onCreated): taken at once, as it is created, into the pane of the chat
// whose turn made it (its artifact), then run there once by itself under the notebook page's rule
// (workspace/agent-made.ts): the pairing that created it, its grant still in force with May run code and Everything,
// still as created, and shown when the run is admitted. The turn may end meanwhile (a create as an agent's last step):
// what is asked of it is only that it made the notebook, at creation.
type MadeAt = { thread: string } | null;
// (the person in another artifact: the one shown is the one they last used in the pane (focused, pointed at, typed in);
//  an artifact of the agent's own left shown, untouched, is no reason to keep the pane there)
let personIn: string | null = null;
for (const t of ["focusin", "pointerdown", "keydown", "input"]) $("#artifacts").addEventListener(t, () => { personIn = openArtifact; }, true);
const paneShowsOther = (path: string) => document.body.classList.contains("has-artifact") && openArtifact !== null && openArtifact !== path
  && (personIn === openArtifact || (!!document.activeElement && $("#artifacts").contains(document.activeElement)));
function madeAt(c: Created, p: { mayRunCreated(c: Created): boolean }): MadeAt {
  // (only a notebook that may run by itself is taken into the pane here; any other is the agent's own to show)
  if (!p.mayRunCreated(c)) return null;
  const thread = current();
  const turn = runningTurn(thread);
  // (a chat that isn't the one shown, or no turn running: no pane to open it in, so it isn't run; the person in another
  //  artifact: the pane stays there (board's BA12-1), so it isn't shown, nor run)
  if (!turn || !workspace || paneShowsOther(c.path)) return null;
  if (!thread.artifacts.some((a) => a.id === c.path && a.kind === "notebook")) session.emit(thread, turn.turn_id, { type: "artifact", id: c.path, kind: "notebook", title: c.path.split("/").pop()!, path: c.path, body: "notebook" });
  // (shown now, at its creation, as the agent's own artifact shows it; nothing later switches the pane to it)
  openArtifact = c.path;
  renderArtifacts();
  return { thread: thread.id };
}
const agentMade = createdRunner<MadeAt>({
  read: (path) => (workspace ? workspace.read(path) : Promise.resolve(null)),
  async open(c, at) {
    // (still the chat it was made in, and still the artifact shown: the pane moved since (the person, or the agent's next
    //  artifact) is never moved back)
    if (!at || current().id !== at.thread || openArtifact !== c.path) return false;
    const h = hosts.get(hostKey(at.thread, c.path));
    if (!h?.nb) return false;
    await h.nb.ready;
    return true;
  },
  runIfShown: (ref, ok) => !!shownHost()?.nb?.runCreated(ref, ok),
  // (the tests' hold, loopback pages only: between the open and the admission, test-agents-artifacts.mjs)
  ...(/^(127\.0\.0\.1|localhost)$/.test(location.hostname) ? { holdRun: (path: string) => (typeof (window as any).__agentRunHold === "function" ? (window as any).__agentRunHold(path) : undefined) } : {}),
});

// (an agent's runs of code here, as on the notebook page (workspace/agent-runs.ts): latex_build, run_notebook, run_file
//  and run_stop under the grant, in the sandboxed runner only, which this page has where it is cross-origin isolated;
//  the interpreter's classes come with the run's chunk, from the notebook's module)
const runsSite = new URL("../", import.meta.url).href;
const agentRuns = (ws: Workspace) => agentRunsFor(ws as any, {
  site: runsSite,
  kernels: () => import(/* @vite-ignore */ new URL("sagebrush-notebook.js", runsSite).href),
  sandbox: globalThis.crossOriginIsolated === true && !!globalThis.navigator && !(window as any).__TAURI__ && !(window as any).__SAGEBRUSH_LOCAL__ ? "ok" : "none",
  perms: createPermissions(),
  chunks: { run: "sagebrush-agent-run.js", ...(__SB_LATEX__ ? { latex: ["sagebrush-latex.js", "sagebrush-latex-tools.js", "sagebrush-latex-run.js"] as [string, string, string] } : {}) },
  // (run_notebook in the pane's notebook: paneRun)
  more: () => ({ inPage: paneRun, ...(/^(localhost|127\.0\.0\.1)$/.test(location.hostname) && typeof (window as any).__runHold === "function" ? { hold: (st: string) => (window as any).__runHold(st) } : {}) }),
});

// (the current pairing's listener for the agent's messages, removed when another pairing replaces it)
let offAgent: (() => void) | null = null;
function mountPairing(ws: Workspace) {
  // (Delegate's last task list, kept in this browser for this workspace: shown while the agent isn't connected, #1622)
  let kept: Storage | null = null;
  try { kept = localStorage; } catch { kept = null; }
  delegateTasks.keepIn(kept, `sb-delegate-tasks-v1:${ws.identity.workspace}`);
  agentUi = mountAgentPairing(ws, {
    program: "sagebrush-agent",
    // (the Connect dialog says so while another tab of this browser has the agent, #1550)
    otherTab: () => (otherTabLive ? OTHER_TAB : null),
    runVerbs: runVerbsFor(agentRuns(ws)),
    button: $("#connect"),
    notebookEdit: editNotebook,
    // (the chat's web cards offer "for this turn" here, where they're drawn: egress.turn)
    egressTurn: true,
    onCreated: (c, p) => { if (c.kind === "notebook" && c.ref) void agentMade(c, p, madeAt(c, p)); },
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
    // (Chat here: an agent on one of your computers, over the relay's agent leg, this page's own)
    extra: (close) => chatHereSection(close),
    onPairing(p) {
      pairing = p;
      delegateTasks.attach(p);
      cards.clear();
      // (only while this pairing is the page's: a late message from one it replaced changes nothing; the replaced
      //  one's listener goes too)
      offAgent?.();
      offAgent = p.onNotification((m, params) => { if (pairing === p) session.onAgent(m, params, p); });
      let granted = false;
      p.onChange(() => {
        cards.refresh(); // (a pairing that closed or changed child: Allows waiting for a digest for it go)
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
          // (what this page missed while it was away, from the agent's log; an agent without one: away turns end)
          session.resume();
          // (the log mirror: the runner's log checked against what the account holds (the runner wins), then what the
          //  account doesn't have yet uploaded)
          void mirror.refresh().then(async () => {
            if (pairing !== p) return;
            await mirror.reconcile().catch(() => {});
            for (const t of state.threads) if (session.marked(t) && !session.readOnly(t)) void mirror.kick(t.id);
          });
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
          if (why === RELEASED) {
            // (let go for another tab: said as asked, the remembered access offered again, nothing tried by itself)
            setConn({ kind: "released", alert: false, action: "connect" });
            void agentUi?.remembered().then((g) => { rememberedGrant = g; renderConn(); });
          } else if (why === "revoked by the person") setConn(null);
          else if (why === "the grant expired") setConn({ kind: "expired", alert: true, action: "connect" });
          else setConn({ kind: "lost", alert: true, action: agentUi?.canReconnect ? "reconnect" : "connect" });
        }
        if (p.state === "closed" && pairing === p) {
          // (with an agent that keeps a log, its running turns are away until the page is paired again; else they end
          //  here, as interrupted)
          session.endLive(!!p.hello?.features?.includes("chat.resume"));
        }
        renderHeader();
        renderComposer();
      });
      renderHeader();
    },
  });
}
if (workspace) mountPairing(workspace);
// (a Files tab this page opened asks whether its agent is still connected here, to come back to this tab: #1620)
answerAgentsLive(() => pairing?.state === "granted", {
  // ("Use Claude here" in another tab: this page's connection, if local and remembered, may be asked to let go; that
  //  is all a message on the channel can do, #1550)
  remembered: () => !!agentUi?.releasable(),
  release: () => void agentUi?.release(),
});
// (and asks the same of the others: while another Agents tab has the agent and this one has none, the bar says so, and
//  goes once that tab no longer does; asked at load, each time this tab is shown again, and every few seconds while
//  the bar says so, #1550)
let otherTabTimer = 0;
async function checkOtherTab() {
  const mine = !!pairing && pairing.state !== "closed";
  const was = otherTabLive;
  // (not while "Use Claude here" runs: its own end says what happened)
  if (reconnecting) return;
  otherTabLive = !mine && (await agentsTabLive());
  // (the header, the banner and Send follow: not the scripted demo while that tab has Claude, #1688)
  if (otherTabLive !== was) { renderHeader(); renderComposer(); }
  // ("Use Claude here" offered only while that tab's connection is local and remembered and a remembered grant is in
  //  force here: else Connect, as before)
  const here = otherTabLive && (await agentsTabRemembered()) && !!(await agentUi?.remembered().catch(() => null));
  if (otherTabLive && (!connBar || connBar.kind === "kept" || connBar.kind === "otherTab" || connBar.kind === "released")) {
    const action = here ? "here" : "connect";
    if (connBar?.kind !== "otherTab" || connBar.action !== action) setConn({ kind: "otherTab", alert: false, action });
  }
  else if (!otherTabLive && connBar?.kind === "otherTab") setConn(null);
  clearTimeout(otherTabTimer);
  if (connBar?.kind === "otherTab") otherTabTimer = window.setTimeout(() => void checkOtherTab(), 3000);
}
void checkOtherTab();
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") void checkOtherTab(); });
// (the person's review of an agent's branches: in a dialog, its chunk fetched at the first click)
$("#review").onclick = () => { if (workspace) void openReviewDialog(workspace.reviewHost(), new URL("../", import.meta.url)); };
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
$("#howto").onclick = () => ($("#help").hidden = !$("#help").hidden);
// (the help box's command for this site: the release's line, with --origin where the agent doesn't trust this page's
//  origin by default, as on a DEV or preview site (#1604))
{ const pre = document.querySelector<HTMLElement>("#help pre"); if (pre) pre.textContent = ownClaudeCommand(pre.textContent?.trim() ?? "", location.origin); }

// ---- the log mirror's settings (design §5): the switch, what it means, the storage line; turning it off deletes
let mirrorConfirm = false;
function fmtBytes(n: number): string {
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1000 && i < u.length - 1) (n /= 1000), i++;
  return `${i === 0 ? n : n < 10 ? n.toFixed(1) : Math.round(n)} ${u[i]}`;
}
function renderMirrorSettings() {
  const st = mirror.status;
  $("#mirror-btn").hidden = !st.available;
  const box = $("#mirror-settings");
  const on = mirror.on();
  const sw = $<HTMLInputElement>("#mirror-switch");
  sw.checked = on;
  setText($("#mirror-about"), on ? MIRROR_COPY.on : MIRROR_COPY.off);
  const lines: string[] = [];
  if (on) lines.push(MIRROR_COPY.storage(fmtBytes(st.bytes ?? 0), st.quota !== undefined ? fmtBytes(st.quota) : null));
  if (on && mirror.full) lines.push(MIRROR_COPY.full);
  if (on && live() && !mirror.agentCan()) lines.push(MIRROR_COPY.updateAgent);
  // ("deleted" only from a status read that says nothing is pending; one that couldn't be read says nothing more)
  if (!on && mirrorDeleting) lines.push(st.available && st.pending === 0 ? MIRROR_COPY.deleted : MIRROR_COPY.deleting);
  $("#mirror-lines").replaceChildren(...lines.map((t) => Object.assign(document.createElement("div"), { textContent: t })));
  $("#mirror-confirm").hidden = !mirrorConfirm;
  box.toggleAttribute("data-on", on);
}
$("#mirror-btn").onclick = () => {
  mirrorConfirm = false;
  void mirror.refresh();
  renderMirrorSettings();
  $<HTMLDialogElement>("#mirror-dlg").showModal();
};
$("#mirror-close").onclick = () => $<HTMLDialogElement>("#mirror-dlg").close();
$<HTMLInputElement>("#mirror-switch").onchange = async (e) => {
  const sw = e.target as HTMLInputElement;
  if (sw.checked) {
    mirrorDeleting = false;
    await mirror.enable();
    await mirror.remote(true).catch(() => []);
    if (live()) for (const t of state.threads) if (session.marked(t)) void mirror.kick(t.id);
  } else {
    // (turning it off deletes the copy: asked first, in the panel's own words)
    sw.checked = true;
    mirrorConfirm = true;
  }
  renderMirrorSettings();
};
$("#mirror-confirm-no").onclick = () => {
  mirrorConfirm = false;
  renderMirrorSettings();
};
$("#mirror-confirm-yes").onclick = async () => {
  mirrorConfirm = false;
  mirrorDeleting = true;
  if (await mirror.disable()) {
    closeMirror();
    renderAll();
    // ("deleted" only once the account's object says nothing is pending)
    for (let i = 0; i < 100 && !(mirror.status.available && mirror.status.pending === 0) && !mirror.on(); i++) {
      await new Promise((r) => setTimeout(r, 3000));
      await mirror.refresh();
    }
  }
  renderMirrorSettings();
};
$("#mirror-delete-one").textContent = MIRROR_COPY.deleteOne;
$("#mirror-delete-one").onclick = async () => {
  const m = mirrorOpen;
  if (!m) return;
  if (await mirror.deleteConversation(m.locator)) {
    closeMirror();
    renderAll();
  }
};
setText($("#mirror-readonly-text"), MIRROR_COPY.readOnly);
setText($("#mirror-switch-label"), MIRROR_COPY.switch);
setText($("#mirror-confirm-text"), MIRROR_COPY.confirmOff);
setText($("#mirror-confirm-yes"), MIRROR_COPY.confirmOffButton);
// (every 30 s of a running turn, the mirror uploads what the log has so far)
setInterval(() => {
  for (const t of state.threads) if (isRunning(t)) void mirror.kick(t.id);
}, 30_000);
void mirror.refresh().then(() => mirror.remote()).catch(() => {});
$("#all-arts-chat").onclick = () => artifactBrowser();
$("#copychat").onclick = () => { const t = current(); void copyText(async () => threadMarkdown(t, { agent: agentName(), link: await fileLinks(t) }), "Copied the chat"); };

/** The header's agent line from text only (an agent's and a computer's names are text, never markup). */
function whoText(who: HTMLElement, dot: string, name: string, small: string) {
  const d = document.createElement("span");
  d.className = `conn ${dot}`;
  const s = document.createElement("small");
  s.textContent = small;
  who.replaceChildren(d, ...(name ? [document.createTextNode(name + " ")] : []), s);
}

/** Where the chats are kept, for the status's popover: "mirrored" only while uploads are actually under way (mirror.ts). */
function keptWhere() {
  return mirror.keptLine();
}

function renderHeader() {
  const who = $("#who");
  if (live() && pairing?.link) {
    whoText(who, "on", agentName(), `on ${pairing.computer}`);
  } else if (live()) {
    who.innerHTML = `<span class="conn on"></span>${esc(agentName())} <small>on your computer</small>`;
  } else if (connectingTo !== null) {
    whoText(who, "wait", "", waitingFor ? RUNNER.waiting(connectingTo) : RUNNER.connecting(connectingTo));
  } else if (pairing && pairing.state === "paired") {
    whoText(who, "wait", agentName(), "waiting: allow it in the dialog");
  } else if (otherTabLive) {
    whoText(who, "", "Claude", "in another tab");
  } else if (inert(current())) {
    who.innerHTML = `<span class="conn"></span>Claude <small>not connected</small>`;
  } else {
    who.innerHTML = `<span class="conn demo"></span>Claude <small>scripted demo</small>`;
  }
  for (const el of document.querySelectorAll<HTMLElement>("#editor [data-placeholder]")) el.dataset.placeholder = `Message ${agentName()}…`;
  $("#attach-hint").textContent = ATTACH_COPY.help + (live() && pairing?.hello?.features?.includes("workspace.image") ? " " + ATTACH_COPY.sees(agentName()) : "");
  $("#connect").textContent = live() ? "Connected" : "Connect Claude";
  $("#stop").textContent = stopLabel(agentName());
  $("#connect").toggleAttribute("disabled", live());
  $("#who-info").innerHTML = live()
    ? `Connected to ${esc(agentName())} on your computer (your own login). Its files are in this browser's workspace; ${mirror.uploading() ? "chats are kept in this browser and mirrored to your Sagebrush account" : "chats are kept in this browser"}.`
    : connBar?.kind === "restoring"
    ? "Reconnecting to Claude on your computer…"
    : pairing && pairing.state === "paired" && connectingTo === null
    ? `${esc(agentName())} is waiting for you to allow it in the dialog. ${keptWhere()}`
    : inert(current())
    ? `Claude isn't connected to this page. ${keptWhere()}`
    : `Preview: the chat is driven by a <b>scripted</b> stand-in for Claude until you connect your own ("Use your own Claude"). ${keptWhere()}`;
}

// (the status's popover, in place of the banner the page had (#1808: a banner in this mode only pushed everything down
//  on switching from Files): the status opens it, and a click elsewhere, Escape or the status again closes it)
{
  const who = $("#who"), info = $("#who-info");
  // (under the status, as far left as it fits: kept inside the top bar, so a phone's narrow window never scrolls sideways;
  //  placed again on a resize while it is open)
  const place = () => {
    const room = who.parentElement!.clientWidth;
    info.style.left = `${Math.max(8, Math.min(who.offsetLeft, room - info.offsetWidth - 8))}px`;
  };
  const show = (on: boolean) => {
    info.hidden = !on;
    who.setAttribute("aria-expanded", String(on));
    if (on) place();
  };
  who.addEventListener("click", () => show(info.hidden));
  addEventListener("resize", () => { if (!info.hidden) place(); });
  addEventListener("pointerdown", (e) => { if (!info.hidden && !who.contains(e.target as Node) && !info.contains(e.target as Node)) show(false); }, true);
  // (first, and taken: Escape that closes it doesn't also stop a running turn or leave full screen)
  addEventListener("keydown", (e) => { if (e.key === "Escape" && !info.hidden) { e.preventDefault(); show(false); who.focus(); } }, true);
}
renderHeader();
openArtifact = current().artifacts.at(-1)?.id ?? null;
mountLayout();
renderAll();
scrollToEnd(true);
editor.focus();
