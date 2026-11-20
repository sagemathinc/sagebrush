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
const PATH = /^\/(?:[!$&'()*+,\-./0-9:;=@A-Z[\\\]^_a-z|~]|%[0-9A-Fa-f]{2})*$/;
const PATH_MAX = 200;
/** The one search provider of the contract (the built-in WebSearch). */
export const PROVIDER = "Anthropic";
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
    const host = keys === "origin,path,reason" ? canonicalHost(i.origin, i.path) : null;
    if (host === null) return "bad";
    return { kind: "fetch", origin: i.origin as string, host, path: i.path as string, reason };
  }
  if (keys !== "provider,reason" || i.provider !== PROVIDER) return "bad";
  return { kind: "search", provider: PROVIDER, reason };
}
/** The host of an origin and path in their one canonical form, or null: each matches the grammar above, AND the
 *  platform's URL parser gives back exactly that origin and that path, byte for byte (so no invalid A-label, no
 *  backslash or dot segment it would rewrite, no port, userinfo, query or fragment). The path is never decoded. A
 *  path the agent cut ends in "…" after at least 198 bytes: it cuts at 200, or before a %HH it would otherwise split. */
function canonicalHost(origin: unknown, path: unknown): string | null {
  if (typeof origin !== "string" || typeof path !== "string") return null;
  const m = ORIGIN.exec(origin);
  // (an A-label is checked here: browsers' URL parsers take https://xn--a.com as it is)
  if (m && !hostOk(m[1])) return null;
  const cut = path.endsWith("…"), base = cut ? path.slice(0, -1) : path;
  if (!m || !PATH.test(base) || base.length > PATH_MAX || (cut && base.length < PATH_MAX - 2)) return null;
  let u: URL;
  try { u = new URL(origin + base); } catch { return null; }
  if (u.origin !== origin || u.pathname !== base || u.search || u.hash || u.username || u.password || u.port) return null;
  return m[1];
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

// ---- A-labels (RFC 3492 Punycode, RFC 5891): a label "xn--…" is one only if it decodes to a name with a non-ASCII
// character and encodes back to exactly itself; any other label passes (the grammar above has checked its form).
const BASE = 36, TMIN = 1, TMAX = 26, SKEW = 38, DAMP = 700, INITIAL_BIAS = 72, INITIAL_N = 128;
function adapt(delta: number, points: number, first: boolean): number {
  delta = first ? Math.floor(delta / DAMP) : delta >> 1;
  delta += Math.floor(delta / points);
  let k = 0;
  for (; delta > ((BASE - TMIN) * TMAX) >> 1; k += BASE) delta = Math.floor(delta / (BASE - TMIN));
  return k + Math.floor(((BASE - TMIN + 1) * delta) / (delta + SKEW));
}
const digitOf = (c: number) => (c >= 48 && c <= 57 ? c - 22 : c >= 97 && c <= 122 ? c - 97 : -1); // (lowercase only)
const charOf = (d: number) => String.fromCharCode(d < 26 ? d + 97 : d + 22);
function punyDecode(s: string): number[] | null {
  const out: number[] = [];
  const last = s.lastIndexOf("-");
  for (let j = 0; j < Math.max(last, 0); j++) out.push(s.charCodeAt(j));
  let n = INITIAL_N, bias = INITIAL_BIAS, i = 0;
  for (let at = last > 0 ? last + 1 : 0; at < s.length; ) {
    const old = i;
    for (let w = 1, k = BASE; ; k += BASE) {
      if (at >= s.length) return null;
      const d = digitOf(s.charCodeAt(at++));
      if (d < 0 || d > Math.floor((0x7fffffff - i) / w)) return null;
      i += d * w;
      const t = k <= bias ? TMIN : k >= bias + TMAX ? TMAX : k - bias;
      if (d < t) break;
      if (w > Math.floor(0x7fffffff / (BASE - t))) return null;
      w *= BASE - t;
    }
    bias = adapt(i - old, out.length + 1, old === 0);
    if (Math.floor(i / (out.length + 1)) > 0x10ffff - n) return null;
    n += Math.floor(i / (out.length + 1));
    i %= out.length + 1;
    if (n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return null;
    out.splice(i++, 0, n);
  }
  return out;
}
function punyEncode(cps: number[]): string {
  let out = cps.filter((c) => c < 128).map((c) => String.fromCharCode(c)).join("");
  const b = out.length;
  let h = b, n = INITIAL_N, delta = 0, bias = INITIAL_BIAS;
  if (b > 0) out += "-";
  while (h < cps.length) {
    const m = Math.min(...cps.filter((c) => c >= n));
    delta += (m - n) * (h + 1);
    n = m;
    for (const c of cps) {
      if (c < n) delta++;
      if (c !== n) continue;
      let q = delta;
      for (let k = BASE; ; k += BASE) {
        const t = k <= bias ? TMIN : k >= bias + TMAX ? TMAX : k - bias;
        if (q < t) break;
        out += charOf(t + ((q - t) % (BASE - t)));
        q = Math.floor((q - t) / (BASE - t));
      }
      out += charOf(q);
      bias = adapt(delta, h + 1, h === b);
      delta = 0;
      h++;
    }
    delta++;
    n++;
  }
  return out;
}
/** A host as the page takes it: each "xn--" label a true A-label, decoding to a name with a non-ASCII character and
 *  encoding back to itself, and the whole name, written in Unicode, parsed by the platform's URL parser (its IDNA:
 *  UTS 46's mapping and validity) back to exactly this host; no other "??--" label (reserved). */
export function hostOk(host: string): boolean {
  let idn = false;
  const uni: string[] = [];
  for (const label of host.split(".")) {
    if (!label.startsWith("xn--")) { if (/^..--/.test(label)) return false; uni.push(label); continue; }
    const cps = punyDecode(label.slice(4));
    if (!cps || !cps.some((c) => c >= 128) || punyEncode(cps) !== label.slice(4)) return false;
    uni.push(String.fromCodePoint(...cps));
    idn = true;
  }
  if (!idn) return true;
  try { return new URL("https://" + uni.join(".") + "/").hostname === host; } catch { return false; }
}

/** A web tool's row summary as the page keeps it: the fetch's origin and path, the search's provider, each only in
 *  the form the agent sends; anything else is replaced by a fixed label, and nothing of it is kept. Other tools' rows
 *  are kept as they are. */
export function webSummary(name: unknown, summary: unknown): string | undefined {
  const s = typeof summary === "string" ? summary : undefined;
  if (name === WEB_FETCH || name === "web_fetch") {
    const m = s === undefined ? null : /^(https:\/\/[^/]*)(\/.*)$/s.exec(s);
    return m && canonicalHost(m[1], m[2]) !== null ? s : "(address withheld)";
  }
  if (name === WEB_SEARCH) return s === PROVIDER ? s : "(search withheld)";
  return s;
}
