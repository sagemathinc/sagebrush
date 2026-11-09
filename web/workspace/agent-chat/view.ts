// The agents chat's turn view (web/agents, and the chat panel to come): a person's message and an agent's turn as DOM
// nodes, its tool calls, permission prompts and artifact cards, as the Agents page has always drawn them. What a click
// does (answering a prompt, opening an artifact) and how Markdown is rendered are the caller's, passed in.
import { ATTENTION_STATES, TOOL_STATUSES, count, langOf, own, type Artifact, type Thread, type ToolCall, type Turn, type UserEntry } from "./events";

// (a class name from a known set only, whatever the thread holds: a stored thread from before apply checked it included)
const cls = (v: unknown, xs: readonly string[]) => (typeof v === "string" && xs.includes(v) ? v : "other");
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** What a turn's node does when it's used: answer a permission prompt, open an artifact; and its Markdown renderer. */
export interface TurnHooks {
  answer(attention: string, approve: boolean): void;
  openArtifact(id: string): void;
  md(src: string): string;
}

export function userNode(e: UserEntry, md: (src: string) => string): HTMLElement {
  const div = document.createElement("div");
  div.className = `user ${cls(e.mode, ["sent", "queued", "note"])}`;
  div.innerHTML =
    `<div class="bubble board-text">${md(e.text)}</div>` +
    (e.mode === "queued" ? `<div class="tag">Queued: sent when the current turn ends</div>` : "") +
    (e.mode === "note" ? `<div class="tag">Note: not sent to the agent</div>` : "");
  return div;
}

const TOOL_ICON: Record<string, string> = { terminal: "▸", file: "📄", edit: "✎", subagent: "◇", diff: "±", image: "🖼" };

export function turnNode(thread: Thread, turn: Turn, h: TurnHooks): HTMLElement {
  const div = document.createElement("div");
  div.className = "turn";
  const parts: string[] = [];
  for (const p of turn.parts) {
    if (p.kind === "thinking") {
      parts.push(`<details class="thinking"><summary>Thinking</summary><div>${esc(p.text)}</div></details>`);
    } else if (p.kind === "message") {
      parts.push(`<div class="msg board-text">${h.md(p.text)}${p.truncated ? `<div class="tag">(cut at 256 KiB)</div>` : ""}</div>`);
    } else if (p.kind === "tool") {
      const t = own(turn.tools, p.call);
      if (t) parts.push(toolHtml(t));
    } else if (p.kind === "attention") {
      const a = own(turn.attention, p.id);
      if (!a) continue;
      const open = a.state === "open" && !turn.outcome;
      parts.push(
        `<div class="attention ${cls(a.state, ATTENTION_STATES)}" data-attention="${esc(a.id)}"><div class="att-title">⚠ ${esc(a.title)}</div>` +
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
          ? `<div class="status done">${((turn.finished ?? 0) - turn.started) / 1000 > 0 ? (((turn.finished ?? 0) - turn.started) / 1000).toFixed(1) + " s · " : ""}${count(turn.usage.output_tokens) ?? 0} tokens</div>`
          : "";
  const tag = turn.agent ? `<span class="demo live">on your computer</span>` : `<span class="demo">demo</span>`;
  div.innerHTML = `<div class="who"><span class="avatar">✳</span>${esc(turn.agent ?? "Claude")} ${tag}</div>${parts.join("")}${status}`;
  for (const b of div.querySelectorAll<HTMLButtonElement>("[data-approve]")) {
    b.onclick = () => {
      const att = b.closest<HTMLElement>("[data-attention]")!.dataset.attention!;
      h.answer(att, b.dataset.approve === "1");
    };
  }
  for (const b of div.querySelectorAll<HTMLButtonElement>("[data-artifact]")) {
    b.onclick = () => h.openArtifact(b.dataset.artifact!);
  }
  return div;
}

export function toolHtml(t: ToolCall): string {
  const icon = Object.hasOwn(TOOL_ICON, t.tool) ? TOOL_ICON[t.tool] : "•";
  const state = t.status === "running" ? `<span class="spinner"></span>` : t.status === "ok" ? `<span class="ok">✓</span>` : `<span class="bad">${t.status === "unknown" ? "?" : "✗"}</span>`;
  const label = t.tool === "terminal" ? `<code>${esc(t.summary ?? t.name ?? "")}</code>` : `${esc(t.name ?? t.tool)} <code>${esc(t.summary ?? "")}</code>`;
  const meta = [t.status !== "running" && t.status !== "ok" ? cls(t.status, TOOL_STATUSES) : "", count(t.duration_ms) !== undefined ? `${(count(t.duration_ms)! / 1000).toFixed(1)} s` : ""].filter(Boolean).join(" · ");
  const body = t.diff ? diffHtml(t.diff.before, t.diff.after) : t.output ? `<pre class="out">${esc(t.output)}${t.body_cut ? "\n… (cut)" : ""}</pre>` : "";
  // (open while it runs, so its output streams in view; closed once it's done)
  return `<details class="tool ${cls(t.status, TOOL_STATUSES)}"${t.status === "running" ? " open" : ""}><summary>${state}<span class="ti">${icon}</span>${label}${meta ? `<span class="meta">${esc(meta)}</span>` : ""}</summary>${body}</details>`;
}

export function artifactIcon(a: Artifact) {
  return a.kind === "markdown" ? "📝" : a.kind === "diff" ? "±" : a.kind === "notebook" ? "📓" : "⌨";
}
export function artifactLabel(a: Artifact) {
  return a.kind === "markdown" ? "Document" : a.kind === "diff" ? "Changes" : a.kind === "notebook" ? "Notebook" : `Code${langOf(a.lang) ? ` · ${esc(langOf(a.lang)!)}` : ""}`;
}

// A line diff (longest common subsequence): small files only.
export function diffHtml(before: string, after: string): string {
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
