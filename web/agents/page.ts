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
import { apply, newThread, runningTurn, type Artifact, type Thread, type ToolCall, type Turn, type TurnEvent, type UserEntry } from "./events";
import { startFakeTurn, type Draft, type FakeTurn } from "./fake-agent";
import type { AgentPairing } from "../workspace/agent-pair";
import { mountAgentPairing } from "../workspace/agent-ui";
import { Workspace } from "../workspace/api";
import { mountNotebook, type AgentCells, type NotebookHost, type NotebookUi } from "./notebook-artifact";

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
    liveRunning.add(thread.id);
    if (!pairing!.notify("chat.message", { conversation: thread.id, id: entry.id, author: "person", text: entry.text })) {
      liveRunning.delete(thread.id);
      toast("The agent is disconnected");
    }
    renderComposer();
  } else {
    startTurn(thread, entry.text);
  }
}

function interrupt(thread: Thread) {
  const scripted = agents.get(thread.id);
  if (scripted) scripted.turn.interrupt();
  else if (liveRunning.has(thread.id)) pairing?.notify("chat.interrupt", { conversation: thread.id });
}

function answer(thread: Thread, attention: string, approve: boolean) {
  const scripted = agents.get(thread.id);
  if (scripted) scripted.turn.answer(attention, approve);
  else pairing?.notify("chat.permission", { request_id: attention, behavior: approve ? "allow" : "deny" });
}

