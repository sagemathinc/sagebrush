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
import { guardGestures, mountNotebook, type AgentCells, type Guard, type NotebookHost, type NotebookUi } from "./notebook-artifact";

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
type Bar = Parameters<NotebookUi["bar"]>[0];
type Host = {
  key: string;
  el: HTMLElement;
  body: string; // (a static host's content key: redrawn only when the artifact's body changes)
  copy: () => string;
  nb?: NotebookHost;
  running: boolean;
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
  document.body.classList.toggle("has-artifact", !!a);
  document.body.classList.toggle("fullscreen", !!a && fullscreen);
  document.body.classList.toggle("wide-artifact", !!a && a.kind === "notebook");
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
  const running = isRunning(current());
  $("#send").textContent = running ? "Send now" : "Send";
  $("#send").title = running ? "Interrupt the agent and send (Shift+Enter)" : "Send (Shift+Enter)";
  $("#queue").hidden = !running;
  $("#stop").hidden = !running;
  const q = queues.get(current().id)?.length ?? 0;
  $("#queued").textContent = q ? `${q} queued` : "";
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
