// The agents chat preview (web/agents): a full-page chat with artifacts beside
// it, the model claude.ai and chatgpt.com have converged on. The chat is
// primary; an artifact opens floating to the right, or full screen. This
// preview drives it with a scripted agent (fake-agent.ts); the real one
// speaks the same turn events (events.ts). Threads are kept in this
// browser's localStorage only.

import { BlockEditor } from "../board/blocks";
import { render as markdown } from "../markdown";
import { apply, newThread, runningTurn, type Artifact, type Thread, type ToolCall, type Turn, type TurnEvent, type UserEntry } from "./events";
import { startFakeTurn, type Draft, type FakeTurn } from "./fake-agent";

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

const agents = new Map<string, { turn: FakeTurn; turn_id: string }>(); // by thread
const queues = new Map<string, UserEntry[]>(); // queued messages, by thread
let openArtifact: string | null = null;
let fullscreen = false;

const current = () => state.threads.find((t) => t.id === state.current) ?? state.threads[0];

function emitTo(thread: Thread, turn_id: string, d: Draft) {
  const e = { ...d, seq: thread.applied_seq + 1, turn_id } as TurnEvent;
  apply(thread, e);
  if (d.type === "artifact") openArtifact = (d as { id: string }).id;
  save();
  if (thread.id === state.current) schedule();
}

// ---------------------------------------------------------------------------
// Sending

function submit(mode: UserEntry["mode"]) {
  const text = editor.value.trim();
  if (!text) return;
  const thread = current();
  const running = agents.get(thread.id);
  if (mode === "sent" && running) {
    // Sending while a turn runs interrupts it, as in Claude Code.
    running.turn.interrupt();
  }
  if (mode === "queued" && !running) mode = "sent";
  const entry: UserEntry = { kind: "user", id: id(), text, mode, time: Date.now() };
  thread.entries.push(entry);
  if (thread.title === "New chat") thread.title = text.split("\n")[0].slice(0, 48);
  editor.value = "";
  if (mode === "queued") {
    queues.set(thread.id, [...(queues.get(thread.id) ?? []), entry]);
  } else if (mode === "sent") {
    const go = () => startTurn(thread, text);
    if (running) running.turn.done.then(go);
    else go();
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
    const next = queues.get(thread.id)?.shift();
    if (next) {
      next.mode = "sent";
      save();
      startTurn(thread, next.text);
    }
    renderAll();
  });
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
    if (agents.has(t.id)) a.append(Object.assign(document.createElement("span"), { className: "dot", title: "working" }));
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
      const open = a.state === "open" && agents.get(thread.id)?.turn_id === turn.turn_id;
      parts.push(
        `<div class="attention ${a.state}" data-attention="${esc(a.id)}"><div class="att-title">⚠ ${esc(a.title)}</div>` +
          (a.summary ? `<div class="att-summary">${esc(a.summary)}</div>` : "") +
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
  div.innerHTML = `<div class="who"><span class="avatar">✳</span>Claude <span class="demo">demo</span></div>${parts.join("")}${status}`;
  for (const b of div.querySelectorAll<HTMLButtonElement>("[data-approve]")) {
    b.onclick = () => {
      const att = b.closest<HTMLElement>("[data-attention]")!.dataset.attention!;
      agents.get(thread.id)?.turn.answer(att, b.dataset.approve === "1");
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
  return a.kind === "markdown" ? "📝" : a.kind === "diff" ? "±" : "⌨";
}
function artifactLabel(a: Artifact) {
  return a.kind === "markdown" ? "Document" : a.kind === "diff" ? "Changes" : `Code${a.lang ? ` · ${a.lang}` : ""}`;
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

function renderArtifacts() {
  const thread = current();
  const pane = $("#artifacts");
  const a = thread.artifacts.find((x) => x.id === openArtifact);
  document.body.classList.toggle("has-artifact", !!a);
  document.body.classList.toggle("fullscreen", !!a && fullscreen);
  if (!a) {
    pane.innerHTML = "";
    return;
  }
  const tabs = thread.artifacts
    .map((x) => `<button class="tab${x.id === a.id ? " on" : ""}" data-tab="${esc(x.id)}">${artifactIcon(x)} ${esc(x.title)}</button>`)
    .join("");
  let body: string;
  if (a.kind === "markdown") body = `<div class="doc board-text">${md(a.body)}</div>`;
  else if (a.kind === "diff") {
    const d = JSON.parse(a.body) as { before: string; after: string };
    body = diffHtml(d.before, d.after);
  } else body = `<pre class="code">${esc(a.body)}</pre>`;
  pane.innerHTML =
    `<div class="pane-head"><div class="tabs">${tabs}</div>` +
    `<button class="icon" id="copy" title="Copy">⧉</button>` +
    `<button class="icon" id="full" title="${fullscreen ? "Exit full screen" : "Full screen"}">${fullscreen ? "⤡" : "⤢"}</button>` +
    `<button class="icon" id="close" title="Close">✕</button></div>` +
    `<div class="pane-body">${body}</div>`;
  for (const t of pane.querySelectorAll<HTMLButtonElement>("[data-tab]")) t.onclick = () => ((openArtifact = t.dataset.tab!), renderArtifacts());
  $("#full", pane).onclick = () => ((fullscreen = !fullscreen), renderArtifacts());
  $("#close", pane).onclick = () => ((openArtifact = null), (fullscreen = false), renderArtifacts());
  $("#copy", pane).onclick = () => {
    const text = a.kind === "diff" ? (JSON.parse(a.body) as { after: string }).after : a.body;
    navigator.clipboard?.writeText(text).then(() => toast("Copied"), () => toast("Couldn't copy"));
  };
  typeset(pane);
}

function renderComposer() {
  const running = agents.has(current().id);
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
$("#stop").onclick = () => agents.get(current().id)?.turn.interrupt();
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
  if (e.key === "Escape" && fullscreen) {
    fullscreen = false;
    renderArtifacts();
  } else if (e.key === "Escape" && agents.has(current().id) && !editor.field) {
    agents.get(current().id)?.turn.interrupt();
  }
});

// (a turn that was running when the page closed can't go on: it ends interrupted)
for (const t of state.threads) {
  const r = runningTurn(t);
  if (r) emitTo(t, r.turn_id, { type: "turn_finished", outcome: "interrupted" });
}
openArtifact = current().artifacts.at(-1)?.id ?? null;
renderAll();
scrollToEnd(true);
editor.focus();
