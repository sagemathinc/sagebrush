// The web tools' permission cards (step 4, the approval policy, with egress.turn): the agent's own fetch and the
// built-in search. Their actions are checked here key by key, in the one form the agent sends (an origin and a path
// with no query, a provider with no search terms), and their cards are worded from what was checked, never from the
// model's text. Shared by the cards (agent-cards.ts) and the chat's tool rows (agent-chat/events.ts).

/** The agent's own fetch and the built-in search: their cards follow the egress rules, not the generic ones. */
export const WEB_FETCH = "mcp__sagebrush_page__web_fetch";
export const WEB_SEARCH = "WebSearch";
/** An origin as the agent sends it: https, a lowercase ASCII (IDNA) host of dot-separated labels whose last starts
 *  with a letter (so never an IP literal), no port, no trailing dot, nothing after it. */
const ORIGIN = /^https:\/\/((?=[a-z0-9.-]{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?)$/;
/** A path as the agent sends it: the serialized pathname, ASCII with its percent escapes kept (never decoded here),
 *  at most 200 bytes, with no query, fragment, space or control; "…" after it when the agent cut it. */
const PATH = /^\/(?:[!$&'()*+,\-./0-9:;=@A-Z[\\\]^_a-z|~]|%[0-9A-Fa-f]{2})*…?$/;
const PATH_MAX = 200;
const PROVIDER = /^[A-Z][A-Za-z0-9 .-]{0,39}$/;
const REASON_MAX = 200; // (Unicode scalars)
/** A web card's request, checked key by key: what it shows and asks for, "bad" for one in another form (shown with
 *  Deny only), or null for a tool that isn't one of the two. */
export type Egress = { kind: "fetch"; origin: string; host: string; path: string; reason: string } | { kind: "search"; provider: string; reason: string };
export function egressOf(tool: string, input: unknown): Egress | "bad" | null {
  if (tool !== WEB_FETCH && tool !== WEB_SEARCH) return null;
  if (!input || typeof input !== "object" || Array.isArray(input)) return "bad";
  const i = input as Record<string, unknown>, keys = Object.keys(i).sort().join(",");
  const reason = typeof i.reason === "string" && [...i.reason].length <= REASON_MAX ? i.reason : null;
  if (reason === null) return "bad";
  if (tool === WEB_FETCH) {
    const m = typeof i.origin === "string" ? ORIGIN.exec(i.origin) : null;
    const path = typeof i.path === "string" ? i.path : "";
    if (keys !== "origin,path,reason" || !m || !PATH.test(path) || path.replace(/…$/, "").length > PATH_MAX) return "bad";
    return { kind: "fetch", origin: i.origin as string, host: m[1], path, reason };
  }
  if (keys !== "provider,reason" || typeof i.provider !== "string" || !PROVIDER.test(i.provider)) return "bad";
  return { kind: "search", provider: i.provider, reason };
}
/** A turn_action that matches its request exactly: {tool: "egress.turn", input} with the one key of the request's
 *  scope, equal byte for byte (its origin, or its provider); anything else gets no "for this turn" button. */
export function turnInputOf(eg: Egress, a: unknown): { origin: string } | { provider: string } | null {
  if (!a || typeof a !== "object" || Array.isArray(a)) return null;
  const t = a as { tool?: unknown; input?: unknown };
  if (t.tool !== "egress.turn" || !t.input || typeof t.input !== "object" || Array.isArray(t.input)) return null;
  const i = t.input as Record<string, unknown>, keys = Object.keys(i);
  if (keys.length !== 1) return null;
  if (eg.kind === "fetch") return keys[0] === "origin" && i.origin === eg.origin ? { origin: eg.origin } : null;
  return keys[0] === "provider" && i.provider === eg.provider ? { provider: eg.provider } : null;
}
/** Text from the model, shown as it is but with every control, bidi, zero-width and line-separator character written
 *  out visibly (\u{202e}), so it can't reorder or hide part of the line. */
export function visible(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g, (c) => `\\u{${c.charCodeAt(0).toString(16).padStart(4, "0")}}`);
}
/** A web card's words and buttons, from its checked request (astra's copy): `turn`, whether the "for this turn"
 *  button is offered. */
export function egressText(eg: Egress | "bad", turn: boolean): { title: string; body: string; summary: string; reason?: string; buttons: "deny" | "two" | "three"; allow: string; turnLabel?: string } {
  if (eg === "bad") return { title: "The agent asked to use the web, in a form this page can't show", body: "Only Deny is offered.", summary: "", buttons: "deny", allow: "" };
  const reason = eg.reason ? `Reason: ${visible(eg.reason)}` : undefined;
  if (eg.kind === "fetch") {
    return {
      title: turn ? `Allow this agent to connect to ${eg.host} for the rest of this turn?` : `Allow this agent to connect to ${eg.host} for this request?`,
      body: "The agent can send information from this workspace to this site in request URLs, including paths and search terms. Content returned by the site is untrusted and may influence the agent's work.",
      summary: eg.origin + eg.path,
      ...(reason ? { reason } : {}),
      buttons: turn ? "three" : "two",
      allow: "Allow this request",
      ...(turn ? { turnLabel: `Allow ${eg.host} for this turn` } : {}),
    };
  }
  return {
    title: turn ? `Allow this agent to search the web (${eg.provider}) for the rest of this turn?` : `Allow this agent to search the web (${eg.provider}) once?`,
    body: `Search terms go to ${eg.provider} and may contain information from this workspace. Results are untrusted and may influence the agent's work.`,
    summary: "",
    ...(reason ? { reason } : {}),
    buttons: turn ? "three" : "two",
    allow: "Allow this search",
    ...(turn ? { turnLabel: "Allow search for this turn" } : {}),
  };
}

/** A web tool's row summary as the page keeps it: the fetch's origin and path, the search's provider, each only in
 *  the form the agent sends; anything else is replaced by a fixed label, and nothing of it is kept. Other tools' rows
 *  are kept as they are. */
export function webSummary(name: unknown, summary: unknown): string | undefined {
  const s = typeof summary === "string" ? summary : undefined;
  if (name === WEB_FETCH || name === "web_fetch") {
    const m = s === undefined ? null : /^(https:\/\/[^/]*)(\/.*)$/.exec(s);
    return m && ORIGIN.test(m[1]) && PATH.test(m[2]) && m[2].replace(/…$/, "").length <= PATH_MAX ? s : "(address withheld)";
  }
  if (name === WEB_SEARCH) return s !== undefined && PROVIDER.test(s) ? s : "(search withheld)";
  return s;
}
