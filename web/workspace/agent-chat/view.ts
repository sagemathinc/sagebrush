// The agents chat's turn view (web/agents, and the chat panel to come): a person's message and an agent's turn as DOM
// nodes, its tool calls, permission prompts and artifact cards, as the Agents page has always drawn them. What a click
// does (answering a prompt, opening an artifact) and how Markdown is rendered are the caller's, passed in.
import { ATTENTION_STATES, TOOL_STATUSES, count, langOf, own, type Artifact, type Attention, type Thread, type ToolCall, type Turn, type UserEntry } from "./events";
import { MIRROR_COPY, present, reasonText, type InertBlock, type InertPart, type Section } from "./mirror";

// (a class name from a known set only, whatever the thread holds: a stored thread from before apply checked it included)
const cls = (v: unknown, xs: readonly string[]) => (typeof v === "string" && xs.includes(v) ? v : "other");
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** What a turn's node does when it's used: answer a permission prompt, open an artifact; and its Markdown renderer. */
export interface TurnHooks {
  /** a permission prompt's answer: its id, Allow (true), Deny (false) or a web card's "for this turn" ("turn"), the
   *  turn it was shown in, and the page's token for that very card */
  answer(attention: string, approve: boolean | "turn", turn: string, instance: string): void;
  openArtifact(id: string): void;
  md(src: string): string;
}

/** A steer's line under the person's message: what the agent said happened to it. */
export function steerTag(e: UserEntry): string {
  if (e.receipt === "delivered") return "Delivered to the running turn";
  if (e.receipt === "rejected") return e.receipt_reason === "busy" ? "Not delivered: the agent had too many messages waiting" : "Not delivered: the agent dropped it when the turn ended";
  if (e.receipt === "queued") return e.receipt_reason === "codex" ? "Queued, runs next: this agent takes it after the turn" : e.receipt_reason === "ended" ? "Queued, runs next: the turn ended first" : "Queued, runs next";
  if (e.settled && (!e.receipt || e.receipt === "steering")) return "Sent during the turn";
  return "Steering: Claude reads it at its next step";
}

