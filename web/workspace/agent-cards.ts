// The paired agent's permission cards, the page's side (W2 B Binding 3): each card kept with the fields its digest
// binds (child, conversation, request_id, action) as admitted, never rebuilt from what is shown; answered once, the
// first click claiming it before anything is awaited; an Allow carrying the digest of that very card (agent-canon.ts),
// computed within the page-wide digest bound and sent only if the same pairing and the same agent child are still
// current. A card the page's canon refuses is answered Deny (the agent accepted the same input when it asked, so that
// is the page's fault, and it fails closed).

import { permissionDigest } from "./agent-canon";

type Gate = { acquire(bytes: number, live: () => boolean): Promise<(() => void) | null> };
/** What the cards need of the pairing: its child, whether it's over a runner, and its notify. */
export type CardPairing = { readonly state: string; readonly link: unknown; readonly hello: { child?: string } | null; notify(method: string, params: unknown): boolean };
type Card = { pairing: CardPairing; child?: string; conversation: string; request_id: string; tool?: string; input?: unknown; claimed: boolean };

export const CARDS_MAX = 16; // (the agent asks at most 4 at once; older unanswered ones past this are forgotten)

export class PermissionCards {
  private cards = new Map<string, Card>();
  private o: { current: () => CardPairing | null; gate: Gate; charge: number; digest?: typeof permissionDigest };
  constructor(o: { current: () => CardPairing | null; gate: Gate; charge: number; digest?: typeof permissionDigest }) { this.o = o; }

  get size() { return this.cards.size; }
  clear() { this.cards.clear(); }
  has(id: string) { return this.cards.has(id); }

  /** A card as it arrives in a turn of `turnConversation`: kept; false if it mustn't be shown (it names another
   * conversation, request or child than its own, or over a runner it lacks the fields its digest needs): then it is
   * answered Deny at once. */
  admit(turnConversation: string, e: any): boolean {
    const p = this.o.current();
    if (!p || !e || typeof e.id !== "string") return false;
    const has = typeof e.child === "string" && typeof e.conversation === "string" && typeof e.request_id === "string" && !!e.action && typeof e.action === "object" && typeof e.action.tool === "string" && "input" in e.action;
    const consistent = has && e.conversation === turnConversation && e.request_id === e.id && e.child === p.hello?.child;
    if ((p.link && !consistent) || (has && !consistent)) {
      p.notify("chat.permission", { request_id: e.id, behavior: "deny" });
      return false;
    }
    while (this.cards.size >= CARDS_MAX) this.cards.delete(this.cards.keys().next().value!);
    let input: unknown;
    try { input = has ? structuredClone(e.action.input) : undefined; } catch { input = undefined; }
    this.cards.set(e.id, { pairing: p, conversation: turnConversation, request_id: e.id, claimed: false, ...(has ? { child: e.child, tool: e.action.tool, input } : {}) });
    return true;
  }

  /** The agent's own answer to a card came (approved, denied): it's done here. */
  settled(id: string) { this.cards.delete(id); }

  /** The person's click: true if it claimed the card (the first click on either button), false if it was already
   * claimed or isn't a card of this pairing. Synchronous up to the claim; Allow's digest follows. */
  answer(id: string, approve: boolean): boolean {
    const c = this.cards.get(id), p = this.o.current();
    if (!c || c.claimed) return false;
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
      const live = () => this.o.current() === p && p.state === "granted" && p.hello?.child === c.child;
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
