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
type Card = { pairing: CardPairing; turn: string; instance: string; child?: string; conversation: string; request_id: string; tool?: string; input?: unknown; claimed: boolean };

/** A card's identities and tool, each at most this many bytes as canonical text (permissionText's bound). A kept card
 * is then at most 16 KiB of input and 4 KiB of identities as UTF-8, so the cards kept hold at most CARDS_MAX times
 * that, twice over as JS strings, plus each card's 32-character page token (64 bytes as a JS string, 1 KiB for
 * CARDS_MAX cards): an accounted figure, not a browser ceiling. */
export const ID_MAX = 1024;
export const CARDS_MAX = 16; // (the agent asks at most 4 at once; older unanswered ones past this are forgotten)
export const SPENT_MAX = 256; // (ids remembered as asked, per pairing, each a 16-character hash: 32 bytes as a JS string, 8 KiB of payload in all; object and GC overhead not counted)

/** A card's own token, made by the page: 16 random bytes. */
const token = () => { let s = ""; for (const b of globalThis.crypto.getRandomValues(new Uint8Array(16))) s += b.toString(16).padStart(2, "0"); return s; };
/** An id as a fixed-size hash (two 32-bit FNV-1a passes): a collision only refuses a new card, failing closed. */
function idHash(id: string): string {
  let a = 0x811c9dc5, b = 0x01000193 ^ id.length;
  for (let i = 0; i < id.length; i++) { const c = id.charCodeAt(i); a = Math.imul(a ^ c, 0x01000193); b = Math.imul(b ^ c, 0x0100019d); }
  return (a >>> 0).toString(16).padStart(8, "0") + (b >>> 0).toString(16).padStart(8, "0");
}

/** What Codex asks before it acts (sagebrush-agent's codex.* cards), titled as the agent titles them. */
const CODEX_TITLES: Record<string, string> = {
  "codex.command": "Run this command?",
  "codex.stdin": "Send input to a running command?",
  "codex.fileChange": "Make these file changes?",
  "codex.permissions": "Give Codex more access?",
};
// (what a Codex card is about, in full: the command and the folder it runs in; the files changed; why more access)
function codexSummary(tool: string, i: Record<string, unknown>): string {
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  if (tool === "codex.fileChange") return (Array.isArray(i.changes) ? i.changes.map((c) => str((c as { path?: unknown })?.path)).filter(Boolean).join(", ") : "") || "(no file named)";
  if (tool === "codex.permissions") return str(i.reason);
  // (Codex's command may be missing or null: said so, never an empty line under "Run this command?")
  const command = str(i.command), cwd = str(i.cwd);
  if (!command) return "(no command given)";
  return cwd ? `${command} (in ${cwd})` : command;
}

/** A card's words from its action, exactly as the agent words them (sagebrush-agent's askPerson): the tool's name,
 * what the call is for (its address, query or path), and all of its arguments. */
export function cardText(tool: string, input: unknown): { title: string; summary: string; detail: string } {
  const name = tool.startsWith("mcp__sagebrush__") ? tool.slice("mcp__sagebrush__".length) : tool;
  const i = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const codex = CODEX_TITLES[tool];
  if (codex) return { title: codex, summary: codexSummary(tool, i), detail: JSON.stringify(input, null, 2) };
  const target = [i.url, i.query, i.path, i.from && i.to ? `${i.from} → ${i.to}` : undefined].find((v) => typeof v === "string") as string | undefined;
  return { title: `Allow ${name}?`, summary: target ?? "(no address or query given)", detail: JSON.stringify(input, null, 2) };
}
// (an answer's event keeps the words its question was shown with)
const c2 = (e: any, c: { tool?: string; input?: unknown }) => (c.tool === undefined ? e : { ...e, ...cardText(c.tool, c.input) });

export class PermissionCards {
  private cards = new Map<string, Card>();
  // (the ids asked in this pairing, the newest SPENT_MAX, each as a fixed-size hash: an id asked again is refused while
  //  it's remembered. Not what keeps a click on the card it was shown for: that's the card's own instance token)
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
    const h = idHash(e.id);
    if (this.spent.has(h)) { p.notify("chat.permission", { request_id: e.id, behavior: "deny" }); return false; }
    this.spent.add(h);
    while (this.spent.size > SPENT_MAX) this.spent.delete(this.spent.values().next().value!);
    while (this.cards.size >= CARDS_MAX) this.cards.delete(this.cards.keys().next().value!);
    this.cards.set(e.id, { pairing: p, turn, instance: token(), conversation: turnConversation, request_id: e.id, claimed: false, ...(has ? { child: e.child, tool: e.action.tool, input } : {}) });
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
      return { ...(c.child === undefined ? e : { ...e, ...cardText(c.tool!, c.input) }), instance: c.instance };
    }
    if (!kept || kept.conversation !== turnConversation || kept.turn !== turn) return null;
    this.settled(e.id);
    return { ...c2(e, kept), instance: kept.instance };
  }

  /** The page's token for a kept card (for a caller that renders it); undefined if none is kept under `id`. */
  instanceOf(id: string): string | undefined { return this.cards.get(id)?.instance; }

  /** The person's click on a card shown in `conversation`: true if it claimed the card (the first click on either
   * button), false if it was already claimed, or is another conversation's, or isn't a card of this pairing.
   * Synchronous up to the claim; Allow's digest follows. */
  answer(id: string, approve: boolean, conversation?: string, turn?: string, instance?: string): boolean {
    const c = this.cards.get(id), p = this.o.current();
    // (the card clicked must be this very card: its page-made token, which a card asked again under the same id never
    //  shares, whatever the ids remembered; a click without one, or an empty one, answers nothing)
    if (!c || c.claimed || (conversation !== undefined && c.conversation !== conversation) || (turn !== undefined && c.turn !== turn) || typeof instance !== "string" || instance === "" || c.instance !== instance) return false;
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