export function userNode(e: UserEntry, md: (src: string) => string): HTMLElement {
  const div = document.createElement("div");
  div.className = `user ${cls(e.mode, ["sent", "queued", "note", "steer"])}`;
  div.innerHTML =
    `<div class="bubble board-text">${md(e.text)}</div>` +
    (e.mode === "queued" ? `<div class="tag">Queued: sent when the current turn ends</div>` : "") +
    (e.mode === "note" ? `<div class="tag">Note: not sent to the agent</div>` : "") +
    (e.mode === "steer" ? `<div class="tag">${steerTag(e)}</div>` : "");
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
      const open = a.state === "open" && !turn.outcome && !turn.away;
      parts.push(
        `<div class="attention ${cls(a.state, ATTENTION_STATES)}" data-attention="${esc(a.id)}" data-instance="${esc(a.instance ?? "")}"><div class="att-title">⚠ ${esc(a.title)}</div>` +
          (a.body ? `<div class="att-body">${esc(a.body)}</div>` : "") +
          (a.summary ? `<div class="att-summary">${esc(a.summary)}</div>` : "") +
          (a.reason ? `<div class="att-reason">${esc(a.reason)}</div>` : "") +
          (a.detail ? `<details class="att-detail"${open ? " open" : ""}><summary>All of the request</summary><pre>${esc(a.detail)}</pre></details>` : "") +
          (open
            ? `<div class="att-actions${a.buttons === "three" ? " three" : ""}">${attButtons(a)}</div>`
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
      : !turn.outcome && turn.away
        ? `<div class="status">The connection to the agent was lost while this ran. Connect again to see how it went.</div>`
      : !turn.outcome
        ? `<div class="status working"><span class="spinner"></span>Working…</div>`
        : turn.usage
          ? `<div class="status done">${((turn.finished ?? 0) - turn.started) / 1000 > 0 ? (((turn.finished ?? 0) - turn.started) / 1000).toFixed(1) + " s · " : ""}${count(turn.usage.output_tokens) ?? 0} tokens</div>`
          : "";
  const tag = turn.agent ? `<span class="demo live">on your computer</span>` : `<span class="demo">demo</span>`;
  // (W3: the model and thinking level this turn runs with, quietly under the name, only as the agent reported them)
  //  (checked again here, as a thread kept from before may hold anything)
  const model = typeof turn.info?.model === "string" && /^[A-Za-z0-9._:\/@[\]-]{1,128}$/.test(turn.info.model) ? turn.info.model : undefined;
  const effort = typeof turn.info?.effort === "string" && /^[a-z0-9]{1,16}$/.test(turn.info.effort) ? turn.info.effort : undefined;
  const info = [model, effort ? `thinking: ${effort}` : undefined].filter(Boolean).join(" · ");
  div.innerHTML = `<div class="who"><span class="avatar">✳</span>${esc(turn.agent ?? "Claude")} ${tag}</div>${info ? `<div class="who-info">${esc(info)}</div>` : ""}${parts.join("")}${status}`;
  for (const b of div.querySelectorAll<HTMLButtonElement>("[data-approve]")) {
    b.onclick = () => {
      const card = b.closest<HTMLElement>("[data-attention]")!;
      const v = b.dataset.approve;
      h.answer(card.dataset.attention!, v === "turn" ? "turn" : v === "1", turn.turn_id, card.dataset.instance ?? "");
    };
  }
  for (const b of div.querySelectorAll<HTMLButtonElement>("[data-artifact]")) {
    b.onclick = () => h.openArtifact(b.dataset.artifact!);
  }
  return div;
}

/** A card's buttons: a web card's three (for this turn, this request, Deny), two, or Deny alone, as it was admitted;
 *  any other card's Allow and Deny. Deny is set apart (att-deny), so on a phone it stands alone below the others. */
function attButtons(a: Attention): string {
  const deny = `<button class="att-deny" data-approve="0">Deny</button>`;
  if (a.buttons === "deny") return deny;
  const allow = `<button class="primary" data-approve="1">${esc(a.allow || "Allow")}</button>`;
  // (the primary style on Allow this request: the narrowest grant is the default-looking answer)
  if (a.buttons === "three" && a.turn_label) return `<button data-approve="turn">${esc(a.turn_label)}</button>${allow}${deny}`;
  return allow + deny;
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
  return a.kind === "markdown" ? "📝" : a.kind === "diff" ? "±" : a.kind === "notebook" ? "📓" : a.kind === "board" ? "▦" : "⌨";
}
export function artifactLabel(a: Artifact) {
  return a.kind === "markdown" ? "Document" : a.kind === "diff" ? "Changes" : a.kind === "notebook" ? "Notebook" : a.kind === "board" ? "Board" : `Code${langOf(a.lang) ? ` · ${esc(langOf(a.lang)!)}` : ""}`;
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

// ---- a conversation read back from the account's mirror (M2): inert, text only

const el = (tag: string, className: string, text?: string) => {
  const e = document.createElement(tag);
  e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
};
const ARTIFACT_WORD: Record<string, string> = { markdown: "Document", code: "Code", diff: "Changes", notebook: "Notebook", board: "Board" };

function inertPart(p: InertPart): HTMLElement {
  if (p.k === "text") {
    const d = el("div", "msg mirror-text", p.text);
    if (p.truncated) d.append(el("div", "tag", "(cut at 256 KiB)"));
    return d;
  }
  if (p.k === "tool") {
    const meta = [p.status === "running" ? "" : p.status, count(p.duration_ms) !== undefined ? `${(count(p.duration_ms)! / 1000).toFixed(1)} s` : ""].filter(Boolean).join(" · ");
    return el("div", "mirror-tool", `${p.tool}${p.summary ? " " + p.summary : ""}${meta ? " · " + meta : ""}`);
  }
  if (p.k === "approval") return el("div", "mirror-approval", `⚠ ${p.title ?? p.kind}: ${p.state === "approved" ? "Allowed" : p.state === "denied" ? "Denied" : "No answer"}`);
  if (p.k === "artifact") return el("div", "mirror-artifact", `${p.title ?? ARTIFACT_WORD[p.kind] ?? "Artifact"} · ${ARTIFACT_WORD[p.kind] ?? "Artifact"}`);
  return el("div", "turn-error", `Error: ${p.code}`);
}

function inertBlock(b: InertBlock, agent: string): HTMLElement {
  let node: HTMLElement;
  if (b.k === "gap") node = el("div", "mirror-gap", MIRROR_COPY.gap);
  else if (b.k === "user") {
    node = el("div", "user sent mirror");
    node.append(el("div", "bubble mirror-text", b.text));
  } else {
    node = el("div", "turn mirror");
    const who = el("div", "who");
    who.append(el("span", "avatar", "✳"), document.createTextNode(agent));
    node.append(who, ...b.parts.map(inertPart));
    if (b.outcome === "interrupted") node.append(el("div", "status", "Interrupted"));
    else if (b.outcome === "error") node.append(el("div", "status", "Ended with an error"));
  }
  if (b.unconfirmed) node.classList.add("unconfirmed");
  return node;
}

/** One stream read back from the mirror, as its own labeled section: its blocks, its gaps, what isn't confirmed. Drawn
 *  from text only; it has no buttons, nothing to answer, open or send. */
export function mirrorSectionNode(sec: Section, agent = "Agent"): HTMLElement {
  const box = el("section", "mirror-section");
  const otherRun = sec.stale_reason === "other_run" && sec.stale_from === 1;
  box.append(el("div", "mirror-label", otherRun ? MIRROR_COPY.otherRun : MIRROR_COPY.section));
  let said = otherRun;
  for (const b of present(sec)) {
    if (b.unconfirmed && !said) {
      const why = reasonText(sec.stale_reason);
      box.append(el("div", "mirror-unconfirmed", why ? `${MIRROR_COPY.unconfirmed}: ${why}` : MIRROR_COPY.unconfirmed));
      said = true;
    }
    box.append(inertBlock(b, agent));
  }
  return box;
}
