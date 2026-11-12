// The paired agent's permission cards, the page's side: each card kept with the fields its digest
// binds (child, conversation, request_id, action) as admitted, never rebuilt from what is shown; answered once, the
// first click claiming it before anything is awaited; an Allow carrying the digest of that very card (agent-canon.ts),
// computed within the page-wide digest bound and sent only if the same pairing and the same agent child are still
// current. A card the page's canon refuses is answered Deny (the agent accepted the same input when it asked, so that
// is the page's fault, and it fails closed).

import { canon, permissionDigest } from "./agent-canon";

type Gate = { acquire(bytes: number, live: () => boolean): Promise<(() => void) | null>; sweep(): void };
/** What the cards need of the pairing: its child, whether it's over a runner, and its notify. */
export type CardPairing = { readonly state: string; readonly link: unknown; readonly hello: { child?: string } | null; notify(method: string, params: unknown): boolean };
type Card = { pairing: CardPairing; turn: string; child?: string; conversation: string; request_id: string; tool?: string; input?: unknown; claimed: boolean };

/** A card's identities and tool, each at most this many bytes as canonical text (permissionText's bound). A kept card
 * is then at most 16 KiB of input and 4 KiB of identities as UTF-8, so the cards kept hold at most CARDS_MAX times
 * that, twice over as JS strings: an accounted figure, not a browser ceiling. */
export const ID_MAX = 1024;
export const CARDS_MAX = 16; // (the agent asks at most 4 at once; older unanswered ones past this are forgotten)
export const SPENT_MAX = 256; // (ids remembered as asked, per pairing: each within ID_MAX, so at most 256 KiB as UTF-8)

/** A card's words from its action, exactly as the agent words them (sagebrush-agent's askPerson): the tool's name,
 * what the call is for (its address, query or path), and all of its arguments. */
export function cardText(tool: string, input: unknown): { title: string; summary: string; detail: string } {
  const name = tool.startsWith("mcp__sagebrush__") ? tool.slice("mcp__sagebrush__".length) : tool;
  const i = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const target = [i.url, i.query, i.path, i.from && i.to ? `${i.from} → ${i.to}` : undefined].find((v) => typeof v === "string") as string | undefined;
  return { title: `Allow ${name}?`, summary: target ?? "(no address or query given)", detail: JSON.stringify(input, null, 2) };
}
// (an answer's event keeps the words its question was shown with)
const c2 = (e: any, c: { tool?: string; input?: unknown }) => (c.tool === undefined ? e : { ...e, ...cardText(c.tool, c.input) });

export class PermissionCards {
  private cards = new Map<string, Card>();
  // (every id asked in this pairing, the newest SPENT_MAX: one is never admitted twice, whatever its turn)
  private spent = new Set<string>();
  private o: { current: () => CardPairing | null; gate: Gate; charge: number; digest?: typeof permissionDigest };
  constructor(o: { current: () => CardPairing | null; gate: Gate; charge: number; digest?: typeof permissionDigest }) { this.o = o; }

  get size() { return this.cards.size; }
  clear() { this.cards.clear(); this.spent.clear(); this.o.gate.sweep(); }
  /** The pairing changed (another child, closed, replaced): Allows waiting for a digest no longer current are dropped. */
  refresh() { this.o.gate.sweep(); }
  has(id: string) { return this.cards.has(id); }

