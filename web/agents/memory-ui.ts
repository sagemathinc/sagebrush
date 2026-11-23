// The Agents page's side of agent memory v1 (design/workspace-agent-protocol.md §7): a proposed note's card in a Pair
// turn (agent-chat/view.ts draws it) and what its buttons do. Save and Dismiss are the person's decisions, sent by this
// page over its pairing (memory.save, memory.dismiss) naming the card's pending id and revision; the agent saves
// nothing on the model's word. Edit… opens the card's text, place and expiry for the person to change, then saves that.
// Each answer is checked closed (memory-schema.ts) before the card changes; a refusal is said in the page's words.
import type { AgentPairing } from "../workspace/agent-pair";
import { grantMemory } from "../workspace/agent-grant";
import { TaskClient } from "../workspace/tasks-client";
import { MEMORY_RESULTS, type Scope } from "../workspace/memory-schema";
import type { MemoryCard, Thread, Turn } from "../workspace/agent-chat/events";

export const MEMORY_COPY = {
  secret: "This note looks like it holds a secret (a key, token or password), so it wasn't saved. Take it out and try again.",
  full: "Your notes are full, so this wasn't saved. Delete or shorten some notes, then try again.",
  stale: "This note changed, or the agent's access did, so it wasn't saved.",
  forbidden: "Memory isn't turned on for this agent.",
  failed: "The note couldn't be saved",
  own: "this agent's own notes",
  tag: "a tag's notes",
} as const;

export interface MemoryUiHost {
  pairing(): AgentPairing | null;
  threads(): Thread[];
  /** the card changed: the chat is kept and drawn again */
  changed(): void;
  toast(text: string, ms?: number): void;
  /** a tag's display name, if the page knows it (lane D's names; never authority) */
  tagName?(id: string): string | null;
}

const hex = (n: number) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => b.toString(16).padStart(2, "0")).join("");

/** The turn hooks for memory cards: memory (the buttons) and scopeName. */
export function memoryHooks(host: MemoryUiHost) {
  // (one decision at a time per card, and the same decision_id when it is sent again after a lost answer)
  const busy = new Set<string>();
  const decisions = new Map<string, string>();
  const find = (pending: string): { turn: Turn; card: MemoryCard } | null => {
    for (const t of host.threads()) for (const e of t.entries) if (e.kind === "turn" && e.memory && Object.hasOwn(e.memory, pending)) return { turn: e, card: e.memory[pending] };
    return null;
  };
  const end = (card: MemoryCard, outcome: MemoryCard["outcome"], note?: string) => {
    card.outcome = outcome;
    if (note) card.note = note;
    delete card.proposal.body;
    host.changed();
  };
  const scopeName = (s: Scope) => (s === "own" ? MEMORY_COPY.own : host.tagName?.(s.tag) ? `the tag ${host.tagName(s.tag)}` : MEMORY_COPY.tag);
  const refused = (e: unknown, card: MemoryCard) => {
    const code = (e as { code?: string })?.code;
    if (code === "stale") return end(card, "stale");
    host.toast(code === "secret" ? MEMORY_COPY.secret : code === "full" ? MEMORY_COPY.full : code === "forbidden" ? MEMORY_COPY.forbidden : `${MEMORY_COPY.failed}: ${(e as Error)?.message ?? e}`, 8000);
  };
  async function save(pending: string, edit?: { scope: Scope; name: string; description: string; body: string; expires: number | null }) {
    const f = find(pending), p = host.pairing();
    if (!f || f.card.outcome || !p || busy.has(pending)) return;
    busy.add(pending);
    const decision_id = decisions.get(pending) ?? hex(16);
    decisions.set(pending, decision_id);
    try {
      const r = MEMORY_RESULTS["memory.save"](await TaskClient.of(p).request("memory.save", { pending, revision: f.card.proposal.revision, decision_id, ...(edit ? { edit } : {}) }));
      end(f.card, "saved", r.note);
    } catch (e) {
      refused(e, f.card);
    } finally {
      busy.delete(pending);
    }
  }
  async function dismiss(pending: string) {
    const f = find(pending), p = host.pairing();
    if (!f || f.card.outcome || !p || busy.has(pending)) return;
    busy.add(pending);
    try {
      MEMORY_RESULTS["memory.dismiss"](await TaskClient.of(p).request("memory.dismiss", { pending, revision: f.card.proposal.revision }));
      end(f.card, "dismissed");
    } catch (e) {
      refused(e, f.card);
    } finally {
      busy.delete(pending);
    }
  }
  // (Edit…: the card's text in a dialog, its place among the grant's scopes, and its expiry; Save there saves that)
  function edit(pending: string) {
    const f = find(pending), p = host.pairing();
    if (!f || f.card.outcome || !p || f.card.proposal.body === undefined) return;
    const pr = f.card.proposal;
    const tags = (grantMemory(p.grant)?.tags ?? []).slice();
    const dlg = document.createElement("dialog");
    dlg.className = "memory-edit";
    const field = <K extends keyof HTMLElementTagNameMap>(tag: K, label: string, set: (el: HTMLElementTagNameMap[K]) => void) => {
      const l = document.createElement("label");
      l.textContent = label;
      const el = document.createElement(tag);
      set(el);
      l.append(el);
      dlg.append(l);
      return el;
    };
    const h = document.createElement("h2");
    h.textContent = "Edit the note before saving";
    dlg.append(h);
    const name = field("input", "Name", (el) => { el.value = pr.name; el.maxLength = 64; el.name = "name"; });
    const description = field("input", "Description (one line)", (el) => { el.value = pr.description; el.maxLength = 200; el.name = "description"; });
    const body = field("textarea", "Note", (el) => { el.value = pr.body ?? ""; el.rows = 8; el.name = "body"; });
    const where = field("select", "Where", (el) => {
      el.name = "scope";
      const add = (value: string, text: string) => el.append(Object.assign(document.createElement("option"), { value, textContent: text }));
      add("own", "This agent's own notes");
      for (const t of tags) add("tag:" + t, `Tag ${host.tagName?.(t) ?? t.slice(0, 8)}`);
      el.value = pr.scope === "own" ? "own" : "tag:" + pr.scope.tag;
    });
    const keep = field("select", "Keep it", (el) => {
      el.name = "expires";
      el.append(Object.assign(document.createElement("option"), { value: "90", textContent: "For 90 days" }), Object.assign(document.createElement("option"), { value: "never", textContent: "Until I delete it" }));
      el.value = pr.expires === null ? "never" : "90";
    });
    const row = document.createElement("menu");
    const ok = Object.assign(document.createElement("button"), { textContent: "Save", className: "primary", type: "button" });
    const cancel = Object.assign(document.createElement("button"), { textContent: "Cancel", type: "button" });
    row.append(cancel, ok);
    dlg.append(row);
    cancel.onclick = () => dlg.close();
    dlg.addEventListener("close", () => dlg.remove(), { once: true });
    ok.onclick = () => {
      const scope: Scope = where.value === "own" ? "own" : { tag: where.value.slice(4) };
      const expires = keep.value === "never" ? null : Date.now() + 90 * 24 * 3600 * 1000;
      dlg.close();
      void save(pending, { scope, name: name.value.trim(), description: description.value.trim(), body: body.value, expires });
    };
    document.body.append(dlg);
    dlg.showModal();
    body.focus();
  }
  return {
    memory: (pending: string, action: "save" | "edit" | "dismiss") => void (action === "save" ? save(pending) : action === "dismiss" ? dismiss(pending) : edit(pending)),
    scopeName,
  };
}
