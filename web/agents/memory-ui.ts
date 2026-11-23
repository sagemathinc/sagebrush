// The Agents page's side of agent memory v1 (design/workspace-agent-protocol.md §7): a proposed note's card in a Pair
// turn (agent-chat/view.ts draws it) and what its buttons do. Save and Dismiss are the person's decisions, sent by this
// page over its pairing (memory.save, memory.dismiss) naming the card's pending id and revision; the agent saves
// nothing on the model's word. Edit… opens the card's text, place and expiry for the person to change, then saves that.
// Each answer is checked closed (memory-schema.ts) before the card changes; a refusal is said in the page's words.
import type { AgentPairing } from "../workspace/agent-pair";
import { grantMemory } from "../workspace/agent-grant";
import { TaskClient } from "../workspace/tasks-client";
import { MEMORY_RESULTS, MemoryShapeError, type Scope } from "../workspace/memory-schema";
import type { MemoryCard, Thread, Turn } from "../workspace/agent-chat/events";
import { expiresText } from "../workspace/agent-chat/view";

export const MEMORY_COPY = {
  secret: "This note looks like it holds a secret (a key, token or password), so it wasn't saved. Take it out and try again.",
  full: "Your notes are full, so this wasn't saved. Delete or shorten some notes, then try again.",
  stale: "This note changed, or the agent's access did, so it wasn't saved.",
  forbidden: "Memory isn't turned on for this agent.",
  conflict: "A note with that name is already there, so this wasn't saved. Choose another name in Edit….",
  away: "The agent that proposed this note isn't the one connected now.",
  where: "Choose where to keep this note.",
  changed: "The agent changed this note while you were looking at it. Check it again.",
  unread: "The agent's answer couldn't be read. It may have been saved: the card will say once the agent does.",
  unreadDismiss: "The agent's answer couldn't be read. It may have been dismissed: the card will say once the agent does.",
  long: "This note is too long to save. Shorten it in Edit….",
  decided: "This note was already decided.",
  failed: "The note couldn't be saved",
  failedDismiss: "The note couldn't be dismissed",
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
  /** which decisions the card takes now: all over the pairing it came on, Dismiss over another connection to the same
   *  run of its agent, none otherwise */
  live(card: MemoryCard): "all" | "dismiss" | false;
}

const hex = (n: number) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => b.toString(16).padStart(2, "0")).join("");