// What the paired agent says: turn events for one of this page's threads.
function onAgent(method: string, params: unknown) {
  if (method !== "turn.event") return;
  const p = params as { conversation?: unknown; turn_id?: unknown; event?: { type?: unknown } } | null;
  const thread = state.threads.find((t) => t.id === p?.conversation);
  if (!thread || typeof p?.turn_id !== "string" || !p.event || typeof p.event.type !== "string") return;
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
    a.onclick = () => {
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
  const div = document.createElement("div");
  div.className = `user ${e.mode}`;
  div.innerHTML =
    `<div class="bubble board-text">${md(e.text)}</div>` +
    (e.mode === "queued" ? `<div class="tag">Queued: sent when the current turn ends</div>` : "") +
    (e.mode === "note" ? `<div class="tag">Note: not sent to the agent</div>` : "");
  return div;
}

const TOOL_ICON: Record<string, string> = { terminal: "▸", file: "📄", edit: "✎", subagent: "◇", diff: "±", image: "🖼" };

function turnNode(thread: Thread, turn: Turn): HTMLElement {
  const div = document.createElement("div");
  div.className = "turn";
  const parts: string[] = [];
  for (const p of turn.parts) {
    if (p.kind === "thinking") {
      parts.push(`<details class="thinking"><summary>Thinking</summary><div>${esc(p.text)}</div></details>`);
    } else if (p.kind === "message") {
      parts.push(`<div class="msg board-text">${md(p.text)}${p.truncated ? `<div class="tag">(cut at 256 KiB)</div>` : ""}</div>`);
    } else if (p.kind === "tool") {
      parts.push(toolHtml(turn.tools[p.call]));
    } else if (p.kind === "attention") {
      const a = turn.attention[p.id];
      const open = a.state === "open" && !turn.outcome;
      parts.push(
        `<div class="attention ${a.state}" data-attention="${esc(a.id)}"><div class="att-title">⚠ ${esc(a.title)}</div>` +
          (a.summary ? `<div class="att-summary">${esc(a.summary)}</div>` : "") +
          (a.detail ? `<details class="att-detail"${open ? " open" : ""}><summary>All of the request</summary><pre>${esc(a.detail)}</pre></details>` : "") +
          (open
            ? `<div class="att-actions"><button class="primary" data-approve="1">Allow</button><button data-approve="0">Deny</button></div>`
            : `<div class="att-state">${a.state === "approved" ? "Allowed" : a.state === "denied" ? "Denied" : "No answer"}</div>`) +
          `</div>`,
      );
    } else if (p.kind === "artifact") {
      const a = thread.artifacts.find((x) => x.id === p.id);
      if (a) parts.push(`<button class="artifact-card" data-artifact="${esc(a.id)}"><span class="ai">${artifactIcon(a)}</span><span><b>${esc(a.title)}</b><small>${artifactLabel(a)} · click to open</small></span></button>`);
    }
  }
  if (turn.error) parts.push(`<div class="turn-error">Error: ${esc(turn.error.message)}</div>`);
  const status =
    turn.outcome === "interrupted"
      ? `<div class="status">Interrupted</div>`
      : !turn.outcome
        ? `<div class="status working"><span class="spinner"></span>Working…</div>`
        : turn.usage
          ? `<div class="status done">${((turn.finished ?? 0) - turn.started) / 1000 > 0 ? (((turn.finished ?? 0) - turn.started) / 1000).toFixed(1) + " s · " : ""}${turn.usage.output_tokens} tokens</div>`
          : "";
  const tag = turn.agent ? `<span class="demo live">on your computer</span>` : `<span class="demo">demo</span>`;
  div.innerHTML = `<div class="who"><span class="avatar">✳</span>${esc(turn.agent ?? "Claude")} ${tag}</div>${parts.join("")}${status}`;
  for (const b of div.querySelectorAll<HTMLButtonElement>("[data-approve]")) {
    b.onclick = () => {
      const att = b.closest<HTMLElement>("[data-attention]")!.dataset.attention!;
      answer(thread, att, b.dataset.approve === "1");
    };
  }
  for (const b of div.querySelectorAll<HTMLButtonElement>("[data-artifact]")) {
    b.onclick = () => {
      openArtifact = b.dataset.artifact!;
      renderArtifacts();
    };
  }
  return div;
}

function toolHtml(t: ToolCall): string {
  const icon = TOOL_ICON[t.tool] ?? "•";
  const state = t.status === "running" ? `<span class="spinner"></span>` : t.status === "ok" ? `<span class="ok">✓</span>` : `<span class="bad">${t.status === "unknown" ? "?" : "✗"}</span>`;
  const label = t.tool === "terminal" ? `<code>${esc(t.summary ?? t.name ?? "")}</code>` : `${esc(t.name ?? t.tool)} <code>${esc(t.summary ?? "")}</code>`;
  const meta = [t.status !== "running" && t.status !== "ok" ? t.status : "", t.duration_ms != null ? `${(t.duration_ms / 1000).toFixed(1)} s` : ""].filter(Boolean).join(" · ");
  const body = t.diff ? diffHtml(t.diff.before, t.diff.after) : t.output ? `<pre class="out">${esc(t.output)}${t.body_cut ? "\n… (cut)" : ""}</pre>` : "";
  // (open while it runs, so its output streams in view; closed once it's done)
  return `<details class="tool ${t.status}"${t.status === "running" ? " open" : ""}><summary>${state}<span class="ti">${icon}</span>${label}${meta ? `<span class="meta">${esc(meta)}</span>` : ""}</summary>${body}</details>`;
}

function artifactIcon(a: Artifact) {
  return a.kind === "markdown" ? "📝" : a.kind === "diff" ? "±" : a.kind === "notebook" ? "📓" : "⌨";
}
function artifactLabel(a: Artifact) {
  return a.kind === "markdown" ? "Document" : a.kind === "diff" ? "Changes" : a.kind === "notebook" ? "Notebook" : `Code${a.lang ? ` · ${a.lang}` : ""}`;
}

// A line diff (longest common subsequence): small files only.
function diffHtml(before: string, after: string): string {
  const a = before.split("\n"), b = after.split("\n");
  const n = a.length, m = b.length;
  const L = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const rows: string[] = [];
  let i = 0, j = 0;
  while (i < n || j < m) {
    // (a removed line before an added one, as git shows them)
    if (i < n && j < m && a[i] === b[j]) rows.push(`<div class="dl"> ${esc(a[i++])}</div>`), j++;
    else if (i < n && (j === m || L[i + 1][j] >= L[i][j + 1])) rows.push(`<div class="dl del">-${esc(a[i++])}</div>`);
    else rows.push(`<div class="dl add">+${esc(b[j++])}</div>`);
  }
  return `<div class="diff">${rows.join("")}</div>`;
}

// The pane: a head (tabs and buttons, redrawn when what it shows changes) and one host per artifact, kept while
// its thread is shown. A host is mounted once: full screen, a new artifact or another tab only hide or show it,
// so a notebook keeps its kernel, a running cell and its pending saves (the artifacts plan, BAP-1).
type Host = {
  key: string;
  el: HTMLElement;
  body: string; // (a static host's content key: redrawn only when the artifact's body changes)
  copy: () => string;
  nb?: NotebookHost;
  running: boolean;
  flush?: () => Promise<void>;
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

/** Let go of every host of a thread: saves flushed, notebooks stopped and disposed. */
async function releaseHosts(threadId: string | null) {
  if (!threadId) return;
  for (const [k, h] of [...hosts]) {
    if (!k.startsWith(threadId + "\u0000")) continue;
    hosts.delete(k);
    await h.flush?.().catch(() => {});
    await h.nb?.dispose().catch(() => {});
    h.el.remove();
  }
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
  document.body.classList.toggle("has-artifact", !!a);
  document.body.classList.toggle("fullscreen", !!a && fullscreen);
  document.body.classList.toggle("wide-artifact", !!a && a.kind === "notebook");
  if (paneThread !== thread.id) {
    void releaseHosts(paneThread);
    paneThread = thread.id;
  }
  const { head, body, bar } = paneShell(pane);
  if (!a) {
    for (const h of hosts.values()) (h.nb ? h.nb.hidden(true) : (h.el.hidden = true));
    headKey = "";
    return;
  }
  // the head: tabs (a running notebook's name says so), copy, full screen, close
  const hk = JSON.stringify([thread.id, thread.artifacts.map((x) => [x.id, x.title, hosts.get(hostKey(thread.id, x.id))?.running ?? false]), a.id, fullscreen]);
  if (hk !== headKey) {
    headKey = hk;
    const tabs = thread.artifacts
      .map((x) => {
        const run = hosts.get(hostKey(thread.id, x.id))?.running;
        return `<button class="tab${x.id === a.id ? " on" : ""}" data-tab="${esc(x.id)}">${artifactIcon(x)} ${esc(x.title)}${run ? ` <span class="tab-running">· running</span>` : ""}</button>`;
      })
      .join("");
    head.innerHTML =
      `<div class="tabs">${tabs}</div>` +
      `<button class="icon" id="copy" title="Copy">⧉</button>` +
      `<button class="icon" id="full" title="${fullscreen ? "Exit full screen" : "Full screen"}">${fullscreen ? "⤡" : "⤢"}</button>` +
      `<button class="icon" id="close" title="Close">✕</button>`;
    for (const t of head.querySelectorAll<HTMLButtonElement>("[data-tab]")) t.onclick = () => ((openArtifact = t.dataset.tab!), renderArtifacts());
    $("#full", head).onclick = () => ((fullscreen = !fullscreen), renderArtifacts());
    $("#close", head).onclick = async () => {
      if (!(await mayClosePane(thread.id))) return;
      openArtifact = null;
      fullscreen = false;
      await releaseHosts(thread.id);
      renderArtifacts();
    };
    $("#copy", head).onclick = () => {
      const h = hosts.get(hostKey(thread.id, openArtifact ?? ""));
      navigator.clipboard?.writeText(h?.copy() ?? "").then(() => toast("Copied"), () => toast("Couldn't copy"));
    };
  }
  // this artifact's host: mounted once; the others of this thread hidden (kept)
  const key = hostKey(thread.id, a.id);
  let h = hosts.get(key);
  const staticBody = a.path && workspace ? "" : a.body;
  if (h && !h.nb && !h.flush && h.body !== staticBody) {
    h.el.remove();
    hosts.delete(key);
    h = undefined;
  }
  if (!h) {
    const el = document.createElement("div");
    el.className = "pane-host";
    body.append(el);
    h = { key, el, body: staticBody, copy: () => a.body, running: false };
    hosts.set(key, h);
    mountHost(thread.id, a, h, bar);
  }
  for (const x of hosts.values()) {
    const show = x === h;
    if (x.nb) x.nb.hidden(!show);
    x.el.hidden = !show;
    if (!show) x.flush?.().catch(() => {});
  }
  if (!h.nb) bar.hidden = true;
}

// What an artifact's host holds: a notebook, a workspace file (Markdown, LaTeX, code), or the artifact's own text.
function mountHost(threadId: string, a: Artifact, h: Host, bar: HTMLElement) {
  const before = document.activeElement as HTMLElement | null;
  const keepFocus = () => {
    // (an artifact opened by the agent never takes the composer's focus: BAP-6)
    if (before && document.activeElement !== before && $("#artifacts").contains(document.activeElement)) before.focus();
  };
  if (a.kind === "notebook" && a.path && workspace) {
    h.el.innerHTML = `<div class="file-path">${esc(a.path)} <span class="saved"></span> <a class="open-full" href="/w${esc(a.path)}" target="_blank" rel="noopener">Open in Sagebrush</a></div><div class="file-body"></div>`;
    const saved = $(".saved", h.el);
    const showBar = (b: Parameters<NotebookUi["bar"]>[0]) => {
      if (hosts.get(h.key) !== h || openArtifact !== a.id) return;
      if (!b) return void (bar.hidden = true);
      bar.hidden = false;
      bar.className = `pane-bar ${b.kind}`;
      bar.setAttribute("role", "alert");
      bar.innerHTML = `<span>${esc(b.text)}</span>` + (b.actions ?? []).map((x, i) => `<button data-act="${i}">${esc(x.label)}</button>`).join("");
      for (const btn of bar.querySelectorAll<HTMLButtonElement>("[data-act]")) btn.onclick = () => b.actions![Number(btn.dataset.act)].run();
    };
    const ui: NotebookUi = {
      saved: (t) => (saved.textContent = t),
      bar: showBar,
      agentName,
      running: (on) => {
        h.running = on;
        headKey = "";
        if (current().id === threadId) renderArtifacts();
      },
    };
    void mountNotebook(workspace, a.path, $(".file-body", h.el), ui, agentCellsByPath.get(a.path) ?? Promise.resolve(null), () => hosts.get(h.key) === h).then(
      (nb) => {
        if (hosts.get(h.key) !== h) return void nb.dispose(); // (closed while it opened: nothing of it stays)
        h.nb = nb;
        h.copy = nb.copyText;
        h.flush = nb.flush;
        nb.hidden(openArtifact !== a.id || current().id !== threadId);
        keepFocus();
      },
      (e) => showBar({ kind: "refused", text: `Couldn't open this notebook: ${(e as Error).message}` }),
    );
    return;
  }
  if (a.path && workspace) {
    h.el.innerHTML = `<div class="file-path">${esc(a.path)} <span class="saved"></span></div><div class="file-body"></div>`;
    const f = mountFile(a, $(".file-body", h.el), $(".saved", h.el));
    h.copy = f.text;
    h.flush = f.flush;
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

// An artifact that is a workspace file: the file itself, editable here (saved as the person, with its
// revision as base, so a change the agent made meanwhile is never overwritten). Markdown in the block editor,
// LaTeX in the LaTeX editor where this build has it (web/latex, /sagebrush-latex.js), other text as text.
function mountFile(a: Artifact, box: HTMLElement, saved: HTMLElement): { text: () => string; flush: () => Promise<void> } {
  const path = a.path!;
  let rev = -1;
  let text = a.body;
  let timer = 0;
  let pending: string | null = null;
  const say = (s: string) => (saved.textContent = s);
  const write = async (value: string) => {
    pending = null;
    try {
      const r = await workspace!.write(path, value, rev >= 0 ? { base: rev } : {});
      rev = r.rev;
      say("Saved");
    } catch (e) {
      const code = (e as { code?: string }).code;
      say(code === "conflict" ? "Not saved: changed elsewhere since (reopen it to see that version)" : `Not saved: ${(e as Error).message}`);
    }
  };
  const changed = (value: string) => {
    text = value;
    pending = value;
    say("Editing…");
    clearTimeout(timer);
    timer = window.setTimeout(() => void write(value), 700);
  };
  let set: (v: string) => void = () => {};
  if (a.kind === "markdown") {
    const ed = new BlockEditor(text, { render: md, typeset: (el) => typeset(el), onChange: changed });
    ed.el.classList.add("doc");
    box.append(ed.el);
    set = (v) => (ed.value = v);
  } else {
    const ta = document.createElement("textarea");
    ta.className = "code-edit";
    ta.spellcheck = false;
    ta.value = text;
    ta.oninput = () => changed(ta.value);
    box.append(ta);
    set = (v) => (ta.value = v);
    if (/\.tex$/i.test(path) && !__SB_LATEX__) {
      // (no LaTeX editor in this build: the source here, and the file in Sagebrush)
      saved.insertAdjacentHTML("afterend", ` <a class="open-full" href="/w${esc(path)}" target="_blank" rel="noopener">Open in Sagebrush</a>`);
    } else if (/\.tex$/i.test(path)) {
      // (LaTeX: the LaTeX editor's live preview, in place of the text)
      import(/* @vite-ignore */ LATEX_URL).then(
        (m: { mountEditor?: (root: HTMLElement, o: { text: string; onChange?(t: string): void; layout?: "split" | "preview" }) => { setText(t: string): void } }) => {
          if (!m.mountEditor || !box.isConnected) return;
          ta.remove();
          const host = document.createElement("div");
          host.className = "tex-host";
          box.append(host);
          const ed = m.mountEditor(host, { text, onChange: changed, layout: "split" });
          set = (v) => ed.setText(v);
        },
        () => {},
      );
    }
  }
  // (the file as it is now: the agent may have written it again since this artifact)
  workspace!.read(path).then(
    (r) => {
      rev = r.rev;
      if (typeof r.content === "string" && r.content !== text) {
        text = r.content;
        set(text);
      }
    },
    () => say("(not in this browser's workspace)"),
  );
  return {
    text: () => text,
    flush: async () => {
      if (pending === null) return;
      clearTimeout(timer);
      await write(pending);
    },
  };
}

function renderComposer() {
  const running = isRunning(current());
  $("#send").textContent = running ? "Send now" : "Send";
  $("#send").title = running ? "Interrupt the agent and send (Shift+Enter)" : "Send (Shift+Enter)";
  $("#queue").hidden = !running;
  $("#stop").hidden = !running;
  const q = queues.get(current().id)?.length ?? 0;
  $("#queued").textContent = q ? `${q} queued` : "";
}

function toast(text: string) {
  const t = $("#toast");
  t.textContent = text;
  t.hidden = false;
  setTimeout(() => (t.hidden = true), 1500);
}

// ---------------------------------------------------------------------------
// The page

const editor = new BlockEditor("", {
  render: md,
  typeset: (el) => typeset(el),
  placeholder: "Message Claude…  (Shift+Enter to send)",
  onKey(e) {
    if (e.key !== "Enter") return false;
    if (e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) return (e.preventDefault(), submit("sent"), true);
    if (e.altKey) return (e.preventDefault(), submit("queued"), true);
    if (e.ctrlKey || e.metaKey) return (e.preventDefault(), submit("note"), true);
    return false;
  },
});
$("#editor").append(editor.el);
$("#send").onclick = () => submit("sent");
$("#queue").onclick = () => submit("queued");
$("#note").onclick = () => submit("note");
$("#stop").onclick = () => interrupt(current());
$("#new").onclick = () => {
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
  if (e.key === "Escape" && (e.defaultPrevented || (e.target instanceof Element && e.target.closest("#artifacts .file-body, #artifacts .nb-root")))) return;
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
// The workspace, and the pairing with an agent on this computer (a ?pair=CODE&port=N link opens it at once).
try {
  workspace = await Workspace.open();
} catch {
  workspace = null; // (no IndexedDB: the scripted demo still works)
}
$("#connect").hidden = !workspace;
if (workspace) {
  mountAgentPairing(workspace, {
    button: $("#connect"),
    onPairing(p) {
      pairing = p;
      p.onNotification(onAgent);
      p.onChange(() => {
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
$("#howto").onclick = () => ($("#help").hidden = !$("#help").hidden);

function renderHeader() {
  const who = $("#who");
  if (live()) {
    who.innerHTML = `<span class="conn on"></span>${esc(agentName())} <small>on your computer</small>`;
  } else if (pairing && pairing.state === "paired") {
    who.innerHTML = `<span class="conn wait"></span>${esc(agentName())} <small>connected: allow it in the dialog</small>`;
  } else {
    who.innerHTML = `<span class="conn demo"></span>Claude <small>scripted demo</small>`;
  }
  for (const el of document.querySelectorAll<HTMLElement>("#editor [data-placeholder]")) el.dataset.placeholder = `Message ${agentName()}…  (Shift+Enter to send)`;
  $("#connect").textContent = live() ? "Connected" : "Connect Claude";
  $("#stop").textContent = `Stop ${agentName()}`;
  $("#connect").toggleAttribute("disabled", live());
  $("#banner").innerHTML = live()
    ? `Connected to ${esc(agentName())} on your computer (your own login). Its files are in this browser's workspace; chats are kept in this browser.`
    : "Preview: the chat is driven by a <b>scripted</b> stand-in for Claude until you connect your own (\"Use your own Claude\"). Chats are kept in this browser only.";
}

renderHeader();
openArtifact = current().artifacts.at(-1)?.id ?? null;
renderAll();
scrollToEnd(true);
editor.focus();