  /** A card as it arrives in a turn of `turnConversation`: kept; false if it mustn't be shown (it names another
   * conversation, request or child than its own, or over a runner it lacks the fields its digest needs): then it is
   * answered Deny at once. */
  admit(turnConversation: string, e: any, turn = ""): boolean {
    const p = this.o.current();
    if (!p || !e || typeof e.id !== "string") return false;
    const has = typeof e.child === "string" && typeof e.conversation === "string" && typeof e.request_id === "string" && !!e.action && typeof e.action === "object" && typeof e.action.tool === "string" && "input" in e.action;
    const consistent = has && e.conversation === turnConversation && e.request_id === e.id && e.child === p.hello?.child;
    if ((p.link && !consistent) || (has && !consistent)) {
      p.notify("chat.permission", { request_id: e.id, behavior: "deny" });
      return false;
    }
    // (the input checked against canon's bound before anything is kept: an inert copy within 16 KiB, or the card is
    //  denied; the agent canonicalizes the same input when it asks, so this refuses only what it would never send)
    // (every field the digest covers checked against its bound before anything is kept or shown: the input as canon's
    //  inert copy within 16 KiB, the tool, child, conversation and request id within 1 KiB each, as permissionText takes
    //  them; else the card is denied)
    let input: unknown;
    if (has) {
      const c = canon(e.action.input);
      const ids = [e.action.tool, e.child, e.conversation, e.request_id].every((s: string) => canon(s, ID_MAX).ok);
      if (!c.ok || !ids) { p.notify("chat.permission", { request_id: e.id.slice(0, ID_MAX), behavior: "deny" }); return false; }
      input = c.value;
    }
    if (this.spent.has(e.id)) { p.notify("chat.permission", { request_id: e.id, behavior: "deny" }); return false; }
    this.spent.add(e.id);
    while (this.spent.size > SPENT_MAX) this.spent.delete(this.spent.values().next().value!);
    while (this.cards.size >= CARDS_MAX) this.cards.delete(this.cards.keys().next().value!);
    this.cards.set(e.id, { pairing: p, turn, conversation: turnConversation, request_id: e.id, claimed: false, ...(has ? { child: e.child, tool: e.action.tool, input } : {}) });
    this.o.gate.sweep();
    return true;
  }

  /** The agent's own answer to a card came (approved, denied): it's done here. */
  settled(id: string) { this.cards.delete(id); this.o.gate.sweep(); }

  /** A card event as the chat shows it, or null for one it mustn't show. A new question is admitted (admit), and its
   * title, summary and detail are made here from the action it was admitted with, as the agent makes them, never taken
   * from the event's own strings: what the person reads is what an Allow's digest covers. A question asked again
   * under an id already kept is dropped, whatever it says; an answer (approved, denied) is shown only for a card of
   * this conversation. */
  view(turnConversation: string, turn: string, e: any): any | null {
    if (!e || typeof e.id !== "string") return null;
    const kept = this.cards.get(e.id);
    if (e.state === "open") {
      if (kept || !this.admit(turnConversation, e, turn)) return null;
      const c = this.cards.get(e.id)!;
      return c.child === undefined ? e : { ...e, ...cardText(c.tool!, c.input) };
    }
    if (!kept || kept.conversation !== turnConversation || kept.turn !== turn) return null;
    this.settled(e.id);
    return c2(e, kept);
  }

  /** The person's click on a card shown in `conversation`: true if it claimed the card (the first click on either
   * button), false if it was already claimed, or is another conversation's, or isn't a card of this pairing.
   * Synchronous up to the claim; Allow's digest follows. */
  answer(id: string, approve: boolean, conversation?: string, turn?: string): boolean {
    const c = this.cards.get(id), p = this.o.current();
    if (!c || c.claimed || (conversation !== undefined && c.conversation !== conversation) || (turn !== undefined && c.turn !== turn)) return false;
    c.claimed = true;
    if (!p || c.pairing !== p || p.state !== "granted") return true;
    if (!approve) { p.notify("chat.permission", { request_id: id, behavior: "deny" }); return true; }
    // (an agent that binds no digest (no child on its card) is one that asks none: loopback only)
    if (c.child === undefined) { p.notify("chat.permission", { request_id: id, behavior: p.link ? "deny" : "allow" }); return true; }
    void this.allow(p, c);
    return true;
  }

  /** The Allow, with its digest; resolves when it was sent or dropped (for the rows). */
  pending: Promise<void> = Promise.resolve();
  private allow(p: CardPairing, c: Card) {
    const run = async () => {
      // (the card itself still kept: cleared, settled or evicted, its Allow is dropped, waiting or not)
      const live = () => this.cards.get(c.request_id) === c && this.o.current() === p && p.state === "granted" && p.hello?.child === c.child;
      const release = await this.o.gate.acquire(this.o.charge, live);
      if (!release) return;
      let d: string | null = null;
      try { d = await (this.o.digest ?? permissionDigest)({ child: c.child, conversation: c.conversation, request: c.request_id, tool: c.tool, input: c.input }); }
      catch { d = null; }
      finally { release(); }
      if (!live()) return;
      if (d === null) { p.notify("chat.permission", { request_id: c.request_id, behavior: "deny" }); return; }
      p.notify("chat.permission", { request_id: c.request_id, behavior: "allow", digest: d });
    };
    this.pending = run();
    return this.pending;
  }
}