/** The turn hooks for memory cards: memory (the buttons) and scopeName. */
export function memoryHooks(host: MemoryUiHost) {
  // (one decision at a time per card. A decision_id is kept only to send the very same decision again after its answer
  //  was lost (no answer in time, or the connection ended): the agent keeps each id's request and answer (§6.1), so
  //  after any answer, or for another revision or text, a new decision gets a new id)
  const busy = new Set<string>();
  const decisions = new Map<string, { key: string; id: string }>();
  // (no answer, or one the page couldn't read (not as §7.2 has it): the same request again, under the same id, gets
  //  the agent's kept answer, and its memory_decided settles the card)
  const LOST = new Set(["timeout", "closed"]);
  const unreadable = (e: unknown) => e instanceof MemoryShapeError || (e as { extra?: { answer?: unknown } })?.extra?.answer === true;
  const lost = (e: unknown) => unreadable(e) || LOST.has((e as { code?: string })?.code ?? "");
  const find = (pending: string): { thread: Thread; turn: Turn; card: MemoryCard } | null => {
    for (const t of host.threads()) for (const e of t.entries) if (e.kind === "turn" && e.memory && Object.hasOwn(e.memory, pending)) return { thread: t, turn: e, card: e.memory[pending] };
    return null;
  };
  // (the card, if it is open and its agent is the one connected now; else said why not)
  const decidable = (pending: string, action: "save" | "edit" | "dismiss") => {
    const f = find(pending), p = host.pairing();
    if (!f || f.card.outcome || !p || busy.has(pending)) return null;
    const may = host.live(f.card);
    if (may === false || (may === "dismiss" && action !== "dismiss")) { host.toast(MEMORY_COPY.away, 6000); return null; }
    return { ...f, p };
  };
  // (a decision names the revision the person saw; a later one shown since is theirs to look at first: nothing sent)
  const seen = (f: { card: MemoryCard }, revision: number) => {
    if (f.card.proposal.revision === revision) return true;
    host.toast(MEMORY_COPY.changed, 6000);
    return false;
  };
  // (an answer changes the card it was for, never a later revision's, nor one the agent's memory_decided ended first)
  const still = (pending: string, card: MemoryCard) => find(pending)?.card === card && !card.outcome;
  const end = (card: MemoryCard, outcome: MemoryCard["outcome"], note?: string) => {
    decisions.delete(card.proposal.pending);
    card.outcome = outcome;
    if (note) card.note = note;
    delete card.proposal.body;
    host.changed();
  };
  const scopeName = (s: Scope) => (s === "own" ? MEMORY_COPY.own : host.tagName?.(s.tag) ? `the tag ${host.tagName(s.tag)}` : MEMORY_COPY.tag);
  const refused = (e: unknown, pending: string, card: MemoryCard, action: "save" | "dismiss") => {
    const code = (e as { code?: string })?.code;
    const failed = `${action === "save" ? MEMORY_COPY.failed : MEMORY_COPY.failedDismiss}: ${(e as Error)?.message ?? e}`;
    if (lost(e)) return host.toast(unreadable(e) ? (action === "save" ? MEMORY_COPY.unread : MEMORY_COPY.unreadDismiss) : failed, 8000);
    if (!still(pending, card)) return;
    // (stale: it changed, or the agent's access did; not_found: the proposal is gone at the agent (decided in another
    //  tab, or the agent started again): either way this card can't be saved now)
    if (code === "stale" || code === "not_found") return end(card, "stale");
    host.toast(code === "secret" ? MEMORY_COPY.secret : code === "full" ? MEMORY_COPY.full : code === "forbidden" ? MEMORY_COPY.forbidden : code === "conflict" ? MEMORY_COPY.conflict : code === "too_large" ? MEMORY_COPY.long : failed, 8000);
  };
  // (revision: the one the person saw, the card's as drawn or as the dialog opened; a later one at the agent is stale)
  async function save(pending: string, revision: number, edit?: { scope: Scope; name: string; description: string; body: string; expires: number | null }) {
    const f = decidable(pending, "save");
    if (!f || !seen(f, revision)) return;
    busy.add(pending);
    const key = JSON.stringify([revision, edit ?? null]);
    // (ids kept for cards that have since ended, or gone, aren't needed again)
    for (const k of [...decisions.keys()]) { const c = find(k)?.card; if (!c || c.outcome) decisions.delete(k); }
    const kept = decisions.get(pending);
    const decision_id = kept?.key === key ? kept.id : hex(16);
    decisions.set(pending, { key, id: decision_id });
    try {
      const r = MEMORY_RESULTS["memory.save"](await TaskClient.of(f.p).request("memory.save", { pending, revision, decision_id, ...(edit ? { edit } : {}) }));
      if (still(pending, f.card)) end(f.card, "saved", r.note);
      decisions.delete(pending);
    } catch (e) {
      if (!lost(e)) decisions.delete(pending);
      refused(e, pending, f.card, "save");
    } finally {
      busy.delete(pending);
    }
  }
  async function dismiss(pending: string, revision: number) {
    const f = decidable(pending, "dismiss");
    if (!f || !seen(f, revision)) return;
    busy.add(pending);
    try {
      MEMORY_RESULTS["memory.dismiss"](await TaskClient.of(f.p).request("memory.dismiss", { pending, revision }));
      if (still(pending, f.card)) end(f.card, "dismissed");
    } catch (e) {
      refused(e, pending, f.card, "dismiss");
    } finally {
      busy.delete(pending);
    }
  }
  // (Edit…: the card's text in a dialog, its place among the grant's scopes, and its expiry; Save there saves that)
  function edit(pending: string, revision: number) {
    const f = decidable(pending, "edit");
    if (!f || f.card.proposal.body === undefined || f.card.proposal.revision !== revision) return;
    const pr = f.card.proposal;
    const tags = (grantMemory(f.p.grant)?.tags ?? []).slice();
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
      // (a tag the grant no longer has isn't offered: the person chooses again)
      const want = pr.scope === "own" ? "own" : "tag:" + pr.scope.tag;
      if (want !== "own" && !tags.includes(want.slice(4))) {
        el.prepend(Object.assign(document.createElement("option"), { value: "", textContent: "Choose…", disabled: true }));
        el.value = "";
      } else el.value = want;
    });
    const keep = field("select", "Keep it", (el) => {
      el.name = "expires";
      // (the proposal's own expiry first, as it is: editing the text alone doesn't change it)
      if (pr.expires !== null) el.append(Object.assign(document.createElement("option"), { value: "as", textContent: `As proposed (${expiresText(pr.expires)})` }));
      el.append(Object.assign(document.createElement("option"), { value: "90", textContent: "For 90 days" }), Object.assign(document.createElement("option"), { value: "never", textContent: "Until I delete it" }));
      el.value = pr.expires === null ? "never" : "as";
    });
    const row = document.createElement("menu");
    const ok = Object.assign(document.createElement("button"), { textContent: "Save", className: "primary", type: "button" });
    const cancel = Object.assign(document.createElement("button"), { textContent: "Cancel", type: "button" });
    row.append(cancel, ok);
    dlg.append(row);
    cancel.onclick = () => dlg.close();
    dlg.addEventListener("close", () => dlg.remove(), { once: true });
    ok.onclick = () => {
      if (!where.value) return host.toast(MEMORY_COPY.where, 5000);
      // (decided meanwhile: the dialog closes, and says so; revised by the agent: the dialog stays, for the person to
      //  compare and start again)
      const now = find(pending)?.card;
      if (!now || now.outcome) { dlg.close(); return host.toast(MEMORY_COPY.decided, 6000); }
      if (now.proposal.revision !== revision) return host.toast(MEMORY_COPY.changed, 6000);
      const scope: Scope = where.value === "own" ? "own" : { tag: where.value.slice(4) };
      const expires = keep.value === "never" ? null : keep.value === "as" ? pr.expires : Date.now() + 90 * 24 * 3600 * 1000;
      dlg.close();
      void save(pending, revision, { scope, name: name.value.trim(), description: description.value.trim(), body: body.value, expires });
    };
    document.body.append(dlg);
    dlg.showModal();
    body.focus();
  }
  return {
    memory: (pending: string, action: "save" | "edit" | "dismiss", _turn: string, revision: number) => void (action === "save" ? save(pending, revision) : action === "dismiss" ? dismiss(pending, revision) : edit(pending, revision)),
    scopeName,
  };
}
